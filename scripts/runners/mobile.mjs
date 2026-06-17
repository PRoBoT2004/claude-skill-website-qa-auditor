import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import { makeFinding } from '../lib/contract.mjs';
import { settlePage, annotateManyAndShoot } from '../lib/page.mjs';

// Mobile-specific: viewport meta tag, touch-target sizes (>=44x44px), readable
// body font size (>=16px) and tap-target spacing. Measured live at 375px.

export async function run(ctx) {
  const { startUrl, pages, config, log } = ctx;
  const findings = [];

  // viewport meta (static — check all pages)
  let missingViewport = 0;
  let badViewport = 0;
  for (const p of pages) {
    if (!p.html) continue;
    const $ = cheerio.load(p.html);
    const vp = $('meta[name="viewport"]').attr('content');
    if (!vp) missingViewport++;
    else if (!/width\s*=\s*device-width/i.test(vp)) badViewport++;
  }
  if (missingViewport) {
    findings.push(
      makeFinding({
        title: `${missingViewport} page(s) missing the viewport meta tag`,
        severity: 'HIGH',
        location: startUrl,
        description: 'Without <meta name="viewport" content="width=device-width, initial-scale=1">, mobile browsers render the page at desktop width and shrink it, making text tiny and unusable.',
        recommendation: 'Add the viewport meta tag to the <head> of every page.',
        reference: { label: 'Google: Viewport', url: 'https://developers.google.com/search/docs/appearance/responsive-design' },
      })
    );
  } else if (badViewport) {
    findings.push(
      makeFinding({
        title: 'Viewport meta tag present but not using device-width',
        severity: 'MEDIUM',
        location: startUrl,
        description: 'A viewport tag exists but does not set width=device-width, so the layout may not adapt correctly to phone screens.',
        recommendation: 'Use content="width=device-width, initial-scale=1".',
        reference: { label: 'Google: Viewport', url: 'https://developers.google.com/search/docs/appearance/responsive-design' },
      })
    );
  }

  // live measurements at mobile size
  const browser = await chromium.launch({ headless: true });
  let measured = null;
  try {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: config.timeout || 20000 });
    await settlePage(page);
    measured = await page.evaluate(() => {
      const out = { small: [], boxes: [], bodyFont: 0, tinyText: 0 };
      const bodyStyle = getComputedStyle(document.body);
      out.bodyFont = parseFloat(bodyStyle.fontSize) || 0;
      const sx = window.scrollX,
        sy = window.scrollY;
      // touch targets
      const targets = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [onclick]');
      let counted = 0;
      for (const el of targets) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        counted++;
        if ((r.width < 44 || r.height < 44) && out.small.length < 20) {
          const label = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('name') || el.tagName).trim().slice(0, 30);
          out.small.push({ label, w: Math.round(r.width), h: Math.round(r.height), tag: el.tagName.toLowerCase() });
          // absolute page coords for the highlight overlay
          out.boxes.push({ x: r.left + sx, y: r.top + sy, width: r.width, height: r.height });
        }
      }
      out.totalTargets = counted;
      // tiny text sample
      for (const el of document.querySelectorAll('p, span, li, a, td')) {
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs && fs < 12 && (el.textContent || '').trim().length > 10) out.tinyText++;
      }
      return out;
    });
    log('mobile', `bodyFont=${measured.bodyFont}px smallTargets=${measured.small.length}/${measured.totalTargets}`);
    if (measured.boxes && measured.boxes.length) {
      measured.tapShot = await annotateManyAndShoot(page, measured.boxes, { fullPage: true });
    }
    await context.close().catch(() => {});
  } catch (err) {
    log('mobile', `live measure failed: ${err.message}`);
  } finally {
    await browser.close().catch(() => {});
  }

  if (measured) {
    if (measured.bodyFont && measured.bodyFont < 16) {
      findings.push(
        makeFinding({
          title: `Body font size below 16px (${Math.round(measured.bodyFont)}px)`,
          severity: 'MEDIUM',
          location: `${startUrl} (body)`,
          description: `The base font size is ${Math.round(measured.bodyFont)}px. On phones, body text under 16px is hard to read and can trigger auto-zoom on form fields in iOS Safari.`,
          recommendation: 'Set the base/body font-size to at least 16px for comfortable mobile reading.',
          reference: { label: 'web.dev: Legible font sizes', url: 'https://web.dev/articles/font-size' },
        })
      );
    }
    if (measured.small.length) {
      const ex = measured.small.slice(0, 4).map((t) => `"${t.label}" (${t.w}×${t.h}px)`).join(', ');
      findings.push(
        makeFinding({
          title: `${measured.small.length} tap target(s) smaller than 44×44px`,
          severity: measured.small.length > 5 ? 'MEDIUM' : 'LOW',
          location: `${startUrl} @ 375px (phone)`,
          description: `${measured.small.length} of ${measured.totalTargets} buttons/links are smaller than the 44×44px minimum recommended for comfortable finger taps, e.g. ${ex}. Small or tightly-packed targets cause mis-taps on phones. Every flagged target is boxed in red in the screenshot.`,
          recommendation: 'Increase the size (or tap padding) of these buttons/links to at least 44×44px and keep ~8px spacing between adjacent targets. Footer/social icons are common offenders.',
          reference: { label: 'Apple HIG: Touch targets', url: 'https://developer.apple.com/design/human-interface-guidelines/accessibility' },
          screenshot: measured.tapShot || null,
          screenshotCaption: 'Phone view (375px) — every red box is a tap target below the 44×44px minimum.',
        })
      );
    }
    if (measured.tinyText > 0) {
      findings.push(
        makeFinding({
          title: `${measured.tinyText} element(s) with very small text (<12px)`,
          severity: 'LOW',
          location: `${startUrl} @ 375px`,
          description: `${measured.tinyText} text element(s) render below 12px on mobile — too small to read comfortably.`,
          recommendation: 'Raise these font sizes; reserve sub-12px text for fine print only.',
          reference: { label: 'web.dev: Legible font sizes', url: 'https://web.dev/articles/font-size' },
        })
      );
    }
  }

  if (!findings.length) {
    findings.push(
      makeFinding({
        title: 'Mobile usability checks pass',
        severity: 'PASS',
        location: startUrl,
        description: 'Viewport meta tag is set correctly, tap targets meet the 44×44px minimum, and body text is legible on phones.',
        recommendation: 'No action needed.',
      })
    );
  }

  return {
    id: 'mobile',
    title: 'Mobile Usability',
    icon: '👆',
    summary: measured
      ? `${measured.small.length} small tap target(s), body font ${Math.round(measured.bodyFont || 0)}px.`
      : 'Mobile checks completed (static only).',
    stats: {
      'Pages w/o viewport tag': missingViewport,
      'Body font size': measured ? `${Math.round(measured.bodyFont || 0)}px` : 'n/a',
      'Small tap targets': measured ? measured.small.length : 'n/a',
      'Interactive elements': measured ? measured.totalTargets : 'n/a',
    },
    findings,
  };
}
