import * as cheerio from 'cheerio';
import { makeFinding } from '../lib/contract.mjs';
import { truncate, uniq } from '../lib/util.mjs';

// Content quality: spell check (real dictionary + allowlist), placeholder text,
// outdated years, thin/empty pages, and duplicate visible content.

const PLACEHOLDERS = [
  { re: /lorem ipsum/i, label: 'Lorem ipsum placeholder text' },
  { re: /\bTODO\b|\bFIXME\b/, label: 'TODO/FIXME developer note' },
  { re: /coming soon/i, label: '"Coming soon" placeholder' },
  { re: /under construction/i, label: '"Under construction" placeholder' },
  { re: /\byour (?:company|business|brand) name\b/i, label: 'Unreplaced "Your Company Name" template text' },
  { re: /insert .* here/i, label: '"Insert … here" template text' },
  { re: /\bplaceholder\b/i, label: 'Literal "placeholder" text' },
];

// words a hunspell dictionary flags but that are fine on real sites
const ALLOWLIST = new Set([
  'website','online','signup','login','ecommerce','blog','blogs','app','apps','api','apis','url','urls',
  'email','emails','faq','faqs','seo','ux','ui','saas','ios','android','login','dashboard','dashboards',
  'analytics','testimonials','pricing','checkout','cart','onboarding','workflow','workflows','dropdown',
  'chatbot','crypto','fintech','realtime','toolkit','newsletter','unsubscribe','login','signin','signup',
  'http','https','www','com','io','co','llc','inc','gmail','whatsapp','linkedin','instagram','facebook',
  'youtube','tiktok','wifi','pdf','png','jpg','svg','css','html','js','json','npm','github','config',
]);

function tokenize(text) {
  return (text.match(/[A-Za-z][A-Za-z'’-]{2,}/g) || []).map((w) => w.replace(/[’']s$/, '').toLowerCase());
}

export async function run(ctx) {
  const { pages, origin, log, config } = ctx;
  const findings = [];

  // load nspell dictionary (best-effort)
  let spell = null;
  try {
    const dictionary = (await import('dictionary-en')).default;
    const nspell = (await import('nspell')).default;
    const dict = typeof dictionary === 'function' ? await new Promise((res, rej) => dictionary((e, d) => (e ? rej(e) : res(d)))) : dictionary;
    spell = nspell(dict);
  } catch (err) {
    log('content', `spellcheck unavailable: ${err.message}`);
  }

  const misspelledGlobal = new Map(); // word -> sample page
  const visibleByPage = new Map();
  const currentYear = config.currentYear || 2026;
  let thinPages = 0;

  for (const p of pages) {
    if (!p.html) continue;
    const $ = cheerio.load(p.html);
    $('script,style,noscript,svg,code,pre').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    const url = p.finalUrl || p.url;
    const words = tokenize(text);
    visibleByPage.set(url, text.slice(0, 400));

    // thin content
    if (words.length < 200 && p.status >= 200 && p.status < 300) {
      thinPages++;
      findings.push(
        makeFinding({
          title: `Thin content (~${words.length} words)`,
          severity: words.length < 50 ? 'MEDIUM' : 'LOW',
          location: url,
          description: `This page has only ~${words.length} words of visible text. Very thin pages rank poorly and may look unfinished to visitors.`,
          recommendation: 'Add substantive, useful content (aim for 300+ words on key pages), or noindex utility pages that are intentionally sparse.',
          reference: { label: 'Google: Thin content', url: 'https://developers.google.com/search/docs/essentials' },
        })
      );
    }

    // placeholders
    for (const ph of PLACEHOLDERS) {
      if (ph.re.test(text)) {
        findings.push(
          makeFinding({
            title: `Placeholder text found: ${ph.label}`,
            severity: 'HIGH',
            location: url,
            description: `The page contains "${ph.label}" — unfinished placeholder content that should never reach a live site. It looks unprofessional to visitors and clients.`,
            recommendation: 'Replace the placeholder with real, final copy before launch.',
          })
        );
      }
    }

    // outdated years (e.g. a 2023 copyright when it's 2026)
    const years = uniq((text.match(/\b(20\d{2})\b/g) || []).map(Number)).filter((y) => y >= 2018 && y < currentYear);
    const copyrightOld = /(?:©|copyright|&copy;)\s*\D{0,6}(20\d{2})/i.exec(p.html);
    if (copyrightOld && Number(copyrightOld[1]) < currentYear) {
      findings.push(
        makeFinding({
          title: `Outdated copyright year (${copyrightOld[1]})`,
          severity: 'MEDIUM',
          location: url,
          description: `The footer shows a copyright year of ${copyrightOld[1]}, but the current year is ${currentYear}. An old year signals the site is unmaintained or abandoned.`,
          recommendation: 'Update the copyright year (ideally make it auto-update to the current year in code).',
        })
      );
    } else if (years.length && years.every((y) => y <= currentYear - 2)) {
      findings.push(
        makeFinding({
          title: `Possibly outdated year references (${years.join(', ')})`,
          severity: 'LOW',
          location: url,
          description: `The page references ${years.join(', ')} but not the current year (${currentYear}). If this is time-sensitive content, it may look stale.`,
          recommendation: `Review whether these dates should be updated to ${currentYear}.`,
        })
      );
    }

    // spellcheck — collect misspellings, but only report the worst offenders
    if (spell) {
      for (const w of uniq(words)) {
        if (w.length < 4 || ALLOWLIST.has(w)) continue;
        if (/\d/.test(w)) continue;
        if (!spell.correct(w)) {
          if (!misspelledGlobal.has(w)) misspelledGlobal.set(w, url);
        }
      }
    }
  }

  // spellcheck summary (cap to avoid noise; brand names will appear here)
  const misspelled = [...misspelledGlobal.entries()];
  if (misspelled.length) {
    const sample = misspelled.slice(0, 25).map(([w]) => w);
    findings.push(
      makeFinding({
        title: `${misspelled.length} potential spelling issue(s) flagged`,
        severity: misspelled.length > 15 ? 'MEDIUM' : 'LOW',
        location: misspelled[0][1],
        description: `A dictionary check flagged ${misspelled.length} words not found in the English dictionary, e.g.: ${sample.join(', ')}. Note: brand names, product names and technical jargon will appear here and are usually fine.`,
        recommendation: 'Review the flagged words; fix genuine typos and ignore intentional brand/technical terms.',
      })
    );
  }

  // duplicate visible content across pages
  const byHash = new Map();
  for (const [url, snippet] of visibleByPage) {
    const key = snippet.slice(0, 200).toLowerCase().replace(/\s+/g, ' ');
    if (key.length < 80) continue;
    byHash.set(key, [...(byHash.get(key) || []), url]);
  }
  for (const [, urls] of byHash) {
    if (urls.length > 1) {
      findings.push(
        makeFinding({
          title: `Near-duplicate page content on ${urls.length} pages`,
          severity: 'LOW',
          location: urls[0],
          description: `These pages open with near-identical visible text: ${urls.slice(0, 3).join(', ')}. Duplicate content can confuse search engines about which page to rank.`,
          recommendation: 'Differentiate the content or set canonical tags to the primary version.',
          reference: { label: 'Google: Duplicate content', url: 'https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls' },
        })
      );
    }
  }

  if (!findings.length) {
    findings.push(
      makeFinding({
        title: 'No content-quality issues detected',
        severity: 'PASS',
        location: origin,
        description: 'No placeholder text, outdated years, thin pages, or obvious spelling issues were found on the crawled pages.',
        recommendation: 'No action needed.',
      })
    );
  }

  return {
    id: 'content',
    title: 'Content Quality',
    icon: '✍️',
    summary: `${findings.filter((f) => f.severity !== 'PASS').length} content issue(s); ${misspelled.length} spelling flags, ${thinPages} thin page(s).`,
    stats: {
      'Pages analyzed': pages.length,
      'Spelling flags': misspelled.length,
      'Thin pages (<200 words)': thinPages,
      'Spellcheck engine': spell ? 'nspell + dictionary-en' : 'unavailable',
    },
    findings,
  };
}
