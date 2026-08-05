/**
 * Renders REPORT.md and tier-a.csv — a call sheet meant to be read on a phone
 * between calls. Deliberately terse. The full data lives in leads.csv.
 */

import fs from 'fs';
import path from 'path';
import { args, readCsv, writeCsv, log } from './utils.js';
import { LEAD_HEADERS } from './score.js';

const runId = args.run;
if (!runId) { console.error('Usage: npm run report -- --run=<runId>'); process.exit(1); }

const OUT = path.join('output', runId);
const leads = readCsv(path.join(OUT, 'leads.csv'));
const raw = readCsv(path.join(OUT, 'raw.csv'));

const byTier = (t) => leads.filter((l) => l.tier === t);
const A = byTier('A');
const B = byTier('B');
const C = byTier('C');
const U = byTier('U');

const withPhone = leads.filter((l) => (l.phone ?? '').trim()).length;
const noWebsite = raw.filter((r) => r.hasWebsite === 'false').length;
const social = raw.filter((r) => r.isSocialOnly === 'true').length;

// tier-a.csv is deliberately NOT written here. score.js owns it, because it is
// the ONE artifact the operator edits by hand — it ships with a blank `outcome`
// column that `npm run blacklist -- --import=` reads back. Rewriting it from
// leads.csv on every report run would silently erase those annotations, which
// is exactly the kind of quiet data loss this codebase exists to avoid.

const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v);

const row = (l, i) =>
  `| ${i + 1} | ${l.name} | ${dash(l.phone)} | ${dash(l.area)} | ${dash(l.rating)}★ ${l.reviewCount ?? 0} | ${l.gapReasons} |`;

const table = (rows) =>
  rows.length
    ? ['| # | Business | Phone | Area | Rating | Gaps |', '|---|---|---|---|---|---|',
       ...rows.map(row)].join('\n')
    : '_None._';

const md = `# Lead Report — ${runId}

Generated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}

## Summary

| | |
|---|---|
| Raw records scraped | ${raw.length} |
| No website | ${noWebsite} |
| Social/directory only | ${social} |
| Qualified leads | ${leads.length} |
| Phone captured | ${withPhone} / ${leads.length} (${Math.round((withPhone / (leads.length || 1)) * 100)}%) |
| **Tier A — call today** | **${A.length}** |
| Tier B — this week | ${B.length} |
| Tier C — backlog | ${C.length} |
| Tier U — unknown demand | ${U.length} |

---

## Tier A — call today

High gap, real customer volume, reachable by phone.

${table(A.slice(0, 40))}
${A.length > 40 ? `\n_+${A.length - 40} more in tier-a.csv_\n` : ''}
---

## Tier B — this week

${table(B.slice(0, 30))}
${B.length > 30 ? `\n_+${B.length - 30} more in leads.csv_\n` : ''}
---

## How to open a call

The \`Gaps\` column is your first line. Lead with the observation, not the pitch:

> "Namaste, main <name> se baat kar raha hoon? Aapki Google listing dekh raha
> tha — <specific gap>. Isliye call kiya."

A named specific gap gets a conversation. A generic "website chahiye kya" gets
hung up on.

Priority within a tier is already sorted by review volume — the top rows are the
busiest businesses with the weakest presence. Start at row 1.

After you call someone, add their \`cid\` to \`config/blacklist.json\` so they
never reappear on a future call sheet.

---

## Files

- \`tier-a.csv\` — today's call list only
- \`leads.csv\` — every qualified lead, scored
- \`raw.csv\` — unfiltered scrape output
- \`errors.log\` — records that failed extraction
`;

fs.writeFileSync(path.join(OUT, 'REPORT.md'), md);
log(`REPORT.md written → ${path.join(OUT, 'REPORT.md')}`);
log(`Tier A: ${A.length} · Tier B: ${B.length} · Tier C: ${C.length} · Tier U: ${U.length}`);
