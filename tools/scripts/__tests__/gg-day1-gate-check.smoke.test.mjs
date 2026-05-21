#!/usr/bin/env node
// Smoke test for gg-day1-gate-check.mjs
// Node built-in `node:test` + `node:assert` only — no npm deps.
//
// Run:  node --test tools/scripts/__tests__/gg-day1-gate-check.smoke.test.mjs

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  loadManifest,
  runAllChecks,
  checkOpsContractSigned,
  checkOpsReadPrd,
  checkOpsWeek2StartDate,
  checkOpsBackupPerson,
  parseIsoTimestamp,
  parseIsoDate,
  redact,
} from '../gg-day1-gate-check.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'gg-day1-gate-check.mjs');

// ============================================================
// helpers
// ============================================================

function mkSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'gg-day1-gate-'));
  return dir;
}

function writeFixture(dir, manifest, { evidenceContent = 'lynne signoff stub' } = {}) {
  const evidencePath = join(dir, 'lynne-evidence.eml');
  writeFileSync(evidencePath, evidenceContent);
  const merged = {
    ...manifest,
    lynne_kill_commit_evidence_path: manifest.lynne_kill_commit_evidence_path || evidencePath,
  };
  const manifestPath = join(dir, 'day1-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(merged, null, 2));
  return { manifestPath, evidencePath };
}

function fullValidManifest() {
  return {
    ops_contract_signed_at: '2026-05-20T14:30:00+08:00',
    ops_read_prd_sec19_at: '2026-05-20T15:00:00+08:00',
    ops_week2_start_date: '2026-05-27',
    ops_backup_person: 'Zhang San (zhang@example.com)',
    lynne_kill_commit_archived_at: '2026-05-20T16:00:00+08:00',
    // evidence_path filled by writeFixture
  };
}

// ============================================================
// unit-level checks
// ============================================================

test('parseIsoTimestamp accepts valid ISO + rejects garbage', () => {
  assert.ok(parseIsoTimestamp('2026-05-20T14:30:00+08:00'));
  assert.ok(parseIsoTimestamp('2026-05-20T14:30:00Z'));
  assert.equal(parseIsoTimestamp('2026-05-20'), null);
  assert.equal(parseIsoTimestamp('not a date'), null);
  assert.equal(parseIsoTimestamp(''), null);
  assert.equal(parseIsoTimestamp(null), null);
  assert.equal(parseIsoTimestamp(12345), null);
});

test('parseIsoDate accepts YYYY-MM-DD + rejects garbage', () => {
  assert.ok(parseIsoDate('2026-05-27'));
  assert.equal(parseIsoDate('2026/05/27'), null);
  assert.equal(parseIsoDate('soon'), null);
  assert.equal(parseIsoDate(''), null);
});

test('redact strips tokens', () => {
  const s = redact('Authorization: Bearer abcdef.1234567890.qwerty');
  assert.ok(!s.includes('abcdef.1234567890.qwerty'));
  assert.ok(s.includes('<redacted>'));
});

// ============================================================
// 5/5 PASS case (full valid manifest)
// ============================================================

test('full valid manifest → 5/5 PASS', () => {
  const dir = mkSandbox();
  try {
    const { manifestPath } = writeFixture(dir, fullValidManifest());
    const manifest = loadManifest(manifestPath);
    const summary = runAllChecks(manifest, { baseDir: dir });
    assert.equal(summary.total, 5);
    assert.equal(summary.passed, 5, `expected 5/5, got ${summary.passed}/5; failures: ${JSON.stringify(summary.results.filter((r) => !r.pass))}`);
    for (const r of summary.results) assert.equal(r.pass, true, `${r.name} should pass`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// 4/5: missing lynne_kill_commit_archived_at
// ============================================================

test('missing lynne_kill_commit_archived_at → 4/5 (lynne fails)', () => {
  const dir = mkSandbox();
  try {
    const m = fullValidManifest();
    delete m.lynne_kill_commit_archived_at;
    const { manifestPath } = writeFixture(dir, m);
    const manifest = loadManifest(manifestPath);
    const summary = runAllChecks(manifest, { baseDir: dir });
    assert.equal(summary.passed, 4);
    const lynne = summary.results.find((r) => r.name === 'Lynne sign-off');
    assert.equal(lynne.pass, false);
    assert.match(lynne.evidence, /lynne_kill_commit_archived_at/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// 4/5: evidence file does not exist
// ============================================================

test('lynne evidence file missing → 4/5 (lynne fails)', () => {
  const dir = mkSandbox();
  try {
    const m = fullValidManifest();
    m.lynne_kill_commit_evidence_path = join(dir, 'does-not-exist.eml');
    const manifestPath = join(dir, 'day1-manifest.json');
    writeFileSync(manifestPath, JSON.stringify(m, null, 2));
    const manifest = loadManifest(manifestPath);
    const summary = runAllChecks(manifest, { baseDir: dir });
    assert.equal(summary.passed, 4);
    const lynne = summary.results.find((r) => r.name === 'Lynne sign-off');
    assert.equal(lynne.pass, false);
    assert.match(lynne.evidence, /evidence file not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// 4/5: lynne_kill_commit_archived_at not parseable
// ============================================================

test('lynne timestamp not ISO → 4/5 (lynne fails)', () => {
  const dir = mkSandbox();
  try {
    const m = fullValidManifest();
    m.lynne_kill_commit_archived_at = 'yesterday around 4pm';
    const { manifestPath } = writeFixture(dir, m);
    const manifest = loadManifest(manifestPath);
    const summary = runAllChecks(manifest, { baseDir: dir });
    assert.equal(summary.passed, 4);
    const lynne = summary.results.find((r) => r.name === 'Lynne sign-off');
    assert.equal(lynne.pass, false);
    assert.match(lynne.evidence, /not a valid ISO timestamp/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// 4/5: lynne evidence file is empty (size 0)
// ============================================================

test('lynne evidence file empty (size 0) → 4/5 (lynne fails)', () => {
  const dir = mkSandbox();
  try {
    const { manifestPath } = writeFixture(dir, fullValidManifest(), {
      evidenceContent: '',
    });
    const manifest = loadManifest(manifestPath);
    const summary = runAllChecks(manifest, { baseDir: dir });
    assert.equal(summary.passed, 4);
    const lynne = summary.results.find((r) => r.name === 'Lynne sign-off');
    assert.equal(lynne.pass, false);
    assert.match(lynne.evidence, /empty \(size=0\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// individual check field validators
// ============================================================

test('checkOpsContractSigned rejects future timestamp', () => {
  const future = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
  const r = checkOpsContractSigned({ ops_contract_signed_at: future });
  assert.equal(r.pass, false);
  assert.match(r.evidence, /future/);
});

test('checkOpsReadPrd accepts legacy field name', () => {
  const r = checkOpsReadPrd({ ops_prd_read_at: '2026-05-20T15:00:00+08:00' });
  assert.equal(r.pass, true);
});

test('checkOpsWeek2StartDate rejects "尽快开始"', () => {
  const r = checkOpsWeek2StartDate({ ops_week2_start_date: '尽快开始' });
  assert.equal(r.pass, false);
});

test('checkOpsBackupPerson accepts non-empty array', () => {
  const r = checkOpsBackupPerson({ ops_backup_persons: ['Zhang (z@e.com)', 'Li (l@e.com)'] });
  assert.equal(r.pass, true);
  assert.match(r.evidence, /2 person/);
});

test('checkOpsBackupPerson rejects empty array', () => {
  const r = checkOpsBackupPerson({ ops_backup_persons: [] });
  assert.equal(r.pass, false);
});

test('checkOpsBackupPerson rejects missing both fields', () => {
  const r = checkOpsBackupPerson({});
  assert.equal(r.pass, false);
});

// ============================================================
// manifest IO
// ============================================================

test('loadManifest throws MANIFEST_MISSING when file does not exist', () => {
  const dir = mkSandbox();
  try {
    const p = join(dir, 'nope.json');
    try {
      loadManifest(p);
      assert.fail('expected throw');
    } catch (e) {
      assert.equal(e.code, 'MANIFEST_MISSING');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadManifest throws MANIFEST_PARSE on bad JSON', () => {
  const dir = mkSandbox();
  try {
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{not valid json');
    try {
      loadManifest(p);
      assert.fail('expected throw');
    } catch (e) {
      assert.equal(e.code, 'MANIFEST_PARSE');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// end-to-end CLI exit codes (spawn the script)
// ============================================================

test('CLI: manifest not found → exit code 2', () => {
  const dir = mkSandbox();
  try {
    const fakeHome = join(dir, 'home');
    mkdirSync(fakeHome, { recursive: true });
    const res = spawnSync(process.execPath, [SCRIPT, '--manifest', join(dir, 'nope.json'), '--skip-infra', '--out', join(dir, 'report.md')], {
      env: { ...process.env, HOME: fakeHome },
      encoding: 'utf8',
    });
    assert.equal(res.status, 2, `expected exit 2, got ${res.status}\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr || '', /manifest not found|fatal/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: 5/5 PASS → exit code 0 + report written', () => {
  const dir = mkSandbox();
  try {
    const { manifestPath } = writeFixture(dir, fullValidManifest());
    const outPath = join(dir, 'report.md');
    const res = spawnSync(process.execPath, [SCRIPT, '--manifest', manifestPath, '--skip-infra', '--out', outPath], {
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stdout, /5\/5 PASS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: 4/5 FAIL → exit code 1', () => {
  const dir = mkSandbox();
  try {
    const m = fullValidManifest();
    delete m.lynne_kill_commit_archived_at;
    const { manifestPath } = writeFixture(dir, m);
    const outPath = join(dir, 'report.md');
    const res = spawnSync(process.execPath, [SCRIPT, '--manifest', manifestPath, '--skip-infra', '--out', outPath], {
      encoding: 'utf8',
    });
    assert.equal(res.status, 1, `expected exit 1, got ${res.status}\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stdout, /4\/5 FAIL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
