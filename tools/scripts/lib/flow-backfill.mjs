// lib/flow-backfill.mjs — P2 loop-until-clean 回填。driver --apply 处理完 park 后跑,把已上线文章的后续
// (sheet 状态/url-inventory/recap/cluster/GSC 队列)补齐到"某轮无真变更"(收敛)或 maxPasses 封顶。
// side-effect 全走注入 deps.runCapture(spawn 回填命令),控制流确定性可测。命令 append-only/幂等。
import { join } from 'node:path';

const SCRIPTS = new URL('.', import.meta.url).pathname.replace(/\/lib\/$/, '');
const LEDGER_RECONCILE = join(SCRIPTS, 'gg-ledger-reconcile.mjs');
const INDEX_MONITOR = join(SCRIPTS, 'gg-index-monitor.mjs');
const CLUSTER_SYNC = join(SCRIPTS, 'gg-cluster-page-assets-sync.mjs');

export const BACKFILL_STEPS = [
  { label: 'reconcile', bin: LEDGER_RECONCILE, args: ['--apply'] },
  { label: 'sync-published', bin: INDEX_MONITOR, args: ['--sync-published', '--write-sheet'] },
  { label: 'sync-recap', bin: INDEX_MONITOR, args: ['--sync-recap', '--write-sheet'] },
  { label: 'cluster-page-assets', bin: CLUSTER_SYNC, args: ['--apply'] },
  { label: 'sync-request-queue', bin: INDEX_MONITOR, args: ['--sync-request-queue', '--write-sheet'] },
];

// 本轮有没有"真变更"：非零成功-变更计数,覆盖全部回填命令的成功变更词(reconcile 的 reconciled/flips
// 易漏——漏了会过早收敛、回填不全)。**有意排除**:
//   · rows —— request-queue 队列总数,每轮非零,含它永不收敛;
//   · retried —— drainPending 的**重试次数**(不是成功变更)。WAL 常有未 drain 的 pending(文章已发未 live),
//       每轮恒 retried=N resolved=0、状态在一次 fire 的几轮间不变 → 含它会永不收敛、每次误报未收敛刷飞书。
//       真变更看 resolved(成功 drain 数),不看 retried。(评审 finding①)
//   · checked —— plan 补勾数,是幂等 mutation,但保守排除以规避"其若为总数时破坏收敛";代价=漏报 plan补勾
//       这一低危项(plan 幂等、无下游重读)。
//   · stillPending/skipped —— 残留/跳过数,非变更。
// 所含词都是幂等成功计数(补完第二轮归零)。
const CHANGE_RE = /(?:appended|updated|slugs_added|updatedCells|resolved|reconciled|flips)=[1-9]\d*/;
export function passHadChanges(out) { return CHANGE_RE.test(String(out || '')); }

// 循环整个回填序列到某轮无真变更(收敛)或 maxPasses(默3)。deps={runCapture(cmd)->{ok,out}, log, maxPasses}。
export async function runBackfillLoop(deps) {
  const maxPasses = deps.maxPasses ?? 3;
  if (maxPasses <= 0) return { passes: 0, converged: true, changedPasses: 0, failedSteps: [] };
  let changedPasses = 0;
  let lastFailed = [];
  for (let pass = 1; pass <= maxPasses; pass++) {
    let combined = '';
    const failed = [];
    for (const step of BACKFILL_STEPS) {
      const r = await deps.runCapture(step);
      combined += `\n${step.label}: ${(r && r.out) || ''}`;
      if (!r || !r.ok) { failed.push(step.label); deps.log(`回填 ${step.label} 失败(非零/超时,下轮重试)`); }
    }
    lastFailed = failed;
    const changed = passHadChanges(combined);
    // 干净收敛 = 本轮既无变更、又无失败。有失败不收敛(可能 transient,下轮重试;持续失败到 maxPasses→告警)——
    // 否则整体失败(无变更词输出)会被当成干净收敛、静默,架空 P2 保证回填真跑完的目的。(评审 finding②)
    if (!changed && failed.length === 0) {
      deps.log(`回填第 ${pass} 轮无变更、无失败 → 收敛`);
      return { passes: pass, converged: true, changedPasses, failedSteps: [] };
    }
    if (changed) changedPasses++;
    deps.log(`回填第 ${pass} 轮${changed ? '有变更' : ''}${failed.length ? ` ${failed.length}步失败` : ''},继续`);
  }
  deps.log(`回填 ${maxPasses} 轮未干净收敛(变更或失败仍在)→ ⚠️需人工看`);
  return { passes: maxPasses, converged: false, changedPasses, failedSteps: lastFailed };
}
