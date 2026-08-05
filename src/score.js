/**
 * Lead scoring. Weights and rationale documented in
 * .agents/rules/20-scoring.md — change that file first, then this one.
 *
 * Two independent axes:
 *   gap    = how broken their digital presence is
 *   demand = how much business they're already doing
 *
 * Tier A = high gap AND high demand AND reachable.
 */

import path from 'path';
import { args, readCsv, writeCsv, log } from './utils.js';

const GAP = {
  noWebsite: 40,
  socialOnly: 32,
  unclaimed: 25,
  noHours: 12,
  noPhotos: 12,
  poorRating: 10,      // < 4.0 with 20+ reviews
  fewReviews: 8,       // < 10 reviews
  noPhone: -25,
};

const bool = (v) => v === 'true' || v === true;
const num = (v) => (v === '' || v == null ? null : Number(v));

function demandScore(reviews) {
  const r = reviews ?? 0;
  if (r >= 500) return 100;
  if (r >= 200) return 90;
  if (r >= 75) return 75;
  if (r >= 30) return 55;
  if (r >= 10) return 30;
  return 10;
}

function scoreRow(row) {
  const reviews = num(row.reviewCount);
  const rating = num(row.rating);
  const hasWebsite = bool(row.hasWebsite);
  const socialOnly = bool(row.isSocialOnly);
  const phone = (row.phone || '').trim();

  let gap = 0;
  const reasons = [];

  if (!hasWebsite && !row.websiteUrl) { gap += GAP.noWebsite; reasons.push('no website'); }
  else if (socialOnly) { gap += GAP.socialOnly; reasons.push('social/directory page only'); }

  if (bool(row.isUnclaimed)) { gap += GAP.unclaimed; reasons.push('listing unclaimed'); }
  if (row.hasHours === 'false') { gap += GAP.noHours; reasons.push('no hours'); }
  if (row.hasPhotos === 'false') { gap += GAP.noPhotos; reasons.push('no photos'); }

  if (rating !== null && rating < 4.0 && (reviews ?? 0) >= 20) {
    gap += GAP.poorRating; reasons.push(`rating ${rating}`);
  }
  if ((reviews ?? 0) < 10) { gap += GAP.fewReviews; reasons.push('under 10 reviews'); }
  if (!phone) { gap += GAP.noPhone; reasons.push('no phone listed'); }

  gap = Math.max(0, Math.min(100, gap));

  const demand = demandScore(reviews);
  const likelyEnterprise = (reviews ?? 0) >= 2000;

  let tier = 'X';
  if (likelyEnterprise) tier = 'C';
  else if (gap >= 50 && demand >= 55 && phone) tier = 'A';
  else if (gap >= 40 && demand >= 30 && phone) tier = 'B';
  else if (gap >= 30 && phone) tier = 'C';

  return { ...row, gapScore: gap, demandScore: demand, tier, likelyEnterprise, gapReasons: reasons.join('; ') };
}

/* ---- main ---- */

const runId = args.run;
if (!runId) { console.error('Usage: npm run score -- --run=<runId>'); process.exit(1); }

const OUT = path.join('output', runId);
const raw = readCsv(path.join(OUT, 'raw.csv'));

// Dedupe by cid, then by phone.
const seen = new Set();
const unique = raw.filter((r) => {
  const key = r.cid || r.mapsUrl;
  const pkey = (r.phone || '').replace(/\D/g, '');
  if (seen.has(key) || (pkey && seen.has(pkey))) return false;
  seen.add(key); if (pkey) seen.add(pkey);
  return true;
});

const scored = unique
  .filter((r) => !bool(r.permanentlyClosed))
  .map(scoreRow)
  .filter((r) => r.tier !== 'X')
  .sort((a, b) =>
    a.tier.localeCompare(b.tier) || b.demandScore - a.demandScore || b.gapScore - a.gapScore
  );

const HEADERS = [
  'tier', 'name', 'phone', 'area', 'category', 'rating', 'reviewCount',
  'gapReasons', 'gapScore', 'demandScore', 'websiteUrl', 'address', 'mapsUrl',
];

writeCsv(path.join(OUT, 'leads.csv'), HEADERS, scored);
writeCsv(path.join(OUT, 'tier-a.csv'), HEADERS, scored.filter((r) => r.tier === 'A'));

const counts = scored.reduce((a, r) => ({ ...a, [r.tier]: (a[r.tier] || 0) + 1 }), {});
log(`Scored ${scored.length} of ${raw.length} raw (${raw.length - unique.length} dupes removed)`);
log(`A: ${counts.A || 0} · B: ${counts.B || 0} · C: ${counts.C || 0}`);
log(`Next: npm run report -- --run=${runId}`);
