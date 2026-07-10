// park-autoretry.smoke.test.mjs — 阶段 6 doAutoRetryParks 集成（子进程 + 临时 ledger/state）。
// 验证：transient 重入队(authoring/pre-preview 删 claim、gate→pushed-preview)、permanent 不动、
// 两-tick 计数跨缺失期存活(CAP 不绕过，评审 BLOCKING)、CAP 非终态升级、backoff。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const AUTOPILOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'gg-seo-autopilot.mjs');

function setup(ledger, sidecar) {
  const ops = mkdtempSync(join(tmpdir(), 'ops-'));
  const state = mkdtempSync(join(tmpdir(), 'state-'));
  const tasksDir = join(ops, 'inbox', '06-tasks', 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  const ledgerPath = join(tasksDir, '.autopilot-claims.json');
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
  if (sidecar) writeFileSync(join(state, 'park-autoretry.json'), JSON.stringify(sidecar));
  return { ops, state, ledgerPath };
}
function run(ops, state, extraEnv = {}) {
  execFileSync('node', [AUTOPILOT, '--auto-retry-parks'], {
    env: { ...process.env, GG_OPS_DIR: ops, GG_FLOW_STATE_DIR: state, GG_LARK_NOTIFY_SILENCE: '1', GG_AUTOPILOT_NO_NOTIFY: '1', ...extraEnv },
    encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
  });
}
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const sidecarOf = (state, pid) => readJson(join(state, 'park-autoretry.json'))[pid];

test('transient authoring park → 清 claim（作者 lane 重授）；permanent 与 done 不动', () => {
  const { ops, state, ledgerPath } = setup({
    'PG-T-1': { status: 'needs_human', stage: 'authoring', error: 'orchestrator produced no draft after 3 attempt(s)', slug: 't1' },
    'PG-CTA-1': { status: 'needs_human', stage: 'authoring', error: 'authoring: CTA Map gap — CTA Map has 37 duplicate (page_role, track) pairs — first row wins:', slug: 'cta1' },
    'PG-P-1': { status: 'needs_human', stage: 'authoring', error: 'phase2 FAIL: missing pillars', slug: 'p1' },
    'PG-D-1': { status: 'done', slug: 'd1' },
  });
  run(ops, state, { GG_PARK_AUTORETRY_BACKOFF_MS: '0' });
  const led = readJson(ledgerPath);
  assert.equal(led['PG-T-1'], undefined, 'transient authoring park 应被清（重授）');
  assert.equal(led['PG-CTA-1'], undefined, 'CTA duplicate bridge park 应被清（重授）');
  assert.equal(led['PG-P-1']?.status, 'needs_human', 'permanent(phase2 FAIL:missing pillars) 原样保留');
  assert.equal(led['PG-D-1']?.status, 'done', 'done 不动');
});

test('transient gate park(pushed-preview) → 重置 pushed-preview + 清 error/failedAt', () => {
  const { ops, state, ledgerPath } = setup({
    'PG-G-1': { status: 'needs_human', stage: 'pushed-preview', branch: 'seo/auto/x', error: 'codex exited 3', failedAt: '2026-07-03T00:00:00Z', slug: 'g1' },
  });
  run(ops, state, { GG_PARK_AUTORETRY_BACKOFF_MS: '0' });
  const g = readJson(ledgerPath)['PG-G-1'];
  assert.equal(g.status, 'pushed-preview');
  assert.equal(g.error, undefined);
  assert.equal(g.failedAt, undefined);
  assert.match(g.retryEvidence, /auto-retry/);
});

test('pre-preview 阶段(build-gate) transient park → 删 claim 从 scan 重跑（不设幻影 pushed-preview）', () => {
  const { ops, state, ledgerPath } = setup({
    'PG-B-1': { status: 'needs_human', stage: 'build-gate', branch: 'seo/auto/b1', error: 'build gate failed — socket hang up', slug: 'b1' },
  });
  run(ops, state, { GG_PARK_AUTORETRY_BACKOFF_MS: '0' });
  assert.equal(readJson(ledgerPath)['PG-B-1'], undefined, 'pre-preview 应删 claim（不能设 pushed-preview 指幻影分支）');
});

test('两-tick + 重 park：sidecar 计数跨"删 claim 缺失期"存活并累加（CAP 不被绕过）', () => {
  const { ops, state, ledgerPath } = setup({
    'PG-T-9': { status: 'needs_human', stage: 'authoring', error: 'produced no draft', slug: 't9' },
  });
  // tick1：删 claim + attempts=1
  run(ops, state, { GG_PARK_AUTORETRY_BACKOFF_MS: '0' });
  assert.equal(readJson(ledgerPath)['PG-T-9'], undefined, 'tick1 删 claim');
  assert.equal(sidecarOf(state, 'PG-T-9').attempts, 1);
  // tick2：claim 仍缺失（作者 lane 还没重授）→ sidecar 绝不能被清（评审 BLOCKING）
  run(ops, state, { GG_PARK_AUTORETRY_BACKOFF_MS: '0' });
  assert.equal(sidecarOf(state, 'PG-T-9').attempts, 1, 'claim 缺失期间计数必须存活，不得归零');
  // 模拟作者 lane 重授后又 transient park → tick3 计数累加到 2（CAP 真的在累积）
  writeFileSync(ledgerPath, JSON.stringify({ 'PG-T-9': { status: 'needs_human', stage: 'authoring', error: 'produced no draft', slug: 't9' } }));
  run(ops, state, { GG_PARK_AUTORETRY_BACKOFF_MS: '0' });
  assert.equal(sidecarOf(state, 'PG-T-9').attempts, 2, '重 park 后计数累加（未归零）');
});

test('CAP 到 → 标 escalated 但非终态（仍重试自愈超长窗口）；attempts 不再增', () => {
  const { ops, state, ledgerPath } = setup(
    { 'PG-G-2': { status: 'needs_human', stage: 'pushed-preview', branch: 'seo/auto/y', error: 'codex exited 3', slug: 'g2' } },
    { 'PG-G-2': { attempts: 3, lastAt: 0 } },
  );
  run(ops, state, { GG_PARK_AUTORETRY_CAP: '3', GG_PARK_AUTORETRY_SLOW_BACKOFF_MS: '0' });
  const side = sidecarOf(state, 'PG-G-2');
  assert.equal(side.escalated, true, 'CAP 到 → 标 escalated');
  assert.equal(side.attempts, 3, 'CAP 后 attempts 不再增');
  assert.equal(readJson(ledgerPath)['PG-G-2'].status, 'pushed-preview', '非终态：仍重跑门');
});

test('backoff：lastAt 太近 → 本轮不重试', () => {
  const { ops, state, ledgerPath } = setup(
    { 'PG-G-3': { status: 'needs_human', stage: 'pushed-preview', branch: 'seo/auto/z', error: 'codex exited 3', slug: 'g3' } },
    { 'PG-G-3': { attempts: 1, lastAt: Date.now() } },
  );
  run(ops, state, { GG_PARK_AUTORETRY_BACKOFF_MS: '3600000' });
  assert.equal(readJson(ledgerPath)['PG-G-3'].status, 'needs_human', 'backoff 未到 → 不动');
});

test('fail-closed：state dir 不可写(chmod 500) → 不重试（计数无法落盘时宁可不自愈）', () => {
  const { ops, state, ledgerPath } = setup({
    'PG-RO-1': { status: 'needs_human', stage: 'authoring', error: 'produced no draft', slug: 'ro1' },
  });
  chmodSync(state, 0o500); // 只读目录 → 探针真写失败
  try {
    run(ops, state, { GG_PARK_AUTORETRY_BACKOFF_MS: '0' });
    assert.ok(readJson(ledgerPath)['PG-RO-1'], 'state 不可写 → fail-closed，claim 保留不重试');
  } finally { chmodSync(state, 0o700); } // 恢复以便清理
});

test('fail-closed：sidecar JSON 损坏 → 不重试（不静默清零 CAP）', () => {
  const { ops, state, ledgerPath } = setup({
    'PG-C-1': { status: 'needs_human', stage: 'pushed-preview', branch: 'b', error: 'codex exited 3', slug: 'c1' },
  });
  writeFileSync(join(state, 'park-autoretry.json'), '{ this is not valid json');
  run(ops, state, { GG_PARK_AUTORETRY_BACKOFF_MS: '0' });
  assert.equal(readJson(ledgerPath)['PG-C-1'].status, 'needs_human', 'sidecar 损坏 → fail-closed，不重试');
});

test('TTL 只回收无 claim 的泄漏项，绝不清活 park 计数（停机>TTL 后不清零预算）', () => {
  const eightDaysAgo = Date.now() - 8 * 24 * 3600 * 1000;
  const { ops, state } = setup(
    { 'PG-LIVE': { status: 'needs_human', stage: 'pushed-preview', branch: 'b', error: 'codex exited 3', slug: 'live' } }, // 活 park；PG-GONE 无 claim=泄漏项
    { 'PG-LIVE': { attempts: 9, lastAt: eightDaysAgo }, 'PG-GONE': { attempts: 3, lastAt: eightDaysAgo } },
  );
  run(ops, state, { GG_PARK_AUTORETRY_BACKOFF_MS: '0', GG_PARK_AUTORETRY_CAP: '10' });
  const side = readJson(join(state, 'park-autoretry.json'));
  assert.equal(side['PG-LIVE'].attempts, 10, '活 park 计数跨 TTL 存活并累加（停机不清零预算）');
  assert.equal(side['PG-GONE'], undefined, '无 claim 的泄漏项超 7d TTL → 回收');
});

test('cleanup：done 的 sidecar 项被清；needs_human 的不清', () => {
  const { ops, state } = setup(
    { 'PG-DONE': { status: 'done', slug: 'x' }, 'PG-NH': { status: 'needs_human', stage: 'pushed-preview', branch: 'b', error: 'codex exited 3', slug: 'y' } },
    { 'PG-DONE': { attempts: 2, lastAt: Date.now() }, 'PG-NH': { attempts: 1, lastAt: Date.now() } },
  );
  run(ops, state, { GG_PARK_AUTORETRY_BACKOFF_MS: '3600000' }); // backoff 挡住重试，只看 cleanup
  const side = readJson(join(state, 'park-autoretry.json'));
  assert.equal(side['PG-DONE'], undefined, 'done → sidecar 清');
  assert.ok(side['PG-NH'], 'needs_human → sidecar 保留');
});

test('永久 park：标 permNotified 去重(只发一次终态通知)；transient 不标(走重试/escalation)', () => {
  const { ops, state } = setup({
    'PG-PERM': { status: 'needs_human', stage: 'authoring', error: 'drifted sections jaccard=0.000, target-recall=0.00', slug: 'perm' }, // 永久(内容漂移)
    'PG-TRANS': { status: 'needs_human', stage: 'pushed-preview', branch: 'b', error: 'codex exited 3', slug: 'trans' }, // transient
  });
  run(ops, state, { GG_PARK_AUTORETRY_BACKOFF_MS: '0' });
  const side = readJson(join(state, 'park-autoretry.json'));
  assert.equal(side['PG-PERM']?.permNotified, true, '永久 park 应标 permNotified(去重)');
  assert.ok(!side['PG-TRANS']?.permNotified, 'transient 不标 permNotified');
  // 再跑一次：permNotified 仍 true(不会重复加进 permParks 通知列表)
  run(ops, state, { GG_PARK_AUTORETRY_BACKOFF_MS: '0' });
  assert.equal(readJson(join(state, 'park-autoretry.json'))['PG-PERM']?.permNotified, true, '再跑仍去重');
});
