import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

function nowMs() {
  return Date.now();
}

function normalizeText(s) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function colorFromUrl(product_url) {
  const slug = (product_url.split("/productos/")[1] || "").split("/")[0] || "";
  const parts = slug.split("-");
  if (parts.length < 2) return "";
  return parts[parts.length - 1].replace(/_/g, " ").trim();
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/check-variants", async (req, res) => {
  const started = nowMs();

  const product_url = normalizeText(req.body?.product_url);
  const max_combos = Number(req.body?.max_combos ?? 200);
  const max_ms = Number(req.body?.max_ms ?? 20000);

  if (!product_url)
    return res.status(400).json({ error: "product_url requerido" });

  const jobStarted = nowMs();
  const deadline = jobStarted + max_ms;

  let browser, context, page;

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
      serviceWorkers: "block",
      extraHTTPHeaders: { "Cache-Control": "no-cache", Pragma: "no-cache" },
    });

    page = await context.newPage();
    page.setDefaultTimeout(Math.min(20000, Math.max(5000, max_ms)));

    await page.goto(product_url, { waitUntil: "networkidle" });
    await page.waitForSelector(
      'h1, [data-store="product-name"], [data-component="product.add-to-cart"]',
      { timeout: Math.min(20000, Math.max(5000, max_ms)) }
    );

    const fallbackColor = colorFromUrl(product_url);

    // ====== ROOT DEL PRODUCTO PRINCIPAL (evita mezclar con recomendados) ======
    const rootInfo = await page.evaluate(() => {
      function pickRoot() {
        const btn =
          document.querySelector('[data-component="product.add-to-cart"]') ||
          document.querySelector("input.product-buy-btn") ||
          document.querySelector("button.product-buy-btn");

        if (btn) {
          const form = btn.closest("form");
          if (form) return { mode: "form", ok: true };
          const wrap = btn.closest(
            ".product-form, .js-product-form, .product-detail, .product-container"
          );
          if (wrap) return { mode: "wrap", ok: true };
        }
        return { mode: "document", ok: false };
      }
      return pickRoot();
    });

    // ===== 1) Descubrir variaciones SOLO dentro del root =====
    const variations = await page.evaluate(
      ({ rootInfo }) => {
        function norm(s) {
          return String(s ?? "")
            .replace(/\s+/g, " ")
            .trim();
        }

        function getRoot(rootInfo) {
          const btn =
            document.querySelector('[data-component="product.add-to-cart"]') ||
            document.querySelector("input.product-buy-btn") ||
            document.querySelector("button.product-buy-btn");

          if (rootInfo?.mode === "form" && btn)
            return btn.closest("form") || document;
          if (rootInfo?.mode === "wrap" && btn)
            return (
              btn.closest(
                ".product-form, .js-product-form, .product-detail, .product-container"
              ) || document
            );
          return document;
        }

        const root = getRoot(rootInfo);

        const groups = {};
        const elems = Array.from(root.querySelectorAll('[name^="variation["]'));

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
              root.querySelectorAll(`input[name="${CSS.escape(name)}"]`)
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

        const list = Object.values(groups).sort((a, b) => {
          const ia = parseInt((a.name.match(/\[(\d+)\]/) || [])[1] || "0", 10);
          const ib = parseInt((b.name.match(/\[(\d+)\]/) || [])[1] || "0", 10);
          return ia - ib;
        });

        return list;
      },
      { rootInfo }
    );

    // ===== 2) setVariation SOLO dentro del root =====
    async function setVariation(name, value) {
      await page.evaluate(
        ({ name, value, rootInfo }) => {
          function getRoot(rootInfo) {
            const btn =
              document.querySelector(
                '[data-component="product.add-to-cart"]'
              ) ||
              document.querySelector("input.product-buy-btn") ||
              document.querySelector("button.product-buy-btn");

            if (rootInfo?.mode === "form" && btn)
              return btn.closest("form") || document;
            if (rootInfo?.mode === "wrap" && btn)
              return (
                btn.closest(
                  ".product-form, .js-product-form, .product-detail, .product-container"
                ) || document
              );
            return document;
          }

          const root = getRoot(rootInfo);

          const sel = root.querySelector(`select[name="${CSS.escape(name)}"]`);
          if (sel) {
            sel.value = value;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            return;
          }

          const radio = root.querySelector(
            `input[name="${CSS.escape(name)}"][value="${CSS.escape(value)}"]`
          );
          if (radio) {
            radio.click();
            radio.dispatchEvent(new Event("change", { bubbles: true }));
          }
        },
        { name, value, rootInfo }
      );
    }

    // ===== 3) disponibilidad mirando SOLO el botón principal =====
    async function readAvailable() {
      return await page.evaluate(() => {
        const btn =
          document.querySelector('[data-component="product.add-to-cart"]') ||
          document.querySelector("input.product-buy-btn") ||
          document.querySelector("button.product-buy-btn");

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

        const noStock =
          disabled ||
          cls.includes("nostock") ||
          text.includes("sin stock") ||
          text.includes("agotado");

        return !noStock;
      });
    }

    // ===== 4) combos =====
    const combos = [];

    // sin variaciones: 1 “combo”
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
        elapsed_ms: nowMs() - jobStarted,
      });
    }

    // regla actual: [0]=talle [1]=color (si existe)
    const v0 = variations[0];
    const v1 = variations[1] || null;

    const talles = (v0?.options || []).filter((o) => !o.disabled);
    const colores = v1 ? (v1.options || []).filter((o) => !o.disabled) : [];

    const tallesCount = talles.length;
    const coloresCount = v1 ? colores.length : 0;

    for (const t of talles) {
      if (nowMs() > deadline) break;

      await setVariation(v0.name, t.value);
      await page.waitForTimeout(40);

      // solo talle (sin color)
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

      // talle + color
      for (const c of colores) {
        if (nowMs() > deadline) break;

        await setVariation(v1.name, c.value);
        await page.waitForTimeout(40);

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
      elapsed_ms: nowMs() - jobStarted,
    });
  } catch (err) {
    return res.status(500).json({
      product_url,
      error: String(err?.message || err),
      elapsed_ms: nowMs() - started,
    });
  } finally {
    try {
      if (page) await page.close();
    } catch {}
    try {
      if (context) await context.close();
    } catch {}
    try {
      if (browser) await browser.close();
    } catch {}
  }
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(PORT, () => console.log(`OK on port ${PORT}`));
