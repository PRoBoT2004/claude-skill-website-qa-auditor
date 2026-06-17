// Builds two things for the report:
//   1. autoChecked  — a plain list of what the automated audit already verified,
//                     so the reader knows the coverage they're getting.
//   2. sections     — a CONTEXTUAL manual QA checklist of test cases a human
//                     must still run by hand (the tool can't submit forms, log
//                     in, judge content accuracy, use a screen reader, etc.).
//
// Everything is derived from data already collected during the crawl — no extra
// browser work, so it adds no time to the audit. Items are ordered fastest /
// highest-value first.

export function buildChecklist({ pages = [], categories = [], origin = '' }) {
  const html = pages.map((p) => p.html || '').join('\n').toLowerCase();
  const paths = pages.map((p) => (p.finalUrl || p.url || '').toLowerCase());
  const has = (re) => re.test(html);

  // ---- detect what the site actually has ----
  const sig = {
    forms: /<form\b/i.test(pages.map((p) => p.html || '').join('')),
    password: has(/type=["']password["']/),
    search: has(/type=["']search["']/) || has(/name=["']s["']/) || has(/placeholder=["'][^"']*search/),
    login: has(/\b(log\s?in|sign\s?in|my account|log\s?out)\b/) || /type=["']password["']/.test(html),
    ecommerce:
      has(/\b(add to cart|add to basket|checkout|shopping cart|view cart|buy now|product)\b/) ||
      paths.some((p) => /(cart|checkout|shop|product|store)/.test(p)),
    newsletter: has(/\b(subscribe|newsletter|sign up for|join our)\b/) && has(/type=["']email["']/),
    mailto: has(/href=["']mailto:/),
    tel: has(/href=["']tel:/),
    cookie: has(/\bcookie\b/) && has(/\b(accept|consent|agree|preferences)\b/),
    privacy: has(/\b(privacy policy|privacy)\b/),
    terms: has(/\b(terms (of|&)|terms and conditions|terms of service)\b/),
    video: has(/<video\b/) || has(/youtube\.com|vimeo\.com|player/),
    maps: has(/google\.com\/maps|maps\.googleapis|mapbox/),
    booking: has(/\b(book (a|now)|appointment|schedule a|reserve|calendly)\b/),
  };

  // ---- what we already auto-verified (only list categories that actually ran) ----
  const ran = (id) => categories.find((c) => c.id === id && !c.error);
  const autoChecked = [];
  if (ran('links')) autoChecked.push(`Every internal & external link was crawled and checked for 404s, server errors and redirect loops across ${pages.length} pages.`);
  if (ran('responsive')) autoChecked.push('Layout was screenshotted at 8 screen widths (320px phone → 1920px desktop) and checked for sideways scrolling / overflow.');
  if (ran('browsers')) autoChecked.push('The home page was rendered in Chromium, Firefox and WebKit (Safari engine) and checked for per-browser console errors.');
  if (ran('performance')) autoChecked.push('Google Lighthouse measured performance, Core Web Vitals, page weight and best-practices.');
  if (ran('accessibility')) autoChecked.push('axe-core + Pa11y scanned for WCAG 2.1 AA issues: contrast, alt text, ARIA, labels, heading order.');
  if (ran('security')) autoChecked.push('Security headers, HTTPS enforcement, the TLS certificate, cookie flags and known-outdated libraries were inspected.');
  if (ran('seo')) autoChecked.push('Titles, meta descriptions, H1s, structured data, robots.txt, sitemap and canonical tags were validated.');
  if (ran('content')) autoChecked.push('Pages were spell-checked and scanned for placeholder text, outdated years and thin content.');
  if (ran('mobile')) autoChecked.push('Tap-target sizes, the viewport tag and mobile font sizes were measured on a phone-sized screen.');
  if (ran('tracking')) autoChecked.push('Analytics (GA4/GTM), JavaScript console errors and third-party scripts were detected.');

  // ---- manual test cases ----
  const item = (text, look, auto) => ({ text, look, auto: auto || '' });
  const sections = [];

  // 1. Forms & input (contextual)
  if (sig.forms || sig.newsletter) {
    const items = [
      item('Submit every form with valid data', 'You reach a clear success message / thank-you page and (if expected) receive the email or entry in your inbox/CRM.', 'Auto: forms were detected and confirmed to load, but never submitted.'),
      item('Submit every form with INVALID/empty data', 'Inline validation appears, the form is NOT sent, and error messages are clear and polite.'),
      item('Submit a form twice / double-click the button', 'No duplicate entries; the button disables or shows a loading state.'),
      item('Try a form on a phone', 'The right keyboard appears (email keyboard for email fields), nothing is hidden behind the keyboard.'),
    ];
    if (sig.newsletter) items.push(item('Subscribe to the newsletter', 'You receive a confirmation/double-opt-in email and appear in the email tool.'));
    sections.push({ title: 'Forms & user input', icon: '📝', time: '~5–10 min', items });
  }

  // 2. Accounts & login (contextual)
  if (sig.login || sig.password) {
    sections.push({
      title: 'Accounts & login',
      icon: '🔑',
      time: '~5–8 min',
      items: [
        item('Log in with correct credentials', 'You land on the right page and your session persists across pages.'),
        item('Log in with a wrong password', 'A clear error appears; it does NOT reveal whether the email exists.'),
        item('Run "forgot password"', 'The reset email arrives and the new password works.'),
        item('Log out', 'You are fully logged out and can’t reach account pages with the back button.'),
      ],
    });
  }

  // 3. Search (contextual)
  if (sig.search) {
    sections.push({
      title: 'Site search',
      icon: '🔎',
      time: '~3 min',
      items: [
        item('Search for something that exists', 'Relevant results appear quickly.'),
        item('Search for gibberish / no results', 'A friendly "no results" message appears (not a blank page or error).'),
        item('Search with a typo or different casing', 'Results are still reasonable.'),
      ],
    });
  }

  // 4. Shop & checkout (contextual)
  if (sig.ecommerce) {
    sections.push({
      title: 'Shop & checkout',
      icon: '🛒',
      time: '~10–15 min',
      items: [
        item('Add a product to the cart and update quantity', 'Cart totals update correctly; out-of-stock is handled.'),
        item('Complete a test checkout (use the payment sandbox)', 'Order succeeds, totals/tax/shipping are right, confirmation email arrives.'),
        item('Try checkout with a declined / invalid card', 'A clear error appears and no order is created.'),
        item('Apply a coupon / discount code', 'Valid codes apply; invalid codes are rejected with a message.'),
        item('Abandon checkout and come back', 'The cart is preserved.'),
      ],
    });
  }

  // 5. Booking (contextual)
  if (sig.booking) {
    sections.push({
      title: 'Booking / scheduling',
      icon: '📅',
      time: '~5 min',
      items: [
        item('Book a test appointment', 'You get a confirmation and it shows in the calendar/back-end.'),
        item('Try to double-book or book a past slot', 'It’s prevented with a clear message.'),
      ],
    });
  }

  // 6. Key journeys & navigation (always)
  sections.push({
    title: 'Key journeys & navigation',
    icon: '🧭',
    time: '~5 min',
    items: [
      item('Click every main-menu and footer link', 'Each lands on the intended page (auto-checked for 404s, but not whether it’s the RIGHT page).', 'Auto: links checked for broken status only.'),
      item('Complete your single most important user journey end-to-end', 'e.g. "find a service → contact us". It works without dead ends.'),
      item('Visit a URL that doesn’t exist', 'You get a helpful, branded 404 page with a way back — not a blank error.'),
      item('Use the browser Back button after key actions', 'Nothing breaks or resubmits unexpectedly.'),
    ],
  });

  // 7. Content & accuracy (always — tool can't judge truth)
  const accuracy = [
    item('Proofread headlines, hero copy and CTAs', 'No typos, no placeholder text, tone is on-brand.', 'Auto: spell-checked, but it can’t judge grammar, tone or wrong-but-real words.'),
    item('Verify business facts are correct & current', 'Phone, email, address, opening hours, pricing, team names, year.'),
  ];
  if (sig.mailto || sig.tel) accuracy.push(item('Click every phone (tel:) and email (mailto:) link', 'They dial/open the correct, current number and address.'));
  if (sig.maps) accuracy.push(item('Check the embedded map', 'It points to the correct location and loads.'));
  if (sig.video) accuracy.push(item('Play each video', 'It plays, has sound where expected, and isn’t broken/auto-playing loudly.'));
  accuracy.push(item('Check images are correct & high quality', 'Right images in the right place, not stretched, not low-res, not missing.'));
  sections.push({ title: 'Content & accuracy', icon: '✅', time: '~10 min', items: accuracy });

  // 8. Keyboard & screen reader (always — automation catches ~30-50%)
  sections.push({
    title: 'Accessibility — by hand',
    icon: '♿',
    time: '~10 min',
    items: [
      item('Navigate the whole page with only the Tab key', 'Focus is always visible, order is logical, and you can reach every link/button.', 'Auto: axe/Pa11y catch ~30–50% of issues — keyboard & screen-reader use must be human-tested.'),
      item('Make sure you can operate menus, modals and sliders with the keyboard', 'No keyboard traps; Esc closes modals.'),
      item('Run a screen reader on the home page + one key page', 'macOS VoiceOver (Cmd+F5) or Windows NVDA. Images, links and buttons are announced meaningfully.'),
      item('Zoom the browser to 200%', 'Content still readable and usable, nothing overlaps or disappears.'),
    ],
  });

  // 9. Real devices & cross-browser interaction (always)
  sections.push({
    title: 'Real devices & browsers',
    icon: '📱',
    time: '~10 min',
    items: [
      item('Open the site on a real iPhone and a real Android phone', 'Tapping, scrolling and menus feel right (emulated sizes were auto-checked, but not touch behaviour).', 'Auto: screenshotted at 8 widths, but not interacted with on a real device.'),
      item('Test interactive bits in Safari and Firefox', 'Dropdowns, modals, carousels, animations and forms all work (rendering was auto-checked, interaction wasn’t).', 'Auto: rendered in 3 engines for console errors only.'),
      item('Rotate the phone to landscape', 'Layout still works.'),
    ],
  });

  // 10. Performance & resilience (always)
  sections.push({
    title: 'Speed & resilience',
    icon: '⚡',
    time: '~5 min',
    items: [
      item('Throttle to "Slow 3G" in DevTools and reload', 'The page is still usable within a few seconds; nothing is permanently blank.'),
      item('Reload a few times / hard-refresh', 'No intermittent errors, missing images, or flashes of unstyled content.'),
    ],
  });

  // 11. Privacy, legal & trust (always)
  const legal = [];
  if (sig.cookie) legal.push(item('Test the cookie/consent banner', 'Accept AND reject both work; rejecting actually blocks non-essential tracking.'));
  legal.push(item('Confirm Privacy Policy & Terms exist and are linked', sig.privacy || sig.terms ? 'They’re present — read them for accuracy and current dates.' : 'They appear to be MISSING — add them (often legally required).'));
  legal.push(item('Check the site feels trustworthy', 'Padlock shows in the address bar, no "not secure" warning, contact details are easy to find.'));
  sections.push({ title: 'Privacy, legal & trust', icon: '🛡️', time: '~5 min', items: legal });

  const totalItems = sections.reduce((n, s) => n + s.items.length, 0);
  return { autoChecked, sections, totalItems };
}
