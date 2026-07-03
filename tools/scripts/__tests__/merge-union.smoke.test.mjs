#!/usr/bin/env node
// Smoke tests for lib/merge-union.mjs — the deterministic union self-heal that lets an already
// CLAIMS_LOCK-serialized oracle publish merge recover from a stale-branch additive conflict
// (阶段 3 · 串行发布强制). Pure-function tests + REAL git integration (no gh / no npm needed).
// Run: node --test tools/scripts/__tests__/merge-union.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB = join(__dirname, '..', 'lib', 'merge-union.mjs');
const {
  unionResolveConflictedText,
  hasConflictMarkers,
  classifyConflicts,
  looksLikeMergeConflict,
  unionMergeIntoWorktree,
  ORACLE_ADDITIVE_FILES,
} = await import(LIB);

// ── pure functions ───────────────────────────────────────────────────────────
test('unionResolveConflictedText: 2-way markers keep BOTH sides, drop markers', () => {
  const conflicted = [
    'const A = [',
    '<<<<<<< HEAD',
    "  'b',",
    '=======',
    "  'a',",
    '>>>>>>> origin/main',
    '];',
    '',
  ].join('\n');
  const r = unionResolveConflictedText(conflicted);
  assert.ok(r.includes("  'a',") && r.includes("  'b',"), 'both slugs survive');
  assert.ok(!hasConflictMarkers(r), 'no markers remain');
  assert.equal(r, "const A = [\n  'b',\n  'a',\n];\n");
});

test('unionResolveConflictedText: diff3 markers drop the base section', () => {
  const conflicted = [
    'X = [',
    '<<<<<<< HEAD',
    "  'b',",
    '||||||| base',
    '=======',
    "  'a',",
    '>>>>>>> origin/main',
    '];',
  ].join('\n');
  const r = unionResolveConflictedText(conflicted);
  assert.ok(r.includes("  'a',") && r.includes("  'b',"));
  assert.ok(!r.includes('base'), 'base marker label dropped');
  assert.ok(!hasConflictMarkers(r));
});

test('unionResolveConflictedText: clean text passes through unchanged', () => {
  const clean = "const A = [\n  'x',\n];\n";
  assert.equal(unionResolveConflictedText(clean), clean);
});

test('hasConflictMarkers detects all three marker kinds', () => {
  assert.ok(hasConflictMarkers('a\n<<<<<<< x\nb'));
  assert.ok(hasConflictMarkers('a\n=======\nb'));
  assert.ok(hasConflictMarkers('a\n>>>>>>> x\nb'));
  assert.ok(!hasConflictMarkers("const A = ['x'];"));
});

test('classifyConflicts: additive-only ok, anything else offends', () => {
  assert.deepEqual(classifyConflicts([...ORACLE_ADDITIVE_FILES]), { ok: true, offending: [] });
  assert.deepEqual(classifyConflicts([]), { ok: true, offending: [] });
  const bad = classifyConflicts(['data/articles/index.ts', 'data/articles/some-slug.ts']);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.offending, ['data/articles/some-slug.ts']);
});

test('looksLikeMergeConflict: conflict phrasing true, infra errors false', () => {
  assert.ok(looksLikeMergeConflict('Pull request is not mergeable'));
  assert.ok(looksLikeMergeConflict('GraphQL: Pull Request is not in a mergeable state'));
  assert.ok(looksLikeMergeConflict('merge conflict in data/articles/index.ts'));
  assert.ok(!looksLikeMergeConflict('authentication required'));
  assert.ok(!looksLikeMergeConflict('could not resolve host github.com'));
  assert.ok(!looksLikeMergeConflict(''));
});

// ── real git integration ──────────────────────────────────────────────────────
function gitFactory(repo) {
  return (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function g(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const INDEX = 'data/articles/index.ts';
const GEN = 'scripts/generate-seo-pages.mjs';

// A repo on `main` with the two additive files as front-insert arrays, plus an unrelated file.
function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'merge-union-'));
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 't@t.test');
  g(repo, 'config', 'user.name', 'Test');
  mkdirSync(join(repo, 'data', 'articles'), { recursive: true });
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(join(repo, INDEX), 'export const ARTICLES = [\n];\n');
  writeFileSync(join(repo, GEN), 'const ARTICLE_SLUGS_EN_ONLY = [\n];\n');
  writeFileSync(join(repo, 'other.ts'), 'export const OTHER = "base";\n');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-qm', 'base');
  return repo;
}
// front-insert a slug line into both additive arrays (mirrors REG + registerSeoSlug head-insert)
function frontInsert(repo, slug) {
  for (const f of [INDEX, GEN]) {
    const abs = join(repo, f);
    writeFileSync(abs, readFileSync(abs, 'utf8').replace('[\n', `[\n  '${slug}',\n`));
  }
}

test('git: stale-branch additive conflict → union keeps BOTH slugs, new merge commit', () => {
  const repo = initRepo();
  try {
    const base = g(repo, 'rev-parse', 'HEAD');
    // branch B off base: registers 'bravo'
    g(repo, 'checkout', '-q', '-b', 'branchB');
    frontInsert(repo, 'bravo'); g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'publish bravo');
    const bravoHead = g(repo, 'rev-parse', 'HEAD');
    // main advances: an intervening publish registered 'alpha' at the same head position
    g(repo, 'checkout', '-q', 'main');
    frontInsert(repo, 'alpha'); g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'publish alpha');
    // now merge main INTO branchB (what unionRebaseBranch does)
    g(repo, 'checkout', '-q', 'branchB');
    const res = unionMergeIntoWorktree(repo, 'main', { git: gitFactory(repo) });

    assert.equal(res.merged, true);
    assert.deepEqual(res.conflicted.sort(), [INDEX, GEN].sort());
    for (const f of [INDEX, GEN]) {
      const txt = readFileSync(join(repo, f), 'utf8');
      assert.ok(txt.includes("'alpha'"), `${f} has alpha`);
      assert.ok(txt.includes("'bravo'"), `${f} has bravo`);
      assert.ok(!hasConflictMarkers(txt), `${f} has no markers`);
    }
    // a real merge commit (2 parents), advanced past both bravoHead and base
    const parents = g(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ');
    assert.equal(parents.length, 3, 'HEAD is a merge commit with 2 parents');
    assert.notEqual(g(repo, 'rev-parse', 'HEAD'), bravoHead);
    assert.notEqual(g(repo, 'rev-parse', 'HEAD'), base);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('git: non-additive conflict → throws and aborts (clean tree, HEAD unchanged)', () => {
  const repo = initRepo();
  try {
    g(repo, 'checkout', '-q', '-b', 'branchB');
    // branchB touches other.ts (NOT an additive registration file)
    writeFileSync(join(repo, 'other.ts'), 'export const OTHER = "branchB";\n');
    g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'branchB edits other');
    const branchBHead = g(repo, 'rev-parse', 'HEAD');
    // main edits the SAME line of other.ts → guaranteed conflict on a non-additive file
    g(repo, 'checkout', '-q', 'main');
    writeFileSync(join(repo, 'other.ts'), 'export const OTHER = "main";\n');
    g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'main edits other');
    g(repo, 'checkout', '-q', 'branchB');

    assert.throws(
      () => unionMergeIntoWorktree(repo, 'main', { git: gitFactory(repo) }),
      /non-additive conflict in other\.ts/,
    );
    // merge aborted: tree clean, HEAD still branchB tip
    assert.equal(g(repo, 'status', '--porcelain'), '', 'working tree is clean after abort');
    assert.equal(g(repo, 'rev-parse', 'HEAD'), branchBHead, 'HEAD unchanged after abort');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('git: non-overlapping additive changes → clean auto-merge, no union needed', () => {
  const repo = initRepo();
  try {
    // seed both arrays with an existing tail element so main can append at the END
    for (const f of [INDEX, GEN]) {
      const abs = join(repo, f);
      writeFileSync(abs, readFileSync(abs, 'utf8').replace('\n];', "\n  'seed',\n];"));
    }
    g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'seed tail');
    g(repo, 'checkout', '-q', '-b', 'branchB');
    frontInsert(repo, 'bravo'); g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'bravo front');
    g(repo, 'checkout', '-q', 'main');
    for (const f of [INDEX, GEN]) { // main appends at END — different hunk than the front insert
      const abs = join(repo, f);
      writeFileSync(abs, readFileSync(abs, 'utf8').replace("  'seed',\n];", "  'seed',\n  'alpha',\n];"));
    }
    g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'alpha end');
    g(repo, 'checkout', '-q', 'branchB');
    const res = unionMergeIntoWorktree(repo, 'main', { git: gitFactory(repo) });
    assert.equal(res.merged, true);
    assert.deepEqual(res.conflicted, [], 'no conflicts — git auto-merged');
    for (const f of [INDEX, GEN]) {
      const txt = readFileSync(join(repo, f), 'utf8');
      assert.ok(txt.includes("'alpha'") && txt.includes("'bravo'") && txt.includes("'seed'"));
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('git: onto already an ancestor → merged:false, no new commit', () => {
  const repo = initRepo();
  try {
    g(repo, 'checkout', '-q', '-b', 'branchB');
    frontInsert(repo, 'bravo'); g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'bravo');
    const head = g(repo, 'rev-parse', 'HEAD');
    // main is an ancestor of branchB (branchB was cut from it, no main advance)
    const res = unionMergeIntoWorktree(repo, 'main', { git: gitFactory(repo) });
    assert.equal(res.merged, false);
    assert.deepEqual(res.conflicted, []);
    assert.equal(g(repo, 'rev-parse', 'HEAD'), head, 'no new commit created');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
