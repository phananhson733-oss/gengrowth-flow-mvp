// _config.mjs — Sync, cached reader for sheet-sourced config snapshot.
//
// Snapshot is written by gg-config-sync.mjs from sheet `config` tab.
// getConfig() is sync (red-lines.mjs is called from non-async validators),
// reads the file at most once per process, and never throws.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = (() => {
  try { return realpathSync(join(__dirname, '..', '..', '..')); } catch { return null; }
})();

export const CONFIG_SNAPSHOT_PATH = REPO_ROOT
  ? join(REPO_ROOT, '.gg-cache', 'config-snapshot.json')
  : join(__dirname, '..', '..', '..', '.gg-cache', 'config-snapshot.json');

let cached = null;

function loadSnapshot() {
  if (cached !== null) return cached;
  cached = { values: {} };
  try {
    if (!existsSync(CONFIG_SNAPSHOT_PATH)) return cached;
    const parsed = JSON.parse(readFileSync(CONFIG_SNAPSHOT_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.values && typeof parsed.values === 'object') {
      cached = { values: parsed.values };
    }
  } catch { /* fall back to defaults */ }
  return cached;
}

/** Sync lookup; returns `fallback` if snapshot missing / key absent / unreadable. Never throws. */
export function getConfig(key, fallback) {
  const snap = loadSnapshot();
  return Object.prototype.hasOwnProperty.call(snap.values, key) ? snap.values[key] : fallback;
}

/** Test-only: drop the cache so a fresh read can pick up new snapshot contents. */
export function _resetConfigCache() { cached = null; }
