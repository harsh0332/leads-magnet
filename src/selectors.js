/**
 * PAGE-CONTROL SELECTORS ONLY. No data is ever read from the DOM.
 *
 * Every field now comes from intercepted network payloads, parsed offline
 * against config/field-map.json (see src/parse.js). The only reasons this file
 * still exists are:
 *
 *   1. driving the page — scrolling the results feed, dismissing consent
 *   2. SOCIAL_DOMAINS, which is domain classification, not a selector
 *
 * If you find yourself adding a selector here to READ a value, stop. That is a
 * field-map entry, and it needs a captured fixture to justify it.
 *
 * The deleted DETAIL block and its per-field selectors are documented in
 * REVIEW.md — they are why the predecessor produced confidently wrong data.
 * There is no detail-panel pass any more; phone and website arrive in the list
 * response.
 */

export const URL_TEMPLATE = (query) =>
  `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en&gl=in`;

/**
 * The endpoint carrying listing data. Both the initial payload and the
 * scroll-triggered pagination payload share this marker; the two differ in
 * body framing, which src/parse.js detects from the leading bytes.
 *
 * Do NOT narrow this to URLs containing `q=` — both variants contain it, the
 * pagination one just carries it at the end of the query string.
 */
export const DATA_ENDPOINT_MARKER = 'tbm=map';

export const FEED = {
  // The scrollable results container. NOT the window — scrolling `window` or
  // using page.mouse.wheel() does nothing. Set scrollTop on this element.
  container: 'div[role="feed"]',

  // Consent / cookie interstitial that sometimes precedes results.
  consentAccept: 'button[aria-label*="Accept all"], form[action*="consent"] button',
};

/**
 * A "website" pointing at one of these is really a social/directory page.
 * These are BETTER leads than a blank field — see .agents/rules/20-scoring.md.
 *
 * Imported by src/parse.js. Matching is on HOSTNAME, not substring, so
 * `https://mysite.com/?ref=facebook.com` is not misread as social.
 */
export const SOCIAL_DOMAINS = [
  'facebook.com', 'fb.com', 'instagram.com', 'justdial.com',
  'sulekha.com', 'indiamart.com', 'practo.com', 'linktr.ee',
  'wa.me', 'api.whatsapp.com', 'sites.google.com', 'blogspot.com',
  'wixsite.com', 'business.site', 'wordpress.com', 'youtube.com',
  'linkedin.com', 'tradeindia.com', 'exportersindia.com',
];
