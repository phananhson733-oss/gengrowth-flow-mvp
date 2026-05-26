// _config.mjs — Sync, cached reader for sheet-sourced config snapshot.
//
// Snapshot is written by gg-config-sync.mjs from sheet `config` tab.
// getConfig() is sync (red-lines.mjs is called from non-async validators),
// reads the file at most once per process, and never throws.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// A snapshot older than this is "stale" — likely behind the sheet, so dynamic
// keys (e.g. author.map.<domain>) added since the last gg-config-sync won't be
// seen. CLI entry points surface this; the library itself stays quiet.
const CONFIG_STALE_MS = 24 * 60 * 60 * 1000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = (() => {
  try { return realpathSync(join(__dirname, '..', '..', '..')); } catch { return null; }
})();

export const CONFIG_SNAPSHOT_PATH = REPO_ROOT
  ? join(REPO_ROOT, '.gg-cache', 'config-snapshot.json')
  : join(__dirname, '..', '..', '..', '.gg-cache', 'config-snapshot.json');

let cached = null;
let cachedStatus = null;

function loadSnapshot() {
  if (cached !== null) return cached;
  cached = { values: {} };
  cachedStatus = { present: false, path: CONFIG_SNAPSHOT_PATH, ageMs: Infinity, stale: true };
  try {
    if (!existsSync(CONFIG_SNAPSHOT_PATH)) return cached;
    const parsed = JSON.parse(readFileSync(CONFIG_SNAPSHOT_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.values && typeof parsed.values === 'object') {
      cached = { values: parsed.values };
    }
    let ageMs = Infinity;
    try { ageMs = Date.now() - statSync(CONFIG_SNAPSHOT_PATH).mtimeMs; } catch { /* keep Infinity */ }
    cachedStatus = { present: true, path: CONFIG_SNAPSHOT_PATH, ageMs, stale: ageMs > CONFIG_STALE_MS };
  } catch { /* fall back to defaults */ }
  return cached;
}

/** Sync lookup; returns `fallback` if snapshot missing / key absent / unreadable. Never throws. */
export function getConfig(key, fallback) {
  const snap = loadSnapshot();
  return Object.prototype.hasOwnProperty.call(snap.values, key) ? snap.values[key] : fallback;
}

/**
 * Return a shallow copy of all snapshot values (the flat dotted-key map).
 * Used by author-routing to prefix-match dynamic `author.map.<domain>` keys
 * that getConfig() can't enumerate. Returns {} if snapshot missing/unreadable.
 */
export function getAllConfig() {
  const snap = loadSnapshot();
  return { ...snap.values };
}

/**
 * Snapshot freshness, for CLI entry points to warn on. Never throws.
 * @returns {{present:boolean, path:string, ageMs:number, stale:boolean}}
 *   present=false → snapshot missing/unreadable (dynamic keys resolve empty);
 *   stale=true → older than CONFIG_STALE_MS (may be behind the sheet).
 */
export function getConfigStatus() {
  loadSnapshot();
  return { ...cachedStatus };
}

/** Test-only: drop the cache so a fresh read can pick up new snapshot contents. */
export function _resetConfigCache() { cached = null; cachedStatus = null; }
