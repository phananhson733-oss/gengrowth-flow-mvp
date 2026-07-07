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

// 本轮有没有"真变更"：非零变更计数。**不含 rows**(request-queue 的 rows=N 是 queue 总数、每轮非零,
// 若算作变更会永不收敛)。
const CHANGE_RE = /(?:appended|updated|slugs_added|updatedCells|resolved|retried)=[1-9]\d*/;
export function passHadChanges(out) { return CHANGE_RE.test(String(out || '')); }

// 循环整个回填序列到某轮无真变更(收敛)或 maxPasses(默3)。deps={runCapture(cmd)->{ok,out}, log, maxPasses}。
export async function runBackfillLoop(deps) {
  const maxPasses = deps.maxPasses || 3;
  let changedPasses = 0;
  for (let pass = 1; pass <= maxPasses; pass++) {
    let combined = '';
    for (const step of BACKFILL_STEPS) {
      const r = await deps.runCapture(step);
      combined += `\n${step.label}: ${(r && r.out) || ''}`;
      if (r && !r.ok) deps.log(`回填 ${step.label} 非零退出(继续,幂等下轮补)`);
    }
    if (!passHadChanges(combined)) {
      deps.log(`回填第 ${pass} 轮无变更 → 收敛`);
      return { passes: pass, converged: true, changedPasses };
    }
    changedPasses++;
    deps.log(`回填第 ${pass} 轮有变更,继续`);
  }
  deps.log(`回填 ${maxPasses} 轮仍有变更 → 未收敛(⚠️需人工看)`);
  return { passes: maxPasses, converged: false, changedPasses };
}
