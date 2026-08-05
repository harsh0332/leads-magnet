/**
 * FIXTURE CAPTURE — camera only. Captures raw Google Maps network payloads to disk
 * so every other agent in this project can work offline against real bytes.
 *
 * This script does NOT parse, clean, prettify, decode, or interpret anything.
 * Raw response bodies are written verbatim as Buffers, junk prefix included.
 *
 *   node scripts/capture-fixtures.js              # headless (default)
 *   node scripts/capture-fixtures.js --headed
 *
 * Hard 900s global watchdog. Browser closed in finally. Each query isolated.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SCROLL LOOP HERE MUST MIRROR src/scraper.js scrollAndCollect()
 * ---------------------------------------------------------------------------
 * A fixture corpus is a sample of a TRAFFIC PATTERN, not just of payloads.
 * The v1 capture took 3 scrolls per query; the live scraper takes up to 25 and
 * exits after two idle scrolls. Google re-sends earlier records in later
 * responses, and `reviewCount` exists ONLY in pagination responses — so the
 * short capture left 47% of records initial-only and `reviewCount` 50% null,
 * against 5% live. `--dry-run` therefore produced Tier A = 0 while the same
 * code produced Tier A = 11 live: a regression harness that could not fail on
 * the bug it exists to catch.
 *
 * So this loop is a deliberate mirror of scrollAndCollect(). If the scraper's
 * traffic pattern changes, change this with it and re-capture.
 * See .agents/rules/10-fixtures.md.
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HEADED = process.argv.includes('--headed');
// Resume support: --from=N skips the first N queries, for appending to a corpus
// that is already partly captured. Sequence numbering continues from whatever is
// already on disk, so a resumed run never overwrites an existing fixture.
const FROM = Number(
  (process.argv.find((a) => a.startsWith('--from=')) ?? '--from=0').split('=')[1]
);
// 16 queries x up to 25 scrolls. Measured: ~43s/query typical, ~107s worst case,
// plus 15s between queries. 40 minutes covers the worst case with headroom.
const GLOBAL_TIMEOUT_MS = 2_400_000;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'fixtures', 'raw');
fs.mkdirSync(OUT_DIR, { recursive: true });

/**
 * The corpus is 4 localities x 4 sibling terms.
 *
 * The sibling terms are NOT padding. Capture round 1 used only the 4 leading
 * terms — one trade per locality, three cities — and measured 19.9% initial-only
 * against 5% for a live run. Per query, initial-only sat at a near-constant
 * 14-18 records no matter how deep the scroll went, because nothing ever
 * re-surfaced a query's own initial records. Scroll depth cannot fix that; only
 * OVERLAP can, and overlap comes from sibling terms on the SAME locality, which
 * is what a real run issues (the live comparison run was 6 terms x Vijay Nagar
 * + 4 terms x New Palasia).
 *
 * Every term below appears in config/categories.json, so the corpus stays
 * representative of the queries the pipeline actually generates.
 */
const QUERIES = [
  // -- Vijay Nagar, Indore
  'dentist in Vijay Nagar Indore',
  'dental clinic in Vijay Nagar Indore',
  'dental hospital in Vijay Nagar Indore',
  'orthodontist in Vijay Nagar Indore',
  // -- MP Nagar, Bhopal
  'interior designer in MP Nagar Bhopal',
  'interior decorator in MP Nagar Bhopal',
  'modular kitchen in MP Nagar Bhopal',
  'home interior in MP Nagar Bhopal',
  // -- Rau, Indore
  'gym in Rau Indore',
  'fitness centre in Rau Indore',
  'health club in Rau Indore',
  'crossfit in Rau Indore',
  // -- Freeganj, Ujjain
  'chartered accountant in Freeganj Ujjain',
  'CA firm in Freeganj Ujjain',
  'tax consultant in Freeganj Ujjain',
  'GST consultant in Freeganj Ujjain',
];

// Mirrors CFG.maxScrolls in src/scraper.js.
const MAX_SCROLLS = 25;
// Mirrors the idle guard in scrollAndCollect(): two consecutive scrolls with no
// new payload means the list is exhausted. ONE is not enough — a slow batch
// looks identical to an exhausted one.
const IDLE_SCROLLS_TO_STOP = 2;
const FEED_SEL = 'div[role="feed"]';

// Production browser config — must match src/scraper.js exactly.
const LOCALE = 'en-IN';
const VIEWPORT = { width: 1440, height: 900 };
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// Phase 1 finding: BOTH the initial and the pagination payloads live at
// https://www.google.com/search?tbm=map . The pagination variant has NO q= param,
// so matching on q= would miss every pagination response. Match the tbm=map marker.
const isDataEndpoint = (url) => url.includes('tbm=map');

const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(`[${el()}]`, ...a);

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
// 3-5 second randomized delay between actions. DO NOT REDUCE.
// This sits ABOVE the live scraper's CFG.actionDelay of [1500, 3500]; capture
// is rare and deliberately more patient than a run. Waiting longer only gives a
// pagination batch more time to land, so it cannot degrade corpus fidelity.
const actionDelay = () => new Promise((r) => setTimeout(r, rand(3000, 5000)));
// 15 seconds between queries — inside the live [10000, 20000] budget. DO NOT REDUCE.
const queryDelay = () => new Promise((r) => setTimeout(r, 15_000));

/* ---------------- capture state ---------------- */

// Continue numbering after any fixture already on disk. Restarting at 001 would
// silently overwrite an earlier round's captures.
let seq = fs
  .readdirSync(OUT_DIR)
  .map((f) => Number((f.match(/^(\d+)-/) ?? [, 0])[1]))
  .reduce((m, n) => (Number.isFinite(n) && n > m ? n : m), 0);
let currentLabel = 'unknown';
const captured = []; // { file, urlFile, status, bytes, label }
const pendingWrites = new Set();
const errors = [];
const scrollReport = []; // { query, scrolls, reason, responses }

// Incremented SYNCHRONOUSLY in the response listener, mirroring the live
// scraper's `bodies.push(...)`. The idle check must not depend on how long a
// body takes to read off the wire.
let responseCount = 0;

function nextSeq() {
  seq += 1;
  return String(seq).padStart(3, '0');
}

/**
 * Registered BEFORE navigation. The initial payload arrives ~2s into load;
 * a listener attached afterwards misses it entirely.
 */
function attachCapture(page) {
  page.on('response', (resp) => {
    const url = resp.url();
    if (!isDataEndpoint(url)) return;

    responseCount += 1;

    const label = currentLabel;
    const n = nextSeq();

    const p = (async () => {
      let buf;
      try {
        buf = await resp.body();
      } catch (e) {
        errors.push(`body unreadable for ${n}-${label}: ${String(e.message).slice(0, 120)}`);
        return;
      }

      const base = `${n}-${label}`;
      const file = path.join(OUT_DIR, `${base}.txt`);
      const urlFile = path.join(OUT_DIR, `${base}.url.txt`);

      // Verbatim bytes. No JSON.parse, no trim, no re-serialize, no normalization.
      // If Google emitted a )]}' or /*""*/ prefix or a trailing /*""*/, it stays.
      // Written immediately on the response event, not batched to the end.
      fs.writeFileSync(file, buf);
      fs.writeFileSync(urlFile, url, 'utf8');

      captured.push({
        file: `${base}.txt`,
        urlFile: `${base}.url.txt`,
        status: resp.status(),
        bytes: buf.length,
        label,
      });
      log(`captured ${base}.txt  status=${resp.status()}  ${buf.length} bytes`);
    })();

    pendingWrites.add(p);
    p.finally(() => pendingWrites.delete(p));
  });
}

/* ---------------- watchdog ---------------- */

let finished = false;

const watchdog = setTimeout(() => {
  console.error(`\n[${el()}] WATCHDOG: ${GLOBAL_TIMEOUT_MS / 1000}s global timeout hit. Force-exiting.`);
  printManifest();
  process.exit(1);
}, GLOBAL_TIMEOUT_MS);

/* ---------------- manifest ---------------- */

function printManifest() {
  const files = fs
    .readdirSync(OUT_DIR)
    .filter((f) => f.endsWith('.txt') && !f.endsWith('.url.txt'))
    .sort();

  console.log('\n================ MANIFEST ================');
  let total = 0;
  for (const f of files) {
    const full = path.join(OUT_DIR, f);
    const buf = fs.readFileSync(full);
    total += buf.length;
    const head = buf.subarray(0, 120).toString('utf8');
    const meta = captured.find((c) => c.file === f);
    console.log(`\n--- ${f}`);
    console.log(`    size:   ${buf.length} bytes`);
    if (meta) console.log(`    status: ${meta.status}`);
    console.log(`    head120: ${JSON.stringify(head)}`);
  }
  console.log('\n------------------------------------------');
  console.log(`files: ${files.length}   total bytes: ${total}`);

  if (scrollReport.length) {
    console.log('\nSCROLLS PER QUERY:');
    for (const r of scrollReport) {
      console.log(`  ${r.query}: ${r.scrolls} scroll(s), exit=${r.reason}, ${r.responses} payload response(s)`);
    }
  }
  if (errors.length) {
    console.log('\nERRORS:');
    for (const e of errors) console.log(`  - ${e}`);
  }
  console.log('==========================================\n');
}

/* ---------------- main ---------------- */

async function runQuery(browser, query, qi) {
  const qslug = slug(query);
  const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en&gl=in`;

  const context = await browser.newContext({
    locale: LOCALE,
    viewport: VIEWPORT,
    userAgent: USER_AGENT,
  });
  const page = await context.newPage();

  const before = responseCount;
  let scrolls = 0;
  let reason = 'max-scrolls';

  try {
    // Listener BEFORE navigation.
    currentLabel = `${qslug}-initial`;
    attachCapture(page);

    log(`[q${qi + 1}] navigating: ${query}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    // Let the initial payload land (fires ~1.8-2.2s after navigation).
    await actionDelay();

    // Block / interstitial gate. A fixture we cannot vouch for is worse than
    // no fixture, so a suspicious page stops this query rather than being
    // worked around. We never solve or bypass anything.
    const landed = page.url();
    if (/\/sorry\/|consent\.google\./.test(landed)) {
      const shot = path.join(OUT_DIR, `BLOCKED-${qslug}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      errors.push(`[${query}] BLOCKED/INTERSTITIAL at ${landed} — evidence ${shot}`);
      log(`[q${qi + 1}] BLOCKED: ${landed} (screenshot ${shot})`);
      reason = 'blocked';
      return;
    }

    const feed = await page.$(FEED_SEL);
    if (!feed) {
      const shot = path.join(OUT_DIR, `NOFEED-${qslug}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      errors.push(`[${query}] feed selector ${FEED_SEL} not found — evidence ${shot}`);
      log(`[q${qi + 1}] WARNING: no feed element; skipping scrolls (screenshot ${shot})`);
      reason = 'no-feed';
      return;
    }

    // ---- mirror of scrollAndCollect() in src/scraper.js ----
    let lastCount = -1;
    let idle = 0;

    for (let s = 1; s <= MAX_SCROLLS; s++) {
      currentLabel = `${qslug}-scroll${s}`;
      scrolls = s;

      // Assigning scrollTop a value it already holds fires no scroll event, so
      // scrolls 2..N would be silent no-ops once we are pinned at the bottom.
      // Nudge up first, then scroll to bottom, so every iteration is a real scroll.
      const geo = await feed
        .evaluate((elm) => {
          elm.scrollTop = Math.max(0, elm.scrollTop - 600);
          elm.scrollTop = elm.scrollHeight;
          return { top: elm.scrollTop, height: elm.scrollHeight };
        })
        .catch(() => ({ top: -1, height: -1 }));

      await actionDelay();

      if (responseCount === lastCount) {
        idle += 1;
        log(
          `[q${qi + 1}] scroll ${s}  (top=${geo.top} height=${geo.height})  ` +
            `no new payload (idle ${idle}/${IDLE_SCROLLS_TO_STOP})`
        );
        if (idle >= IDLE_SCROLLS_TO_STOP) {
          reason = `idle-x${IDLE_SCROLLS_TO_STOP}`;
          break;
        }
      } else {
        idle = 0;
        lastCount = responseCount;
        log(
          `[q${qi + 1}] scroll ${s}  (top=${geo.top} height=${geo.height})  ` +
            `responses so far: ${responseCount - before}`
        );
      }
    }
  } finally {
    scrollReport.push({
      query,
      scrolls,
      reason,
      responses: responseCount - before,
    });
    await context.close().catch(() => {});
  }
}

async function main() {
  log(`starting capture (${HEADED ? 'headed' : 'headless'}) -> ${OUT_DIR}`);
  log(`maxScrolls=${MAX_SCROLLS}  idleStop=${IDLE_SCROLLS_TO_STOP}  queries=${QUERIES.length}`);
  if (FROM > 0) log(`--from=${FROM}: skipping the first ${FROM} query(ies); sequence resumes at ${String(seq + 1).padStart(3, '0')}`);
  const browser = await chromium.launch({ headless: !HEADED });

  try {
    for (let i = FROM; i < QUERIES.length; i++) {
      const q = QUERIES[i];
      try {
        await runQuery(browser, q, i);
      } catch (e) {
        errors.push(`[${q}] ${String(e.message).slice(0, 200)}`);
        log(`[q${i + 1}] FAILED: ${String(e.message).slice(0, 200)}`);
      }
      if (i < QUERIES.length - 1) {
        log(`inter-query delay 15s`);
        await queryDelay();
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // Drain any in-flight body writes (bounded — watchdog still governs).
  if (pendingWrites.size) {
    log(`draining ${pendingWrites.size} in-flight writes`);
    await Promise.race([
      Promise.allSettled([...pendingWrites]),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
  }

  finished = true;
  clearTimeout(watchdog);
  printManifest();
}

main()
  .catch((e) => {
    console.error(`[${el()}] FATAL:`, e);
    printManifest();
    process.exitCode = 1;
  })
  .finally(() => {
    if (!finished) clearTimeout(watchdog);
  });
