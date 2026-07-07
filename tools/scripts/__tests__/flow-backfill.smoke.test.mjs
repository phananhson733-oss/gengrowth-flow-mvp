// flow-backfill.smoke.test.mjs — loop-until-clean 回填：passHadChanges 收敛判据 + runBackfillLoop 有界循环。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passHadChanges, runBackfillLoop, BACKFILL_STEPS } from '../lib/flow-backfill.mjs';

test('passHadChanges: 非零变更计数→true;全零/仅 rows→false', () => {
  assert.equal(passHadChanges('sync-published: updated=7 appended=0'), true);
  assert.equal(passHadChanges('cluster: slugs_added=3'), true);
  assert.equal(passHadChanges('reconcile: resolved=2'), true);
  // reconcile 的 reconciled=/flips= 也是变更词(易漏,漏了会过早收敛)
  assert.equal(passHadChanges('2. reconcile-published: ok reconciled=5'), true);
  assert.equal(passHadChanges('3. reconcile-status: ok flips=3'), true);
  assert.equal(passHadChanges('updated=0 appended=0 slugs_added=0 reconciled=0 flips=0'), false); // 全零→收敛
  assert.equal(passHadChanges('request-queue: rows=25'), false);             // rows 是总数,不算变更
  // retried=重试次数(非成功变更):WAL 常有未 drain 的 pending 每轮恒 retried=N resolved=0,含它永不收敛(finding①)
  assert.equal(passHadChanges('drainPending: retried=3 resolved=0'), false);
  assert.equal(passHadChanges('plan-sweep: checked=12 stillPending=3'), false); // checked(有意排除)/stillPending 不计
  assert.equal(passHadChanges('no counts here'), false);
});

test('BACKFILL_STEPS: 含 reconcile/sync-published/sync-recap/cluster/sync-request-queue,命令确切', () => {
  const labels = BACKFILL_STEPS.map((s) => s.label);
  assert.deepEqual(labels, ['reconcile', 'sync-published', 'sync-recap', 'cluster-page-assets', 'sync-request-queue']);
  assert.match(BACKFILL_STEPS[0].bin, /gg-ledger-reconcile\.mjs$/);
  assert.deepEqual(BACKFILL_STEPS[0].args, ['--apply']);
  assert.deepEqual(BACKFILL_STEPS[1].args, ['--sync-published', '--write-sheet']);
});

function mkDeps(passOutputs) {
  // passOutputs: 每轮的输出(该轮所有 step 都返这个);runCapture 按调用顺序取
  let call = 0;
  const perStep = passOutputs.flatMap((passOut) => BACKFILL_STEPS.map(() => passOut));
  return {
    runCapture: async () => { const out = perStep[call++] ?? ''; return { ok: true, out }; },
    log: () => {},
    maxPasses: 3,
  };
}

test('runBackfillLoop: 第一轮有变更、第二轮全零 → 2 轮收敛', async () => {
  const deps = mkDeps(['appended=1', 'appended=0']);
  const r = await runBackfillLoop(deps);
  assert.equal(r.converged, true);
  assert.equal(r.passes, 2);
  assert.equal(r.changedPasses, 1);
});

test('runBackfillLoop: 首轮即无变更 → 1 轮收敛,changedPasses=0', async () => {
  const deps = mkDeps(['updated=0']);
  const r = await runBackfillLoop(deps);
  assert.equal(r.converged, true);
  assert.equal(r.passes, 1);
  assert.equal(r.changedPasses, 0);
});

test('runBackfillLoop: 每轮都有变更 → maxPasses 封顶、converged=false(不死循环)', async () => {
  const deps = mkDeps(['appended=1', 'appended=1', 'appended=1', 'appended=1']);
  const r = await runBackfillLoop(deps);
  assert.equal(r.converged, false);
  assert.equal(r.passes, 3); // maxPasses
});

test('runBackfillLoop: 某步持续失败(无变更) → 不误判干净收敛、failedSteps 记录、maxPasses 后 converged=false(治 finding②)', async () => {
  const deps = {
    runCapture: async (step) => ({ ok: step.label !== 'sync-recap', out: 'updated=0' }),
    log: () => {},
    maxPasses: 2,
  };
  const r = await runBackfillLoop(deps);
  assert.equal(r.converged, false);                 // 有失败 → 不干净收敛(否则整体失败=静默收敛)
  assert.deepEqual(r.failedSteps, ['sync-recap']);  // 记录失败步供汇总告警
});

test('runBackfillLoop: maxPasses=0 → 立即 converged(不跑)、failedSteps 空', async () => {
  const deps = { runCapture: async () => ({ ok: true, out: '' }), log: () => {}, maxPasses: 0 };
  const r = await runBackfillLoop(deps);
  assert.equal(r.passes, 0);
  assert.equal(r.converged, true);
});
