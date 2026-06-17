import { makeFinding } from '../lib/contract.mjs';
import { bytesToKB } from '../lib/util.mjs';

// Performance: run a full Lighthouse audit (Performance, Accessibility,
// Best Practices, SEO) and surface Core Web Vitals, page weight and
// render-blocking resources in plain English. Lighthouse 13 is ESM and is
// driven over the DevTools port opened by chrome-launcher (the maintained
// approach — the playwright-lighthouse wrapper is stale).

const DESKTOP_FLAGS = {
  formFactor: 'desktop',
  screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
  throttling: { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1, requestLatencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0 },
};

// chrome-launcher's kill() is synchronous (returns void) in v1.x, so we can't
// call .catch() on it — guard for both sync and promise-returning versions.
async function safeKill(chrome) {
  try {
    const r = chrome?.kill?.();
    if (r && typeof r.then === 'function') await r;
  } catch {
    /* ignore */
  }
}

function scoreSeverity(score) {
  if (score == null) return null;
  if (score < 0.5) return 'CRITICAL';
  if (score < 0.7) return 'HIGH';
  if (score < 0.9) return 'MEDIUM';
  return 'PASS';
}

export async function run(ctx) {
  const { startUrl, config, log } = ctx;
  const findings = [];

  let lighthouse, ChromeLauncher;
  try {
    lighthouse = (await import('lighthouse')).default;
    ChromeLauncher = await import('chrome-launcher');
  } catch (err) {
    return degraded(`Lighthouse not available: ${err.message}`);
  }

  let chrome;
  let lhr;
  try {
    chrome = await ChromeLauncher.launch({
      chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });
    const formFactor = config.lighthouseFormFactor || 'desktop';
    const flags = {
      port: chrome.port,
      output: 'json',
      logLevel: 'error',
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      ...(formFactor === 'desktop' ? DESKTOP_FLAGS : {}),
    };
    log('lighthouse', `running (${formFactor}) on ${startUrl}`);
    const runnerResult = await lighthouse(startUrl, flags);
    lhr = runnerResult?.lhr;
  } catch (err) {
    await safeKill(chrome);
    return degraded(`Lighthouse run failed: ${err.message}`);
  } finally {
    await safeKill(chrome);
  }

  if (!lhr) return degraded('Lighthouse returned no result.');

  const cat = lhr.categories || {};
  const scores = {
    performance: cat.performance?.score,
    accessibility: cat.accessibility?.score,
    'best-practices': cat['best-practices']?.score,
    seo: cat.seo?.score,
  };
  const a = lhr.audits || {};

  const labels = {
    performance: 'Performance (page speed)',
    accessibility: 'Accessibility',
    'best-practices': 'Best Practices',
    seo: 'SEO',
  };
  for (const [k, s] of Object.entries(scores)) {
    const sev = scoreSeverity(s);
    if (sev == null) continue;
    findings.push(
      makeFinding({
        title: `Lighthouse ${labels[k]} score: ${Math.round((s || 0) * 100)}/100`,
        severity: sev,
        location: startUrl,
        description:
          sev === 'PASS'
            ? `Strong ${labels[k]} score from Google Lighthouse.`
            : `Lighthouse rates ${labels[k]} at ${Math.round((s || 0) * 100)}/100. ${k === 'performance' ? 'Slow pages lose visitors and rank lower.' : k === 'accessibility' ? 'See the Accessibility section for specific failures.' : 'Below the 90/100 "good" threshold.'}`,
        recommendation:
          sev === 'PASS' ? 'No action needed.' : `Open the Lighthouse "${labels[k]}" audit details and address the flagged opportunities.`,
        reference: { label: 'Google Lighthouse scoring', url: 'https://developer.chrome.com/docs/lighthouse/performance/performance-scoring' },
      })
    );
  }

  // ---- Core Web Vitals ----
  const lcp = a['largest-contentful-paint'];
  if (lcp?.numericValue != null) {
    const ms = lcp.numericValue;
    const sev = ms > 4000 ? 'HIGH' : ms > 2500 ? 'MEDIUM' : 'PASS';
    findings.push(
      makeFinding({
        title: `Largest Contentful Paint (LCP): ${lcp.displayValue}`,
        severity: sev,
        location: startUrl,
        description: `LCP measures how long until the largest thing on screen (page becomes visibly "loaded" to the user) appears: ${lcp.displayValue}. Google's "good" target is under 2.5 seconds.`,
        recommendation: sev === 'PASS' ? 'No action needed.' : 'Optimize the largest element (usually the hero image or heading): compress/preload it, reduce render-blocking CSS/JS, and improve server response time.',
        reference: { label: 'web.dev: LCP', url: 'https://web.dev/articles/lcp' },
      })
    );
  }
  const cls = a['cumulative-layout-shift'];
  if (cls?.numericValue != null) {
    const v = cls.numericValue;
    const sev = v > 0.25 ? 'HIGH' : v > 0.1 ? 'MEDIUM' : 'PASS';
    findings.push(
      makeFinding({
        title: `Cumulative Layout Shift (CLS): ${cls.displayValue}`,
        severity: sev,
        location: startUrl,
        description: `CLS measures how much the page jumps around while loading (content becomes visible to user then shifts): ${cls.displayValue}. Google's "good" target is under 0.1.`,
        recommendation: sev === 'PASS' ? 'No action needed.' : 'Set explicit width/height on images and ads, avoid inserting content above existing content, and preload fonts to stop layout jumps.',
        reference: { label: 'web.dev: CLS', url: 'https://web.dev/articles/cls' },
      })
    );
  }
  const inp = a['interaction-to-next-paint'] || a['experimental-interaction-to-next-paint'];
  const tbt = a['total-blocking-time'];
  if (inp?.numericValue != null) {
    const v = inp.numericValue;
    const sev = v > 500 ? 'HIGH' : v > 200 ? 'MEDIUM' : 'PASS';
    findings.push(
      makeFinding({
        title: `Interaction to Next Paint (INP): ${inp.displayValue}`,
        severity: sev,
        location: startUrl,
        description: `INP measures how quickly the page responds when a user taps or clicks (responsiveness): ${inp.displayValue}. Good is under 200ms.`,
        recommendation: sev === 'PASS' ? 'No action needed.' : 'Reduce heavy JavaScript work on the main thread; break up long tasks and defer non-critical scripts.',
        reference: { label: 'web.dev: INP', url: 'https://web.dev/articles/inp' },
      })
    );
  } else if (tbt?.numericValue != null) {
    const v = tbt.numericValue;
    const sev = v > 600 ? 'HIGH' : v > 200 ? 'MEDIUM' : 'PASS';
    findings.push(
      makeFinding({
        title: `Total Blocking Time (TBT): ${tbt.displayValue}`,
        severity: sev,
        location: startUrl,
        description: `TBT is a lab proxy for responsiveness — how long scripts block the page from responding to input: ${tbt.displayValue}. (INP needs real user interaction, so TBT is shown for this lab run.)`,
        recommendation: sev === 'PASS' ? 'No action needed.' : 'Split long JavaScript tasks, remove unused scripts, and defer third-party code.',
        reference: { label: 'web.dev: TBT', url: 'https://web.dev/articles/tbt' },
      })
    );
  }

  // ---- Page weight breakdown ----
  const resourceSummary = a['resource-summary']?.details?.items || a['network-requests']?.details?.items;
  const weightStats = {};
  if (a['resource-summary']?.details?.items) {
    for (const it of a['resource-summary'].details.items) {
      weightStats[it.resourceType] = `${bytesToKB(it.transferSize)} KB (${it.requestCount})`;
    }
  }
  const totalBytes = a['total-byte-weight']?.numericValue;
  if (totalBytes != null) {
    const mb = totalBytes / (1024 * 1024);
    const sev = mb > 4 ? 'HIGH' : mb > 2 ? 'MEDIUM' : 'PASS';
    findings.push(
      makeFinding({
        title: `Total page weight: ${mb.toFixed(2)} MB`,
        severity: sev,
        location: startUrl,
        description: `The page transfers ${mb.toFixed(2)} MB. Heavy pages are slow on mobile data and cost users money. A lean marketing page is typically under 2 MB.`,
        recommendation: sev === 'PASS' ? 'No action needed.' : 'Compress and lazy-load images (use WebP/AVIF), minify JS/CSS, and remove unused third-party scripts.',
        reference: { label: 'web.dev: Page weight', url: 'https://web.dev/articles/total-byte-weight' },
      })
    );
  }

  // ---- Render-blocking ----
  const rb = a['render-blocking-resources']?.details?.items || [];
  if (rb.length) {
    const savedMs = a['render-blocking-resources']?.numericValue || 0;
    findings.push(
      makeFinding({
        title: `${rb.length} render-blocking resource(s) delaying first paint`,
        severity: savedMs > 500 ? 'MEDIUM' : 'LOW',
        location: startUrl,
        description: `${rb.length} CSS/JS file(s) block the page from showing until they finish downloading, delaying display by ~${Math.round(savedMs)}ms. Example: ${rb[0]?.url?.slice(0, 80)}`,
        recommendation: 'Defer or async non-critical JavaScript, inline critical CSS, and load the rest asynchronously.',
        reference: { label: 'web.dev: Render-blocking resources', url: 'https://web.dev/articles/render-blocking-resources' },
      })
    );
  }

  return {
    id: 'performance',
    title: 'Performance (Lighthouse)',
    icon: '⚡',
    summary: `Lighthouse — Perf ${pctOf(scores.performance)}, A11y ${pctOf(scores.accessibility)}, Best Practices ${pctOf(scores['best-practices'])}, SEO ${pctOf(scores.seo)}.`,
    stats: {
      Performance: pctOf(scores.performance),
      Accessibility: pctOf(scores.accessibility),
      'Best Practices': pctOf(scores['best-practices']),
      SEO: pctOf(scores.seo),
      LCP: lcp?.displayValue || 'n/a',
      CLS: cls?.displayValue || 'n/a',
      [inp ? 'INP' : 'TBT']: (inp || tbt)?.displayValue || 'n/a',
      ...weightStats,
    },
    findings,
  };

  function degraded(msg) {
    log('lighthouse', msg);
    return {
      id: 'performance',
      title: 'Performance (Lighthouse)',
      icon: '⚡',
      summary: 'Lighthouse could not run in this environment.',
      error: msg,
      findings: [
        makeFinding({
          title: 'Lighthouse audit could not run',
          severity: 'LOW',
          location: startUrl,
          description: `The performance audit was skipped: ${msg}. This usually means Chrome could not be launched in this environment.`,
          recommendation: 'Ensure Google Chrome is installed and re-run; performance scores require a headless Chrome instance.',
        }),
      ],
    };
  }
}

function pctOf(s) {
  return s == null ? 'n/a' : `${Math.round(s * 100)}/100`;
}
