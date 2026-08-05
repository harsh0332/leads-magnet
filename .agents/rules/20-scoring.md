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
| Website is social/directory only | 40 | Better lead — they already want presence |
| Listing unclaimed | 25 | Nobody is managing this |
| No hours listed | 12 | Neglected profile |
| No photos / under 3 photos | 12 | Neglected profile |
| Rating < 4.0 with 20+ reviews | 10 | Reputation problem = a service you sell |
| Under 10 reviews total | 8 | Not collecting reviews |
| No phone on listing | −25 | You literally cannot call them |

### Observable-signal rescaling (added 2026-08-05, NOW DORMANT)

When a gap signal has no path in `config/field-map.json` its weight cannot be
observed, and leaving it in the budget is not neutral: every lead lands short of
the tier it belongs in, and the report prints a confidently wrong "Tier A: 0".
That is the REVIEW.md S1-1 failure by another route.

So the observable signals are rescaled **at runtime** to preserve their ratios
and the original achievable maximum, and every run prints what was dropped and
the scale factor. A silently reweighted model is exactly as dangerous as a
silently broken field.

**As of 2026-08-06 the rescale is dormant — scale = 1.0 — because `discover`
mapped the last three unmapped signals** (`isUnclaimed` `[49,0]`, `hours`
`[203,0]`, `photoCount` `[37,1]`). Every weight in the table above is now used
at face value. This is exactly the automatic revert the runtime design was for:
nobody had to remember to undo anything.

It will re-arm on its own if a future payload change breaks a path. Two
properties it must keep:

1. **Computed at runtime** from which fields the map actually provides, never
   hardcoded.
2. **Printed every run.** If you see a scale factor in the log, some signal has
   stopped resolving and that is the thing to fix — not the weights.

Restoring a broken signal requires a fixture-derived path recorded in
`config/field-map.json` with its provenance. Never restore a weight by guessing
an index.

Note that `noWebsite` and `socialOnly` are mutually exclusive — a record scores
one or the other, never both — so only the larger counts toward the ceiling.
Now that both are 40 the achievable positive maximum is 142, clamped to 100.

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

**Why social-only scores the SAME as no-website (raised 32 → 40, 2026-08-06):**
that owner has already decided digital presence matters and has taken action.
They are pre-sold on the problem. A blank listing often belongs to someone who
doesn't want anything.

The rationale above was always written that way, but the weight scored these
leads 20% BELOW a blank listing — the number contradicted the argument. The
contradiction had a visible cost: the highest-review social-only record in the
corpus (236 reviews, Instagram page only) scored gap 32 and landed in Tier B,
while a 100-review business with no site scored 40. If the pre-sold argument is
right, that ordering is backwards.

**This is a hypothesis, not a measured result.** There is no conversion data
behind either number. 40 encodes "a social-only owner is at least as good a
prospect as one with nothing", which is an assertion about buyer psychology that
this repo has never tested.

**Re-derive both weights from actual close rates once 30+ calls are logged.**
Until then every gap weight in this table is an informed guess, and the tier
thresholds built on them inherit that uncertainty. Do not treat the numbers as
validated because they appear in a rules file.

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
| **A** | gap ≥ 40 AND demand ≥ 75 AND has phone | Call today |
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

### STANDING RULE — recalibrate floors whenever the signal set changes

A tier floor is a fraction of an achievable maximum, not an absolute. Change the
signal set and the maximum moves underneath the floor, silently changing what
the tier means. **This has now caused the same failure twice**, so it is a rule
rather than a note:

> Whenever a gap signal is added, removed, or reweighted, re-derive the tier
> floors against the new achievable maximum in the same change. State the new
> maximum and what fraction of it each floor represents.

Occurrence 1: three signals went unmapped, the observable maximum fell, and
`noWebsite` alone cleared the old gap ≥ 50 floor — so gap stopped discriminating
and Tier A ballooned to 93 on a 454-record run.

Occurrence 2: the reverse. `nameStuffed` and `badCategory` were added and three
signals were mapped, but the gap ≥ 50 floor stayed. With `noWebsite` and
`socialOnly` both worth exactly 40, a floor of 50 made a **second signal
mandatory** — so Tier A silently began selecting for *listing hygiene problems*
rather than *needs a website*, which inverts what this tool is for. A
509-review dentist with only an Instagram page sat in Tier B.

### Tier A gap floor lowered 50 → 40 (2026-08-06)

The realistic gap ceiling is about 75, not 100: `noWebsite` and `socialOnly` are
mutually exclusive at 40, and the remaining signals a *busy, well-run* business
can plausibly carry are `nameStuffed` (20) and `badCategory` (15). The
unclaimed/noHours/noPhotos signals are strongly anti-correlated with high review
counts — a business with 500 reviews is claimed, has hours, and has photos.

So a floor of 50 against a realistic 75 ceiling demanded two signals. At 40 the
core pitch — **no website, or social-only, on a business with real footfall** —
qualifies on its own, and `nameStuffed` / `badCategory` become bonus signals
that pull a *less* busy business up rather than prerequisites.

**Demand does the selectivity.** The demand ≥ 75 floor (75+ reviews) is
unchanged and is what keeps Tier A small.

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
