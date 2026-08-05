/**
 * Lead scoring. The MODEL is unchanged and deliberate — two independent axes,
 * gap x demand, with the tier thresholds documented in
 * .agents/rules/20-scoring.md. Change that file first, then this one.
 *
 *   gap    = how broken their digital presence is
 *   demand = how much business they already do
 *
 * WHAT CHANGED IN THIS REVISION (and why it is not a redesign):
 *
 * Three gap signals have no path in config/field-map.json and therefore cannot
 * be observed at all: isUnclaimed (25), noHours (12), noPhotos (12). That is 49
 * of the 107-point positive budget.
 *
 * Leaving those weights in place would NOT be neutral. A business with no
 * website and few reviews would score 40 + 8 = 48 against a Tier A floor of 50
 * — every lead in the corpus would land one or two points short of the tier it
 * belongs in, and the report would say "Tier A: 0" while looking perfectly
 * correct. That is REVIEW.md S1-1 by a different route.
 *
 * So the available signals are rescaled to preserve their ratios and the
 * original maximum. The rescale is computed at RUNTIME from which fields the
 * field map actually provides, so when `discover` maps isUnclaimed the weights
 * revert automatically and nobody has to remember to undo anything.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { args, readCsv, writeCsv, log } from './utils.js';

/* ------------------------------------------------------------------ */
/* Weights — base values live in .agents/rules/20-scoring.md           */
/* ------------------------------------------------------------------ */

const BASE_GAP = {
  noWebsite: 40,
  socialOnly: 32,
  unclaimed: 25,
  noHours: 12,
  noPhotos: 12,
  poorRating: 10,
  fewReviews: 8,
};

/** Penalty, not a gap signal. Never rescaled. */
const NO_PHONE_PENALTY = -25;

/** Which Place field each gap signal needs in order to be observable. */
const SIGNAL_REQUIRES = {
  noWebsite: 'website',
  socialOnly: 'website',
  unclaimed: 'isUnclaimed',
  noHours: 'hours',
  noPhotos: 'photoCount',
  poorRating: 'rating',
  fewReviews: 'reviewCount',
};

/**
 * noWebsite and socialOnly are mutually exclusive — a record scores one or the
 * other, never both — so only the larger counts toward the achievable maximum.
 */
function positiveMax(weights, available) {
  let total = 0;
  let exclusiveBest = 0;
  for (const [signal, w] of Object.entries(weights)) {
    if (!available.has(signal)) continue;
    if (signal === 'noWebsite' || signal === 'socialOnly') exclusiveBest = Math.max(exclusiveBest, w);
    else total += w;
  }
  return total + exclusiveBest;
}

/**
 * Rescale the observable signals so they keep their relative weighting and the
 * original achievable maximum. Returns the weights actually used plus a record
 * of what was dropped, which the report prints — a silently reweighted model is
 * exactly as dangerous as a silently broken field.
 */
export function resolveWeights(mappedFields) {
  const available = new Set(
    Object.keys(BASE_GAP).filter((s) => mappedFields.has(SIGNAL_REQUIRES[s]))
  );
  const dropped = Object.keys(BASE_GAP).filter((s) => !available.has(s));

  const before = positiveMax(BASE_GAP, new Set(Object.keys(BASE_GAP)));
  const after = positiveMax(BASE_GAP, available);
  const scale = after > 0 ? before / after : 1;

  const weights = {};
  for (const signal of available) weights[signal] = Math.round(BASE_GAP[signal] * scale * 10) / 10;

  return { weights, dropped, scale, before, after };
}

/* ------------------------------------------------------------------ */
/* Demand — unchanged                                                  */
/* ------------------------------------------------------------------ */

export function demandScore(reviews) {
  const r = reviews ?? 0;
  if (r >= 500) return 100;
  if (r >= 200) return 90;
  if (r >= 75) return 75;
  if (r >= 30) return 55;
  if (r >= 10) return 30;
  return 10;
}

/* ------------------------------------------------------------------ */
/* Row helpers                                                         */
/* ------------------------------------------------------------------ */

/** readCsv gives null for an empty cell, which is the honest value. */
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const truthy = (v) => v === 'true' || v === true;
const isFalse = (v) => v === 'false' || v === false;

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

export function scoreRow(row, W) {
  const reviews = num(row.reviewCount);
  const rating = num(row.rating);
  const phone = (row.phone ?? '').trim();

  let gap = 0;
  const reasons = [];

  // Website: the core pitch. `hasWebsite` is null when extraction FAILED, as
  // opposed to false when the listing genuinely has none — a null must never
  // be scored as a gap, or a broken path awards the largest weight to everyone.
  if (isFalse(row.hasWebsite)) {
    if (W.noWebsite) { gap += W.noWebsite; reasons.push('no website'); }
  } else if (truthy(row.isSocialOnly)) {
    if (W.socialOnly) { gap += W.socialOnly; reasons.push('social/directory page only'); }
  }

  if (W.unclaimed && truthy(row.isUnclaimed)) { gap += W.unclaimed; reasons.push('listing unclaimed'); }
  if (W.noHours && isFalse(row.hasHours)) { gap += W.noHours; reasons.push('no hours'); }
  if (W.noPhotos && isFalse(row.hasPhotos)) { gap += W.noPhotos; reasons.push('no photos'); }

  if (W.poorRating && rating !== null && rating < 4.0 && (reviews ?? 0) >= 20) {
    gap += W.poorRating; reasons.push(`rating ${rating}`);
  }
  // Only assert "few reviews" when the count was actually observed. In an
  // "initial" payload reviewCount is omitted entirely, and treating an
  // unobserved count as 0 would award this to every such record.
  if (W.fewReviews && reviews !== null && reviews < 10) {
    gap += W.fewReviews; reasons.push('under 10 reviews');
  }

  if (!phone) { gap += NO_PHONE_PENALTY; reasons.push('no phone listed'); }

  gap = Math.max(0, Math.min(100, Math.round(gap * 10) / 10));

  const demand = demandScore(reviews);
  const likelyEnterprise = (reviews ?? 0) >= 2000;

  let tier = 'X';
  if (likelyEnterprise) tier = 'C';
  else if (gap >= 50 && demand >= 55 && phone) tier = 'A';
  else if (gap >= 40 && demand >= 30 && phone) tier = 'B';
  else if (gap >= 30 && phone) tier = 'C';

  return {
    ...row,
    gapScore: gap,
    demandScore: demand,
    tier,
    likelyEnterprise,
    gapReasons: reasons.join('; '),
  };
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function loadBlacklist() {
  const file = path.join('config', 'blacklist.json');
  if (!fs.existsSync(file)) return new Set();
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new Set(Array.isArray(parsed) ? parsed : (parsed.cids ?? []));
}

function mappedFieldsFromMap() {
  const file = path.join('config', 'field-map.json');
  const map = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new Set(Object.keys(map.fields ?? {}));
}

export const LEAD_HEADERS = Object.freeze([
  'tier', 'name', 'phone', 'area', 'category', 'rating', 'reviewCount',
  'gapReasons', 'gapScore', 'demandScore', 'website', 'address',
  'lat', 'lng', 'cid', 'placeId',
]);

function main() {
  const runId = args.run;
  if (!runId) { console.error('Usage: npm run score -- --run=<runId>'); process.exit(1); }

  const OUT = path.join('output', runId);
  const raw = readCsv(path.join(OUT, 'raw.csv'));

  const mapped = mappedFieldsFromMap();
  const { weights, dropped, scale } = resolveWeights(mapped);

  if (dropped.length) {
    log(`Gap signals unavailable (no field-map path): ${dropped.join(', ')}`);
    log(`Remaining weights rescaled x${scale.toFixed(3)} to preserve ratios and the 100-point ceiling:`);
    log(`  ${Object.entries(weights).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  }

  const blacklist = loadBlacklist();

  // Dedupe by cid ONLY.
  //
  // The previous implementation also deduped by phone digits, using one shared
  // Set for both keys. Fixture 007 proves why that is wrong: three legally
  // distinct CA firms at Astha Tower, Ujjain share the reception line
  // 0734 2XX XXXX (redacted). Phone-deduping silently deleted two real leads and counted
  // them as duplicates. cid is unique per business in the payload — it is the
  // correct and sufficient key.
  const seen = new Set();
  let blacklisted = 0;
  const unique = raw.filter((r) => {
    const key = r.cid ?? r.placeId;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    if (blacklist.has(key)) { blacklisted += 1; return false; }
    return true;
  });

  // permanentlyClosed has no field-map path, so the documented "always exclude
  // permanently closed" rule CANNOT be enforced yet. Filter on it only where it
  // was actually observed; never treat an unobserved value as false.
  const open = unique.filter((r) => !truthy(r.permanentlyClosed));

  const scored = open
    .map((r) => scoreRow(r, weights))
    .filter((r) => r.tier !== 'X')
    .sort((a, b) =>
      a.tier.localeCompare(b.tier) || b.demandScore - a.demandScore || b.gapScore - a.gapScore
    );

  writeCsv(path.join(OUT, 'leads.csv'), LEAD_HEADERS, scored);
  writeCsv(path.join(OUT, 'tier-a.csv'), LEAD_HEADERS, scored.filter((r) => r.tier === 'A'));

  const counts = scored.reduce((a, r) => ({ ...a, [r.tier]: (a[r.tier] ?? 0) + 1 }), {});
  log(`Scored ${scored.length} of ${raw.length} raw (${raw.length - unique.length} dupes, ${blacklisted} blacklisted)`);
  log(`A: ${counts.A ?? 0} · B: ${counts.B ?? 0} · C: ${counts.C ?? 0}`);
  log(`Next: npm run report -- --run=${runId}`);
}

// Only run when invoked directly. report.js imports LEAD_HEADERS from here, and
// a bare main() call would re-score the entire run on import.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) main();
