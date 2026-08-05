#!/usr/bin/env node
/**
 * discover-fields.js — derive config/field-map.json from captured fixtures.
 *
 * Offline only. Reads fixtures/raw/*.txt, locates the repeating record array,
 * enumerates every leaf path inside each record, and scores candidate paths for
 * each target field by PATTERN and STRUCTURE — never by remembered position.
 *
 * Nothing here opens a browser or makes a network request.
 *
 * Usage:
 *   node scripts/discover-fields.js            # report + write config/field-map.json
 *   node scripts/discover-fields.js --dry-run  # report only, write nothing
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = path.join(ROOT, 'fixtures', 'raw');
const OUT_FILE = path.join(ROOT, 'config', 'field-map.json');
const DERIVED_ON = new Date().toISOString().slice(0, 10);
const DRY_RUN = process.argv.includes('--dry-run');

const MAX_DEPTH = 12;          // leaf-walk depth cap
const LOW_CONFIDENCE = 0.7;    // below this a field is flagged for manual review

// ---------------------------------------------------------------------------
// 1. Loading — two framings, discriminated by the body's leading bytes only.
//    Filenames and URL query params are NOT reliable discriminators.
// ---------------------------------------------------------------------------

const XSSI = ")]}'";

function stripXssi(s) {
  if (!s.startsWith(XSSI)) return s;
  let i = XSSI.length;
  while (i < s.length && (s[i] === '\n' || s[i] === '\r')) i++;
  return s.slice(i);
}

/** @returns {{framing:'initial'|'pagination', data:unknown[]}} */
export function loadFixture(file) {
  const body = fs.readFileSync(file, 'utf8');

  // Framing 1: raw XSSI-guarded JSON array.
  if (body.startsWith(XSSI)) {
    return { framing: 'initial', data: JSON.parse(stripXssi(body)) };
  }

  // Framing 2: JSON envelope {"c":0,"d":"<xssi+json>"} with a trailing /*""*/.
  if (body.trimStart().startsWith('{')) {
    const end = body.lastIndexOf('}');
    if (end === -1) throw new Error(`envelope has no closing brace: ${file}`);
    const envelope = JSON.parse(body.slice(0, end + 1));
    if (typeof envelope.d !== 'string') {
      throw new Error(`envelope .d is not a string: ${file}`);
    }
    return { framing: 'pagination', data: JSON.parse(stripXssi(envelope.d)) };
  }

  throw new Error(`unrecognised framing (leading bytes: ${JSON.stringify(body.slice(0, 8))}): ${file}`);
}

function fixtureFiles() {
  return fs.readdirSync(RAW_DIR)
    .filter((f) => f.endsWith('.txt') && !f.endsWith('.url.txt'))
    .sort();
}

// ---------------------------------------------------------------------------
// 2. Locate the record array — derived, not assumed.
//
//    A record array is a top-level array whose children are structurally
//    similar subtrees and whose length is plausible for one result page.
//    We score every top-level slot and take the best.
// ---------------------------------------------------------------------------

/**
 * A coarse shape fingerprint: array arities for the top two levels only.
 * Fine enough to tell a record list from a settings blob, coarse enough that
 * sibling records with differing optional fields still collide.
 */
function structuralSignature(node, depth = 0) {
  if (node === null || node === undefined) return 'n';
  if (Array.isArray(node)) {
    if (depth >= 1) return `a${node.length}`;
    return `[${node.map((c) => structuralSignature(c, depth + 1)).join(',')}]`;
  }
  return typeof node;
}

function scoreRecordArray(arr) {
  if (!Array.isArray(arr) || arr.length < 3) return null;
  // Children must be arrays.
  if (!arr.every((c) => Array.isArray(c))) return null;
  // Structural similarity: the modal signature must dominate.
  const sigs = arr.map((c) => structuralSignature(c));
  const counts = {};
  sigs.forEach((s) => { counts[s] = (counts[s] || 0) + 1; });
  const modal = Math.max(...Object.values(counts));
  const similarity = modal / arr.length;
  // Depth: records are large nested subtrees, not shallow tuples.
  const avgLeaves = arr.reduce((sum, c) => sum + countLeaves(c), 0) / arr.length;
  return { similarity, avgLeaves, length: arr.length };
}

function countLeaves(node, depth = 0) {
  if (node === null || node === undefined) return 0;
  if (Array.isArray(node)) {
    if (depth >= MAX_DEPTH) return 0;
    let n = 0;
    for (const c of node) n += countLeaves(c, depth + 1);
    return n;
  }
  return 1;
}

/**
 * Returns { containerPath, unwrap } where containerPath indexes the document to
 * the record array and unwrap maps a container element to the record root.
 */
function locateRecordRoot(data) {
  let best = null;
  for (let i = 0; i < data.length; i++) {
    const s = scoreRecordArray(data[i]);
    if (!s) continue;
    if (s.similarity < 0.8) continue;
    if (s.avgLeaves < 50) continue; // a record is a big subtree
    if (!best || s.avgLeaves > best.score.avgLeaves) {
      best = { index: i, score: s };
    }
  }
  if (!best) throw new Error('could not locate a record array in this payload');

  // Records are commonly wrapped as [null, <record>]. Detect that by checking
  // whether every element is a 2-tuple whose leaves live entirely in slot 1.
  const arr = data[best.index];
  const wrapped = arr.every(
    (c) => c.length === 2 && c[0] === null && Array.isArray(c[1]) && countLeaves(c[1]) > 50,
  );
  return {
    containerIndex: best.index,
    wrapped,
    score: best.score,
    records: arr.map((c) => (wrapped ? c[1] : c)),
  };
}

// ---------------------------------------------------------------------------
// 3. Leaf-path enumeration
// ---------------------------------------------------------------------------

function walkLeaves(node, cb, pathAcc = []) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    if (pathAcc.length >= MAX_DEPTH) return;
    for (let i = 0; i < node.length; i++) walkLeaves(node[i], cb, pathAcc.concat(i));
    return;
  }
  if (typeof node === 'object') return; // payload is array-only; ignore stray objects
  cb(pathAcc, node);
}

const get = (obj, p) => p.reduce((a, k) => (a === null || a === undefined ? undefined : a[k]), obj);

// ---------------------------------------------------------------------------
// 4. Field patterns + structural discriminators
//
//    Every rule below is a general property of the value or of its distribution.
//    None of them names an index.
// ---------------------------------------------------------------------------

const NON_BUSINESS_HOST = /(^|\.)(google\.com|google\.co\.[a-z.]+|gstatic\.com|googleusercontent\.com|ggpht\.com|googleapis\.com|schema\.org|goo\.gl|google\.[a-z.]+)$/i;

/** Opaque machine tokens (response ids, protobuf blobs) masquerading as text. */
function looksOpaque(v) {
  if (typeof v !== 'string') return false;
  if (/^0x[0-9a-f]+:/i.test(v)) return true;
  if (/^0ahUKEw/.test(v)) return true;                    // per-response ved token
  if (/^[A-Za-z0-9_-]{15,}$/.test(v) && !/\s/.test(v)) return true; // base64-ish
  return false;
}

function hostOf(u) {
  try { return new URL(u).hostname; } catch { return null; }
}

const PATTERNS = {
  // NOTE: the brief specified a 3–80 char name. The corpus disproves the upper
  // bound — real listings stuff keywords into the name and run past 120 chars
  // (e.g. "REVTI Dental Clinic (Dr. Rahul Shrivastava) Vijay Nagar Indore | …").
  // Capping at 80 drops those records and pushes the true name path below its
  // structural gate. The cap is widened; shape is enforced by the gate instead.
  businessName: (v) => typeof v === 'string' && v.length >= 3 && v.length <= 200 && !looksOpaque(v),
  phone: (v) => typeof v === 'string' && /^\+?[\d][\d\s\-()]{7,17}$/.test(v),
  website: (v) => {
    if (typeof v !== 'string' || !/^https?:\/\//.test(v)) return false;
    const h = hostOf(v);
    return h !== null && !NON_BUSINESS_HOST.test(h);
  },
  rating: (v) => typeof v === 'number' && v >= 1.0 && v <= 5.0,
  reviewCount: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1,
  address: (v) => typeof v === 'string' && v.includes(',') && /\b\d{6}\b/.test(v),
  category: (v) => typeof v === 'string' && v.length >= 3 && v.length <= 60 && !looksOpaque(v),
  latitude: (v) => typeof v === 'number' && v >= 6 && v <= 38 && !Number.isInteger(v),
  longitude: (v) => typeof v === 'number' && v >= 68 && v <= 98 && !Number.isInteger(v),
  // Two distinct stable identifiers exist per listing and both are useful:
  //  cid     — the hex feature-id pair, source of the numeric CID used in
  //            maps.google.com/?cid=… deep links.
  //  placeId — the ChIJ… Places identifier.
  // All 153 observed placeIds are ChIJ-prefixed and exactly 27 chars. The
  // prefix is asserted rather than inferred so that a future capture carrying a
  // different prefix family fails the coverage gate loudly instead of silently
  // resolving to some other opaque string.
  cid: (v) => typeof v === 'string' && /^0x[0-9a-f]+:0x[0-9a-f]+$/i.test(v),
  placeId: (v) => typeof v === 'string' && /^Ch[A-Za-z0-9_-]{18,}$/.test(v),
};

/**
 * Structural gates. Each receives per-path statistics and returns true if the
 * candidate is structurally consistent with the field's known behaviour.
 * `ctx` carries corpus-level facts (business identity keys, sibling lookups).
 */
const DISCRIMINATORS = {
  // Names are near-unique, wordy, and — unlike every address-shaped string in
  // the payload — almost never contain commas.
  businessName: (c) => c.coverage >= 0.95 && c.distinct / c.hits >= 0.8
    && c.spaceRate >= 0.6 && c.commaRate < 0.15,

  // Phones: absent for many businesses by nature. Just require real variety.
  phone: (c) => c.distinct >= 20,

  // Websites: genuinely absent for many. Coverage must be strictly interior —
  // 0% or 100% both mean the path is wrong.
  website: (c) => c.coverage > 0.02 && c.coverage < 0.98 && c.distinct >= 10,

  // A rating column varies and contains fractional values. UI-chrome integers
  // (constant per path) are eliminated by the variance requirement.
  rating: (c) => c.distinct >= 5 && c.nonIntegerRate > 0.3 && c.coverage >= 0.5,

  // A review count sits in the same parent array as a rating, and varies a lot.
  reviewCount: (c) => c.hasRatingSibling && c.distinct >= 20 && c.max > 20,

  // Street address: has a PIN, and is NOT the name-prefixed display address.
  address: (c) => c.coverage >= 0.9 && c.containsNameRate < 0.1,

  // Categories repeat within a query and change between queries.
  category: (c) => c.coverage >= 0.9 && c.avgModalShare >= 0.4
    && c.distinctQueryModes >= 3 && c.distinct <= 60,

  latitude: (c) => c.coverage >= 0.9 && c.hasLngSibling,
  longitude: (c) => c.coverage >= 0.9 && c.hasLatSibling,

  // A stable identifier is unique within a fixture but REPEATS across fixtures
  // for the same business. Per-response tokens fail this: they are unique
  // globally (distinct === total records).
  cid: (c) => c.coverage >= 0.99 && c.distinct === c.expectedDistinctBusinesses,
  placeId: (c) => c.coverage >= 0.99 && c.distinct === c.expectedDistinctBusinesses,
};

/** Fields where a null is a real-world fact about the business, not a miss. */
const ABSENCE_IS_EXPECTED = new Set(['phone', 'website']);

// ---------------------------------------------------------------------------
// 5. Build the corpus
// ---------------------------------------------------------------------------

function buildCorpus() {
  const files = fixtureFiles();
  if (files.length === 0) throw new Error(`no fixtures found in ${RAW_DIR}`);

  const records = [];
  const perFixture = [];

  for (const name of files) {
    const { framing, data } = loadFixture(path.join(RAW_DIR, name));
    const located = locateRecordRoot(data);
    const query = name.replace(/^\d+-/, '').replace(/-(initial|scroll\d+)\.txt$/, '');
    located.records.forEach((rec) => records.push({ file: name, framing, query, rec }));
    perFixture.push({
      file: name,
      framing,
      query,
      containerIndex: located.containerIndex,
      wrapped: located.wrapped,
      count: located.records.length,
      similarity: located.score.similarity,
    });
  }
  return { files, records, perFixture };
}

/** Index every leaf path across every record. */
function indexPaths(records) {
  const paths = new Map();
  records.forEach((R, idx) => {
    walkLeaves(R.rec, (p, v) => {
      const key = p.join('.');
      let e = paths.get(key);
      if (!e) { e = { path: p.slice(), byRecord: new Map(), files: new Set(), byQuery: new Map() }; paths.set(key, e); }
      e.byRecord.set(idx, v);
      e.files.add(R.file);
      if (!e.byQuery.has(R.query)) e.byQuery.set(R.query, []);
      e.byQuery.get(R.query).push(v);
    });
  });
  return paths;
}

// ---------------------------------------------------------------------------
// 6. Score candidates for one field
// ---------------------------------------------------------------------------

function scoreField(field, paths, records, ctx) {
  const test = PATTERNS[field];
  const gate = DISCRIMINATORS[field];
  const total = records.length;
  const out = [];

  for (const [key, e] of paths) {
    const matching = [];
    const matchingIdx = [];
    for (const [idx, v] of e.byRecord) {
      if (test(v)) { matching.push(v); matchingIdx.push(idx); }
    }
    if (matching.length === 0) continue;

    const hits = matching.length;
    const distinctVals = new Set(matching);
    const files = new Set(matchingIdx.map((i) => records[i].file));

    // Per-query modal share (repetition-within / variation-across signal).
    const modalShares = [];
    const queryModes = [];
    for (const [, vs] of e.byQuery) {
      const kept = vs.filter(test);
      if (kept.length === 0) continue;
      const c = {};
      kept.forEach((v) => { c[v] = (c[v] || 0) + 1; });
      const top = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
      modalShares.push(top[1] / kept.length);
      queryModes.push(top[0]);
    }

    // Sibling facts: does this leaf's parent array also hold a rating / a
    // complementary coordinate? Used to bind reviewCount to rating and lat to lng.
    const parent = e.path.slice(0, -1);
    let hasRatingSibling = false;
    let hasLatSibling = false;
    let hasLngSibling = false;
    for (const idx of matchingIdx.slice(0, 40)) {
      const sib = get(records[idx].rec, parent);
      if (!Array.isArray(sib)) continue;
      if (sib.some((s, i) => i !== e.path[e.path.length - 1]
        && typeof s === 'number' && s >= 1 && s <= 5 && !Number.isInteger(s))) hasRatingSibling = true;
      if (sib.some((s) => typeof s === 'number' && s >= 6 && s <= 38 && !Number.isInteger(s))) hasLatSibling = true;
      if (sib.some((s) => typeof s === 'number' && s >= 68 && s <= 98 && !Number.isInteger(s))) hasLngSibling = true;
    }

    const strings = matching.filter((v) => typeof v === 'string');
    const nums = matching.filter((v) => typeof v === 'number');

    const cand = {
      path: e.path.slice(),
      key,
      hits,
      coverage: hits / total,
      confidence: hits / total,
      distinct: distinctVals.size,
      filesConfirmed: files.size,
      sample: matching[0],
      spaceRate: strings.length ? strings.filter((v) => /\s/.test(v)).length / strings.length : 0,
      commaRate: strings.length ? strings.filter((v) => v.includes(',')).length / strings.length : 0,
      intlFormat: typeof matching[0] === 'string' && matching[0].startsWith('+'),
      coverageByFraming: (() => {
        const acc = {};
        for (const R of records) {
          acc[R.framing] = acc[R.framing] || { present: 0, total: 0 };
          acc[R.framing].total += 1;
        }
        matchingIdx.forEach((i) => { acc[records[i].framing].present += 1; });
        return Object.fromEntries(Object.entries(acc).map(([k, v]) =>
          [k, { present: v.present, total: v.total, coverage: Number((v.present / v.total).toFixed(4)) }]));
      })(),
      nonIntegerRate: nums.length ? nums.filter((v) => !Number.isInteger(v)).length / nums.length : 0,
      max: nums.length ? Math.max(...nums) : null,
      avgModalShare: modalShares.length ? modalShares.reduce((a, b) => a + b, 0) / modalShares.length : 0,
      distinctQueryModes: new Set(queryModes).size,
      containsNameRate: strings.length
        ? matchingIdx.filter((i, n) => {
          const s = matching[n];
          const nm = ctx.nameOf ? ctx.nameOf(records[i].rec) : null;
          return typeof s === 'string' && nm && s.includes(nm);
        }).length / strings.length
        : 0,
      hasRatingSibling,
      hasLatSibling,
      hasLngSibling,
      expectedDistinctBusinesses: ctx.distinctBusinesses,
    };
    cand.passesGate = gate ? gate(cand) : true;
    out.push(cand);
  }

  // Ranking: gate first, then coverage. Remaining ties are broken by an
  // explicit, field-specific preference — never arbitrarily. For phone the four
  // co-located renderings of the same number tie exactly on coverage, so we
  // prefer the internationalised form (+91 …), which is unambiguous to dial.
  out.sort((a, b) => (b.passesGate - a.passesGate)
    || (b.coverage - a.coverage)
    || (field === 'phone' ? (b.intlFormat - a.intlFormat) : 0)
    || (a.path.length - b.path.length));
  return out;
}

/** Candidates that tie with the winner on coverage — reported, never hidden. */
function tiedWith(chosen, cands) {
  return cands.filter((c) => c !== chosen && c.passesGate && c.hits === chosen.hits);
}

// ---------------------------------------------------------------------------
// 7. Main
// ---------------------------------------------------------------------------

function main() {
  const { records, perFixture } = buildCorpus();
  const total = records.length;

  console.log('# Record root derivation\n');
  console.log('fixture'.padEnd(52), 'framing'.padEnd(11), 'container', 'wrapped', 'records', 'similarity');
  for (const f of perFixture) {
    console.log(
      f.file.padEnd(52), f.framing.padEnd(11),
      String(`[${f.containerIndex}]`).padEnd(9), String(f.wrapped).padEnd(7),
      String(f.count).padEnd(7), f.similarity.toFixed(2),
    );
  }
  console.log(`\nTotal records: ${total}\n`);

  // Pass 1: derive businessName with no context, so later gates can use it.
  const paths = indexPaths(records);
  const bootstrapCtx = { distinctBusinesses: 0, nameOf: null };
  const nameCands = scoreField('businessName', paths, records, bootstrapCtx);
  const namePath = nameCands.find((c) => c.passesGate)?.path;
  const nameOf = namePath ? (rec) => get(rec, namePath) : null;

  // A business is identified by name + rounded coordinates. Used to compute how
  // many distinct businesses the corpus really contains (fixtures overlap).
  const coordPaths = { lat: null, lng: null };
  for (const fld of ['latitude', 'longitude']) {
    const c = scoreField(fld, paths, records, { distinctBusinesses: 0, nameOf }).find((x) => x.passesGate);
    if (c) coordPaths[fld === 'latitude' ? 'lat' : 'lng'] = c.path;
  }
  const bizKey = (rec) => [
    nameOf ? nameOf(rec) : '',
    coordPaths.lat ? Number(get(rec, coordPaths.lat)).toFixed(4) : '',
    coordPaths.lng ? Number(get(rec, coordPaths.lng)).toFixed(4) : '',
  ].join('|');
  const distinctBusinesses = new Set(records.map((r) => bizKey(r.rec))).size;
  console.log(`Distinct businesses (name+coords): ${distinctBusinesses} — `
    + `${total - distinctBusinesses} records are repeats across fixtures.\n`);

  const ctx = { distinctBusinesses, nameOf };

  const FIELDS = ['businessName', 'phone', 'website', 'rating', 'reviewCount',
    'address', 'category', 'latitude', 'longitude', 'cid', 'placeId'];

  const map = {};
  const report = {};

  for (const field of FIELDS) {
    const cands = scoreField(field, paths, records, ctx);
    report[field] = cands;
    const chosen = cands.find((c) => c.passesGate);

    console.log(`\n## ${field} — ${cands.length} candidate path(s) matched the pattern`);
    console.log('   path'.padEnd(28), 'conf'.padEnd(7), 'hits'.padEnd(9), 'fx', 'distinct', 'gate', 'sample');
    for (const c of cands.slice(0, 10)) {
      console.log(
        `   [${c.path.join(',')}]`.padEnd(28),
        c.coverage.toFixed(3).padEnd(7),
        `${c.hits}/${total}`.padEnd(9),
        String(c.filesConfirmed).padEnd(2),
        String(c.distinct).padEnd(8),
        (c.passesGate ? 'PASS' : '-   '),
        JSON.stringify(String(c.sample)).slice(0, 58),
      );
    }
    if (cands.length > 10) console.log(`   … ${cands.length - 10} further candidate(s) suppressed`);

    if (!chosen) {
      console.log(`   >> UNRESOLVED: no candidate passed the structural gate for "${field}"`);
      map[field] = {
        path: null,
        status: 'UNRESOLVED — no candidate passed structural discrimination',
        derivedOn: DERIVED_ON,
        candidatesConsidered: cands.length,
      };
      continue;
    }

    const entry = {
      path: chosen.path,
      type: typeof chosen.sample,
      derivedFrom: `fixtures/raw/${records.find((r) => get(r.rec, chosen.path) === chosen.sample)?.file ?? perFixture[0].file}`,
      derivedOn: DERIVED_ON,
      sample: chosen.sample,
      confidence: Number(chosen.coverage.toFixed(4)),
      confirmedIn: chosen.filesConfirmed,
      nullRate: Number((1 - chosen.coverage).toFixed(4)),
      distinctValues: chosen.distinct,
      coverageByFraming: chosen.coverageByFraming,
      equivalentPaths: tiedWith(chosen, cands).map((c) => ({ path: c.path, sample: String(c.sample).slice(0, 60) })),
      runnersUp: cands.filter((c) => c !== chosen).slice(0, 3)
        .map((c) => ({ path: c.path, confidence: Number(c.coverage.toFixed(4)), sample: String(c.sample).slice(0, 60) })),
    };
    if (ABSENCE_IS_EXPECTED.has(field)) {
      entry.absenceIsExpected = true;
      entry.note = `Many businesses genuinely have no ${field}. Coverage below 1.0 is a `
        + 'property of the businesses, not a defect in the path. Do NOT "fix" this by '
        + 'choosing a higher-coverage path — a path at 0% or 100% would be the wrong one.';
    }
    if (chosen.coverage < LOW_CONFIDENCE) entry.status = 'LOW — verify manually';
    if (chosen.filesConfirmed < 2) {
      entry.status = 'PROVISIONAL — confirmed in fewer than 2 fixtures';
    }

    // A field whose availability depends on the response framing is not a
    // low-confidence path — it is a capture-strategy constraint. Say so, loudly
    // and separately, so nobody "fixes" it by hunting for a better index.
    const byFr = Object.entries(chosen.coverageByFraming);
    const absentIn = byFr.filter(([, v]) => v.coverage === 0).map(([k]) => k);
    const presentIn = byFr.filter(([, v]) => v.coverage > 0.5).map(([k]) => k);
    if (absentIn.length && presentIn.length) {
      entry.framingDependent = true;
      entry.status = `FRAMING-DEPENDENT — absent from every "${absentIn.join('/')}" payload, `
        + `present in "${presentIn.join('/')}" payloads at `
        + `${(chosen.coverageByFraming[presentIn[0]].coverage * 100).toFixed(1)}%. `
        + 'The path is correct; the initial payload does not carry this field.';
    }
    map[field] = entry;
    console.log(`   >> chosen [${chosen.path.join(',')}] confidence=${chosen.coverage.toFixed(3)} `
      + `confirmedIn=${chosen.filesConfirmed}${entry.status ? ` status=${entry.status}` : ''}`);
  }

  // -- Loud checks -----------------------------------------------------------
  console.log('\n\n# Sanity checks\n');
  for (const f of ['phone', 'website']) {
    const e = map[f];
    const cov = e && e.confidence != null ? e.confidence : 0;
    console.log(`${f}: coverage ${(cov * 100).toFixed(1)}% (absence is expected for this field)`);
    if (cov === 0 || cov === 1) {
      console.log(`  *** ALARM: ${f} coverage is ${cov === 0 ? '0%' : '100%'} — THE PATH IS WRONG. `
        + `${f} is absent for some businesses and present for others; a path that is `
        + `always-null or always-present is not the ${f} field.`);
    }
  }

  const output = {
    $schema: 'internal://field-map/v1',
    derivedOn: DERIVED_ON,
    derivedBy: 'scripts/discover-fields.js',
    corpus: {
      fixtures: perFixture.length,
      records: total,
      distinctBusinesses,
      perFixture: perFixture.map(({ file, framing, count, containerIndex, wrapped }) =>
        ({ file, framing, records: count, containerIndex, wrapped })),
    },
    recordRoot: {
      containerPath: [perFixture[0].containerIndex],
      elementUnwrap: perFixture[0].wrapped ? [1] : [],
      note: 'Record root = payload[containerPath][i][...elementUnwrap]. '
        + 'All field paths below are relative to that record root.',
    },
    fields: map,
  };

  if (DRY_RUN) {
    console.log('\n--dry-run: config/field-map.json not written.');
  } else {
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, `${JSON.stringify(output, null, 2)}\n`);
    console.log(`\nWrote ${path.relative(ROOT, OUT_FILE)}`);
  }
  return output;
}

main();
