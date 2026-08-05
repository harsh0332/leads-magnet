---
name: selectors
activation: model_decision
description: Apply when writing, debugging, or repairing any Google Maps DOM selector or extraction logic.
---

# Google Maps selector reference

All of these live in `src/selectors.js`. This file explains **why** each one was
chosen so you don't "improve" it into something fragile.

## Stability tiers

| Tier | Handle | Lifespan | Use it? |
|---|---|---|---|
| 1 | `data-item-id="..."` | Years | Always prefer |
| 2 | `role="feed"`, `role="main"`, `role="img"` | Years | Yes |
| 3 | `aria-label` text patterns | Months–years | Yes, with locale pinned |
| 4 | `href` URL patterns | Years | Yes |
| 5 | Structural (`> div > div`) | Months | Only as fallback, comment it |
| ✗ | `.Nv2PK`, `.hfpxzc`, `.lI9IFe` | Weeks | **Never** |

## The URL must pin locale

```
https://www.google.com/maps/search/{query}?hl=en&gl=in
```

`hl=en` is mandatory. Without it Maps may serve Hindi DOM and every aria-label
pattern breaks. `gl=in` keeps results India-biased.

## Results feed

The results list is **not** the page. It is an inner scrollable container:

```js
feed: 'div[role="feed"]'
```

Scrolling `window` does nothing. You must set `scrollTop` on this element.
This is the single most common mistake — if a rewrite uses `page.mouse.wheel()`
or `window.scrollBy()`, it is wrong.

## Pass 1 — result cards (no clicking)

| Field | Selector / method |
|---|---|
| card | `div[role="feed"] > div > div[jsaction]` |
| place link + name | `a[href*="/maps/place/"]` → `aria-label` is the name |
| maps URL | same element's `href` |
| rating + reviews | `span[role="img"][aria-label*="star"]` → parse aria-label |
| hasWebsite | presence of `a[data-value="Website"]` |
| category | last `.` -separated span in the info row — structural, fragile |
| sponsored | card contains text "Sponsored" / "Ad" → **skip these** |

Rating aria-label format (en): `"4.6 stars 214 Reviews"` — regex
`/([\d.]+)\s*stars?\s*([\d,]+)\s*Review/i`.

## Pass 2 — detail panel (only for filtered records)

| Field | Selector |
|---|---|
| name | `h1` inside the detail panel |
| phone | `button[data-item-id^="phone:tel:"]` → strip prefix from `data-item-id` |
| website | `a[data-item-id="authority"]` → `href` |
| address | `button[data-item-id="address"]` → `aria-label` |
| plus code | `button[data-item-id="oloc"]` |
| hours | `button[data-item-id="oh"]` or `[jsaction*="openhours"]` |
| claim status | link containing `/business/` or text "Claim this business" |
| photo count | tab/button with `aria-label` containing "Photos" |

Phone extraction is cleanest from the attribute, not the text:
`data-item-id="phone:tel:+919876543210"` → `+919876543210`.

## Waiting

Never `waitForTimeout` after a card click. The detail panel reuses the same DOM
node, so a fixed wait races. Wait for the **content to change**:

```js
const prevName = await page.locator('h1').first().textContent().catch(() => '');
await card.click();
await page.waitForFunction(
  (prev) => {
    const h = document.querySelector('h1');
    return h && h.textContent.trim() && h.textContent.trim() !== prev;
  },
  prevName,
  { timeout: 15000 }
);
```

## When a selector breaks

Symptom → cause:

- **Zero results, every query** → feed selector broke, or soft block. Check
  screenshot first.
- **Names captured, ratings all null** → aria-label locale changed. Check `hl=en`.
- **`hasWebsite` always false** → `data-value="Website"` renamed. Verify live.
- **Phone null on most records** → detail panel didn't finish loading; the wait
  condition is racing.

Repair procedure: run `/verify-selectors`, capture the live DOM, patch only
`src/selectors.js`, re-verify. Never patch scraper.js to work around a broken
selector.
