# website-qa-auditor

A [Claude Code](https://claude.com/claude-code) skill (and standalone CLI) that takes **any website URL** and produces **one polished, self-contained HTML QA report** — the kind a professional QA tester or PM would assemble by hand over 1–2 days, in about 5 minutes.

It runs **real tools** (Playwright, Lighthouse, axe-core, Pa11y) — not an LLM guessing — across 10 categories, then writes a single HTML file with embedded screenshots that you can email to a client or hand to a non-technical PM.

> **Why this exists:** existing "website audit" Claude skills are prompt- or console-snippet-driven and emit Markdown. Single-purpose tools (Lighthouse, axe) cover one slice each. Nothing produced *all 10 categories, with real tool execution, as one PM-friendly HTML artifact, from a single command*. This fills that gap.

---

## What it checks

| # | Category | What it covers |
|---|----------|----------------|
| 1 | **Functional & Links** | Crawls the site; flags broken links (404/500), unreachable URLs, redirect chains >3 hops; counts forms |
| 2 | **Responsive & Visual** | Screenshots at 320 / 375 / 414 / 768 / 1024 / 1280 / 1440 / 1920px; detects horizontal scrolling & overflowing elements |
| 3 | **Browser Compatibility** | Renders in Chromium, Firefox & WebKit; per-engine console errors and layout-height divergence |
| 4 | **Performance** | Lighthouse Perf / A11y / Best-Practices / SEO scores; Core Web Vitals (LCP, INP/TBT, CLS); page weight; render-blocking resources |
| 5 | **Accessibility** | axe-core (primary) + Pa11y (second opinion); WCAG 2.1 AA; color contrast w/ ratios; missing alt; heading order; ARIA; labels |
| 6 | **Security** | CSP / HSTS / X-Frame-Options / X-Content-Type-Options / Referrer-Policy / Permissions-Policy; HTTPS enforcement; TLS cert (issuer, expiry, key); mixed content; cookie flags; outdated libraries (jQuery <3.5, AngularJS 1.x) |
| 7 | **SEO** | Title/meta length; single-H1; JSON-LD validation; robots.txt / sitemap.xml / **llms.txt**; canonical tags; internal-link density; alt coverage; duplicate titles/descriptions |
| 8 | **Content Quality** | Spell check (nspell + English dictionary + allowlist); placeholder text (Lorem ipsum / TODO / "Coming soon"); outdated years; thin pages (<200 words); duplicate content |
| 9 | **Mobile Usability** | Viewport meta tag; 44×44px tap targets; ≥16px body font; tiny-text detection |
| 10 | **Tracking & Errors** | GA4 / GTM detection; console errors per page; failed network requests; third-party script inventory |

Every finding is rated **CRITICAL / HIGH / MEDIUM / LOW / PASS**, explained in plain English, and paired with a recommended fix and a reference link (WCAG / OWASP / Google / web.dev).

### Visual-first reporting (v1.1)

The point of a QA report is to *see* the problem, not decode a CSS selector. So:

- **Annotated screenshots** — layout/overflow and small-tap-target findings include a screenshot with the exact element **boxed in red**, so a non-technical reader can see it and judge whether it's a real bug or intentional (off-canvas menu, full-bleed image, etc.).
- **Click-to-zoom** — every screenshot opens full-size in a lightbox (Esc or click to close).
- **Loader-aware capture** — the page is settled before screenshots (intro loaders dismissed, scroll-reveal/lazy content triggered), so animation-heavy sites don't produce black frames.
- **Plain-English location first**; the raw CSS selector is tucked into a collapsible "Technical location."

### Manual QA checklist (v1.2)

Automated tools can't submit a form, judge whether your phone number is correct, or use a screen reader. So the report ends with a **tickable manual checklist** of test cases a human should run by hand:

- A green **"Already verified for you"** summary so the reader knows exactly what the audit *did* cover.
- **Contextual** test cases — checkout steps only appear if the site has a shop; login tests only if it has accounts; form tests only if it has forms, etc.
- Each item has a **"Pass when:"** acceptance criterion, a rough **time estimate** per section, and is **ordered fastest / highest-value first**.
- Built entirely from data already collected — it adds **zero** time to the audit.

---

## Quick start

```bash
git clone https://github.com/PRoBoT2004/claude-skill-website-qa-auditor.git
cd claude-skill-website-qa-auditor
npm install
npx playwright install          # one-time browser download (~400MB)

node scripts/audit.mjs https://example.com --open
```

The report lands at `audits/qa-report-{domain}-{YYYY-MM-DD}.html`.

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--depth <n>` | `2` | Crawl depth from the start URL |
| `--max-pages <n>` | `25` | Hard cap on pages crawled |
| `--out <file.html>` | `audits/qa-report-…` | Explicit output path |
| `--form-factor desktop\|mobile` | `desktop` | Lighthouse emulation profile |
| `--a11y-pages <n>` | `5` | Pages axe-core scans |
| `--fresh` / `--no-cache` | cache on | Bypass the same-day cache |
| `--open` | off | Open the report when finished |

**Tips:** big sites → `--depth 1 --max-pages 10` to stay fast. Single-page spot check → `--depth 0 --max-pages 1`.

---

## Use as a Claude Code skill

Install into your skills directory:

```bash
git clone https://github.com/PRoBoT2004/claude-skill-website-qa-auditor.git ~/.claude/skills/website-qa-auditor
cd ~/.claude/skills/website-qa-auditor && npm install && npx playwright install
```

Then just ask Claude: *"audit https://example.com"* or *"QA this client site and give me a report."* Claude reads [`SKILL.md`](SKILL.md), runs the audit, and reports the score, the critical issues, and the report path.

---

## Architecture

```
scripts/
  audit.mjs            orchestrator: parse args → crawl once → run analyzers → score → report
  report.mjs           renders the HTML from results + EJS template
  lib/
    contract.mjs       shared Finding/Category shape, severity weights, scoring
    crawl.mjs          single Playwright crawl: HTML, headers, console, network, cookies, links
    cache.mjs          per-URL-per-day result cache (OS temp dir)
    util.mjs           url/normalize, concurrency-limited map, helpers
  runners/             one analyzer per category (links, responsive, browsers, lighthouse,
                       axe, security, seo, content, mobile, tracking)
templates/
  report.html.ejs      self-contained report (inline CSS, embedded screenshots, <details> sections)
```

**Design:** the site is **crawled once**; data-only analyzers (links, security, SEO, content, tracking) read that shared snapshot and run in parallel, while browser analyzers (responsive, cross-browser, axe, mobile, Lighthouse) run with bounded concurrency. Each analyzer is time-boxed and degrades gracefully — one failure never sinks the whole report. The overall score is a weighted average across the 10 categories.

A runner is just:

```js
export async function run(ctx) {
  // ctx = { startUrl, origin, pages, cookies, config, log }
  return { id, title, icon, summary, stats, findings };  // findings: makeFinding({...})
}
```

Add a category by dropping a file in `runners/`, returning that shape, and registering it in `audit.mjs`.

---

## Sample results

Run against three real sites (depth 1, 6 pages each):

| Site | Type | Score | Critical | High | Time |
|------|------|:-----:|:--------:|:----:|------|
| `11ty.dev` | Static marketing/docs | **87** | 0 | 2 | 43s |
| `posthog.com` | Complex SaaS (logged-out) | **60** | 5 | 10 | 90s |
| `woocommerce.com` | WordPress / WooCommerce | **62** | 1 | 11 | 136s |

Real findings surfaced included: Lighthouse performance of 17/100 on a heavy JS marketing site, 43 buttons without accessible names, 10 images missing alt text, missing security headers (CSP/HSTS), and forbidden (403) links that block search-engine crawlers. Each is reported with severity, location, a plain-English explanation, and a recommended fix.

---

## Limitations

- **Non-destructive only.** It never submits forms, logs in, or runs intrusive/active security scans — it audits the public, logged-out surface. The OWASP coverage is a surface check (headers, transport, disclosed versions, known-outdated libs), not a penetration test.
- **Automated a11y catches ~30–50% of WCAG issues.** The report says so and recommends manual keyboard + screen-reader testing.
- **Lighthouse needs Chrome/Chromium.** The Performance section degrades gracefully if it can't launch.
- Very large sites should be bounded with `--max-pages` / `--depth`.

## License

MIT © PRoBoT2004
