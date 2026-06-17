---
name: website-qa-auditor
description: Take any website URL and produce one polished, self-contained HTML QA report covering 10 categories — broken links, responsive layout, cross-browser rendering, Lighthouse performance, WCAG accessibility, security headers/SSL, SEO, content quality/spelling, mobile usability, and analytics/console errors. Use when asked to "audit", "QA", "do a quality check on", "review", or "test" a website, or to produce a client/PM-facing site health report. Runs real tools (Playwright, Lighthouse, axe-core, Pa11y), not just an LLM read.
---

# Website QA Auditor

Produces the kind of comprehensive QA report a professional tester/PM would assemble manually over 1–2 days — in ~5 minutes — as one shareable HTML file.

## When to use this skill

Trigger when the user wants a quality/health audit of a website: "audit example.com", "QA this site", "is my site ready to launch", "check this client site", "accessibility/SEO/performance report for …". Works on **any public URL**, not just the user's own sites.

## What it checks (10 categories)

1. **Functional & Links** — crawl, broken links (404/500), redirect chains, forms present
2. **Responsive & Visual** — screenshots at 320/375/414/768/1024/1280/1440/1920px, horizontal-scroll & overflow detection
3. **Browser Compatibility** — renders in Chromium, Firefox, WebKit; per-engine console errors & layout diffs
4. **Performance** — Lighthouse (Perf/A11y/Best-Practices/SEO scores), Core Web Vitals (LCP/INP/CLS), page weight, render-blocking
5. **Accessibility** — axe-core + Pa11y, WCAG 2.1 AA, contrast, alt text, heading order, ARIA, labels
6. **Security** — security headers, HTTPS enforcement, TLS cert details, mixed content, cookie flags, outdated libraries
7. **SEO** — titles, meta descriptions, H1 uniqueness, JSON-LD schema, robots.txt, sitemap.xml, llms.txt, canonical, alt coverage, duplicates
8. **Content Quality** — spell check, placeholder text (Lorem ipsum/TODO/Coming soon), outdated years, thin pages, duplicate content
9. **Mobile Usability** — viewport meta, 44×44px tap targets, ≥16px body font, tiny-text detection
10. **Tracking & Errors** — GA4/GTM presence, console errors, failed network requests, third-party script inventory

## Protocol when invoked

1. **Confirm the target URL.** If the user gave a bare domain, normalize to `https://`. If no URL is given, ask for one.

2. **Ensure dependencies are installed.** From the skill directory, if `node_modules/` is missing, run:
   ```bash
   npm install && npx playwright install
   ```
   (First run only — Playwright browsers are ~400MB and persist.)

3. **Run the audit:**
   ```bash
   node scripts/audit.mjs <url> [options]
   ```
   Run from the skill directory. The report is written to `audits/qa-report-{domain}-{YYYY-MM-DD}.html` **relative to the current working directory** (so it lands in the user's project, not the skill folder, when you `cd` there first — or pass `--out`).

   Options:
   - `--depth <n>` crawl depth (default 2)
   - `--max-pages <n>` page cap (default 25)
   - `--out <file.html>` explicit output path
   - `--form-factor desktop|mobile` Lighthouse profile (default desktop)
   - `--fresh` / `--no-cache` bypass the same-day cache
   - `--a11y-pages <n>` how many pages axe scans (default 5)
   - `--open` open the report when done

4. **Report back to the user** with: the overall score (0–100), the critical/high counts, the single most important fix, and the path to the HTML file. The script prints a JSON line `{overall, counts, report}` you can parse.

5. **Tune for the site size.** Big sites: lower `--max-pages` or `--depth 1` to stay within ~10 minutes. A quick single-page check: `--depth 0 --max-pages 1`.

## Output

One self-contained HTML file: inline CSS, base64-embedded screenshots, collapsible per-category sections, a 0–100 weighted executive summary, severity-coded findings (CRITICAL/HIGH/MEDIUM/LOW/PASS), and a plain-English fix + reference link for every issue. Emailable as a single attachment. Designed to be read by a non-technical PM or handed to a client.

## Notes & limits

- **Non-destructive**: it never submits forms, logs in, or performs intrusive security scans. It audits the logged-out, public surface.
- Automated accessibility tools catch ~30–50% of WCAG issues — the report says so, and recommends manual keyboard/screen-reader testing.
- Lighthouse needs Google Chrome (or Chromium) available; the Performance section degrades gracefully if Chrome can't launch.
- Results are cached per URL per day under the OS temp dir; use `--fresh` to force a new scan.

## Tech

Node.js (ESM). Playwright (Chromium/Firefox/WebKit), Lighthouse 13 via chrome-launcher, @axe-core/playwright, Pa11y, cheerio, nspell + dictionary-en, Node `tls`, EJS for the report. See `README.md` for architecture.
