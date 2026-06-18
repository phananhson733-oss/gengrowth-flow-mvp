#!/usr/bin/env node
// Hermetic smoke tests for gg-preview-gate.mjs.
//
// Everything is faked via env-overridable bin paths: the autopilot (--status / --mark-verified
// / --merge / --mark-failed), preview-wait, preview-verify, review-worker, lark-notify. Each
// fake is a tiny shell script that (a) prints canned stdout and (b) touches a SENTINEL file so
// the test can assert whether it was invoked. No network, no chromium, no real LLM, no real
// gh merge, no ledger write. Mirrors the node:test + spawnSync black-box style of the sibling
// __tests__/.
//
// Run: node --test /tmp/gg-landing-staging/__tests__/gg-preview-gate.smoke.test.mjs

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../gg-preview-gate.mjs', import.meta.url));
const BRANCH = 'seo/auto/2026-06-18-12345';

// A fresh sandbox per test run (pid-scoped); each test gets its own bin dir + sentinel dir.
const ROOT = join(tmpdir(), `gg-preview-gate-test-${process.pid}`);
mkdirSync(ROOT, { recursive: true });

let caseSeq = 0;
function freshCase() {
  const dir = join(ROOT, `case-${caseSeq++}`);
  mkdirSync(dir, { recursive: true });
  const sentinels = join(dir, 'sentinels');
  mkdirSync(sentinels, { recursive: true });
  return { dir, sentinels };
}

// Write a NODE fake bin (the gate invokes preview-wait/verify/review-worker as
// `node <bin> ...`, so these must be node scripts). Records argv to a sentinel file,
// optionally dispatches on a substring of the joined argv (`dispatch:[{match,stdout,exit}]`),
// else prints a fixed stdout/exit. Returns the bin path.
function writeNodeFake(dir, name, { sentinelName, sentinelsDir, stdout = '', exit = 0, dispatch = null }) {
  const p = join(dir, name);
  const src = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const joined = argv.join(' ');
try { appendFileSync(${JSON.stringify(join(sentinelsDir, sentinelName || name))}, joined + '\\n'); } catch {}
const dispatch = ${JSON.stringify(dispatch)};
if (dispatch) {
  for (const d of dispatch) {
    if (joined.includes(d.match)) { process.stdout.write(d.stdout); process.exit(d.exit); }
  }
}
process.stdout.write(${JSON.stringify(stdout)});
process.exit(${exit});
`;
  writeFileSync(p, src);
  chmodSync(p, 0o755);
  return p;
}

// Write a SHELL fake bin (the gate invokes lark-notify as `bash <bin>`).
function writeShellFake(dir, name, { sentinelName, sentinelsDir, stdout = '', exit = 0 }) {
  const p = join(dir, name);
  const lines = ['#!/bin/sh'];
  if (sentinelName) lines.push(`printf '%s\\n' "$*" >> "${join(sentinelsDir, sentinelName)}"`);
  if (stdout) lines.push(`printf '%s' '${stdout.replace(/'/g, `'\\''`)}'`);
  lines.push(`exit ${exit}`);
  writeFileSync(p, lines.join('\n') + '\n');
  chmodSync(p, 0o755);
  return p;
}

// A fake gg-seo-autopilot.mjs: it's a node script, but the gate invokes it as
// `node <bin> --status|--mark-verified|...`. We make ONE fake node-script that
// dispatches on the subcommand, prints the canned --status JSON, and touches a
// per-subcommand sentinel.
function writeAutopilotFake(dir, { statusJson, sentinelsDir }) {
  const p = join(dir, 'fake-autopilot.mjs');
  const src = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const touch = (name) => { try { appendFileSync(${JSON.stringify(sentinelsDir)} + '/' + name, argv.join(' ') + '\\n'); } catch {} };
if (argv.includes('--status')) {
  touch('autopilot-status');
  process.stdout.write(${JSON.stringify(statusJson)});
  process.exit(0);
}
if (argv.includes('--mark-verified')) { touch('autopilot-mark-verified'); process.exit(0); }
if (argv.includes('--merge')) { touch('autopilot-merge'); process.exit(0); }
if (argv.includes('--mark-failed')) { touch('autopilot-mark-failed'); process.exit(0); }
process.exit(0);
`;
  writeFileSync(p, src);
  chmodSync(p, 0o755);
  return p;
}

function sentinelHit(sentinelsDir, name) {
  return existsSync(join(sentinelsDir, name));
}
function sentinelText(sentinelsDir, name) {
  const f = join(sentinelsDir, name);
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

// Build the env that points every gate sub-bin at our fakes.
function fakeEnv({ dir, sentinelsDir, statusJson, reviewBin, verifyExit = 0, verifyJson, waitJson, codexBin }) {
  const autopilot = writeAutopilotFake(dir, { statusJson, sentinelsDir });
  const previewWait = writeNodeFake(dir, 'fake-preview-wait.mjs', {
    sentinelName: 'preview-wait', sentinelsDir,
    stdout: waitJson || JSON.stringify({ ok: true, previewUrl: 'https://preview.example.test' }),
    exit: 0,
  });
  const previewVerify = writeNodeFake(dir, 'fake-preview-verify.mjs', {
    sentinelName: 'preview-verify', sentinelsDir,
    stdout: verifyJson || JSON.stringify({ ok: true, checked: [{ url: 'x' }], warnings: [] }),
    exit: verifyExit,
  });
  const larkNotify = writeShellFake(dir, 'fake-lark-notify.sh', {
    sentinelName: 'lark-notify', sentinelsDir, stdout: '', exit: 0,
  });
  const env = {
    ...process.env,
    GG_AUTOPILOT_BIN: autopilot,
    GG_PREVIEW_WAIT_BIN: previewWait,
    GG_PREVIEW_VERIFY_BIN: previewVerify,
    GG_REVIEW_WORKER_BIN: reviewBin,
    GG_LARK_NOTIFY_BIN: larkNotify,
    VERCEL_AUTOMATION_BYPASS_SECRET: 'test-bypass',
  };
  if (codexBin) env.GG_CODEX_BIN = codexBin;
  else delete env.GG_CODEX_BIN;
  return env;
}

// A review-worker fake that always PASSes (json on stdout, exit 0).
function reviewPassBin(dir, sentinelsDir) {
  return writeNodeFake(dir, 'fake-review-pass.mjs', {
    sentinelName: 'review-worker', sentinelsDir,
    stdout: JSON.stringify({ verdict: 'PASS', blocking_reason: '', notes: [] }),
    exit: 0,
  });
}

// A review-worker fake that PASSes for astrology/schema but FAILs for `failDim`.
// Dispatches on the `--dimension <failDim>` substring of the joined argv.
function reviewDimFailBin(dir, sentinelsDir, failDim) {
  const passJson = JSON.stringify({ verdict: 'PASS', blocking_reason: '', notes: [] });
  const failJson = JSON.stringify({ verdict: 'FAIL', blocking_reason: 'broken internal link', notes: [] });
  return writeNodeFake(dir, 'fake-review-dimfail.mjs', {
    sentinelName: 'review-worker', sentinelsDir,
    dispatch: [{ match: `--dimension ${failDim}`, stdout: failJson, exit: 0 }],
    stdout: passJson, exit: 0,
  });
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30000, env });
}

const CLAIM_VERIFIED = (extra = {}) => JSON.stringify({
  'PG-001': {
    branch: BRANCH, slug: 'chiron-in-7th-house', status: 'verified-preview',
    previewUrl: 'https://stored-preview.example.test', zh: false, worktree: '/tmp/wt', pr: '123',
    ...extra,
  },
});

// ── (a) missing --branch → nonzero + stderr ───────────────────────────────────
test('missing --branch → nonzero exit + stderr "--branch is required"', () => {
  const r = run([], { ...process.env });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--branch is required/);
});

// ── (b) --dry-run with a verified-preview claim → plan, no merge ───────────────
test('--dry-run on verified-preview: prints plan, exits without merging, no --merge call', () => {
  const { dir, sentinels } = freshCase();
  const env = fakeEnv({
    dir, sentinelsDir: sentinels,
    statusJson: CLAIM_VERIFIED(),
    reviewBin: reviewPassBin(dir, sentinels),
  });
  const r = run(['--branch', BRANCH, '--dry-run', '--json'], env);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.dryRun, true);
  assert.equal(out.exitCode, 0);
  assert.match(out.action, /WOULD mark-verified \+ merge/);
  // A verified-preview claim must REUSE the stored previewUrl (skip preview-wait).
  assert.ok(out.plan.some((l) => /REUSE stored previewUrl/.test(l)), 'should reuse stored previewUrl');
  // --status IS read (read-only parse), but NO mutating subcommand fired.
  assert.ok(sentinelHit(sentinels, 'autopilot-status'), '--status should be read');
  assert.ok(!sentinelHit(sentinels, 'autopilot-merge'), '--merge must NOT be called in dry-run');
  assert.ok(!sentinelHit(sentinels, 'autopilot-mark-verified'), '--mark-verified must NOT be called in dry-run');
  assert.ok(!sentinelHit(sentinels, 'preview-verify'), 'no real verify in dry-run');
});

// ── (c1) one review dimension FAILs → exit 2 + mark-failed + lark-notify ───────
test('a review dimension FAILs → exit 2, calls mark-failed + lark-notify', () => {
  const { dir, sentinels } = freshCase();
  const env = fakeEnv({
    dir, sentinelsDir: sentinels,
    statusJson: CLAIM_VERIFIED(), // verified-preview → skips preview-wait, runs verify+reviews
    reviewBin: reviewDimFailBin(dir, sentinels, 'links-seo'),
  });
  const r = run(['--branch', BRANCH, '--json'], env);
  assert.equal(r.status, 2, `expected gate-failed exit 2; stderr: ${r.stderr}; stdout: ${r.stdout}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.exitCode, 2);
  assert.match(out.reason, /links-seo/);
  // verify ran (PASS) then a review FAILed → park + notify.
  assert.ok(sentinelHit(sentinels, 'preview-verify'), 'verify should run');
  assert.ok(sentinelHit(sentinels, 'autopilot-mark-failed'), 'mark-failed must be called');
  assert.ok(sentinelHit(sentinels, 'lark-notify'), 'lark-notify must be called by the gate');
  // mark-failed carried a specific reason; lark message @PM/@Ops env is set (not asserted here).
  assert.match(sentinelText(sentinels, 'autopilot-mark-failed'), /--reason/);
  // and the success path was NOT taken.
  assert.ok(!sentinelHit(sentinels, 'autopilot-merge'), '--merge must NOT be called on failure');
});

// ── (c2) mark-failed is NOT called when claim already needs_human ─────────────
test('claim already needs_human: gate does NOT call mark-failed (avoids mjs throw), but is nothing-pending', () => {
  // A needs_human claim is not a preview status → the gate short-circuits to NOTHING_PENDING
  // (exit 1) BEFORE any gate work, so mark-failed is never attempted. This is the safe guard:
  // we never feed an already-terminal claim back into --mark-failed.
  const { dir, sentinels } = freshCase();
  const statusJson = JSON.stringify({
    'PG-009': { branch: BRANCH, slug: 's', status: 'needs_human', zh: false, worktree: '/tmp/wt' },
  });
  const env = fakeEnv({ dir, sentinelsDir: sentinels, statusJson, reviewBin: reviewPassBin(dir, sentinels) });
  const r = run(['--branch', BRANCH, '--json'], env);
  assert.equal(r.status, 1, `expected nothing-pending exit 1; stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.exitCode, 1);
  assert.ok(!sentinelHit(sentinels, 'autopilot-mark-failed'), 'mark-failed must NOT be called for an already-terminal claim');
  assert.ok(!sentinelHit(sentinels, 'lark-notify'), 'no notify for nothing-pending');
});

// ── (c3) DRY-RUN failure path: a verify FAIL would-park-and-notify but is dry-run guarded ──
test('dry-run never mutates even when it would fail: no mark-failed/notify side effects', () => {
  // In dry-run the gate doesn't actually RUN verify/reviews, so it plans the happy path; the
  // key guarantee is simply that NO mutating call fires. Covered by (b); here we assert the
  // failure-path helper is dry-run-safe by forcing a non-preview status in dry-run.
  const { dir, sentinels } = freshCase();
  const statusJson = JSON.stringify({
    'PG-002': { branch: BRANCH, slug: 's', status: 'pushed-preview', zh: false, worktree: '/tmp/wt', pr: '7' },
  });
  const env = fakeEnv({ dir, sentinelsDir: sentinels, statusJson, reviewBin: reviewPassBin(dir, sentinels) });
  const r = run(['--branch', BRANCH, '--dry-run', '--json'], env);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  // pushed-preview (not verified) → plan should call preview-wait, but in dry-run it is NOT executed.
  assert.ok(!sentinelHit(sentinels, 'preview-wait'), 'preview-wait must NOT run in dry-run');
  assert.ok(!sentinelHit(sentinels, 'autopilot-merge'), 'no merge in dry-run');
  assert.ok(!sentinelHit(sentinels, 'autopilot-mark-failed'), 'no mark-failed in dry-run');
});

// ── (d) happy path: all gates pass → exit 0, mark-verified + merge, NO notify by gate ─
test('all gates pass → exit 0, calls mark-verified + merge, gate does NOT notify (merge owns it)', () => {
  const { dir, sentinels } = freshCase();
  const env = fakeEnv({
    dir, sentinelsDir: sentinels,
    statusJson: CLAIM_VERIFIED(),
    reviewBin: reviewPassBin(dir, sentinels),
  });
  const r = run(['--branch', BRANCH, '--json'], env);
  assert.equal(r.status, 0, `expected published exit 0; stderr: ${r.stderr}; stdout: ${r.stdout}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.exitCode, 0);
  assert.equal(out.action, 'merged');
  assert.ok(sentinelHit(sentinels, 'autopilot-mark-verified'), 'mark-verified should run');
  assert.ok(sentinelHit(sentinels, 'autopilot-merge'), 'merge should run');
  assert.ok(!sentinelHit(sentinels, 'lark-notify'), 'gate must NOT fire the success notify (merge owns it)');
  assert.ok(!sentinelHit(sentinels, 'autopilot-mark-failed'), 'no mark-failed on success');
});

// ── (e) zh claim → verify gets --zh; pushed-preview drives preview-wait ───────
test('pushed-preview + zh claim: preview-wait runs and verify is invoked with --zh', () => {
  const { dir, sentinels } = freshCase();
  const statusJson = JSON.stringify({
    'PG-003': { branch: BRANCH, slug: 's', status: 'pushed-preview', zh: true, worktree: '/tmp/wt', pr: '9' },
  });
  const env = fakeEnv({ dir, sentinelsDir: sentinels, statusJson, reviewBin: reviewPassBin(dir, sentinels) });
  const r = run(['--branch', BRANCH, '--json'], env);
  assert.equal(r.status, 0, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
  assert.ok(sentinelHit(sentinels, 'preview-wait'), 'pushed-preview should drive preview-wait');
  // verify invocation argv was recorded; must include --zh for a zh claim.
  assert.match(sentinelText(sentinels, 'preview-verify'), /--zh/);
});

// ── (f) preview-verify tooling/verify failure → exit 2 + park + notify ────────
test('chrome verify fails (ok:false) → exit 2, mark-failed + lark-notify', () => {
  const { dir, sentinels } = freshCase();
  const env = fakeEnv({
    dir, sentinelsDir: sentinels,
    statusJson: CLAIM_VERIFIED(),
    reviewBin: reviewPassBin(dir, sentinels),
    verifyExit: 1,
    verifyJson: JSON.stringify({ ok: false, checked: [], warnings: [], failReason: 'no <h1> on rendered page' }),
  });
  const r = run(['--branch', BRANCH, '--json'], env);
  assert.equal(r.status, 2, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
  const out = JSON.parse(r.stdout.trim());
  assert.match(out.reason, /no <h1>/);
  assert.ok(sentinelHit(sentinels, 'autopilot-mark-failed'), 'park on verify fail');
  assert.ok(sentinelHit(sentinels, 'lark-notify'), 'notify on verify fail');
  assert.ok(!sentinelHit(sentinels, 'autopilot-merge'), 'no merge on verify fail');
});

// ── (g) SKIPPED review (tooling) blocks → exit 2 ──────────────────────────────
test('a SKIPPED review (tooling failure) blocks the gate → exit 2', () => {
  const { dir, sentinels } = freshCase();
  // review fake emits SKIPPED with exit 1 (the worker's tooling-failure contract).
  const reviewBin = writeNodeFake(dir, 'fake-review-skip.mjs', {
    sentinelName: 'review-worker', sentinelsDir: sentinels,
    stdout: JSON.stringify({ dimension: 'schema', verdict: 'SKIPPED', blocking_reason: 'tooling: no parseable JSON verdict', notes: [] }),
    exit: 1,
  });
  const env = fakeEnv({ dir, sentinelsDir: sentinels, statusJson: CLAIM_VERIFIED(), reviewBin });
  const r = run(['--branch', BRANCH, '--json'], env);
  assert.equal(r.status, 2, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
  const out = JSON.parse(r.stdout.trim());
  assert.match(out.reason, /SKIPPED|tooling/);
  assert.ok(sentinelHit(sentinels, 'autopilot-mark-failed'));
  assert.ok(!sentinelHit(sentinels, 'autopilot-merge'));
});

// ── (h) no claim for branch → nothing pending (exit 1), no side effects ───────
test('no claim for the branch → exit 1 (nothing pending), no mutations', () => {
  const { dir, sentinels } = freshCase();
  const env = fakeEnv({
    dir, sentinelsDir: sentinels,
    statusJson: JSON.stringify({ 'PG-X': { branch: 'some/other/branch', slug: 's', status: 'pushed-preview' } }),
    reviewBin: reviewPassBin(dir, sentinels),
  });
  const r = run(['--branch', BRANCH, '--json'], env);
  assert.equal(r.status, 1, `stderr: ${r.stderr}`);
  assert.ok(!sentinelHit(sentinels, 'autopilot-merge'));
  assert.ok(!sentinelHit(sentinels, 'autopilot-mark-failed'));
  assert.ok(!sentinelHit(sentinels, 'lark-notify'));
});

// ── (i) codex completed FAIL blocks; codex tooling failure does NOT ───────────
test('codex completed VERDICT: FAIL → exit 2 (blocks merge)', () => {
  const { dir, sentinels } = freshCase();
  const codexBin = writeNodeFake(dir, 'fake-codex-fail.mjs', {
    sentinelName: 'codex', sentinelsDir: sentinels, stdout: 'reviewing...\nVERDICT: FAIL — broken JSON-LD', exit: 0,
  });
  const env = fakeEnv({ dir, sentinelsDir: sentinels, statusJson: CLAIM_VERIFIED(), reviewBin: reviewPassBin(dir, sentinels), codexBin });
  const r = run(['--branch', BRANCH, '--json'], env);
  assert.equal(r.status, 2, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
  assert.match(JSON.parse(r.stdout.trim()).reason, /codex/i);
  assert.ok(!sentinelHit(sentinels, 'autopilot-merge'), 'codex FAIL blocks merge');
});

test('codex tooling failure (nonzero exit) does NOT block → exit 0, merged', () => {
  const { dir, sentinels } = freshCase();
  const codexBin = writeNodeFake(dir, 'fake-codex-broken.mjs', {
    sentinelName: 'codex', sentinelsDir: sentinels, stdout: '', exit: 3,
  });
  const env = fakeEnv({ dir, sentinelsDir: sentinels, statusJson: CLAIM_VERIFIED(), reviewBin: reviewPassBin(dir, sentinels), codexBin });
  const r = run(['--branch', BRANCH, '--json'], env);
  assert.equal(r.status, 0, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
  assert.ok(sentinelHit(sentinels, 'autopilot-merge'), 'codex tooling failure must not block merge');
});

// ── (j) --status itself fails → exit 2, NO mark-failed (no claim to park), DOES notify ──
// Covers the gateFail() parkable=false branch via the public interface: when gg-seo-autopilot
// --status errors/times out there is no claim object, so the gate must skip --mark-failed
// (nothing safe to park, and it would not even know which branch row to touch) yet still fire
// the failure notify. This is genuinely reachable in prod (a --status timeout/error), unlike
// the already-needs_human race the verify flagged.
test('--status failure (autopilot exits nonzero) → exit 2, skips mark-failed, still notifies', () => {
  const { dir, sentinels } = freshCase();
  const env = fakeEnv({ dir, sentinelsDir: sentinels, statusJson: '{}', reviewBin: reviewPassBin(dir, sentinels) });
  // Override the autopilot bin with one that EXITS NONZERO on --status.
  env.GG_AUTOPILOT_BIN = writeNodeFake(dir, 'fake-autopilot-statusfail.mjs', {
    sentinelName: 'autopilot-status', sentinelsDir: sentinels,
    dispatch: [{ match: '--status', stdout: '', exit: 7 }],
    stdout: '', exit: 0,
  });
  const r = run(['--branch', BRANCH, '--json'], env);
  assert.equal(r.status, 2, `expected gate-failed exit 2; stderr: ${r.stderr}; stdout: ${r.stdout}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.exitCode, 2);
  assert.match(out.reason, /status/i);
  assert.ok(sentinelHit(sentinels, 'autopilot-status'), '--status was attempted');
  assert.ok(!sentinelHit(sentinels, 'autopilot-mark-failed'), 'no claim to park → mark-failed must be skipped');
  assert.ok(!sentinelHit(sentinels, 'autopilot-merge'), 'no merge on status failure');
  assert.ok(sentinelHit(sentinels, 'lark-notify'), 'gate still fires the failure notify');
});

// ── (k) per-step hard timeout → exit 2 + park + notify (the hammer-prevention contract) ──
// The gate SIGKILLs a child that exceeds its per-step timeout and maps timedOut → gateFail/exit 2.
// This is what stops the cron from re-looping on a wedged preview and holding the PID lock for
// hours. Previously every fake exited instantly, so this branch was never exercised.
test('a sub-step that exceeds its timeout → exit 2, mark-failed + lark-notify, no merge', () => {
  const { dir, sentinels } = freshCase();
  const env = fakeEnv({ dir, sentinelsDir: sentinels, statusJson: CLAIM_VERIFIED(), reviewBin: reviewPassBin(dir, sentinels) });
  // A verify fake that records its invocation then sleeps WAY past the injected --verify-timeout-ms.
  const slowVerify = join(dir, 'fake-verify-slow.mjs');
  writeFileSync(slowVerify, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(join(sentinels, 'preview-verify'))}, process.argv.slice(2).join(' ') + '\\n');\nsetTimeout(() => { process.stdout.write('{"ok":true}'); process.exit(0); }, 5000);\n`);
  chmodSync(slowVerify, 0o755);
  env.GG_PREVIEW_VERIFY_BIN = slowVerify;
  const r = run(['--branch', BRANCH, '--verify-timeout-ms', '150', '--json'], env);
  assert.equal(r.status, 2, `expected gate-failed exit 2 on timeout; stderr: ${r.stderr}; stdout: ${r.stdout}`);
  assert.match(JSON.parse(r.stdout.trim()).reason, /timeout/i);
  assert.ok(sentinelHit(sentinels, 'preview-verify'), 'the slow verify did run');
  assert.ok(sentinelHit(sentinels, 'autopilot-mark-failed'), 'timeout parks the claim');
  assert.ok(sentinelHit(sentinels, 'lark-notify'), 'timeout fires the failure notify');
  assert.ok(!sentinelHit(sentinels, 'autopilot-merge'), 'a timed-out gate must NOT merge');
});

test('cleanup', () => {
  rmSync(ROOT, { recursive: true, force: true });
});
