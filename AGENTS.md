# AGENTS.md — Local Business Lead Engine

## What this project is

A Google Maps lead-generation pipeline. The operator names a **city** and a
**business category**. The system returns a scored, outreach-ready list of
businesses with a weak digital presence — no website, unclaimed listing,
missing hours, no photos — sorted by how likely they are to buy web/GMB
services.

The operator is a solo digital-marketing agency owner in India. Output is used
for cold calling, not email blasts.

## Stack

- Node.js 20+, ES modules (`"type": "module"`)
- Playwright (chromium) for extraction
- No database. JSON + CSV files only.
- No external APIs. No API keys anywhere in this repo.

## Commands

```
npm install                                  # first-time setup
npx playwright install chromium              # first-time setup
npm run scrape -- --city=Indore --category=dentist
npm run score  -- --run=<runId>
npm run report -- --run=<runId>
npm run pipeline -- --city=Indore --category=dentist   # all three
```

Every run writes to `output/<runId>/` where `runId` = `<city>-<category>-<YYYYMMDD>`.

## The golden rule of this repo

**You write and repair the scraper. You do NOT act as the scraper.**

Never drive Google Maps click-by-click through the browser tool to collect
records. That burns agent quota, is 50x slower, and produces nothing reusable.
Browser access is for exactly two things:

1. Verifying that a selector matches live DOM (`/verify-selectors`)
2. Diagnosing a specific failure the operator reported (`/fix-scraper`)

Bulk collection always runs through `npm run scrape` in the terminal.

## Selector discipline — non-negotiable

Google Maps ships obfuscated, rotating CSS class names (`Nv2PK`, `hfpxzc`,
`lI9IFe`). Any selector built on them dies within weeks.

- **All** selectors live in `src/selectors.js`. Nowhere else. Never inline a
  selector in `scraper.js`.
- Prefer, in this order: `data-item-id` → `role` attributes → `aria-label`
  patterns → `href` patterns → structural position.
- **Never** use a class name that looks machine-generated.
- If a needed element genuinely has no stable handle, say so and propose a
  structural fallback with a comment explaining its fragility.

## Extraction is two-pass. Never one-pass.

- **Pass 1** reads the results feed only: name, category, rating, review count,
  `hasWebsite`, maps URL. No clicking. Cheap and fast.
- **Pass 2** opens the detail panel **only for records that pass the Pass-1
  filter** (typically ~20% of them) to get phone, address, hours, photo count,
  claim status.

A single-pass design that opens every listing is a bug. Reject it.

## Reliability requirements

- Append every record to CSV **immediately** on extraction. Never buffer to the
  end of a run.
- Maintain `output/<runId>/progress.json` after every query so an interrupted
  run resumes instead of restarting.
- Wrap every per-record extraction in try/catch. Log the failure to
  `errors.log` with the maps URL and continue. One bad listing must never kill
  a run.
- Randomized delays only. Fixed intervals are a bot signature.
- `headless: false` by default. Headless is opt-in via `--headless`.

## Anti-blocking budget

- 1.5–3.5s between in-page actions
- 10–20s between queries
- Hard stop and warn the operator if 3 consecutive queries return zero results
  (that means soft-blocked or selectors broke — do not keep hammering)
- Max 200 places per query

## Scoring

Lead quality logic lives in `src/score.js` and the rationale is documented in
`.agents/rules/20-scoring.md`. Do not invent new scoring weights inline. If a
weight needs to change, change it in that rules file first, then the code.

## Config files are the knowledge base

- `config/localities.json` — city → neighbourhood list. This is what breaks the
  ~120-results-per-search ceiling.
- `config/categories.json` — category → search-term synonyms.

When the operator names a city or category not present, **add it to the config
file** as part of the task. That is how this repo gets smarter over time. Never
hardcode a city name into `src/`.

## Deny rules

- Never commit or write scraped personal data outside `output/`
- Never add email-harvesting, WhatsApp bulk-send, or auto-dial functionality
- Never reduce delays below the values above to "speed things up"
- Never bypass a CAPTCHA — stop the run and tell the operator
- Never install a proxy/stealth dependency without explicitly asking first

## Legal note the operator has already been told

This reads publicly displayed business listing data. It is against Google Maps
Terms of Service. Business phone numbers are public, but Indian TRAI/DND rules
apply to bulk SMS and WhatsApp Business policy applies to unsolicited template
messages. This repo produces a **calling list**, nothing more. Do not build
anything that automates contact.
