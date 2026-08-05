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
