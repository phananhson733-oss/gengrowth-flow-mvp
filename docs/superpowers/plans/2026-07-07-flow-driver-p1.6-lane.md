# Flow Driver P1.6 (lane 自动跑 + 一条汇总) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 加一条 launchd lane 让 driver 到点自动跑；把 archive 的 per-park 通知换成**每轮一条终态汇总**（符合"只发终态、不刷中间态"）。lane **默认安全**：跑起来但默认 dry-run，`--apply` 由 `GG_FLOW_DRIVER_APPLY=1` 显式开、RunAtLoad false、灰度上线。

**Architecture:** driver 的 `--apply` 不再 per-park 发通知——archive 只记 sidecar，driveApply 收集终态 slugs，跑完打印一行 `FLOW_DRIVER_SUMMARY: <msg>`（仅当有终态）。新 tick.sh 跑 driver（dry-run 除非 GG_FLOW_DRIVER_APPLY=1）并把那行 relay 给 `gg-lark-notify.sh`。plist 复用现有 lane 范式（RunAtLoad false，Background，user session）。

**Tech Stack:** Node ESM, bash tick(仿 gg-seo-author-tick.sh), launchd plist, `gg-lark-notify.sh`(Hermes bot 汇总)。

## Global Constraints

- **只在 macmini 改 flow 代码;** 隔离 worktree(基于 origin/main)+rebase push;repo 在 codex 分支+Codex 会话在跑,**绝不碰 checkout**。
- **Full-suite baseline:** 仅 2 pre-existing codex 超时可接受。
- **lane 默认安全(不可协商)**：① RunAtLoad **false**(加载不立即跑) ② tick 默认 **dry-run**,只有 `GG_FLOW_DRIVER_APPLY=1` 才 --apply ③ 不 launchctl 自动 enable(交人工灰度) ④ 不设 LimitLoadToSessionType=Background(要 keychain 跑 gh/claude)。
- **一条汇总**：driver 每轮 --apply 只输出**一行** `FLOW_DRIVER_SUMMARY:`（仅当 fixed/archived/fixFailed 有非零),tick relay 一条飞书;无终态 → 静默(不发)。
- **env 加载**：tick 必须 `set -a; . ~/.config/gg/_gg.env; set +a`(30 个 bare KEY=,否则 gh/codex 密钥对子进程不可见——见 [[manual-gate-env-set-a-footgun]])。
- **锁**：mkdir 互斥 + pid/lstart identity cookie + stale-takeover(仿 author tick),防并发 + PID 复用。

## File Structure

- **Modify** `tools/scripts/lib/flow-driver-apply.mjs` — archive 改 sidecar-only(去 per-park notify 命令);driveApply 收集 `archivedSlugs/fixedSlugs/fixFailedSlugs`;新增 `buildSummaryMessage(s, site)`。
- **Modify** `tools/scripts/gg-flow-driver.mjs` — --apply 末尾若有终态,打印 `FLOW_DRIVER_SUMMARY: <buildSummaryMessage>`。
- **Create** `tools/scripts/gg-flow-driver-tick.sh` — env+锁+跑 driver(dry-run 除非 GG_FLOW_DRIVER_APPLY=1)+relay 汇总。
- **Create** `tools/scripts/com.gengrowth.flow-driver.plist` — RunAtLoad false,StartInterval,Background,日志。
- **Modify** `tools/scripts/__tests__/flow-driver-apply.smoke.test.mjs` — 改 archive 断言(sidecar-only)+加 buildSummaryMessage 测试。
- **Modify** `tools/scripts/__tests__/flow-driver-plan.smoke.test.mjs` — --apply 断言含 `FLOW_DRIVER_SUMMARY`。

---

### Task 1: archive 改 sidecar-only + driveApply 收集终态 slugs + buildSummaryMessage

**Files:**
- Modify: `tools/scripts/lib/flow-driver-apply.mjs`
- Test: `tools/scripts/__tests__/flow-driver-apply.smoke.test.mjs`

**Interfaces:**
- Changed: `buildActionCommands` archive → `{ kind:'archive', commands: [] }`(不再派 gg-notify;archive=纯 sidecar 记录)。
- Changed: `driveApply` summary 增 `archivedSlugs/fixedSlugs/fixFailedSlugs` 数组。
- New: `buildSummaryMessage(s, site) → string`(仅当有终态;供 CLI 打印 FLOW_DRIVER_SUMMARY)。

- [ ] **Step 1: 改测试(TDD 先改期望)** — 改 `flow-driver-apply.smoke.test.mjs`：

将 `buildActionCommands: archive → 一条 gg-notify parked` 测试替换为：

```js
test('buildActionCommands: archive → sidecar-only(不再 per-park 派通知,一条汇总在末尾)', () => {
  const r = buildActionCommands({ pid: 'PG-X', action: 'archive', slug: 'foo', stage: 'pushed-preview', branch: 'seo/auto/x' }, CFG);
  assert.equal(r.kind, 'archive');
  assert.equal(r.commands.length, 0); // 不派 gg-notify——archive 只记 sidecar
});
```

将 `driveApply: archive 派 notify...deps.ran.length===3` 测试替换为（archive 不再 spawn，fix 派 2 条）：

```js
test('driveApply: archive 只记 sidecar(不 spawn)、fix 派两条、汇总带 slugs', async () => {
  const deps = mkDeps();
  const plan = [
    { pid: 'PG-A', action: 'archive', slug: 'aa', stage: 'pushed-preview', branch: 'b/a' },
    { pid: 'PG-F', action: 'fix', slug: 'ff', stage: 'pushed-preview', branch: 'b/f' },
  ];
  const s = await driveApply(plan, deps);
  assert.equal(s.archived, 1);
  assert.equal(s.fixed, 1);
  assert.deepEqual(s.archivedSlugs, ['aa']);
  assert.deepEqual(s.fixedSlugs, ['ff']);
  assert.equal(deps.ran.length, 2); // 只 fix 的 2 条,archive 不 spawn
  assert.ok(deps.archived.has('PG-A')); // archive 仍记 sidecar
});
```

新增 buildSummaryMessage 测试：

```js
import { buildSummaryMessage } from '../lib/flow-driver-apply.mjs';

test('buildSummaryMessage: 有终态 → 一行中文汇总(含 slugs);无终态 → 空串', () => {
  assert.equal(buildSummaryMessage({ fixed: 0, archived: 0, fixFailed: 0, archivedSlugs: [], fixedSlugs: [], fixFailedSlugs: [] }, 'astrologywiki'), '');
  const msg = buildSummaryMessage({ fixed: 1, archived: 1, fixFailed: 1, fixedSlugs: ['x'], archivedSlugs: ['wc-045'], fixFailedSlugs: ['z'] }, 'astrologywiki');
  assert.match(msg, /astrologywiki/);
  assert.match(msg, /自修上线 1.*x/);
  assert.match(msg, /归档 1.*wc-045/);
  assert.match(msg, /修失败 1.*z/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tools/scripts/__tests__/flow-driver-apply.smoke.test.mjs`
Expected: FAIL（archive 仍派命令 / 无 archivedSlugs / buildSummaryMessage 未导出）。

- [ ] **Step 3: 实现** — 改 `lib/flow-driver-apply.mjs`：

archive 分支改为不派命令：

```js
  if (action === 'archive') {
    return { kind: 'archive', commands: [] }; // sidecar-only：不 per-park 通知,终态进每轮一条汇总
  }
```

driveApply archive 分支改为(不 spawn，记 sidecar + slug)：

```js
    if (built.kind === 'archive') {
      if (deps.isArchived && deps.isArchived(park.pid)) { s.archiveSkipped++; deps.log(`${park.pid} 已归档过 → 跳过(幂等)`); continue; }
      if (archiveCount >= deps.maxArchive) { s.capped++; deps.log(`${park.pid} archive capped(>${deps.maxArchive})`); continue; }
      archiveCount++;
      if (deps.markArchived) deps.markArchived(park.pid);
      s.archived++; s.archivedSlugs.push(park.slug || park.pid);
      deps.log(`${park.pid} archived(记 sidecar,退出队列)`);
      continue;
    }
```

driveApply summary init 增数组 + fix 分支记 slug：

```js
  const s = { fixed: 0, fixFailed: 0, archived: 0, archiveSkipped: 0, retryDeferred: 0, fixSkipped: 0, capped: 0, archivedSlugs: [], fixedSlugs: [], fixFailedSlugs: [] };
```
```js
      if (ok) { s.fixed++; s.fixedSlugs.push(park.slug || park.pid); deps.log(`${park.pid} fix → 重过门(门做保证,PASS 才 merge)`); }
      else { s.fixFailed++; s.fixFailedSlugs.push(park.slug || park.pid); deps.log(`${park.pid} fix 失败(门未过或工具错)——留 needs_human`); }
```

新增 buildSummaryMessage（文件末尾）：

```js
// 每轮一条终态汇总(仅有 fixed/archived/fixFailed 时);无终态→空串(tick 据此决定发不发)。
export function buildSummaryMessage(s, site) {
  if (!(s.fixed || s.archived || s.fixFailed)) return '';
  const parts = [`flow-driver [${site}]`];
  if (s.fixed) parts.push(`自修上线 ${s.fixed}(${s.fixedSlugs.join(', ')})`);
  if (s.archived) parts.push(`归档 ${s.archived}(${s.archivedSlugs.join(', ')})`);
  if (s.fixFailed) parts.push(`修失败留 needs_human ${s.fixFailed}(${s.fixFailedSlugs.join(', ')})`);
  return parts.join('；');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tools/scripts/__tests__/flow-driver-apply.smoke.test.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add tools/scripts/lib/flow-driver-apply.mjs tools/scripts/__tests__/flow-driver-apply.smoke.test.mjs
git commit -m "flow-driver P1.6: archive 改 sidecar-only + driveApply 收集终态 slugs + buildSummaryMessage"
```

---

### Task 2: gg-flow-driver --apply 打印 FLOW_DRIVER_SUMMARY

**Files:**
- Modify: `tools/scripts/gg-flow-driver.mjs`
- Test: `tools/scripts/__tests__/flow-driver-plan.smoke.test.mjs`

**Interfaces:**
- Consumes: `driveApply` summary + `buildSummaryMessage` (Task 1)。
- Produces: --apply 末尾若 `buildSummaryMessage` 非空 → 打印 `FLOW_DRIVER_SUMMARY: <msg>`(tick 据此 relay)。

- [ ] **Step 1: 改测试** — `flow-driver-plan.smoke.test.mjs` 的 --apply 测试增断言：

```js
  assert.match(r.stdout, /mode=apply/);
  assert.match(r.stdout, /archived=1/);
  assert.match(r.stdout, /FLOW_DRIVER_SUMMARY: flow-driver \[astrologywiki\].*归档 1/);
```

- [ ] **Step 2: 跑测试确认失败** — 无 `FLOW_DRIVER_SUMMARY` 输出。

- [ ] **Step 3: 实现** — `gg-flow-driver.mjs` 引入 `buildSummaryMessage`,--apply 汇总行后加：

```js
import { driveApply, buildSummaryMessage } from './lib/flow-driver-apply.mjs';
```
```js
  const summaryMsg = buildSummaryMessage(s, SITE);
  if (summaryMsg) console.log(`FLOW_DRIVER_SUMMARY: ${summaryMsg}`);
  process.exit(0);
```

- [ ] **Step 4: 跑测试确认通过**（记得 --apply 测试用 GG_OPS_DIR=temp 隔离 sidecar）。

- [ ] **Step 5: Commit**

```bash
git add tools/scripts/gg-flow-driver.mjs tools/scripts/__tests__/flow-driver-plan.smoke.test.mjs
git commit -m "flow-driver P1.6: --apply 打印 FLOW_DRIVER_SUMMARY(一条终态汇总,供 tick relay)"
```

---

### Task 3: lane — tick.sh + plist（默认安全）

**Files:**
- Create: `tools/scripts/gg-flow-driver-tick.sh`
- Create: `tools/scripts/com.gengrowth.flow-driver.plist`
- Test: `tools/scripts/__tests__/flow-driver-tick.smoke.test.mjs`(bash 子进程冒烟)

**Interfaces:**
- tick 跑 `gg-flow-driver.mjs`(dry-run;`GG_FLOW_DRIVER_APPLY=1` 才 `--apply`),grep `FLOW_DRIVER_SUMMARY:` → `gg-lark-notify.sh "<msg>"`(仅有终态);其余静默。

- [ ] **Step 1: 写 tick 冒烟测试** — `flow-driver-tick.smoke.test.mjs`：

```js
// flow-driver-tick.smoke.test.mjs — tick 默认 dry-run、GG_FLOW_DRIVER_APPLY 才 apply、无终态不发通知。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runTick(env) {
  return spawnSync('bash', ['tools/scripts/gg-flow-driver-tick.sh'], { encoding: 'utf8', env: { ...process.env, ...env } });
}

test('tick 默认 dry-run(无 GG_FLOW_DRIVER_APPLY)：跑 driver 不 --apply,exit 0', () => {
  const ops = mkdtempSync(join(tmpdir(), 'tick-ops-'));
  mkdirSync(join(ops, 'inbox/06-tasks/tasks'), { recursive: true });
  writeFileSync(join(ops, 'inbox/06-tasks/tasks/.autopilot-claims.json'), JSON.stringify({ 'PG-S': { status: 'needs_human', stage: 'pushed-preview', slug: 's', branch: 'b/s', error: 'review[codex] FAIL: stale topic, do not publish' } }));
  const r = runTick({ GG_OPS_DIR: ops, GG_FLOW_DRIVER_LOCK: join(ops, 'lock'), GG_LARK_NOTIFY_SILENCE: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /mode=dry-run/);
  assert.doesNotMatch(r.stdout + r.stderr, /mode=apply/);
});
```

- [ ] **Step 2: 跑测试确认失败** — tick 不存在。

- [ ] **Step 3: 写 tick.sh**（仿 author tick 的 PATH/锁/env）：

```bash
#!/bin/bash
# gg-flow-driver-tick.sh — overlay driver lane。**默认安全**：默认 dry-run(只打印计划),只有
# GG_FLOW_DRIVER_APPLY=1 才 --apply(接侧效:archive/fix→可能 merge)。RunAtLoad false + 手动灰度。
# 跑完把 driver 的 FLOW_DRIVER_SUMMARY 行(仅有终态时有)relay 一条飞书;无终态静默。
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="${GG_FLOW_DRIVER_LOCK:-/tmp/gg-flow-driver.lock}"
LOG_DIR="$HOME/gengrowth-agents/cron-sync/flow_driver"; mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y-%m-%d).log"
TICK_TIMEOUT="${GG_FLOW_DRIVER_TICK_TIMEOUT:-1800}"
case "$TICK_TIMEOUT" in ''|*[!0-9]*) TICK_TIMEOUT=1800 ;; esac

# mkdir 互斥 + pid/lstart identity cookie + stale-takeover(仿 author tick)
if [ -d "$LOCK" ]; then
  lp="$(cat "$LOCK/pid" 2>/dev/null)"; ls_="$(cat "$LOCK/start" 2>/dev/null)"
  cs=""; [ -n "$lp" ] && cs="$(ps -o lstart= -p "$lp" 2>/dev/null | tr -s ' ')"
  if [ -n "$lp" ] && kill -0 "$lp" 2>/dev/null && [ -n "$ls_" ] && [ "$cs" = "$ls_" ]; then
    echo "$(date '+%F %T') skip — prev flow-driver fire (pid $lp) active" >> "$LOG"; exit 0
  fi
  rm -rf "$LOCK" 2>/dev/null
fi
mkdir "$LOCK" 2>/dev/null || { echo "$(date '+%F %T') skip — lost mutex" >> "$LOG"; exit 0; }
trap 'rm -rf "$LOCK" 2>/dev/null' EXIT INT TERM
echo "$$" > "$LOCK/pid"; ps -o lstart= -p $$ 2>/dev/null | tr -s ' ' > "$LOCK/start"

APPLY_FLAG=""; [ "$GG_FLOW_DRIVER_APPLY" = "1" ] && APPLY_FLAG="--apply"
echo "$(date '+%F %T') flow-driver tick start (pid $$, ${APPLY_FLAG:-dry-run})" >> "$LOG"
OUT=$( ( set -a; . "$HOME/.config/gg/_gg.env" 2>/dev/null; set +a
  gtimeout "$TICK_TIMEOUT" node "$SCRIPT_DIR/gg-flow-driver.mjs" $APPLY_FLAG ) 2>&1 )
printf '%s\n' "$OUT" >> "$LOG"
# relay 一条终态汇总(仅有 FLOW_DRIVER_SUMMARY 行时);无终态 → 静默不发
SUMMARY=$(printf '%s\n' "$OUT" | sed -n 's/^FLOW_DRIVER_SUMMARY: //p' | head -1)
if [ -n "$SUMMARY" ]; then
  "$SCRIPT_DIR/gg-lark-notify.sh" "$SUMMARY" >> "$LOG" 2>&1 || true
fi
exit 0
```

- [ ] **Step 4: 写 plist** — `com.gengrowth.flow-driver.plist`（RunAtLoad false，Background，StartInterval 例 7200，日志路径 flow_driver/）。头注写清安装/灰度步骤（cp→enable→bootstrap→kickstart 观察一次；先不设 GG_FLOW_DRIVER_APPLY=先 dry-run 验证，再设 =1 上线）。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!-- flow-driver overlay lane。默认安全:RunAtLoad false(加载不立即跑) + tick 默认 dry-run(只有
     _gg.env 里 GG_FLOW_DRIVER_APPLY=1 才接侧效)。灰度:
       cp tools/scripts/com.gengrowth.flow-driver.plist ~/Library/LaunchAgents/
       launchctl enable    gui/$(id -u)/com.gengrowth.flow-driver
       launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gengrowth.flow-driver.plist
       launchctl kickstart gui/$(id -u)/com.gengrowth.flow-driver   # 先 dry-run 观察一轮
     确认 dry-run 计划无误后,在 ~/.config/gg/_gg.env 加 GG_FLOW_DRIVER_APPLY=1 再 kickstart 上线。
     不设 LimitLoadToSessionType=Background(要 keychain 跑 gh/claude)。 -->
<plist version="1.0"><dict>
  <key>Label</key><string>com.gengrowth.flow-driver</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string>
    <string>/Users/awayer_mini/gengrowth-flow-mvp/tools/scripts/gg-flow-driver-tick.sh</string>
  </array>
  <key>StartInterval</key><integer>7200</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>/Users/awayer_mini/gengrowth-agents/cron-sync/flow_driver/launchd.out.log</string>
  <key>StandardErrorPath</key><string>/Users/awayer_mini/gengrowth-agents/cron-sync/flow_driver/launchd.err.log</string>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
```

- [ ] **Step 5: 跑测试确认通过** + `chmod +x gg-flow-driver-tick.sh`。

- [ ] **Step 6: 手动 dry-run tick 验证**（不设 GG_FLOW_DRIVER_APPLY）：真 ledger 下 tick 跑出 mode=dry-run、WC-045→archive、无飞书。**不 --apply、不 load plist**（交人工灰度）。

- [ ] **Step 7: Full-suite + commit + atomic-land + 对抗评审**。plist/tick **不自动 install/load**——落代码,人工灰度。

---

## Self-Review

- **Spec 覆盖**：实现 spec §4.1 lane + §4.5 一条汇总。**deferred(P1.7)**：LLM stale 预判、sheet 标不写、stranded pushed-preview reconcile、gengrowth 站、时序精确挂 author+publish 后(现用固定 StartInterval)。
- **Placeholder**：无。
- **Type 一致**：`buildSummaryMessage(s,site)` 消费 driveApply summary 的 slugs 数组(T1 定义)→CLI 打印(T2)→tick relay(T3)。

## 安全模型(实现者+operator 必读)
- lane 落地**不等于**自动发布：RunAtLoad false + 默认 dry-run + 不自动 load。启用是**两步显式操作**：load plist(dry-run 观察) → `_gg.env` 加 `GG_FLOW_DRIVER_APPLY=1`(接侧效)。
- --apply 时 fix 会 merge 到 prod,但 **maxFix=1/轮 + 门(codex)做保证**;archive 幂等 sidecar;**每轮只一条飞书汇总**(无终态静默)。
- **不要**在这个 plan 里 `launchctl load` 或设 GG_FLOW_DRIVER_APPLE=1——那是人工灰度决定。

## Deferred → P1.7
LLM stale 预判 · sheet 标"不写" · stranded pushed-preview reconcile · 时序挂 author+publish 后(依赖链而非固定 interval) · gengrowth 站 · P2 完整性 verifier+回填 · P3 GSC browser-use。
