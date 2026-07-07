# Flow Driver P1.5 (--apply 接侧效) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 P1 的 dry-run driver 接上真实动作：`gg-flow-driver.mjs --apply` 对每个 park 按分诊执行 archive(通知+保持 needs_human) / retry(跳过,记数——现有 auto-retry lane owns transient) / fix(重过门→可能 merge)，全程有界、一条终态汇总。

**Architecture:** side-effect 全部收在一个可注入 deps 的纯 orchestrator (`driveApply(plan, deps)`) 后面——测试注入 mock deps 断言"每个 action 派了正确的命令 + 有界 + 汇总正确",不真 spawn。`buildActionCommands(park, cfg)` 是纯函数把 park+action 映射成确切命令数组。`gg-flow-driver.mjs --apply` 只负责把真 deps(spawnSync/notify)接进去。这样控制流确定性可测(符合总纲),LLM/子进程只在边界。

**Tech Stack:** Node ESM `.mjs`, `node:test`, `node:child_process` spawnSync(边界), 复用现有 `gg-seo-autopilot`/`gg-preview-gate`/`gg-notify` 子命令。

## Global Constraints

- **只在 macmini 改 flow 代码;** 隔离 worktree(基于 origin/main)+rebase push origin HEAD:main;repo 当前在 codex 分支+Codex 会话在跑,**绝不碰 checkout**。
- **Full-suite baseline:** `node --test 'tools/scripts/__tests__/*.test.mjs'` — 仅 2 个 pre-existing codex 超时失败可接受,零新回归。
- **dry-run 默认**:无 `--apply` = 只打印(P1 行为不变);`--apply` 才执行。
- **有界**:每次运行最多处理 `GG_FLOW_DRIVER_MAX_FIX`(默认 1) 个 fix、`GG_FLOW_DRIVER_MAX_ARCHIVE`(默认 5) 个 archive——限制爆炸半径。
- **总纲**:fix 的"保证"是**门**(gg-preview-gate 内建 codex 事实核会再抓 stale/错,不会 merge 坏稿);driver 只负责把 park 送回门,不自己判对错。
- **不复刻 claims 锁**:所有 claim 变更走 spawn autopilot 子命令(它内部 withClaimsLock),driver 只读 ledger。
- **claim 字段**(真 ledger 证实):park 有 `status/slug/stage/branch/pr/error`。fix 需 `branch` 且 `stage` 为 gate 阶段(pushed-preview/verified-preview);authoring 阶段 fixable(无 branch)无门可重跑→只记数交现有 re-author。
- **repo/site**:astrologywiki → repo=`xdawayer/oracle`, site=`astrologywiki`(P1.5 只做 astrologywiki;gengrowth 后续)。

## File Structure

- **Create** `tools/scripts/lib/flow-driver-apply.mjs` — `buildActionCommands(park, cfg)` (纯) + `driveApply(plan, deps)` (orchestrator, deps 注入)。
- **Modify** `tools/scripts/gg-flow-driver.mjs` — 加 `--apply` 分支:构造真 deps(spawnSync 跑命令 / notify) → `driveApply` → 一条汇总。dry-run 路径不变。
- **Create** `tools/scripts/__tests__/flow-driver-apply.smoke.test.mjs` — `buildActionCommands` + `driveApply`(mock deps) 单测。

---

### Task 1: `buildActionCommands` — park+action → 确切命令数组（纯函数）

**Files:**
- Create: `tools/scripts/lib/flow-driver-apply.mjs`
- Test: `tools/scripts/__tests__/flow-driver-apply.smoke.test.mjs`

**Interfaces:**
- Consumes: 一个 plan action 对象 `{ pid, action, slug, stage, branch }`(planDriverActions 产出 + 从 claim 补 branch)。
- Produces: `buildActionCommands(park, cfg) → { kind, commands, skipReason }`,`kind ∈ 'fix'|'archive'|'retry-skip'|'fix-skip'`,`commands` 是 `[{bin,args}]` 数组(retry/skip 为 `[]`)。`cfg = { repo, site }`。

- [ ] **Step 1: Write the failing test**

Create `tools/scripts/__tests__/flow-driver-apply.smoke.test.mjs`:

```js
// flow-driver-apply.smoke.test.mjs — P1.5 接侧效：buildActionCommands 映射 + driveApply 编排(mock deps)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildActionCommands } from '../lib/flow-driver-apply.mjs';

const CFG = { repo: 'xdawayer/oracle', site: 'astrologywiki' };

test('buildActionCommands: archive → 一条 gg-notify parked', () => {
  const r = buildActionCommands({ pid: 'PG-X', action: 'archive', slug: 'foo', stage: 'pushed-preview', branch: 'seo/auto/x', reason: '死选题' }, CFG);
  assert.equal(r.kind, 'archive');
  assert.equal(r.commands.length, 1);
  assert.match(r.commands[0].bin, /gg-notify\.mjs$/);
  assert.deepEqual(r.commands[0].args.slice(0, 2), ['parked', '--site']);
  assert.ok(r.commands[0].args.includes('astrologywiki') && r.commands[0].args.includes('PG-X'));
});

test('buildActionCommands: fix(gate 阶段有 branch) → retry-failed + preview-gate 两条', () => {
  const r = buildActionCommands({ pid: 'PG-Y', action: 'fix', slug: 'bar', stage: 'pushed-preview', branch: 'seo/auto/y' }, CFG);
  assert.equal(r.kind, 'fix');
  assert.equal(r.commands.length, 2);
  assert.match(r.commands[0].args.join(' '), /--retry-failed --branch seo\/auto\/y/);
  assert.match(r.commands[1].args.join(' '), /--branch seo\/auto\/y --repo xdawayer\/oracle/);
  assert.match(r.commands[1].bin, /gg-preview-gate\.mjs$/);
});

test('buildActionCommands: fix 但 authoring 阶段(无 branch) → fix-skip,不派门', () => {
  const r = buildActionCommands({ pid: 'PG-Z', action: 'fix', slug: 'baz', stage: 'authoring', branch: '' }, CFG);
  assert.equal(r.kind, 'fix-skip');
  assert.equal(r.commands.length, 0);
  assert.match(r.skipReason, /authoring|no branch|无门/i);
});

test('buildActionCommands: retry → retry-skip,不派命令(现有 auto-retry lane owns)', () => {
  const r = buildActionCommands({ pid: 'PG-T', action: 'retry', slug: 't', stage: 'pushed-preview', branch: 'seo/auto/t' }, CFG);
  assert.equal(r.kind, 'retry-skip');
  assert.equal(r.commands.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/scripts/__tests__/flow-driver-apply.smoke.test.mjs`
Expected: FAIL — cannot find module `../lib/flow-driver-apply.mjs`.

- [ ] **Step 3: Write minimal implementation**

Create `tools/scripts/lib/flow-driver-apply.mjs`:

```js
// lib/flow-driver-apply.mjs — P1.5 接侧效。buildActionCommands: park+action→确切命令(纯,可测);
// driveApply: 编排(deps 注入,side-effect 在边界)。总纲:控制流确定性,门做保证,子进程只在边界。
import { join } from 'node:path';

const SCRIPTS = new URL('.', import.meta.url).pathname.replace(/\/lib\/$/, '');
const AUTOPILOT = join(SCRIPTS, 'gg-seo-autopilot.mjs');
const PREVIEW_GATE = join(SCRIPTS, 'gg-preview-gate.mjs');
const NOTIFY = join(SCRIPTS, 'gg-notify.mjs');

// gate 阶段(有 PR/branch,可重过门自修) vs authoring 阶段(无门)。
const GATE_STAGES = new Set(['pushed-preview', 'verified-preview']);

export function buildActionCommands(park, cfg) {
  const { pid, action, slug = '', stage = '', branch = '', reason = '' } = park;
  if (action === 'retry') {
    return { kind: 'retry-skip', commands: [], skipReason: 'transient — 现有 --auto-retry-parks lane owns' };
  }
  if (action === 'archive') {
    return {
      kind: 'archive',
      commands: [{ bin: NOTIFY, args: ['parked', '--site', cfg.site, '--pid', pid, '--slug', slug, '--reason', reason || 'archived: unfixable(时效死/不该发)'] }],
    };
  }
  if (action === 'fix') {
    if (!branch || !GATE_STAGES.has(stage)) {
      return { kind: 'fix-skip', commands: [], skipReason: `fixable 但 ${stage || 'no'} 阶段无 branch/门可重跑(authoring→交现有 re-author)` };
    }
    return {
      kind: 'fix',
      commands: [
        { bin: AUTOPILOT, args: ['--retry-failed', '--branch', branch] },
        { bin: PREVIEW_GATE, args: ['--branch', branch, '--repo', cfg.repo] },
      ],
    };
  }
  return { kind: 'unknown', commands: [], skipReason: `未知 action ${action}` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/scripts/__tests__/flow-driver-apply.smoke.test.mjs`
Expected: PASS — `tests 4 / pass 4`.

- [ ] **Step 5: Commit**

```bash
git add tools/scripts/lib/flow-driver-apply.mjs tools/scripts/__tests__/flow-driver-apply.smoke.test.mjs
git commit -m "flow-driver P1.5: buildActionCommands park+action→确切命令(纯函数)"
```

---

### Task 2: `driveApply` — 有界编排 + 汇总（deps 注入）

**Files:**
- Modify: `tools/scripts/lib/flow-driver-apply.mjs` (追加 `driveApply`)
- Test: `tools/scripts/__tests__/flow-driver-apply.smoke.test.mjs` (追加)

**Interfaces:**
- Consumes: `buildActionCommands` (Task 1)。
- Produces: `async driveApply(plan, deps) → summary`。`deps = { run(cmd)→Promise<{ok,code}>, log(msg), cfg:{repo,site}, maxFix, maxArchive }`。`summary = { fixed, fixFailed, archived, retryDeferred, fixSkipped, capped }`。**有界**:超过 maxFix/maxArchive 的同类 park 记入 `capped`、不执行。

- [ ] **Step 1: Write the failing test** (追加)

```js
import { driveApply } from '../lib/flow-driver-apply.mjs';

function mkDeps(overrides = {}) {
  const ran = [];
  return {
    ran,
    run: async (cmd) => { ran.push(cmd); return { ok: overrides.fail ? false : true, code: overrides.fail ? 1 : 0 }; },
    log: () => {},
    cfg: CFG,
    maxFix: overrides.maxFix ?? 1,
    maxArchive: overrides.maxArchive ?? 5,
  };
}

test('driveApply: archive 派 notify、retry 跳过、fix 派两条门命令、汇总正确', async () => {
  const deps = mkDeps();
  const plan = [
    { pid: 'PG-A', action: 'archive', slug: 'a', stage: 'pushed-preview', branch: 'b/a' },
    { pid: 'PG-T', action: 'retry', slug: 't', stage: 'pushed-preview', branch: 'b/t' },
    { pid: 'PG-F', action: 'fix', slug: 'f', stage: 'pushed-preview', branch: 'b/f' },
  ];
  const s = await driveApply(plan, deps);
  assert.equal(s.archived, 1);
  assert.equal(s.retryDeferred, 1);
  assert.equal(s.fixed, 1);
  // fix 派了 2 条(retry-failed + preview-gate)、archive 1 条 notify = 3 条真跑
  assert.equal(deps.ran.length, 3);
});

test('driveApply: maxFix=1 时第二个 fix 被 cap、不执行', async () => {
  const deps = mkDeps({ maxFix: 1 });
  const plan = [
    { pid: 'PG-F1', action: 'fix', slug: 'f1', stage: 'pushed-preview', branch: 'b/f1' },
    { pid: 'PG-F2', action: 'fix', slug: 'f2', stage: 'pushed-preview', branch: 'b/f2' },
  ];
  const s = await driveApply(plan, deps);
  assert.equal(s.fixed, 1);
  assert.equal(s.capped, 1);
  assert.equal(deps.ran.length, 2); // 只第一个 fix 的 2 条命令
});

test('driveApply: fix 命令失败 → fixFailed 计数、不误报 fixed', async () => {
  const deps = mkDeps({ fail: true });
  const plan = [{ pid: 'PG-F', action: 'fix', slug: 'f', stage: 'pushed-preview', branch: 'b/f' }];
  const s = await driveApply(plan, deps);
  assert.equal(s.fixed, 0);
  assert.equal(s.fixFailed, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/scripts/__tests__/flow-driver-apply.smoke.test.mjs`
Expected: FAIL — `driveApply is not a function`.

- [ ] **Step 3: Write minimal implementation** (追加到 `lib/flow-driver-apply.mjs`)

```js
export async function driveApply(plan, deps) {
  const s = { fixed: 0, fixFailed: 0, archived: 0, retryDeferred: 0, fixSkipped: 0, capped: 0 };
  let fixCount = 0, archiveCount = 0;
  for (const park of plan || []) {
    const built = buildActionCommands(park, deps.cfg);
    if (built.kind === 'retry-skip') { s.retryDeferred++; deps.log(`${park.pid} retry → 交现有 auto-retry lane`); continue; }
    if (built.kind === 'fix-skip') { s.fixSkipped++; deps.log(`${park.pid} fix-skip: ${built.skipReason}`); continue; }
    if (built.kind === 'archive') {
      if (archiveCount >= deps.maxArchive) { s.capped++; deps.log(`${park.pid} archive capped(>${deps.maxArchive})`); continue; }
      archiveCount++;
      const r = await deps.run(built.commands[0]);
      if (r.ok) s.archived++; else deps.log(`${park.pid} archive notify 失败 code=${r.code}`);
      continue;
    }
    if (built.kind === 'fix') {
      if (fixCount >= deps.maxFix) { s.capped++; deps.log(`${park.pid} fix capped(>${deps.maxFix},下轮再处理)`); continue; }
      fixCount++;
      let ok = true;
      for (const cmd of built.commands) { const r = await deps.run(cmd); if (!r.ok) { ok = false; break; } }
      if (ok) { s.fixed++; deps.log(`${park.pid} fix → 重过门(门做保证,PASS 才 merge)`); }
      else { s.fixFailed++; deps.log(`${park.pid} fix 失败(门未过或工具错)——留 needs_human`); }
      continue;
    }
  }
  return s;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/scripts/__tests__/flow-driver-apply.smoke.test.mjs`
Expected: PASS — `tests 7 / pass 7`.

- [ ] **Step 5: Commit**

```bash
git add tools/scripts/lib/flow-driver-apply.mjs tools/scripts/__tests__/flow-driver-apply.smoke.test.mjs
git commit -m "flow-driver P1.5: driveApply 有界编排+汇总(deps 注入,可测)"
```

---

### Task 3: `gg-flow-driver.mjs --apply` — 接真 deps + 一条汇总

**Files:**
- Modify: `tools/scripts/gg-flow-driver.mjs`
- Test: `tools/scripts/__tests__/flow-driver-plan.smoke.test.mjs` (追加 --apply 的 dry-run 仍不执行 + branch 补全测试)

**Interfaces:**
- Consumes: `planDriverActions` (P1), `driveApply` (Task 2)。
- Produces: `--apply` 时构造 `deps.run = (cmd)=>spawnSync(cmd.bin,cmd.args)` + 从 ledger 补 `branch`/`stage` 进 plan;跑完 `console.log` 一条汇总 + (可选)`notify` 汇总。无 `--apply` 时行为完全不变(P1 dry-run)。

- [ ] **Step 1: Write the failing test** (追加到 `flow-driver-plan.smoke.test.mjs`)

```js
test('gg-flow-driver 无 --apply：仍是 dry-run,绝不执行(exit 0,只打印计划)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowdrv-noapply-'));
  const ledger = join(dir, 'claims.json');
  writeFileSync(ledger, JSON.stringify(CLAIMS));
  const r = spawnSync('node', ['tools/scripts/gg-flow-driver.mjs', '--ledger', ledger], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /mode=dry-run/);
  assert.doesNotMatch(r.stdout, /mode=apply/);
});

test('gg-flow-driver --apply --ledger(只 archive 的 ledger)：跑出 mode=apply 汇总,exit 0', () => {
  // 只放一个 unfixable(archive)——不触发 fix(不会真 merge),测 apply 路径安全
  const dir = mkdtempSync(join(tmpdir(), 'flowdrv-apply-'));
  const ledger = join(dir, 'claims.json');
  writeFileSync(ledger, JSON.stringify({ 'PG-S': { status: 'needs_human', stage: 'pushed-preview', slug: 's', branch: 'seo/auto/s', error: 'review[codex] FAIL: stale topic, do not publish' } }));
  // GG_FLOW_DRIVER_DRYRUN_NOTIFY=1：archive 的 notify 也走 dry(不真发飞书)——见实现
  const r = spawnSync('node', ['tools/scripts/gg-flow-driver.mjs', '--ledger', ledger, '--apply'], { encoding: 'utf8', env: { ...process.env, GG_LARK_NOTIFY_SILENCE: '1' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /mode=apply/);
  assert.match(r.stdout, /archived=1/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/scripts/__tests__/flow-driver-plan.smoke.test.mjs`
Expected: FAIL — 无 `mode=apply`/`archived=` 输出(--apply 未接线)。

- [ ] **Step 3: Write minimal implementation** (改 `gg-flow-driver.mjs`)

在现有 dry-run 打印之后、`process.exit(0)` 之前,插入 `--apply` 分支。完整替换 `main()`:

```js
import { spawnSync } from 'node:child_process';
import { driveApply } from './lib/flow-driver-apply.mjs';

const APPLY = argv.includes('--apply');
const REPO = process.env.GG_FLOW_DRIVER_REPO || 'xdawayer/oracle';
const SITE = process.env.GG_FLOW_DRIVER_SITE || 'astrologywiki';
const MAX_FIX = Number(process.env.GG_FLOW_DRIVER_MAX_FIX || 1);
const MAX_ARCHIVE = Number(process.env.GG_FLOW_DRIVER_MAX_ARCHIVE || 5);

async function main() {
  let claims = {};
  try { claims = JSON.parse(readFileSync(ledgerPath, 'utf8')); }
  catch (e) { console.error(`flow-driver: 读 ledger 失败 ${String(e.message).slice(0, 80)} — 无可规划`); process.exit(0); }
  const plan = planDriverActions(claims);
  // 从 claim 补 branch/stage(planDriverActions 已带 stage,补 branch)
  for (const p of plan) { const c = claims[p.pid] || {}; p.branch = c.branch || ''; }
  for (const a of plan) console.log(`  ${a.pid} [${a.stage}] → ${a.action}\t${a.slug}\t${a.reason}`);
  const n = (act) => plan.filter((a) => a.action === act).length;

  if (!APPLY) {
    console.log(`flow-driver: parks=${plan.length} fix=${n('fix')} retry=${n('retry')} archive=${n('archive')} mode=dry-run`);
    process.exit(0);
  }

  const deps = {
    run: async (cmd) => { const r = spawnSync('node', [cmd.bin, ...cmd.args], { encoding: 'utf8', stdio: 'inherit' }); return { ok: r.status === 0, code: r.status }; },
    log: (m) => console.log(`  · ${m}`),
    cfg: { repo: REPO, site: SITE },
    maxFix: MAX_FIX, maxArchive: MAX_ARCHIVE,
  };
  const s = await driveApply(plan, deps);
  console.log(`flow-driver: parks=${plan.length} fixed=${s.fixed} fixFailed=${s.fixFailed} archived=${s.archived} retryDeferred=${s.retryDeferred} fixSkipped=${s.fixSkipped} capped=${s.capped} mode=apply`);
  process.exit(0);
}
```

(保留现有 F3 的 `try { main() } catch { exit 0 }` 兜底;`main` 现在是 async,catch 里 `.catch(()=>process.exit(0))` 或 `try/await`。)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/scripts/__tests__/flow-driver-plan.smoke.test.mjs`
Expected: PASS。

- [ ] **Step 5: 真 ledger dry-run 复核(WC-045 仍 archive,不误触发 fix)**

Run: `node tools/scripts/gg-flow-driver.mjs`
Expected: `mode=dry-run`, WC-045 → archive, fix=0(不会真 merge)。**不要在真 ledger 上跑 --apply**(直到你确认)——现在唯一 park 是 WC-045,archive 会真发一条飞书 parked 通知。

- [ ] **Step 6: Full-suite + commit**

Run: `node --test 'tools/scripts/__tests__/*.test.mjs'` → 仅 2 pre-existing codex 超时。

```bash
git add tools/scripts/gg-flow-driver.mjs tools/scripts/__tests__/flow-driver-plan.smoke.test.mjs
git commit -m "flow-driver P1.5: gg-flow-driver --apply 接真 deps(spawn/notify)+汇总;dry-run 默认不变"
```

- [ ] **Step 7: Atomic-land**(隔离 worktree rebase push origin HEAD:main) + 对抗评审 before land。

---

## Self-Review

- **Spec 覆盖**:实现 spec §4.2 的 fix/archive/retry wiring。**已声明 deferred(不在 P1.5)**:sheet 标"不写"(需扩展 flipRowsByPageId→P1.6)、LLM stale 预判(保守正则漏的非显式 stale 会落 fix 空跑一轮门,靠门内 codex 兜底→P1.6)、launchd lane(P1.6,默认 off)、gengrowth 站(P1.5 只 astrologywiki)。
- **Placeholder**:无——每步真代码+真命令+期望。
- **Type 一致**:`buildActionCommands→{kind,commands,skipReason}`(T1) 被 `driveApply` 消费(T2)、`driveApply→summary` 被 CLI 汇总(T3)。deps 形状 T2/T3 一致(run/log/cfg/maxFix/maxArchive)。

## 安全要点(实现者必读)
- **fix 会 merge 到 prod**。防护:dry-run 默认、maxFix=1/轮、只对 gate 阶段有 branch 的 park、**门(codex 事实核)是最终保证**(不会 merge 坏/stale 稿——WC-045 若误判 fix,门会再抓 stale 并 park)。
- **不要在真 ledger 无监督跑 --apply** 直到 lane(P1.6)前做过一次有监督验证。
- **archive 会真发一条飞书 parked 通知**(除非 GG_LARK_NOTIFY_SILENCE=1)。

## Deferred → P1.6
sheet 标"不写"(扩展 flipRowsByPageId) · LLM stale 预判(自修前拦截,省一轮门) · launchd lane `com.gengrowth.flow-driver`(默认 off,时序挂 author+publish 后) · 每轮一条汇总飞书(现在是 console 汇总) · gengrowth 站支持。
