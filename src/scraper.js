/**
 * Payload-interception scraper.
 *
 * Google Maps returns its search results as a deeply nested array payload. We
 * intercept that response and parse it offline against config/field-map.json.
 * NOTHING is read from the DOM — selectors exist only to scroll the feed and
 * dismiss consent.
 *
 * There is no detail-panel pass. Phone and website arrive in the list response,
 * which is why a run is now one page-load per query instead of one page-load
 * plus a click per candidate.
 *
 * IMPORTANT — why we must scroll even when we already have enough records:
 * reviewCount is absent from every "initial" payload (rec[4] has length 8) and
 * present in "pagination" payloads (length 9). Verified 0/80 vs 68/73 across
 * the fixture corpus. A run that reads only the first response produces a
 * constant demand score, which makes Tier A and Tier B mathematically
 * unreachable — REVIEW.md S1-1, the exact failure this rewrite exists to kill.
 *
 *   npm run scrape -- --city=Indore --category=dentist
 *   npm run scrape -- --city=Indore --category=dentist --limit=3
 *   npm run scrape -- --dry-run          # offline, against fixtures/raw
 */

import fs from 'fs';
import path from 'path';
import { URL_TEMPLATE, FEED, DATA_ENDPOINT_MARKER } from './selectors.js';
import { args, sleep, jitter, log } from './utils.js';
import { parseSearchResponseDetailed } from './parse.js';
import { buildQueries, areaFromQuery } from './query-matrix.js';
import {
  resolveRunId, openRun, appendRecord, loadProgress, saveProgress,
  logError, summarize, printSummary,
} from './run-state.js';

const CFG = {
  city: args.city,
  category: args.category,
  limit: args.limit ? Number(args.limit) : null,
  maxPlaces: Number(args.maxPlaces ?? 200),
  maxScrolls: Number(args.maxScrolls ?? 25),
  headless: args.headless === 'true',
  dryRun: args['dry-run'] === 'true' || args.dryRun === 'true',
  runId: args.run ?? null,

  // Anti-blocking budget. Do not reduce these. If a run is rate limited the
  // fix is longer delays or fewer queries — never a proxy, never a workaround.
  actionDelay: [1500, 3500],
  queryDelay: [10000, 20000],
  emptyStreakLimit: 3,
};

const FIXTURE_DIR = path.join('fixtures', 'raw');

/* ------------------------------------------------------------------ */
/* Shared record handling                                              */
/* ------------------------------------------------------------------ */

/**
 * Parse one intercepted body and append every unseen record immediately.
 * Returns counts. Pure except for the CSV append, which is the point.
 */
function ingestBody(body, { handle, query, area, seen, progress, collected }) {
  const { framing, records, skipped } = parseSearchResponseDetailed(body);

  let written = 0;
  let duplicates = 0;

  for (const place of records) {
    if (seen.has(place.cid)) { duplicates += 1; continue; }
    seen.add(place.cid);
    appendRecord(handle, place, { query, area, framing });
    collected?.push(place);
    written += 1;
  }

  progress.stats.records += records.length;
  progress.stats.written += written;
  progress.stats.duplicates += duplicates;

  return { framing, total: records.length, written, duplicates, skipped: skipped.length };
}

/* ------------------------------------------------------------------ */
/* Dry run — fixtures instead of the network                           */
/* ------------------------------------------------------------------ */

/**
 * Runs the identical parse -> append -> checkpoint path against captured
 * fixtures. No browser, no network, seconds not hours. This is the regression
 * harness for the whole pipeline: if a change breaks extraction, --dry-run
 * shows it without burning a live run or a quota.
 */
async function runDry(handle, progress, collected) {
  if (!fs.existsSync(FIXTURE_DIR)) {
    throw new Error(`--dry-run needs captured fixtures; ${FIXTURE_DIR} does not exist`);
  }

  let files = fs.readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.txt') && !f.endsWith('.url.txt'))
    .sort();

  if (!files.length) throw new Error(`--dry-run found no fixtures in ${FIXTURE_DIR}`);
  if (CFG.limit) files = files.slice(0, CFG.limit);

  const seen = new Set(progress.seenCids);
  log(`DRY RUN — ${files.length} fixtures, no browser, no network`);

  for (const file of files) {
    // The fixture's own captured URL is the honest "query" for this row.
    const sidecar = path.join(FIXTURE_DIR, file.replace(/\.txt$/, '.url.txt'));
    const query = fs.existsSync(sidecar)
      ? decodeURIComponent((fs.readFileSync(sidecar, 'utf8').match(/[?&]q=([^&]+)/) ?? [, file])[1] || file)
          .replace(/\+/g, ' ')
      : file;

    if (progress.done.includes(file)) { log(`  skip (done) ${file}`); continue; }

    try {
      const body = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
      const r = ingestBody(body, {
        handle, query, area: areaFromQuery(query, CFG.city ?? ''), seen, progress, collected,
      });
      log(`  ${file} [${r.framing}] ${r.total} records, ${r.written} new, ${r.duplicates} dupe`);
    } catch (e) {
      progress.stats.errors += 1;
      logError(handle, file, e);
      log(`  ✗ ${file} — ${e.message}`);
    }

    progress.done.push(file);
    progress.seenCids = [...seen];
    progress.stats.queries += 1;
    saveProgress(handle, progress);
  }
}

/* ------------------------------------------------------------------ */
/* Live run                                                            */
/* ------------------------------------------------------------------ */

/**
 * Scroll the feed, collecting intercepted payloads.
 *
 * `el.scrollTop = el.scrollHeight` is a SILENT NO-OP after the first call —
 * assigning a value the property already holds fires no scroll event, so
 * scrolls 2..N do nothing and no pagination request is made. Measured in
 * Phase 1. The nudge upward before each scroll is what makes the assignment a
 * real change.
 */
async function scrollAndCollect(page, bodies) {
  const feed = page.locator(FEED.container).first();
  if (!(await feed.count())) return;

  let lastCount = -1;
  let idle = 0;

  for (let i = 0; i < CFG.maxScrolls; i += 1) {
    await feed.evaluate((el) => {
      el.scrollTop = Math.max(0, el.scrollTop - 600);
      el.scrollTop = el.scrollHeight;
    }).catch(() => {});

    await sleep(jitter(...CFG.actionDelay));

    if (bodies.length === lastCount) {
      idle += 1;
      // Two consecutive scrolls with no new payload means the list is
      // exhausted. One is not enough — a slow batch looks identical.
      if (idle >= 2) break;
    } else {
      idle = 0;
      lastCount = bodies.length;
    }
  }
}

async function runLive(handle, progress, collected) {
  const { chromium } = await import('playwright');

  const queries = buildQueries({
    city: CFG.city, category: CFG.category, limit: CFG.limit,
  });

  const seen = new Set(progress.seenCids);
  log(`${queries.length} queries planned · ${progress.done.length} already done`);

  let browser;
  try {
    browser = await chromium.launch({ headless: CFG.headless });
    const ctx = await browser.newContext({
      locale: 'en-IN',
      viewport: { width: 1440, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    });
    const page = await ctx.newPage();

    let emptyStreak = 0;

    for (const query of queries) {
      if (progress.done.includes(query)) continue;

      const bodies = [];
      // Listener registered BEFORE navigation — the initial payload lands
      // ~2s into load and a listener attached afterwards misses it entirely.
      const onResponse = (res) => {
        if (!res.url().includes(DATA_ENDPOINT_MARKER)) return;
        bodies.push(
          res.text().then((t) => ({ ok: true, body: t })).catch((e) => ({ ok: false, err: e }))
        );
      };
      page.on('response', onResponse);

      try {
        await page.goto(URL_TEMPLATE(query), { waitUntil: 'domcontentloaded', timeout: 45000 });

        const consent = page.locator(FEED.consentAccept).first();
        if (await consent.count()) {
          await consent.click().catch(() => {});
          await sleep(jitter(...CFG.actionDelay));
        }

        await page.waitForSelector(FEED.container, { timeout: 20000 }).catch(() => {});
        await scrollAndCollect(page, bodies);

        const settled = await Promise.all(bodies);
        let queryRecords = 0;

        for (const r of settled) {
          if (!r.ok) { progress.stats.errors += 1; logError(handle, query, r.err); continue; }
          try {
            const out = ingestBody(r.body, {
              handle, query, area: areaFromQuery(query, CFG.city), seen, progress, collected,
            });
            queryRecords += out.total;
          } catch (e) {
            progress.stats.errors += 1;
            logError(handle, query, e);
          }
        }

        if (queryRecords === 0) {
          emptyStreak += 1;
          progress.stats.emptyQueries += 1;
          log(`  ⚠ 0 records — ${query} (streak ${emptyStreak})`);
          if (emptyStreak >= CFG.emptyStreakLimit) {
            await page.screenshot({ path: handle.blockEvidence, fullPage: true }).catch(() => {});
            throw new Error(
              `${CFG.emptyStreakLimit} consecutive queries returned zero records. ` +
              'Likely soft-blocked, or the payload shape changed. Stopping — not retrying. ' +
              `See ${handle.blockEvidence}. If it shows a normal results page, the field ` +
              'map is stale: re-capture fixtures and re-run discovery.'
            );
          }
        } else {
          emptyStreak = 0;
          log(`  ${query} → ${queryRecords} records, ${progress.stats.written} written so far`);
        }
      } catch (e) {
        if (/consecutive queries returned zero/.test(e.message)) {
          logError(handle, query, e);
          log(`\n✗ ${e.message}`);
          progress.done.push(query);
          progress.seenCids = [...seen];
          saveProgress(handle, progress);
          break;
        }
        progress.stats.errors += 1;
        logError(handle, query, e);
        log(`  ✗ ${query} — ${e.message}`);
      } finally {
        page.off('response', onResponse);
      }

      progress.done.push(query);
      progress.seenCids = [...seen];
      progress.stats.queries += 1;
      saveProgress(handle, progress);

      await sleep(jitter(...CFG.queryDelay));
    }
  } finally {
    // Closed on the error path too, not just the success path. The previous
    // implementation left chromium alive and the process never exited.
    if (browser) await browser.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Entry                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  if (!CFG.dryRun && (!CFG.city || !CFG.category)) {
    console.error('Usage: npm run scrape -- --city=Indore --category=dentist [--limit=N]');
    console.error('       npm run scrape -- --dry-run   (offline, against fixtures/raw)');
    process.exit(1);
  }

  const runId = CFG.runId ?? resolveRunId({
    city: CFG.city ?? 'fixtures',
    category: CFG.category ?? 'dryrun',
    now: new Date(),
  });

  const handle = openRun({ runId });
  const progress = loadProgress(handle);

  log(`Run ${runId}${CFG.dryRun ? ' (dry run)' : ''}`);

  const collected = [];
  if (CFG.dryRun) await runDry(handle, progress, collected);
  else await runLive(handle, progress, collected);

  saveProgress(handle, progress);

  // CLAUDE.md: every run prints a per-field null-rate table, and a field at
  // 100% null or a numeric field with zero variance fails the run.
  const summary = summarize(collected);
  const healthy = printSummary(summary);

  log('');
  log(`Records written: ${progress.stats.written} (${progress.stats.duplicates} duplicates skipped)`);
  log(`Queries: ${progress.stats.queries} · Errors: ${progress.stats.errors}`);
  log(`raw.csv → ${handle.rawCsv}`);
  log(`Next: npm run score -- --run=${runId}`);

  if (!healthy) {
    throw new Error(
      'Null-rate check FAILED (see table above). A field over 30% unresolved, or a ' +
      'numeric field with zero variance, means extraction is broken — not that the ' +
      'data is like that. Fix the field map before trusting this run.'
    );
  }

  return runId;
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(`\n${e.stack ?? e.message}`); process.exit(1); });
