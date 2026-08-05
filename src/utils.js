import fs from 'fs';
import path from 'path';
import { SOCIAL_DOMAINS } from './selectors.js';

/** --key=value CLI args */
export const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, ...v] = a.replace(/^--/, '').split('=');
      return [k, v.length ? v.join('=') : 'true'];
    })
);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const jitter = (min, max) => Math.floor(min + Math.random() * (max - min));

export const log = (msg) => {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}] ${msg}`);
};

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Append one row immediately. Never buffer to end of run. */
export function appendCsv(file, headers, row) {
  ensureDir(path.dirname(file));
  if (!fs.existsSync(file)) fs.writeFileSync(file, headers.join(',') + '\n');
  fs.appendFileSync(file, headers.map((h) => csvCell(row[h])).join(',') + '\n');
}

export function writeCsv(file, headers, rows) {
  ensureDir(path.dirname(file));
  const body = rows.map((r) => headers.map((h) => csvCell(r[h])).join(',')).join('\n');
  fs.writeFileSync(file, headers.join(',') + '\n' + body + '\n');
}

export function readCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ;
      } else if (c === ',' && !inQ) { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']));
  });
}

export function isSocialDomain(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  return SOCIAL_DOMAINS.some((d) => u.includes(d));
}
