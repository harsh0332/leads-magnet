/**
 * Adversarial test suite for src/parse.js.
 *
 * The job here is NOT to confirm the parser works. It is to prove it doesn't.
 * Every test that passes on the first try taught us nothing.
 *
 * The failures this suite exists to catch are documented in REVIEW.md:
 *   S1-1  reviewCount null on every record -> demand constant -> Tier A/B unreachable
 *   S1-2  street address captured into the category column
 *   S1-3  websiteUrl only readable where it was guaranteed absent
 * All three shipped in committed output. None crashed. None was noticed.
 *
 * Runs fully offline against fixtures/raw/. No network, no browser, no deps.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseSearchResponse,
  parseSearchResponseDetailed,
  parseOneRecord,
  detectFraming,
  decodeResponseBody,
  resolvePath,
  normalizeIndianPhone,
  websiteHost,
  isSocialHost,
  nullRateTable,
  DEFAULT_FIELD_MAP,
  FIELD_STATE,
} from '../src/parse.js';

/* ------------------------------------------------------------------ */
/* Corpus                                                              */
/* ------------------------------------------------------------------ */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = path.join(ROOT, 'fixtures', 'raw');

const FIXTURES = fs
  .readdirSync(RAW_DIR)
  .filter((f) => f.endsWith('.txt') && !f.endsWith('.url.txt'))
  .sort()
  .map((file) => ({ file, body: fs.readFileSync(path.join(RAW_DIR, file), 'utf8') }));

assert.ok(FIXTURES.length > 0, 'no fixtures found — run scripts/capture-fixtures.js first');

/** Parse once, reuse everywhere. Parsing is pure, so this is safe. */
const PARSED = FIXTURES.map(({ file, body }) => ({
  file,
  ...parseSearchResponseDetailed(body),
}));

const ALL = PARSED.flatMap((p) => p.records);
const PAGINATION = PARSED.filter((p) => p.framing === 'pagination').flatMap((p) => p.records);

const pct = (n, d) => (d === 0 ? 0 : (n / d) * 100);
const present = (recs, key) => recs.filter((r) => r[key] !== null && r[key] !== undefined);
const INDIA = { latMin: 6, latMax: 38, lngMin: 68, lngMax: 98 };

/* ================================================================== */
/* REQUIRED ASSERTIONS                                                 */
/* ================================================================== */

test('every fixture parses without throwing', () => {
  for (const { file, body } of FIXTURES) {
    assert.doesNotThrow(() => parseSearchResponse(body), `${file} threw during parse`);
  }
});

test('each fixture yields at least 15 records', () => {
  for (const { file, records } of PARSED) {
    assert.ok(
      records.length >= 15,
      `${file}: expected >=15 records, got ${records.length}`
    );
  }
});

test('name coverage is 100%', () => {
  for (const { file, records } of PARSED) {
    const missing = records.filter((r) => !r.name);
    assert.equal(
      missing.length, 0,
      `${file}: ${missing.length}/${records.length} records missing name`
    );
  }
});

test('cid coverage is 100% and cids are unique within a fixture', () => {
  for (const { file, records } of PARSED) {
    const missing = records.filter((r) => !r.cid);
    assert.equal(missing.length, 0, `${file}: ${missing.length} records missing cid`);

    const seen = new Map();
    const dupes = [];
    for (const r of records) {
      if (seen.has(r.cid)) dupes.push(`${r.cid} (${seen.get(r.cid)} / ${r.name})`);
      else seen.set(r.cid, r.name);
    }
    assert.equal(dupes.length, 0, `${file}: duplicate cids -> ${dupes.join('; ')}`);
  }
});

test('rating, when present, is between 1.0 and 5.0', () => {
  for (const { file, records } of PARSED) {
    for (const r of present(records, 'rating')) {
      assert.equal(typeof r.rating, 'number', `${file}: ${r.name} rating not a number`);
      assert.ok(
        r.rating >= 1.0 && r.rating <= 5.0,
        `${file}: ${r.name} rating ${r.rating} outside 1.0–5.0`
      );
    }
  }
});

test('reviewCount, when present, is a non-negative integer', () => {
  for (const { file, records } of PARSED) {
    for (const r of present(records, 'reviewCount')) {
      assert.ok(
        Number.isInteger(r.reviewCount) && r.reviewCount >= 0,
        `${file}: ${r.name} reviewCount ${r.reviewCount} is not a non-negative integer`
      );
    }
  }
});

test('lat/lng, when present, fall within India bounds', () => {
  for (const { file, records } of PARSED) {
    for (const r of present(records, 'lat')) {
      assert.ok(
        r.lat >= INDIA.latMin && r.lat <= INDIA.latMax,
        `${file}: ${r.name} lat ${r.lat} outside India (${INDIA.latMin}–${INDIA.latMax})`
      );
    }
    for (const r of present(records, 'lng')) {
      assert.ok(
        r.lng >= INDIA.lngMin && r.lng <= INDIA.lngMax,
        `${file}: ${r.name} lng ${r.lng} outside India (${INDIA.lngMin}–${INDIA.lngMax})`
      );
    }
  }
});

test('phone coverage is between 40% and 98% — neither extreme', () => {
  // 0% means the path is wrong. 100% means the path is matching something that
  // is always there, i.e. also wrong. Real Indian listings sit in between.
  const cov = pct(present(ALL, 'phone').length, ALL.length);
  assert.ok(
    cov >= 40 && cov <= 98,
    `phone coverage ${cov.toFixed(1)}% outside 40–98% ` +
    `(${present(ALL, 'phone').length}/${ALL.length}) — a wrong path is the likely cause`
  );
});

test('website coverage is between 15% and 85% — THE MOST IMPORTANT ASSERTION IN THIS SUITE', () => {
  // ---------------------------------------------------------------------
  // THIS IS THE SINGLE MOST IMPORTANT ASSERTION IN THE SUITE.
  //
  // `website` drives the largest scoring weight in the whole pipeline:
  // noWebsite is +40 gap, and social-only is +32. If this path is wrong:
  //
  //   - coverage 0%   -> every business scores "no website" -> the operator
  //                      cold-calls hundreds of businesses that already have
  //                      one, and finds out on call #14.
  //   - coverage 100% -> nothing ever scores the gap -> the lead list is empty
  //                      and looks like the city simply has no prospects.
  //
  // Both failures produce a clean, well-formatted, confidently wrong report.
  // That is exactly how REVIEW.md S1-3 survived from the first commit: the
  // predecessor could only read websiteUrl in the branch where it was
  // guaranteed absent, so isSocialOnly was false on 100% of records and the
  // highest-value lead class was invisible.
  //
  // An extreme here is never a fact about Indian businesses. It is a bug.
  // ---------------------------------------------------------------------
  const n = present(ALL, 'website').length;
  const cov = pct(n, ALL.length);
  assert.ok(
    cov >= 15 && cov <= 85,
    `website coverage ${cov.toFixed(1)}% outside 15–85% (${n}/${ALL.length}) — ` +
    'this is a wrong-path signature, not a data characteristic'
  );
});

test('no two records in one fixture share the same phone number', () => {
  for (const { file, records } of PARSED) {
    const seen = new Map();
    const collisions = [];
    for (const r of records) {
      if (r.phone === null) continue;
      if (seen.has(r.phone)) collisions.push(`${r.phone}: "${seen.get(r.phone)}" vs "${r.name}"`);
      else seen.set(r.phone, r.name);
    }
    assert.equal(
      collisions.length, 0,
      `${file}: shared phone numbers -> ${collisions.join(' | ')}`
    );
  }
});

test('every normalized phone matches /^\\+91\\d{10}$/', () => {
  const bad = [];
  for (const { file, records } of PARSED) {
    for (const r of present(records, 'phone')) {
      if (!/^\+91\d{10}$/.test(r.phone)) bad.push(`${file}: ${r.name} -> ${JSON.stringify(r.phone)}`);
    }
  }
  assert.equal(bad.length, 0, `malformed phones:\n  ${bad.join('\n  ')}`);
});

/* ================================================================== */
/* CORPUS-LEVEL DISTRIBUTION INVARIANTS                                */
/*                                                                     */
/* Per-field assertions pass happily while the dataset as a whole is    */
/* garbage. Every REVIEW.md failure would have slipped through a suite  */
/* that only checked individual records.                               */
/* ================================================================== */

test('no numeric field has zero variance across the corpus', () => {
  for (const key of ['rating', 'reviewCount', 'lat', 'lng']) {
    const vals = present(ALL, key).map((r) => r[key]);
    if (vals.length === 0) continue;
    const distinct = new Set(vals).size;
    assert.ok(
      distinct > 1,
      `${key} has ${distinct} distinct value across ${vals.length} records — ` +
      'a constant is the signature of a wrong path (REVIEW.md S1-1)'
    );
  }
});

test('no boolean field is 100% true or 100% false across the corpus', () => {
  for (const key of ['hasWebsite', 'isSocialOnly']) {
    const vals = present(ALL, key).map((r) => r[key]);
    if (vals.length === 0) continue;
    const t = vals.filter(Boolean).length;
    assert.ok(
      t > 0 && t < vals.length,
      `${key} is ${t === 0 ? 'always false' : 'always true'} across ${vals.length} records — ` +
      'REVIEW.md S1-3 shipped exactly this'
    );
  }
});

test('reviewCount has real variance in the pagination corpus (tier reachability)', () => {
  // REVIEW.md S1-1: the predecessor's reviewCount was null on every record, so
  // demandScore() returned a constant 10, so Tier A (needs >=55) and Tier B
  // (needs >=30) were MATHEMATICALLY UNREACHABLE. The report printed
  // "Tier A: 0" forever and looked correct. This is that regression test.
  const vals = present(PAGINATION, 'reviewCount').map((r) => r.reviewCount);
  assert.ok(vals.length > 0, 'no reviewCount anywhere in the pagination corpus');
  assert.ok(new Set(vals).size > 5, `reviewCount has only ${new Set(vals).size} distinct values`);
  assert.ok(Math.max(...vals) > 30, `max reviewCount is ${Math.max(...vals)} — no lead could reach Tier A`);
});

test('rating and reviewCount are not perfectly correlated', () => {
  const pairs = PAGINATION
    .filter((r) => r.rating !== null && r.reviewCount !== null)
    .map((r) => [r.rating, r.reviewCount]);
  assert.ok(pairs.length > 10, `only ${pairs.length} rating+reviewCount pairs`);
  const ratios = new Set(pairs.map(([a, b]) => (b === 0 ? 'z' : (a / b).toFixed(6))));
  assert.ok(ratios.size > 1, 'rating and reviewCount move in lockstep — likely the same node');
});

/* ================================================================== */
/* TRAP REGRESSIONS — the named decoys from Phase 3                    */
/* ================================================================== */

test('address does not contain the business name (REVIEW.md S1-2)', () => {
  // [18] is a name-prefixed address (contains the business name in 152/152
  // cases); [39] is the clean street address. Picking [18] reproduces the
  // predecessor's defect, where the category column held a street address and
  // shipped that way for the life of the project.
  const bad = [];
  for (const r of present(ALL, 'address')) {
    if (!r.name || r.name.length < 6) continue;
    if (r.address.toLowerCase().includes(r.name.toLowerCase())) {
      bad.push(`${r.name} -> ${r.address.slice(0, 70)}`);
    }
  }
  assert.ok(
    bad.length <= ALL.length * 0.05,
    `${bad.length}/${ALL.length} addresses embed the business name:\n  ${bad.slice(0, 5).join('\n  ')}`
  );
});

test('category is a short label, not an address or a PIN code', () => {
  const bad = [];
  for (const r of present(ALL, 'category')) {
    if (r.category.length > 60) bad.push(`too long: ${r.category.slice(0, 60)}`);
    else if (/\d{6}/.test(r.category)) bad.push(`contains PIN: ${r.category}`);
    else if ((r.category.match(/,/g) || []).length >= 2) bad.push(`address-shaped: ${r.category}`);
  }
  assert.equal(bad.length, 0, `category column polluted:\n  ${bad.slice(0, 5).join('\n  ')}`);
});

test('category repeats across records but name does not', () => {
  // The discriminator discover relied on. If it inverts, the two paths were swapped.
  for (const { file, records } of PARSED) {
    const cats = new Set(present(records, 'category').map((r) => r.category)).size;
    const names = new Set(present(records, 'name').map((r) => r.name)).size;
    assert.ok(
      cats < names,
      `${file}: ${cats} distinct categories vs ${names} distinct names — paths may be swapped`
    );
  }
});

test('no record carries another business\'s coordinates ([37,...] trap)', () => {
  // [37,...] mirrors the record shape but holds a DIFFERENT, related business.
  // A parser that falls back to it emits another company's data under this
  // company's name. Coordinates must be distinct per business.
  for (const { file, records } of PARSED) {
    const byCoord = new Map();
    const shared = [];
    for (const r of records) {
      if (r.lat === null || r.lng === null) continue;
      const k = `${r.lat},${r.lng}`;
      if (byCoord.has(k) && byCoord.get(k) !== r.name) shared.push(`${k}: ${byCoord.get(k)} / ${r.name}`);
      else byCoord.set(k, r.name);
    }
    assert.equal(shared.length, 0, `${file}: identical coords on distinct businesses -> ${shared.join(' | ')}`);
  }
});

/* ================================================================== */
/* MUTATION / MALFORMED INPUT                                          */
/* ================================================================== */

test('malformed bodies throw loudly rather than returning partial results', () => {
  const cases = [
    ['empty string', ''],
    ['garbage', 'not a payload at all'],
    ['truncated initial', ")]}'\n[[\"dentist\",[[null,"],
    ['initial prefix, invalid json', ")]}'\n{{{"],
    ['envelope without .d', '{"c":0}'],
    ['envelope with non-string .d', '{"c":0,"d":123}'],
    ['envelope .d missing xssi prefix', '{"c":0,"d":"[1,2,3]"}'],
    ['html block page', '<html><body>unusual traffic</body></html>'],
  ];
  for (const [label, body] of cases) {
    assert.throws(() => parseSearchResponse(body), `${label}: should have thrown`);
  }
});

test('non-string body is rejected by type, not coerced', () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.throws(() => detectFraming(bad), /must be a string/);
  }
});

test('a wrong path reports unknown rather than a plausible value', () => {
  // The core silent-failure guard: a drifted index must never quietly resolve
  // to whatever happens to sit there.
  const rec = PARSED[0].records[0];
  const raw = decodeResponseBody(FIXTURES[0].body).payload;
  const node = raw[DEFAULT_FIELD_MAP.recordRoot.containerPath[0]][0][1];

  const bent = structuredClone(DEFAULT_FIELD_MAP);
  bent.fields.rating = { ...bent.fields.rating, path: [999, 999] };
  const out = parseOneRecord(node, 0, bent, 'initial');

  assert.equal(out.rating, null, 'bent rating path produced a value instead of null');
  assert.notEqual(out._meta.fields.rating.state, FIELD_STATE.OK);
  assert.ok(out._meta.fields.rating.reason, 'no reason recorded for the failure');
  assert.equal(out.name, rec.name, 'unrelated field changed when only rating was bent');
});

test('a bent REQUIRED path throws and names the field and record index', () => {
  const raw = decodeResponseBody(FIXTURES[0].body).payload;
  const node = raw[DEFAULT_FIELD_MAP.recordRoot.containerPath[0]][3][1];

  const bent = structuredClone(DEFAULT_FIELD_MAP);
  bent.fields.cid = { ...bent.fields.cid, path: [999] };
  assert.throws(
    () => parseOneRecord(node, 3, bent, 'initial'),
    (e) => /required field "cid"/.test(e.message) && /record index 3/.test(e.message),
    'error must name both the field and the record index'
  );
});

test('a stale container path throws and says to re-capture', () => {
  const bent = structuredClone(DEFAULT_FIELD_MAP);
  bent.recordRoot = { ...bent.recordRoot, containerPath: [4242] };
  assert.throws(() => parseSearchResponse(FIXTURES[0].body, bent), /re-capture|stale/i);
});

test('non-container record node throws rather than yielding an empty Place', () => {
  for (const junk of [null, 42, 'a string', undefined]) {
    assert.throws(() => parseOneRecord(junk, 0), /not a container/);
  }
});

/* ================================================================== */
/* PHONE NORMALIZATION — hostile inputs                                */
/* ================================================================== */

test('phone normalizer accepts every real Indian rendering', () => {
  const ok = [
    '+91 90000 12345', '090000 12345', '09000012345', '9000012345',
    '919000012345', '+91 731 400 1234', '(0731) 4000000', '+91-90000-12345',
  ];
  for (const raw of ok) {
    const { value } = normalizeIndianPhone(raw);
    assert.ok(value !== null, `rejected a valid number: ${JSON.stringify(raw)}`);
    assert.match(value, /^\+91\d{10}$/, `bad shape for ${JSON.stringify(raw)}: ${value}`);
  }
});

test('phone normalizer rejects rather than mangles', () => {
  const bad = [
    '', '   ', 'not a phone', '12345', '+91 90000 123450', '+1 415 555 2671',
    '+44 20 7946 0958', '94259', '+91', null, undefined,
  ];
  for (const raw of bad) {
    const { value, reason } = normalizeIndianPhone(raw);
    assert.equal(value, null, `should have rejected ${JSON.stringify(raw)}, got ${value}`);
    assert.ok(reason, `no reason recorded for ${JSON.stringify(raw)}`);
  }
});

test('a rejected phone never reaches the record as a mangled string', () => {
  for (const r of ALL) {
    if (r.phone === null) continue;
    assert.match(r.phone, /^\+91\d{10}$/, `${r.name} carries un-normalized "${r.phone}"`);
  }
});

/* ================================================================== */
/* SOCIAL / WEBSITE CLASSIFICATION                                     */
/* ================================================================== */

test('social classification matches on host, not on substring', () => {
  assert.equal(isSocialHost(websiteHost('https://facebook.com/x')), true);
  assert.equal(isSocialHost(websiteHost('https://foo.blogspot.com')), true);
  // A real site that merely mentions a social domain in its query string:
  assert.equal(isSocialHost(websiteHost('https://mysite.com/?ref=facebook.com')), false);
  // A lookalike domain:
  assert.equal(isSocialHost(websiteHost('https://facebook.com.evil.net/x')), false);
});

test('social-only lead class is detectable and non-empty (REVIEW.md S1-3)', () => {
  const social = ALL.filter((r) => r.isSocialOnly === true);
  const owned = ALL.filter((r) => r.hasWebsite === true && r.isSocialOnly === false);
  assert.ok(social.length > 0, 'no social-only leads found — the predecessor\'s exact blind spot');
  assert.ok(owned.length > 0, 'every website classified as social — classifier is inverted');
});

test('hasWebsite is null, never false, when website is unknown', () => {
  // A drifted website path must not hand every record +40 gap points (S2-1).
  for (const r of ALL) {
    const st = r._meta.fields.website.state;
    if (st === FIELD_STATE.UNKNOWN) {
      assert.equal(r.hasWebsite, null, `${r.name}: unknown website became hasWebsite=${r.hasWebsite}`);
    }
  }
});

/* ================================================================== */
/* PURITY / CONTRACT                                                   */
/* ================================================================== */

test('parsing is pure: same input twice is deep-equal', () => {
  const a = JSON.parse(JSON.stringify(parseSearchResponse(FIXTURES[0].body)));
  const b = JSON.parse(JSON.stringify(parseSearchResponse(FIXTURES[0].body)));
  assert.deepEqual(a, b);
});

test('the injected field map is genuinely honoured, not decorative', () => {
  const bent = structuredClone(DEFAULT_FIELD_MAP);
  bent.fields.category = { ...bent.fields.category, path: [11] }; // point category at the name
  const out = parseSearchResponse(FIXTURES[0].body, bent);
  const base = PARSED[0].records;
  assert.notDeepEqual(
    out.map((r) => r.category),
    base.map((r) => r.category),
    'bending the map changed nothing — the parser is not reading it'
  );
  assert.equal(out[0].category, base[0].name, 'injected path did not take effect');
});

test('every Place carries the full contract shape', () => {
  const required = [
    'cid', 'name', 'category', 'rating', 'reviewCount', 'phone', 'website',
    'address', 'area', 'lat', 'lng', 'isUnclaimed', 'permanentlyClosed',
  ];
  for (const r of ALL.slice(0, 40)) {
    for (const k of required) {
      assert.ok(k in r, `Place missing contract key "${k}"`);
    }
  }
});

test('unmapped fields are distinguishable from genuinely absent ones', () => {
  // area / isUnclaimed / permanentlyClosed have no path in the field map.
  // They must read as "we never looked", not as "the business has none".
  for (const r of ALL.slice(0, 40)) {
    for (const k of ['area', 'isUnclaimed', 'permanentlyClosed']) {
      assert.equal(r[k], null, `${k} should be null while unmapped`);
      assert.equal(
        r._meta.fields[k].state, FIELD_STATE.UNMAPPED,
        `${k} state is "${r._meta.fields[k].state}" — unmapped must not masquerade as absent`
      );
    }
  }
});

test('values hostile to CSV round-tripping survive parsing intact', () => {
  const raw = decodeResponseBody(FIXTURES[0].body).payload;
  const node = structuredClone(raw[DEFAULT_FIELD_MAP.recordRoot.containerPath[0]][0][1]);
  const hostile = 'Sharma, "Best" Dental\nClinic — दंत ✨';
  const namePath = DEFAULT_FIELD_MAP.fields.businessName.path;
  let cur = node;
  for (let i = 0; i < namePath.length - 1; i += 1) cur = cur[namePath[i]];
  cur[namePath[namePath.length - 1]] = hostile;

  const out = parseOneRecord(node, 0, DEFAULT_FIELD_MAP, 'initial');
  assert.equal(out.name, hostile, 'parser altered a hostile-but-valid name');
});

/* ================================================================== */
/* NULL-RATE OBSERVABILITY                                             */
/* ================================================================== */

test('nullRateTable separates absent from unknown from unmapped', () => {
  const t = nullRateTable(ALL);
  assert.equal(t.website.unknown, 0, 'website has unresolved extractions');
  assert.ok(t.website.absent > 0, 'website absence is not being recorded');
  assert.equal(t.area.unmapped, ALL.length, 'area should be 100% unmapped');
  assert.ok(
    t.reviewCount.framingOmitted > 0,
    'framing-omitted reviewCount is not flagged — the >30% rule will misfire'
  );
});

test('no MAPPED field exceeds a 30% unresolved rate', () => {
  // CLAUDE.md: "A field that returns null for more than 30% of records is a
  // BUG, not a data characteristic." Enforced on unresolvedRate, which excludes
  // genuine absence and framing omission. The three unmapped fields are
  // deliberately excluded — they are tracked as unresolved work, not as a
  // parser defect.
  const t = nullRateTable(ALL);
  const mapped = Object.keys(DEFAULT_FIELD_MAP.fields);
  const offenders = [];
  for (const [placeKey, row] of Object.entries(t)) {
    if (row.unmapped > 0) continue;
    if (!mapped.includes(placeKey) && !['hasWebsite', 'isSocialOnly'].includes(placeKey)) continue;
    if (row.unresolvedRate > 0.3) {
      offenders.push(`${placeKey}: ${(row.unresolvedRate * 100).toFixed(1)}%`);
    }
  }
  assert.equal(offenders.length, 0, `unresolved rate over 30%: ${offenders.join(', ')}`);
});

/* ================================================================== */
/* PER-CATEGORY COVERAGE — deliberately strict                         */
/* ================================================================== */

test('website coverage holds per fixture, not just corpus-wide', () => {
  // Corpus-wide coverage can mask a category where the path collapses.
  // If this fails while the corpus-wide test passes, the bound is
  // category-dependent and the runner needs a per-category threshold.
  const rows = PARSED.map(({ file, records }) => ({
    file,
    cov: pct(present(records, 'website').length, records.length),
  }));
  const out = rows.filter((r) => r.cov < 15 || r.cov > 85);
  assert.equal(
    out.length, 0,
    `per-fixture website coverage outside 15–85%:\n  ` +
    rows.map((r) => `${r.file}: ${r.cov.toFixed(1)}%`).join('\n  ')
  );
});
