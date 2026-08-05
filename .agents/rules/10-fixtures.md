---
name: fixtures
activation: model_decision
description: Apply when changing extraction, field paths, or anything that reads a Google Maps payload.
---

# Fixture discipline

This replaces the old selector rules. There are no data selectors any more.
Fields come from **intercepted network payloads**, not from the DOM.

```
capture  →  fixtures/*.txt        (browser, rare, probe agent only)
discover →  config/field-map.json (offline, pattern matching)
parse    →  records               (pure functions, offline, unit tested)
score    →  leads.csv             (pure)
report   →  REPORT.md             (pure)
```

## The four rules

1. **Fixtures are the source of truth.** A captured payload on disk is the
   evidence. If a question can be answered from `fixtures/`, it must be —
   opening a browser to check something you could have grepped is the failure
   mode this design exists to remove.
2. **Field paths live in `config/field-map.json`. Nowhere else.** No literal
   payload index appears anywhere in `src/`. `src/parse.js` reads every index —
   container, element unwrap, all field paths — from that file.
3. **Iteration is offline.** `npm test` and `npm run pipeline -- --dry-run` run
   against fixtures in seconds with the network unplugged. That is the loop.
4. **The browser is only for capture.** `scripts/capture-fixtures.js`, run by
   the `probe` agent. Never to collect records, never to "just check" a value.

## Why — read this before you decide the rules are excessive

The predecessor scraped the DOM and did not crash. It produced well-formatted,
confidently wrong data for its entire lifetime: a constant demand score, street
addresses in the category column, and an entire lead class that could never be
detected. All three shipped in committed output and none was noticed.

None of those needed a browser to reproduce — yet none was reproducible without
one, so none was caught. `REVIEW.md` has the full audit.

## Response framings — there are two, always handle both

Detect by the body's **leading bytes**, never by filename or URL parameter.
(The heuristic "pagination URLs have no `q=`" is false — both carry it.)

| Framing | Body starts | Unwrap |
|---|---|---|
| initial | `)]}'` | strip `)]}'\n`, `JSON.parse` |
| pagination | `{"c":0,"d":"` | strip trailing `/*""*/`, parse envelope, take `.d`, strip `)]}'\n`, parse again |

**`reviewCount` exists only in pagination responses.** `rec[4]` has length 8 in
initial and 9 in pagination — 0/80 vs 68/73 across the corpus, zero
counterexamples. A run that reads only the initial response produces a constant
demand score and an unreachable Tier A, which is the original S1-1 defect by a
new route. The scraper must keep pagination responses.

## Fixtures must match the traffic shape of a live run

A fixture corpus is not just a sample of *payloads*. It is a sample of the
*traffic pattern* that produces them, and if the pattern differs the corpus
tests a different system than the one that ships.

The first capture took **one scroll per query**. A live run scrolls repeatedly
(`maxScrolls`, exiting after two idle scrolls), and Google re-sends earlier
records in later responses. The consequences were measurable:

| | fixtures v1 | live run |
|---|---|---|
| distinct cids | 137 | 342 |
| in **both** framings | 16 | 44 |
| **initial-only** | 64 (47%) | 16 (5%) |
| pagination-only | 57 | 282 |
| `reviewCount` null | 50.4% | 5.0% |

`reviewCount` exists only in pagination responses, so an initial-only record can
never carry one. With 47% of the corpus initial-only, `--dry-run` produced
Tier A = 0 while the identical code produced Tier A = 11 live.

**That is the failure mode to avoid: the regression harness could not detect a
Tier A regression, because Tier A was structurally zero in it.** A harness that
cannot fail on the bug you are trying to prevent is decoration.

So: **capture with the same scroll loop, the same `maxScrolls`, and the same
delays the live scraper uses.** When the scraper's traffic pattern changes, the
capture script changes with it, and the corpus is re-captured.

Superseded corpora are kept (`fixtures/raw-v1/`) rather than deleted, so a
"did this change behaviour or did the corpus change?" question stays answerable.

## Field map entries carry their own evidence

Every entry records `path`, `type`, `derivedFrom` (the fixture), `derivedOn`,
`sample`, `confidence`, `confirmedIn`, `nullRate`.

- An index without a recorded fixture is not allowed to exist. **If you cannot
  cite the fixture, you guessed.**
- A path that resolves in one fixture and not another is a bug in the path, not
  in the fixture.
- When a path stops matching, re-capture and re-run discovery. Do **not** patch
  the parser to compensate for a stale map.
- Below 0.7 confidence, the entry is marked `LOW — verify manually`. Do not
  silently pick a weak path to make the map look complete.

**This repo is public.** Fixtures are gitignored because they hold real business
names, phones and addresses. Sample values that would expose a phone or full
street address are redacted with `sampleRedacted: true`; the real value stays in
the local fixture named in `derivedFrom`.

## Known traps in the payload

These out-score real fields on naive heuristics. All are documented in the map.

| Node | What it actually is |
|---|---|
| `[37,…]` | mirrors the record shape but holds a **different, related** business (~56% coverage). Never a fallback. `[37,1]` alone is proven safe as `photoCount`; do not generalise. |
| `[25,18,…]` | UI chrome — "Favourites", "Want to go". Constants at 100% coverage. |
| `[88,4,…]` | image dimensions (607, 608, 1187). Looks like a photo count. |
| `[18]` | name-prefixed address. Contains the business name in 152/152 cases; `[39]` is the clean street address. |
| `[75,…]` | action links (WhatsApp, Instagram, booking). A superset that mixes chat links with the website; not a `website` fallback. |
| `[1]` | a per-response `ved` token. Looks like a stable id, distinct on every row — would silently break dedupe. |

## Null rates

Every run prints a per-field table. Enforce the >30% rule on
**`unresolvedRate`**, not `nullRate`:

- `nullRate` counts every blank cell, including genuine absence. `website` is
  ~59% blank because most small businesses have no website. That is data.
- `unresolvedRate` counts extraction *failures*, excluding genuine absence and
  framing omission. This is the number that means a bug.

A field at 100% null, or a numeric field with zero variance, fails the run.

## Any mapped field a scorer reads needs a CSV column

`RAW_HEADERS` in `src/run-state.js` must stay in step with `SIGNAL_REQUIRES` in
`src/score.js`. A field mapped in `field-map.json` but missing from
`RAW_HEADERS` is the worst case: `resolveWeights()` sees it as available and
stops rescaling, while `scoreRow()` never receives it and the signal silently
never fires. That combination once cost the whole of Tier A while the run
printed "Null rates: OK".
