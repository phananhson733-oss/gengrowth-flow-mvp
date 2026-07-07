// flow-backfill.smoke.test.mjs — loop-until-clean 回填：passHadChanges 收敛判据 + runBackfillLoop 有界循环。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passHadChanges, runBackfillLoop, BACKFILL_STEPS, buildBackfillSteps } from '../lib/flow-backfill.mjs';

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

test('buildBackfillSteps: ledger 一次 + 两站点完整 publish 后回填,命令显式带 workbook/site/sitemap', () => {
  const steps = buildBackfillSteps({
    env: {
      GG_SHEETS_ASTROLOGY_WORKBOOK_ID: 'astro-wb',
      GG_SHEETS_GENGROWTH_WORKBOOK_ID: 'gg-wb',
      GG_GSC_ASTROLOGY_SITE: 'sc-domain:astrology.test',
      GG_GSC_GENGROWTH_SITE: 'sc-domain:gengrowth.test',
      GG_ASTROLOGY_SITEMAP_URL: 'https://astrology.test/sitemap.xml',
      GG_GENGROWTH_SITEMAP_URL: 'https://gengrowth.test/sitemap.xml',
    },
  });
  const labels = steps.map((s) => s.label);
  assert.deepEqual(labels, [
    'reconcile',
    'astrologywiki:sync-published',
    'astrologywiki:sync-url-inventory',
    'astrologywiki:sync-recap',
    'astrologywiki:cluster-page-assets',
    'astrologywiki:sync-request-queue',
    'gengrowth:sync-published',
    'gengrowth:sync-url-inventory',
    'gengrowth:sync-recap',
    'gengrowth:cluster-page-assets',
    'gengrowth:sync-request-queue',
  ]);
  assert.match(steps[0].bin, /gg-ledger-reconcile\.mjs$/);
  assert.deepEqual(steps[0].args, ['--apply']);

  const ggPublished = steps.find((s) => s.label === 'gengrowth:sync-published');
  assert.match(ggPublished.bin, /gg-index-monitor\.mjs$/);
  assert.deepEqual(ggPublished.args, ['--sync-published', '--write-sheet', '--workbook', 'gg-wb', '--site', 'sc-domain:gengrowth.test', '--sitemap-url', 'https://gengrowth.test/sitemap.xml']);

  const ggCluster = steps.find((s) => s.label === 'gengrowth:cluster-page-assets');
  assert.match(ggCluster.bin, /gg-cluster-page-assets-sync\.mjs$/);
  assert.deepEqual(ggCluster.args, ['--apply', '--workbook', 'gg-wb']);
});

test('BACKFILL_STEPS: 默认导出包含 url-inventory,避免 publish 后库存表遗漏', () => {
  const labels = BACKFILL_STEPS.map((s) => s.label);
  assert.ok(labels.includes('astrologywiki:sync-url-inventory'));
  assert.ok(labels.includes('gengrowth:sync-url-inventory'));
});

function mkDeps(passOutputs) {
  // passOutputs: 每轮的输出(该轮所有 step 都返这个);runCapture 按调用顺序取
  let call = 0;
  const steps = BACKFILL_STEPS;
  const perStep = passOutputs.flatMap((passOut) => steps.map(() => passOut));
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
