/**
 * src/utils.js — process-level helpers and the ONE correct CSV implementation.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CSV CODE LIVES HERE
 * ---------------------------------------------------------------------------
 * REVIEW.md S2-4: the previous `readCsv` split the file on "\n" BEFORE parsing
 * quotes, while `csvCell` correctly quoted cells containing newlines. The
 * writer therefore produced valid CSV the reader could not read: one business
 * name with a line break shifted every later column of that row, and a phone
 * number landed in `area`. Nothing validated column types, so the row was
 * still scored, tiered and printed onto the call sheet.
 *
 * REVIEW.md S2-9: `appendCsv` wrote the header only when the file did not
 * exist, so resuming a run after the header changed appended rows in the new
 * order under the old header — silently mismapping every column.
 *
 * Both bugs are fixed at the source, in this file, because `src/score.js` and
 * `src/report.js` already import `readCsv` / `writeCsv` from here. Fixing them
 * in a new module would have left the broken reader in the pipeline. The
 * signatures other modules rely on — `args`, `sleep`, `jitter`, `log`,
 * `ensureDir`, `isSocialDomain`, `appendCsv(file, headers, row)`,
 * `writeCsv(file, headers, rows)`, `readCsv(file)` — are unchanged.
 *
 * ---------------------------------------------------------------------------
 * NULL IS NOT THE EMPTY STRING
 * ---------------------------------------------------------------------------
 * CLAUDE.md: "`null` is information; `0` and `''` are lies." So the encoding
 * distinguishes them and the round trip preserves the difference:
 *
 *   null / undefined  ->  an empty UNQUOTED cell   ->  read back as null
 *   ''  (real empty)  ->  an empty QUOTED cell ""  ->  read back as ''
 *   false             ->  false                    ->  read back as "false"
 *
 * A short read of a row (fewer cells than headers) is corruption, not a
 * missing value, and throws. That is the check whose absence let S2-4 ship.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SOCIAL_DOMAINS } from './selectors.js';

/** --key=value CLI args */
export const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, ...v] = a.replace(/^--/, '').split('=');
      return [k, v.length ? v.join('=') : 'true'];
    })
);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const jitter = (min, max) => Math.floor(min + Math.random() * (max - min));

export const log = (msg) => {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}] ${msg}`);
};

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/* ------------------------------------------------------------------ */
/* CSV encoding                                                        */
/* ------------------------------------------------------------------ */

const NEEDS_QUOTES = /["\r\n,]/;
const EDGE_SPACE = /^\s|\s$/;

/**
 * Encode one value as a CSV field.
 * Pure. Never substitutes a placeholder for a missing value.
 */
export function csvCell(v) {
  if (v === null || v === undefined) return '';       // unknown / absent
  if (v === '') return '""';                          // a real, empty string
  const s = String(v);
  return NEEDS_QUOTES.test(s) || EDGE_SPACE.test(s)
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

/** Encode one record (array of values) as a CSV line, without the newline. */
export function csvLine(values) {
  return values.map(csvCell).join(',');
}

function rowLine(headers, row) {
  return csvLine(headers.map((h) => row[h]));
}

/* ------------------------------------------------------------------ */
/* CSV decoding — a real state machine, quotes parsed before newlines  */
/* ------------------------------------------------------------------ */

/**
 * Parse CSV text into records. Handles quoted fields containing commas,
 * doubled quotes and embedded CR/LF. Blank lines are skipped.
 *
 * A cell is returned as `null` when it was empty and unquoted, and as `''`
 * when it was written as `""`. That is what keeps "we have no value" separate
 * from "the value is an empty string" across a round trip.
 *
 * @param {string} text
 * @returns {(string|null)[][]}
 * @throws on an unterminated quoted field, or on stray text after a closing
 *         quote — both mean the file is corrupt and must not be guessed at.
 */
export function parseCsvRecords(text) {
  if (typeof text !== 'string') {
    throw new TypeError(`parseCsvRecords: expected string, got ${typeof text}`);
  }
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM

  const records = [];
  let record = [];
  let field = '';
  let quoted = false;    // the current field was written with quotes
  let inQuotes = false;
  let dirty = false;     // current record has any content at all
  let line = 1;

  const endField = () => {
    record.push(quoted ? field : (field === '' ? null : field));
    field = '';
    quoted = false;
  };
  const endRecord = () => {
    if (!dirty && record.length === 0 && field === '' && !quoted) return; // blank line
    endField();
    records.push(record);
    record = [];
    dirty = false;
  };

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else {
        if (c === '\n') line += 1;
        field += c;
      }
      continue;
    }

    if (c === '"') {
      if (field !== '') {
        throw new Error(`CSV parse error on line ${line}: quote inside an unquoted field`);
      }
      inQuotes = true;
      quoted = true;
      dirty = true;
      continue;
    }
    if (c === ',') { endField(); dirty = true; continue; }
    if (c === '\r') {
      if (src[i + 1] === '\n') i += 1;
      endRecord();
      line += 1;
      continue;
    }
    if (c === '\n') { endRecord(); line += 1; continue; }

    field += c;
    dirty = true;
  }

  if (inQuotes) {
    throw new Error(`CSV parse error: unterminated quoted field starting before line ${line}`);
  }
  if (dirty || record.length > 0 || field !== '' || quoted) endRecord();

  return records;
}

/**
 * Read only as much of a file as is needed to recover its header record.
 * Used by appendCsv so header verification does not re-read a 50 MB CSV on
 * every single row.
 *
 * @returns {string[]|null} header cells, or null if the file is empty
 * @throws if the first record is not complete within `maxBytes`
 */
export function readCsvHeader(file, maxBytes = 65536) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buf, 0, maxBytes, 0);
    if (read === 0) return null;
    const chunk = buf.subarray(0, read).toString('utf8');

    const nl = findRecordEnd(chunk);
    if (nl === -1 && read === maxBytes) {
      throw new Error(
        `readCsvHeader: no complete header record in the first ${maxBytes} bytes of ${file}`
      );
    }
    const headerText = nl === -1 ? chunk : chunk.slice(0, nl);
    const records = parseCsvRecords(headerText);
    return records.length ? records[0].map((c) => (c === null ? '' : c)) : null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Index of the first record-terminating newline that is not inside quotes. */
function findRecordEnd(text) {
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') i += 1;
        else inQuotes = false;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === '\n' || c === '\r') return i;
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* CSV file I/O                                                        */
/* ------------------------------------------------------------------ */

/**
 * Append ONE row immediately. Never buffered to the end of a run — a run that
 * is killed at query 40 keeps the first 39 queries' rows.
 *
 * If the file already exists, its header is verified against `headers` and a
 * mismatch throws (REVIEW.md S2-9). Appending new columns under an old header
 * silently mismaps every column on resume, which is exactly the class of
 * failure this codebase exists to stop.
 */
export function appendCsv(file, headers, row) {
  assertHeaders(headers);
  ensureDir(path.dirname(file));

  const exists = fs.existsSync(file);
  const existingHeader = exists ? readCsvHeader(file) : null;

  if (existingHeader === null) {
    fs.writeFileSync(file, `${csvLine(headers)}\n`);
  } else if (
    existingHeader.length !== headers.length ||
    existingHeader.some((h, i) => h !== headers[i])
  ) {
    throw new Error(
      `CSV header mismatch in ${file}\n` +
      `  file expects: ${existingHeader.join(',')}\n` +
      `  code writes:  ${headers.join(',')}\n` +
      'Appending under a stale header silently mismaps every column on resume ' +
      '(REVIEW.md S2-9). Start a fresh run directory or migrate the file.'
    );
  }

  fs.appendFileSync(file, `${rowLine(headers, row)}\n`);
}

export function writeCsv(file, headers, rows) {
  assertHeaders(headers);
  ensureDir(path.dirname(file));
  const lines = [csvLine(headers), ...rows.map((r) => rowLine(headers, r))];
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

/**
 * Read a CSV file into row objects.
 *
 * @param {string} file
 * @param {{ emptyAs?: null|string }} [opts] value for an empty UNQUOTED cell.
 *        Defaults to `null` — the honest answer. Pass `emptyAs: ''` only if a
 *        caller genuinely cannot tell the difference and says so.
 * @throws if the header is malformed or any row's column count differs from
 *         the header's. A short row is corruption, not a missing value.
 */
export function readCsv(file, { emptyAs = null } = {}) {
  const records = parseCsvRecords(fs.readFileSync(file, 'utf8'));
  if (records.length === 0) return [];

  const headers = records[0].map((h, i) => {
    if (h === null || h === '') {
      throw new Error(`readCsv: ${file} has an empty header at column ${i}`);
    }
    return h;
  });

  return records.slice(1).map((cells, r) => {
    if (cells.length !== headers.length) {
      throw new Error(
        `readCsv: ${file} row ${r + 1} has ${cells.length} cells but the header has ` +
        `${headers.length}. The file is corrupt — refusing to guess which column is which.`
      );
    }
    const out = {};
    for (let i = 0; i < headers.length; i += 1) {
      out[headers[i]] = cells[i] === null ? emptyAs : cells[i];
    }
    return out;
  });
}

function assertHeaders(headers) {
  if (!Array.isArray(headers) || headers.length === 0) {
    throw new Error('CSV: headers must be a non-empty array');
  }
  for (const h of headers) {
    if (typeof h !== 'string' || h === '') {
      throw new Error(`CSV: header ${JSON.stringify(h)} must be a non-empty string`);
    }
  }
}

/* ------------------------------------------------------------------ */

export function isSocialDomain(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  return SOCIAL_DOMAINS.some((d) => u.includes(d));
}
