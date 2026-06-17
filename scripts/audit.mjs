#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { crawlSite } from './lib/crawl.mjs';
import { scoreCategory, overallScore, countBySeverity } from './lib/contract.mjs';
import { loadCache, saveCache } from './lib/cache.mjs';
import { normalizeUrl, slugifyDomain, todayStamp, ensureDir, makeLogger, mapLimit } from './lib/util.mjs';
import { generateReport } from './report.mjs';

import * as links from './runners/links.mjs';
import * as responsive from './runners/responsive.mjs';
import * as browsers from './runners/browsers.mjs';
import * as lighthouse from './runners/lighthouse.mjs';
import * as axe from './runners/axe.mjs';
import * as security from './runners/security.mjs';
import * as seo from './runners/seo.mjs';
import * as content from './runners/content.mjs';
import * as mobile from './runners/mobile.mjs';
import * as tracking from './runners/tracking.mjs';

// data-only runners read the crawl result (fast, run all in parallel)
const DATA_RUNNERS = [
  { mod: links, id: 'links' },
  { mod: security, id: 'security' },
  { mod: seo, id: 'seo' },
  { mod: content, id: 'content' },
  { mod: tracking, id: 'tracking' },
];
// browser runners each launch their own browser(s) (limited concurrency)
const BROWSER_RUNNERS = [
  { mod: responsive, id: 'responsive' },
  { mod: browsers, id: 'browsers' },
  { mod: axe, id: 'accessibility' },
  { mod: mobile, id: 'mobile' },
  { mod: lighthouse, id: 'performance' },
];

// order categories appear in the report
const REPORT_ORDER = ['links', 'responsive', 'browsers', 'performance', 'accessibility', 'security', 'seo', 'content', 'mobile', 'tracking'];

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-cache' || a === '--fresh') args.cache = false;
    else if (a === '--open') args.open = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[key] = val;
    } else args._.push(a);
  }
  return args;
}

function buildConfig(args) {
  return {
    depth: args.depth != null ? Number(args.depth) : 2,
    maxPages: args['max-pages'] != null ? Number(args['max-pages']) : 25,
    timeout: args.timeout != null ? Number(args.timeout) : 20000,
    cache: args.cache !== false,
    viewports: [320, 375, 414, 768, 1024, 1280, 1440, 1920],
    browsers: args.browsers ? String(args.browsers).split(',') : ['chromium', 'firefox', 'webkit'],
    lighthouseFormFactor: args['form-factor'] || 'desktop',
    maxA11yPages: args['a11y-pages'] != null ? Number(args['a11y-pages']) : 5,
    currentYear: args.year != null ? Number(args.year) : new Date().getFullYear(),
    runBudgetMs: args.budget != null ? Number(args.budget) : 10 * 60 * 1000,
  };
}

async function runWithTimeout({ mod, id }, ctx, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          id,
          title: id,
          icon: '⏱️',
          summary: 'Runner exceeded its time budget and was skipped.',
          error: `timed out after ${Math.round(ms / 1000)}s`,
          findings: [],
        }),
      ms
    );
  });
  try {
    return await Promise.race([mod.run(ctx), timeout]);
  } catch (err) {
    ctx.log('audit', `runner "${id}" FAILED: ${err?.stack || err?.message || err}`);
    return { id, title: id, icon: '⚠️', summary: 'This analyzer failed to run.', error: err?.message || String(err), findings: [] };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args._[0]) {
    console.error('Usage: node scripts/audit.mjs <url> [--depth 2] [--max-pages 25] [--out file.html] [--no-cache] [--form-factor desktop|mobile] [--open]');
    process.exit(1);
  }

  const start = Date.now();
  const log = makeLogger(start);
  const url = normalizeUrl(args._[0]).toString();
  const config = buildConfig(args);
  const now = new Date();
  const domain = slugifyDomain(url);
  const stamp = todayStamp(now);

  const outPath = path.resolve(args.out || path.join('audits', `qa-report-${domain}-${stamp}.html`));
  await ensureDir(path.dirname(outPath));

  log('audit', `Target: ${url}`);
  log('audit', `Config: depth=${config.depth} maxPages=${config.maxPages} cache=${config.cache} formFactor=${config.lighthouseFormFactor}`);

  let categories;
  const cached = await loadCache(url, config, now);
  if (cached) {
    log('cache', `HIT — reusing today's results (run with --fresh to force a new scan)`);
    categories = cached.categories;
  } else {
    // ---- crawl once ----
    const crawl = await crawlSite(url, { depth: config.depth, maxPages: config.maxPages, timeout: config.timeout, log });
    if (!crawl.pages.length || crawl.pages.every((p) => p.status === 0)) {
      log('audit', 'ERROR: could not load the target site at all. Aborting.');
      process.exit(2);
    }
    const ctx = {
      startUrl: url,
      origin: crawl.origin,
      pages: crawl.pages,
      cookies: crawl.cookies,
      config,
      log,
    };

    const perRunner = Math.min(5 * 60 * 1000, config.runBudgetMs);

    log('audit', `Running ${DATA_RUNNERS.length} data analyzers + ${BROWSER_RUNNERS.length} browser analyzers…`);
    const dataPromise = Promise.all(DATA_RUNNERS.map((m) => runWithTimeout(m, ctx, perRunner)));
    const browserResults = await mapLimit(BROWSER_RUNNERS, 2, (m) => runWithTimeout(m, ctx, perRunner));
    const dataResults = await dataPromise;

    categories = [...dataResults, ...browserResults];
    await saveCache(url, config, now, { categories, generatedAt: now.toISOString() });
  }

  // score + order
  for (const c of categories) {
    c.score = scoreCategory(c.findings || []);
  }
  categories.sort((a, b) => REPORT_ORDER.indexOf(a.id) - REPORT_ORDER.indexOf(b.id));

  const overall = overallScore(categories);
  const counts = countBySeverity(categories);

  const meta = {
    url,
    domain,
    generatedAt: now.toISOString(),
    generatedHuman: now.toUTCString(),
    durationSec: ((Date.now() - start) / 1000).toFixed(1),
    pagesScanned: categories.find((c) => c.stats?.['Pages crawled'])?.stats['Pages crawled'] ?? config.maxPages,
    tools: ['Playwright (Chromium/Firefox/WebKit)', 'Lighthouse', 'axe-core', 'Pa11y', 'nspell', 'Node TLS'],
    config,
  };

  const html = await generateReport({ meta, overall, counts, categories });
  const { promises: fs } = await import('node:fs');
  await fs.writeFile(outPath, html, 'utf8');

  log('audit', `DONE in ${meta.durationSec}s — overall score ${overall}/100`);
  log('audit', `Critical: ${counts.CRITICAL}  High: ${counts.HIGH}  Medium: ${counts.MEDIUM}  Low: ${counts.LOW}`);
  console.log('\nReport: ' + outPath);
  console.log(JSON.stringify({ overall, counts, report: outPath }));

  if (args.open) {
    const { exec } = await import('node:child_process');
    const opener = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${opener} "${outPath}"`, { shell: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
