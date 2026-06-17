import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { makeFinding } from '../lib/contract.mjs';
import { truncate, uniq } from '../lib/util.mjs';

// Accessibility (WCAG 2.1 AA): axe-core is the primary engine, run across a
// sample of pages. Pa11y (HTML CodeSniffer) runs on the home page as an
// independent second opinion. Findings are grouped by rule with the worst
// impact, affected element count, and sample selectors.

const IMPACT_SEVERITY = { critical: 'CRITICAL', serious: 'HIGH', moderate: 'MEDIUM', minor: 'LOW' };

export async function run(ctx) {
  const { pages, startUrl, config, log } = ctx;
  const findings = [];
  const sample = uniq([startUrl, ...pages.map((p) => p.finalUrl || p.url)])
    .filter(Boolean)
    .slice(0, config.maxA11yPages || 5);

  const browser = await chromium.launch({ headless: true });
  const ruleAgg = new Map(); // ruleId -> { impact, help, helpUrl, nodes:[], pages:Set }
  let pagesScanned = 0;

  try {
    for (const url of sample) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.timeout || 20000 });
        await page.waitForTimeout(700);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
          .analyze();
        pagesScanned++;
        for (const v of results.violations) {
          if (!ruleAgg.has(v.id)) {
            ruleAgg.set(v.id, { id: v.id, impact: v.impact, help: v.help, description: v.description, helpUrl: v.helpUrl, nodes: [], pages: new Set() });
          }
          const agg = ruleAgg.get(v.id);
          agg.pages.add(url);
          for (const n of v.nodes) {
            agg.nodes.push({ target: (n.target || []).join(' '), summary: n.failureSummary || '', html: truncate(n.html || '', 120), page: url });
          }
        }
        log('axe', `${url} → ${results.violations.length} rule violations`);
      } catch (err) {
        log('axe', `${url} failed: ${err.message}`);
      } finally {
        await context.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // friendly names for the rules the brief specifically calls out
  const FRIENDLY = {
    'color-contrast': 'Low color contrast (text hard to read)',
    'image-alt': 'Images missing alternative text',
    'heading-order': 'Heading levels skip / out of order',
    'page-has-heading-one': 'Page is missing a top-level <h1> heading',
    label: 'Form fields missing labels',
    'link-name': 'Links without descriptive text',
    'button-name': 'Buttons without accessible names',
    'aria-required-attr': 'ARIA elements missing required attributes',
    'aria-valid-attr-value': 'Invalid ARIA attribute values',
    'document-title': 'Page missing a <title>',
    'html-has-lang': 'Page missing a language attribute',
  };

  for (const agg of [...ruleAgg.values()].sort((a, b) => sevRank(a.impact) - sevRank(b.impact))) {
    const sev = IMPACT_SEVERITY[agg.impact] || 'MEDIUM';
    const count = agg.nodes.length;
    const samples = agg.nodes.slice(0, 3).map((n) => n.target).filter(Boolean);
    let extra = '';
    if (agg.id === 'color-contrast' && agg.nodes[0]?.summary) {
      const m = agg.nodes[0].summary.match(/contrast.*?(\d+\.?\d*):1/i);
      if (m) extra = ` Example contrast ratio: ${m[1]}:1 (AA requires 4.5:1 for normal text).`;
    }
    findings.push(
      makeFinding({
        title: `${FRIENDLY[agg.id] || agg.help} — ${count} instance${count > 1 ? 's' : ''}`,
        severity: sev,
        location: `${samples[0] || agg.nodes[0]?.page || startUrl}${agg.pages.size > 1 ? `  (across ${agg.pages.size} pages)` : ''}`,
        description: `${agg.description}.${extra} Affects ${count} element${count > 1 ? 's' : ''}. Impact: ${agg.impact}.`,
        recommendation: recommendationFor(agg.id, agg.help),
        reference: { label: `axe rule: ${agg.id}`, url: agg.helpUrl },
      })
    );
  }

  // ---- Pa11y second opinion on the home page ----
  let pa11yCount = null;
  try {
    const pa11y = (await import('pa11y')).default;
    const r = await pa11y(startUrl, { standard: 'WCAG2AA', timeout: 30000, chromeLaunchConfig: { args: ['--no-sandbox'] } });
    pa11yCount = r.issues.filter((i) => i.type === 'error').length;
    log('axe', `pa11y: ${pa11yCount} errors on home`);
    findings.push(
      makeFinding({
        title: `Pa11y (second engine) found ${pa11yCount} WCAG 2.1 AA error(s) on the home page`,
        severity: pa11yCount === 0 ? 'PASS' : pa11yCount > 10 ? 'HIGH' : 'MEDIUM',
        location: startUrl,
        description: `Pa11y is an independent accessibility checker (HTML CodeSniffer) used to cross-check axe-core. It reports ${pa11yCount} WCAG 2.1 AA error(s) on the home page${pa11yCount ? `, e.g. "${truncate(r.issues.find((i) => i.type === 'error')?.message || '', 120)}"` : ''}.`,
        recommendation: pa11yCount === 0 ? 'No action needed — both engines agree the home page is clean.' : 'Cross-reference these with the axe findings above; overlap = high confidence, unique items = worth a manual check.',
        reference: { label: 'Pa11y', url: 'https://pa11y.org/' },
      })
    );
  } catch (err) {
    log('axe', `pa11y skipped: ${err.message}`);
  }

  if (!ruleAgg.size && pagesScanned) {
    findings.push(
      makeFinding({
        title: `No automated WCAG 2.1 AA violations across ${pagesScanned} page(s)`,
        severity: 'PASS',
        location: startUrl,
        description: 'axe-core found no automatically-detectable accessibility violations. Note: automated tools catch ~30-50% of issues; a manual keyboard + screen-reader pass is still recommended.',
        recommendation: 'Complement this with manual keyboard navigation and screen-reader testing for full WCAG coverage.',
        reference: { label: 'WCAG 2.1 AA', url: 'https://www.w3.org/WAI/WCAG21/quickref/?levels=aa' },
      })
    );
  }

  const totalIssues = [...ruleAgg.values()].reduce((n, a) => n + a.nodes.length, 0);
  return {
    id: 'accessibility',
    title: 'Accessibility (WCAG 2.1 AA)',
    icon: '♿',
    summary: ruleAgg.size
      ? `${ruleAgg.size} accessibility rule(s) failing (${totalIssues} elements) across ${pagesScanned} pages.`
      : `No automated WCAG 2.1 AA violations on ${pagesScanned} pages.`,
    stats: {
      'Pages scanned': pagesScanned,
      'axe rules failing': ruleAgg.size,
      'Elements affected': totalIssues,
      'Pa11y errors (home)': pa11yCount == null ? 'n/a' : pa11yCount,
    },
    findings,
  };
}

function sevRank(impact) {
  return { critical: 0, serious: 1, moderate: 2, minor: 3 }[impact] ?? 4;
}

function recommendationFor(id, help) {
  const map = {
    'color-contrast': 'Increase the contrast between text and its background to at least 4.5:1 (3:1 for large text). Darken text or lighten the background.',
    'image-alt': 'Add a descriptive alt="" attribute to each informative image; use alt="" (empty) for purely decorative images.',
    'heading-order': 'Use headings in order (h1 → h2 → h3) without skipping levels, so screen-reader users can navigate structure.',
    'page-has-heading-one': 'Add exactly one <h1> that describes the page’s main topic.',
    label: 'Associate every input with a <label> (via for/id) or an aria-label so assistive tech announces its purpose.',
    'link-name': 'Give every link meaningful text (avoid "click here"); add aria-label to icon-only links.',
    'button-name': 'Give every button visible text or an aria-label so its action is announced.',
  };
  return map[id] || `Resolve the "${help}" issue following the linked axe guidance.`;
}
