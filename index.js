const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

app.get('/', (_req, res) => res.send('OK'));

app.post('/check-variants', async (req, res) => {
  const product_url = String(req.body?.product_url ?? '').trim();
  if (!product_url) return res.status(400).json({ error: 'product_url requerido' });

  const MAX_COMBOS = Number.isFinite(Number(req.body?.max_combos)) ? Number(req.body.max_combos) : 300;
  const MAX_MS = Number.isFinite(Number(req.body?.max_ms)) ? Number(req.body.max_ms) : 60000;

  let browser;
  const started = Date.now();

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.goto(product_url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(800);

    // --- helpers dentro de la página ---
    const getVisibleOptions = async () => {
      return await page.evaluate(() => {
        const isVisible = (el) => {
          if (!el) return false;
          const st = window.getComputedStyle(el);
          if (!st) return false;
          if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
          // offsetParent null suele significar hidden (excepto position:fixed)
          if (el.offsetParent === null && st.position !== 'fixed') return false;
          return true;
        };

        const pick = (cls) => {
          const all = Array.from(document.querySelectorAll(`a.js-insta-variant.${cls}`))
            .filter(isVisible);

          // dedupe por data-option (hay duplicados)
          const seen = new Set();
          const out = [];
          for (const a of all) {
            const opt = a.getAttribute('data-option') || '';
            if (!opt || seen.has(opt)) continue;
            seen.add(opt);
            out.push({
              option: opt,
              label: (a.textContent || '').trim() || opt,
            });
          }
          return out;
        };

        return {
          talles: pick('Talle'),
          colores: pick('Color'),
        };
      });
    };

    const clickOption = async (cls, option) => {
      return await page.evaluate(({ cls, option }) => {
        const isVisible = (el) => {
          const st = window.getComputedStyle(el);
          if (!st) return false;
          if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
          if (el.offsetParent === null && st.position !== 'fixed') return false;
          return true;
        };

        const candidates = Array.from(document.querySelectorAll(`a.js-insta-variant.${cls}`))
          .filter(isVisible);

        const el = candidates.find(a => (a.getAttribute('data-option') || '') === option);

        if (!el) return { ok: false, reason: 'not_found' };

        el.click();
        return { ok: true };
      }, { cls, option });
    };

    const getAvailability = async (talleOption, colorOption) => {
      return await page.evaluate(({ talleOption, colorOption }) => {
        const isVisible = (el) => {
          const st = window.getComputedStyle(el);
          if (!st) return false;
          if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
          if (el.offsetParent === null && st.position !== 'fixed') return false;
          return true;
        };

        const findVisibleChip = (cls, option) => {
          const candidates = Array.from(document.querySelectorAll(`a.js-insta-variant.${cls}`))
            .filter(isVisible);
          return candidates.find(a => (a.getAttribute('data-option') || '') === option) || null;
        };

        const talleEl = findVisibleChip('Talle', talleOption);
        const colorEl = findVisibleChip('Color', colorOption);

        // 1) chip con clase de no stock (rayita)
        const chipNoStock =
          (talleEl && talleEl.classList.contains('btn-variant-no-stock')) ||
          (colorEl && colorEl.classList.contains('btn-variant-no-stock'));

        // 2) CTA real de esta tienda: input.product-buy-btn ... disabled ... class nostock ... value "Sin stock"
        const submit =
          document.querySelector('input.product-buy-btn[type="submit"]') ||
          document.querySelector('form input[type="submit"]') ||
          document.querySelector('form button[type="submit"]') ||
          document.querySelector('button[type="submit"]');

        const submitDisabled = submit ? !!submit.disabled : true; // si no hay submit, asumí no disponible
        const submitClass = submit ? (submit.className || '').toLowerCase() : '';
        const submitValue = submit
          ? (submit.tagName === 'INPUT' ? (submit.getAttribute('value') || '') : (submit.textContent || ''))
          : '';

        const submitNoStock =
          submitDisabled ||
          submitClass.includes('nostock') ||
          submitValue.toLowerCase().includes('sin stock');

        // Regla final
        if (chipNoStock) return false;
        if (submitNoStock) return false;

        return true;
      }, { talleOption, colorOption });
    };

    // --- tomar opciones desde chips visibles ---
    const { talles, colores } = await getVisibleOptions();

    if (!talles.length || !colores.length) {
      return res.status(200).json({
        product_url,
        combos: [],
        combosCount: 0,
        tallesCount: talles.length,
        coloresCount: colores.length,
        limited: false,
        note: 'No encontré chips visibles de Talle/Color (a.js-insta-variant).',
      });
    }

    const combos = [];
    let count = 0;

    for (const t of talles) {
      if (Date.now() - started > MAX_MS) break;
      if (count >= MAX_COMBOS) break;

      const ct = await clickOption('Talle', t.option);
      if (!ct.ok) continue;

      await page.waitForTimeout(250);

      for (const c of colores) {
        if (Date.now() - started > MAX_MS) break;
        if (count >= MAX_COMBOS) break;

        const cc = await clickOption('Color', c.option);
        if (!cc.ok) continue;

        await page.waitForTimeout(250);

        const available = await getAvailability(t.option, c.option);

        combos.push({
          talle: t.label,
          color: c.label,
          available,
        });

        count++;
      }
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
    res.status(500).json({ error: err.message, elapsed_ms: Date.now() - started });
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API escuchando en puerto ${PORT}`));
