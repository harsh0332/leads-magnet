---
name: verify-selectors
description: Check every selector against live Google Maps DOM and repair what broke. Run this before the first ever scrape, and any time a run comes back empty.
---

# /verify-selectors

This is the **only** workflow where you drive the browser. Keep it tight — it
costs quota.

---

## Step 1 — Open a known-good page

```
https://www.google.com/maps/search/dentist+in+Vijay+Nagar+Indore?hl=en&gl=in
```

Wait for the results feed to render.

---

## Step 2 — Test Pass 1 selectors

Read `src/selectors.js`. For each Pass-1 selector, evaluate it in the page and
record the match count.

Report as a table:

| Selector | Purpose | Matches | Status |
|---|---|---|---|
| `div[role="feed"]` | results container | 1 | ✅ |
| ... | ... | 0 | ❌ BROKEN |

Expected: feed = 1, cards = 15–25 on first paint, place links = same as cards.

---

## Step 3 — Test the scroll

Set `scrollTop = scrollHeight` on the feed element three times with a 2s wait
between. Card count must increase each time. If it doesn't, the feed selector
is matching the wrong element.

---

## Step 4 — Test Pass 2 selectors

Click the **first non-sponsored** result. Wait for the `h1` to populate.

Then check each detail-panel selector and report match counts the same way.

Test on **two** listings: one that obviously has a website and one that
obviously doesn't, so `a[data-item-id="authority"]` is verified in both the
present and absent case.

---

## Step 5 — Repair

For every ❌:

1. Capture the actual outerHTML of the target element (and 2 levels of parent)
2. Derive a replacement using the stability tier order in
   `.agents/rules/10-selectors.md` — `data-item-id` first, obfuscated classes
   never
3. Patch **only** `src/selectors.js`
4. Re-run steps 2–4 to confirm the fix

---

## Step 6 — Log it

Append to `SELECTOR-LOG.md` at repo root:

```
## 2026-08-05
- `a[data-value="Website"]` → `a[data-value="Open website"]`  (label changed)
- feed, cards, phone, address: unchanged
```

This log is how you diagnose the next break faster.

---

## Step 7 — Smoke test

```bash
npm run scrape -- --city=Indore --category=dentist --limit=1 --maxPlaces=10
```

10 records with real names, ratings, and at least one captured phone = green.
Then tell the operator it's safe to run the full pipeline.
