const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

// Healthcheck
app.get('/', (_req, res) => res.send('OK'));

/**
 * POST /check-variants
 * Body:
 * {
 *   "product_url": "https://....",
 *   "max_combos": 250,   // opcional
 *   "max_ms": 60000      // opcional
 * }
 */
app.post('/check-variants', async (req, res) => {
  const product_url = String(req.body?.product_url ?? '').trim();
  if (!product_url) return res.status(400).json({ error: 'product_url requerido' });

  const MAX_COMBOS = Number.isFinite(Number(req.body?.max_combos)) ? Number(req.body.max_combos) : 250;
  const MAX_MS = Number.isFinite(Number(req.body?.max_ms)) ? Number(req.body.max_ms) : 60000;

  let browser;
  const started = Date.now();

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();

    await page.goto(product_url, { waitUntil: 'networkidle', timeout: 30000 });

    // Esperar que el DOM esté listo (aunque los selects estén hidden)
    await page.waitForTimeout(500);

    // Helper: elegir el "mejor" select entre muchos duplicados (TiendaNube suele duplicar)
    const getBestSelectOptions = async (name) => {
      return await page.evaluate((name) => {
        const selects = Array.from(document.querySelectorAll(`select[name="${name}"]`));

        function score(sel) {
          const optCount = sel.querySelectorAll('option').length;
          const form = sel.closest('form');
          const hasSubmit = !!(form && form.querySelector('button[type="submit"]'));
          // prioriza el que está en un form con submit y con más options reales
          return (hasSubmit ? 1000 : 0) + optCount;
        }

        const best = selects
          .map(sel => ({ sel, s: score(sel) }))
          .sort((a, b) => b.s - a.s)[0]?.sel;

        if (!best) return [];

        return Array.from(best.querySelectorAll('option'))
          .map(o => ({
            value: o.value,
            label: (o.textContent || '').trim(),
            disabled: !!o.disabled,
          }))
          .filter(o => o.label && !o.label.toLowerCase().includes('seleccion'));
      }, name);
    };

    const talles = await getBestSelectOptions('variation[0]');
    const colores = await getBestSelectOptions('variation[1]');

    if (!talles.length || !colores.length) {
      return res.status(200).json({
        product_url,
        combos: [],
        combosCount: 0,
        tallesCount: talles.length,
        coloresCount: colores.length,
        limited: false,
        note: 'No se encontraron 2 selects variation[0] y variation[1]. Puede ser que el producto no tenga esas 2 variaciones o el template use otro name.',
      });
    }

    // Helper: setear select por VALUE y disparar change (aunque esté hidden)
    const setVariationValue = async (name, value) => {
      await page.evaluate(({ name, value }) => {
        const selects = Array.from(document.querySelectorAll(`select[name="${name}"]`));

        function score(sel) {
          const optCount = sel.querySelectorAll('option').length;
          const form = sel.closest('form');
          const hasSubmit = !!(form && form.querySelector('button[type="submit"]'));
          return (hasSubmit ? 1000 : 0) + optCount;
        }

        const sel = selects
          .map(s => ({ s, sc: score(s) }))
          .sort((a, b) => b.sc - a.sc)[0]?.s;

        if (!sel) return;

        sel.value = value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }, { name, value });
    };

    const combos = [];
    let count = 0;

    for (const t of talles) {
      if (Date.now() - started > MAX_MS) break;

      await setVariationValue('variation[0]', t.value);
      await page.waitForTimeout(150);

      for (const c of colores) {
        if (Date.now() - started > MAX_MS) break;
        if (count >= MAX_COMBOS) break;

        await setVariationValue('variation[1]', c.value);
        await page.waitForTimeout(200);

        const available = await page.evaluate(() => {
          const btn = document.querySelector('form button[type="submit"], button[type="submit"]');
          return btn ? !btn.disabled : false;
        });

        combos.push({
          talle: t.label,
          color: c.label,
          available,
        });

        count++;
      }

      if (count >= MAX_COMBOS) break;
    }

    const limited = (count >= MAX_COMBOS) || (Date.now() - started > MAX_MS);

    res.json({
      product_url,
      combos,
      combosCount: combos.length,
      tallesCount: talles.length,
      coloresCount: colores.length,
      limited,
      max_combos: MAX_COMBOS,
      max_ms: MAX_MS,
      elapsed_ms: Date.now() - started,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message, elapsed_ms: Date.now() - started });
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API escuchando en puerto ${PORT}`));
