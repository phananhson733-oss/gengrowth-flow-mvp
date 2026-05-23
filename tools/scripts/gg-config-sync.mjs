#!/usr/bin/env node
// gg-config-sync.mjs — Make sheet `config` tab authoritative for thresholds.
//
// Fixes PIPELINE.md line 414-415: `config` was "only-doc"; code used hardcoded
// thresholds, sheet edits silently drifted. This script pulls the tab, coerces
// each row, writes .gg-cache/config-snapshot.json. lib/_config.mjs lazily reads
// the snapshot (sync, cached) so red-lines.mjs + gg-keyword-mine.mjs pick up
// sheet values at module-load without async / network.
//
// Defaults preserved when sheet has no override (back-compat).

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

import { loadEnv, getAccessToken, gFetch } from './lib/gg-shared.mjs';
import { CONFIG_SNAPSHOT_PATH } from './lib/_config.mjs';
// IMPORTANT: import the *_DEFAULT / *_FALLBACK (hardcoded) constants here, not the
// resolved ones — otherwise the diff would always show "match" once a snapshot exists.
import {
  RL3_NGRAM_THRESHOLD_DEFAULT,
  RL4_JACCARD_FLOOR_DEFAULT,
  RL4_SHINGLE_FLOOR_DEFAULT,
  RL4_DRIFTED_SECTIONS_FAIL_DEFAULT,
  RL5_MAX_COUNT_DEFAULT,
} from './lib/red-lines.mjs';
import {
  DEFAULT_MAX_KD_FALLBACK,
  DEFAULT_MIN_VOLUME_FALLBACK,
  DEFAULT_MAX_RESULTS_FALLBACK,
  DEFAULT_LOCATION_CODE_FALLBACK,
  DEFAULT_LANGUAGE_CODE_FALLBACK,
} from './gg-keyword-mine.mjs';

export const CONFIG_TAB_NAME = 'config';
export const CONFIG_RANGE = `${CONFIG_TAB_NAME}!A1:F200`;

// Schema — sheet key (dotted) → { codeDefault, coerce, codeConstantName }.
// Anything not in here is reported as "unrecognised" so adding a sheet row
// doesn't silently no-op.

const num = (s) => {
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`not a finite number: ${s}`);
  return n;
};
const int = (s) => {
  const n = num(s);
  if (!Number.isInteger(n)) throw new Error(`not an integer: ${s}`);
  return n;
};
const bool = (s) => {
  const v = String(s).trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  throw new Error(`not a bool: ${s}`);
};
const str = (s) => String(s);

export const SCHEMA = Object.freeze({
  // keyword-mine
  'mine.max_kd':         { codeDefault: DEFAULT_MAX_KD_FALLBACK,        coerce: num,  constant: 'DEFAULT_MAX_KD' },
  'mine.min_volume':     { codeDefault: DEFAULT_MIN_VOLUME_FALLBACK,    coerce: num,  constant: 'DEFAULT_MIN_VOLUME' },
  'mine.max_results':    { codeDefault: DEFAULT_MAX_RESULTS_FALLBACK,   coerce: int,  constant: 'DEFAULT_MAX_RESULTS' },
  'mine.location_code':  { codeDefault: DEFAULT_LOCATION_CODE_FALLBACK, coerce: int,  constant: 'DEFAULT_LOCATION_CODE' },
  'mine.language_code':  { codeDefault: DEFAULT_LANGUAGE_CODE_FALLBACK, coerce: str,  constant: 'DEFAULT_LANGUAGE_CODE' },
  'mine.read_negatives_from_sheet': { codeDefault: true,                coerce: bool, constant: '(runtime flag)' },
  // red-lines
  'phase2.RL3_n_gram':              { codeDefault: RL3_NGRAM_THRESHOLD_DEFAULT,     coerce: int, constant: 'RL3_NGRAM_THRESHOLD' },
  'phase2.RL4_jaccard_floor':       { codeDefault: RL4_JACCARD_FLOOR_DEFAULT,       coerce: num, constant: 'RL4_JACCARD_FLOOR' },
  'phase2.RL4_shingle_floor':       { codeDefault: RL4_SHINGLE_FLOOR_DEFAULT,       coerce: num, constant: 'RL4_SHINGLE_FLOOR' },
  'phase2.RL4_drifted_sections_fail':{ codeDefault: RL4_DRIFTED_SECTIONS_FAIL_DEFAULT, coerce: int, constant: 'RL4_DRIFTED_SECTIONS_FAIL' },
  'phase2.RL5_keyword_max':         { codeDefault: RL5_MAX_COUNT_DEFAULT,           coerce: int, constant: 'RL5_MAX_COUNT' },
  // word-count tiers (not yet wired into code; tracked here for visibility)
  'tier1.word_min':      { codeDefault: 2800, coerce: int, constant: '(doc-only)' },
  'tier1.word_max':      { codeDefault: 3500, coerce: int, constant: '(doc-only)' },
  'tier2.word_min':      { codeDefault: 1500, coerce: int, constant: '(doc-only)' },
  'tier2.word_max':      { codeDefault: 1800, coerce: int, constant: '(doc-only)' },
  'prompt.version':      { codeDefault: 'v8', coerce: str, constant: '(doc-only)' },
});

// CLI parsing
export function parseArgs(argv) {
  const args = { dry_run: false, diff_only: false, help: false };
  for (const a of argv) {
    if (a === '--dry-run') args.dry_run = true;
    else if (a === '--diff-only') args.diff_only = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const USAGE = `gg-config-sync.mjs — sync sheet \`config\` tab → .gg-cache/config-snapshot.json

Usage:
  node tools/scripts/gg-config-sync.mjs              # fetch + write snapshot
  node tools/scripts/gg-config-sync.mjs --dry-run    # fetch + diff, no write
  node tools/scripts/gg-config-sync.mjs --diff-only  # fetch + diff, no write
  node tools/scripts/gg-config-sync.mjs --help

Env:
  GG_SHEETS_FLOW_MVP_WORKBOOK_ID  required
  GG_WRITER_SA_JSON               default ~/.config/gg/gg-writer-sa.json
`;

// Sheet fetch + row parse
/**
 * Parse sheet rows (header + data) into a structured result.
 * @param {string[][]} rows
 * @returns {{ values: Record<string, any>, unparsable: Array<{key:string, raw:string, reason:string}>, unrecognised: string[] }}
 */
export function parseConfigRows(rows) {
  const out = { values: {}, unparsable: [], unrecognised: [] };
  if (!Array.isArray(rows) || rows.length < 2) return out;
  const header = (rows[0] || []).map((c) => String(c || '').trim().toLowerCase());
  const keyIdx = header.indexOf('key');
  const valIdx = header.indexOf('value');
  if (keyIdx < 0 || valIdx < 0) {
    throw new Error(`config tab missing required columns key/value; got header: ${header.join(',')}`);
  }
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const key = String(row[keyIdx] || '').trim();
    const rawVal = row[valIdx];
    if (!key) continue;
    const rawStr = rawVal == null ? '' : String(rawVal).trim();
    if (!rawStr) continue;
    const spec = SCHEMA[key];
    if (!spec) {
      out.unrecognised.push(key);
      continue;
    }
    try {
      out.values[key] = spec.coerce(rawStr);
    } catch (e) {
      out.unparsable.push({ key, raw: rawStr, reason: e.message });
    }
  }
  return out;
}

async function fetchConfigTab(workbookId, token) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(CONFIG_RANGE)}`;
  const res = await gFetch(url, token);
  return res.values || [];
}

// Diff report
export function buildDiff(sheetValues) {
  const rows = [];
  for (const [key, spec] of Object.entries(SCHEMA)) {
    const sheetHas = Object.prototype.hasOwnProperty.call(sheetValues, key);
    const sheetVal = sheetHas ? sheetValues[key] : null;
    const codeVal = spec.codeDefault;
    let status;
    if (!sheetHas) status = 'missing';
    else if (sheetVal === codeVal) status = 'match';
    else status = 'drift!';
    rows.push({ key, codeVal, sheetVal, sheetHas, status, constant: spec.constant });
  }
  return rows;
}

export function renderDiffTable(diffRows) {
  const w = (s, n) => String(s).padEnd(n);
  const lines = [];
  lines.push(`| ${w('key', 36)} | ${w('code default', 14)} | ${w('sheet value', 14)} | ${w('status', 8)} | code constant`);
  lines.push(`| ${'-'.repeat(36)} | ${'-'.repeat(14)} | ${'-'.repeat(14)} | ${'-'.repeat(8)} | ----`);
  for (const r of diffRows) {
    const sheet = r.sheetHas ? String(r.sheetVal) : '(missing)';
    lines.push(`| ${w(r.key, 36)} | ${w(r.codeVal, 14)} | ${w(sheet, 14)} | ${w(r.status, 8)} | ${r.constant}`);
  }
  return lines.join('\n');
}

// Snapshot write
export function writeSnapshot(values, tabName = CONFIG_TAB_NAME, snapshotPath = CONFIG_SNAPSHOT_PATH) {
  const dir = dirname(snapshotPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const payload = {
    fetched_at: new Date().toISOString(),
    from_sheet_tab: tabName,
    values,
  };
  writeFileSync(snapshotPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return snapshotPath;
}

// Main
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  loadEnv();
  const workbookId = process.env.GG_SHEETS_FLOW_MVP_WORKBOOK_ID;
  if (!workbookId) {
    console.error('FATAL: GG_SHEETS_FLOW_MVP_WORKBOOK_ID not set in env or ~/.config/gg/_gg.env');
    return 2;
  }
  const saPath = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
  if (!existsSync(saPath)) {
    console.error(`FATAL: writer SA not found at ${saPath}`);
    return 2;
  }

  let token;
  try {
    ({ token } = await getAccessToken(saPath, ['https://www.googleapis.com/auth/spreadsheets']));
  } catch (e) {
    console.error(`FATAL: token exchange failed: ${e.message}`);
    return 2;
  }

  let rows;
  try {
    rows = await fetchConfigTab(workbookId, token);
  } catch (e) {
    console.error(`FATAL: failed to fetch ${CONFIG_RANGE}: ${e.message}`);
    return 2;
  }
  console.error(`[config-sync] fetched ${rows.length} rows from sheet tab \`${CONFIG_TAB_NAME}\``);

  let parsed;
  try {
    parsed = parseConfigRows(rows);
  } catch (e) {
    console.error(`FATAL: parse error: ${e.message}`);
    return 2;
  }
  const recognisedKeys = Object.keys(parsed.values);
  console.error(`[config-sync] recognised ${recognisedKeys.length} key(s); ${parsed.unparsable.length} unparsable; ${parsed.unrecognised.length} unrecognised`);

  if (parsed.unparsable.length) {
    console.error('\nUnparsable rows (kept defaults):');
    for (const u of parsed.unparsable) {
      console.error(`  - ${u.key} = ${JSON.stringify(u.raw)}: ${u.reason}`);
    }
  }
  if (parsed.unrecognised.length) {
    console.error('\nUnrecognised keys (not in SCHEMA, ignored):');
    for (const k of parsed.unrecognised) console.error(`  - ${k}`);
  }

  const diff = buildDiff(parsed.values);
  process.stdout.write('\n' + renderDiffTable(diff) + '\n\n');

  const driftCount = diff.filter((r) => r.status === 'drift!').length;
  const matchCount = diff.filter((r) => r.status === 'match').length;
  const missingCount = diff.filter((r) => r.status === 'missing').length;
  console.error(`[config-sync] ${matchCount} match, ${driftCount} drift, ${missingCount} missing-from-sheet`);

  if (args.diff_only) {
    console.error('[config-sync] --diff-only: skipping snapshot write');
    return 0;
  }
  if (args.dry_run) {
    console.error(`[config-sync] --dry-run: would write ${recognisedKeys.length} values to ${CONFIG_SNAPSHOT_PATH}`);
    return 0;
  }

  const outPath = writeSnapshot(parsed.values);
  console.error(`[config-sync] wrote snapshot → ${outPath}`);
  if (driftCount > 0) {
    console.error('[config-sync] NOTE: red-lines.mjs / gg-keyword-mine.mjs will pick up new values on next import (process restart).');
  }
  return 0;
}

// Run when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('FATAL:', e?.stack || e);
      process.exit(2);
    });
}
