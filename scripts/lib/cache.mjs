import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { readJsonIfExists, writeJson, slugifyDomain, todayStamp } from './util.mjs';

// Results are cached per (url + date + key config) so re-running the same audit
// the same day is fast. Cache lives under the OS temp dir, not the report dir,
// so it never pollutes the deliverable. Pass --no-cache or --fresh to bypass.
const CACHE_ROOT = path.join(os.tmpdir(), 'website-qa-auditor-cache');

function cacheKey(url, config, now) {
  const sig = crypto
    .createHash('sha1')
    .update(JSON.stringify({ url, depth: config.depth, maxPages: config.maxPages, viewports: config.viewports }))
    .digest('hex')
    .slice(0, 10);
  return `${slugifyDomain(url)}-${todayStamp(now)}-${sig}`;
}

export function cachePathFor(url, config, now) {
  return path.join(CACHE_ROOT, cacheKey(url, config, now) + '.json');
}

export async function loadCache(url, config, now) {
  if (!config.cache) return null;
  return readJsonIfExists(cachePathFor(url, config, now));
}

export async function saveCache(url, config, now, payload) {
  if (!config.cache) return;
  try {
    await writeJson(cachePathFor(url, config, now), payload);
  } catch {
    /* cache is best-effort */
  }
}
