# AGENTS.md — Local Business Lead Engine

Auto-loaded by Antigravity. Claude Code reads `CLAUDE.md`, which carries the
same rules. If the two ever disagree, `CLAUDE.md` wins and this file is stale.

## What this project is

A Google Maps lead-generation pipeline. The operator names a **city** and a
**business category**. The system returns a scored, outreach-ready list of
businesses with a weak digital presence — no website, unclaimed listing, missing
hours, no photos, keyword-stuffed name, wrong primary category — ranked by how
likely they are to buy web/GMB services.

The operator is a solo digital-marketing agency owner in India. Output is a
**calling list**. Nothing in this repo automates contact.

## The golden rule of this repo

**Never browse Google Maps to collect data. Run `npm run pipeline` instead.**

You write and repair the pipeline. You do not act as the pipeline. Driving Maps
click-by-click burns quota, is orders of magnitude slower, produces nothing
reusable, and is the exact failure this architecture was rebuilt to eliminate.

A browser is permitted for exactly two things:

1. Capturing fixtures — `scripts/capture-fixtures.js`, run by the `probe` agent
2. Diagnosing one specific reported failure

Everything else — every question about what a field contains, every check that
extraction still works, every iteration on scoring — happens **offline against
fixtures**, in seconds.

## Architecture

Fields are extracted from **intercepted network payloads**, not from the DOM.
Google Maps returns search results as a deeply nested array payload. We capture
that payload once, store it as a fixture, and parse it offline.

```
capture  →  fixtures/*.txt        (browser, rare, probe agent only)
discover →  config/field-map.json (offline, pattern matching)
parse    →  records               (pure functions, offline, unit tested)
score    →  leads.csv             (pure)
report   →  REPORT.md             (pure)
```

There is **no DOM scraping and no detail-panel pass**. Phone, website, rating,
review count, hours, photo count and claim status all arrive in the list
response. `src/selectors.js` now exists only for page control during capture
(scrolling, consent) — never for data.

`REVIEW.md` documents the predecessor and its failure modes. Read it before
changing extraction logic; it explains why each rule below exists.

## Stack

- Node.js 20+, ES modules (`"type": "module"`)
- Playwright (chromium) — capture only, never in the iteration loop
- No database. JSON fixtures + CSV output.
- No external APIs. No API keys anywhere in this repo.

## Commands

```
npm install                                  # first-time setup
npx playwright install chromium              # first-time setup

npm test                                     # offline, against fixtures — the main loop
npm run pipeline -- --dry-run                # whole pipeline offline, ~1s
npm run pipeline -- --city=Indore --category=dentist
npm run scrape  -- --city=Indore --category=dentist
npm run score   -- --run=<runId>
npm run report  -- --run=<runId>
```

Every run writes to `output/<runId>/` where `runId` = `<city>-<category>-<YYYYMMDD>`,
computed **once** from the local date and passed down. Never recompute it in a
second process, and never use `toISOString()` — UTC stamps a run started between
00:00 and 05:30 IST with the previous day, which silently rescores stale data.

## Silent failure is the enemy

The predecessor did not crash. It produced well-formatted, confidently wrong
data for its entire lifetime — a constant demand score, street addresses in the
category column, and an entire lead class that could never be detected. All
three shipped in committed output and none was noticed. So:

1. A loud crash is **good**. Prefer it to a plausible default.
2. Never substitute a fallback value for a failed extraction. `null` is
   information; `0` and `''` are lies.
3. "Not extracted" and "genuinely absent" must be distinguishable in the stored
   record. A record whose parse threw must be marked as such.
4. Every run prints a per-field null-rate table. A field at 100% null, or a
   numeric field with zero variance, fails the run.
5. Never write a rule in a Markdown file and assume the code obeys it. If a
   constraint matters, it needs a test.

## Field map and parser discipline

- `config/field-map.json` is the single source of truth for where each field
  lives. **No literal payload index appears anywhere in `src/`.**
- Every entry records the path, the fixture it came from, the date, and a sample
  value. If you cannot cite the fixture, you guessed.
- Parsers are pure: payload in, record out. No `fetch`, no `page`, no `fs`, no
  `Date.now()`, no randomness inside a parse function.
- A parser never catches an error and returns a default. It throws, or returns
  an explicit `{ value: null, reason: '...' }`.

Full detail in `.agents/rules/10-fixtures.md`.

## Anti-blocking budget

Do not change these numbers.

- 1.5–3.5s between in-page actions
- 10–20s between queries
- Hard stop and warn the operator if 3 consecutive queries return zero records
- Max 200 places per query
- `headless: false` by default; headless is opt-in via `--headless`

If a run is being rate limited, the fix is longer delays or fewer queries. It is
never a proxy, and it is never a workaround.

## Deny rules

- Never add CAPTCHA solving or CAPTCHA bypass of any kind
- Never add proxy rotation, IP cycling, or fingerprint spoofing beyond the
  single fixed user-agent already present
- Never reduce the configured request delays
- Never add email harvesting, bulk WhatsApp/SMS sending, or auto-dialing
- If Google returns a block page, stop the run and report it. Do not retry
  around it.

Additionally: never commit scraped personal data (`output/` and `fixtures/` are
gitignored, and this repo is public), and never install a proxy or stealth
dependency without asking.

## Scoring

Weights and rationale live in `.agents/rules/20-scoring.md`. Change that file
first, then the code. Never invent a weight inline.

Two independent axes — `gap` (how broken their presence is) and `demand` (how
much business they already do). Do not collapse them into one number.

Gap signals with no field-map path are dropped and the remaining weights are
rescaled **at runtime**, so mapping a missing field reverts the rescale
automatically. Every run prints what was dropped and the scale factor.

## Config is the knowledge base

- `config/localities.json` — city → neighbourhood list. This is what breaks the
  ~120-results-per-search ceiling, and it is also how `area` is derived from a
  business address.
- `config/categories.json` — category → search-term synonyms, plus
  `_genericCategories`, the per-trade blocklist behind the `badCategory` signal.

When the operator names a city or category not present, **add it to the config
file** as part of the task, and say what you added. Never hardcode a city name
into `src/`.

## Subagents

Defined in `.claude/agents/`. Each has an explicit prohibition list — respect it.

| Agent | Role | Browser? |
|---|---|---|
| `probe` | Captures raw network payloads into `fixtures/` | **Yes — only agent allowed** |
| `discover` | Derives `config/field-map.json` from fixtures | No |
| `parser` | Writes pure parsing functions against the field map | No |
| `harness` | Writes the test suite; adversarial toward the parser | No |
| `auditor` | Reviews finished work for silent-failure modes | No |

## Language

The operator writes in Hinglish. Reply in Hinglish for conversation. Keep all
**code, comments, file contents, and CSV headers in English**.

## Legal note the operator has already been told

This reads publicly displayed business listing data. It is against Google Maps
Terms of Service. Business phone numbers are public, but Indian TRAI/DND rules
apply to bulk SMS and WhatsApp Business policy applies to unsolicited template
messages. This repo produces a calling list, nothing more. Do not build anything
that automates contact.
