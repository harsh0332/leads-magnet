/**
 * src/parse.js — PURE extraction of Place records from an intercepted
 * Google Maps search response.
 *
 * ---------------------------------------------------------------------------
 * PURITY CONTRACT
 * ---------------------------------------------------------------------------
 * No function exported from this module performs I/O of any kind: no fetch,
 * no Playwright, no fs, no Date.now(), no Math.random(), no process.env, no
 * global mutable state. Same bytes in => same records out, on any machine,
 * with the network unplugged.
 *
 * The field map is the one thing a parser needs that lives on disk. It is
 * read ONCE, at module scope (import time), never from inside a parse
 * function. Every exported parse function also accepts an injected field map
 * as an optional parameter, so it can be unit-tested against a synthetic map
 * with no filesystem involved at all.
 *
 * ---------------------------------------------------------------------------
 * NO LITERAL PAYLOAD INDICES LIVE IN THIS FILE
 * ---------------------------------------------------------------------------
 * Every index — the record container, the element unwrap, and all 11 field
 * paths — is read from config/field-map.json, which records the fixture and
 * date each index was derived from. If a field is not in that map, this file
 * cannot extract it and does not try. See UNMAPPED below.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR STATES OF A FIELD  (this is the whole point of the module)
 * ---------------------------------------------------------------------------
 * Every field on a Place carries a value or `null`. `null` alone is
 * ambiguous, so every field ALSO gets an entry in `place._meta.fields[key]`
 * describing exactly why:
 *
 *   state: 'ok'       value extracted successfully. `value` is on the Place.
 *   state: 'absent'   the path resolved and the payload explicitly carries
 *                     nothing there — the business genuinely has no such
 *                     field (no website, no phone, unrated).
 *   state: 'unknown'  the path did not resolve, or resolved to something of
 *                     the wrong shape, or the value could not be normalized.
 *                     We do not know what the real value is. `reason` says why.
 *   state: 'unmapped' the field is part of the Place contract but has NO
 *                     entry in config/field-map.json. Nobody has derived a
 *                     path for it from a fixture yet. This is unresolved work
 *                     for `discover`, not a property of the business.
 *
 * 'absent' and 'unknown' MUST NOT be collapsed by any consumer. An unclaimed
 * listing we failed to read is not the same as a claimed one, and a website
 * we failed to read is not the same as a business without a website — the
 * latter mistake is worth +40 gap points to the scorer.
 *
 * Nothing here ever substitutes a fallback value. No `|| ''`, no `?? 0`, no
 * `|| 'Unknown'`. No try/catch that swallows a failure into a default.
 * Required fields (cid, name) throw with the field name and record index.
 *
 * ---------------------------------------------------------------------------
 * UNMAPPED FIELDS — `area`, `isUnclaimed`, `permanentlyClosed`
 * ---------------------------------------------------------------------------
 * These three are part of the Place shape but have no path in
 * config/field-map.json. They are emitted as `null` with
 * `state: 'unmapped'`, and listed in `place._meta.unmapped`. They are NOT
 * guessed, NOT regexed out of the payload blob, and `area` is NOT derived by
 * splitting a search query — this module never sees the query.
 *
 * The binding table below is keyed by field-map field name, so the day
 * `discover` adds a path for any of them, extraction starts working here with
 * no change to this file.
 *
 * ---------------------------------------------------------------------------
 * FRAMING-DEPENDENT FIELDS
 * ---------------------------------------------------------------------------
 * `reviewCount` is emitted only by "pagination" responses; "initial"
 * responses do not carry it (0/80 vs 68/73 across the fixture corpus). When a
 * field the map marks `framingDependent` is missing, its state is 'unknown'
 * (reason names the framing) and never 'absent' — we cannot tell an
 * unreviewed business from a response that simply omits the column.
 */

import { readFileSync } from 'node:fs';
import { SOCIAL_DOMAINS } from './selectors.js';

/* ------------------------------------------------------------------ */
/* Field map — loaded once, at module scope. Never inside a parser.    */
/* ------------------------------------------------------------------ */

export const DEFAULT_FIELD_MAP = Object.freeze(
  JSON.parse(readFileSync(new URL('../config/field-map.json', import.meta.url), 'utf8'))
);

/**
 * Place key -> field-map field name.
 * A key whose field-map name is missing from `fieldMap.fields` is reported as
 * 'unmapped'. That is how area / isUnclaimed / permanentlyClosed behave today.
 */
export const FIELD_BINDINGS = Object.freeze({
  cid: 'cid',
  name: 'businessName',
  category: 'category',
  rating: 'rating',
  reviewCount: 'reviewCount',
  phone: 'phone',
  website: 'website',
  address: 'address',
  area: 'area',
  lat: 'latitude',
  lng: 'longitude',
  isUnclaimed: 'isUnclaimed',
  hours: 'hours',
  photoCount: 'photoCount',
  permanentlyClosed: 'permanentlyClosed',
  placeId: 'placeId',
});

/** Extraction failure on one of these is a hard error, not a null. */
export const REQUIRED_FIELDS = Object.freeze(['cid', 'name']);

/** Every key a Place carries, in emission order. */
export const PLACE_FIELDS = Object.freeze([
  'cid', 'name', 'category', 'rating', 'reviewCount', 'phone', 'website',
  'address', 'area', 'lat', 'lng', 'isUnclaimed', 'hours', 'photoCount',
  'permanentlyClosed', 'placeId', 'hasWebsite', 'isSocialOnly', 'hasHours', 'hasPhotos',
]);

export const FIELD_STATE = Object.freeze({
  OK: 'ok',
  ABSENT: 'absent',
  UNKNOWN: 'unknown',
  UNMAPPED: 'unmapped',
});

/* ------------------------------------------------------------------ */
/* Response framing                                                    */
/* ------------------------------------------------------------------ */

const XSSI_PREFIX = /^\)\]\}'\s*/;

/**
 * Framing is detected from the body's leading bytes only — never from a
 * filename, never from URL parameters.
 *
 *   'initial'     body starts with )]}'\n then a raw JSON array.
 *   'pagination'  body is a {"c":0,"d":"..."} envelope with trailing /*""*\/
 *                 junk after the closing brace; the real payload is the
 *                 XSSI-prefixed JSON string in `.d`.
 *
 * @returns {'initial'|'pagination'}
 */
export function detectFraming(rawBody) {
  if (typeof rawBody !== 'string') {
    throw new TypeError(`parse: response body must be a string, got ${typeof rawBody}`);
  }
  const head = rawBody.slice(0, 32).trimStart();
  if (head.startsWith(")]}'")) return 'initial';
  if (head.startsWith('{')) return 'pagination';
  throw new Error(
    `parse: unrecognised response framing; body starts with ${JSON.stringify(rawBody.slice(0, 24))}`
  );
}

/**
 * Body string -> decoded payload array. Pure; throws loudly on anything it
 * does not recognise rather than returning a partial result.
 *
 * @returns {{ framing: string, payload: unknown[] }}
 */
export function decodeResponseBody(rawBody) {
  const framing = detectFraming(rawBody);
  const body = rawBody.trim();

  if (framing === 'initial') {
    const json = body.replace(XSSI_PREFIX, '');
    if (json === body) {
      throw new Error('parse: initial framing detected but XSSI prefix ")]}\'" not found');
    }
    return { framing, payload: expectArray(JSON.parse(json), 'initial payload root') };
  }

  // pagination: slice off the trailing /*""*/ junk that follows the envelope.
  const end = body.lastIndexOf('}');
  if (end === -1) {
    throw new Error('parse: pagination framing detected but envelope has no closing brace');
  }
  const envelope = JSON.parse(body.slice(0, end + 1));
  const inner = envelope?.d;
  if (typeof inner !== 'string') {
    throw new Error(
      `parse: pagination envelope has no string ".d" payload (got ${typeof inner})`
    );
  }
  const json = inner.replace(XSSI_PREFIX, '');
  if (json === inner) {
    throw new Error('parse: pagination ".d" payload is missing its XSSI prefix ")]}\'"');
  }
  return { framing, payload: expectArray(JSON.parse(json), 'pagination .d payload root') };
}

function expectArray(value, what) {
  if (!Array.isArray(value)) {
    throw new Error(`parse: expected ${what} to be an array, got ${describe(value)}`);
  }
  return value;
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

/* ------------------------------------------------------------------ */
/* Path resolution                                                     */
/* ------------------------------------------------------------------ */

/**
 * Walk a map-supplied path and report HOW it terminated. The outcome is what
 * lets 'absent' stay distinguishable from 'unknown'.
 *
 *   'value'            reached a defined, non-null leaf
 *   'null-branch'      payload explicitly carries null partway down
 *   'null-leaf'        payload explicitly carries null at the leaf
 *   'undefined-branch' index does not exist partway down
 *   'undefined-leaf'   index does not exist at the leaf
 *   'not-indexable'    a primitive sat where a container was expected (drift)
 */
export function resolvePath(root, path) {
  let cur = root;
  for (let depth = 0; depth < path.length; depth += 1) {
    if (cur === null) return { outcome: 'null-branch', value: null, depth };
    if (cur === undefined) return { outcome: 'undefined-branch', value: null, depth };
    if (typeof cur !== 'object') return { outcome: 'not-indexable', value: null, depth };
    cur = cur[path[depth]];
  }
  if (cur === null) return { outcome: 'null-leaf', value: null, depth: path.length };
  if (cur === undefined) return { outcome: 'undefined-leaf', value: null, depth: path.length };
  return { outcome: 'value', value: cur, depth: path.length };
}

const ok = (value) => ({ state: FIELD_STATE.OK, value });
const absent = (reason) => ({ state: FIELD_STATE.ABSENT, value: null, reason });
const unknown = (reason, extra) => ({ state: FIELD_STATE.UNKNOWN, value: null, reason, ...extra });

/**
 * Resolve one mapped field on one record node and classify the result.
 * Returns { state, value, reason?, path? } — never throws for a missing
 * value; the caller decides whether the field was required.
 */
function extractField(recordNode, placeKey, fieldMap, framing) {
  const mapName = FIELD_BINDINGS[placeKey];
  const spec = fieldMap?.fields?.[mapName];

  if (!spec) {
    return {
      state: FIELD_STATE.UNMAPPED,
      value: null,
      reason: `no path in field map for "${mapName}" — unresolved work for discover`,
    };
  }
  if (!Array.isArray(spec.path) || spec.path.length === 0) {
    return unknown(`field map entry "${mapName}" has no usable path`);
  }

  const hit = resolvePath(recordNode, spec.path);
  const where = `path ${JSON.stringify(spec.path)}`;

  // A presence-flag field: the node's EXISTENCE is the value. isUnclaimed is
  // the case — [49,0] holds a "Claim this business" CTA link that Google only
  // renders on listings with no verified owner. Absence here is a real `false`,
  // not a failed extraction, so this must be decided before the absent/unknown
  // logic below. Verified against the fixtures: 28/153 positive, and the CTA's
  // fp= parameter matches the record's OWN cid 28/28.
  if (spec.type === 'booleanByPresence') {
    if (hit.outcome === 'not-indexable') {
      return unknown(`path-type-mismatch at depth ${hit.depth} of ${where}`, { path: spec.path });
    }
    return { state: FIELD_STATE.OK, value: hit.outcome === 'value' };
  }

  if (hit.outcome === 'not-indexable') {
    // Schema drift: the payload changed shape under us. Never guess.
    return unknown(`path-type-mismatch: non-container at depth ${hit.depth} of ${where}`, {
      path: spec.path,
    });
  }

  if (hit.outcome !== 'value') {
    const missingKind = hit.outcome.startsWith('null') ? 'payload-null' : 'path-unresolved';

    // A field the map flags as framing-dependent can be missing purely
    // because this response framing does not emit it. That is NOT evidence
    // the business lacks the field, so it stays 'unknown'.
    if (spec.framingDependent && missingKind === 'path-unresolved') {
      return unknown(
        `framing-omits-field: "${mapName}" is not emitted by "${framing ?? 'unknown'}" framing`,
        { path: spec.path, framingOmitted: true }
      );
    }
    // The map records, with fixture evidence, that some businesses simply do
    // not have this field. A resolved-to-nothing path is then real information.
    if (spec.absenceIsExpected || missingKind === 'payload-null') {
      return absent(`${missingKind} at depth ${hit.depth} of ${where}`);
    }
    return unknown(`${missingKind} at depth ${hit.depth} of ${where}`, { path: spec.path });
  }

  return checkType(hit.value, spec, mapName);
}

function checkType(value, spec, mapName) {
  const want = spec.type;

  if (want === 'string') {
    if (typeof value !== 'string') {
      return unknown(`type-mismatch: "${mapName}" expected string, got ${describe(value)}`);
    }
    const trimmed = value.trim();
    if (trimmed === '') return absent(`empty-string at "${mapName}"`);
    return ok(trimmed);
  }

  if (want === 'number') {
    if (typeof value !== 'number') {
      return unknown(`type-mismatch: "${mapName}" expected number, got ${describe(value)}`);
    }
    if (!Number.isFinite(value)) {
      return unknown(`non-finite-number at "${mapName}"`);
    }
    return ok(value);
  }

  if (want === 'boolean') {
    if (typeof value !== 'boolean') {
      return unknown(`type-mismatch: "${mapName}" expected boolean, got ${describe(value)}`);
    }
    return ok(value);
  }

  // Untyped entry in the map: pass the value through unmodified rather than
  // inventing a coercion rule the map never authorised.
  return ok(value);
}

/* ------------------------------------------------------------------ */
/* Phone normalization                                                 */
/* ------------------------------------------------------------------ */

/**
 * Indian phone renderings observed in the corpus:
 *   "+91 90000 12345"   E.164 with spaces
 *   "090000 12345"      national form, leading trunk 0
 *   "09000012345"       national form, no spaces
 *   "+91 731 400 1234"  landline, STD code + subscriber number
 *
 * Rule: reduce to digits, strip a 91 country code or a leading trunk 0, and
 * require EXACTLY 10 national digits. Anything else is rejected — a mangled
 * number on a call sheet is worse than a blank one.
 *
 * @returns {{ value: string|null, reason: string|null }}
 */
export function normalizeIndianPhone(raw) {
  if (typeof raw !== 'string') {
    return { value: null, reason: `phone-not-a-string: got ${describe(raw)}` };
  }

  // Scoped to the phone node only — never a regex over a whole payload.
  const cleaned = raw.trim();

  // Reject anything carrying an extension marker; we cannot dial it reliably.
  // Word-boundaried so that "Fax 0731 …" is not read as an extension.
  if (/(?:\bext\b|\bextn\b|\bx)\s*\.?\s*\d/i.test(cleaned)) {
    return { value: null, reason: `phone-has-extension: ${JSON.stringify(raw)}` };
  }

  const digits = cleaned.replace(/\D/g, '');
  if (digits === '') {
    return { value: null, reason: `phone-no-digits: ${JSON.stringify(raw)}` };
  }

  let national = null;
  if (cleaned.startsWith('+')) {
    if (!digits.startsWith('91')) {
      return { value: null, reason: `phone-not-indian-country-code: ${JSON.stringify(raw)}` };
    }
    national = digits.slice(2);
  } else if (digits.length === 12 && digits.startsWith('91')) {
    national = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    national = digits.slice(1);
  } else {
    national = digits;
  }

  if (national.length !== 10) {
    return {
      value: null,
      reason: `phone-not-10-national-digits: got ${national.length} from ${JSON.stringify(raw)}`,
    };
  }
  return { value: `+91${national}`, reason: null };
}

/* ------------------------------------------------------------------ */
/* Website classification                                              */
/* ------------------------------------------------------------------ */

// Host extraction without try/catch and without new URL(): a malformed URL is
// a data condition to report, not an exception to swallow.
const HOST_RE = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/(?:[^/?#@]*@)?([^/?#:]+)/;

/** @returns {string|null} lowercase hostname, or null if none could be read. */
export function websiteHost(url) {
  if (typeof url !== 'string') return null;
  const m = HOST_RE.exec(url.trim());
  if (!m) return null;
  const host = m[1].toLowerCase().replace(/\.$/, '');
  return host === '' ? null : host;
}

/**
 * True when the "website" is really a social/directory profile.
 * Matched against the HOSTNAME only — a substring test over the whole URL
 * would classify https://mysite.com/?ref=facebook.com as social.
 *
 * @param {string[]} socialDomains injected for testability; defaults to the
 *   single list already in src/selectors.js
 */
export function isSocialHost(host, socialDomains = SOCIAL_DOMAINS) {
  if (typeof host !== 'string' || host === '') return null;
  return socialDomains.some((d) => host === d || host.endsWith(`.${d}`));
}

/* ------------------------------------------------------------------ */
/* Record parsing                                                      */
/* ------------------------------------------------------------------ */

/**
 * Parse one record node (already unwrapped via recordRoot.elementUnwrap).
 *
 * @param {unknown} recordNode
 * @param {number} index          record position, used in error messages
 * @param {object} fieldMap       injectable; defaults to config/field-map.json
 * @param {string|null} framing   'initial' | 'pagination' | null if unknown
 * @returns {object} Place
 * @throws if a REQUIRED field (cid, name) cannot be extracted
 */
export function parseOneRecord(recordNode, index = 0, fieldMap = DEFAULT_FIELD_MAP, framing = null) {
  if (recordNode === null || typeof recordNode !== 'object') {
    throw new Error(
      `parse: record ${index} is not a container (got ${describe(recordNode)}); ` +
      'recordRoot.elementUnwrap may be stale — re-capture and re-run discovery'
    );
  }

  const place = {};
  const meta = { fields: {}, unmapped: [], framing, recordIndex: index };

  for (const placeKey of Object.keys(FIELD_BINDINGS)) {
    const result = extractField(recordNode, placeKey, fieldMap, framing);
    place[placeKey] = result.value;
    meta.fields[placeKey] = stripValue(result);
    if (result.state === FIELD_STATE.UNMAPPED) meta.unmapped.push(placeKey);
  }

  // Phone: normalize in place. A number that will not normalize becomes null
  // with a reason — never a mangled string on the call sheet.
  if (meta.fields.phone.state === FIELD_STATE.OK) {
    const rawPhone = place.phone;
    const { value, reason } = normalizeIndianPhone(rawPhone);
    if (value === null) {
      place.phone = null;
      meta.fields.phone = { state: FIELD_STATE.UNKNOWN, reason, raw: rawPhone };
    } else {
      place.phone = value;
      if (value !== rawPhone) meta.fields.phone = { state: FIELD_STATE.OK, raw: rawPhone };
    }
  }

  // Derived: hasWebsite / isSocialOnly.
  // 'unknown' website must NOT become hasWebsite:false — that mistake is
  // worth +40 gap points per record to the scorer (REVIEW.md S2-1).
  const websiteState = meta.fields.website.state;
  if (websiteState === FIELD_STATE.OK) {
    place.hasWebsite = true;
    const host = websiteHost(place.website);
    if (host === null) {
      place.isSocialOnly = null;
      meta.fields.isSocialOnly = {
        state: FIELD_STATE.UNKNOWN,
        reason: `website-host-unreadable: ${JSON.stringify(place.website)}`,
      };
    } else {
      place.isSocialOnly = isSocialHost(host);
      meta.fields.isSocialOnly = { state: FIELD_STATE.OK, host };
    }
    meta.fields.hasWebsite = { state: FIELD_STATE.OK };
  } else if (websiteState === FIELD_STATE.ABSENT) {
    place.hasWebsite = false;
    place.isSocialOnly = false;
    meta.fields.hasWebsite = { state: FIELD_STATE.OK, derivedFrom: 'website:absent' };
    meta.fields.isSocialOnly = { state: FIELD_STATE.OK, derivedFrom: 'website:absent' };
  } else {
    place.hasWebsite = null;
    place.isSocialOnly = null;
    const reason = `website-${websiteState}: ${meta.fields.website.reason ?? 'no reason recorded'}`;
    meta.fields.hasWebsite = { state: FIELD_STATE.UNKNOWN, reason };
    meta.fields.isSocialOnly = { state: FIELD_STATE.UNKNOWN, reason };
  }

  // Derived: hasHours / hasPhotos. Same discipline as hasWebsite — an
  // unresolved source field must yield null, never false, or a drifted path
  // silently awards a gap signal to every record.
  const hoursState = meta.fields.hours.state;
  if (hoursState === FIELD_STATE.OK) {
    place.hasHours = Array.isArray(place.hours) && place.hours.length > 0;
    meta.fields.hasHours = { state: FIELD_STATE.OK };
  } else if (hoursState === FIELD_STATE.ABSENT) {
    place.hasHours = false;
    meta.fields.hasHours = { state: FIELD_STATE.OK, derivedFrom: 'hours:absent' };
  } else {
    place.hasHours = null;
    meta.fields.hasHours = { state: hoursState, reason: `hours-${hoursState}` };
  }

  const photoState = meta.fields.photoCount.state;
  if (photoState === FIELD_STATE.OK) {
    place.hasPhotos = Number(place.photoCount) > 0;
    meta.fields.hasPhotos = { state: FIELD_STATE.OK };
  } else if (photoState === FIELD_STATE.ABSENT) {
    // The payload gives a stub with no hero image. Consistent with zero photos
    // but never observed as an explicit 0, so photoCount stays null.
    place.hasPhotos = false;
    meta.fields.hasPhotos = { state: FIELD_STATE.OK, derivedFrom: 'photoCount:absent' };
  } else {
    place.hasPhotos = null;
    meta.fields.hasPhotos = { state: photoState, reason: `photoCount-${photoState}` };
  }

  for (const key of REQUIRED_FIELDS) {
    if (place[key] === null) {
      const info = meta.fields[key];
      throw new Error(
        `parse: required field "${key}" (map field "${FIELD_BINDINGS[key]}") did not ` +
        `resolve for record index ${index} [framing=${framing ?? 'unknown'}] — ` +
        `state=${info.state}, reason=${info.reason ?? 'none recorded'}`
      );
    }
  }

  Object.defineProperty(place, '_meta', { value: meta, enumerable: true, writable: false });
  return place;
}

function stripValue({ value, ...rest }) {
  return rest;
}

/* ------------------------------------------------------------------ */
/* Response parsing                                                    */
/* ------------------------------------------------------------------ */

/**
 * Full result of parsing a response, including the observability the runner
 * needs (framing, container length, skipped entries).
 *
 * @param {string} rawBody
 * @param {object} fieldMap injectable; defaults to config/field-map.json
 */
export function parseSearchResponseDetailed(rawBody, fieldMap = DEFAULT_FIELD_MAP) {
  const { framing, payload } = decodeResponseBody(rawBody);

  const root = fieldMap?.recordRoot;
  if (!root || !Array.isArray(root.containerPath) || !Array.isArray(root.elementUnwrap)) {
    throw new Error('parse: field map has no usable recordRoot (containerPath / elementUnwrap)');
  }

  const containerHit = resolvePath(payload, root.containerPath);
  if (containerHit.outcome !== 'value' || !Array.isArray(containerHit.value)) {
    throw new Error(
      `parse: record container ${JSON.stringify(root.containerPath)} did not resolve to an ` +
      `array (outcome=${containerHit.outcome}, got ${describe(containerHit.value)}) ` +
      `in "${framing}" response — field map may be stale; re-capture and re-run discovery`
    );
  }

  const container = containerHit.value;
  const records = [];
  const skipped = [];

  for (let i = 0; i < container.length; i += 1) {
    const nodeHit = resolvePath(container[i], root.elementUnwrap);
    if (nodeHit.outcome !== 'value' || nodeHit.value === null || typeof nodeHit.value !== 'object') {
      // Reported, never silently dropped: the runner surfaces this count.
      skipped.push({
        index: i,
        reason: `element-unwrap ${JSON.stringify(root.elementUnwrap)} gave ${nodeHit.outcome}` +
          ` (${describe(nodeHit.value)})`,
      });
      continue;
    }
    records.push(parseOneRecord(nodeHit.value, i, fieldMap, framing));
  }

  return { framing, containerLength: container.length, records, skipped };
}

/**
 * @param {string} rawBody raw intercepted response body
 * @param {object} fieldMap injectable; defaults to config/field-map.json
 * @returns {object[]} Place records
 */
export function parseSearchResponse(rawBody, fieldMap = DEFAULT_FIELD_MAP) {
  return parseSearchResponseDetailed(rawBody, fieldMap).records;
}

/* ------------------------------------------------------------------ */
/* Null-rate support (pure; the runner decides what to do with it)     */
/* ------------------------------------------------------------------ */

/**
 * Per-field tallies over a set of Places. Keeps 'absent' and 'unknown'
 * separate so a caller can enforce the >30% rule on whichever it means.
 *
 * `nullRate` counts every non-value state (absent + unknown + unmapped),
 * i.e. the rate at which the CSV column would be blank.
 *
 * `framingOmitted` counts the subset of 'unknown' caused solely by a response
 * framing that does not emit the field (reviewCount in "initial" responses).
 * It is broken out so the runner's ">30% null is a bug" rule can be applied to
 * genuine extraction failures without either firing spuriously on every mixed
 * run OR being silenced wholesale — which would hide a real regression.
 * `unresolvedRate` is the number to enforce that rule against.
 */
export function nullRateTable(places) {
  const table = {};
  for (const key of PLACE_FIELDS) {
    table[key] = {
      total: 0, ok: 0, absent: 0, unknown: 0, unmapped: 0,
      framingOmitted: 0, nullRate: 0, unresolvedRate: 0,
    };
  }
  for (const place of places) {
    const fields = place?._meta?.fields ?? {};
    for (const key of PLACE_FIELDS) {
      const row = table[key];
      row.total += 1;
      const entry = fields[key];
      const state = entry?.state;
      if (state === FIELD_STATE.OK) row.ok += 1;
      else if (state === FIELD_STATE.ABSENT) row.absent += 1;
      else if (state === FIELD_STATE.UNMAPPED) row.unmapped += 1;
      else {
        row.unknown += 1;
        if (entry?.framingOmitted === true) row.framingOmitted += 1;
      }
    }
  }
  for (const key of PLACE_FIELDS) {
    const row = table[key];
    row.nullRate = row.total === 0 ? 0 : (row.total - row.ok) / row.total;
    row.unresolvedRate = row.total === 0
      ? 0
      : (row.unknown - row.framingOmitted + row.unmapped) / row.total;
  }
  return table;
}
