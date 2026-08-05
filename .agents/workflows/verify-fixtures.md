---
name: verify-fixtures
description: Offline health check of the whole pipeline against captured fixtures. Run before any real run, and any time output looks wrong. No browser.
---

# /verify-fixtures

Replaces the old `/verify-selectors`. **This workflow does not open a browser.**
It runs the entire pipeline offline against `fixtures/` in about a second.

---

## Step 1 — Run the suite

```bash
npm test
```

Expected: 39 tests, 35 pass, 4 fail. The four failures are known, documented
miscalibrated assertions, not defects:

| Failing test | Why it fails |
|---|---|
| each fixture yields at least 15 records | fixture 006 has 13 — Rau genuinely has 13 gyms |
| no two records share the same phone | three distinct CA firms share one reception line |
| no record carries another business's coordinates | two firms co-located in one building |
| website coverage holds per fixture | gyms are 8–10%; the bound is category-dependent |

**A different failure, or a different count, is a real regression.** Report it —
do not adjust a threshold to make it green. Changing a threshold to go green
produces a system that reports success while generating garbage.

---

## Step 2 — Run the offline pipeline

```bash
npm run pipeline -- --dry-run
```

This runs scrape → score → report against `fixtures/raw/` with no network. It
writes to `output/fixtures-dryrun-<date>/`.

---

## Step 3 — Report the null-rate table

The run prints a per-field table. Report it as-is, plus the summary line.

Read the columns correctly:

- **`nullRate`** — how often the CSV cell is blank, *including genuine
  absence*. `website` around 59% is normal; most small businesses have none.
- **`unresolvedRate`** — extraction *failures* only, excluding genuine absence
  and framing omission. **This is the number the >30% rule applies to.**

Flag any of these:

- a mapped field with `unresolvedRate` over 30% → broken path
- a field at 100% null → the path resolves to nothing
- a numeric field with zero variance → a constant, which is the signature of the
  original S1-1 defect
- `phone` coverage outside 40–98%, or corpus-wide `website` coverage outside
  15–85% → both extremes mean a wrong path, never a fact about Indian businesses

---

## Step 4 — Sanity-check the scored output

From the run's log lines and `leads.csv`:

- **Tier counts.** Tier A at 0 is not automatically correct — check whether gap
  and demand are both discriminating, or whether one axis has collapsed.
- **gapReasons spread.** If 85%+ of leads carry exactly one reason, the
  secondary signals are not landing.
- **Duplicate phones in `leads.csv` must be 0.**
- **Rescale line.** If any gap signal is unavailable the run prints what was
  dropped and the scale factor. A silently reweighted model is exactly as
  dangerous as a silently broken field.

---

## Step 5 — Only if a field-map path genuinely broke

Everything above is offline. If — and only if — a path has stopped resolving
against *newly captured* payloads, the fixtures are stale, and the sequence is:

1. `probe` captures fresh fixtures (the only agent allowed a browser)
2. `discover` re-derives `config/field-map.json` from them
3. re-run steps 1–4

Do not patch `src/parse.js` to compensate for a stale map, and do not capture
fixtures yourself unless you are `probe`.
