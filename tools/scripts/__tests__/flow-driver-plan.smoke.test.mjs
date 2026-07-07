// flow-driver-plan.smoke.test.mjs — planDriverActions：把 ledger 里每个 needs_human park 映射成动作。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDriverActions } from '../lib/flow-driver.mjs';

const CLAIMS = {
  'PG-A': { status: 'done', slug: 'a' },                                          // 非 park → 跳过
  'PG-B': { status: 'pushed-preview', slug: 'b' },                                // 非 park → 跳过
  'PG-TRANS': { status: 'needs_human', stage: 'pushed-preview', slug: 't', error: 'codex exited 3' },
  'PG-FIX': { status: 'needs_human', stage: 'authoring', slug: 'f', error: 'phase2 FAIL: drifted sections' },
  'PG-STALE': { status: 'needs_human', stage: 'pushed-preview', slug: 's', error: 'review[codex] FAIL: stale topic — match already played' },
};

test('planDriverActions：只挑 needs_human，映射 retry/fix/archive', () => {
  const plan = planDriverActions(CLAIMS);
  const byPid = Object.fromEntries(plan.map((a) => [a.pid, a]));
  assert.equal(plan.length, 3, '只 3 个 needs_human');
  assert.equal(byPid['PG-TRANS'].action, 'retry');
  assert.equal(byPid['PG-FIX'].action, 'fix');
  assert.equal(byPid['PG-STALE'].action, 'archive');
  assert.equal(byPid['PG-FIX'].triage, 'fixable');
  assert.match(byPid['PG-STALE'].reason, /already played/);
});

test('planDriverActions：空/无 claims → 空数组', () => {
  assert.deepEqual(planDriverActions({}), []);
  assert.deepEqual(planDriverActions(null), []);
});

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('gg-flow-driver CLI dry-run：读 ledger 打印计划 + 汇总，exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowdrv-'));
  const ledger = join(dir, 'claims.json');
  writeFileSync(ledger, JSON.stringify(CLAIMS));
  const r = spawnSync('node', ['tools/scripts/gg-flow-driver.mjs', '--ledger', ledger], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /parks=3 fix=1 retry=1 archive=1 mode=dry-run/);
  assert.match(r.stdout, /PG-STALE.*archive/);
});

test('gg-flow-driver CLI fail-safe：缺 ledger 文件 → exit 0 不崩、无 plan 行', () => {
  const r = spawnSync('node', ['tools/scripts/gg-flow-driver.mjs', '--ledger', '/nonexistent/definitely-not-here.json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /→/); // 无 plan 行
});

test('gg-flow-driver CLI fail-safe：autopilot 并发半写的截断/非法 JSON → exit 0 不崩', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowdrv-bad-'));
  const ledger = join(dir, 'claims.json');
  writeFileSync(ledger, '{"PG-A":'); // 截断（ledger 由 autopilot 并发写，driver 可能读到半写）
  const r = spawnSync('node', ['tools/scripts/gg-flow-driver.mjs', '--ledger', ledger], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
