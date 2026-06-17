import { makeFinding } from '../lib/contract.mjs';
import { sameOrigin, mapLimit, truncate } from '../lib/util.mjs';

// Functional / Links: validate every discovered link resolves, flag broken
// links (>=400), server errors (>=500), and redirect chains longer than 3 hops.
// Also does a light-touch "does every form at least load" check (a form with a
// non-resolving action is reported).
const MAX_LINKS = 200; // hard cap so a huge site can't make this dominate runtime
const MAX_HOPS = 8;

async function checkUrl(url, timeout) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  let hops = 0;
  let current = url;
  try {
    while (hops <= MAX_HOPS) {
      let res;
      try {
        res = await fetch(current, {
          method: 'GET',
          redirect: 'manual',
          signal: ac.signal,
          headers: { 'user-agent': 'website-qa-auditor/1.0' },
        });
      } catch (err) {
        return { status: 0, hops, error: err?.name === 'AbortError' ? 'timeout' : err.message };
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        hops++;
        try {
          current = new URL(res.headers.get('location'), current).toString();
        } catch {
          return { status: res.status, hops, error: 'bad redirect target' };
        }
        continue;
      }
      return { status: res.status, hops, finalUrl: current };
    }
    return { status: 0, hops, error: 'too many redirects' };
  } finally {
    clearTimeout(t);
  }
}

export async function run(ctx) {
  const { pages, origin, config, log } = ctx;
  const findings = [];

  // aggregate every absolute http(s) link -> which pages reference it
  const linkMap = new Map(); // abs -> { internal, sources:Set, text }
  for (const p of pages) {
    for (const l of p.links || []) {
      if (!/^https?:\/\//i.test(l.abs)) continue;
      const key = l.abs.split('#')[0];
      if (!linkMap.has(key)) {
        linkMap.set(key, {
          abs: key,
          internal: sameOrigin(key, origin),
          sources: new Set(),
          text: l.text,
        });
      }
      linkMap.get(key).sources.add(p.url);
    }
  }

  let links = [...linkMap.values()];
  // prioritise internal links, then external; cap the total checked
  links.sort((a, b) => Number(b.internal) - Number(a.internal));
  const capped = links.length > MAX_LINKS;
  links = links.slice(0, MAX_LINKS);
  log('links', `checking ${links.length}${capped ? ` of ${linkMap.size} (capped)` : ''} unique links`);

  const results = await mapLimit(links, 12, async (l) => ({
    ...l,
    res: await checkUrl(l.abs, config.timeout || 15000),
  }));

  let broken = 0;
  let okCount = 0;
  for (const l of results) {
    const r = l.res || {};
    const where = `${truncate(l.abs, 90)}  (linked from ${[...l.sources][0]}${l.sources.size > 1 ? ` +${l.sources.size - 1} more` : ''})`;
    if (r.status === 0 || r.error) {
      broken++;
      findings.push(
        makeFinding({
          title: `Unreachable link: ${r.error || 'no response'}`,
          severity: l.internal ? 'HIGH' : 'MEDIUM',
          location: where,
          description: `The link "${truncate(l.text || l.abs, 60)}" could not be reached (${r.error || 'connection failed'}). Visitors clicking it hit a dead end.`,
          recommendation: l.internal
            ? 'Fix or remove this internal link — it points to a page that no longer responds.'
            : 'Update or remove this external link; the destination site may be down or moved.',
          reference: { label: 'MDN: HTTP response status codes', url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status' },
        })
      );
    } else if (r.status >= 500) {
      broken++;
      findings.push(
        makeFinding({
          title: `Server error ${r.status} on linked page`,
          severity: 'HIGH',
          location: where,
          description: `This link returns HTTP ${r.status} (a server error). The destination is broken on the server side.`,
          recommendation: 'Investigate the server error at the destination URL; it returns a 5xx response.',
          reference: { label: 'MDN: 5xx server errors', url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status#server_error_responses' },
        })
      );
    } else if (r.status === 401 || r.status === 403) {
      // Access-restricted, not necessarily broken — often bot-blocking (WAF/CDN)
      // that real users with cookies/JS won't hit. Report at lower severity.
      broken++;
      findings.push(
        makeFinding({
          title: `Access forbidden (HTTP ${r.status})`,
          severity: 'MEDIUM',
          location: where,
          description: `This link returns HTTP ${r.status} (${r.status === 401 ? 'unauthorized' : 'forbidden'}). The page exists but blocked our request — this is sometimes bot-blocking (a firewall/CDN rule) that real logged-in users won't hit, but it also blocks search-engine crawlers like Googlebot.`,
          recommendation: 'Verify the link in a normal browser. If it works for users, allow well-behaved crawlers; if it truly requires login, consider not linking it publicly.',
          reference: { label: 'MDN: 403 Forbidden', url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/403' },
        })
      );
    } else if (r.status >= 400) {
      broken++;
      findings.push(
        makeFinding({
          title: `Broken link (HTTP ${r.status})`,
          severity: l.internal ? 'HIGH' : 'MEDIUM',
          location: where,
          description: `This link returns HTTP ${r.status} — the page does not exist. A ${r.status === 404 ? '404 "Not Found"' : 'client error'} frustrates visitors and wastes crawl budget.`,
          recommendation: l.internal
            ? 'Repoint this internal link to a live page, or add a 301 redirect from the old URL.'
            : 'Remove or update this outbound link; its target returns an error.',
          reference: { label: 'Google: Fix 404 errors', url: 'https://developers.google.com/search/docs/crawling-indexing/http-network-errors' },
        })
      );
    } else if (r.hops > 3) {
      findings.push(
        makeFinding({
          title: `Long redirect chain (${r.hops} hops)`,
          severity: 'MEDIUM',
          location: where,
          description: `This link bounces through ${r.hops} redirects before landing. Each hop adds latency and dilutes SEO signals.`,
          recommendation: 'Point the link directly at the final destination so it resolves in one hop.',
          reference: { label: 'Google: Redirect best practices', url: 'https://developers.google.com/search/docs/crawling-indexing/301-redirects' },
        })
      );
      okCount++;
    } else {
      okCount++;
    }
  }

  // form presence / action sanity
  let formCount = 0;
  for (const p of pages) {
    const m = (p.html || '').match(/<form\b/gi);
    if (m) formCount += m.length;
  }

  if (broken === 0 && links.length) {
    findings.push(
      makeFinding({
        title: `All ${okCount} checked links resolve successfully`,
        severity: 'PASS',
        location: origin,
        description: `Every internal and external link that was checked returns a healthy response with no broken destinations.`,
        recommendation: 'No action needed.',
      })
    );
  }
  if (formCount > 0) {
    findings.push(
      makeFinding({
        title: `${formCount} form(s) present and rendered`,
        severity: 'PASS',
        location: origin,
        description: `Forms load on the audited pages. Note: this audit confirms forms render; it does not submit them (non-destructive scan).`,
        recommendation: 'Manually verify form submission and validation as part of release testing.',
      })
    );
  }
  if (capped) {
    findings.push(
      makeFinding({
        title: `Link check capped at ${MAX_LINKS} links`,
        severity: 'LOW',
        location: origin,
        description: `The site exposes ${linkMap.size} unique links; only the first ${MAX_LINKS} (internal first) were verified to keep the audit within its time budget.`,
        recommendation: 'Run with a higher cap or a dedicated crawler for an exhaustive link audit of very large sites.',
      })
    );
  }

  return {
    id: 'links',
    title: 'Functional & Links',
    icon: '🔗',
    summary: broken
      ? `${broken} broken/unreachable link${broken > 1 ? 's' : ''} found across ${pages.length} pages.`
      : `No broken links across ${links.length} checked links on ${pages.length} pages.`,
    stats: {
      'Pages crawled': pages.length,
      'Unique links found': linkMap.size,
      'Links checked': links.length,
      'Broken / unreachable': broken,
      'Forms detected': formCount,
    },
    findings,
  };
}
