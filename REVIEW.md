# REVIEW.md — pre-rewrite audit

Audit of the DOM-scraping implementation before replacing it with network
response interception. No code has been changed.

Evidence base: `output/indore-dentist-20260804/` — a real run (1 query, 20 raw
records, 9 detailed, 0 errors). Several failures below are not predictions.
They are visible in that committed output right now.

---

## 1. What each file does

### Source

| File | One line |
|---|---|
| `src/scraper.js` | Two-pass Playwright scraper: reads the results feed, then opens detail panels for records that pass a filter; writes `raw.csv` + `progress.json` incrementally. |
| `src/selectors.js` | Every CSS selector and regex in one module, plus the social/directory domain list. |
| `src/score.js` | Dedupes `raw.csv`, computes gap + demand scores, assigns tier A/B/C/X, writes `leads.csv` and `tier-a.csv`. |
| `src/report.js` | Renders `REPORT.md`, a terse phone-readable call sheet, from `leads.csv`. |
| `src/utils.js` | CLI arg parsing, sleep/jitter, logging, `ensureDir`, CSV append/write/read, social-domain test. |
| `src/pipeline.js` | Chains scrape → score → report via `spawnSync`, recomputing `runId` itself. |

### Config and knowledge

| File | One line |
|---|---|
| `config/localities.json` | 6 cities → 100 neighbourhood names; each locality becomes a separate query to break Maps' ~120-result ceiling. |
| `config/categories.json` | 12 categories → 64 search-term synonyms; each term × each locality = one query. |

### Agent instructions

| File | One line |
|---|---|
| `AGENTS.md` | Primary agent context: stack, commands, the "write the scraper, don't be the scraper" rule, selector discipline, reliability and anti-blocking budgets, deny rules. |
| `README.md` | Hinglish operator manual: setup, `/leads` usage, output file meanings, runtime/cost expectations. |
| `.agents/rules/00-mission.md` | Always-on operating mode: parse Hinglish requests, extend config, run the pipeline, report in a fixed summary block; quota economy. |
| `.agents/rules/10-selectors.md` | Selector stability tiers (`data-item-id` > `role` > `aria-label` > `href` > structural), locale pinning, per-field selector table, symptom→cause repair map. |
| `.agents/rules/20-scoring.md` | Rationale for gap/demand weights and tier thresholds; why social-only scores nearly as high as no-website. |
| `.agents/workflows/leads.md` | `/leads` workflow: parse request → extend config → run pipeline → report → escalate on failure. |
| `.agents/workflows/verify-selectors.md` | `/verify-selectors` workflow: the only browser-driving workflow; test each selector live, repair `selectors.js` only, log to `SELECTOR-LOG.md`. |
| `prompts/PHASES.md` | Phase 0–7 copy-paste prompts for setup, smoke test, scoring sanity, first run, breakage symptoms, future extensions. |
| `SELECTOR-LOG.md` | One dated entry recording the 2026-08-05 live selector verification. |

### Other

| Path | One line |
|---|---|
| `package.json` | ESM, Node ≥20, single dependency `playwright`, four npm scripts. |
| `.gitignore` | Excludes `node_modules/` and `output/*` (keeps `.gitkeep`). |
| `data/` | Empty. Never read or written by any code. |
| `{.agents/` | Literal-brace directory, empty — shell brace-expansion litter from a failed `mkdir`. |
| `output/indore-dentist-20260804/` | The one real run: `raw.csv`, `leads.csv`, `tier-a.csv` (header only), `progress.json`, `REPORT.md`. No `errors.log`. |

---

## 2. Fragility ranking

Ordered worst → least bad. **Silent failures rank above loud ones.** A loud
crash costs an hour. A silent wrong value costs a reputation on call #14.

Three severity bands:

- **S1 — silent, and already happening in committed output.** Confirmed, not theorised.
- **S2 — silent, latent.** Correct today, fails without any visible signal.
- **L — loud.** Crashes, empty runs, or logged errors. Annoying, self-announcing.

---

### S1-1 · `reviewCount` is never populated, so Tier A and Tier B are mathematically unreachable

`src/selectors.js:85` — `rating: /([\d.]+)\s*stars?/i` has **one** capture group.
`src/scraper.js:123` reads `m[2]`, which is always `undefined`. `reviewCount`
is therefore `null` on every record ever scraped.

Downstream, in `src/score.js`:

- `demandScore(null)` → `r = 0` → returns `10`, always.
- Tier A needs `demand >= 55`. Tier B needs `demand >= 30`. **Neither can ever be assigned.**
- `fewReviews` (+8) fires on 100% of records.
- `poorRating` (+10) requires `reviews >= 20` — it is dead code.
- `likelyEnterprise` requires `reviews >= 2000` — dead code.

Proof, from the committed run: all 9 qualified leads are Tier C with
`demandScore 10` and `gapScore 48`. `tier-a.csv` contains a header row and
nothing else. `REPORT.md` reports "Tier A — call today: **0**" and prints
`_None._` — in a clean, correct-looking, well-formatted document.

The pipeline's entire purpose is ranking by demand. The demand axis has been
returning a constant since the first commit, and every artifact downstream
looks healthy.

`.agents/rules/10-selectors.md:56` documents the *correct* regex
(`/([\d.]+)\s*stars?\s*([\d,]+)\s*Review/i`). The rules file was right; the code
never matched it. Nothing checks that they agree.

---

### S1-2 · `category` is capturing the street address

`src/scraper.js:132` picks the category by scanning card text lines:

```js
const category = lines.find((l) => l !== name && !/^[\d.]/.test(l)) || '';
```

Actual value in the committed `raw.csv`:

```
Dentist ·  · ground floor, infront choudhary cycle and tyre house, 34, Vijay Nagar Main Rd
```

The category, an empty separator, and the full street address, concatenated
into one field. This is in the shipped output for the majority of rows. The
CSV column is populated and non-empty, so nothing anywhere flags it. It flows
straight into `leads.csv` and onto the call sheet.

`.agents/rules/10-selectors.md:53` already labels this field "structural,
fragile". It is not fragile — it is currently wrong.

---

### S1-3 · `isSocialOnly` can never be true, deleting the highest-value lead category

`src/scraper.js:259`:

```js
const needDetail = fresh.filter((c) => !c.hasWebsite && !c.permanentlyClosed);
```

Pass 2 runs **only when the feed says there is no website**. But `websiteUrl` is
only ever read in Pass 2 (`src/scraper.js:185`). So:

- Record has a website → Pass 2 skipped → `websiteUrl` empty → `isSocialOnly: false`.
- Record has no website → Pass 2 runs → `websiteUrl` null anyway → `isSocialOnly: false`.

`isSocialOnly` is `false` on all 20 rows of the committed `raw.csv`, including
all 11 rows where `hasWebsite` is `true`.

`src/score.js:50` therefore never awards `socialOnly` (+32), and the 19-domain
`SOCIAL_DOMAINS` list in `selectors.js` is decorative.

`.agents/rules/20-scoring.md:35` argues at length that social-only listings are
the **best** leads — the owner is already pre-sold on digital presence. That
entire lead class is invisible to this pipeline, and its absence is
indistinguishable from "no such businesses exist in this city".

---

### S2-1 · `hasWebsite` is a single unguarded presence check on a rotating attribute

`FEED.websiteBtn: 'a[data-value="Website"]'` — absence is interpreted as
"business has no website" (+40 gap, the single largest weight and the core
sales pitch).

If Google renames that attribute value, the selector matches nothing, and:

- every record scores +40 "no website",
- `needDetail` stops filtering, so Pass 2 opens **every** listing instead of ~20% — a 5× slowdown that will trip rate limiting,
- the report fills with Tier A/B-shaped leads that all have websites.

`websiteBtnFallbacks` exists in `selectors.js:37` and **is never read by any
code**. It is documentation posing as a safety net.

The distribution today is 11 true / 9 false, so this is working — but the
failure mode is a full-run, confidently-wrong lead list. `prompts/PHASES.md:35`
names this exact scenario: *"2,000 fake leads and you'd only find out on call
#14."* The design that produces it is unchanged.

---

### S2-2 · `isUnclaimed` regex-matches the entire page body

`src/scraper.js:189`:

```js
isUnclaimed: new RegExp(claimRx, 'i').test(body) || !!q(DETAIL.claimLink)
```

`body` is `document.body.innerText` — the whole page, including nav, footer,
related-listings rail, and review text. `DETAIL.claimLink` is
`a[href*="/business/"]`, which matches Google's own promotional chrome, not
just this listing's ownership CTA.

Any page that happens to contain "own this business" anywhere, or any
`/business/` href anywhere, awards +25 gap. All 9 detailed records came back
`false` today, so the false-positive is not yet firing — but there is no
scoping to the detail panel at all, and a layout change that adds a footer link
silently inflates every gap score by 25 and puts a false claim in the operator's
opening line.

---

### S2-3 · "not extracted" and "genuinely absent" are the same value

When Pass 2 is skipped or throws, `detail` stays `{}`. `src/scraper.js:290-292`
then writes `null` for `hasHours`, `hasPhotos`, `isUnclaimed`.

`src/score.js` uses two different truthiness conventions in the same function:

```js
if (bool(row.isUnclaimed))       { gap += 25; }   // '' → false → no penalty
if (row.hasHours === 'false')    { gap += 12; }   // '' → no penalty
```

The no-penalty direction is the safe one, so this doesn't corrupt scores today.
What it does destroy is observability: a record whose detail pass **crashed**
and a record whose listing is genuinely complete produce byte-identical CSV
rows. `progress.stats.errors` increments, but nothing ties an error back to the
row it damaged. There is no way, after the fact, to ask "which of these 500
leads have unverified data?"

---

### S2-4 · Column desync on any cell containing a newline

`src/utils.js:47` splits the file on `\n` before parsing quotes:

```js
const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
```

`csvCell` (`utils.js:30`) correctly *quotes* cells containing newlines but does
not strip them — so writes are valid CSV that this reader cannot read. Business
names and Maps addresses routinely carry line breaks. One such cell splits a
row in half; every field after it shifts left by one column, for that row only.

A phone number lands in `area`. An address lands in `gapReasons`. The row still
has the right shape and still gets scored, tiered, and printed onto the call
sheet. Nothing in the pipeline validates column types.

The header row is also split naively on `,` (`utils.js:48`), so any quoted
header would desync the entire file.

---

### S2-5 · Phone-based dedupe silently deletes legitimate records

`src/score.js:85-91` puts CIDs and phone digits into **one shared `Set`** and
drops any record whose phone was already seen:

```js
if (seen.has(key) || (pkey && seen.has(pkey))) return false;
```

Multi-doctor clinics, chains sharing a reception line, and shared building
receptions collapse to a single lead. The dropped records are counted in the
`dupes removed` log line as if they were true duplicates, and the report's
"Qualified leads" number simply looks lower. There is no record of what was
discarded.

---

### S2-6 · Per-card errors are swallowed without a counter

`src/scraper.js:139`:

```js
} catch { /* one bad card must not kill the batch */ }
```

Correct instinct, no instrumentation. A card that throws vanishes with no log
line, no counter, no error file entry. If a DOM change breaks extraction for
60% of cards, the run reports fewer results and looks like a thin locality.
`AGENTS.md:76` requires failures be logged to `errors.log` with the maps URL —
that requirement is met in Pass 2 (`scraper.js:273`) and violated here.

---

### S2-7 · Early scroll termination under-collects silently

`src/scraper.js:89` breaks when the card count is unchanged between iterations.
Maps loads asynchronously; a slow batch produces an unchanged count that is
indistinguishable from an exhausted list. The run captures 40 of 120 available
places and reports success. Under-collection has no signature at all in the
output.

---

### S2-8 · `runId` computed twice, from two different clocks

`src/pipeline.js:12` and `src/scraper.js:33` each call `new Date()`
independently, and both use `toISOString()` (UTC).

- A run crossing local midnight writes to one directory and scores another.
- For an IST operator, **any run started between 00:00 and 05:30 IST is stamped with the previous day's date** — and `PHASES.md:93` explicitly instructs starting runs at night.

If the mismatched directory doesn't exist, this crashes (loud, fine). If a
previous run's directory *does* exist — the common case for a repeated
city/category — `score.js` silently scores **yesterday's `raw.csv`** and
overwrites yesterday's `leads.csv` with it. The operator gets a fresh-looking
report built from stale data.

---

### S2-9 · Header drift on resume

`src/utils.js:36` writes the header only when the file does not exist. Resuming
an interrupted run after `RAW_HEADERS` has changed appends rows in the new field
order under the old header. Every subsequent read silently mismaps every column.

---

### L-1 · `DETAIL.name` is built on a rotating class token

`selectors.js:51` — `h1:not([class*="fontTitleLarge"])` — a class-name
dependency, which `.agents/rules/10-selectors.md:21` bans outright. When that
token rotates, `waitForFunction` (`scraper.js:158`) times out at 15s per record.
Loud: every detail extraction throws and lands in `errors.log`. The run still
completes, `noPhone` (−25) drives everything to tier X, and the report says
"0 qualified leads" — visible, though the stated cause will be wrong.

---

### L-2 · Structural feed and card selectors

`FEED.card: 'div[role="feed"] > div > div[jsaction]'` is tier-5 structural by
the repo's own stability table. Breakage yields zero results, the
three-empty-query guard trips, and a screenshot is saved. This is the failure
mode the codebase handles *well*.

---

### L-3 · `closedBanner` is not valid CSS

`selectors.js:76` uses Playwright's `:has-text()` pseudo-class inside a value
destined for `document.querySelector`. Currently unreachable dead code —
`permanentlyClosed` is derived by regex instead — but wiring it up throws
`SyntaxError` immediately.

---

### L-4 · Interpolating a raw URL into a CSS attribute selector

`src/scraper.js:266` builds `a[href="${rec.mapsUrl}"]` from scraped input.
Place URLs contain `!`, `%`, `+`, `&`, and apostrophes (one record in the
committed run is `Dr. Annu's dental care`). A quote character produces an
invalid selector. Caught and logged per record — loud, bounded loss.

---

### L-5 · Consent-dismissal failure is misdiagnosed

`src/scraper.js:230` — `.catch(() => {})` on the consent click. If the banner
isn't dismissed the feed never renders, three empty queries follow, and the run
aborts with *"Likely soft-blocked or selectors broke"*. It stops, which is
correct, but sends the operator to `/verify-selectors` for a consent problem.

---

### Non-issues checked and cleared

- `--headless` flag parsing (`utils.js:11` → `'true'`) works as documented.
- `scrollFeed`'s `prev = -1` seed is correct; no off-by-one.
- The empty-`bool()` convention, while inconsistent, currently fails in the safe direction.
- Delay budgets in `scraper.js:24-25` match `AGENTS.md:84-88` exactly.

---

### Summary of the ranking

The top three are **not risks. They are active defects in committed output.**
Together they mean the current pipeline cannot produce a Tier A lead, cannot
detect a social-only listing, and writes street addresses into the category
column — while emitting a perfectly formatted report that states all of this as
if it were a finding about Indore's dentists.

That is the argument for the rewrite. The DOM approach's problem is not that it
breaks; it is that it breaks into plausible-looking data. Every S-band item
above is a place where a value was invented rather than extracted.

---

## 3. Keep / replace / delete

Nothing is executed here. This is the plan for the next phase.

### Keep unchanged

| Path | Why |
|---|---|
| `config/localities.json` | Pure knowledge base. Transport-independent, hand-curated, the thing that actually gets better over time. |
| `config/categories.json` | Same. |
| `.agents/rules/20-scoring.md` | Scoring rationale is independent of how fields are obtained. The weights survive the rewrite. |
| `src/report.js` | Reads `leads.csv`, writes Markdown. Untouched by the transport change. |
| `output/indore-dentist-20260804/` | Regression baseline. The "before" evidence for every S1 item above. Stays gitignored. |

### Keep with targeted changes

| Path | Change |
|---|---|
| `src/score.js` | Split the CID and phone dedupe sets (S2-5); unify the `bool()` / `=== 'false'` convention (S2-3); add a null-rate assertion so a constant `demandScore` fails loudly (S1-1). Weights unchanged. |
| `src/utils.js` | Keep `args`, `sleep`, `jitter`, `log`, `ensureDir`, `isSocialDomain`. Replace `readCsv` with a real parser (S2-4). Make `appendCsv` verify an existing header matches (S2-9). |
| `package.json` | Add a `test` script and the fixture-driven scripts. |
| `.gitignore` | Add a fixtures policy — payload fixtures may contain business PII and must not be committed casually. |

### Replace

| Path | Replaced by |
|---|---|
| `src/scraper.js` | Split three ways: browser capture (fixtures only), pure parsers, and orchestration. The current file mixes browser control, extraction, scoring inputs, and file I/O in one scope — which is why no part of it is testable offline. |
| `src/selectors.js` | `config/field-map.json`, with indices empirically derived from captured fixtures. A small selector set survives for capture-time concerns only (consent banner, feed scroll). |
| `AGENTS.md` | `CLAUDE.md` — Claude Code auto-loads that filename. Content is carried over and updated for the new architecture. |
| `.agents/rules/10-selectors.md` | Field-map documentation. Selector stability tiers stop being the governing concern. |
| `.agents/workflows/verify-selectors.md` | `.claude/agents/probe.md`. |
| `.agents/workflows/leads.md` | Rewritten for the capture → parse → score → report flow. |
| `.agents/rules/00-mission.md` | Folded into `CLAUDE.md`. The Hinglish and quota-economy rules are worth keeping; a separate always-on file is redundant once `CLAUDE.md` auto-loads. |
| `README.md` | Updated commands and output layout. |
| `prompts/PHASES.md` | Rewritten around the offline test loop. |

### Delete

| Path | Why |
|---|---|
| `SELECTOR-LOG.md` | An artifact of the DOM approach. Its successor is the field-map's provenance record. |
| `data/` | Empty, never referenced by any code. |
| `{.agents/` | Literal-brace directory from a failed shell brace expansion. Untracked litter. |

---

## 4. What the rewrite must guarantee that this design does not

Drawn directly from the S-band above. These are acceptance criteria, not aspirations.

1. **Every field has a measured null rate, checked every run.** S1-1 survived from the first commit because nothing ever asked "is this column always the same value?"
2. **Payload indices are recorded with the fixture they were derived from.** S2-1 exists because `websiteBtnFallbacks` was written as prose and never executed.
3. **"Not extracted" is a distinct state from "absent".** S2-3 makes a crashed record indistinguishable from a clean one.
4. **Parsers are pure and run offline against fixtures.** None of S1-1, S1-2, or S1-3 needs a browser to reproduce — yet none was reproducible without one, so none was caught.
5. **The rules files and the code are checked against each other.** `10-selectors.md:56` carried the correct regex the entire time. Documentation that cannot fail a test is decoration.
