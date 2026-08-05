---
name: scoring
activation: model_decision
description: Apply when changing lead scoring, tiering, or filtering logic.
---

# Lead scoring model

Two independent axes. Do not collapse them into one number.

- **Gap score (0–100)** — how broken their digital presence is
- **Demand score (0–100)** — how much business they're already doing

A high gap with zero demand is a dead lead (tiny shop, no budget). High demand
with zero gap is a bad fit (already has an agency). **The money is in high gap
+ high demand.**

## Gap score weights

| Signal | Points | Why |
|---|---|---|
| No website at all | 40 | The core pitch |
| Website is social/directory only | 32 | Better lead — they already want presence |
| Listing unclaimed | 25 | Nobody is managing this |
| No hours listed | 12 | Neglected profile |
| No photos / under 3 photos | 12 | Neglected profile |
| Rating < 4.0 with 20+ reviews | 10 | Reputation problem = a service you sell |
| Under 10 reviews total | 8 | Not collecting reviews |
| No phone on listing | −25 | You literally cannot call them |

### Observable-signal rescaling (added 2026-08-05)

Three of the signals above **cannot currently be observed**. They have no path
in `config/field-map.json`, so the payload never yields them:

| Signal | Weight | Status |
|---|---|---|
| Listing unclaimed | 25 | no field-map path — unmapped |
| No hours listed | 12 | no field-map path — unmapped |
| No photos | 12 | no field-map path — unmapped |

That is **49 of the 107-point positive budget**.

Leaving those weights in the table would not be neutral. A business with no
website and under ten reviews would score `40 + 8 = 48` against a Tier A floor
of 50 — every lead would land one or two points below the tier it belongs in,
and the report would print "Tier A: 0" while looking entirely correct. That is
the REVIEW.md S1-1 failure by another route.

So the **observable** signals are rescaled to preserve their ratios and the
original achievable maximum:

```
scale = 107 / 58 = 1.845

noWebsite    40 -> 73.8
socialOnly   32 -> 59.0
poorRating   10 -> 18.4
fewReviews    8 -> 14.8
noPhone     -25 -> -25   (a penalty, never rescaled)
```

`noWebsite` and `socialOnly` stay mutually exclusive, so only the larger counts
toward the ceiling. Gap is still clamped to 0–100 and the tier thresholds are
**unchanged**.

Two properties this must keep:

1. **The rescale is computed at runtime** in `src/score.js` from which fields
   the field map actually provides. When `discover` maps `isUnclaimed`, the
   weights revert automatically — nobody has to remember to undo this.
2. **Every run prints what was dropped and the scale factor.** A silently
   reweighted model is exactly as dangerous as a silently broken field.

Restoring these signals requires a fixture-derived path for each, recorded in
`config/field-map.json` with its provenance. Do not restore a weight by
guessing an index.

### Two more rules the code cannot currently enforce

- **`permanentlyClosed` is unmapped**, so "always exclude permanently closed"
  is enforced only where the value was actually observed. An unobserved value
  is never treated as `false`.
- **Deduplication is by `cid` only.** The previous implementation also deduped
  by phone digits into a shared `Set`. Fixture 007 disproves that: three legally
  distinct CA firms at Astha Tower, Ujjain share the reception line
  `0734 2XX XXXX` (redacted). Phone-deduping silently deleted two real leads and reported
  them as duplicates. `cid` is unique per business in the payload and is the
  correct key.

"Social/directory only" means the website field points at: `justdial.com`,
`facebook.com`, `instagram.com`, `linktr.ee`, `wa.me`, `sulekha.com`,
`indiamart.com`, `practo.com`, `linktree`, or a `sites.google.com` page.

**Why social-only scores nearly as high as no-website:** that owner has already
decided digital presence matters and has taken action. They are pre-sold on the
problem. A blank listing often belongs to someone who doesn't want anything.

## Demand score

From review count, log-scaled — review volume is the only public proxy for
footfall available on a listing.

| Reviews | Demand |
|---|---|
| 0–9 | 10 |
| 10–29 | 30 |
| 30–74 | 55 |
| 75–199 | 75 |
| 200–499 | 90 |
| 500+ | 100 |

Cap it there. A 2,000-review business is almost certainly a chain or hospital
with an existing agency — flag `likelyEnterprise: true` and drop to Tier C.

## Tiers

| Tier | Condition | Meaning |
|---|---|---|
| **A** | gap ≥ 50 AND demand ≥ 55 AND has phone | Call today |
| **B** | gap ≥ 40 AND demand ≥ 30 AND has phone | Call this week |
| **C** | gap ≥ 30 AND has phone | Backlog |
| **X** | everything else | Excluded from report |

Sort within tier by `demand` descending — biggest business first.

## Always excluded

- Sponsored / ad results
- `permanentlyClosed: true`
- Records with no phone **and** no website (unreachable)
- Duplicate CID / place URL

## What to put in the report

For each lead: name, category, phone, area, rating, reviews, gap reasons (as a
short comma list), tier. Nothing else. The operator is reading this on a phone
between calls.

The `gapReasons` field is the actual value here — it becomes the opening line
of the call. "Aapki listing pe website nahi hai aur photos bhi nahi hain" is a
concrete opener; a numeric score is not.
