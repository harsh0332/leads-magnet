/**
 * Run bookkeeping: run ids, output directory, incremental CSV, checkpointing,
 * error log, and the per-field null-rate summary.
 *
 * No browser, no network, no parsing. The scraper owns the browser; parse.js
 * owns extraction; this module owns "what survives a kill -9".
 */

import fs from 'fs';
import path from 'path';
import { appendCsv, ensureDir, log } from './utils.js';
import { nullRateTable, PLACE_FIELDS } from './parse.js';

/* ------------------------------------------------------------------ */
/* Run id                                                              */
/* ------------------------------------------------------------------ */

/**
 * `<city>-<category>-<YYYYMMDD>`, lowercased, whitespace collapsed to '-'.
 *
 * The date comes from LOCAL components, never `toISOString()`. REVIEW.md S2-8:
 * `toISOString()` is UTC, so for an IST operator every run started between
 * 00:00 and 05:30 IST was stamped with the PREVIOUS day's date — and
 * prompts/PHASES.md tells the operator to start runs at night. When the stale
 * directory happened to exist, the scorer silently rescored yesterday's raw.csv
 * and overwrote yesterday's leads.csv with it.
 *
 * `now` is injected so this is testable and so the caller computes it ONCE and
 * passes the result down. Never recompute a runId in a second process.
 *
 * @param {{ city: string, category: string, now?: Date }} opts
 */
export function resolveRunId({ city, category, now = new Date() }) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${city}-${category}-${y}${m}${d}`
    .toLowerCase()
    .replace(/\s+/g, '-');
}

/* ------------------------------------------------------------------ */
/* Output directory                                                    */
/* ------------------------------------------------------------------ */

/**
 * @param {{ runId: string, outDir?: string }} opts
 * @returns {{ runId, dir, rawCsv, progressJson, errorsLog, blockEvidence }}
 */
export function openRun({ runId, outDir = 'output' }) {
  const dir = path.join(outDir, runId);
  ensureDir(dir);
  return {
    runId,
    dir,
    rawCsv: path.join(dir, 'raw.csv'),
    progressJson: path.join(dir, 'progress.json'),
    errorsLog: path.join(dir, 'errors.log'),
    blockEvidence: path.join(dir, 'block-evidence.png'),
  };
}

/* ------------------------------------------------------------------ */
/* raw.csv                                                             */
/* ------------------------------------------------------------------ */

/**
 * Column order for raw.csv.
 *
 * Representation rules, which the scorer depends on:
 *   - a value            -> the value
 *   - null / unknown     -> EMPTY cell (readCsv returns null, not '')
 *   - genuine false      -> the literal "false"
 *   - unmapped field     -> EMPTY cell, AND named in `unmappedFields`
 *
 * That last column is what keeps "we never looked" distinguishable from "the
 * business has none" once the data is on disk. isUnclaimed and
 * permanentlyClosed have no path in config/field-map.json yet, so they are
 * blank on every row and listed there. Writing `false` for them would be a lie
 * the scorer would act on.
 */
export const RAW_HEADERS = Object.freeze([
  'query', 'framing', 'cid', 'placeId', 'name', 'category',
  'rating', 'reviewCount', 'phone', 'website', 'hasWebsite', 'isSocialOnly',
  'address', 'area', 'lat', 'lng',
  'isUnclaimed', 'permanentlyClosed', 'unmappedFields',
]);

/** Fields whose value came from the caller, not the payload. */
const CALLER_SUPPLIED = new Set(['query', 'framing', 'area']);

/**
 * Map a Place + caller context to a raw.csv row. Pure.
 *
 * @param {object} place  a Place from parse.js
 * @param {{ query: string, area?: string|null, framing?: string|null }} extra
 */
export function toRawRow(place, extra = {}) {
  const meta = place?._meta ?? {};
  const unmapped = Array.isArray(meta.unmapped) ? meta.unmapped.slice() : [];

  const row = {
    query: extra.query ?? null,
    framing: extra.framing ?? meta.framing ?? null,
    area: extra.area ?? null,
  };

  for (const key of RAW_HEADERS) {
    if (CALLER_SUPPLIED.has(key) || key === 'unmappedFields') continue;
    row[key] = place[key] === undefined ? null : place[key];
  }

  // `area` is caller-supplied; if it is unmapped in the payload AND the caller
  // gave us one, it is no longer unknown — drop it from the unmapped list so
  // the row does not claim ignorance it does not have.
  row.unmappedFields =
    (row.area !== null ? unmapped.filter((k) => k !== 'area') : unmapped).join('|') || null;

  return row;
}

/**
 * Append ONE record immediately. Never buffered — a run killed at query 40
 * keeps the first 39 queries' rows. Header mismatch throws (see utils.js).
 */
export function appendRecord(handle, place, extra = {}) {
  appendCsv(handle.rawCsv, RAW_HEADERS, toRawRow(place, extra));
}

/* ------------------------------------------------------------------ */
/* progress.json                                                       */
/* ------------------------------------------------------------------ */

export function emptyProgress() {
  return {
    done: [],
    seenCids: [],
    stats: { queries: 0, records: 0, written: 0, duplicates: 0, errors: 0, emptyQueries: 0 },
  };
}

export function loadProgress(handle) {
  if (!fs.existsSync(handle.progressJson)) return emptyProgress();
  try {
    const parsed = JSON.parse(fs.readFileSync(handle.progressJson, 'utf8'));
    return { ...emptyProgress(), ...parsed, stats: { ...emptyProgress().stats, ...(parsed.stats ?? {}) } };
  } catch (e) {
    // A corrupt checkpoint must not silently restart the run from zero and
    // re-scrape everything — that looks like success and costs hours.
    throw new Error(
      `progress.json in ${handle.dir} is unreadable (${e.message}). ` +
      'Delete it to restart this run from scratch, or repair it to resume.'
    );
  }
}

export function saveProgress(handle, progress) {
  fs.writeFileSync(handle.progressJson, `${JSON.stringify(progress, null, 2)}\n`);
}

/* ------------------------------------------------------------------ */
/* errors.log                                                          */
/* ------------------------------------------------------------------ */

export function logError(handle, query, err) {
  const msg = err?.stack ?? err?.message ?? String(err);
  fs.appendFileSync(handle.errorsLog, `[query] ${query} :: ${msg}\n\n`);
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

const NULL_RATE_LIMIT = 0.3;

/**
 * Per-field table plus the checks CLAUDE.md requires every run to print.
 *
 * The >30% rule is enforced on `unresolvedRate`, NOT `nullRate`. `nullRate`
 * counts genuine absence too — website is blank on ~59% of real Indian
 * listings because those businesses have no website, which is the entire
 * product. Enforcing on nullRate would fail every run and train the operator
 * to ignore the check. `unresolvedRate` excludes genuine absence and
 * framing-omitted fields, so it only fires on real extraction failure.
 *
 * Unmapped fields are reported separately: they are outstanding work for
 * `discover`, not a parser defect, but they must stay visible.
 */
export function summarize(places) {
  const table = nullRateTable(places);
  const total = places.length;

  const rows = [];
  const failures = [];
  const unmappedFields = [];

  for (const key of PLACE_FIELDS) {
    const r = table[key];
    if (!r || r.total === 0) continue;

    if (r.unmapped === r.total && r.total > 0) {
      unmappedFields.push(key);
      rows.push({ field: key, coverage: 0, nullRate: 1, unresolvedRate: 1, note: 'UNMAPPED' });
      continue;
    }

    const coverage = r.ok / r.total;
    rows.push({
      field: key,
      coverage,
      nullRate: r.nullRate,
      unresolvedRate: r.unresolvedRate,
      note: r.framingOmitted > 0 ? `${r.framingOmitted} framing-omitted` : '',
    });

    if (r.unresolvedRate > NULL_RATE_LIMIT) {
      failures.push(`${key}: ${(r.unresolvedRate * 100).toFixed(1)}% unresolved`);
    }
  }

  // A numeric field with zero variance is the S1-1 signature: reviewCount was
  // a constant null for the life of the predecessor, which made demandScore
  // constant, which made Tier A unreachable, and every report looked fine.
  const constants = [];
  for (const key of ['rating', 'reviewCount', 'lat', 'lng']) {
    const vals = places.map((p) => p[key]).filter((v) => v !== null && v !== undefined);
    if (vals.length > 1 && new Set(vals).size === 1) {
      constants.push(`${key} is constant at ${vals[0]} across ${vals.length} records`);
    }
  }

  return { total, rows, failures, constants, unmappedFields, limit: NULL_RATE_LIMIT };
}

/** Print the summary table. Returns true if the run passes its own checks. */
export function printSummary(summary) {
  log('');
  log('Null rates (unresolved = extraction failure; blanks from genuine absence are fine)');
  log('  field                coverage   null%   unresolved%  note');
  for (const r of summary.rows) {
    log(
      `  ${r.field.padEnd(20)} ${(r.coverage * 100).toFixed(1).padStart(6)}%  ` +
      `${(r.nullRate * 100).toFixed(1).padStart(6)}%  ` +
      `${(r.unresolvedRate * 100).toFixed(1).padStart(9)}%   ${r.note}`
    );
  }

  if (summary.unmappedFields.length) {
    log(`  unmapped (work for discover): ${summary.unmappedFields.join(', ')}`);
  }

  const ok = summary.failures.length === 0 && summary.constants.length === 0;
  if (summary.failures.length) {
    log('');
    for (const f of summary.failures) log(`  FAIL  ${f} — over the ${summary.limit * 100}% limit`);
  }
  for (const c of summary.constants) log(`  FAIL  ${c}`);
  if (ok) log('  Null rates: OK (all mapped fields under 30% unresolved)');
  return ok;
}
