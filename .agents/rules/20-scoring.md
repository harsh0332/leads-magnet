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
scale = 142 / 93 = 1.527      (after nameStuffed + badCategory were added)

noWebsite    40 -> 61.1
socialOnly   32 -> 48.9
nameStuffed  20 -> 30.5
badCategory  15 -> 22.9
poorRating   10 -> 15.3
fewReviews    8 -> 12.2
noPhone     -25 -> -25   (a penalty, never rescaled)
```

Adding the two derived signals lowered the scale factor from 1.845 to 1.527,
because more of the budget is now observable. `noWebsite` alone fell from 73.8
to 61.1 — still above the gap ≥ 50 floor on its own, which is why the Tier A
demand floor below is doing the selectivity work.

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

### Two signals computed from fields we already have (added 2026-08-05)

Neither needs new payload work. Both are derived from `name` and `category`,
which are at 100% coverage.

| Signal | Points | Detect | gapReason |
|---|---|---|---|
| `nameStuffed` | 20 | 2+ pipe chars, OR 3+ forward slashes, OR length > 70 | `listing name violates Google naming policy — suspension risk` |
| `badCategory` | 15 | primary category appears in that trade's generic blocklist | `wrong primary GMB category — hurts map pack ranking` |

**Why `nameStuffed` is a sellable gap, not a nitpick.** Google's naming
guideline is that the listing name must be the real-world business name.
Keyword-stuffed names (`Clinic | Root Canal | Implants | Aligners | Indore`)
are a documented suspension trigger. The owner has usually done it deliberately
and does not know the risk, which makes it a concrete opening line rather than
a generic pitch.

**Why `badCategory` matters.** Primary category is the single strongest local
ranking factor for map-pack placement. A dentist filed under `Medical clinic`
loses the "dentist near me" pack outright. It is a five-minute fix the operator
can demonstrate on the call, which makes it a strong door-opener.

The blocklists live in `config/categories.json` under `_genericCategories`,
keyed by the same category names as the search terms. They list categories that
are **generic relative to that trade**, not categories that are wrong in
general. `Dental clinic` and `Orthodontist` are specific for a dentist;
`Medical clinic` and `Hospital` are not.

Determining which blocklist applies: the searched trade is recovered by
reverse-mapping the query's search term through `config/categories.json`. If a
term maps to no category, **the signal is not applied at all** — an unknown
trade must never be scored as a bad category.

Observed on the 137-record fixture corpus: `nameStuffed` 10.9%,
`badCategory` 5.8%. The badCategory figure is below the ~9% originally
estimated. The blocklists were derived from the actual category distribution
per trade and deliberately NOT widened to hit a target number — `Certified
public accountant` (8 records) was left out because it is specific to
accounting, merely wrong-jurisdiction for India, and blocking it purely to
raise the percentage would be fitting the rule to the expectation.

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
| **A** | gap ≥ 50 AND demand ≥ 75 AND has phone | Call today |
| **B** | gap ≥ 40 AND demand ≥ 30 AND has phone | Call this week |
| **C** | gap ≥ 30 AND has phone | Backlog |
| **U** | reviewCount never observed AND has phone | Unknown demand — reported separately |
| **X** | everything else | Excluded from report |

### Tier U — unknown demand (added 2026-08-06)

`demandScore(null)` used to return 10, which scored "we never observed a review
count" identically to "this business has zero reviews". Those are different
states, and collapsing them put every unobserved record at the bottom of the
demand axis — invisibly, because 10 is a plausible-looking number.

A record whose `reviewCount` is null is now tiered **U** rather than scored.
`U` is reported separately from C and its count is logged every run.

**The point of U is to be visible.** A silent 10 hides a data bug; a visible U
surfaces it. If U is more than a few percent of a run, something upstream is
dropping review counts and the fix belongs there, not here.

### Record merge, not copy preference

Deduplication by `cid` used to keep the first-seen copy. That is wrong, because
the two response framings carry different fields:

- **initial** responses omit `reviewCount` entirely (`rec[4]` has length 8)
- **pagination** responses carry it (length 9)

Keep-first therefore systematically discarded the only copy carrying the review
count, which starved the demand axis and made Tier A unreachable.

Records are now **merged field by field across every copy of a cid, preferring
the first non-null value per field**. Neither copy is chosen wholesale in either
direction — the initial copy carries fields the pagination copy lacks and vice
versa. `raw.csv` keeps every copy; the merge happens at scoring time, so the raw
file stays an honest record of what was actually returned.

Sort within tier by `demand` descending — biggest business first.

### Tier A demand floor raised 55 → 75 (2026-08-05)

Losing `isUnclaimed`, `noHours` and `noPhotos` to the observable-signal rescale
made `noWebsite` alone worth 73.8 — enough on its own to clear the gap ≥ 50
floor. With gap effectively binary, the gap axis stopped discriminating and
Tier A ballooned (93 leads on a 454-record live run, which is not a day's
calling for a solo operator).

The demand axis has to carry the selectivity instead. A floor of 75 means
75+ reviews rather than 30+, i.e. a business with real, provable footfall.

This is a compensating change, not a permanent one. When `discover` maps the
three missing signals the rescale reverts automatically and gap becomes
discriminating again — at which point **revisit this floor**, because 75 will
then be over-tight. The reason it is recorded here rather than only in code is
so the next person knows it is coupled to the rescale.

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
