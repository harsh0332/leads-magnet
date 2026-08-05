/** Chains scrape → score → report in one command. */

import { spawnSync } from 'child_process';
import { args, log } from './utils.js';

const { city, category } = args;
if (!city || !category) {
  console.error('Usage: npm run pipeline -- --city=Indore --category=dentist');
  process.exit(1);
}

const runId = `${city}-${category}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`
  .toLowerCase().replace(/\s+/g, '-');

const passthrough = process.argv.slice(2).filter((a) => !a.startsWith('--run='));

const step = (name, script, extra) => {
  log(`\n━━━ ${name} ━━━`);
  const r = spawnSync('node', [script, ...extra], { stdio: 'inherit' });
  if (r.status !== 0) { log(`✗ ${name} failed — stopping.`); process.exit(r.status); }
};

step('SCRAPE', 'src/scraper.js', passthrough);
step('SCORE', 'src/score.js', [`--run=${runId}`]);
step('REPORT', 'src/report.js', [`--run=${runId}`]);

log(`\n✓ Pipeline complete → output/${runId}/REPORT.md`);
