# Phase Prompts — copy-paste into Antigravity

Workflows (`/leads`, `/verify-selectors`) handle the day-to-day. These are the
prompts for setup, and for when something breaks.

Run Phase 0 → 3 once. After that you only ever use Phase 5 (`/leads`) and Phase
6 when Google changes its DOM.

---

## PHASE 0 — Environment setup

> Set up this project. Run `npm install`, then `npx playwright install chromium`.
> Verify Node is 20 or higher. Then run `node -e "import('playwright').then(()=>console.log('ok'))"`
> to confirm the install worked. Report only pass/fail for each step — no
> explanation unless something failed.

Expected: three green checks. If Chromium download fails, it's usually a
corporate proxy or disk space, not code.

---

## PHASE 1 — Selector verification (**do not skip this**)

> Run the `/verify-selectors` workflow.
>
> Every selector in `src/selectors.js` was written from documented Maps DOM
> patterns but has NOT been checked against today's live page. Assume at least
> one is stale.
>
> Pay specific attention to `FEED.websiteBtn` — the `data-value="Website"`
> attribute is the single most likely thing to have changed, and if it's wrong
> then every record will show `hasWebsite: false` and the entire lead list will
> be garbage that looks correct.
>
> Report a table of every selector with its live match count before you change
> anything.

This is the highest-value 20 minutes in the whole build. A silently wrong
`hasWebsite` produces 2,000 fake leads and you'd only find out on call #14.

---

## PHASE 2 — Smoke test

> Run a minimal scrape:
> ```
> npm run scrape -- --city=Indore --category=dentist --limit=1 --maxPlaces=10
> ```
> Then show me the contents of the generated `raw.csv`.
>
> Check these things and tell me pass/fail for each:
> 1. Are there 10 rows with real business names?
> 2. Do rating and reviewCount have plausible values, not nulls?
> 3. Is `hasWebsite` a mix of true and false — not all one value?
> 4. Did at least one row capture a phone number in `+91...` format?
> 5. Is `area` populated?
>
> If any check fails, diagnose the specific selector responsible and fix only
> `src/selectors.js`. Do not modify `scraper.js` to work around it.

Check 3 is the one that catches silent failure. All-false or all-true means the
website detection is broken.

---

## PHASE 3 — Scoring sanity check

> Run `npm run score -- --run=indore-dentist-<today>` then
> `npm run report -- --run=indore-dentist-<today>`.
>
> Open REPORT.md and tell me: does the Tier A list look like businesses I'd
> actually want to call? Specifically — are any of them obviously large
> hospitals or chains that already have agencies? If yes, propose an adjustment
> to the `likelyEnterprise` threshold in `src/score.js` and explain your
> reasoning before changing it.

Tune this once against real output. The 2,000-review enterprise cutoff is a
guess and will need adjusting per category — a dentist with 400 reviews is big,
a restaurant with 400 reviews is average.

---

## PHASE 4 — First real run

> Run the full pipeline for Indore dentists. This will take 5-6 hours. Start it,
> confirm the first three queries return results, then stop monitoring and tell
> me it's running. I'll check back.
>
> If it stops early because of the consecutive-empty-query guard, don't restart
> it — tell me and we'll diagnose.

Start this at night. Laptop plugged in, sleep disabled (`caffeinate -i` on Mac,
or set Power to Never Sleep on Windows).

---

## PHASE 5 — Daily use

This is all you do from here on:

```
/leads Indore dentist
/leads Bhopal ke interior designers
/leads Pithampur factory owners
/leads Guna dental clinic, only 50+ reviews
```

For a new city or category, the agent extends the config automatically and tells
you what it added. Nothing else is needed.

---

## PHASE 6 — When it breaks

It will break. Google rotates its DOM every few months. Symptoms and prompts:

**Everything returns zero:**
> Run `/verify-selectors`. Also check `output/<runId>/block-evidence.png` — tell
> me whether that screenshot shows a CAPTCHA or a normal results page. If it's a
> CAPTCHA we have a rate problem, not a selector problem, and the fix is longer
> delays not new selectors.

**Names come through but ratings are all null:**
> The rating aria-label pattern changed or the page served a non-English locale.
> Confirm `URL_TEMPLATE` still includes `hl=en`, then capture the live
> aria-label from a rating element and update `PATTERNS.rating`.

**Phone is null on most detail records:**
> The detail panel wait is racing. Capture the DOM state 1s and 3s after a card
> click, compare, and propose a more reliable wait condition. Don't just
> increase the timeout.

**hasWebsite always false:**
> `FEED.websiteBtn` is stale. Check the `websiteBtnFallbacks` array in
> selectors.js — try each against live DOM, and if none match, derive a new one
> from the actual card HTML.

---

## PHASE 7 — Extensions worth building later

Only after the base pipeline has produced real clients. In rough priority order:

1. **`config/blacklist.json`** — CIDs you've already called, auto-excluded from
   future runs. This becomes essential by month two.
2. **Call outcome tracking** — a `status` column you update by hand, fed back so
   scoring learns which gap combinations actually convert.
3. **Scheduled re-runs** — cron the pipeline monthly to catch newly opened
   businesses, which are the warmest leads of all.
4. **Screenshot capture** — grab the listing screenshot for Tier A leads so you
   can show the owner their own broken profile on the call. Highest close-rate
   addition, but adds significant run time.

Do not build any of these until the base has closed at least one client.
