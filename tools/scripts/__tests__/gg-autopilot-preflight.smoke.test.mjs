import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Resolve sibling script: __tests__/<name>.smoke.test.mjs → ../<name>.mjs
const SCRIPT = new URL('../gg-autopilot-preflight.mjs', import.meta.url).pathname;

test('preflight fails with actionable missing path errors', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--json', '--skip-live-cli'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GG_FLOW_REPO: '/definitely/missing/flow',
      GG_OPS_DIR: '/definitely/missing/ops',
      GG_ORACLE_DIR: '/definitely/missing/oracle',
      PATH: process.env.PATH || '',
    },
  });
  // exit 2 when not ok
  assert.equal(r.status, 2);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  // ALL three named, not just the first (errors collected, no early bail)
  assert.ok(out.errors.some((e) => e.includes('GG_FLOW_REPO')), 'GG_FLOW_REPO');
  assert.ok(out.errors.some((e) => e.includes('GG_OPS_DIR')), 'GG_OPS_DIR');
  assert.ok(out.errors.some((e) => e.includes('GG_ORACLE_DIR')), 'GG_ORACLE_DIR');
});

test('preflight passes when required directories and fake bins exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'gg-preflight-'));
  const bin = join(root, 'bin');
  const flow = join(root, 'flow');
  const ops = join(root, 'ops');
  const oracle = join(root, 'oracle');
  mkdirSync(bin);
  mkdirSync(flow);
  mkdirSync(ops);
  mkdirSync(oracle);
  for (const name of ['node', 'git', 'gh', 'claude', 'codex']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  const r = spawnSync(process.execPath, [SCRIPT, '--json', '--skip-live-cli'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GG_FLOW_REPO: flow,
      GG_OPS_DIR: ops,
      GG_ORACLE_DIR: oracle,
      // Hermetic PATH: ONLY the fake bins — proves the PATH-walk check, not host bins.
      PATH: bin,
      VERCEL_AUTOMATION_BYPASS_SECRET: 'test-secret',
    },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.deepEqual(out.errors, []);
  // dirs echoed back so the tick log / Lark alert can show what was checked.
  assert.equal(out.dirs.GG_FLOW_REPO, flow);
  assert.equal(out.dirs.GG_OPS_DIR, ops);
  assert.equal(out.dirs.GG_ORACLE_DIR, oracle);
  // bypass secret present → no warning about it
  assert.ok(!out.warnings.some((w) => w.includes('VERCEL_AUTOMATION_BYPASS_SECRET')));
});

test('default paths use ~/oracle + ~/gengrowth-ops (NO Code segment)', () => {
  // Regression guard for the v0.1 ~/Code/* bug: with NO env override, the reported
  // default dirs must end in the real, Code-less layout.
  const r = spawnSync(process.execPath, [SCRIPT, '--json', '--skip-live-cli'], {
    encoding: 'utf8',
    env: {
      // Strip any GG_* overrides the host might export so we observe pure defaults.
      ...Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith('GG_')),
      ),
      PATH: process.env.PATH || '',
    },
  });
  const out = JSON.parse(r.stdout);
  assert.ok(out.dirs.GG_ORACLE_DIR.endsWith('/oracle'), out.dirs.GG_ORACLE_DIR);
  assert.ok(out.dirs.GG_OPS_DIR.endsWith('/gengrowth-ops'), out.dirs.GG_OPS_DIR);
  assert.ok(!out.dirs.GG_ORACLE_DIR.includes('/Code/'), 'no Code segment in oracle');
  assert.ok(!out.dirs.GG_OPS_DIR.includes('/Code/'), 'no Code segment in ops');
});

test('VERCEL_AUTOMATION_BYPASS_SECRET unset is a WARNING, not an error', () => {
  const root = mkdtempSync(join(tmpdir(), 'gg-preflight-warn-'));
  const bin = join(root, 'bin');
  const flow = join(root, 'flow');
  const ops = join(root, 'ops');
  const oracle = join(root, 'oracle');
  mkdirSync(bin);
  mkdirSync(flow);
  mkdirSync(ops);
  mkdirSync(oracle);
  for (const name of ['node', 'git', 'gh', 'claude', 'codex']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  const env = {
    ...process.env,
    GG_FLOW_REPO: flow,
    GG_OPS_DIR: ops,
    GG_ORACLE_DIR: oracle,
    PATH: bin,
  };
  delete env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const r = spawnSync(process.execPath, [SCRIPT, '--json', '--skip-live-cli'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.ok(out.warnings.some((w) => w.includes('VERCEL_AUTOMATION_BYPASS_SECRET')));
});
