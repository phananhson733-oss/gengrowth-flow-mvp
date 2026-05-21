#!/usr/bin/env node
// Smoke test for gg-gate-check.mjs
// Node built-in `node:test` + `node:assert` only — no npm deps.
//
// Run:  node --test tools/scripts/__tests__/gg-gate-check.smoke.test.mjs

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  SUPPORTED_GATES,
  runWeekly,
  runVerticalSlice,
  runDay14,
  runDay30,
  runDay60,
  runGate,
  isoWeekStamp,
  renderConsole,
  renderMarkdown,
} from '../gg-gate-check.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'gg-gate-check.mjs');

// ============================================================
// helpers
// ============================================================

function mkSandbox() {
  return mkdtempSync(join(tmpdir(), 'gg-gate-'));
}

function writeManifest(dir, name, obj) {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

// ============================================================
// metadata
// ============================================================

test('SUPPORTED_GATES contains all 6 gates', () => {
  const expected = ['day-1', 'weekly', 'vertical-slice', 'day-14', 'day-30', 'day-60'];
  for (const g of expected) assert.ok(SUPPORTED_GATES.includes(g), `missing gate: ${g}`);
});

test('isoWeekStamp returns YYYY-Www format', () => {
  const s = isoWeekStamp(new Date('2026-05-21T00:00:00Z'));
  assert.match(s, /^\d{4}-W\d{2}$/);
});

// ============================================================
// weekly
// ============================================================

test('weekly: 3/3 PASS', () => {
  const s = runWeekly({
    wzb_hours_this_week: 16.5,
    articles_published_this_week: 2,
    ops_hours_this_week: 5.5,
  });
  assert.equal(s.passed, 3);
  assert.equal(s.total, 3);
});

test('weekly: wzb hours > 18 → FAIL', () => {
  const s = runWeekly({
    wzb_hours_this_week: 22,
    articles_published_this_week: 2,
    ops_hours_this_week: 5,
  });
  assert.equal(s.passed, 2);
  assert.equal(s.results[0].pass, false);
  assert.match(s.results[0].evidence, /threshold/);
});

test('weekly: missing field → FAIL', () => {
  const s = runWeekly({ articles_published_this_week: 1, ops_hours_this_week: 5 });
  assert.equal(s.passed, 2);
  assert.equal(s.results[0].pass, false);
  assert.match(s.results[0].evidence, /missing field/);
});

test('weekly: non-number field → FAIL', () => {
  const s = runWeekly({
    wzb_hours_this_week: 'too many',
    articles_published_this_week: 1,
    ops_hours_this_week: 5,
  });
  assert.equal(s.passed, 2);
  assert.match(s.results[0].evidence, /not a finite number/);
});

// ============================================================
// vertical-slice
// ============================================================

test('vertical-slice: 3/3 PASS', () => {
  const dir = mkSandbox();
  try {
    const auditPath = join(dir, 'facts-audit.json');
    writeFileSync(auditPath, JSON.stringify({ status: 'pass', critical_count: 0 }));
    const s = runVerticalSlice(
      {
        content_draft_shipped_at: '2026-05-20T10:00:00+08:00',
        vertical_slice_article_url: 'https://example.com/post-1',
        facts_audit_report_path: 'facts-audit.json',
      },
      { baseDir: dir },
    );
    assert.equal(s.passed, 3, JSON.stringify(s.results.filter((r) => !r.pass)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Fix 5 (2026-05-21): vertical-slice gate prefers the new `facts_audit_sidecar_path`
// field and reads the JSON sidecar written by facts-audit.mjs (Fix 4).
test('vertical-slice: NEW field facts_audit_sidecar_path → reads JSON sidecar (PASS)', () => {
  const dir = mkSandbox();
  try {
    const sidecarPath = join(dir, 'facts-audit-2026-05-21.json');
    writeFileSync(
      sidecarPath,
      JSON.stringify({
        ts: '2026-05-21T18:00:00Z',
        status: 'pass',
        critical_count: 0,
        high_count: 0,
        info_count: 0,
        assertions: [
          { id: 1, name: '#1 oracle', severity: 'CRITICAL', status: 'pass', evidence_summary: 'ok' },
        ],
      }),
    );
    const s = runVerticalSlice(
      {
        content_draft_shipped_at: '2026-05-20T10:00:00+08:00',
        vertical_slice_article_url: 'https://example.com/post-1',
        facts_audit_sidecar_path: 'facts-audit-2026-05-21.json',
      },
      { baseDir: dir },
    );
    assert.equal(s.passed, 3, JSON.stringify(s.results.filter((r) => !r.pass)));
    const audit = s.results.find((r) => r.name.includes('facts-audit'));
    assert.equal(audit.field, 'facts_audit_sidecar_path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vertical-slice: facts-audit critical_count > 0 → FAIL', () => {
  const dir = mkSandbox();
  try {
    const auditPath = join(dir, 'facts-audit.json');
    writeFileSync(auditPath, JSON.stringify({ status: 'fail', critical_count: 2 }));
    const s = runVerticalSlice(
      {
        content_draft_shipped_at: '2026-05-20T10:00:00+08:00',
        vertical_slice_article_url: 'https://example.com/post-1',
        facts_audit_report_path: 'facts-audit.json',
      },
      { baseDir: dir },
    );
    assert.equal(s.passed, 2);
    const audit = s.results.find((r) => r.name.includes('facts-audit'));
    assert.equal(audit.pass, false);
    assert.match(audit.evidence, /does not indicate pass/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vertical-slice: facts-audit file missing → FAIL', () => {
  const dir = mkSandbox();
  try {
    const s = runVerticalSlice(
      {
        content_draft_shipped_at: '2026-05-20T10:00:00+08:00',
        vertical_slice_article_url: 'https://example.com/post-1',
        facts_audit_report_path: 'nope.json',
      },
      { baseDir: dir },
    );
    assert.equal(s.passed, 2);
    const audit = s.results.find((r) => r.name.includes('facts-audit'));
    assert.match(audit.evidence, /not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vertical-slice: critical_count=0 (without status) → PASS', () => {
  const dir = mkSandbox();
  try {
    const auditPath = join(dir, 'facts-audit.json');
    writeFileSync(auditPath, JSON.stringify({ critical_count: 0 }));
    const s = runVerticalSlice(
      {
        content_draft_shipped_at: '2026-05-20T10:00:00+08:00',
        vertical_slice_article_url: 'https://example.com/post-1',
        facts_audit_report_path: 'facts-audit.json',
      },
      { baseDir: dir },
    );
    assert.equal(s.passed, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vertical-slice: empty article url → FAIL', () => {
  const dir = mkSandbox();
  try {
    const auditPath = join(dir, 'facts-audit.json');
    writeFileSync(auditPath, JSON.stringify({ status: 'pass' }));
    const s = runVerticalSlice(
      {
        content_draft_shipped_at: '2026-05-20T10:00:00+08:00',
        vertical_slice_article_url: '',
        facts_audit_report_path: 'facts-audit.json',
      },
      { baseDir: dir },
    );
    assert.equal(s.passed, 2);
    const url = s.results.find((r) => r.name.includes('article url'));
    assert.equal(url.pass, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// day-14
// ============================================================

test('day-14: 2/2 PASS (defaults)', () => {
  const s = runDay14({ day14_pageviews: 250, day14_top50_count: 2 });
  assert.equal(s.passed, 2);
});

test('day-14: pageviews below default 100 → FAIL', () => {
  const s = runDay14({ day14_pageviews: 50, day14_top50_count: 1 });
  assert.equal(s.passed, 1);
  assert.equal(s.results[0].pass, false);
});

test('day-14: Top 50 = 0 → FAIL', () => {
  const s = runDay14({ day14_pageviews: 200, day14_top50_count: 0 });
  assert.equal(s.passed, 1);
  assert.equal(s.results[1].pass, false);
});

test('day-14: env override GG_DAY14_PAGEVIEWS_MIN=300', () => {
  const original = process.env.GG_DAY14_PAGEVIEWS_MIN;
  process.env.GG_DAY14_PAGEVIEWS_MIN = '300';
  try {
    const s = runDay14({ day14_pageviews: 250, day14_top50_count: 1 });
    assert.equal(s.passed, 1, 'pageviews 250 should fail under threshold 300');
  } finally {
    if (original == null) delete process.env.GG_DAY14_PAGEVIEWS_MIN;
    else process.env.GG_DAY14_PAGEVIEWS_MIN = original;
  }
});

// ============================================================
// day-30
// ============================================================

// Use a clearly past timestamp so the test isn't time-sensitive.
const PAST_ISO = '2024-01-01T10:00:00+08:00';

test('day-30: 3/3 PASS', () => {
  const s = runDay30({
    day30_top10_count: 3,
    day30_ai_citation_count: 4,
    lynne_day30_signoff_at: PAST_ISO,
  });
  assert.equal(s.passed, 3);
});

test('day-30: Top 10 = 2 + signoff missing → 1/3 FAIL', () => {
  const s = runDay30({
    day30_top10_count: 2,
    day30_ai_citation_count: 4,
  });
  assert.equal(s.passed, 1);
});

test('day-30: signoff in future → FAIL', () => {
  const future = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
  const s = runDay30({
    day30_top10_count: 3,
    day30_ai_citation_count: 3,
    lynne_day30_signoff_at: future,
  });
  assert.equal(s.passed, 2);
  const sign = s.results.find((r) => r.name.includes('sign-off'));
  assert.match(sign.evidence, /future/);
});

// ============================================================
// day-60
// ============================================================

test('day-60: 3/3 PASS (continue)', () => {
  const s = runDay60({
    day60_top10_count: 5,
    day60_ai_citation_count: 4,
    lynne_day60_decision: 'continue',
  });
  assert.equal(s.passed, 3);
});

test('day-60: Lynne decision = kill → FAIL by design', () => {
  const s = runDay60({
    day60_top10_count: 5,
    day60_ai_citation_count: 4,
    lynne_day60_decision: 'kill',
  });
  assert.equal(s.passed, 2);
  const dec = s.results.find((r) => r.name.includes('decision'));
  assert.equal(dec.pass, false);
  assert.match(dec.evidence, /kill/);
});

test('day-60: Lynne decision = "maybe" → FAIL (invalid value)', () => {
  const s = runDay60({
    day60_top10_count: 5,
    day60_ai_citation_count: 4,
    lynne_day60_decision: 'maybe',
  });
  assert.equal(s.passed, 2);
  const dec = s.results.find((r) => r.name.includes('decision'));
  assert.match(dec.evidence, /expected 'continue' or 'kill'/);
});

test('day-60: Top 10 = 1 + continue → 2/3 FAIL', () => {
  const s = runDay60({
    day60_top10_count: 1,
    day60_ai_citation_count: 4,
    lynne_day60_decision: 'continue',
  });
  assert.equal(s.passed, 2);
});

// ============================================================
// runGate dispatcher
// ============================================================

test('runGate: weekly dispatches correctly', () => {
  const s = runGate('weekly', {
    wzb_hours_this_week: 10,
    articles_published_this_week: 1,
    ops_hours_this_week: 5,
  });
  assert.equal(s.total, 3);
  assert.equal(s.passed, 3);
});

test('runGate: unknown gate throws', () => {
  assert.throws(() => runGate('not-a-gate', {}), /unknown gate/);
});

// ============================================================
// renderers
// ============================================================

test('renderConsole has RESULT line and gate name', () => {
  const s = runWeekly({
    wzb_hours_this_week: 5,
    articles_published_this_week: 1,
    ops_hours_this_week: 5,
  });
  const out = renderConsole('weekly', s);
  assert.match(out, /\[gg-gate-check weekly\]/);
  assert.match(out, /RESULT: 3\/3 PASS/);
});

test('renderMarkdown includes table + manifest path', () => {
  const s = runWeekly({
    wzb_hours_this_week: 5,
    articles_published_this_week: 1,
    ops_hours_this_week: 5,
  });
  const md = renderMarkdown({ gate: 'weekly', summary: s, manifestPath: '/tmp/w.json' });
  assert.match(md, /# Gate Report \(weekly\)/);
  assert.match(md, /\/tmp\/w\.json/);
  assert.match(md, /\| # \| check \|/);
  assert.match(md, /3\/3 PASS/);
});

// ============================================================
// CLI: argument validation
// ============================================================

test('CLI: missing --gate → exit 2', () => {
  const res = runCli([]);
  assert.equal(res.status, 2);
  assert.match(res.stderr || '', /--gate <type> is required/);
});

test('CLI: unknown --gate → exit 2', () => {
  const res = runCli(['--gate', 'bogus']);
  assert.equal(res.status, 2);
  assert.match(res.stderr || '', /unknown gate/);
});

test('CLI: --help → exit 0', () => {
  const res = runCli(['--help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout || '', /usage:/);
});

// ============================================================
// CLI: weekly PASS / FAIL end-to-end
// ============================================================

test('CLI: weekly PASS → exit 0 + report written', () => {
  const dir = mkSandbox();
  try {
    const mPath = writeManifest(dir, 'w.json', {
      wzb_hours_this_week: 10,
      articles_published_this_week: 2,
      ops_hours_this_week: 5,
    });
    const outPath = join(dir, 'report.md');
    const res = runCli(['--gate', 'weekly', '--manifest', mPath, '--out', outPath]);
    assert.equal(res.status, 0, `expected 0, got ${res.status}\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stdout, /3\/3 PASS/);
    assert.match(res.stdout, /Report:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: weekly FAIL → exit 1', () => {
  const dir = mkSandbox();
  try {
    const mPath = writeManifest(dir, 'w.json', {
      wzb_hours_this_week: 25,
      articles_published_this_week: 0,
      ops_hours_this_week: 3,
    });
    const outPath = join(dir, 'report.md');
    const res = runCli(['--gate', 'weekly', '--manifest', mPath, '--out', outPath]);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /0\/3 FAIL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: missing manifest file → exit 2', () => {
  const dir = mkSandbox();
  try {
    const outPath = join(dir, 'report.md');
    const res = runCli([
      '--gate',
      'weekly',
      '--manifest',
      join(dir, 'nope.json'),
      '--out',
      outPath,
    ]);
    assert.equal(res.status, 2);
    assert.match(res.stderr || '', /manifest not found|fatal/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// CLI: vertical-slice / day-14 / day-30 / day-60 quick smokes
// ============================================================

test('CLI: vertical-slice PASS', () => {
  const dir = mkSandbox();
  try {
    const auditPath = join(dir, 'facts-audit.json');
    writeFileSync(auditPath, JSON.stringify({ status: 'pass' }));
    const mPath = writeManifest(dir, 'vs.json', {
      content_draft_shipped_at: '2026-05-20T10:00:00+08:00',
      vertical_slice_article_url: 'https://example.com/x',
      facts_audit_report_path: auditPath,
    });
    const outPath = join(dir, 'report.md');
    const res = runCli(['--gate', 'vertical-slice', '--manifest', mPath, '--out', outPath]);
    assert.equal(res.status, 0, `stdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stdout, /3\/3 PASS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: day-14 FAIL (Top 50 = 0)', () => {
  const dir = mkSandbox();
  try {
    const mPath = writeManifest(dir, 'd14.json', {
      day14_pageviews: 200,
      day14_top50_count: 0,
    });
    const outPath = join(dir, 'report.md');
    const res = runCli(['--gate', 'day-14', '--manifest', mPath, '--out', outPath]);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /1\/2 FAIL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: day-30 PASS', () => {
  const dir = mkSandbox();
  try {
    const mPath = writeManifest(dir, 'd30.json', {
      day30_top10_count: 3,
      day30_ai_citation_count: 3,
      lynne_day30_signoff_at: PAST_ISO,
    });
    const outPath = join(dir, 'report.md');
    const res = runCli(['--gate', 'day-30', '--manifest', mPath, '--out', outPath]);
    assert.equal(res.status, 0, `stdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stdout, /3\/3 PASS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: day-60 kill → exit 1', () => {
  const dir = mkSandbox();
  try {
    const mPath = writeManifest(dir, 'd60.json', {
      day60_top10_count: 5,
      day60_ai_citation_count: 5,
      lynne_day60_decision: 'kill',
    });
    const outPath = join(dir, 'report.md');
    const res = runCli(['--gate', 'day-60', '--manifest', mPath, '--out', outPath]);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /2\/3 FAIL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// CLI: day-1 forwarding to gg-day1-gate-check.mjs
// ============================================================

test('CLI: day-1 forwarding — manifest missing → exit 2 (from child)', () => {
  const dir = mkSandbox();
  try {
    const fakeHome = join(dir, 'home');
    mkdirSync(fakeHome, { recursive: true });
    const res = runCli(
      ['--gate', 'day-1', '--manifest', join(dir, 'nope.json'), '--skip-infra', '--out', join(dir, 'report.md')],
      { HOME: fakeHome },
    );
    assert.equal(res.status, 2, `expected 2, got ${res.status}\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr || '', /manifest not found|fatal/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: day-1 forwarding — full PASS manifest → exit 0', () => {
  const dir = mkSandbox();
  try {
    // mirror the day-1 fixture structure
    const evidencePath = join(dir, 'lynne-evidence.eml');
    writeFileSync(evidencePath, 'lynne signoff stub');
    const mPath = writeManifest(dir, 'day1.json', {
      ops_contract_signed_at: '2026-05-20T14:30:00+08:00',
      ops_read_prd_sec19_at: '2026-05-20T15:00:00+08:00',
      ops_week2_start_date: '2026-05-27',
      ops_backup_person: 'Zhang San (zhang@example.com)',
      lynne_kill_commit_archived_at: '2026-05-20T16:00:00+08:00',
      lynne_kill_commit_evidence_path: evidencePath,
    });
    const outPath = join(dir, 'report.md');
    const res = runCli([
      '--gate', 'day-1',
      '--manifest', mPath,
      '--skip-infra',
      '--out', outPath,
    ]);
    assert.equal(res.status, 0, `expected 0, got ${res.status}\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stdout, /5\/5 PASS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: day-1 forwarding — partial FAIL manifest → exit 1', () => {
  const dir = mkSandbox();
  try {
    const evidencePath = join(dir, 'lynne-evidence.eml');
    writeFileSync(evidencePath, 'lynne signoff stub');
    const mPath = writeManifest(dir, 'day1.json', {
      ops_contract_signed_at: '2026-05-20T14:30:00+08:00',
      ops_read_prd_sec19_at: '2026-05-20T15:00:00+08:00',
      ops_week2_start_date: '2026-05-27',
      ops_backup_person: 'Zhang San (zhang@example.com)',
      // missing lynne_kill_commit_archived_at
      lynne_kill_commit_evidence_path: evidencePath,
    });
    const outPath = join(dir, 'report.md');
    const res = runCli([
      '--gate', 'day-1',
      '--manifest', mPath,
      '--skip-infra',
      '--out', outPath,
    ]);
    assert.equal(res.status, 1, `expected 1, got ${res.status}\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stdout, /4\/5 FAIL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
