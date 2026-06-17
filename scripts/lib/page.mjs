// Shared page helpers for the browser-driven runners.
//
// settlePage(): get a page into a "real, painted" state before screenshotting —
//   wait out intro loaders/preloaders (including full-screen black overlays),
//   scroll top-to-bottom to trigger lazy-loaded and scroll-reveal (opacity:0)
//   content, then return to the top. This is what fixes "black screenshot" on
//   animation-heavy sites (Elementor/GSAP/AOS, etc.).
//
// annotateAndShoot(): draw a highlight box around a specific element and take a
//   screenshot, so a non-technical reader can SEE exactly what a finding refers
//   to and judge whether it's a real problem or intentional.

const LOADER_SELECTORS = [
  '.elementor-loading',
  '.preloader',
  '#preloader',
  '.page-loader',
  '#loader',
  '.loader-wrapper',
  '.loading-overlay',
  '[class*="preloader"]',
  '[class*="page-loading"]',
  '[id*="preloader"]',
];

export async function settlePage(page, { scroll = true } = {}) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  // try for network idle but never hang on sites that poll/animate forever
  await Promise.race([page.waitForLoadState('networkidle').catch(() => {}), page.waitForTimeout(2500)]);

  // 1) wait for known loaders to be hidden (absent selectors resolve instantly)
  await Promise.all(
    LOADER_SELECTORS.map((sel) => page.waitForSelector(sel, { state: 'hidden', timeout: 2500 }).catch(() => {}))
  );

  // 2) generic: wait for any full-viewport fixed/absolute overlay (e.g. a black
  //    intro loader) to disappear or fade out
  await page
    .waitForFunction(
      () => {
        const vw = window.innerWidth,
          vh = window.innerHeight;
        for (const el of document.querySelectorAll('body *')) {
          const s = getComputedStyle(el);
          if (s.position !== 'fixed' && s.position !== 'absolute') continue;
          if (s.opacity === '0' || s.visibility === 'hidden' || s.display === 'none') continue;
          const r = el.getBoundingClientRect();
          const coversViewport = r.width >= vw * 0.9 && r.height >= vh * 0.9 && r.top <= 1 && r.left <= 1;
          const onTop = parseInt(s.zIndex || '0', 10) >= 100;
          if (coversViewport && onTop) return false; // still covered
        }
        return true;
      },
      { timeout: 3000 }
    )
    .catch(() => {});

  // 3) scroll through to trigger lazy images and scroll-reveal animations
  if (scroll) {
    await page
      .evaluate(async () => {
        await new Promise((resolve) => {
          let total = 0;
          const step = Math.max(400, Math.round(window.innerHeight * 0.9));
          const timer = setInterval(() => {
            window.scrollBy(0, step);
            total += step;
            if (total >= document.body.scrollHeight - window.innerHeight || total > 16000) {
              clearInterval(timer);
              resolve();
            }
          }, 60);
        });
      })
      .catch(() => {});
    await page.waitForTimeout(350);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.waitForTimeout(350);
  }
}

// Highlight one element (by Playwright locator) and screenshot the viewport
// around it. Returns a JPEG data-URI, or null if the element can't be shown.
export async function annotateAndShoot(page, locator, { quality = 72, label = '' } = {}) {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 4000 });
    await page.waitForTimeout(150);
    const box = await locator.boundingBox();
    if (!box) return null;

    // draw a red outline + label over the element
    await page.evaluate(
      ({ box, label }) => {
        const o = document.createElement('div');
        o.id = '__qa_highlight__';
        Object.assign(o.style, {
          position: 'fixed',
          left: box.x + 'px',
          top: box.y + 'px',
          width: box.width + 'px',
          height: box.height + 'px',
          border: '3px solid #dc2626',
          boxShadow: '0 0 0 3px rgba(220,38,38,.25), 0 0 0 9999px rgba(0,0,0,.08)',
          borderRadius: '2px',
          zIndex: 2147483647,
          pointerEvents: 'none',
          boxSizing: 'border-box',
        });
        if (label) {
          const tag = document.createElement('div');
          tag.textContent = label;
          Object.assign(tag.style, {
            position: 'absolute',
            top: '-22px',
            left: '-3px',
            background: '#dc2626',
            color: '#fff',
            font: '600 11px -apple-system,Segoe UI,sans-serif',
            padding: '2px 6px',
            borderRadius: '3px 3px 0 0',
            whiteSpace: 'nowrap',
          });
          o.appendChild(tag);
        }
        document.body.appendChild(o);
      },
      { box, label }
    );

    const buf = await page.screenshot({ type: 'jpeg', quality, fullPage: false });
    await page.evaluate(() => document.getElementById('__qa_highlight__')?.remove()).catch(() => {});
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch {
    await page.evaluate(() => document.getElementById('__qa_highlight__')?.remove()).catch(() => {});
    return null;
  }
}

// Highlight several elements at once (e.g. all small tap targets) and shoot.
// boxes are in absolute page coordinates (left+scrollX, top+scrollY).
export async function annotateManyAndShoot(page, boxes, { quality = 72, color = '#dc2626', fullPage = true } = {}) {
  try {
    if (!boxes.length) return null;
    await page.evaluate(
      ({ boxes, color }) => {
        const wrap = document.createElement('div');
        wrap.id = '__qa_highlights__';
        for (const b of boxes) {
          const o = document.createElement('div');
          Object.assign(o.style, {
            position: 'absolute',
            left: b.x + 'px',
            top: b.y + 'px',
            width: b.width + 'px',
            height: b.height + 'px',
            border: '2px solid ' + color,
            background: 'rgba(220,38,38,.12)',
            borderRadius: '3px',
            zIndex: 2147483647,
            pointerEvents: 'none',
            boxSizing: 'border-box',
          });
          wrap.appendChild(o);
        }
        document.body.appendChild(wrap);
      },
      { boxes, color }
    );
    const buf = await page.screenshot({ type: 'jpeg', quality, fullPage });
    await page.evaluate(() => document.getElementById('__qa_highlights__')?.remove()).catch(() => {});
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch {
    await page.evaluate(() => document.getElementById('__qa_highlights__')?.remove()).catch(() => {});
    return null;
  }
}
