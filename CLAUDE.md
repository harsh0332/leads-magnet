# CLAUDE.md — Local Business Lead Engine

## What this is

A Google Maps lead-generation pipeline. The operator names a **city** and a
**business category**. The system returns a scored, outreach-ready list of
businesses with a weak digital presence — no website, unclaimed listing, missing
hours, no photos — ranked by how likely they are to buy web/GMB services.

The operator is a solo digital-marketing agency owner in India. Output is a
**calling list**. Nothing in this repo automates contact.

## Architecture

Fields are extracted from **intercepted network payloads**, not from the DOM.
Google Maps returns its search results as a deeply nested array payload. We
capture that payload once, store it as a fixture, and parse it offline.

```
capture  →  fixtures/*.json   (browser, rare, one agent only)
discover →  config/field-map.json   (offline, pattern matching)
parse    →  records            (pure functions, offline, unit tested)
score    →  leads.csv          (pure)
report   →  REPORT.md          (pure)
```

The DOM-scraping predecessor and its failure modes are documented in
`REVIEW.md`. Read that before changing extraction logic — it explains why each
rule below exists.

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
npm run capture -- --city=Indore --category=dentist --limit=1   # browser, writes fixtures/
npm run discover                             # offline, derives config/field-map.json
npm run scrape  -- --city=Indore --category=dentist
npm run score   -- --run=<runId>
npm run report  -- --run=<runId>
npm run pipeline -- --city=Indore --category=dentist
```

Every run writes to `output/<runId>/` where `runId` = `<city>-<category>-<YYYYMMDD>`,
computed **once** and passed down. Never recompute it in a second process.

## Golden rules

- Never open a browser to collect data. Browsers are for capturing fixtures
  and for one-off diagnosis only. All iteration happens offline against
  fixtures.
- Never hardcode a payload array index that was not empirically derived from
  a real captured fixture and recorded in config/field-map.json.
- A field that returns null for more than 30% of records is a BUG, not a
  data characteristic. Fail loudly.
- Every extraction function must be pure: payload in, record out. No network,
  no browser, no filesystem inside a parser function.

## Deny rules

- Never add CAPTCHA solving or CAPTCHA bypass of any kind
- Never add proxy rotation, IP cycling, or fingerprint spoofing beyond the
  single fixed user-agent already present
- Never reduce the configured request delays
- Never add email harvesting, bulk WhatsApp/SMS sending, or auto-dialing
- If Google returns a block page, stop the run and report it. Do not retry
  around it.

Additionally: never commit scraped personal data (`output/` and `fixtures/` are
gitignored; this repo is public), and never install a proxy or stealth
dependency without asking.

## Silent failure is the enemy

This codebase's predecessor did not crash. It produced well-formatted,
confidently wrong data for its entire lifetime — a constant demand score, street
addresses in the category column, and an entire lead class that could never be
detected. All three shipped in committed output and none was noticed. So:

1. A loud crash is **good**. Prefer it to a plausible default.
2. Never substitute a fallback value for a failed extraction. `null` is
   information; `0` and `''` are lies.
3. "Not extracted" and "genuinely absent" must be distinguishable in the
   stored record. A record whose parse threw must be marked as such.
4. Every run prints a per-field null-rate table. A field at 100% null, or a
   numeric field with zero variance, fails the run.
5. Never write a rule in a Markdown file and assume the code obeys it. If a
   constraint matters, it needs a test.
6. **Every test report states the TOTAL count and the PASS count** — "43 tests,
   43 pass, 0 fail", never "all green" or a bare pass rate. A suite that
   silently runs fewer tests reads as success: three tests were once deleted
   during a rewrite and the run reported "39/39 green". `tests/parse.test.js`
   asserts its own declared test count for this reason; raise that constant
   deliberately when adding tests.

## Field map discipline

`config/field-map.json` is the single source of truth for where each field
lives in the payload. Nowhere else.

- Every entry records the path, the fixture it came from, the date, and a sample
  value. If you cannot cite the fixture, you guessed.
- When a path stops matching, re-capture and re-run discovery. Never patch the
  parser around a stale map. A path that resolves in one fixture and not another
  is a bug in the path.

## Parser discipline

- Pure functions only. `parse(payload) -> record`. No `fetch`, `page`, `fs`,
  `Date.now()`, or randomness. One function per non-trivial field.
- Never catch an error and return a default. Throw, or return an explicit
  `{ value: null, reason: '...' }`.
- No regex over a whole document body — scope every match to its payload node.

## Anti-blocking budget

Do not change these numbers.

- 1.5–3.5s between in-page actions
- 10–20s between queries
- Hard stop and warn the operator if 3 consecutive queries return zero results
- Max 200 places per query
- `headless: false` by default; headless is opt-in via `--headless`

If a run is being rate limited, the fix is longer delays or fewer queries. It is
never a proxy, and it is never a workaround.
## Scoring

Weights and rationale live in `.agents/rules/20-scoring.md`. Change that file
first, then the code. Never invent a weight inline.

Two independent axes — `gap` (how broken their presence is) and `demand` (how
much business they already do). Do not collapse them into one number.

## Config is the knowledge base

- `config/localities.json` — city → neighbourhood list; breaks the
  ~120-results-per-search ceiling and derives `area` from a business address.
- `config/categories.json` — search-term synonyms + `_genericCategories`.

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

## Quota awareness

Rate-limited tier. Don't re-read files already in context, don't open a browser
unless a fixture is genuinely stale, batch questions, and say up front when a
run will take hours.

## Reporting style

After a run, give the operator this and nothing more:

```
Run: indore-dentist-20260805
Scraped:      1,847 places across 96 queries
No website:     412
Tier A:          38   ← call these first
Tier B:         104
Phone captured: 487 / 516 (94%)
Null rates:     OK (all fields under 30%)
Failures:        29 (see errors.log)
```

Plus the top 5 leads. Full list stays in the CSV — don't paste hundreds of rows
into chat.

## Legal note the operator has already been told

This reads publicly displayed business listing data. It is against Google Maps
Terms of Service. Business phone numbers are public, but Indian TRAI/DND rules
apply to bulk SMS and WhatsApp Business policy applies to unsolicited template
messages. This repo produces a calling list, nothing more. Do not build anything
that automates contact.
