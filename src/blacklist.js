/**
 * Blacklist management.
 *
 * The blacklist is what stops next month's run re-serving businesses the
 * operator has already phoned. Without it every run compounds the problem: the
 * same 40 Tier A leads surface every time and the genuinely new ones are buried.
 *
 *   npm run blacklist -- --run=<runId> --tier=A
 *       Append every cid from that tier to config/blacklist.json.
 *
 *   npm run blacklist -- --import=<path-to-edited-tier-a.csv>
 *       Read back a tier-a.csv the operator has annotated and blacklist every
 *       row with a non-empty `outcome`.
 *
 *   npm run blacklist -- --list
 *       Show what is currently blacklisted.
 *
 * Every entry records WHEN it was added, WHICH run it came from, and (on
 * import) the outcome the operator recorded — so a blacklist decision stays
 * auditable rather than becoming an opaque list of ids.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { args, readCsv, log } from './utils.js';

const BLACKLIST_FILE = path.join('config', 'blacklist.json');

/** Outcomes the operator may record in tier-a.csv. */
export const OUTCOMES = Object.freeze([
  'called', 'no-answer', 'not-interested', 'interested', 'closed',
]);

/**
 * Read the blacklist. Tolerates both shapes: a bare array of cids (the original
 * placeholder) and the richer { cids: [...] } object, so an operator who hand
 * edited the file does not lose entries.
 */
export function loadBlacklist(file = BLACKLIST_FILE) {
  if (!fs.existsSync(file)) return { entries: [], cids: new Set() };

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    // Never silently start from an empty blacklist — that would re-serve
    // everyone the operator has already called.
    throw new Error(
      `${file} is unreadable (${e.message}). Repair it before running; ` +
      'starting from an empty blacklist would re-serve already-contacted businesses.'
    );
  }

  const raw = Array.isArray(parsed) ? parsed : (parsed.entries ?? parsed.cids ?? []);
  const entries = raw.map((e) => (typeof e === 'string' ? { cid: e } : e)).filter((e) => e?.cid);
  return { entries, cids: new Set(entries.map((e) => e.cid)) };
}

export function saveBlacklist(entries, file = BLACKLIST_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = {
    _note:
      'Businesses already contacted. score.js excludes these cids from every ' +
      'future run. Managed by `npm run blacklist`.',
    updatedAt: new Date().toISOString(),
    count: entries.length,
    entries,
  };
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

/**
 * Add cids, skipping ones already present. Pure apart from the caller's I/O.
 * @returns {{entries: object[], added: number, skipped: number}}
 */
export function addToBlacklist(existing, additions) {
  const seen = new Set(existing.map((e) => e.cid));
  const entries = [...existing];
  let added = 0;
  let skipped = 0;

  for (const a of additions) {
    if (!a?.cid) { skipped += 1; continue; }
    if (seen.has(a.cid)) { skipped += 1; continue; }
    seen.add(a.cid);
    entries.push(a);
    added += 1;
  }
  return { entries, added, skipped };
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function fromRun(runId, tier) {
  const file = path.join('output', runId, tier === 'A' ? 'tier-a.csv' : 'leads.csv');
  if (!fs.existsSync(file)) {
    throw new Error(`${file} not found — run \`npm run score -- --run=${runId}\` first`);
  }
  const rows = readCsv(file).filter((r) => !tier || r.tier === tier);
  const at = new Date().toISOString();
  return rows
    .filter((r) => r.cid)
    .map((r) => ({
      cid: r.cid,
      name: r.name ?? null,
      phone: r.phone ?? null,
      tier: r.tier ?? null,
      sourceRun: runId,
      addedAt: at,
      reason: 'tier-export',
    }));
}

function fromImport(csvPath) {
  if (!fs.existsSync(csvPath)) throw new Error(`${csvPath} not found`);
  const rows = readCsv(csvPath);

  if (!Object.prototype.hasOwnProperty.call(rows[0] ?? {}, 'outcome')) {
    throw new Error(
      `${csvPath} has no "outcome" column. Export a tier-a.csv from a scored run ` +
      '— it ships with an empty outcome column ready for annotation.'
    );
  }

  const at = new Date().toISOString();
  const annotated = rows.filter((r) => (r.outcome ?? '').trim() !== '');
  const unknown = [...new Set(
    annotated.map((r) => r.outcome.trim()).filter((o) => !OUTCOMES.includes(o))
  )];

  if (unknown.length) {
    // Loud, not silent: a typo'd outcome would otherwise be blacklisted
    // anyway and the operator would never learn the value was wrong.
    log(`⚠ unrecognised outcome value(s): ${unknown.join(', ')}`);
    log(`  expected one of: ${OUTCOMES.join(' | ')} — importing them anyway`);
  }

  return annotated
    .filter((r) => r.cid)
    .map((r) => ({
      cid: r.cid,
      name: r.name ?? null,
      phone: r.phone ?? null,
      tier: r.tier ?? null,
      sourceRun: null,
      addedAt: at,
      reason: 'outcome-import',
      outcome: r.outcome.trim(),
    }));
}

function main() {
  const { entries: existing } = loadBlacklist();

  if (args.list === 'true') {
    log(`Blacklist: ${existing.length} cid(s)`);
    const byReason = existing.reduce((a, e) => ({ ...a, [e.reason ?? '?']: (a[e.reason ?? '?'] ?? 0) + 1 }), {});
    for (const [r, n] of Object.entries(byReason)) log(`  ${r}: ${n}`);
    return;
  }

  let additions;
  if (args.import) {
    additions = fromImport(args.import);
    log(`Import: ${additions.length} row(s) with a non-empty outcome in ${args.import}`);
  } else if (args.run) {
    const tier = (args.tier ?? 'A').toUpperCase();
    additions = fromRun(args.run, tier);
    log(`Run ${args.run}: ${additions.length} tier-${tier} record(s)`);
  } else {
    console.error('Usage: npm run blacklist -- --run=<runId> --tier=A');
    console.error('       npm run blacklist -- --import=<path-to-edited-tier-a.csv>');
    console.error('       npm run blacklist -- --list');
    process.exit(1);
  }

  const { entries, added, skipped } = addToBlacklist(existing, additions);
  saveBlacklist(entries);

  log(`Blacklisted ${added} new cid(s), skipped ${skipped} already present`);
  log(`Blacklist now holds ${entries.length} cid(s) → ${BLACKLIST_FILE}`);
  log('These are excluded from every future run at scoring time.');
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) main();
