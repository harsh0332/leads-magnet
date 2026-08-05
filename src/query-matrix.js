/**
 * Query matrix: city x category -> the list of searches a run performs.
 *
 * Lifted verbatim in behaviour from the previous scraper's buildQueries().
 * That logic was correct and the operator relies on its error messages, so the
 * only change here is that it takes its inputs as arguments instead of reading
 * module-level CLI state.
 *
 * Iteration order is term-outer / area-inner, which is deliberate: with
 * --limit=N the operator gets N localities of the FIRST search term rather than
 * one locality across N terms. That makes a limited run a usable smoke test of
 * a real category instead of a scattered sample.
 */

import fs from 'fs';
import path from 'path';

const CONFIG_DIR = 'config';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** localities.json, read once per process. Not inside a hot loop. */
let _localities = null;
export function loadLocalities(configDir = CONFIG_DIR) {
  if (_localities === null) _localities = readJson(path.join(configDir, 'localities.json'));
  return _localities;
}

/**
 * @param {{ city: string, category: string, limit?: number|null,
 *           configDir?: string }} opts
 * @returns {string[]} e.g. ["dentist in Vijay Nagar Indore", ...]
 * @throws descriptive error naming the missing config key
 */
export function buildQueries({ city, category, limit = null, configDir = CONFIG_DIR }) {
  if (!city || !category) {
    throw new Error('buildQueries: both city and category are required');
  }

  const localities = readJson(path.join(configDir, 'localities.json'));
  const categories = readJson(path.join(configDir, 'categories.json'));

  const areas = localities[city];
  const terms = categories[category];

  if (!areas) {
    throw new Error(`City "${city}" not in config/localities.json — add it first.`);
  }
  if (!terms) {
    throw new Error(`Category "${category}" not in config/categories.json — add it first.`);
  }

  const queries = [];
  for (const term of terms) {
    for (const area of areas) queries.push(`${term} in ${area} ${city}`);
  }

  return limit ? queries.slice(0, Number(limit)) : queries;
}

/**
 * The locality a query targets, recovered from the query string.
 *
 * `area` has no path in config/field-map.json — it is not in the payload at
 * all. The scraper owns the query text, so it can supply this; a parser cannot
 * and must not invent it. Recorded per row as caller-supplied, never as
 * extracted data.
 *
 * @param {string} query
 * @param {string} city
 * @returns {string|null}
 */
export function areaFromQuery(query, city) {
  const marker = ' in ';
  const at = query.indexOf(marker);
  if (at === -1) return null;
  const tail = query.slice(at + marker.length).trim();
  if (!city) return tail || null;
  const cut = tail.toLowerCase().lastIndexOf(city.toLowerCase());
  const area = (cut > 0 ? tail.slice(0, cut) : tail).trim();
  return area || null;
}

/* ------------------------------------------------------------------ */
/* Area resolution — derive from the ADDRESS, not the query            */
/* ------------------------------------------------------------------ */

/**
 * Which city a query belongs to. The query tail is "<area> <City>", so the
 * city is whichever localities.json key the tail ends with.
 */
export function cityFromQuery(query, localities = loadLocalities()) {
  const tail = String(query ?? '').split(' in ').slice(1).join(' in ').trim().toLowerCase();
  if (!tail) return null;
  let best = null;
  for (const key of Object.keys(localities)) {
    if (key.startsWith('_')) continue;
    const k = key.toLowerCase();
    if (tail === k || tail.endsWith(` ${k}`)) {
      if (!best || key.length > best.length) best = key;
    }
  }
  return best;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Find which locality an address actually sits in.
 *
 * Google bleeds results across locality boundaries — a business surfaced by the
 * "Vijay Nagar" query frequently sits in Nipania or Mahalaxmi Nagar — so the
 * query locality is a search parameter, not a fact about the business.
 *
 * Matching is deliberately strict:
 *   - word-boundary anchored, so "Rau" does not match "Raunak Tower"
 *   - longest match wins, so "Vijay Nagar" beats a bare "Nagar"
 *   - scoped to one city's list, so a city name can never be returned as an area
 *
 * A loose matcher here is worse than no matcher: it would relabel most records
 * with a confident, wrong locality. Returns null when nothing matches, and the
 * caller falls back to the query with areaSource='query'.
 */
export function areaFromAddress(address, areas) {
  if (typeof address !== 'string' || !address.trim()) return null;
  if (!Array.isArray(areas) || areas.length === 0) return null;

  let best = null;
  for (const area of areas) {
    const a = String(area).trim();
    if (!a) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(a)}([^\\p{L}\\p{N}]|$)`, 'iu');
    if (re.test(address) && (!best || a.length > best.length)) best = a;
  }
  return best;
}

/**
 * Resolve the area for one record.
 * @returns {{area: string|null, areaSource: 'address'|'query'|'none', queryArea: string|null}}
 */
export function resolveArea({ address, query, city, localities = loadLocalities() }) {
  const resolvedCity = city || cityFromQuery(query, localities);
  const queryArea = areaFromQuery(query, resolvedCity ?? '');
  const areas = resolvedCity ? localities[resolvedCity] : null;
  const fromAddress = areaFromAddress(address, areas);

  if (fromAddress) return { area: fromAddress, areaSource: 'address', queryArea };
  if (queryArea) return { area: queryArea, areaSource: 'query', queryArea };
  return { area: null, areaSource: 'none', queryArea: null };
}

/* ------------------------------------------------------------------ */
/* Adaptive query plan                                                 */
/* ------------------------------------------------------------------ */

/** Tuning for the per-locality early exit. Documented in AGENTS.md. */
// Threshold set from measured data, not intuition. The specialist terms
// (orthodontist, dental surgeon, implant clinic) recover into a 0.17-0.28
// new-record band AFTER two weak terms, because they surface partly disjoint
// businesses -- which is why the synonym list exists. A 0.20 floor cut exactly
// those terms: 43% of queries saved but 19.1% of unique records lost. A 0.10
// floor sits below the recovery band: 17% saved for 1.3% lost.
export const ADAPTIVE = Object.freeze({
  minTerms: 2,            // always run at least this many terms per locality
  newRatioFloor: 0.10,    // below this, a term counts as "exhausted"
  consecutiveToStop: 2,   // this many exhausted terms in a row ends the locality
});

/**
 * Queries grouped by locality, so a run can stop early on a locality that has
 * stopped yielding anything new.
 *
 * NOTE the ordering inversion. buildQueries() is term-outer/area-inner, which
 * makes --limit=N a sample of N localities of the first term. A per-locality
 * early exit needs all terms for one locality adjacent, so this is
 * area-outer/term-inner and --limit=N caps TOTAL queries across whole
 * localities. Both are exported; the adaptive scraper path uses this one.
 *
 * @returns {{area: string, queries: string[]}[]}
 */
export function buildQueryPlan({ city, category, limit = null, configDir = CONFIG_DIR }) {
  if (!city || !category) {
    throw new Error('buildQueryPlan: both city and category are required');
  }

  const localities = readJson(path.join(configDir, 'localities.json'));
  const categories = readJson(path.join(configDir, 'categories.json'));

  const areas = localities[city];
  const terms = categories[category];

  if (!areas) throw new Error(`City "${city}" not in config/localities.json — add it first.`);
  if (!terms) throw new Error(`Category "${category}" not in config/categories.json — add it first.`);

  const plan = [];
  let budget = limit ?? Infinity;

  for (const area of areas) {
    if (budget <= 0) break;
    const queries = terms.slice(0, Math.max(0, budget)).map((t) => `${t} in ${area} ${city}`);
    if (!queries.length) break;
    plan.push({ area, queries });
    budget -= queries.length;
  }
  return plan;
}

/**
 * Decide whether to keep going in a locality.
 *
 * `ratios` is every term's newRecordRatio so far, in order. A term that
 * returned nothing at all is NOT counted as exhausted — zero results is a
 * different failure (block, or a thin locality) and the run's empty-query
 * guard owns it. Treating it as exhaustion would silently truncate a locality
 * that a transient failure hit.
 */
export function shouldStopLocality(ratios, cfg = ADAPTIVE) {
  if (ratios.length < cfg.minTerms) return false;
  const tail = ratios.slice(-cfg.consecutiveToStop);
  if (tail.length < cfg.consecutiveToStop) return false;
  return tail.every((r) => r !== null && r < cfg.newRatioFloor);
}
