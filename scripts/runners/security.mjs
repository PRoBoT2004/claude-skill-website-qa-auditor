import tls from 'node:tls';
import { makeFinding } from '../lib/contract.mjs';
import { truncate } from '../lib/util.mjs';

// Security: security headers, HTTPS enforcement, TLS certificate details,
// mixed content, cookie flags, outdated front-end libraries, and light
// (non-destructive) information-disclosure checks.

const SECURITY_HEADERS = {
  'content-security-policy': {
    name: 'Content-Security-Policy (CSP)',
    sev: 'HIGH',
    why: 'Without a Content Security Policy, the browser will run scripts from anywhere — the main defense against cross-site scripting (XSS) is missing.',
    fix: 'Add a Content-Security-Policy header restricting script/style/img sources to trusted origins.',
    ref: { label: 'OWASP: CSP', url: 'https://owasp.org/www-project-secure-headers/#content-security-policy' },
  },
  'strict-transport-security': {
    name: 'Strict-Transport-Security (HSTS)',
    sev: 'MEDIUM',
    why: 'HSTS forces browsers to always use HTTPS. Without it, a first visit can be downgraded to insecure HTTP by an attacker.',
    fix: 'Add Strict-Transport-Security: max-age=31536000; includeSubDomains (only once HTTPS is fully working).',
    ref: { label: 'OWASP: HSTS', url: 'https://owasp.org/www-project-secure-headers/#http-strict-transport-security' },
  },
  'x-frame-options': {
    name: 'X-Frame-Options',
    sev: 'MEDIUM',
    why: 'Without this (or a CSP frame-ancestors), the site can be embedded in a hidden iframe and used for clickjacking attacks.',
    fix: 'Add X-Frame-Options: SAMEORIGIN (or a CSP frame-ancestors directive).',
    ref: { label: 'OWASP: X-Frame-Options', url: 'https://owasp.org/www-project-secure-headers/#x-frame-options' },
  },
  'x-content-type-options': {
    name: 'X-Content-Type-Options',
    sev: 'LOW',
    why: 'Without nosniff, browsers may guess (MIME-sniff) file types, which can turn an uploaded file into executable script.',
    fix: 'Add X-Content-Type-Options: nosniff.',
    ref: { label: 'OWASP: nosniff', url: 'https://owasp.org/www-project-secure-headers/#x-content-type-options' },
  },
  'referrer-policy': {
    name: 'Referrer-Policy',
    sev: 'LOW',
    why: 'Without a referrer policy, full URLs (possibly with sensitive query data) leak to third-party sites users click through to.',
    fix: 'Add Referrer-Policy: strict-origin-when-cross-origin.',
    ref: { label: 'OWASP: Referrer-Policy', url: 'https://owasp.org/www-project-secure-headers/#referrer-policy' },
  },
  'permissions-policy': {
    name: 'Permissions-Policy',
    sev: 'LOW',
    why: 'Permissions-Policy controls access to camera, microphone, geolocation, etc. Without it, embedded third-party code may request these.',
    fix: 'Add a Permissions-Policy header disabling features you don’t use, e.g. geolocation=(), camera=().',
    ref: { label: 'MDN: Permissions-Policy', url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Permissions-Policy' },
  },
};

function getCert(hostname) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      const socket = tls.connect({ host: hostname, port: 443, servername: hostname, timeout: 12000 }, () => {
        const cert = socket.getPeerCertificate();
        const cipher = socket.getCipher();
        socket.end();
        finish({ cert, cipher, authorized: socket.authorized, authError: socket.authorizationError });
      });
      socket.on('error', (e) => finish({ error: e.message }));
      socket.on('timeout', () => {
        socket.destroy();
        finish({ error: 'tls timeout' });
      });
    } catch (e) {
      finish({ error: e.message });
    }
  });
}

export async function run(ctx) {
  const { pages, origin, cookies, config, log } = ctx;
  const findings = [];
  const url = new URL(origin);
  const isHttps = url.protocol === 'https:';
  const home = pages[0];
  const headers = home?.headers || {};

  // ---- HTTPS enforcement ----
  if (!isHttps) {
    findings.push(
      makeFinding({
        title: 'Site is not served over HTTPS',
        severity: 'CRITICAL',
        location: origin,
        description: 'The site loads over plain HTTP. All traffic — including any form data — is transmitted unencrypted and can be read or modified by anyone on the network.',
        recommendation: 'Install a TLS certificate (free via Let’s Encrypt) and redirect all HTTP traffic to HTTPS.',
        reference: { label: 'OWASP: Transport security', url: 'https://owasp.org/www-project-top-ten/2017/A3_2017-Sensitive_Data_Exposure' },
      })
    );
  } else {
    // does http:// redirect to https://?
    try {
      const httpRes = await fetch(`http://${url.hostname}/`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000) }).catch(() => null);
      if (httpRes && !(httpRes.status >= 300 && httpRes.status < 400 && /^https:/i.test(httpRes.headers.get('location') || ''))) {
        if (httpRes.status < 400) {
          findings.push(
            makeFinding({
              title: 'HTTP does not redirect to HTTPS',
              severity: 'HIGH',
              location: `http://${url.hostname}/`,
              description: `Visiting the plain http:// address returns HTTP ${httpRes.status} instead of redirecting to the secure https:// version. Users (and old links) can land on the insecure page.`,
              recommendation: 'Configure a permanent 301 redirect from all http:// URLs to their https:// equivalents.',
              reference: { label: 'web.dev: Redirect HTTP to HTTPS', url: 'https://web.dev/articles/why-https-matters' },
            })
          );
        }
      } else if (httpRes) {
        findings.push(
          makeFinding({
            title: 'HTTP correctly redirects to HTTPS',
            severity: 'PASS',
            location: origin,
            description: 'Plain HTTP requests are redirected to the secure HTTPS version.',
            recommendation: 'No action needed.',
          })
        );
      }
    } catch {
      /* ignore */
    }

    // ---- TLS certificate ----
    const info = await getCert(url.hostname);
    log('security', info.error ? `tls error: ${info.error}` : `cert ok, ${info.cert?.valid_to}`);
    if (info.error) {
      findings.push(
        makeFinding({
          title: 'Could not inspect SSL certificate',
          severity: 'LOW',
          location: origin,
          description: `The TLS certificate could not be read (${info.error}). The connection may still be valid — verify manually.`,
          recommendation: 'Check the certificate in a browser or with an SSL test tool.',
        })
      );
    } else if (info.cert && info.cert.valid_to) {
      const expiry = new Date(info.cert.valid_to);
      const days = Math.round((expiry.getTime() - Date.parse(home?.headers?.date || info.cert.valid_from)) / 86400000);
      const issuer = info.cert.issuer?.O || info.cert.issuer?.CN || 'unknown issuer';
      const bits = info.cert.bits || (info.cipher?.name || '');
      const expSev = days < 0 ? 'CRITICAL' : days < 14 ? 'HIGH' : days < 30 ? 'MEDIUM' : 'PASS';
      findings.push(
        makeFinding({
          title:
            days < 0
              ? 'SSL certificate has EXPIRED'
              : `SSL certificate valid — expires in ~${days} days`,
          severity: expSev,
          location: origin,
          description: `Certificate issued by ${issuer}, valid until ${info.cert.valid_to}${bits ? `, ${bits}-bit key` : ''}. Cipher: ${info.cipher?.name || 'n/a'}.${days < 30 && days >= 0 ? ' It expires soon — renew before it lapses or the site will show a security warning.' : ''}`,
          recommendation: days < 30 ? 'Renew the TLS certificate now (enable auto-renewal if using Let’s Encrypt).' : 'No action needed.',
          reference: { label: 'SSL/TLS best practices', url: 'https://ssl-config.mozilla.org/' },
        })
      );
      if (!info.authorized && info.authError) {
        findings.push(
          makeFinding({
            title: `Certificate trust problem: ${info.authError}`,
            severity: 'HIGH',
            location: origin,
            description: `The certificate did not validate cleanly (${info.authError}). Visitors may see a "not secure" or "connection not private" warning.`,
            recommendation: 'Fix the certificate chain (install intermediate certificates) or hostname mismatch.',
          })
        );
      }
    }
  }

  // ---- Security headers ----
  let missingHeaders = 0;
  for (const [key, def] of Object.entries(SECURITY_HEADERS)) {
    if (!headers[key]) {
      missingHeaders++;
      findings.push(
        makeFinding({
          title: `Missing security header: ${def.name}`,
          severity: def.sev,
          location: origin,
          description: def.why,
          recommendation: def.fix,
          reference: def.ref,
        })
      );
    }
  }
  if (missingHeaders === 0) {
    findings.push(
      makeFinding({
        title: 'All six core security headers are present',
        severity: 'PASS',
        location: origin,
        description: 'CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy and Permissions-Policy are all set.',
        recommendation: 'No action needed.',
      })
    );
  }

  // information disclosure
  for (const h of ['server', 'x-powered-by']) {
    if (headers[h] && /\d/.test(headers[h])) {
      findings.push(
        makeFinding({
          title: `Software version disclosed in "${h}" header`,
          severity: 'LOW',
          location: origin,
          description: `The "${h}: ${truncate(headers[h], 60)}" header reveals exact software versions, helping attackers find matching known exploits.`,
          recommendation: `Suppress or genericize the ${h} header so it doesn't reveal version numbers.`,
          reference: { label: 'OWASP: Fingerprinting', url: 'https://owasp.org/www-project-secure-headers/#x-powered-by' },
        })
      );
    }
  }

  // ---- Mixed content ----
  if (isHttps) {
    let mixed = 0;
    const examples = [];
    for (const p of pages) {
      const m = (p.html || '').match(/(?:src|href)\s*=\s*["']http:\/\/[^"']+["']/gi) || [];
      for (const hit of m) {
        // ignore http://www.w3.org and schema/xmlns namespaces
        if (/w3\.org|schema\.org|xmlns|\.dtd/i.test(hit)) continue;
        mixed++;
        if (examples.length < 3) examples.push(truncate(hit.replace(/^[^=]*=\s*["']/, ''), 80));
      }
    }
    if (mixed) {
      findings.push(
        makeFinding({
          title: `${mixed} mixed-content resource(s) loaded over insecure HTTP`,
          severity: 'MEDIUM',
          location: examples[0] || origin,
          description: `The HTTPS site references ${mixed} resource(s) over plain http://, e.g. ${examples.join(', ')}. Browsers block or warn on these, breaking images/scripts and weakening the secure padlock.`,
          recommendation: 'Update these URLs to https:// (or protocol-relative //) so the whole page loads securely.',
          reference: { label: 'web.dev: Mixed content', url: 'https://web.dev/articles/what-is-mixed-content' },
        })
      );
    }
  }

  // ---- Cookie flags ----
  for (const c of cookies || []) {
    const issues = [];
    if (isHttps && !c.secure) issues.push('Secure');
    if (!c.httpOnly) issues.push('HttpOnly');
    if (!c.sameSite || c.sameSite === 'None') issues.push('SameSite');
    if (issues.length) {
      findings.push(
        makeFinding({
          title: `Cookie "${c.name}" missing flags: ${issues.join(', ')}`,
          severity: issues.includes('Secure') ? 'MEDIUM' : 'LOW',
          location: `${c.domain}${c.path || ''}`,
          description: `The cookie "${c.name}" is missing ${issues.join(', ')}. ${issues.includes('HttpOnly') ? 'Without HttpOnly, JavaScript (and any injected script) can read it. ' : ''}${issues.includes('Secure') ? 'Without Secure, it can be sent over insecure HTTP. ' : ''}${issues.includes('SameSite') ? 'Without SameSite, it is exposed to cross-site request forgery (CSRF).' : ''}`,
          recommendation: `Set the ${issues.join(', ')} attribute(s) on this cookie. Session cookies should be HttpOnly; Secure; SameSite=Lax or Strict.`,
          reference: { label: 'OWASP: Cookie security', url: 'https://owasp.org/www-community/controls/SecureCookieAttribute' },
        })
      );
    }
  }

  // ---- Outdated libraries ----
  const libFindings = detectOutdatedLibs(pages);
  findings.push(...libFindings);

  const critical = findings.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH').length;
  return {
    id: 'security',
    title: 'Security',
    icon: '🔒',
    summary: critical
      ? `${critical} high/critical security issue(s) — including headers and/or transport.`
      : `HTTPS in place; ${missingHeaders} security header(s) missing.`,
    stats: {
      HTTPS: isHttps ? 'yes' : 'NO',
      'Security headers missing': missingHeaders,
      'Cookies inspected': (cookies || []).length,
    },
    findings,
  };
}

function detectOutdatedLibs(pages) {
  const out = [];
  const seen = new Set();
  const html = pages.map((p) => p.html || '').join('\n');

  const jq = html.match(/jquery[.\-/]?(\d+\.\d+\.\d+)/i);
  if (jq && !seen.has('jquery')) {
    seen.add('jquery');
    const [maj, min] = jq[1].split('.').map(Number);
    if (maj < 3 || (maj === 3 && min < 5)) {
      out.push(
        makeFinding({
          title: `Outdated jQuery detected (v${jq[1]})`,
          severity: 'MEDIUM',
          location: 'page scripts',
          description: `jQuery ${jq[1]} is in use. Versions before 3.5.0 contain known cross-site scripting (XSS) vulnerabilities (CVE-2020-11022/11023).`,
          recommendation: 'Upgrade to jQuery 3.5.0 or later, or remove jQuery if no longer needed.',
          reference: { label: 'jQuery security advisory', url: 'https://blog.jquery.com/2020/04/10/jquery-3-5-0-released/' },
        })
      );
    }
  }
  const ng = html.match(/angular[.\-/]?(1\.\d+\.\d+)/i);
  if (ng && !seen.has('angularjs')) {
    seen.add('angularjs');
    out.push(
      makeFinding({
        title: `End-of-life AngularJS detected (v${ng[1]})`,
        severity: 'MEDIUM',
        location: 'page scripts',
        description: `AngularJS 1.x (${ng[1]}) reached end-of-life in 2022 and receives no security patches.`,
        recommendation: 'Migrate off AngularJS 1.x to a maintained framework.',
        reference: { label: 'AngularJS EOL', url: 'https://docs.angularjs.org/misc/version-support-status' },
      })
    );
  }
  return out;
}
