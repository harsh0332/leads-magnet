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
