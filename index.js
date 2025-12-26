import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

/* ================= CONFIG ================= */
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const MAX_QUEUE = Number(process.env.MAX_QUEUE ?? 50);
const RESTART_EVERY_JOBS = Number(process.env.RESTART_EVERY_JOBS ?? 80);
const DEFAULT_MAX_MS = Number(process.env.DEFAULT_MAX_MS ?? 20000);
const DEFAULT_MAX_COMBOS = Number(process.env.DEFAULT_MAX_COMBOS ?? 200);
const UI_TICK_MS = Number(process.env.UI_TICK_MS ?? 120);
const STEP_TIMEOUT_CAP_MS = 15000;

const FATAL_PATTERNS = [
  "EAGAIN",
  "spawn ",
  "browserType.launch",
  "Failed to launch",
  "Executable doesn't exist",
  "Target closed",
  "Browser has been closed",
];

/* ================= UTILS ================= */
const nowMs = () => Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const normalizeText = s => String(s ?? "").replace(/\s+/g, " ").trim();
const isFatalPlaywrightError = msg =>
  FATAL_PATTERNS.some(p => String(msg || "").includes(p));

/* ================= BROWSER ================= */
let browser = null;
let browserLaunching = null;
let jobsDone = 0;

async function ensureBrowser() {
  if (browser) return browser;
  if (browserLaunching) return browserLaunching;

  browserLaunching = chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  }).then(b => (browser = b));

  return browserLaunching;
}

async function restartBrowser(reason) {
  try { if (browser) await browser.close(); } catch {}
  browser = null;
  await sleep(250);
  await ensureBrowser();
}

/* ================= QUEUE ================= */
const queue = [];
let workerRunning = false;

function enqueue(jobFn) {
  if (queue.length >= MAX_QUEUE) {
    const e = new Error("queue_full");
    e.status = 429;
    throw e;
  }
  return new Promise((resolve, reject) => {
    queue.push({ jobFn, resolve, reject });
    runWorker();
  });
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (queue.length) {
      if (browser && jobsDone && jobsDone % RESTART_EVERY_JOBS === 0) {
        await restartBrowser("preventive");
      }
      const { jobFn, resolve, reject } = queue.shift();
      try { resolve(await jobFn()); }
      catch (e) { reject(e); }
    }
  } finally {
    workerRunning = false;
  }
}

/* ================= SCRAPER ================= */
async function scrapeProduct({ product_url, max_combos, max_ms }) {
  const started = nowMs();
  const deadline = started + max_ms;

  const b = await ensureBrowser();
  const context = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(Math.min(STEP_TIMEOUT_CAP_MS, max_ms));

  try {
    await page.goto(product_url, { waitUntil: "domcontentloaded" });

    const variations = await page.evaluate(() => {
      const norm = s => String(s ?? "").replace(/\s+/g, " ").trim();
      const groups = {};

      document.querySelectorAll('[name^="variation["]').forEach(el => {
        const name = el.name;
        if (!name || el.type === "hidden") return;
        groups[name] ??= { name, options: [] };

        if (el.tagName === "SELECT") {
          [...el.options].forEach(o => {
            if (!o.value) return;
            groups[name].options.push({
              value: norm(o.value),
              label: norm(o.textContent),
              disabled: o.disabled,
            });
          });
        }

        if (el.tagName === "INPUT") {
          groups[name].options.push({
            value: norm(el.value),
            label: norm(el.getAttribute("aria-label")) || norm(el.value),
            disabled: el.disabled,
          });
        }
      });

      return Object.values(groups);
    });

    async function setVar(name, value) {
      await page.evaluate(({ name, value }) => {
        const s = document.querySelector(`select[name="${CSS.escape(name)}"]`);
        if (s) {
          s.value = value;
          s.dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }
        const r = document.querySelector(
          `input[name="${CSS.escape(name)}"][value="${CSS.escape(value)}"]`
        );
        if (r) r.click();
      }, { name, value });
    }

    async function available() {
      return await page.evaluate(() => {
        const btn = document.querySelector(".product-buy-btn");
        if (!btn) return null;
        const t = (btn.value || btn.textContent || "").toLowerCase();
        return !(btn.disabled || t.includes("sin stock") || t.includes("agotado"));
      });
    }

    // Producto cartesiano
    let combos = [{}];
    for (const v of variations) {
      const next = [];
      for (const c of combos) {
        for (const o of v.options.filter(x => !x.disabled)) {
          next.push({ ...c, [v.name]: o });
        }
      }
      combos = next;
    }

    const results = [];

    for (const combo of combos.slice(0, max_combos)) {
      if (nowMs() > deadline) break;

      for (const [k, o] of Object.entries(combo)) {
        await setVar(k, o.value);
        await page.waitForTimeout(UI_TICK_MS);
      }

      results.push({
        options: Object.fromEntries(
          Object.values(combo).map(o => [o.label, o.value])
        ),
        available: await available(),
      });
    }

    jobsDone++;
    return {
      product_url,
      combos: results,
      combosCount: results.length,
      limited: results.length >= max_combos,
      elapsed_ms: nowMs() - started,
    };
  } catch (e) {
    if (isFatalPlaywrightError(e.message)) await restartBrowser(e.message);
    throw e;
  } finally {
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
  }
}

/* ================= ROUTES ================= */
app.post("/check-variants", async (req, res) => {
  try {
    const r = await enqueue(() =>
      scrapeProduct({
        product_url: normalizeText(req.body.product_url),
        max_combos: Number(req.body.max_combos ?? DEFAULT_MAX_COMBOS),
        max_ms: Number(req.body.max_ms ?? DEFAULT_MAX_MS),
      })
    );
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "stock-bot-api",
    routes: ["GET /health", "POST /check-variants"],
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    queue_len: queue.length,
    worker_running: workerRunning,
    jobs_done: jobsDone,
    browser_up: !!browser,
  });
});


app.listen(PORT, () => ensureBrowser());
