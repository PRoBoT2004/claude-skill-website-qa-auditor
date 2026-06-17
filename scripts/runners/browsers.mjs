import { chromium, firefox, webkit } from 'playwright';
import { makeFinding } from '../lib/contract.mjs';
import { settlePage } from '../lib/page.mjs';
import { truncate } from '../lib/util.mjs';

// Browser compatibility: render the home page in Chromium, Firefox and WebKit
// (Safari's engine). Capture per-engine console errors and a screenshot, and
// flag rendering differences (notably layout height divergence and errors that
// only appear in one engine).
const ENGINES = { chromium, firefox, webkit };

export async function run(ctx) {
  const { startUrl, config, log } = ctx;
  const wanted = config.browsers || ['chromium', 'firefox', 'webkit'];
  const findings = [];
  const renders = [];

  for (const name of wanted) {
    const engine = ENGINES[name];
    if (!engine) continue;
    let browser;
    const consoleErrors = [];
    try {
      browser = await engine.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
      });
      page.on('pageerror', (e) => consoleErrors.push('Uncaught: ' + e.message.slice(0, 300)));

      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: config.timeout || 25000 });
      await settlePage(page);

      const layout = await page.evaluate(() => ({
        height: document.documentElement.scrollHeight,
        width: document.documentElement.scrollWidth,
        bodyText: (document.body?.innerText || '').length,
      }));
      const buf = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false });

      renders.push({
        name,
        consoleErrors,
        layout,
        dataUri: `data:image/jpeg;base64,${buf.toString('base64')}`,
      });
      log('browsers', `${name}: ${consoleErrors.length} console error(s), h=${layout.height}`);
      await browser.close().catch(() => {});
    } catch (err) {
      log('browsers', `${name} failed: ${err.message}`);
      renders.push({ name, consoleErrors, layout: null, error: err.message });
      if (browser) await browser.close().catch(() => {});
    }
  }

  // per-engine console errors
  for (const r of renders) {
    if (r.error) {
      findings.push(
        makeFinding({
          title: `Page failed to render in ${r.name}`,
          severity: 'HIGH',
          location: `${startUrl} (${r.name})`,
          description: `The page could not be loaded/rendered in ${r.name}: ${truncate(r.error, 120)}. Users on this engine may see a broken page.`,
          recommendation: `Test the page manually in ${r.name === 'webkit' ? 'Safari/iOS' : r.name} and fix the loading failure.`,
        })
      );
      continue;
    }
    if (r.consoleErrors.length) {
      findings.push(
        makeFinding({
          title: `${r.consoleErrors.length} JavaScript console error(s) in ${r.name}`,
          severity: 'MEDIUM',
          location: `${startUrl} (${r.name})`,
          description: `${r.name} logs errors while loading: "${truncate(r.consoleErrors[0], 140)}"${r.consoleErrors.length > 1 ? ` (and ${r.consoleErrors.length - 1} more)` : ''}. Console errors often mean broken features for users on this browser.`,
          recommendation: `Open ${r.name === 'webkit' ? 'Safari' : r.name} DevTools, reproduce these errors, and resolve them — some scripts may behave differently per engine.`,
          reference: { label: 'MDN: Cross-browser testing', url: 'https://developer.mozilla.org/en-US/docs/Learn/Tools_and_testing/Cross_browser_testing' },
        })
      );
    }
  }

  // layout divergence between engines
  const good = renders.filter((r) => r.layout);
  if (good.length >= 2) {
    const heights = good.map((r) => r.layout.height);
    const min = Math.min(...heights);
    const max = Math.max(...heights);
    if (min > 0 && (max - min) / min > 0.15) {
      const tallest = good.find((r) => r.layout.height === max);
      const shortest = good.find((r) => r.layout.height === min);
      findings.push(
        makeFinding({
          title: 'Page height differs noticeably between browsers',
          severity: 'LOW',
          location: startUrl,
          description: `The page renders ${max}px tall in ${tallest.name} but ${min}px in ${shortest.name} — a ${Math.round(((max - min) / min) * 100)}% difference. This can signal layout that breaks or shifts on one engine.`,
          recommendation: 'Compare the screenshots side by side; check for fonts, flex/grid, or CSS features that one engine renders differently.',
          reference: { label: 'web.dev: Cross-browser CSS', url: 'https://web.dev/learn/css/' },
        })
      );
    }
  }

  if (!findings.length && good.length) {
    findings.push(
      makeFinding({
        title: `Renders consistently across ${good.length} browser engine(s)`,
        severity: 'PASS',
        location: startUrl,
        description: `No console errors and consistent layout in ${good.map((r) => r.name).join(', ')} (covers Chrome/Edge, Firefox and Safari).`,
        recommendation: 'No action needed.',
      })
    );
  }

  return {
    id: 'browsers',
    title: 'Browser Compatibility',
    icon: '🌐',
    summary: findings.some((f) => f.severity !== 'PASS')
      ? `Differences/errors found across ${good.length} engines.`
      : `Consistent across Chromium, Firefox & WebKit.`,
    stats: Object.fromEntries(renders.map((r) => [r.name, r.error ? 'failed' : `${r.consoleErrors.length} console errors`])),
    renders: renders.map(({ name, dataUri, layout }) => ({ name, dataUri, layout })),
    findings,
  };
}
