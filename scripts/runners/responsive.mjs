import { chromium } from 'playwright';
import { makeFinding } from '../lib/contract.mjs';

// Responsive / Visual: screenshot the page at 8 breakpoints, detect horizontal
// scrolling at mobile sizes and elements that overflow the viewport. Screenshots
// are returned as base64 data-URIs so the report stays a single self-contained file.

const CSS_PATH_FN = `function cssPath(el){
  if(!el||el.nodeType!==1)return '';
  const parts=[];
  while(el&&el.nodeType===1&&parts.length<5){
    let s=el.tagName.toLowerCase();
    if(el.id){s+='#'+el.id;parts.unshift(s);break;}
    if(el.className&&typeof el.className==='string'){
      const c=el.className.trim().split(/\\s+/).slice(0,2).join('.');
      if(c)s+='.'+c;
    }
    parts.unshift(s);el=el.parentElement;
  }
  return parts.join(' > ');
}`;

export async function run(ctx) {
  const { startUrl, config, log } = ctx;
  const viewports = config.viewports || [320, 375, 414, 768, 1024, 1280, 1440, 1920];
  const findings = [];
  const screenshots = [];

  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of viewports) {
      const context = await browser.newContext({
        viewport: { width, height: Math.round(width * 1.6) },
        deviceScaleFactor: 1,
        isMobile: width <= 480,
      });
      const page = await context.newPage();
      try {
        await page.goto(startUrl, { waitUntil: 'networkidle', timeout: config.timeout || 20000 }).catch(() =>
          page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: config.timeout || 20000 })
        );
        await page.waitForTimeout(600);

        const metrics = await page.evaluate(`(() => {
          ${CSS_PATH_FN}
          const winWidth = window.innerWidth;
          const docWidth = document.documentElement.scrollWidth;
          const offenders = [];
          for (const el of document.querySelectorAll('body *')) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.right > winWidth + 3 && r.left < winWidth) {
              offenders.push({ sel: cssPath(el), right: Math.round(r.right), tag: el.tagName.toLowerCase() });
            }
          }
          return { winWidth, docWidth, hasHScroll: docWidth > winWidth + 3, offenders: offenders.slice(0, 6) };
        })()`);

        const buf = await page.screenshot({ type: 'jpeg', quality: 55, fullPage: false });
        screenshots.push({
          width,
          label: `${width}px`,
          device: width <= 414 ? 'Mobile' : width <= 768 ? 'Tablet' : 'Desktop',
          dataUri: `data:image/jpeg;base64,${buf.toString('base64')}`,
          hasHScroll: metrics.hasHScroll,
        });

        if (metrics.hasHScroll) {
          const isMobile = width <= 480;
          findings.push(
            makeFinding({
              title: `Horizontal scrolling at ${width}px${isMobile ? ' (mobile)' : ''}`,
              severity: isMobile ? 'HIGH' : 'MEDIUM',
              location: `${startUrl} @ ${width}px viewport`,
              description: `The page content is ${metrics.docWidth}px wide but the screen is only ${metrics.winWidth}px, forcing users to scroll sideways${isMobile ? ' — a common, frustrating mobile bug' : ''}.${metrics.offenders.length ? ` Likely cause: ${metrics.offenders[0].sel} extends to ${metrics.offenders[0].right}px.` : ''}`,
              recommendation: 'Find the element wider than the viewport (often a fixed-width image, table, or element with a hard-coded width/margin) and constrain it with max-width:100% or overflow handling.',
              reference: { label: 'web.dev: Content sized correctly for the viewport', url: 'https://web.dev/articles/content-is-not-sized-correctly-for-the-viewport' },
            })
          );
        }
        for (const o of metrics.offenders.slice(0, 3)) {
          findings.push(
            makeFinding({
              title: `Element overflows viewport at ${width}px`,
              severity: width <= 480 ? 'MEDIUM' : 'LOW',
              location: `${o.sel}  @ ${width}px`,
              description: `The element <${o.tag}> extends to ${o.right}px, past the ${metrics.winWidth}px screen edge, so part of it is clipped or causes sideways scroll.`,
              recommendation: 'Add max-width:100%, box-sizing:border-box, or responsive units to this element so it fits within small screens.',
              reference: { label: 'MDN: Responsive design', url: 'https://developer.mozilla.org/en-US/docs/Learn/CSS/CSS_layout/Responsive_Design' },
            })
          );
        }
        log('responsive', `${width}px ${metrics.hasHScroll ? 'H-SCROLL' : 'ok'} (${metrics.offenders.length} overflow)`);
      } catch (err) {
        log('responsive', `${width}px failed: ${err.message}`);
      } finally {
        await context.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const mobileBad = screenshots.filter((s) => s.width <= 480 && s.hasHScroll).length;
  if (!findings.length) {
    findings.push(
      makeFinding({
        title: `Layout adapts cleanly across all ${viewports.length} breakpoints`,
        severity: 'PASS',
        location: startUrl,
        description: 'No horizontal scrolling or overflowing elements were detected from 320px (small phone) up to 1920px (large desktop).',
        recommendation: 'No action needed.',
      })
    );
  }

  return {
    id: 'responsive',
    title: 'Responsive & Visual',
    icon: '📱',
    summary: mobileBad
      ? `Horizontal scrolling at ${mobileBad} mobile breakpoint(s) — fix before launch.`
      : `Layout holds across all ${viewports.length} screen sizes.`,
    stats: {
      'Breakpoints tested': viewports.length,
      'Mobile h-scroll issues': screenshots.filter((s) => s.width <= 480 && s.hasHScroll).length,
    },
    screenshots,
    findings,
  };
}
