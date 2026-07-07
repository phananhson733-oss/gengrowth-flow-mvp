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
