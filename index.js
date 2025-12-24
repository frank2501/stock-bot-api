import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

/**
 * =========================
 *  CONFIG
 * =========================
 */
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// límite de cola: si n8n se enloquece, devolvemos 429
const MAX_QUEUE = Number(process.env.MAX_QUEUE ?? 50);

// reinicio preventivo del browser cada N jobs (baja leaks/riesgos)
const RESTART_EVERY_JOBS = Number(process.env.RESTART_EVERY_JOBS ?? 80);

// timeouts
const DEFAULT_MAX_MS = Number(process.env.DEFAULT_MAX_MS ?? 20000);
const DEFAULT_MAX_COMBOS = Number(process.env.DEFAULT_MAX_COMBOS ?? 200);
const STEP_TIMEOUT_CAP_MS = 15000;

// micro-wait luego de cambiar variación
const UI_TICK_MS = Number(process.env.UI_TICK_MS ?? 120);

// si hay un error “fatal”, reiniciamos browser, y si no se puede, matamos proceso (Railway revive)
const FATAL_PATTERNS = [
  "EAGAIN",
  "spawn ",
  "browserType.launch",
  "Failed to launch",
  "Executable doesn't exist",
  "Target closed",
  "Browser has been closed",
];

/**
 * =========================
 *  UTILS
 * =========================
 */
function nowMs() {
  return Date.now();
}

function normalizeText(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function isFatalPlaywrightError(msg) {
  const m = String(msg || "");
  return FATAL_PATTERNS.some((p) => m.includes(p));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function colorFromUrl(product_url) {
  // ej: /productos/art-4315-malbec/ -> "malbec"
  const slug = (product_url.split("/productos/")[1] || "").split("/")[0] || "";
  const parts = slug.split("-");
  if (parts.length < 2) return "";
  return parts[parts.length - 1].replace(/_/g, " ").trim();
}

/**
 * =========================
 *  BROWSER MANAGER (1 browser vivo)
 * =========================
 */
let browser = null;
let browserLaunching = null;
let jobsDone = 0;
let lastBrowserStart = 0;

async function ensureBrowser() {
  if (browser) return browser;
  if (browserLaunching) return browserLaunching;

  browserLaunching = (async () => {
    try {
      const b = await chromium.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      });
      browser = b;
      lastBrowserStart = nowMs();
      return browser;
    } catch (err) {
      const msg = String(err?.message || err);
      console.error("Failed to launch browser:", msg);
      // si no podemos lanzar, matamos proceso -> Railway restart
      setTimeout(() => process.exit(1), 200);
      throw err;
    } finally {
      browserLaunching = null;
    }
  })();

  return browserLaunching;
}

async function restartBrowser(reason = "unknown") {
  console.warn("Restarting browser. reason:", reason);
  try {
    if (browser) await browser.close();
  } catch {}
  browser = null;
  // backoff mínimo
  await sleep(250);
  await ensureBrowser();
}

/**
 * =========================
 *  QUEUE (1 worker)
 * =========================
 */
const queue = [];
let workerRunning = false;

function queueStats() {
  return {
    ok: true,
    queue_len: queue.length,
    worker_running: workerRunning,
    jobs_done: jobsDone,
    browser_up: !!browser,
    last_browser_start_ms_ago: lastBrowserStart ? nowMs() - lastBrowserStart : null,
  };
}

function enqueue(jobFn) {
  if (queue.length >= MAX_QUEUE) {
    const err = new Error("queue_full");
    err.status = 429;
    err.retry_after_ms = 30000;
    throw err;
  }

  return new Promise((resolve, reject) => {
    queue.push({ jobFn, resolve, reject });
    runWorker().catch((e) => console.error("worker crash:", e));
  });
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;

  try {
    while (queue.length) {
      // restart preventivo cada N jobs
      if (browser && jobsDone > 0 && jobsDone % RESTART_EVERY_JOBS === 0) {
        await restartBrowser("preventive_restart");
      }

      const item = queue.shift();
      if (!item) continue;

      try {
        const result = await item.jobFn();
        item.resolve(result);
      } catch (err) {
        item.reject(err);
      }
    }
  } finally {
    workerRunning = false;
  }
}

/**
 * =========================
 *  CORE SCRAPER (1 product)
 * =========================
 */
async function scrapeProduct({ product_url, max_combos, max_ms }) {
  const started = nowMs();
  const deadline = started + max_ms;

  const b = await ensureBrowser();

  let context = null;
  let page = null;

  try {
    context = await b.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    });

    page = await context.newPage();
    page.setDefaultTimeout(Math.min(STEP_TIMEOUT_CAP_MS, max_ms));

    await page.goto(product_url, { waitUntil: "domcontentloaded" });

    // ===== 1) detectar variations del DOM =====
    const variations = await page.evaluate(() => {
      function norm(s) {
        return String(s ?? "").replace(/\s+/g, " ").trim();
      }

      const groups = {};
      const elems = Array.from(document.querySelectorAll('[name^="variation["]'));

      for (const el of elems) {
        const name = el.getAttribute("name") || "";
        if (!name) continue;

        const type = (el.getAttribute("type") || "").toLowerCase();
        if (type === "hidden") continue;

        groups[name] = groups[name] || { name, kind: "", options: [] };

        if (el.tagName.toLowerCase() === "select") {
          groups[name].kind = "select";
          const opts = Array.from(el.querySelectorAll("option")).map((o) => ({
            value: norm(o.getAttribute("value") || o.textContent),
            label: norm(o.textContent),
            disabled: o.disabled,
          }));
          groups[name].options = opts.filter((o) => o.value !== "");
        } else if (
          el.tagName.toLowerCase() === "input" &&
          ["radio", "checkbox"].includes(type)
        ) {
          groups[name].kind = "radio";
          const radios = Array.from(
            document.querySelectorAll(`input[name="${CSS.escape(name)}"]`)
          );
          groups[name].options = radios.map((r) => ({
            value: norm(r.getAttribute("value") || ""),
            label:
              norm(r.getAttribute("aria-label")) ||
              norm(r.getAttribute("title")) ||
              norm(r.value),
            disabled: r.disabled,
          }));
        }
      }

      return Object.values(groups).sort((a, b) => {
        const ia = parseInt((a.name.match(/\[(\d+)\]/) || [])[1] || "0", 10);
        const ib = parseInt((b.name.match(/\[(\d+)\]/) || [])[1] || "0", 10);
        return ia - ib;
      });
    });

    const fallbackColor = colorFromUrl(product_url);

    async function setVariation(name, value) {
      await page.evaluate(
        ({ name, value }) => {
          const sel = document.querySelector(`select[name="${CSS.escape(name)}"]`);
          if (sel) {
            sel.value = value;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            return;
          }
          const radio = document.querySelector(
            `input[name="${CSS.escape(name)}"][value="${CSS.escape(value)}"]`
          );
          if (radio) {
            radio.click();
            radio.dispatchEvent(new Event("change", { bubbles: true }));
          }
        },
        { name, value }
      );
    }

    // disponibilidad basada en botón “Sin stock”
    async function readAvailable() {
      return await page.evaluate(() => {
        const btn =
          document.querySelector("input.product-buy-btn") ||
          document.querySelector("button.product-buy-btn") ||
          document.querySelector('[data-component="product.add-to-cart"]');

        if (!btn) return null;

        const disabled =
          (btn instanceof HTMLInputElement || btn instanceof HTMLButtonElement) &&
          btn.disabled === true;

        const cls = (btn.getAttribute("class") || "").toLowerCase();
        const val =
          btn instanceof HTMLInputElement ? btn.value || "" : btn.textContent || "";
        const text = String(val).toLowerCase();

        const noStock =
          disabled ||
          cls.includes("nostock") ||
          text.includes("sin stock") ||
          text.includes("agotado");

        return !noStock;
      });
    }

    const combos = [];

    // Caso: sin variaciones detectadas (raro en tu caso, pero lo dejo prolijo)
    if (!variations.length) {
      const available = await readAvailable();
      combos.push({
        talle: "(sin talle)",
        color: fallbackColor || "(sin color)",
        available: available === true,
      });

      jobsDone++;
      return {
        product_url,
        combos,
        combosCount: combos.length,
        tallesCount: 0,
        coloresCount: 0,
        limited: false,
        max_combos,
        max_ms,
        elapsed_ms: nowMs() - started,
      };
    }

    // Asumimos:
    // variation[0] = talle (SIEMPRE)
    // variation[1] = color (si existe)
    const v0 = variations[0];
    const v1 = variations[1] || null;

    const talles = (v0?.options || []).filter((o) => !o.disabled);
    const colores = v1 ? (v1.options || []).filter((o) => !o.disabled) : [];

    for (const t of talles) {
      if (nowMs() > deadline) break;

      await setVariation(v0.name, t.value);
      await page.waitForTimeout(UI_TICK_MS);

      if (!v1) {
        // solo talle
        const available = await readAvailable();
        combos.push({
          talle: t.label || t.value,
          color: fallbackColor || "(sin color)",
          available: available === true,
        });
        if (combos.length >= max_combos) break;
        continue;
      }

      for (const c of colores) {
        if (nowMs() > deadline) break;

        await setVariation(v1.name, c.value);
        await page.waitForTimeout(UI_TICK_MS);

        const available = await readAvailable();

        combos.push({
          talle: t.label || t.value,
          color: c.label || c.value,
          available: available === true,
        });

        if (combos.length >= max_combos) break;
      }

      if (combos.length >= max_combos) break;
    }

    const limited = combos.length >= max_combos || nowMs() > deadline;

    jobsDone++;
    return {
      product_url,
      combos,
      combosCount: combos.length,
      tallesCount: talles.length,
      coloresCount: v1 ? colores.length : 0,
      limited,
      max_combos,
      max_ms,
      elapsed_ms: nowMs() - started,
    };
  } catch (err) {
    const msg = String(err?.message || err);

    // si se rompió el browser / target cerrado / etc, reiniciamos browser para próximos jobs
    if (isFatalPlaywrightError(msg)) {
      await restartBrowser(msg);
    }

    throw new Error(msg);
  } finally {
    try {
      if (page) await page.close();
    } catch {}
    try {
      if (context) await context.close();
    } catch {}
  }
}

/**
 * =========================
 *  ROUTES
 * =========================
 */
app.get("/health", (_req, res) => {
  res.json(queueStats());
});

app.post("/check-variants", async (req, res) => {
  const started = nowMs();

  const product_url = normalizeText(req.body?.product_url);
  const max_combos = Number(req.body?.max_combos ?? DEFAULT_MAX_COMBOS);
  const max_ms = Number(req.body?.max_ms ?? DEFAULT_MAX_MS);

  if (!product_url) {
    return res.status(400).json({ error: "product_url requerido" });
  }

  try {
    const result = await enqueue(() =>
      scrapeProduct({ product_url, max_combos, max_ms })
    );

    return res.json(result);
  } catch (err) {
    const msg = String(err?.message || err);

    // cola llena
    if (err?.status === 429 || msg === "queue_full") {
      return res.status(429).json({
        error: "busy",
        retry_after_ms: err.retry_after_ms ?? 30000,
        queue_len: queue.length,
        elapsed_ms: nowMs() - started,
      });
    }

    // si es fatal y sigue pasando, matamos el proceso para que Railway lo reinicie “limpio”
    if (isFatalPlaywrightError(msg)) {
      console.error("FATAL (request) -> restart process:", msg);
      setTimeout(() => process.exit(1), 200);
    }

    return res.status(500).json({
      error: msg,
      queue_len: queue.length,
      elapsed_ms: nowMs() - started,
    });
  }
});

/**
 * =========================
 *  GRACEFUL SHUTDOWN
 * =========================
 */
async function shutdown() {
  console.log("Shutting down...");
  try {
    if (browser) await browser.close();
  } catch {}
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

app.listen(PORT, async () => {
  console.log(`OK on port ${PORT}`);
  // warm-up browser (opcional, acelera primer request)
  ensureBrowser().catch(() => {});
});
