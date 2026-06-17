import * as cheerio from 'cheerio';
import { makeFinding } from '../lib/contract.mjs';
import { sameOrigin, truncate } from '../lib/util.mjs';

// SEO: per-page title/meta/H1/canonical/schema checks plus site-level
// robots.txt, sitemap.xml, llms.txt and duplicate-title/description detection.
// Follows the claude-seo methodology (title ~60c, meta ~155c, single H1,
// valid JSON-LD, canonical present, healthy internal linking).

async function fetchText(u) {
  try {
    const res = await fetch(u, { signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'website-qa-auditor/1.0' } });
    return { ok: res.ok, status: res.status, text: res.ok ? await res.text() : '' };
  } catch {
    return { ok: false, status: 0, text: '' };
  }
}

export async function run(ctx) {
  const { pages, origin, log } = ctx;
  const findings = [];
  const titles = new Map(); // title -> [urls]
  const descs = new Map();

  let pagesMissingTitle = 0,
    pagesLongTitle = 0,
    pagesMissingDesc = 0,
    pagesMultiH1 = 0,
    pagesNoH1 = 0,
    pagesNoCanonical = 0,
    badSchema = 0,
    schemaPages = 0,
    imgs = 0,
    imgsNoAlt = 0;

  for (const p of pages) {
    if (!p.html) continue;
    const $ = cheerio.load(p.html);
    const url = p.finalUrl || p.url;

    // title
    const title = ($('head > title').first().text() || '').trim();
    if (!title) {
      pagesMissingTitle++;
    } else {
      if (title.length > 60) pagesLongTitle++;
      titles.set(title, [...(titles.get(title) || []), url]);
    }

    // meta description
    const desc = ($('meta[name="description"]').attr('content') || '').trim();
    if (!desc) {
      pagesMissingDesc++;
    } else {
      descs.set(desc, [...(descs.get(desc) || []), url]);
      if (desc.length > 160 || desc.length < 50) {
        findings.push(
          makeFinding({
            title: `Meta description ${desc.length > 160 ? 'too long' : 'too short'} (${desc.length} chars)`,
            severity: 'LOW',
            location: url,
            description: `The meta description is ${desc.length} characters. Google typically shows ~155; ${desc.length > 160 ? 'longer text gets truncated in search results' : 'very short descriptions waste the chance to attract clicks'}.`,
            recommendation: 'Write a compelling 120–155 character description that summarizes the page and includes the primary keyword.',
            reference: { label: 'Google: Meta descriptions', url: 'https://developers.google.com/search/docs/appearance/snippet' },
          })
        );
      }
    }
    if (title && title.length > 60) {
      findings.push(
        makeFinding({
          title: `Title tag too long (${title.length} chars)`,
          severity: 'LOW',
          location: url,
          description: `"${truncate(title, 70)}" is ${title.length} characters; Google truncates titles past ~60, so the end may be cut off in search results.`,
          recommendation: 'Shorten the title to under 60 characters, front-loading the most important keywords.',
          reference: { label: 'Google: Title links', url: 'https://developers.google.com/search/docs/appearance/title-link' },
        })
      );
    }

    // H1
    const h1s = $('h1');
    if (h1s.length === 0) pagesNoH1++;
    else if (h1s.length > 1) {
      pagesMultiH1++;
      findings.push(
        makeFinding({
          title: `Multiple <h1> headings (${h1s.length}) on one page`,
          severity: 'LOW',
          location: url,
          description: `This page has ${h1s.length} <h1> tags. A single, unique H1 best communicates the page's main topic to search engines and screen readers.`,
          recommendation: 'Keep one <h1> as the page’s main heading; demote the others to <h2>/<h3>.',
          reference: { label: 'Google: Heading structure', url: 'https://developers.google.com/search/docs/appearance/structured-data' },
        })
      );
    }

    // canonical
    if (!$('link[rel="canonical"]').attr('href')) pagesNoCanonical++;

    // JSON-LD schema
    $('script[type="application/ld+json"]').each((_, el) => {
      schemaPages++;
      try {
        JSON.parse($(el).text());
      } catch {
        badSchema++;
        findings.push(
          makeFinding({
            title: 'Invalid JSON-LD structured data',
            severity: 'MEDIUM',
            location: url,
            description: 'A JSON-LD structured-data block on this page is not valid JSON, so search engines will ignore it and you lose rich-result eligibility.',
            recommendation: 'Validate the structured data and fix the JSON syntax error.',
            reference: { label: 'Google Rich Results Test', url: 'https://search.google.com/test/rich-results' },
          })
        );
      }
    });

    // images alt coverage
    $('img').each((_, el) => {
      imgs++;
      const alt = $(el).attr('alt');
      if (alt == null) imgsNoAlt++;
    });

    // internal link density
    const internal = (p.links || []).filter((l) => l.abs && sameOrigin(l.abs, origin)).length;
    if (internal < 3 && p.level === 0) {
      findings.push(
        makeFinding({
          title: 'Very few internal links on the home page',
          severity: 'LOW',
          location: url,
          description: `Only ${internal} internal link(s) were found. Internal links help users and search engines discover your other pages.`,
          recommendation: 'Add a clear navigation menu and contextual links to key pages.',
          reference: { label: 'Google: Internal links', url: 'https://developers.google.com/search/docs/crawling-indexing/links-crawlable' },
        })
      );
    }
  }

  // aggregate per-page counters into findings
  if (pagesMissingTitle)
    findings.push(mk(`${pagesMissingTitle} page(s) missing a <title> tag`, 'HIGH', origin, 'Pages without a title tag show their URL in search results and lose ranking signals.', 'Add a unique, descriptive <title> to every page.', { label: 'Google: Title links', url: 'https://developers.google.com/search/docs/appearance/title-link' }));
  if (pagesMissingDesc)
    findings.push(mk(`${pagesMissingDesc} page(s) missing a meta description`, 'MEDIUM', origin, 'Without a meta description, Google auto-generates snippet text, which is often less compelling and lowers click-through.', 'Add a hand-written meta description to every important page.', { label: 'Google: Snippets', url: 'https://developers.google.com/search/docs/appearance/snippet' }));
  if (pagesNoH1)
    findings.push(mk(`${pagesNoH1} page(s) with no <h1> heading`, 'MEDIUM', origin, 'A missing H1 weakens both SEO and accessibility — neither search engines nor screen readers get a clear page topic.', 'Add exactly one descriptive <h1> per page.', { label: 'WCAG: Headings', url: 'https://www.w3.org/WAI/tutorials/page-structure/headings/' }));
  if (pagesNoCanonical)
    findings.push(mk(`${pagesNoCanonical} page(s) missing a canonical tag`, 'LOW', origin, 'Canonical tags tell Google which URL is the "official" version, preventing duplicate-content dilution.', 'Add <link rel="canonical"> pointing to each page’s preferred URL.', { label: 'Google: Canonicalization', url: 'https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls' }));

  // image alt coverage
  if (imgs) {
    const cov = Math.round(((imgs - imgsNoAlt) / imgs) * 100);
    if (imgsNoAlt) {
      findings.push(
        mk(
          `${imgsNoAlt} of ${imgs} images missing alt text (${cov}% coverage)`,
          imgsNoAlt / imgs > 0.5 ? 'MEDIUM' : 'LOW',
          origin,
          `Alt text helps SEO (image search) and is required for accessibility. Current coverage is ${cov}%.`,
          'Add descriptive alt attributes to informative images; use empty alt="" for decorative ones.',
          { label: 'Google: Image SEO', url: 'https://developers.google.com/search/docs/appearance/google-images' }
        )
      );
    } else {
      findings.push(mk(`All ${imgs} images have alt attributes`, 'PASS', origin, 'Every image carries an alt attribute — good for SEO and accessibility.', 'No action needed.'));
    }
  }

  // duplicate titles / descriptions
  for (const [t, urls] of titles) {
    if (urls.length > 1)
      findings.push(mk(`Duplicate <title> on ${urls.length} pages`, 'MEDIUM', urls[0], `The title "${truncate(t, 60)}" is reused on ${urls.length} pages (e.g. ${urls.slice(0, 2).join(', ')}). Each page should have a unique title.`, 'Give every page a unique, descriptive title.', { label: 'Google: Duplicate titles', url: 'https://developers.google.com/search/docs/appearance/title-link' }));
  }
  for (const [d, urls] of descs) {
    if (urls.length > 1)
      findings.push(mk(`Duplicate meta description on ${urls.length} pages`, 'LOW', urls[0], `The same meta description is reused on ${urls.length} pages. Unique descriptions improve click-through.`, 'Write a distinct meta description per page.', { label: 'Google: Snippets', url: 'https://developers.google.com/search/docs/appearance/snippet' }));
  }

  // ---- site-level files ----
  const robots = await fetchText(new URL('/robots.txt', origin).toString());
  if (!robots.ok) {
    findings.push(mk('robots.txt is missing', 'LOW', `${origin}/robots.txt`, 'No robots.txt was found. While not mandatory, it lets you guide crawlers and point them to your sitemap.', 'Add a robots.txt that allows crawling and references your sitemap.', { label: 'Google: robots.txt', url: 'https://developers.google.com/search/docs/crawling-indexing/robots/intro' }));
  } else {
    const hasSitemapRef = /sitemap:/i.test(robots.text);
    findings.push(mk('robots.txt present', 'PASS', `${origin}/robots.txt`, `robots.txt is reachable${hasSitemapRef ? ' and references a sitemap' : ''}.`, hasSitemapRef ? 'No action needed.' : 'Consider adding a "Sitemap:" line pointing to your sitemap.xml.'));
  }
  const sitemap = await fetchText(new URL('/sitemap.xml', origin).toString());
  if (!sitemap.ok || !/<urlset|<sitemapindex/i.test(sitemap.text)) {
    findings.push(mk('sitemap.xml missing or invalid', 'MEDIUM', `${origin}/sitemap.xml`, 'No valid XML sitemap was found at /sitemap.xml. Sitemaps help search engines discover and index all your pages.', 'Generate and submit an XML sitemap (most CMS platforms and frameworks can auto-generate one).', { label: 'Google: Sitemaps', url: 'https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview' }));
  } else {
    const count = (sitemap.text.match(/<loc>/g) || []).length;
    findings.push(mk(`Valid XML sitemap (${count} URLs)`, 'PASS', `${origin}/sitemap.xml`, `A valid sitemap with ${count} URLs was found.`, 'No action needed.'));
  }
  const llms = await fetchText(new URL('/llms.txt', origin).toString());
  findings.push(
    llms.ok
      ? mk('llms.txt present (AI-search ready)', 'PASS', `${origin}/llms.txt`, 'An llms.txt file is present, helping AI search engines (ChatGPT, Perplexity, etc.) understand your site.', 'No action needed.')
      : mk('llms.txt not found', 'LOW', `${origin}/llms.txt`, 'No llms.txt was found. This emerging standard helps AI assistants and AI search engines summarize your site accurately.', 'Consider adding an llms.txt that lists your key pages and a short site description.', { label: 'llms.txt spec', url: 'https://llmstxt.org/' })
  );

  log('seo', `titles=${titles.size} dupTitles=${[...titles.values()].filter((u) => u.length > 1).length} altMissing=${imgsNoAlt}/${imgs}`);

  return {
    id: 'seo',
    title: 'SEO',
    icon: '🔍',
    summary: `${findings.filter((f) => f.severity !== 'PASS').length} SEO issue(s) across ${pages.length} pages; alt-text coverage ${imgs ? Math.round(((imgs - imgsNoAlt) / imgs) * 100) : 100}%.`,
    stats: {
      'Pages analyzed': pages.length,
      'Missing titles': pagesMissingTitle,
      'Missing meta desc': pagesMissingDesc,
      'Pages w/o H1': pagesNoH1,
      'Structured-data blocks': schemaPages,
      'Alt-text coverage': imgs ? `${Math.round(((imgs - imgsNoAlt) / imgs) * 100)}%` : 'n/a',
    },
    findings,
  };
}

function mk(title, severity, location, description, recommendation, reference) {
  return makeFinding({ title, severity, location, description, recommendation, reference });
}
