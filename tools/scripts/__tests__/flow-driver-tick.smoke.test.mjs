// flow-driver-tick.smoke.test.mjs — tick 默认 dry-run、_gg.env 里 GG_FLOW_DRIVER_APPLY=1 才 apply、
// 无终态不发通知。用 GG_FLOW_DRIVER_LOG_DIR/GG_ENV_FILE override 做隔离 + 真验日志。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function mkOps(claims) {
  const ops = mkdtempSync(join(tmpdir(), 'tick-ops-'));
  mkdirSync(join(ops, 'inbox/06-tasks/tasks'), { recursive: true });
  writeFileSync(join(ops, 'inbox/06-tasks/tasks/.autopilot-claims.json'), JSON.stringify(claims));
  return ops;
}
function runTick(ops, extraEnv = {}) {
  const logDir = mkdtempSync(join(tmpdir(), 'tick-log-'));
  const r = spawnSync('bash', ['tools/scripts/gg-flow-driver-tick.sh'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GG_OPS_DIR: ops,
      GG_ENV_FILE: '/dev/null',                 // 默认不 source 真 _gg.env(隔离)
      GG_FLOW_DRIVER_LOCK: join(ops, 'lock'),
      GG_FLOW_DRIVER_LOG_DIR: logDir,
      GG_LARK_NOTIFY_SILENCE: '1',
      GG_FLOW_DRIVER_TICK_TIMEOUT: '120',
      GG_FLOW_DRIVER_BACKFILL_PASSES: '0', // 跳过 P2 回填(否则 --apply 会真 spawn 回填命令打真 sheet)
      ...extraEnv,
    },
  });
  const log = readdirSync(logDir).filter((f) => f.endsWith('.log')).map((f) => readFileSync(join(logDir, f), 'utf8')).join('\n');
  return { r, log };
}
const STALE = { 'PG-S': { status: 'needs_human', stage: 'pushed-preview', slug: 's', branch: 'b/s', error: 'review[codex] FAIL: stale topic, do not publish' } };

test('tick 默认 dry-run(无 GG_FLOW_DRIVER_APPLY)：日志 dry-run + 计划,不 apply', () => {
  const { r, log } = runTick(mkOps(STALE));
  assert.equal(r.status, 0, r.stderr);
  assert.match(log, /dry-run/);
  assert.match(log, /→ archive/);
  assert.doesNotMatch(log, /mode=apply/);
});

test('tick 启用路径：_gg.env 里 GG_FLOW_DRIVER_APPLY=1 → 真 --apply(治评审 finding①,防死启用路径)', () => {
  // 写临时 _gg.env(仿真实启用);空 ledger(--apply 无终态→不发飞书,安全)
  const envDir = mkdtempSync(join(tmpdir(), 'tick-env-'));
  const envFile = join(envDir, '_gg.env');
  writeFileSync(envFile, 'GG_FLOW_DRIVER_APPLY=1\n');
  const { r, log } = runTick(mkOps({}), { GG_ENV_FILE: envFile });
  assert.equal(r.status, 0, r.stderr);
  assert.match(log, /--apply|mode=apply/); // 证明 _gg.env 的 flag 到了 APPLY_FLAG(不是死路径)
});

test('tick 空 ledger dry-run：exit 0 不崩', () => {
  const { r } = runTick(mkOps({}));
  assert.equal(r.status, 0, r.stderr);
});
