import { promises as fs } from 'node:fs';
import path from 'node:path';

export function normalizeUrl(input) {
  let u = String(input || '').trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  const url = new URL(u);
  url.hash = '';
  return url;
}

export function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

// Strip the hash and trailing slash so we don't crawl the same page twice.
export function canonicalKey(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    let s = u.toString();
    if (u.pathname !== '/' && s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return url;
  }
}

export function slugifyDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '-');
  } catch {
    return 'site';
  }
}

export function todayStamp(date) {
  // date is passed in (Date.now/new Date are unavailable in some harness
  // contexts); fall back to a Date if a real one is provided.
  const d = date || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJsonIfExists(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function writeJson(file, obj) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(obj, null, 2), 'utf8');
}

export function truncate(str, n) {
  str = String(str || '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

export function pct(n) {
  return Math.round(Number(n) * 100);
}

export function bytesToKB(n) {
  return Math.round((Number(n) || 0) / 1024);
}

// A tiny concurrency-limited map so we don't open 50 browser pages at once.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        results[idx] = { __error: err?.message || String(err) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export function uniq(arr) {
  return [...new Set(arr)];
}

// Simple logger that prefixes a category tag and timestamps relative ms.
export function makeLogger(start) {
  return (tag, msg) => {
    const t = ((Date.now() - start) / 1000).toFixed(1);
    process.stderr.write(`[${t}s] ${tag.padEnd(12)} ${msg}\n`);
  };
}
