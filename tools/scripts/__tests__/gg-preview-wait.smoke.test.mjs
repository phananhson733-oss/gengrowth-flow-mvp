#!/usr/bin/env node
// Smoke tests for gg-preview-wait.mjs — HERMETIC: no live gh, no network.
// Black-box CLI check via spawnSync for the missing-arg contract; direct imports
// of the exported pure functions for deployment/status parsing with canned fixtures.
//
// Run: node --test /tmp/gg-landing-staging/__tests__/gg-preview-wait.smoke.test.mjs

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseArgs,
  classifyState,
  parseDeployments,
  parseStatus,
  waitForPreview,
  DEFAULT_REPO,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_POLL_MS,
  EXIT,
} from '../gg-preview-wait.mjs';

const SCRIPT = fileURLToPath(new URL('../gg-preview-wait.mjs', import.meta.url));

// ── CLI contract: missing --branch ────────────────────────────────────────────
test('CLI: missing --branch → nonzero exit + stderr /--branch is required/', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'should exit nonzero');
  assert.equal(r.status, EXIT.ARGS);
  assert.match(r.stderr, /--branch is required/);
  // must NOT have attempted any live work / printed a previewUrl
  assert.equal(r.stdout.trim(), '');
});

test('CLI: --branch flag present but no value → still nonzero + required msg', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--branch'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--branch is required/);
});

// ── parseArgs defaults ─────────────────────────────────────────────────────────
test('parseArgs: defaults', () => {
  const o = parseArgs(['--branch', 'pg-x']);
  assert.equal(o.branch, 'pg-x');
  assert.equal(o.repo, DEFAULT_REPO);
  assert.equal(o.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(o.pollMs, DEFAULT_POLL_MS);
  assert.equal(o.json, false);
});

test('parseArgs: overrides', () => {
  const o = parseArgs(['--branch', 'b', '--repo', 'me/site', '--timeout-ms', '5000', '--poll-ms', '250', '--json']);
  assert.equal(o.repo, 'me/site');
  assert.equal(o.timeoutMs, 5000);
  assert.equal(o.pollMs, 250);
  assert.equal(o.json, true);
});

// ── classifyState ──────────────────────────────────────────────────────────────
test('classifyState: success / failure-set / pending-set / unknown', () => {
  assert.equal(classifyState('success'), 'success');
  assert.equal(classifyState('SUCCESS'), 'success');
  for (const s of ['failure', 'error', 'cancelled', 'canceled']) {
    assert.equal(classifyState(s), 'failure', s);
  }
  for (const s of ['queued', 'pending', 'in_progress', 'inactive']) {
    assert.equal(classifyState(s), 'pending', s);
  }
  // unknown / empty → pending (never abort prematurely)
  assert.equal(classifyState('weird'), 'pending');
  assert.equal(classifyState(''), 'pending');
  assert.equal(classifyState(undefined), 'pending');
});

// ── parseDeployments ─────────────────────────────────────────────────────────
test('parseDeployments: newest id from array', () => {
  const json = JSON.stringify([{ id: 999, ref: 'b' }, { id: 1, ref: 'b' }]);
  assert.deepEqual(parseDeployments(json), { id: 999 });
});

test('parseDeployments: empty array → null id (no deployment yet)', () => {
  assert.deepEqual(parseDeployments('[]'), { id: null });
});

test('parseDeployments: garbage → null id + error', () => {
  const r = parseDeployments('not json');
  assert.equal(r.id, null);
  assert.match(r.error, /unparseable/);
});

// ── parseStatus ────────────────────────────────────────────────────────────────
test('parseStatus: success → previewUrl from environment_url', () => {
  const json = JSON.stringify([
    { state: 'success', environment_url: 'https://oracle-abc.vercel.app', target_url: 'https://ignored' },
  ]);
  assert.deepEqual(parseStatus(json), { kind: 'success', previewUrl: 'https://oracle-abc.vercel.app' });
});

test('parseStatus: success → falls back to target_url when no environment_url', () => {
  const json = JSON.stringify([{ state: 'success', target_url: 'https://oracle-xyz.vercel.app' }]);
  assert.deepEqual(parseStatus(json), { kind: 'success', previewUrl: 'https://oracle-xyz.vercel.app' });
});

test('parseStatus: success but no URL → terminal failure (cannot verify)', () => {
  const r = parseStatus(JSON.stringify([{ state: 'success' }]));
  assert.equal(r.kind, 'failure');
  assert.match(r.reason, /no environment_url/);
});

test('parseStatus: terminal failure states → failure with reason', () => {
  for (const s of ['failure', 'error', 'cancelled']) {
    const r = parseStatus(JSON.stringify([{ state: s, description: 'boom' }]));
    assert.equal(r.kind, 'failure', s);
    assert.match(r.reason, new RegExp(s));
    assert.match(r.reason, /boom/);
  }
});

test('parseStatus: pending states → pending', () => {
  assert.deepEqual(parseStatus(JSON.stringify([{ state: 'in_progress' }])), { kind: 'pending' });
  assert.deepEqual(parseStatus('[]'), { kind: 'pending' });
});

// ── waitForPreview with FAKE gh (no network, no spawn) ─────────────────────────
function fakeGh(responses) {
  // responses: array consumed in order; each is { code, stdout }
  let i = 0;
  return async () => responses[Math.min(i++, responses.length - 1)];
}

test('waitForPreview: success on first poll → { ok:true, previewUrl }', async () => {
  const gh = fakeGh([
    { code: 0, stdout: JSON.stringify([{ id: 42 }]) },
    { code: 0, stdout: JSON.stringify([{ state: 'success', environment_url: 'https://prev.vercel.app' }]) },
  ]);
  const res = await waitForPreview(
    { branch: 'b', repo: DEFAULT_REPO, timeoutMs: 10000, pollMs: 1 },
    { runGhFn: gh, sleepFn: async () => {} },
  );
  assert.deepEqual(res, { ok: true, previewUrl: 'https://prev.vercel.app' });
});

test('waitForPreview: terminal failure → nonzero result WITHOUT polling to timeout', async () => {
  let sleeps = 0;
  const gh = fakeGh([
    { code: 0, stdout: JSON.stringify([{ id: 7 }]) },
    { code: 0, stdout: JSON.stringify([{ state: 'failure', description: 'build failed' }]) },
  ]);
  const res = await waitForPreview(
    { branch: 'b', repo: DEFAULT_REPO, timeoutMs: 999999, pollMs: 1 },
    { runGhFn: gh, sleepFn: async () => { sleeps++; } },
  );
  assert.equal(res.ok, false);
  assert.match(res.reason, /failure/);
  assert.equal(sleeps, 0, 'must not sleep/poll after a terminal failure');
});

test('waitForPreview: pending then success across polls', async () => {
  const gh = fakeGh([
    { code: 0, stdout: JSON.stringify([{ id: 1 }]) },
    { code: 0, stdout: JSON.stringify([{ state: 'in_progress' }]) }, // pending
    { code: 0, stdout: JSON.stringify([{ id: 1 }]) },
    { code: 0, stdout: JSON.stringify([{ state: 'success', target_url: 'https://t.vercel.app' }]) },
  ]);
  const res = await waitForPreview(
    { branch: 'b', repo: DEFAULT_REPO, timeoutMs: 10000, pollMs: 1 },
    { runGhFn: gh, sleepFn: async () => {} },
  );
  assert.deepEqual(res, { ok: true, previewUrl: 'https://t.vercel.app' });
});

test('waitForPreview: self-enforced timeout when deployment never appears', async () => {
  // gh always returns an empty deployments array → never resolves; fake clock
  // advances past the deadline so the loop must give up with reason:'timeout'.
  const gh = async () => ({ code: 0, stdout: '[]' });
  let t = 1000;
  const now = () => t;
  const res = await waitForPreview(
    { branch: 'b', repo: DEFAULT_REPO, timeoutMs: 50, pollMs: 10 },
    { runGhFn: gh, now, sleepFn: async (ms) => { t += ms; } },
  );
  assert.deepEqual(res, { ok: false, reason: 'timeout' });
});

test('waitForPreview: transient gh nonzero exit does not abort — keeps polling until timeout', async () => {
  // gh keeps failing (rate limit / network blip) → must not crash; times out.
  const gh = async () => ({ code: 1, stdout: '', stderr: 'API rate limit' });
  let t = 0;
  const now = () => t;
  const res = await waitForPreview(
    { branch: 'b', repo: DEFAULT_REPO, timeoutMs: 30, pollMs: 10 },
    { runGhFn: gh, now, sleepFn: async (ms) => { t += ms; } },
  );
  assert.deepEqual(res, { ok: false, reason: 'timeout' });
});

// ── REGRESSION (Fix 2): transient gh failure then RECOVERY → success ────────────
// The plain "transient nonzero keeps polling" test above is tautological: the fake
// gh ALWAYS returns code:1, so the only reachable terminal is timeout — it never
// proves the loop can actually recover. This fixture returns code:1 on the FIRST
// deployments call, then code:0 + a real deployment/status on the next round,
// asserting we get { ok:true, previewUrl } — i.e. recovery, not just eventual timeout.
test('waitForPreview: gh code:1 first deployments call then recovers → { ok:true, previewUrl }', async () => {
  let sleeps = 0;
  const gh = fakeGh([
    // round 1: deployments call fails transiently → keep polling
    { code: 1, stdout: '', stderr: 'API rate limit exceeded' },
    // round 2: deployments call succeeds with a deployment id…
    { code: 0, stdout: JSON.stringify([{ id: 314 }]) },
    // …and its status is a successful deployment with a preview URL.
    { code: 0, stdout: JSON.stringify([{ state: 'success', environment_url: 'https://recovered.vercel.app' }]) },
  ]);
  let t = 0;
  const now = () => t;
  const res = await waitForPreview(
    { branch: 'b', repo: DEFAULT_REPO, timeoutMs: 100000, pollMs: 10 },
    { runGhFn: gh, now, sleepFn: async (ms) => { sleeps++; t += ms; } },
  );
  assert.deepEqual(res, { ok: true, previewUrl: 'https://recovered.vercel.app' });
  assert.equal(sleeps, 1, 'should have polled exactly once (the transient round) before recovering');
});

// ── REGRESSION (Fix 1): non-finite / non-positive timeout must NOT hang ─────────
// Before the guard, deadline = now()+NaN = NaN, `now() >= NaN` is always false, and
// a NaN pollMs makes sleep(NaN) busy-loop → infinite hang. These assert a PROMPT
// structured {ok:false} instead. The tiny per-test `timeout` is the tripwire: if the
// bug returns, the function spins forever and node:test kills the test as a FAILURE
// (not a silent hang), so the regression is caught loudly.
test('waitForPreview: NaN timeoutMs returns { ok:false } promptly (no hang)', { timeout: 1000 }, async () => {
  // gh that would loop forever if ever called — proves we bail before polling.
  let calls = 0;
  const gh = async () => { calls++; return { code: 0, stdout: '[]' }; };
  const res = await waitForPreview(
    { branch: 'b', repo: DEFAULT_REPO, timeoutMs: NaN, pollMs: NaN },
    { runGhFn: gh, sleepFn: async () => {} },
  );
  assert.equal(res.ok, false);
  assert.match(res.reason, /invalid timeoutMs/);
  assert.equal(calls, 0, 'must bail before issuing any gh call');
});

test('waitForPreview: Infinity / zero / negative timeoutMs all return { ok:false } promptly', { timeout: 1000 }, async () => {
  const gh = async () => ({ code: 0, stdout: '[]' });
  for (const bad of [Infinity, -Infinity, 0, -5]) {
    const res = await waitForPreview(
      { branch: 'b', repo: DEFAULT_REPO, timeoutMs: bad, pollMs: 10 },
      { runGhFn: gh, sleepFn: async () => {} },
    );
    assert.deepEqual(res, { ok: false, reason: 'invalid timeoutMs' }, `timeoutMs=${bad}`);
  }
});

// A finite timeout with a NaN pollMs must NOT busy-loop: pollMs is clamped to the
// default, so the loop advances via the fake clock and terminates at the deadline.
test('waitForPreview: NaN pollMs is clamped (no busy-loop) → terminates at timeout', { timeout: 1000 }, async () => {
  const gh = async () => ({ code: 0, stdout: '[]' }); // never produces a deployment
  let t = 0;
  let sleeps = 0;
  const now = () => t;
  const res = await waitForPreview(
    { branch: 'b', repo: DEFAULT_REPO, timeoutMs: 50, pollMs: NaN },
    { runGhFn: gh, now, sleepFn: async (ms) => { sleeps++; t += ms; assert.ok(Number.isFinite(ms), `sleep got non-finite ms=${ms}`); } },
  );
  assert.deepEqual(res, { ok: false, reason: 'timeout' });
  assert.ok(sleeps >= 1, 'should have slept with the clamped (finite) poll interval');
});
