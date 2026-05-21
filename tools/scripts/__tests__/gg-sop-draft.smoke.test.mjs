#!/usr/bin/env node
// Smoke test for gg-sop-draft.mjs
// Node built-in `node:test` + `node:assert` only — no npm deps.
//
// Run:  node --test tools/scripts/__tests__/gg-sop-draft.smoke.test.mjs

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  SUPPORTED_TYPES,
  TEMPLATES,
  parseArgs,
  todayStamp,
  outputFileName,
  renderTemplate,
  generateDraft,
} from '../gg-sop-draft.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'gg-sop-draft.mjs');

// ============================================================
// helpers
// ============================================================

function mkSandbox() {
  return mkdtempSync(join(tmpdir(), 'gg-sop-draft-'));
}

function runCli(args, opts = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    ...opts,
  });
}

// ============================================================
// unit-level
// ============================================================

test('SUPPORTED_TYPES contains exactly the 5 expected types', () => {
  assert.deepEqual([...SUPPORTED_TYPES].sort(), [
    'ai-monitor',
    'm9',
    'monday',
    'reddit',
    'social-distribute',
  ]);
});

test('TEMPLATES has a function for every supported type', () => {
  for (const t of SUPPORTED_TYPES) {
    assert.equal(typeof TEMPLATES[t], 'function', `${t} should map to a function`);
  }
});

test('todayStamp returns YYYY-MM-DD', () => {
  const s = todayStamp(new Date('2026-05-21T10:00:00'));
  assert.match(s, /^\d{4}-\d{2}-\d{2}$/);
});

test('outputFileName matches Ops-SOP-<type>-<stamp>-draft.md', () => {
  assert.equal(
    outputFileName('m9', '2026-05-21'),
    'Ops-SOP-m9-2026-05-21-draft.md',
  );
});

test('parseArgs handles all flags', () => {
  const a = parseArgs(['--type', 'm9', '--out-dir', '/tmp/x', '--force']);
  assert.deepEqual(a, {
    type: 'm9',
    outDir: '/tmp/x',
    force: true,
    list: false,
    help: false,
  });
  const b = parseArgs(['--list']);
  assert.equal(b.list, true);
  const c = parseArgs(['-h']);
  assert.equal(c.help, true);
});

test('renderTemplate throws on unknown type', () => {
  assert.throws(() => renderTemplate('bogus', '2026-05-21'), /unknown SOP type/);
});

test('renderTemplate for each type contains required sections', () => {
  for (const t of SUPPORTED_TYPES) {
    const md = renderTemplate(t, '2026-05-21');
    // PRD §19.2 6 items must show up as section headings
    assert.match(md, /## §1 SOP 目的/, `${t} missing §1`);
    assert.match(md, /## §2 触发时机/, `${t} missing §2`);
    assert.match(md, /## §3 准备工作/, `${t} missing §3`);
    assert.match(md, /## §4 步骤/, `${t} missing §4`);
    assert.match(md, /## §5 验收标准/, `${t} missing §5`);
    assert.match(md, /## §6 失败场景/, `${t} missing §6`);
    assert.match(md, /## §7 wzb LOOK 节点/, `${t} missing §7`);
    // frontmatter sanity
    assert.match(md, /^---\ntitle: Ops SOP — /, `${t} missing frontmatter title`);
    assert.match(md, /\nsop_type: /, `${t} missing sop_type field`);
    assert.match(md, /\nstatus: draft\n/, `${t} status not draft`);
    // date is the stamp
    assert.match(md, /\ndate: 2026-05-21\n/, `${t} date mismatch`);
    // sop_type uses the type slug
    const escaped = t.replace(/-/g, '\\-');
    assert.match(md, new RegExp(`sop_type: ${escaped}`), `${t} sop_type wrong`);
  }
});

// ============================================================
// generateDraft (programmatic)
// ============================================================

test('generateDraft writes file for each type', () => {
  const dir = mkSandbox();
  try {
    for (const t of SUPPORTED_TYPES) {
      const r = generateDraft({ type: t, outDir: dir, force: false });
      assert.ok(existsSync(r.path), `${t}: file not written at ${r.path}`);
      assert.ok(r.bytes > 500, `${t}: file too small (${r.bytes} bytes)`);
      const content = readFileSync(r.path, 'utf8');
      assert.ok(content.includes('## §4 步骤'), `${t}: missing §4 in file`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generateDraft throws UNKNOWN_TYPE for bogus type', () => {
  const dir = mkSandbox();
  try {
    assert.throws(
      () => generateDraft({ type: 'bogus', outDir: dir }),
      (e) => e.code === 'UNKNOWN_TYPE',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generateDraft throws EXISTS when file exists and no --force', () => {
  const dir = mkSandbox();
  try {
    const r1 = generateDraft({ type: 'm9', outDir: dir, force: false });
    assert.ok(existsSync(r1.path));
    assert.throws(
      () => generateDraft({ type: 'm9', outDir: dir, force: false }),
      (e) => e.code === 'EXISTS' && e.path === r1.path,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generateDraft overwrites when --force', () => {
  const dir = mkSandbox();
  try {
    const r1 = generateDraft({ type: 'm9', outDir: dir, force: false });
    const stat1 = statSync(r1.path);
    // wait a tick so mtime differs (filesystems may have sub-second granularity but most resolve)
    const r2 = generateDraft({ type: 'm9', outDir: dir, force: true });
    assert.equal(r2.path, r1.path);
    const stat2 = statSync(r2.path);
    // mtime should be >= original (force overwrote)
    assert.ok(stat2.mtimeMs >= stat1.mtimeMs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generateDraft auto-creates missing out-dir', () => {
  const dir = mkSandbox();
  try {
    const nested = join(dir, 'a', 'b', 'c');
    assert.ok(!existsSync(nested));
    const r = generateDraft({ type: 'monday', outDir: nested, force: false });
    assert.ok(existsSync(r.path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// CLI-level
// ============================================================

test('CLI --list exits 0 and prints all 5 types', () => {
  const r = runCli(['--list']);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  for (const t of SUPPORTED_TYPES) {
    assert.ok(r.stdout.includes(t), `--list output missing ${t}`);
  }
});

test('CLI --help exits 0', () => {
  const r = runCli(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage:/);
});

test('CLI missing --type exits 2', () => {
  const r = runCli([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--type is required/);
});

test('CLI unknown --type exits 2', () => {
  const r = runCli(['--type', 'bogus']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown SOP type/);
});

test('CLI generates file for each type (sandbox out-dir)', () => {
  const dir = mkSandbox();
  try {
    for (const t of SUPPORTED_TYPES) {
      const r = runCli(['--type', t, '--out-dir', dir]);
      assert.equal(r.status, 0, `${t}: status ${r.status}, stderr: ${r.stderr}`);
      assert.match(r.stdout, /\[gg-sop-draft\] wrote /);
    }
    // 5 files in dir
    const stamp = todayStamp();
    for (const t of SUPPORTED_TYPES) {
      const expected = join(dir, outputFileName(t, stamp));
      assert.ok(existsSync(expected), `${t}: missing expected file ${expected}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exits 1 when file exists and no --force; exits 0 with --force', () => {
  const dir = mkSandbox();
  try {
    const r1 = runCli(['--type', 'reddit', '--out-dir', dir]);
    assert.equal(r1.status, 0, `first: ${r1.stderr}`);
    const r2 = runCli(['--type', 'reddit', '--out-dir', dir]);
    assert.equal(r2.status, 1, `expected EXISTS exit 1, got ${r2.status}; stderr: ${r2.stderr}`);
    assert.match(r2.stderr, /already exists/);
    const r3 = runCli(['--type', 'reddit', '--out-dir', dir, '--force']);
    assert.equal(r3.status, 0, `--force should overwrite; stderr: ${r3.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
