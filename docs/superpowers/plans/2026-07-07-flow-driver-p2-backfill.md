# Flow Driver P2 (loop-until-clean 回填) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 治"publish 后不管"——driver `--apply` 处理完 park 后，跑一遍回填命令序列(reconcile / sync-published / sync-recap / cluster / sync-request-queue)，按"本轮有没有真变更"**循环到收敛(有界)**，把回填状态并入那一条终态汇总。只在 --apply 跑(dry-run 保持只读)。

**Architecture:** 回填也走注入 deps 的确定性 orchestrator。`BACKFILL_STEPS` 是命令序列(纯数据)。`passHadChanges(out)` 用变更计数正则(appended/updated/slugs_added/updatedCells/resolved/retried,**排除 rows**=queue 总数)判本轮是否有真变更。`runBackfillLoop(deps)` 循环整个序列到某轮无变更(收敛)或 maxPasses(默3)。side-effect(spawn 回填命令、写 sheet)全在 deps.runCapture 边界,可 mock 单测。

**Tech Stack:** Node ESM, spawnSync(capture stdout), 复用 `gg-ledger-reconcile`/`gg-index-monitor`/`gg-cluster-page-assets-sync`。

## Global Constraints

- **只在 macmini 改 flow 代码;** 隔离 worktree(基于 origin/main)+rebase push;repo 在 codex 分支+Codex 会话,**绝不碰 checkout**。
- **Full-suite baseline:** 仅 2 pre-existing codex 超时可接受。
- **回填只在 --apply 跑**：dry-run driver 保持纯只读(只打印 park 计划,不写 sheet)。
- **幂等+有界**：回填命令 append-only/idempotent;循环 maxPasses(默3)封顶,不收敛只 warn 不死循环。
- **收敛判据**：变更计数正则 `(appended|updated|slugs_added|updatedCells|resolved|retried)=[1-9]\d*`;**不含 rows**(request-queue 的 rows=N 是 queue 总数、每轮非零,不算变更、不破坏收敛)。
- **命令确切**(本 session 手验过)：reconcile=`gg-ledger-reconcile --apply`;index=`gg-index-monitor --sync-published|--sync-recap|--sync-request-queue --write-sheet`;cluster=`gg-cluster-page-assets-sync --apply`。env 由 tick 的 `set -a; . _gg.env` 提供(sheet auth/workbook)。

## File Structure

- **Create** `tools/scripts/lib/flow-backfill.mjs` — `BACKFILL_STEPS` + `passHadChanges(out)` + `runBackfillLoop(deps)`。
- **Modify** `tools/scripts/gg-flow-driver.mjs` — --apply 末尾(driveApply 之后)跑 runBackfillLoop;把回填状态并入 FLOW_DRIVER_SUMMARY。
- **Modify** `tools/scripts/lib/flow-driver-apply.mjs` — `buildSummaryMessage` 增回填参数(有变更/未收敛才提)。
- **Create** `tools/scripts/__tests__/flow-backfill.smoke.test.mjs` — passHadChanges + runBackfillLoop(mock deps)。
- **Modify** `tools/scripts/__tests__/flow-driver-apply.smoke.test.mjs` — buildSummaryMessage 增回填断言。

---

### Task 1: flow-backfill.mjs — BACKFILL_STEPS + passHadChanges + runBackfillLoop

**Files:**
- Create: `tools/scripts/lib/flow-backfill.mjs`
- Test: `tools/scripts/__tests__/flow-backfill.smoke.test.mjs`

**Interfaces:**
- Produces: `BACKFILL_STEPS`(Array<{label,bin,args}>)、`passHadChanges(out:string)→bool`、`async runBackfillLoop(deps)→{passes,converged,changedPasses}`。`deps={ runCapture(cmd)→Promise<{ok,out}>, log(msg), maxPasses }`。

- [ ] **Step 1: 写失败测试** — `flow-backfill.smoke.test.mjs`：

```js
// flow-backfill.smoke.test.mjs — loop-until-clean 回填：passHadChanges 收敛判据 + runBackfillLoop 有界循环。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passHadChanges, runBackfillLoop, BACKFILL_STEPS } from '../lib/flow-backfill.mjs';

test('passHadChanges: 非零变更计数→true;全零/仅 rows→false', () => {
  assert.equal(passHadChanges('sync-published: updated=7 appended=0'), true);
  assert.equal(passHadChanges('cluster: slugs_added=3'), true);
  assert.equal(passHadChanges('reconcile: resolved=2'), true);
  assert.equal(passHadChanges('updated=0 appended=0 slugs_added=0'), false); // 全零→收敛
  assert.equal(passHadChanges('request-queue: rows=25'), false);             // rows 是总数,不算变更
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
  // passOutputs: 每轮所有 step 合并输出的数组;runCapture 按调用顺序取(每 step 一次)
  let call = 0;
  const perStep = passOutputs.flatMap((passOut) => BACKFILL_STEPS.map(() => passOut));
  return {
    calls: [],
    runCapture: async (cmd) => { const out = perStep[call++] ?? ''; return { ok: true, out }; },
    log: () => {},
    maxPasses: 3,
    _record(cmd) { this.calls.push(cmd); },
  };
}

test('runBackfillLoop: 第一轮有变更、第二轮全零 → 2 轮收敛', async () => {
  // 轮1每 step 输出 "appended=1"(有变更),轮2输出 "appended=0"(收敛)
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
```

- [ ] **Step 2: 跑测试确认失败** — 模块不存在。

- [ ] **Step 3: 实现** — `lib/flow-backfill.mjs`：

```js
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

export async function runBackfillLoop(deps) {
  const maxPasses = deps.maxPasses || 3;
  let changedPasses = 0;
  for (let pass = 1; pass <= maxPasses; pass++) {
    let combined = '';
    for (const step of BACKFILL_STEPS) {
      const r = await deps.runCapture(step);
      combined += `\n${step.label}: ${r.out || ''}`;
      if (!r.ok) deps.log(`回填 ${step.label} 非零退出(继续,幂等下轮补)`);
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
```

- [ ] **Step 4: 跑测试确认通过**。

- [ ] **Step 5: Commit**

```bash
git add tools/scripts/lib/flow-backfill.mjs tools/scripts/__tests__/flow-backfill.smoke.test.mjs
git commit -m "flow-driver P2: flow-backfill loop-until-clean(BACKFILL_STEPS/passHadChanges/runBackfillLoop)"
```

---

### Task 2: buildSummaryMessage 增回填 + gg-flow-driver --apply 跑回填

**Files:**
- Modify: `tools/scripts/lib/flow-driver-apply.mjs`(buildSummaryMessage 增回填参数)
- Modify: `tools/scripts/gg-flow-driver.mjs`(--apply 末尾跑 runBackfillLoop + 汇总)
- Test: `tools/scripts/__tests__/flow-driver-apply.smoke.test.mjs`

**Interfaces:**
- Changed: `buildSummaryMessage(s, site, backfill)` — backfill 可选;仅当 `backfill.changedPasses>0`(补了 gap)或 `backfill.converged===false`(未收敛⚠️)才在汇总加一段。park 无终态但回填补了 gap 时也应发汇总。

- [ ] **Step 1: 改测试** — `flow-driver-apply.smoke.test.mjs` buildSummaryMessage 测试增：

```js
test('buildSummaryMessage: 回填补了 gap → 汇总带回填;收敛无变更 → 不提回填', () => {
  const noTerminal = { fixed: 0, archived: 0, fixFailed: 0, archivedSlugs: [], fixedSlugs: [], fixFailedSlugs: [] };
  // 回填补了 gap(changedPasses>0) → 即使无 park 终态也发汇总
  assert.match(buildSummaryMessage(noTerminal, 'astrologywiki', { converged: true, changedPasses: 1, passes: 2 }), /回填补齐/);
  // 回填未收敛 → warn
  assert.match(buildSummaryMessage(noTerminal, 'astrologywiki', { converged: false, changedPasses: 3, passes: 3 }), /回填未收敛|⚠️/);
  // 回填收敛且无变更 + 无 park 终态 → 空串(不发)
  assert.equal(buildSummaryMessage(noTerminal, 'astrologywiki', { converged: true, changedPasses: 0, passes: 1 }), '');
});
```

- [ ] **Step 2: 跑测试确认失败**。

- [ ] **Step 3: 实现** — `flow-driver-apply.mjs` 改 buildSummaryMessage：

```js
export function buildSummaryMessage(s, site, backfill) {
  const terminal = s.fixed || s.archived || s.fixFailed;
  const bfChanged = backfill && backfill.changedPasses > 0;
  const bfWarn = backfill && backfill.converged === false;
  if (!terminal && !bfChanged && !bfWarn) return '';
  const parts = [`flow-driver [${site}]`];
  if (s.fixed) parts.push(`自修上线 ${s.fixed}(${s.fixedSlugs.join(', ')})`);
  if (s.archived) parts.push(`归档 ${s.archived}(${s.archivedSlugs.join(', ')})`);
  if (s.fixFailed) parts.push(`修失败留 needs_human ${s.fixFailed}(${s.fixFailedSlugs.join(', ')})`);
  if (bfWarn) parts.push(`⚠️回填未收敛(${backfill.passes}轮)`);
  else if (bfChanged) parts.push(`回填补齐(${backfill.changedPasses}轮变更)`);
  return parts.join('；');
}
```

`gg-flow-driver.mjs` --apply 分支(driveApply 之后、summary 之前)插入回填：

```js
import { runBackfillLoop } from './lib/flow-backfill.mjs';
```
```js
  const s = await driveApply(plan, deps);
  // P2：处理完 park 后跑 loop-until-clean 回填(只 --apply,幂等,有界)。
  const backfill = await runBackfillLoop({
    runCapture: async (cmd) => { const r = spawnSync('node', [cmd.bin, ...cmd.args], { encoding: 'utf8' }); return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}` }; },
    log: (m) => console.log(`  · ${m}`),
    maxPasses: Number(process.env.GG_FLOW_DRIVER_BACKFILL_PASSES || 3),
  });
  console.log(`flow-driver: parks=${plan.length} fixed=${s.fixed} fixFailed=${s.fixFailed} archived=${s.archived} archiveSkipped=${s.archiveSkipped} retryDeferred=${s.retryDeferred} fixSkipped=${s.fixSkipped} capped=${s.capped} backfillPasses=${backfill.passes} backfillConverged=${backfill.converged} mode=apply`);
  const summaryMsg = buildSummaryMessage(s, SITE, backfill);
  if (summaryMsg) console.log(`FLOW_DRIVER_SUMMARY: ${summaryMsg}`);
  process.exit(0);
```

- [ ] **Step 4: 跑测试确认通过**(flow-driver-apply + flow-driver-plan)。--apply CLI 测试现在会真 spawn 回填命令——测试用**空 ledger + 隔离 GG_OPS_DIR** 时回填命令会尝试读 sheet(可能失败/慢);改 CLI --apply 测试注入 `GG_FLOW_DRIVER_BACKFILL_PASSES=0` 跳过回填(或 mock),避免测试打真 sheet。

- [ ] **Step 5: 真 ledger dry-run 复核**：`node tools/scripts/gg-flow-driver.mjs`(dry-run)——**不跑回填**(回填只在 --apply),WC-045→archive、mode=dry-run 不变。

- [ ] **Step 6: Full-suite + commit**

```bash
git add tools/scripts/lib/flow-driver-apply.mjs tools/scripts/gg-flow-driver.mjs tools/scripts/__tests__/flow-driver-apply.smoke.test.mjs
git commit -m "flow-driver P2: --apply 处理完 park 后跑 loop-until-clean 回填 + 并入汇总"
```

- [ ] **Step 7: Atomic-land + 对抗评审**。

---

## Self-Review

- **Spec 覆盖**：实现 spec §4.3 回填 + loop-until-clean。**deferred(P2.5/P1.7)**：逐篇 granular 完整性 verifier(现用"整序列 loop 到无变更"的 fixpoint 判完整,更简单;granular 版能指出哪篇缺哪项——留后)、dry-run 下的回填预览(现回填只 --apply)、gengrowth 站回填。
- **收敛正确性**：CHANGE_RE 不含 rows(request-queue 总数)→ request-queue 每轮 rows=N 不破坏收敛;幂等命令第二轮变更归零 → 收敛。maxPasses 封顶防非幂等命令死循环。
- **只读安全**：回填只在 --apply;dry-run driver 不碰 sheet。

## Deferred → P2.5 / P1.7
逐篇 granular 完整性 verifier(指出哪篇缺哪项) · dry-run 回填预览 · gengrowth 站 · (P1.7)LLM stale 预判 / sheet 标不写 / stranded reconcile / 时序挂链。→ P3 GSC browser-use。
