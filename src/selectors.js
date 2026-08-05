/**
 * SINGLE SOURCE OF TRUTH FOR ALL GOOGLE MAPS SELECTORS.
 *
 * When Maps changes its DOM, this is the ONLY file that should need editing.
 * If you find yourself adding a selector anywhere else, stop.
 *
 * Stability order — data-item-id > role > aria-label > href > structural.
 * Obfuscated class names (.Nv2PK, .hfpxzc) are banned. They rotate.
 *
 * Run `/verify-selectors` before trusting any of this.
 */

export const URL_TEMPLATE = (query) =>
  `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en&gl=in`;

/* ---------- PASS 1 : results feed, no clicking ---------- */

export const FEED = {
  // The scrollable results container. NOT the window.
  container: 'div[role="feed"]',

  // Individual result cards inside the feed.
  card: 'div[role="feed"] > div > div[jsaction]',

  // Anchor inside a card. Its aria-label is the business name,
  // its href is the canonical place URL.
  placeLink: 'a[href*="/maps/place/"]',

  // Rating widget. aria-label reads like "4.6 stars 214 Reviews".
  ratingWidget: 'span[role="img"][aria-label*="star"]',

  // Presence of this = the listing has a website. Absence = it doesn't.
  // VERIFY THIS ONE FIRST — the data-value label is the most likely to change.
  websiteBtn: 'a[data-value="Website"]',

  // Fallbacks if the above stops matching. Try in order.
  websiteBtnFallbacks: [
    'a[data-value="Open website"]',
    'a[aria-label^="Visit"][target="_blank"]',
  ],

  directionsBtn: '[data-value="Directions"]',

  // Consent / cookie interstitial that sometimes precedes results.
  consentAccept: 'button[aria-label*="Accept all"], form[action*="consent"] button',
};

/* ---------- PASS 2 : detail panel, only for filtered records ---------- */

export const DETAIL = {
  name: 'h1:not([class*="fontTitleLarge"])',

  // data-item-id="phone:tel:+919876543210" — parse the attribute, not the text.
  phoneBtn: 'button[data-item-id^="phone:tel:"]',

  // Absent = genuinely no website.
  websiteLink: 'a[data-item-id="authority"]',

  addressBtn: 'button[data-item-id="address"]',
  plusCodeBtn: 'button[data-item-id="oloc"]',

  // Hours block. Two known shapes.
  hoursBtn: 'button[data-item-id="oh"], [jsaction*="openhours"]',

  // Unclaimed listings surface an ownership CTA.
  claimLink: 'a[href*="/business/"], a[href*="business.google.com"]',
  claimTextPattern: /claim this business|own this business/i,

  // Photo strip / count.
  photoButton: 'button[aria-label*="Photo"], button[jsaction*="heroHeaderImage"]',

  // Category label sits directly under the h1.
  categoryBtn: 'button[jsaction*="category"]',

  // Status banners.
  closedBanner: 'span:has-text("Permanently closed"), span:has-text("Temporarily closed")',

  reviewCount: 'span[aria-label*="review"], button[jsaction*="reviewChart"]',
};

/* ---------- Regex helpers ---------- */

export const PATTERNS = {
  // "4.6 stars"
  rating: /([\d.]+)\s*stars?/i,

  // Fallback when review count renders separately.
  ratingOnly: /^([\d.]+)\s*stars?/i,

  // data-item-id="phone:tel:+919876543210"
  phoneFromAttr: /^phone:tel:(.+)$/,

  // CID / place identifier from the URL, used for dedupe.
  cid: /!1s([^!]+)/,
  placeSlug: /\/maps\/place\/([^/]+)\//,

  sponsored: /^(sponsored|ad)$/i,
};

/* ---------- Classification ---------- */

// A "website" pointing at one of these is really a social/directory page.
// These are BETTER leads than a blank field — see .agents/rules/20-scoring.md
export const SOCIAL_DOMAINS = [
  'facebook.com', 'fb.com', 'instagram.com', 'justdial.com',
  'sulekha.com', 'indiamart.com', 'practo.com', 'linktr.ee',
  'wa.me', 'api.whatsapp.com', 'sites.google.com', 'blogspot.com',
  'wixsite.com', 'business.site', 'wordpress.com', 'youtube.com',
  'linkedin.com', 'tradeindia.com', 'exportersindia.com',
];
