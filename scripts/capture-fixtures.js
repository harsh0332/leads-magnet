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
 * Hard 300s global watchdog. Browser closed in finally. Each query isolated.
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HEADED = process.argv.includes('--headed');
const GLOBAL_TIMEOUT_MS = 300_000;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'fixtures', 'raw');
fs.mkdirSync(OUT_DIR, { recursive: true });

const QUERIES = [
  'dentist in Vijay Nagar Indore',
  'interior designer in MP Nagar Bhopal',
  'gym in Rau Indore',
  'chartered accountant in Freeganj Ujjain',
];

const SCROLLS_PER_QUERY = 3;
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
const actionDelay = () => new Promise((r) => setTimeout(r, rand(3000, 5000)));
// 15 seconds between queries. DO NOT REDUCE.
const queryDelay = () => new Promise((r) => setTimeout(r, 15_000));

/* ---------------- capture state ---------------- */

let seq = 0;
let currentLabel = 'unknown';
const captured = []; // { file, urlFile, status, bytes, label, query, phase }
const pendingWrites = new Set();
const errors = [];

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
      // If Google emitted a )]}' or /*""*/ prefix, it stays.
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
  console.error(`\n[${el()}] WATCHDOG: 300s global timeout hit. Force-exiting.`);
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
    const head = buf.subarray(0, 200).toString('utf8');
    const meta = captured.find((c) => c.file === f);
    console.log(`\n--- ${f}`);
    console.log(`    size:   ${buf.length} bytes`);
    if (meta) console.log(`    status: ${meta.status}`);
    console.log(`    head200: ${JSON.stringify(head)}`);
  }
  console.log('\n------------------------------------------');
  console.log(`files: ${files.length}   total bytes: ${total}`);
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

  try {
    // Listener BEFORE navigation.
    currentLabel = `${qslug}-initial`;
    attachCapture(page);

    log(`[q${qi + 1}] navigating: ${query}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    // Let the initial payload land (fires ~1.8-2.2s after navigation).
    await actionDelay();

    const feed = await page.$(FEED_SEL);
    if (!feed) {
      errors.push(`[${query}] feed selector ${FEED_SEL} not found`);
      log(`[q${qi + 1}] WARNING: no feed element; skipping scrolls`);
      return;
    }

    for (let s = 1; s <= SCROLLS_PER_QUERY; s++) {
      currentLabel = `${qslug}-scroll${s}`;
      // Assigning scrollTop to a value it already holds fires no scroll event, so
      // scrolls 2..N would be silent no-ops once we are pinned at the bottom.
      // Nudge up first, then scroll to bottom, so every iteration is a real scroll.
      const geo = await feed.evaluate((elm) => {
        elm.scrollTop = Math.max(0, elm.scrollTop - 600);
        elm.scrollTop = elm.scrollHeight;
        return { top: elm.scrollTop, height: elm.scrollHeight };
      });
      log(`[q${qi + 1}] scroll ${s}  (scrollTop=${geo.top} scrollHeight=${geo.height})`);
      await actionDelay();
    }
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  log(`starting capture (${HEADED ? 'headed' : 'headless'}) -> ${OUT_DIR}`);
  const browser = await chromium.launch({ headless: !HEADED });

  try {
    for (let i = 0; i < QUERIES.length; i++) {
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
