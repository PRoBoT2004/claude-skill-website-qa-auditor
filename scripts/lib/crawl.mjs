import { chromium } from 'playwright';
import { canonicalKey, sameOrigin, normalizeUrl } from './util.mjs';

// Crawl the site once with a real browser, capturing everything the
// content/SEO/security/tracking runners need without re-navigating:
//   - final URL + HTTP status + response headers
//   - full rendered HTML
//   - console errors/warnings
//   - failed network requests (third-party + first-party)
//   - cookies set on the origin
//   - every <a href> discovered (for the link checker and link-density stats)
//
// Returns { pages: Page[], cookies, startUrl, origin }
export async function crawlSite(startUrl, opts = {}) {
  const { depth = 2, maxPages = 25, timeout = 20000, log = () => {} } = opts;
  const start = normalizeUrl(startUrl).toString();
  const origin = new URL(start).origin;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (compatible; website-qa-auditor/1.0; +https://github.com/PRoBoT2004/claude-skill-website-qa-auditor)',
    viewport: { width: 1366, height: 900 },
    ignoreHTTPSErrors: false,
  });

  const pages = [];
  const visited = new Set();
  const queue = [{ url: start, level: 0 }];
  let allCookies = [];

  try {
    while (queue.length && pages.length < maxPages) {
      const { url, level } = queue.shift();
      const key = canonicalKey(url);
      if (visited.has(key)) continue;
      visited.add(key);

      const page = await context.newPage();
      const consoleMsgs = [];
      const failedRequests = [];

      page.on('console', (msg) => {
        const type = msg.type();
        if (type === 'error' || type === 'warning') {
          consoleMsgs.push({ type, text: msg.text().slice(0, 500) });
        }
      });
      page.on('requestfailed', (req) => {
        failedRequests.push({
          url: req.url().slice(0, 300),
          method: req.method(),
          failure: req.failure()?.errorText || 'failed',
          resourceType: req.resourceType(),
        });
      });
      page.on('pageerror', (err) => {
        consoleMsgs.push({ type: 'error', text: ('Uncaught: ' + err.message).slice(0, 500) });
      });

      let response = null;
      let status = 0;
      let headers = {};
      let html = '';
      let title = '';
      let finalUrl = url;
      let loadError = null;

      try {
        response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        // give late scripts a moment to throw / inject, but bounded
        await page.waitForTimeout(1200);
        status = response ? response.status() : 0;
        headers = response ? response.headers() : {};
        finalUrl = page.url();
        html = await page.content();
        title = await page.title();
      } catch (err) {
        loadError = err?.message || String(err);
      }

      // collect links for the queue and for link-density stats
      let links = [];
      try {
        links = await page.$$eval('a[href]', (as) =>
          as.map((a) => ({
            href: a.getAttribute('href') || '',
            abs: a.href,
            text: (a.textContent || '').trim().slice(0, 120),
            rel: a.getAttribute('rel') || '',
          }))
        );
      } catch {
        /* page failed to load; no links */
      }

      try {
        const cookies = await context.cookies();
        allCookies = cookies; // cumulative; last snapshot is fine for flags
      } catch {
        /* ignore */
      }

      pages.push({
        url,
        finalUrl,
        level,
        status,
        headers,
        html,
        title,
        links,
        console: consoleMsgs,
        failedRequests,
        loadError,
      });
      log('crawl', `${status || 'ERR'} (L${level}) ${url}`);

      await page.close();

      // enqueue same-origin children
      if (level < depth) {
        for (const l of links) {
          if (!l.abs) continue;
          if (!sameOrigin(l.abs, origin)) continue;
          const ck = canonicalKey(l.abs);
          if (visited.has(ck)) continue;
          if (queue.find((q) => canonicalKey(q.url) === ck)) continue;
          // skip obvious non-HTML assets
          if (/\.(pdf|zip|jpg|jpeg|png|gif|svg|webp|mp4|mp3|css|js|ico|woff2?)($|\?)/i.test(l.abs))
            continue;
          queue.push({ url: l.abs, level: level + 1 });
        }
      }
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return { pages, cookies: allCookies, startUrl: start, origin };
}
