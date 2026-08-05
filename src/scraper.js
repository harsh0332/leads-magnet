/**
 * Two-pass Google Maps scraper.
 *
 * Pass 1 — read the results feed. No clicking. Cheap.
 * Pass 2 — open detail panel ONLY for records that survive the Pass-1 filter.
 *
 * Every record is written to disk immediately. Progress is checkpointed after
 * every query so an interrupted run resumes instead of restarting.
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { URL_TEMPLATE, FEED, DETAIL, PATTERNS } from './selectors.js';
import { args, sleep, jitter, log, ensureDir, appendCsv, isSocialDomain } from './utils.js';

const CFG = {
  city: args.city,
  category: args.category,
  maxPlacesPerQuery: Number(args.maxPlaces ?? 200),
  maxScrolls: Number(args.maxScrolls ?? 25),
  queryLimit: args.limit ? Number(args.limit) : null,   // for smoke tests
  headless: args.headless === 'true',
  actionDelay: [1500, 3500],
  queryDelay: [10000, 20000],
};

if (!CFG.city || !CFG.category) {
  console.error('Usage: npm run scrape -- --city=Indore --category=dentist');
  process.exit(1);
}

const runId = `${CFG.city}-${CFG.category}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`
  .toLowerCase().replace(/\s+/g, '-');
const OUT = path.join('output', runId);
ensureDir(OUT);

const RAW_CSV = path.join(OUT, 'raw.csv');
const PROGRESS = path.join(OUT, 'progress.json');
const ERRORS = path.join(OUT, 'errors.log');

const RAW_HEADERS = [
  'query', 'name', 'category', 'rating', 'reviewCount', 'hasWebsite',
  'websiteUrl', 'isSocialOnly', 'phone', 'address', 'area',
  'hasHours', 'hasPhotos', 'isUnclaimed', 'permanentlyClosed', 'mapsUrl', 'cid',
];

/* ---------------- query matrix ---------------- */

function buildQueries() {
  const localities = JSON.parse(fs.readFileSync('config/localities.json', 'utf8'));
  const categories = JSON.parse(fs.readFileSync('config/categories.json', 'utf8'));

  const areas = localities[CFG.city];
  const terms = categories[CFG.category];

  if (!areas) throw new Error(`City "${CFG.city}" not in config/localities.json — add it first.`);
  if (!terms) throw new Error(`Category "${CFG.category}" not in config/categories.json — add it first.`);

  const q = [];
  for (const term of terms) {
    for (const area of areas) q.push(`${term} in ${area} ${CFG.city}`);
  }
  return CFG.queryLimit ? q.slice(0, CFG.queryLimit) : q;
}

/* ---------------- progress ---------------- */

function loadProgress() {
  if (fs.existsSync(PROGRESS)) return JSON.parse(fs.readFileSync(PROGRESS, 'utf8'));
  return { done: [], seenCids: [], stats: { scraped: 0, detailed: 0, errors: 0 } };
}
function saveProgress(p) {
  fs.writeFileSync(PROGRESS, JSON.stringify(p, null, 2));
}

/* ---------------- pass 1 ---------------- */

async function scrollFeed(page) {
  const feed = page.locator(FEED.container).first();
  if (!(await feed.count())) return 0;

  let prev = -1;
  for (let i = 0; i < CFG.maxScrolls; i++) {
    await feed.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await sleep(2000 + Math.random() * 800);

    const count = await page.locator(FEED.card).count();
    if (count === prev) break;          // list exhausted
    if (count >= CFG.maxPlacesPerQuery) break;
    prev = count;
  }
  return page.locator(FEED.card).count();
}

async function extractCards(page) {
  return page.evaluate(
    ({ FEED, patternSrc }) => {
      const rx = {
        rating: new RegExp(patternSrc.rating, 'i'),
        cid: new RegExp(patternSrc.cid),
      };
      const out = [];
      const cards = document.querySelectorAll(FEED.card);

      for (const card of cards) {
        try {
          const link = card.querySelector(FEED.placeLink);
          if (!link) continue;

          const text = card.innerText || '';
          if (/^\s*(Sponsored|Ad)\b/i.test(text)) continue;   // skip paid

          const name = link.getAttribute('aria-label') || '';
          const mapsUrl = link.getAttribute('href') || '';

          let rating = null, reviewCount = null;
          const rw = card.querySelector(FEED.ratingWidget);
          if (rw) {
            const m = (rw.getAttribute('aria-label') || '').match(rx.rating);
            if (m) {
              rating = parseFloat(m[1]);
              if (m[2]) reviewCount = parseInt(m[2].replace(/,/g, ''), 10);
            }
          }

          const hasWebsite = !!card.querySelector(FEED.websiteBtn);
          const cidMatch = mapsUrl.match(rx.cid);

          // Category is the fragile bit: first line of the info row after name.
          const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
          const category = lines.find((l) => l !== name && !/^[\d.]/.test(l)) || '';

          out.push({
            name, mapsUrl, rating, reviewCount, hasWebsite, category,
            cid: cidMatch ? cidMatch[1] : mapsUrl,
            permanentlyClosed: /permanently closed/i.test(text),
          });
        } catch { /* one bad card must not kill the batch */ }
      }
      return out;
    },
    { FEED, patternSrc: { rating: PATTERNS.rating.source, cid: PATTERNS.cid.source } }
  );
}

/* ---------------- pass 2 ---------------- */

async function extractDetail(page, card) {
  const prevName = await page.evaluate((sel) => {
    const h = Array.from(document.querySelectorAll(sel)).find(el => el.textContent.trim());
    return h ? h.textContent.trim() : '';
  }, DETAIL.name);

  await card.click({ timeout: 8000 });

  // Wait for CONTENT change, not a fixed timeout. The panel reuses the node.
  await page.waitForFunction(
    ({ sel, prev }) => {
      const h = Array.from(document.querySelectorAll(sel)).find(el => el.textContent.trim() && el.textContent.trim() !== prev);
      return h ? h.textContent.trim() : false;
    },
    { sel: DETAIL.name, prev: prevName },
    { timeout: 15000 }
  );
  await sleep(jitter(...CFG.actionDelay));

  return page.evaluate(
    ({ DETAIL, phoneRx, claimRx }) => {
      const q = (s) => document.querySelector(s);
      const body = document.body.innerText || '';

      let phone = null;
      const pb = q(DETAIL.phoneBtn);
      if (pb) {
        const m = (pb.getAttribute('data-item-id') || '').match(new RegExp(phoneRx));
        phone = m ? m[1] : (pb.innerText || '').trim() || null;
      }

      const wl = q(DETAIL.websiteLink);

      return {
        detailName: (q(DETAIL.name)?.textContent || '').trim(),
        phone,
        websiteUrl: wl ? wl.getAttribute('href') : null,
        address: q(DETAIL.addressBtn)?.getAttribute('aria-label')?.replace(/^Address:\s*/i, '') || null,
        hasHours: !!q(DETAIL.hoursBtn),
        hasPhotos: !!q(DETAIL.photoButton),
        isUnclaimed: new RegExp(claimRx, 'i').test(body) || !!q(DETAIL.claimLink),
        permanentlyClosed: /permanently closed/i.test(body),
      };
    },
    {
      DETAIL,
      phoneRx: PATTERNS.phoneFromAttr.source,
      claimRx: DETAIL.claimTextPattern.source,
    }
  );
}

/* ---------------- main ---------------- */

async function main() {
  const queries = buildQueries();
  const progress = loadProgress();
  const seen = new Set(progress.seenCids);

  log(`Run ${runId}`);
  log(`${queries.length} queries planned · ${progress.done.length} already done`);

  const browser = await chromium.launch({ headless: CFG.headless });
  const ctx = await browser.newContext({
    locale: 'en-IN',
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  let emptyStreak = 0;

  for (const query of queries) {
    if (progress.done.includes(query)) continue;

    try {
      await page.goto(URL_TEMPLATE(query), { waitUntil: 'domcontentloaded', timeout: 45000 });

      const consent = page.locator(FEED.consentAccept).first();
      if (await consent.count()) { await consent.click().catch(() => {}); await sleep(1500); }

      await page.waitForSelector(FEED.container, { timeout: 20000 }).catch(() => {});
      const found = await scrollFeed(page);

      if (!found) {
        emptyStreak++;
        log(`  ⚠ 0 results — ${query}`);
        if (emptyStreak >= 3) {
          await page.screenshot({ path: path.join(OUT, 'block-evidence.png') });
          throw new Error(
            'Three consecutive empty queries. Likely soft-blocked or selectors broke. ' +
            'Stopping. See block-evidence.png and run /verify-selectors.'
          );
        }
        progress.done.push(query);
        saveProgress(progress);
        await sleep(jitter(...CFG.queryDelay));
        continue;
      }
      emptyStreak = 0;

      const cards = await extractCards(page);
      const fresh = cards.filter((c) => c.cid && !seen.has(c.cid));
      fresh.forEach((c) => seen.add(c.cid));

      log(`  ${query} → ${cards.length} cards, ${fresh.length} new`);

      // PASS 2 — only the ones worth a click.
      const needDetail = fresh.filter((c) => !c.hasWebsite && !c.permanentlyClosed);

      for (const rec of fresh) {
        let detail = {};
        if (needDetail.includes(rec)) {
          try {
            const card = page.locator(FEED.card)
              .filter({ has: page.locator(`a[href="${rec.mapsUrl}"]`) }).first();
            if (await card.count()) {
              detail = await extractDetail(page, card);
              progress.stats.detailed++;
            }
          } catch (e) {
            progress.stats.errors++;
            fs.appendFileSync(ERRORS, `[detail] ${rec.mapsUrl} :: ${e.message}\n`);
          }
        }

        const website = detail.websiteUrl ?? null;
        appendCsv(RAW_CSV, RAW_HEADERS, {
          query,
          name: detail.detailName || rec.name,
          category: rec.category,
          rating: rec.rating,
          reviewCount: rec.reviewCount,
          hasWebsite: rec.hasWebsite,
          websiteUrl: website,
          isSocialOnly: website ? isSocialDomain(website) : false,
          phone: detail.phone ?? null,
          address: detail.address ?? null,
          area: query.split(' in ')[1] ?? '',
          hasHours: detail.hasHours ?? null,
          hasPhotos: detail.hasPhotos ?? null,
          isUnclaimed: detail.isUnclaimed ?? null,
          permanentlyClosed: rec.permanentlyClosed || detail.permanentlyClosed || false,
          mapsUrl: rec.mapsUrl,
          cid: rec.cid,
        });
        progress.stats.scraped++;
      }

      progress.done.push(query);
      progress.seenCids = [...seen];
      saveProgress(progress);

      await sleep(jitter(...CFG.queryDelay));
    } catch (e) {
      fs.appendFileSync(ERRORS, `[query] ${query} :: ${e.message}\n`);
      if (/consecutive empty/.test(e.message)) { log(`\n✗ ${e.message}`); break; }
      progress.stats.errors++;
      log(`  ✗ ${query} — ${e.message}`);
    }
  }

  await browser.close();
  log(`\nDone. ${progress.stats.scraped} records → ${RAW_CSV}`);
  log(`Detail pass: ${progress.stats.detailed} · Errors: ${progress.stats.errors}`);
  log(`Next: npm run score -- --run=${runId}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
