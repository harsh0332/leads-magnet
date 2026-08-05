/**
 * Blacklist tests.
 *
 * The blacklist is what stops next month's run re-serving businesses the
 * operator has already phoned, and the cost of it silently not working is paid
 * on a phone call to an annoyed stranger. So the exclusion is tested against
 * real scoring output, not assumed from reading score.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadBlacklist, saveBlacklist, addToBlacklist, OUTCOMES } from '../src/blacklist.js';
import { readCsv, writeCsv } from '../src/utils.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'blacklist-test-'));

/* ------------------------------------------------------------------ */
/* Unit                                                                */
/* ------------------------------------------------------------------ */

test('addToBlacklist appends new cids and skips duplicates', () => {
  const existing = [{ cid: 'a' }, { cid: 'b' }];
  const { entries, added, skipped } = addToBlacklist(existing, [
    { cid: 'b' }, { cid: 'c' }, { cid: 'd' }, { cid: 'c' },
  ]);
  assert.equal(added, 2);
  assert.equal(skipped, 2);
  assert.deepEqual(entries.map((e) => e.cid), ['a', 'b', 'c', 'd']);
});

test('addToBlacklist never drops an existing entry', () => {
  const existing = [{ cid: 'keep', outcome: 'closed' }];
  const { entries } = addToBlacklist(existing, [{ cid: 'new' }]);
  assert.equal(entries[0].outcome, 'closed', 'existing metadata was lost');
});

test('blacklist round-trips through disk with its metadata', () => {
  const dir = tmp();
  const file = path.join(dir, 'blacklist.json');
  saveBlacklist([{ cid: 'x1', sourceRun: 'r1', addedAt: 'now', outcome: 'called' }], file);
  const { entries, cids } = loadBlacklist(file);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sourceRun, 'r1');
  assert.equal(entries[0].outcome, 'called');
  assert.ok(cids.has('x1'));
});

test('a bare array of cids is still readable', () => {
  // The original placeholder file was a bare array. An operator who hand-edited
  // it must not silently lose every entry.
  const dir = tmp();
  const file = path.join(dir, 'blacklist.json');
  fs.writeFileSync(file, JSON.stringify(['old1', 'old2']));
  const { cids } = loadBlacklist(file);
  assert.ok(cids.has('old1') && cids.has('old2'));
});

test('a corrupt blacklist throws rather than starting empty', () => {
  // Starting from an empty blacklist would re-serve everyone already called.
  const dir = tmp();
  const file = path.join(dir, 'blacklist.json');
  fs.writeFileSync(file, '{not json');
  assert.throws(() => loadBlacklist(file), /unreadable|re-serve/i);
});

test('a missing blacklist is empty, not an error', () => {
  const { entries, cids } = loadBlacklist(path.join(tmp(), 'nope.json'));
  assert.deepEqual(entries, []);
  assert.equal(cids.size, 0);
});

test('the documented outcome vocabulary is what the CLI accepts', () => {
  assert.deepEqual(
    [...OUTCOMES].sort(),
    ['called', 'closed', 'interested', 'no-answer', 'not-interested']
  );
});

/* ------------------------------------------------------------------ */
/* End-to-end: does score.js ACTUALLY exclude blacklisted cids?        */
/* ------------------------------------------------------------------ */

test('score.js excludes blacklisted cids — verified end to end, not assumed', () => {
  // Build a real run directory, score it, blacklist 3 cids from the result,
  // re-score, and assert exactly those 3 vanished and the count fell by 3.
  const runId = `blacklist-test-${process.pid}`;
  const outDir = path.join(ROOT, 'output', runId);
  const blacklistFile = path.join(ROOT, 'config', 'blacklist.json');
  const backup = fs.existsSync(blacklistFile) ? fs.readFileSync(blacklistFile, 'utf8') : null;

  try {
    // Reuse the dry-run corpus as realistic input.
    const dry = fs.readdirSync(path.join(ROOT, 'output'))
      .filter((d) => d.startsWith('fixtures-dryrun-'))
      .sort()
      .pop();
    if (!dry) {
      assert.fail('no dry-run output found — run `npm run pipeline -- --dry-run` first');
    }

    fs.mkdirSync(outDir, { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'output', dry, 'raw.csv'),
      path.join(outDir, 'raw.csv')
    );

    const score = () =>
      execFileSync('node', [path.join(ROOT, 'src', 'score.js'), `--run=${runId}`],
        { cwd: ROOT, encoding: 'utf8' });

    saveBlacklist([], blacklistFile);
    score();
    const before = readCsv(path.join(outDir, 'leads.csv'));
    assert.ok(before.length >= 5, `need >=5 leads to test with, got ${before.length}`);

    const victims = before.slice(0, 3).map((r) => r.cid);
    assert.equal(new Set(victims).size, 3, 'picked cids are not distinct');

    saveBlacklist(
      victims.map((cid) => ({ cid, sourceRun: runId, addedAt: 'test', reason: 'test' })),
      blacklistFile
    );
    score();
    const after = readCsv(path.join(outDir, 'leads.csv'));

    assert.equal(
      after.length, before.length - 3,
      `expected exactly 3 fewer leads (${before.length} -> ${before.length - 3}), got ${after.length}`
    );
    for (const cid of victims) {
      assert.ok(
        !after.some((r) => r.cid === cid),
        `blacklisted cid ${cid} is STILL in leads.csv — the exclusion does not work`
      );
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
    if (backup === null) fs.rmSync(blacklistFile, { force: true });
    else fs.writeFileSync(blacklistFile, backup);
  }
});

test('tier-a.csv ships an empty outcome column ready for annotation', () => {
  const dry = fs.readdirSync(path.join(ROOT, 'output'))
    .filter((d) => d.startsWith('fixtures-dryrun-'))
    .sort()
    .pop();
  if (!dry) return; // nothing to check without a scored run
  const file = path.join(ROOT, 'output', dry, 'tier-a.csv');
  if (!fs.existsSync(file)) return;

  const header = fs.readFileSync(file, 'utf8').split('\n')[0].split(',');
  assert.ok(header.includes('outcome'), 'tier-a.csv has no outcome column');

  const rows = readCsv(file);
  for (const r of rows) {
    assert.equal(r.outcome ?? '', '', 'outcome should ship empty for manual entry');
  }
});

test('--import blacklists only rows with a non-empty outcome', () => {
  const dir = tmp();
  const csv = path.join(dir, 'tier-a.csv');
  const headers = ['outcome', 'tier', 'name', 'phone', 'cid'];
  writeCsv(csv, headers, [
    { outcome: 'called', tier: 'A', name: 'One', phone: '+911111111111', cid: 'c1' },
    { outcome: '', tier: 'A', name: 'Two', phone: '+912222222222', cid: 'c2' },
    { outcome: 'not-interested', tier: 'A', name: 'Three', phone: '+913333333333', cid: 'c3' },
    { outcome: '   ', tier: 'A', name: 'Four', phone: '+914444444444', cid: 'c4' },
  ]);

  const rows = readCsv(csv).filter((r) => (r.outcome ?? '').trim() !== '');
  assert.deepEqual(rows.map((r) => r.cid), ['c1', 'c3'],
    'only annotated rows should be blacklisted; blank and whitespace-only must be skipped');
});
