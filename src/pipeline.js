/**
 * Single entry point: scrape -> score -> report. Stops on any non-zero exit.
 *
 *   npm run pipeline -- --city=Indore --category=dentist
 *   npm run pipeline -- --city=Indore --category=dentist --limit=5
 *   npm run pipeline -- --dry-run        # offline, against fixtures, seconds
 *
 * The runId is computed ONCE here and passed down to every step. The previous
 * implementation recomputed it in a second process from a second clock, using
 * UTC — so a run crossing local midnight scored a different directory than it
 * scraped, and for an IST operator any run started between 00:00 and 05:30
 * silently rescored the PREVIOUS day's data (REVIEW.md S2-8).
 */

import { spawnSync } from 'child_process';
import { args, log } from './utils.js';
import { resolveRunId } from './run-state.js';

const dryRun = args['dry-run'] === 'true' || args.dryRun === 'true';
const { city, category } = args;

if (!dryRun && (!city || !category)) {
  console.error('Usage: npm run pipeline -- --city=Indore --category=dentist [--limit=N]');
  console.error('       npm run pipeline -- --dry-run');
  process.exit(1);
}

const runId = resolveRunId({
  city: city ?? 'fixtures',
  category: category ?? 'dryrun',
  now: new Date(),
});

// Everything the operator passed, minus any --run they tried to set: this
// process owns the runId.
const passthrough = process.argv.slice(2).filter((a) => !a.startsWith('--run='));

function step(name, script, extra) {
  log('');
  log(`━━━ ${name} ━━━`);
  const r = spawnSync('node', [script, ...extra], { stdio: 'inherit' });
  if (r.status !== 0) {
    log('');
    log(`✗ ${name} failed (exit ${r.status}) — stopping. Nothing downstream ran.`);
    process.exit(r.status ?? 1);
  }
}

step('SCRAPE', 'src/scraper.js', [...passthrough, `--run=${runId}`]);
step('SCORE', 'src/score.js', [`--run=${runId}`]);
step('REPORT', 'src/report.js', [`--run=${runId}`]);

log('');
log(`✓ Pipeline complete → output/${runId}/REPORT.md`);
