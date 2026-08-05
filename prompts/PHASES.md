# Phase Prompts

The day-to-day is `/leads` and `/verify-fixtures`. These are the prompts for
setup, and for when something breaks.

Run Phase 0 → 2 once. After that you only use Phase 3 (`/leads`) and Phase 5
when Google changes its payload.

**The loop is offline.** Fields come from intercepted network payloads stored as
fixtures, not from the DOM. `npm test` and `npm run pipeline -- --dry-run` run
the whole pipeline against those fixtures in about a second, with the network
unplugged. A browser is opened only to capture fixtures.

---

## PHASE 0 — Environment setup

> Set up this project. Run `npm install`, then `npx playwright install chromium`.
> Verify Node is 20 or higher. Then run `npm test`.
> Report only pass/fail for each step — no explanation unless something failed.

Expected: `npm test` reports **42 tests, 38 pass, 4 fail**. The four failures are
known and documented in `/verify-fixtures` — they are miscalibrated assertions
about sparse localities and shared phone lines, not defects. A *different*
failure, or a different count, is a real regression.

---

## PHASE 1 — Offline verification (**do not skip this**)

> Run the `/verify-fixtures` workflow.
>
> Report the null-rate table and the tier counts. Flag any mapped field with an
> `unresolvedRate` over 30%, any field at 100% null, and any numeric field with
> zero variance.

This is the highest-value minute in the whole build, and it costs no browser and
no quota.

Read the two null columns correctly:

- `nullRate` counts every blank cell **including genuine absence**. `website`
  around 59% blank is normal — most small businesses have none.
- `unresolvedRate` counts extraction **failures**. This is the number the >30%
  rule applies to.

Confusing the two leads someone to "fix" a working path.

---

## PHASE 2 — Scoring sanity check

> Run `npm run pipeline -- --dry-run` and open the generated REPORT.md.
>
> Tell me: does the Tier A list look like businesses I'd actually want to call?
> Are any obviously large hospitals or chains that already have agencies? If so,
> propose an adjustment to the `likelyEnterprise` threshold in `src/score.js`
> and explain your reasoning **before** changing it.

Two things to check that are easy to miss:

- **Tier U** is records whose `reviewCount` was never observed. U existing is
  fine; U being most of the run means something upstream is dropping review
  counts. `reviewCount` lives only in *pagination* responses, so a run that
  didn't scroll enough produces a large U.
- **The rescale line.** If any gap signal has no field-map path the run prints
  what was dropped and the scale factor. A silently reweighted model is exactly
  as dangerous as a silently broken field.

The fixture corpus is not a representative sample of a live run — most of its
records appear in only one response framing, so its Tier U is much larger and
its Tier A much smaller than a real run's. Judge tier *shape* here; judge tier
*counts* on a live run.

---

## PHASE 3 — First real run

> Run the full pipeline for Indore dentists. This takes hours. Start it, confirm
> the first three queries return records, then stop monitoring and tell me it's
> running. I'll check back.
>
> If it stops early because of the consecutive-empty-query guard, don't restart
> it — tell me and we'll diagnose.

Start this at night. Laptop plugged in, sleep disabled (`caffeinate -i` on Mac,
or set Power to Never Sleep on Windows).

The run is resumable: progress is checkpointed after every query, so an
interrupted run continues rather than restarting.

---

## PHASE 4 — Daily use

This is all you do from here on:

```
/leads Indore dentist
/leads Bhopal ke interior designers
/leads Pithampur factory owners
/leads Guna dental clinic, only 50+ reviews
```

For a new city or category, the agent extends the config and tells you what it
added. Nothing else is needed.

---

## PHASE 5 — When it breaks

It will break. Google rotates its payload shape every few months. Symptoms and
prompts — **note that none of the first three needs a browser**:

**Everything returns zero records:**
> Run `/verify-fixtures` first. If the fixtures still parse cleanly, the payload
> shape has not changed and this is a live problem — check
> `output/<runId>/block-evidence.png` and tell me whether it shows a CAPTCHA or
> a normal results page. A CAPTCHA is a rate problem, and the fix is longer
> delays or fewer queries, never a proxy.

**A field is suddenly null on most records:**
> Run `npm run pipeline -- --dry-run` and report the null-rate table. If the
> fixtures parse fine but a live run does not, the payload changed and the
> fixtures are stale — that needs a re-capture, not a parser patch.

**Tier A is 0 or Tier U is most of the run:**
> Check `reviewCount` coverage first. It is emitted only by *pagination*
> responses, so a run that failed to scroll produces a constant demand axis and
> an unreachable Tier A. That is REVIEW.md S1-1 and it is the single most
> important failure mode in this codebase — it produces a clean, confident,
> completely wrong report.

**A field path genuinely stopped resolving:**
> Only now is a browser justified, and only via the `probe` agent:
> 1. `probe` captures fresh fixtures
> 2. `discover` re-derives `config/field-map.json` from them
> 3. re-run `/verify-fixtures`
>
> Never patch `src/parse.js` to compensate for a stale map, and never hardcode a
> payload index anywhere in `src/`.

---

## PHASE 6 — Extensions worth building later

Only after the base pipeline has produced real clients. In rough priority order:

1. **Blacklist wiring** — `config/blacklist.json` exists and `score.js` already
   excludes its cids, but nothing populates it. Feeding called leads back in is
   what stops next month's run re-serving people you already phoned. Essential
   by month two.
2. **Call outcome tracking** — a `status` column you update by hand, fed back so
   scoring learns which gap combinations actually convert.
3. **Dead-website detection** — a business with a dead or parked site is a
   stronger lead than one with no site: they already paid for a website once, so
   budget exists. Must be opt-in and separate from `npm run pipeline`, because
   it makes outbound requests to third-party servers.
4. **Scheduled re-runs** — cron monthly to catch newly opened businesses, which
   are the warmest leads of all.

Do not build any of these until the base has closed at least one client.
