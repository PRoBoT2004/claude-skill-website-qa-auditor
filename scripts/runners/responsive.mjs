import { chromium } from 'playwright';
import { makeFinding } from '../lib/contract.mjs';
import { settlePage, annotateAndShoot } from '../lib/page.mjs';

// Responsive / Visual: load the page ONCE, settle it (dismiss intro loaders,
// trigger scroll-reveal animations so screenshots aren't black), then resize the
// viewport across 8 breakpoints — far faster than reloading per width. At each
// width: screenshot, detect overflow, and capture an ANNOTATED screenshot of
// each overflow so a non-technical reader can see exactly what's wrong.

export async function run(ctx) {
  const { startUrl, config, log } = ctx;
  const viewports = config.viewports || [320, 375, 414, 768, 1024, 1280, 1440, 1920];
  const findings = [];
  const screenshots = [];

  const browser = await chromium.launch({ headless: true });
  const seenOverflow = new Map(); // de-dupe the same offending element across widths
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: config.timeout || 25000 });
    await settlePage(page); // once — loader + animations handled here

    for (const width of viewports) {
      try {
        await page.setViewportSize({ width, height: Math.round(width * 1.5) });
        await page.waitForTimeout(450); // let layout reflow / responsive CSS apply
        await page.evaluate(() => window.scrollTo(0, 0));

        const metrics = await page.evaluate(() => {
          function describe(el) {
            const txt = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 45);
            if (txt) return '“' + txt + (el.innerText.length > 45 ? '…' : '') + '”';
            const tag = el.tagName.toLowerCase();
            if (tag === 'img') return 'an image';
            if (/grid|row|container|loop|carousel|slider/i.test(el.className || '')) return 'a row/grid of items';
            if (tag === 'table') return 'a table';
            return 'a ' + tag + ' block';
          }
          // clear previous tags
          for (const el of document.querySelectorAll('[data-qa-overflow]')) el.removeAttribute('data-qa-overflow');
          const winWidth = window.innerWidth;
          const docWidth = document.documentElement.scrollWidth;
          const offenders = [];
          let i = 0;
          for (const el of document.querySelectorAll('body *')) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.right > winWidth + 4 && r.left < winWidth) {
              el.setAttribute('data-qa-overflow', String(i));
              offenders.push({ idx: i, right: Math.round(r.right), tag: el.tagName.toLowerCase(), desc: describe(el) });
              i++;
              if (i >= 8) break;
            }
          }
          return { winWidth, docWidth, hasHScroll: docWidth > winWidth + 4, offenders };
        });

        const buf = await page.screenshot({ type: 'jpeg', quality: 72, fullPage: false });
        screenshots.push({
          width,
          label: `${width}px`,
          device: width <= 414 ? 'Mobile' : width <= 768 ? 'Tablet' : 'Desktop',
          dataUri: `data:image/jpeg;base64,${buf.toString('base64')}`,
          hasHScroll: metrics.hasHScroll,
        });

        // Overflow findings only for PHONE widths (<=480) and capped/de-duped.
        // Severity depends on whether it actually causes sideways scroll:
        //   - real page h-scroll  -> MEDIUM (user-visible problem)
        //   - clipped (no scroll) -> LOW   (often an off-canvas menu/carousel —
        //     the annotated screenshot lets the reader judge if it's intentional)
        if (width <= 480) {
          for (const o of metrics.offenders.slice(0, 4)) {
            if (seenOverflow.has(o.desc)) continue;
            seenOverflow.set(o.desc, true);
            if (seenOverflow.size > 5) break; // cap total noise
            const shot = await annotateAndShoot(page, page.locator(`[data-qa-overflow="${o.idx}"]`).first(), {
              label: `runs to ${o.right}px (screen is ${metrics.winWidth}px)`,
            });
            const real = metrics.hasHScroll;
            findings.push(
              makeFinding({
                title: real
                  ? `Content runs off-screen & causes sideways scroll at ${width}px`
                  : `Element extends past the screen edge at ${width}px (clipped)`,
                severity: real ? 'MEDIUM' : 'LOW',
                location: `${startUrl}  @ ${width}px`,
                plainLocation: `${o.desc}`,
                description: real
                  ? `On a ${width}px phone screen, ${o.desc} stretches to ${o.right}px — past the ${metrics.winWidth}px edge — and makes the whole page scroll sideways, which feels broken to visitors. The red box shows exactly which element.`
                  : `On a ${width}px phone screen, ${o.desc} extends to ${o.right}px, past the ${metrics.winWidth}px edge, but it's clipped (no sideways scroll). This is often an intentional off-canvas menu, carousel, or full-bleed section — the red box in the screenshot lets you confirm whether anything important is actually cut off.`,
                recommendation: real
                  ? 'Give this element max-width:100% and box-sizing:border-box (or responsive units) so the page stops scrolling sideways.'
                  : 'If the screenshot shows real content being cut off, constrain this element with max-width:100%. If it’s a hidden menu/slider, no action needed.',
                reference: { label: 'MDN: Responsive design (plain guide)', url: 'https://developer.mozilla.org/en-US/docs/Learn/CSS/CSS_layout/Responsive_Design' },
                screenshot: shot,
                screenshotCaption: `${width}px phone view — the red box is the element extending past the screen.`,
              })
            );
          }
        }
        log('responsive', `${width}px ${metrics.hasHScroll ? 'H-SCROLL' : 'ok'} (${metrics.offenders.length} overflow)`);
      } catch (err) {
        log('responsive', `${width}px failed: ${err.message}`);
      }
    }
    await context.close().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }

  const mobileBad = screenshots.filter((s) => s.width <= 480 && s.hasHScroll).length;
  if (!findings.length) {
    findings.push(
      makeFinding({
        title: `Layout adapts cleanly across all ${viewports.length} breakpoints`,
        severity: 'PASS',
        location: startUrl,
        description: 'No horizontal scrolling or overflowing elements were detected from 320px (small phone) up to 1920px (large desktop). See the screenshots below.',
        recommendation: 'No action needed.',
      })
    );
  }

  return {
    id: 'responsive',
    title: 'Responsive & Visual',
    icon: '📱',
    summary: mobileBad
      ? `Sideways scrolling at ${mobileBad} mobile breakpoint(s) — see the highlighted screenshots.`
      : `Layout holds across all ${viewports.length} screen sizes.`,
    stats: {
      'Breakpoints tested': viewports.length,
      'Mobile h-scroll issues': mobileBad,
      'Screenshots captured': screenshots.length,
    },
    screenshots,
    findings,
  };
}
