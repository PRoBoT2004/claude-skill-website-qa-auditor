import * as cheerio from 'cheerio';
import { makeFinding } from '../lib/contract.mjs';
import { truncate, uniq } from '../lib/util.mjs';

// Tracking & errors: analytics presence (GA4 / GTM), JavaScript console errors
// per page (captured live during the crawl), failed network requests, and a
// third-party script inventory.

export async function run(ctx) {
  const { pages, origin, log } = ctx;
  const findings = [];
  const html = pages.map((p) => p.html || '').join('\n');

  // ---- analytics ----
  const hasGA4 = /gtag\/js\?id=G-|gtag\(['"]config['"],\s*['"]G-/.test(html) || /googletagmanager\.com\/gtag\/js\?id=G-/.test(html);
  const hasGTM = /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]+/.test(html);
  const hasUA = /UA-\d{4,}-\d/.test(html);
  const hasOtherAnalytics = /(plausible\.io|posthog|mixpanel|segment\.com|matomo|hotjar|clarity\.ms|fathom)/i.test(html);

  if (hasGA4 || hasGTM) {
    findings.push(
      makeFinding({
        title: `Analytics installed: ${[hasGA4 && 'Google Analytics 4', hasGTM && 'Google Tag Manager'].filter(Boolean).join(' + ')}`,
        severity: 'PASS',
        location: origin,
        description: `Tracking is in place via ${[hasGA4 && 'GA4', hasGTM && 'GTM'].filter(Boolean).join(' and ')}, so visitor behavior is being measured.`,
        recommendation: 'No action needed — verify events fire correctly in your analytics dashboard.',
      })
    );
  } else if (hasOtherAnalytics) {
    findings.push(
      makeFinding({
        title: 'Third-party analytics detected (non-Google)',
        severity: 'PASS',
        location: origin,
        description: 'A non-Google analytics tool (e.g. Plausible, PostHog, Mixpanel, Hotjar) appears to be installed.',
        recommendation: 'No action needed.',
      })
    );
  } else {
    findings.push(
      makeFinding({
        title: 'No analytics / tracking detected',
        severity: 'MEDIUM',
        location: origin,
        description: 'Neither Google Analytics 4, Google Tag Manager, nor common alternatives were found. Without analytics you have no visibility into traffic, conversions, or where visitors drop off.',
        recommendation: 'Install GA4 (or a privacy-friendly alternative like Plausible) so you can measure traffic and conversions.',
        reference: { label: 'Google: Set up GA4', url: 'https://support.google.com/analytics/answer/9304153' },
      })
    );
  }
  if (hasUA && !hasGA4) {
    findings.push(
      makeFinding({
        title: 'Legacy Universal Analytics (UA-) tag detected',
        severity: 'MEDIUM',
        location: origin,
        description: 'A Universal Analytics tag (UA-…) was found. Universal Analytics stopped processing data in 2023 and no longer collects anything.',
        recommendation: 'Replace the UA tag with Google Analytics 4 (G-…).',
        reference: { label: 'Google: UA sunset', url: 'https://support.google.com/analytics/answer/11583528' },
      })
    );
  }

  // ---- console errors aggregated across pages ----
  let totalErrors = 0;
  const errorSamples = [];
  for (const p of pages) {
    const errs = (p.console || []).filter((c) => c.type === 'error');
    totalErrors += errs.length;
    for (const e of errs) if (errorSamples.length < 5) errorSamples.push({ url: p.finalUrl || p.url, text: e.text });
  }
  if (totalErrors) {
    findings.push(
      makeFinding({
        title: `${totalErrors} JavaScript console error(s) across ${pages.length} pages`,
        severity: totalErrors > 10 ? 'HIGH' : 'MEDIUM',
        location: errorSamples[0]?.url || origin,
        description: `Pages log JavaScript errors during load, e.g. "${truncate(errorSamples[0]?.text || '', 140)}". Console errors frequently mean broken interactive features (forms, menus, sliders) for real users.`,
        recommendation: 'Open browser DevTools → Console on the affected pages, reproduce each error, and fix the underlying script issues.',
        reference: { label: 'MDN: Console errors', url: 'https://developer.mozilla.org/en-US/docs/Web/API/console' },
      })
    );
  }

  // ---- failed network requests (often third-party) ----
  const allFailed = [];
  for (const p of pages) for (const f of p.failedRequests || []) allFailed.push({ ...f, page: p.finalUrl || p.url });
  const failedHosts = uniq(allFailed.map((f) => hostOf(f.url)).filter(Boolean));
  if (allFailed.length) {
    findings.push(
      makeFinding({
        title: `${allFailed.length} failed network request(s) from ${failedHosts.length} host(s)`,
        severity: allFailed.length > 5 ? 'MEDIUM' : 'LOW',
        location: allFailed[0]?.page || origin,
        description: `Some resources failed to load: ${failedHosts.slice(0, 4).join(', ')}${failedHosts.length > 4 ? '…' : ''}. Failed requests can mean missing images, broken tracking, or blocked third-party scripts.`,
        recommendation: 'Review these failed requests in the Network tab; remove dead third-party scripts and fix any missing first-party assets.',
      })
    );
  }

  // ---- third-party script inventory ----
  const scriptHosts = new Set();
  for (const p of pages) {
    if (!p.html) continue;
    const $ = cheerio.load(p.html);
    $('script[src]').each((_, el) => {
      const src = $(el).attr('src') || '';
      const h = hostOf(src.startsWith('//') ? 'https:' + src : src);
      if (h && !sameHost(h, origin)) scriptHosts.add(h);
    });
  }
  const thirdParty = [...scriptHosts];
  if (thirdParty.length) {
    findings.push(
      makeFinding({
        title: `${thirdParty.length} third-party script source(s) loaded`,
        severity: thirdParty.length > 12 ? 'MEDIUM' : 'LOW',
        location: origin,
        description: `The site loads scripts from ${thirdParty.length} external domains: ${thirdParty.slice(0, 8).join(', ')}${thirdParty.length > 8 ? `, +${thirdParty.length - 8} more` : ''}. Each adds load time, privacy exposure and a potential point of failure.`,
        recommendation: thirdParty.length > 12 ? 'Audit these third-party scripts; remove unused tags/pixels and self-host or defer what you keep.' : 'Periodically review third-party scripts and remove any you no longer use.',
        reference: { label: 'web.dev: Third-party scripts', url: 'https://web.dev/articles/optimizing-content-efficiency-loading-third-party-javascript' },
      })
    );
  }

  log('tracking', `GA4=${hasGA4} GTM=${hasGTM} consoleErr=${totalErrors} 3p=${thirdParty.length}`);

  return {
    id: 'tracking',
    title: 'Tracking & Errors',
    icon: '📊',
    summary: `${totalErrors} console error(s); ${thirdParty.length} third-party scripts; analytics ${hasGA4 || hasGTM || hasOtherAnalytics ? 'present' : 'MISSING'}.`,
    stats: {
      GA4: hasGA4 ? 'yes' : 'no',
      GTM: hasGTM ? 'yes' : 'no',
      'Console errors': totalErrors,
      'Failed requests': allFailed.length,
      'Third-party scripts': thirdParty.length,
    },
    findings,
  };
}

function hostOf(u) {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
}
function sameHost(host, origin) {
  try {
    return host === new URL(origin).host;
  } catch {
    return false;
  }
}
