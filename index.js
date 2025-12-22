import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ====== LOCK GLOBAL (evita EAGAIN por spawnear 2 Chromium) ======
let busy = false;

// ====== UTILS ======
function nowMs() {
  return Date.now();
}

function normalizeText(s) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function colorFromUrl(product_url) {
  // ej: /productos/art-4315-malbec/ -> "malbec"
  const slug = (product_url.split("/productos/")[1] || "").split("/")[0] || "";
  const parts = slug.split("-");
  if (parts.length < 2) return "";
  return parts[parts.length - 1].replace(/_/g, " ").trim();
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, busy });
});

app.post("/check-variants", async (req, res) => {
  const started = nowMs();

  const product_url = normalizeText(req.body?.product_url);
  const max_combos = Number(req.body?.max_combos ?? 200);
  const max_ms = Number(req.body?.max_ms ?? 20000);

  if (!product_url) {
    return res.status(400).json({ error: "product_url requerido" });
  }

  // lock: 1 corrida a la vez por instancia
  if (busy) {
    return res.status(429).json({
      error: "busy",
      retry_after_ms: 5000,
      elapsed_ms: nowMs() - started,
    });
  }
  busy = true;

  let browser;
  let context;
  let page;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    });

    page = await context.newPage();

    // timeout por step (igual cortamos con max_ms)
    page.setDefaultTimeout(Math.min(15000, max_ms));

    await page.goto(product_url, { waitUntil: "domcontentloaded" });

    // ===== 1) Descubrir “variations” del DOM =====
    // Soporta:
    // - select[name="variation[0]"], select[name="variation[1]"]
    // - radios/inputs con name variation[x]
    const variations = await page.evaluate(() => {
      function norm(s) {
        return String(s ?? "")
          .replace(/\s+/g, " ")
          .trim();
      }

      // agrupar por name: variation[0], variation[1], ...
      const groups = {};

      const elems = Array.from(
        document.querySelectorAll('[name^="variation["]')
      );

      for (const el of elems) {
        const name = el.getAttribute("name") || "";
        if (!name) continue;

        // ignorar inputs hidden
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
          // radios: juntamos todos los del mismo name
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
        } else {
          // fallback: no lo usamos
        }
      }

      // ordenar por índice variation[0], variation[1], ...
      const list = Object.values(groups).sort((a, b) => {
        const ia = parseInt((a.name.match(/\[(\d+)\]/) || [])[1] || "0", 10);
        const ib = parseInt((b.name.match(/\[(\d+)\]/) || [])[1] || "0", 10);
        return ia - ib;
      });

      return list;
    });

    // si no hay variaciones, igual podemos chequear stock del “único”
    const fallbackColor = colorFromUrl(product_url);

    // ===== 2) Función: setear variación SIN necesidad de que sea visible =====
    async function setVariation(name, value) {
      // intenta select o radio. No exige visible.
      await page.evaluate(
        ({ name, value }) => {
          const sel = document.querySelector(
            `select[name="${CSS.escape(name)}"]`
          );
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

    // ===== 3) Función: leer disponibilidad por botón “Sin stock” =====
    async function readAvailable() {
      return await page.evaluate(() => {
        const btn =
          document.querySelector("input.product-buy-btn") ||
          document.querySelector("button.product-buy-btn") ||
          document.querySelector('[data-component="product.add-to-cart"]');

        if (!btn) return null;

        const disabled =
          (btn instanceof HTMLInputElement ||
            btn instanceof HTMLButtonElement) &&
          btn.disabled === true;

        const cls = (btn.getAttribute("class") || "").toLowerCase();
        const val =
          btn instanceof HTMLInputElement
            ? btn.value || ""
            : btn.textContent || "";
        const text = String(val).toLowerCase();

        // criterios de NO stock típicos de TiendaNube
        const noStock =
          disabled ||
          cls.includes("nostock") ||
          text.includes("sin stock") ||
          text.includes("agotado");

        return !noStock;
      });
    }

    // ===== 4) Armar combos =====
    const combos = [];
    const deadline = started + max_ms;

    // Caso A: sin variaciones detectadas -> 1 “combo”
    if (!variations.length) {
      const available = await readAvailable();
      combos.push({
        talle: "(sin talle)",
        color: fallbackColor || "(sin color)",
        available: available === true,
      });

      return res.json({
        product_url,
        combos,
        combosCount: combos.length,
        tallesCount: 0,
        coloresCount: 0,
        limited: false,
        max_combos,
        max_ms,
        elapsed_ms: nowMs() - started,
      });
    }

    // Tomamos:
    // variation[0] = talle
    // variation[1] = color (si existe)
    const v0 = variations[0];
    const v1 = variations[1] || null;

    const talles = (v0?.options || []).filter((o) => !o.disabled);
    const colores = v1 ? (v1.options || []).filter((o) => !o.disabled) : [];

    const tallesCount = talles.length;
    const coloresCount = v1 ? colores.length : 0;

    // Iteración
    for (const t of talles) {
      if (nowMs() > deadline) break;

      await setVariation(v0.name, t.value);
      // micro wait para que actualice UI
      await page.waitForTimeout(120);

      if (!v1) {
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
        await page.waitForTimeout(120);

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

    return res.json({
      product_url,
      combos,
      combosCount: combos.length,
      tallesCount,
      coloresCount,
      limited,
      max_combos,
      max_ms,
      elapsed_ms: nowMs() - started,
    });
  } catch (err) {
    return res.status(500).json({
      error: String(err?.message || err),
      elapsed_ms: nowMs() - started,
    });
  } finally {
    // cerrar SIEMPRE
    try {
      if (page) await page.close();
    } catch {}
    try {
      if (context) await context.close();
    } catch {}
    try {
      if (browser) await browser.close();
    } catch {}
    busy = false;
  }
});

// Railway usa PORT
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(PORT, () => {
  console.log(`OK on port ${PORT}`);
});
