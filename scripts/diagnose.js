/**
 * THROWAWAY DIAGNOSTIC — not production code. Safe to delete.
 *
 * Answers 6 questions about what Google Maps actually serves the scraper.
 * Hard 90s global watchdog. Browser closed in finally. Every probe isolated.
 *
 *   node scripts/diagnose.js              # headed
 *   node scripts/diagnose.js --headless   # headless
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const HEADLESS = process.argv.includes('--headless');
const MODE = HEADLESS ? 'headless' : 'headed';
const GLOBAL_TIMEOUT_MS = 90_000;

// NOTE: do not name this `URL` — it shadows the global URL constructor.
const TARGET_URL =
  'https://www.google.com/maps/search/dentist%20in%20Vijay%20Nagar%20Indore?hl=en&gl=in';

const SEL = {
  feed: 'div[role="feed"]',
  card: 'div[role="feed"] > div > div[jsaction]',
  placeLink: 'a[href*="/maps/place/"]',
  consentAccept: 'button[aria-label*="Accept all"], form[action*="consent"] button',
};

const OUT = path.join('output', '_diag');
fs.mkdirSync(OUT, { recursive: true });

const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const results = {
  mode: MODE,
  startedAt: new Date().toISOString(),
  build: {},
  q1_landing: null,
  q2_feed: null,
  q3_cards: null,
  q4_listOrPlace: null,
  q5_beforeScroll: null,
  q6_afterScroll: null,
  errors: [],
  completed: false,
};

/* ------------ response capture ------------ */
let phase = 'before-scroll';
let scrollMarkTs = null;
const pending = [];
const captured = [];

function attachResponseCapture(page) {
  page.on('response', (resp) => {
    const ts = Date.now();
    const req = resp.request();
    const p = (async () => {
      let bytes = null;
      let src = 'none';
      try {
        const buf = await resp.body();
        bytes = buf.length;
        src = 'body';
      } catch (e) {
        const h = resp.headers()['content-length'];
        if (h) {
          bytes = Number(h);
          src = 'content-length';
        } else {
          src = `unreadable: ${String(e.message).slice(0, 60)}`;
        }
      }
      if (bytes != null && bytes > 50 * 1024) {
        let u = resp.url();
        const qi = u.indexOf('?');
        if (qi !== -1) {
          const base = u.slice(0, qi);
          const q = u.slice(qi);
          u = base + (q.length > 120 ? q.slice(0, 120) + '…[truncated]' : q);
        }
        captured.push({
          phase,
          tSec: Number(((ts - t0) / 1000).toFixed(1)),
          afterScrollMark: scrollMarkTs != null && ts >= scrollMarkTs,
          method: req.method(),
          url: u,
          status: resp.status(),
          kb: Number((bytes / 1024).toFixed(1)),
          sizeSource: src,
        });
      }
    })().catch((e) => results.errors.push(`response-capture: ${e.message}`));
    pending.push(p);
  });
}

async function settleResponses() {
  await Promise.allSettled(pending.splice(0, pending.length));
}

/* ------------ probe wrapper ------------ */
async function probe(name, fn) {
  try {
    return await fn();
  } catch (e) {
    const msg = `${e.name}: ${e.message}`.split('\n')[0];
    results.errors.push(`${name} :: ${msg}`);
    console.log(`[${el()}] ${name} FAILED -> ${msg}`);
    return { error: msg };
  }
}

/* ------------ reporting ------------ */
function respTable(rows, label) {
  if (!rows.length) return `  (none >50KB) — ${label}`;
  return rows
    .map(
      (r) =>
        `  ${String(r.kb).padStart(8)}KB  ${String(r.status).padStart(3)}  ${r.method.padEnd(4)}  t=${String(r.tSec).padStart(5)}s  [${r.sizeSource}]\n      ${r.url}`
    )
    .join('\n');
}

function printReport(reason) {
  console.log(`\n${'='.repeat(78)}`);
  console.log(`VERDICT TABLE — mode=${MODE} — ${reason} — elapsed ${el()}`);
  console.log('='.repeat(78));
  console.log(`BROWSER BUILD: ${JSON.stringify(results.build, null, 2)}`);
  console.log(`\nQ1 landing page / consent:\n  ${JSON.stringify(results.q1_landing)}`);
  console.log(`\nQ2 div[role="feed"]:\n  ${JSON.stringify(results.q2_feed)}`);
  console.log(`\nQ3 result cards:\n  ${JSON.stringify(results.q3_cards)}`);
  console.log(`\nQ4 LIST vs SINGLE PLACE:\n  ${JSON.stringify(results.q4_listOrPlace)}`);
  console.log(`\nQ5 responses >50KB BEFORE SCROLL (${(results.q5_beforeScroll || []).length}):`);
  console.log(respTable(results.q5_beforeScroll || [], 'before scroll'));
  console.log(`\nQ6 responses >50KB FIRED DURING/AFTER SCROLL (${(results.q6_afterScroll || []).length}):`);
  console.log(respTable(results.q6_afterScroll || [], 'during/after scroll'));
  console.log(`\nCARD COUNTS after scroll: ${JSON.stringify(results.q3_cards_afterScroll)}`);
  console.log(`CARD COUNTS after extended scroll: ${JSON.stringify(results.q3_cards_afterExtended ?? 'n/a')}`);
  console.log(`LISTING-DATA REQUESTS (search?tbm=map, >50KB): ${JSON.stringify(results.listingRequests ?? [])}`);
  console.log(`\nERRORS (${results.errors.length}):`);
  results.errors.forEach((e) => console.log(`  - ${e}`));
  console.log('='.repeat(78));

  try {
    results.finishReason = reason;
    fs.writeFileSync(
      path.join(OUT, `results-${MODE}.json`),
      JSON.stringify(results, null, 2)
    );
    console.log(`wrote ${path.join(OUT, `results-${MODE}.json`)}`);
  } catch (e) {
    console.log(`could not write results json: ${e.message}`);
  }
}

/* ------------ watchdog ------------ */
const watchdog = setTimeout(() => {
  console.log(`\n!!! GLOBAL TIMEOUT ${GLOBAL_TIMEOUT_MS}ms HIT — force exiting !!!`);
  results.errors.push(`GLOBAL TIMEOUT at ${GLOBAL_TIMEOUT_MS}ms`);
  results.q5_beforeScroll ??= captured.filter((c) => c.phase === 'before-scroll');
  results.q6_afterScroll ??= captured.filter((c) => c.phase === 'after-scroll');
  printReport('WATCHDOG FORCE-EXIT');
  process.exit(2);
}, GLOBAL_TIMEOUT_MS);
watchdog.unref?.();

/* ------------ main ------------ */
let browser = null;

async function main() {
  console.log(`[${el()}] launching chromium headless=${HEADLESS}`);
  results.build.playwrightVersion = JSON.parse(
    fs.readFileSync('node_modules/playwright/package.json', 'utf8')
  ).version;
  results.build.defaultExecutablePath = chromium.executablePath();

  browser = await chromium.launch({ headless: HEADLESS });
  results.build.browserVersion = browser.version();

  // Evidence of which binary actually got spawned.
  try {
    const ps = execSync(
      `ps -Ao pid=,command= | grep -i ms-playwright | grep -v grep || true`,
      { encoding: 'utf8', timeout: 5000 }
    );
    const lines = ps.split('\n').filter(Boolean);
    results.build.psMentionsFullChromium = /ms-playwright\/chromium-\d/.test(ps);
    results.build.psMentionsHeadlessShell =
      /ms-playwright\/chromium_headless_shell-\d/.test(ps);
    results.build.psSampleLine = (lines[0] || '').slice(0, 220);
    results.build.psLineCount = lines.length;
  } catch (e) {
    results.build.spawnedBinaries = `ps failed: ${e.message}`;
  }
  console.log(`[${el()}] build: ${JSON.stringify(results.build)}`);

  const ctx = await browser.newContext({
    locale: 'en-IN',
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  attachResponseCapture(page); // BEFORE navigating

  /* Q1 */
  results.q1_landing = await probe('Q1 navigate', async () => {
    const resp = await page.goto(TARGET_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    const finalUrl = page.url();
    const host = new URL(finalUrl).host;
    const consentFormPresent = await page
      .locator(SEL.consentAccept)
      .count()
      .catch(() => -1);
    return {
      httpStatus: resp ? resp.status() : null,
      finalUrl,
      host,
      consentHost: host.includes('consent.google.com'),
      consentAcceptMatches: consentFormPresent,
      consentDetected: host.includes('consent.google.com') || consentFormPresent > 0,
      title: await page.title().catch(() => null),
    };
  });
  console.log(`[${el()}] Q1 ${JSON.stringify(results.q1_landing)}`);

  // give the SPA a chance to paint, same order of magnitude as production's
  // waitForSelector(FEED.container, {timeout: 20000})
  await probe('wait for feed', () =>
    page.waitForSelector(SEL.feed, { timeout: 15000 })
  );

  /* Q2 */
  results.q2_feed = await probe('Q2 feed', async () => ({
    feedCount: await page.locator(SEL.feed).count(),
  }));
  console.log(`[${el()}] Q2 ${JSON.stringify(results.q2_feed)}`);

  /* Q3 */
  results.q3_cards = await probe('Q3 cards', async () => ({
    cardCount: await page.locator(SEL.card).count(),
    placeLinkCount: await page.locator(SEL.placeLink).count(),
  }));
  console.log(`[${el()}] Q3 ${JSON.stringify(results.q3_cards)}`);

  /* Q4 */
  results.q4_listOrPlace = await probe('Q4 list-vs-place', async () => {
    const u = page.url();
    const h1Count = await page.locator('h1').count();
    const h1Texts = await page
      .locator('h1')
      .allTextContents()
      .catch(() => []);
    const feedPresent = (results.q2_feed?.feedCount ?? 0) > 0;
    const isPlaceUrl = u.includes('/maps/place/');
    const isSearchUrl = u.includes('/maps/search/');
    return {
      urlHasMapsPlace: isPlaceUrl,
      urlHasMapsSearch: isSearchUrl,
      feedPresent,
      h1Count,
      h1Texts: h1Texts.map((t) => t.trim().slice(0, 60)),
      verdict:
        isPlaceUrl && !feedPresent
          ? 'SINGLE PLACE PANEL'
          : feedPresent && isSearchUrl
            ? 'RESULTS LIST'
            : 'AMBIGUOUS',
    };
  });
  console.log(`[${el()}] Q4 ${JSON.stringify(results.q4_listOrPlace)}`);

  /* artifacts */
  await probe('screenshot', () =>
    page.screenshot({ path: path.join(OUT, `page-${MODE}.png`), fullPage: true, timeout: 15000 })
  );
  await probe('html dump', async () => {
    const html = await page.content();
    fs.writeFileSync(path.join(OUT, `body-${MODE}.html`), html);
    return html.length;
  });

  /* Q5 — snapshot before scroll */
  await settleResponses();
  results.q5_beforeScroll = captured.filter((c) => c.phase === 'before-scroll');
  console.log(`[${el()}] Q5 captured ${results.q5_beforeScroll.length} responses >50KB`);

  /* Q6 — scroll the feed once, then look at what fired */
  phase = 'after-scroll';
  scrollMarkTs = Date.now();
  await probe('scroll feed', async () => {
    const feed = page.locator(SEL.feed).first();
    if (!(await feed.count())) throw new Error('no feed element to scroll');
    await feed.evaluate((e) => {
      e.scrollTop = e.scrollHeight;
    });
  });
  await page.waitForTimeout(3000);
  await settleResponses();
  results.q6_afterScroll = captured.filter((c) => c.phase === 'after-scroll');
  results.q3_cards_afterScroll = await probe('cards after scroll', async () => ({
    cardCount: await page.locator(SEL.card).count(),
    placeLinkCount: await page.locator(SEL.placeLink).count(),
  }));
  console.log(`[${el()}] Q6 captured ${results.q6_afterScroll.length} responses >50KB`);

  // If no listing-data request fired in the first 3s, give it 5s more before
  // concluding that scrolling does not paginate. Recorded separately.
  const isListingReq = (r) => /\/search\?/.test(r.url) && /tbm=map/.test(r.url);
  if (!results.q6_afterScroll.some(isListingReq)) {
    console.log(`[${el()}] no tbm=map request in first 3s after scroll — extending 5s`);
    await probe('scroll feed (again)', async () => {
      await page.locator(SEL.feed).first().evaluate((e) => {
        e.scrollTop = e.scrollHeight;
      });
    });
    await page.waitForTimeout(5000);
    await settleResponses();
    results.q6_afterScroll = captured.filter((c) => c.phase === 'after-scroll');
    results.q3_cards_afterExtended = await probe('cards after extended scroll', async () => ({
      cardCount: await page.locator(SEL.card).count(),
      placeLinkCount: await page.locator(SEL.placeLink).count(),
    }));
    results.scrollExtended = true;
  }
  results.listingRequests = captured
    .filter(isListingReq)
    .map((r) => ({ phase: r.phase, tSec: r.tSec, kb: r.kb, status: r.status }));

  results.completed = true;
}

main()
  .catch((e) => {
    results.errors.push(`FATAL main: ${e.name}: ${e.message}`.split('\n')[0]);
    console.error(`[${el()}] FATAL:`, e.message);
  })
  .finally(async () => {
    try {
      if (browser) await browser.close();
      console.log(`[${el()}] browser closed`);
    } catch (e) {
      console.log(`[${el()}] browser close failed: ${e.message}`);
    }
    clearTimeout(watchdog);
    results.q5_beforeScroll ??= captured.filter((c) => c.phase === 'before-scroll');
    results.q6_afterScroll ??= captured.filter((c) => c.phase === 'after-scroll');
    printReport(results.completed ? 'COMPLETED' : 'ENDED EARLY (see errors)');
  });
