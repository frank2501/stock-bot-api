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
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function isFatalPlaywrightError(msg) {
  const m = String(msg || "");
  return FATAL_PATTERNS.some((p) => m.includes(p));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * NUEVO: slug y color “inteligente”
 * - toma todo lo que está después de ART-#### (o ART. ####)
 * - ignora un sufijo tipo código (bpofg / uafvv / t352x, etc)
 */
function productSlugFromUrl(product_url) {
  const after = (product_url.split("/productos/")[1] || "").split("/")[0] || "";
  return after.trim();
}

function looksLikeCodeToken(tok) {
  // ejemplos reales: bpofg, uafvv, t352x, chicle? (chicle NO es código)
  // regla: 4-6 chars alfanum, y que NO sea una palabra “normal” con vocales claras
  const t = String(tok || "").toLowerCase().trim();
  if (!/^[a-z0-9]{4,6}$/.test(t)) return false;
  // si tiene al menos 2 vocales, probablemente es palabra/color (chicle, aqua) -> no lo mates
  const vowels = (t.match(/[aeiou]/g) || []).length;
  if (vowels >= 2) return false;
  return true;
}

function cleanColorText(s) {
  return normalizeText(String(s || "").replace(/_/g, " ").replace(/-/g, " "));
}

function colorFromUrlSmart(product_url) {
  const slug = productSlugFromUrl(product_url);
  if (!slug) return "";

  const parts = slug.split("-").filter(Boolean).map((x) => x.trim());
  if (!parts.length) return "";

  // encontrar “art” + número (art 4315)
  let i = 0;
  if (parts[0].toLowerCase() === "art" || parts[0].toLowerCase() === "art.") i = 1;
  if (i < parts.length && /^\d+$/.test(parts[i])) i += 1;

  // si no matcheó el patrón, igual intentamos: buscar primer número y cortar ahí
  if (i === 0) {
    const idxNum = parts.findIndex((p) => /^\d+$/.test(p));
    if (idxNum >= 0) i = idxNum + 1;
  }

  let colorParts = parts.slice(i);
  if (!colorParts.length) return "";

  // sacar sufijo tipo código (bpofg/uafvv/t352x/etc)
  const last = colorParts[colorParts.length - 1];
  if (looksLikeCodeToken(last)) {
    colorParts = colorParts.slice(0, -1);
  }

  // caso borde: si quedó vacío, devolvemos el último “no código”
  if (!colorParts.length) return "";

  return cleanColorText(colorParts.join(" "));
}

/**
 * Heurística para detectar “talle”
 * (T1/T2..., S/M/L/XL..., 85/90..., 36/38..., etc)
 */
function isLikelySizeLabel(label) {
  const s = String(label || "").toLowerCase().trim();

  // t1, t2, t3...
  if (/\bt\s*\d+\b/.test(s)) return true;

  // xs/s/m/l/xl/xxl/xxxl
  if (/\b(xxs|xs|s|m|l|xl|xxl|xxxl)\b/.test(s)) return true;

  // números típicos de talle (ropa / corpiño / jean)
  if (/^\d{1,3}$/.test(s)) return true; // 85, 90, 95, 36, 38...
  if (/\b(34|35|36|37|38|39|40|41|42|43|44|45|46|47|48|49|50)\b/.test(s))
    return true;

  // “único”
  if (/\b(único|unico|unique|one size|talle unico)\b/.test(s)) return true;

  return false;
}

function talleScoreForGroup(group) {
  const opts = Array.isArray(group?.options) ? group.options : [];
  if (!opts.length) return 0;

  let hits = 0;
  for (const o of opts) {
    const lbl = o.label || o.value || "";
    if (isLikelySizeLabel(lbl)) hits++;
  }
  return hits / opts.length; // 0..1
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
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

    // NUEVO: sacar title (para fallback de color si no hay variación de color)
    const pageTitle = await page.evaluate(() => {
      const h1 =
        document.querySelector("h1.product-name") ||
        document.querySelector("h1[itemprop='name']") ||
        document.querySelector("h1") ||
        null;
      return h1 ? String(h1.textContent || "").trim() : "";
    });

    function colorFromTitleSmart(title) {
      const t = String(title || "").replace(/\s+/g, " ").trim();
      if (!t) return "";

      // ejemplo: "ART. 4315 - LILA Y ROSA CHICLE"
      const partsDash = t.split(" - ").map((x) => x.trim()).filter(Boolean);
      if (partsDash.length >= 2) {
        // todo lo que va después del primer " - "
        return cleanColorText(partsDash.slice(1).join(" - "));
      }

      // fallback: si hay "art" y número, tomar lo que sigue
      const m = t.match(/art\.?\s*\d+\s*(.*)$/i);
      if (m && m[1]) return cleanColorText(m[1]);

      return "";
    }

    const fallbackColor =
      colorFromTitleSmart(pageTitle) || colorFromUrlSmart(product_url);

    // ===== 1) detectar variaciones del DOM (SOLO VISIBLES) =====
    const variations = await page.evaluate(() => {
      const norm = (s) =>
        String(s ?? "")
          .replace(/\s+/g, " ")
          .trim();

      const form =
        document.querySelector('form[action*="/cart"]') ||
        document.querySelector('form[action*="carrito"]') ||
        document.querySelector("form.product-form") ||
        document
          .querySelector('[data-component="product.add-to-cart"]')
          ?.closest("form") ||
        document.querySelector("form");

      const scope = form || document;

      const groups = {};
      const elems = Array.from(scope.querySelectorAll('[name^="variation["]'));

      for (const el of elems) {
        const name = el.getAttribute("name") || "";
        if (!name) continue;

        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute("type") || "").toLowerCase();

        if (type === "hidden") continue;

        groups[name] ??= { name, kind: "", options: [] };

        if (tag === "select") {
          groups[name].kind = "select";
          const opts = Array.from(el.querySelectorAll("option")).map((o) => ({
            value: norm(o.getAttribute("value") || ""),
            label: norm(o.textContent),
            disabled: !!o.disabled,
          }));
          groups[name].options = opts.filter((o) => o.value !== "" && !o.disabled);
        } else if (tag === "input" && (type === "radio" || type === "checkbox")) {
          groups[name].kind = "radio";
          const radios = Array.from(
            scope.querySelectorAll(`input[name="${CSS.escape(name)}"]`)
          );
          const mapped = radios.map((r) => ({
            value: norm(r.getAttribute("value") || ""),
            label:
              norm(r.getAttribute("aria-label")) ||
              norm(r.getAttribute("title")) ||
              norm(r.value),
            disabled: !!r.disabled,
          }));
          const seen = new Set();
          groups[name].options = mapped.filter((o) => {
            if (!o.value || o.disabled) return false;
            const k = `${o.value}||${o.label}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        }
      }

      return Object.values(groups).sort((a, b) => {
        const ia = parseInt((a.name.match(/\[(\d+)\]/) || [])[1] || "0", 10);
        const ib = parseInt((b.name.match(/\[(\d+)\]/) || [])[1] || "0", 10);
        return ia - ib;
      });
    });

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

    // Caso: sin variaciones
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

    // ---------- soportar N variaciones ----------
    const vars = variations
      .map((v) => ({
        name: v.name,
        options: Array.isArray(v.options) ? v.options.filter((o) => !o.disabled) : [],
      }))
      .filter((v) => v.options.length > 0);

    if (!vars.length) {
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

    /**
     * NUEVO: elegir “talleVar” por score (arregla color/talle invertidos)
     * - si algún grupo tiene score >= 0.6 lo tomamos como talle
     * - si no, agarramos el de mayor score
     * - si todos empatan en 0, queda el primero (como antes)
     */
    const scored = vars.map((v, idx) => ({
      idx,
      v,
      score: talleScoreForGroup(v),
    }));

    scored.sort((a, b) => b.score - a.score);

    let tallePick = scored[0]; // best
    // si el best es muy bajo, volvemos al comportamiento original (primer grupo)
    if ((tallePick?.score ?? 0) < 0.2) {
      tallePick = { idx: 0, v: vars[0], score: 0 };
    }

    const talleVar = tallePick.v;

    // mantener orden original para el resto
    const otherVars = vars.filter((x) => x.name !== talleVar.name);

    const talles = talleVar.options;

    // “coloresCount” compat: cantidad de opciones del primer “otro” grupo
    const coloresCountCompat = otherVars[0]?.options?.length ?? 0;

    function buildOtherCombos() {
      if (!otherVars.length) return [[]];

      let acc = [[]];
      for (const v of otherVars) {
        const next = [];
        for (const partial of acc) {
          for (const opt of v.options) {
            next.push([...partial, { varName: v.name, opt }]);
            if (next.length >= max_combos) break;
          }
          if (next.length >= max_combos) break;
        }
        acc = next;
        if (acc.length >= max_combos) break;
      }
      return acc;
    }

    const otherCombos = buildOtherCombos();

    for (const t of talles) {
      if (nowMs() > deadline) break;

      await setVariation(talleVar.name, t.value);
      await page.waitForTimeout(UI_TICK_MS);

      if (!otherVars.length) {
        const available = await readAvailable();
        combos.push({
          talle: t.label || t.value,
          color: fallbackColor || "(sin color)",
          available: available === true,
        });
        if (combos.length >= max_combos) break;
        continue;
      }

      for (const parts of otherCombos) {
        if (nowMs() > deadline) break;

        for (const p of parts) {
          await setVariation(p.varName, p.opt.value);
          await page.waitForTimeout(UI_TICK_MS);
        }

        const available = await readAvailable();

        const colorLabel = parts
          .map((p) => p.opt.label || p.opt.value)
          .filter(Boolean)
          .join(" | ");

        combos.push({
          talle: t.label || t.value,
          color: colorLabel || fallbackColor || "(sin color)",
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
      coloresCount: coloresCountCompat,
      limited,
      max_combos,
      max_ms,
      elapsed_ms: nowMs() - started,
    };
  } catch (err) {
    const msg = String(err?.message || err);

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
app.get("/", (_req, res) => {
  res.json({ ok: true, routes: ["GET /health", "POST /check-variants"] });
});

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

    if (err?.status === 429 || msg === "queue_full") {
      return res.status(429).json({
        error: "busy",
        retry_after_ms: err.retry_after_ms ?? 30000,
        queue_len: queue.length,
        elapsed_ms: nowMs() - started,
      });
    }

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
  console.log(`Server listening on port ${PORT}`);
  ensureBrowser().catch(() => {});
});
