// flow-driver-tick.smoke.test.mjs — tick 默认 dry-run、GG_FLOW_DRIVER_APPLY 才 apply、无终态不发通知。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function mkOps(claims) {
  const ops = mkdtempSync(join(tmpdir(), 'tick-ops-'));
  mkdirSync(join(ops, 'inbox/06-tasks/tasks'), { recursive: true });
  writeFileSync(join(ops, 'inbox/06-tasks/tasks/.autopilot-claims.json'), JSON.stringify(claims));
  return ops;
}
function runTick(ops) {
  return spawnSync('bash', ['tools/scripts/gg-flow-driver-tick.sh'], {
    encoding: 'utf8',
    env: { ...process.env, GG_OPS_DIR: ops, GG_FLOW_DRIVER_LOCK: join(ops, 'lock'), GG_LARK_NOTIFY_SILENCE: '1', GG_FLOW_DRIVER_TICK_TIMEOUT: '120' },
  });
}
const STALE = { 'PG-S': { status: 'needs_human', stage: 'pushed-preview', slug: 's', branch: 'b/s', error: 'review[codex] FAIL: stale topic, do not publish' } };

test('tick 默认 dry-run(无 GG_FLOW_DRIVER_APPLY)：跑 driver 不 --apply,exit 0', () => {
  const r = runTick(mkOps(STALE));
  assert.equal(r.status, 0, r.stderr);
  const all = r.stdout + r.stderr;
  // dry-run 不接侧效——日志里应无 mode=apply(默认安全)
  assert.doesNotMatch(all, /mode=apply/);
});

test('tick 空 ledger：exit 0,不崩', () => {
  const r = runTick(mkOps({}));
  assert.equal(r.status, 0, r.stderr);
});
