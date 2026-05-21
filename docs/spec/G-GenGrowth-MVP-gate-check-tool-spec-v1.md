---
title: GenGrowth MVP — bin/gg-gate-check 统一 gate 工具 spec v1
date: 2026-05-21
type: tech-spec
author: wzb
status: draft (W1 Thu Claude Code 实现参考)
version: v1.0
tags:
  - gengrowth
  - mvp
  - gate-check
  - tool-spec
aliases:
  - gate check unified spec
related:
  - "[[G-GenGrowth-MVP-day1-gate-check-tool-spec-v1]]"
  - "[[G-GenGrowth-MVP-RACI-and-execution-flow-v1]]"
  - "[[G-GenGrowth-MVP-落地plan-v1.1]]"
review_trail:
  - "2026-05-21 v1.0 — RACI v1 §6 P1-2 W1 Thu 30 min 落地。把已 ship 的 day-1 gate（5 binary）和 weekly / vertical-slice / day-14 / day-30 / day-60 五条新 gate 收口到一个入口；day-1 走 child process 转发避免双源漂移；其余 5 条 v1 最简版（每 gate 2-3 check）。"
---

# /bin/gg-gate-check 统一 gate 工具 spec v1

> [!info] 为什么有这个工具
> plan v1.1 全程有 6 个判决点：Day-1 主线/§1B 分叉、Week-2 vertical-slice、周报、Day 14 cohort、Day 30 retro（Lynne judge）、Day 60 kill（Lynne judge）。当前只有 Day-1 单独自动化（`gg-day1-gate-check.mjs`）。其余 5 条还在手工核对 plan 表格，**容易漏 + 容易错记 + 没有统一报告归档**。
> 这个工具是 RACI v1 §6 P1-2：把 6 个判决点收口到一个入口 `gg-gate-check --gate <type>`，复用 day-1 已 ship 的 helpers + 报告模板风格。**v1 是最简版**：每个 gate 只跑 2-3 个 binary check 字段，复杂判决（Lynne sign-off 的真实数据）仍由 wzb 手工填 manifest。

---

## §1 30 秒读完

**入口**：`node tools/scripts/gg-gate-check.mjs --gate <type> [--manifest <path>] [--out <path>] [--skip-infra]`

**支持的 gate**：

| `--gate` | 触发时机 | check 项数 | 实现策略 |
|----------|---------|-----------|---------|
| `day-1` | Day-1 18:00 主线/§1B 分叉 | 5（已 ship）| child process 转发到 `gg-day1-gate-check.mjs` |
| `weekly` | 每周五 17:00 周报 | 3 | 本工具内置 |
| `vertical-slice` | W2 Wed 17:00 自检 | 3 | 本工具内置（含 1 文件读）|
| `day-14` | 首批 cohort age = 14 天 | 2 | 本工具内置 |
| `day-30` | W6 Mon retro pack 前 | 3 | 本工具内置（Lynne sign-off）|
| `day-60` | Day 60 kill 决策前 | 3 | 本工具内置（Lynne kill/continue）|

**退出码**：`0` PASS / `1` FAIL（任一 check 不过）/ `2` fatal（manifest 缺失 / parse 错 / IO 错 / 未知 gate）。
**wzb 工作量**：每次 ≤ 5 min（跑命令 + LOOK 报告）；6 个 gate 全程 ≤ 30 min。
**Ship 时机**：W1 Thu，30 min Claude Code 增量（RACI v1 §6 P1-2）。

---

## §2 输入

### 2.1 通用 CLI flag

| flag | 默认 | 说明 |
|------|------|------|
| `--gate <type>` | 必填 | 6 种之一（见 §1） |
| `--manifest <path>` | 见 §2.2 各 gate 默认值 | 该 gate 的 manifest 文件 |
| `--out <path>` | `~/.gg-cache/gate-<type>-<YYYY-MM-DD>.md` | 报告输出 |
| `--skip-infra` | false | 仅对 `day-1` 有效（转发给 child process）|
| `--help` / `-h` | — | 用法 |

### 2.2 各 gate 的 manifest 默认路径

| gate | 默认 manifest 路径 |
|------|------------------|
| `day-1` | `~/.gg-cache/day1-manifest.json`（由 day-1 child 解析）|
| `weekly` | `~/.gg-cache/weekly-manifest-<ISO-week>.json`（ISO 周用 `2026-W21` 格式）|
| `vertical-slice` | `~/.gg-cache/vertical-slice-manifest.json` |
| `day-14` | `~/.gg-cache/day14-manifest.json` |
| `day-30` | `~/.gg-cache/day30-manifest.json` |
| `day-60` | `~/.gg-cache/day60-manifest.json` |

> [!tip] ISO week 怎么算
> 用 Node `new Date()` + ISO 8601 week-numbering year + week number；不依赖 `Intl`。例：2026-05-21 = `2026-W21`。

---

## §3 各 gate 最简 check 定义（v1）

> [!warning] v1 是"最简版"
> 每个非 day-1 gate 只跑 2-3 个字段断言，**够 wzb 自检不漏即可**。v2 再加更多 check（见 §7 边界）。

### 3.1 `weekly`（周报 3 binary）

| # | check | manifest 字段 | 判决 |
|---|-------|-------------|------|
| 1 | wzb 本周工时 ≤ 18h | `wzb_hours_this_week` (number) | 字段为 number 且 ≤ 18 |
| 2 | 精修发布 ≥ 1 篇 | `articles_published_this_week` (number) | 字段为 number 且 ≥ 1 |
| 3 | Ops 工时 ≥ 5h | `ops_hours_this_week` (number) | 字段为 number 且 ≥ 5 |

**plan 引用**：§11.1 工时看板 + §11.2 精修看板 + §3-§5 各周 Ops 工时行。

### 3.2 `vertical-slice`（W2 Wed 17:00 3 check）

| # | check | manifest 字段 / 路径 | 判决 |
|---|-------|---------------------|------|
| 1 | `/gg-content-draft` ship 完成 | `content_draft_shipped_at` (ISO timestamp) | 合法 ISO timestamp ≤ now |
| 2 | 1 篇精修走通端到端 | `vertical_slice_article_url` (非空 string) | 非空字符串 |
| 3 | facts-audit 报告 0 CRITICAL | `facts_audit_report_path` (文件存在) | 文件存在 + JSON parse + `status === 'pass'` 或 `critical_count === 0` |

**plan 引用**：§3.4 Day 3-4 manage 自检（lean2.1 vertical-slice 判定）。

> [!info] facts-audit 报告字段约定
> v1 接受两种 shape：(a) `{ "status": "pass" }`；(b) `{ "critical_count": 0 }`。任一满足即 pass。

### 3.3 `day-14`（首批 cohort 2 check）

| # | check | manifest 字段 | 判决 |
|---|-------|-------------|------|
| 1 | Day 14 GA4 pageviews ≥ 阈值 | `day14_pageviews` (number) | ≥ 阈值（默认 100，从 env `GG_DAY14_PAGEVIEWS_MIN` 读，否则 100）|
| 2 | ≥ 1 篇排名 Top 50 | `day14_top50_count` (number) | ≥ 1 |

**plan 引用**：§5.3 Week-4 必交付 "首批 Day 14 节点到达"；§11.3 "Day 14 收录率 ≥ 80%"。
**v1 简化**：用 pageviews + Top 50 count 做最简 proxy；收录率 v2 加。

### 3.4 `day-30`（W6 Mon Lynne retro 3 check）

| # | check | manifest 字段 | 判决 |
|---|-------|-------------|------|
| 1 | ≥ 3 篇 Top 10 | `day30_top10_count` (number) | ≥ 3 |
| 2 | ≥ 3 篇 AI 引用 | `day30_ai_citation_count` (number) | ≥ 3 |
| 3 | Lynne sign-off 收 | `lynne_day30_signoff_at` (ISO timestamp) | 合法 ISO timestamp ≤ now |

**plan 引用**：§6.6 Day 30 retro gate（lean2.1 新增）+ §6.7.1 Day 60 成功标准（提前 30 天看 stretch goal）。
> [!warning] v1 简化
> plan §6.6 真实判决档是"≥1 Top 50 + ≥1 AI Overview"（正向）/ "0 SERP feature" (微弱) / "0/3" (kill)。v1 工具只 check 是否到 stretch 目标 + Lynne sign-off 是否收。**Lynne 真实决策档**仍由 Lynne 看数据手工 trigger（plan §6.6 表格），工具不替代。

### 3.5 `day-60`（kill criterion 3 check）

| # | check | manifest 字段 | 判决 |
|---|-------|-------------|------|
| 1 | ≥ 3 篇 Top 10 持续 | `day60_top10_count` (number) | ≥ 3 |
| 2 | ≥ 3 篇 AI 引用持续 | `day60_ai_citation_count` (number) | ≥ 3 |
| 3 | Lynne kill/continue 决定 | `lynne_day60_decision` (string) | `'continue'` 或 `'kill'`（必须二选一）|

**plan 引用**：§6.7.2 Day 60 kill criterion（v1.1.2 judge = Lynne）。
> [!warning] v1 简化
> Day 60 真实判决 4 档（plan §6.7.2 表）。v1 工具只 check 数据到 stretch + Lynne 是否给了 decision。**`PASS` = 数据达标 + Lynne `continue`；`FAIL` = 任一不达 / Lynne `kill` / 字段缺**。

### 3.6 `day-1`（已 ship，child process 转发）

转发 `--manifest` / `--out` / `--skip-infra` 给 `gg-day1-gate-check.mjs`，继承其退出码 + stdout + stderr。本工具**不**重新实现 5 check 逻辑。

---

## §4 通用实现规则

### 4.1 复用 day-1 helpers

直接 `import` `gg-day1-gate-check.mjs` 的：

- `loadEnv()`：解析 `_gg.env`
- `redact()`：脱敏 token / private key
- `parseIsoTimestamp(value)`：ISO timestamp 严格 regex + parse
- `parseIsoDate(value)`：YYYY-MM-DD 严格 regex + parse
- `loadManifest(path)`：throw `{ code: 'MANIFEST_MISSING' | 'MANIFEST_PARSE' | 'MANIFEST_SHAPE' | 'MANIFEST_IO' }`
- `isNonEmptyString(v)`

**理由**：避免双源漂移；day-1 已经过 smoke + dry-run 验证。

### 4.2 check 返回 shape

```js
// 每个 check 函数返回：
{
  pass: boolean,
  name: string,        // 人读 check 名（报告 §B 行标题）
  field: string,       // 失败时定位字段名
  evidence: string,    // 通过 redact 的可读 evidence
  line_ref: string,    // plan 行号 / 章节引用
}
```

### 4.3 报告模板（§A + §B + §C）

仿 day-1 的 `~/.gg-cache/day1-gate-<date>.md` 风格：

```markdown
# Gate Report (<type>) — <YYYY-MM-DD>

## §A 结论
- **RESULT**: n/m PASS / FAIL
- **gate**: <type>
- **生成时间**: ISO timestamp
- **manifest 路径**: ...

## §B check 明细
| # | check | status | evidence | line ref |
|---|-------|--------|----------|----------|
| 1 | ... | PASS/FAIL | ... | plan §X.Y |

## §C wzb 行动建议
- PASS → 按 plan §<下一节> 起跑
- FAIL → 看失败 check 的 line ref 决定补救动作
```

**目录不存在**：`mkdirSync(dir, { recursive: true })`。

### 4.4 day-1 转发

```js
import { spawnSync } from 'node:child_process';
const args = [DAY1_SCRIPT];
if (manifest) args.push('--manifest', manifest);
if (out) args.push('--out', out);
if (skipInfra) args.push('--skip-infra');
const res = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(res.status ?? 2);
```

**注意**：`stdio: 'inherit'` 保证 stdout/stderr 实时透传；不用 `encoding: 'utf8'` 捕获。

### 4.5 退出码

| 码 | 含义 |
|----|------|
| 0 | 所有 check PASS（包括 day-1 5/5）|
| 1 | 任一 check FAIL（包括 day-1 n/5）|
| 2 | 工具自身异常：manifest 缺失 / parse 错 / IO 错 / `--gate` 未传 / `--gate` 是未知值 |

---

## §5 输出例（console）

PASS 例（weekly 3/3）/ FAIL 例（day-30 1/3）：每行 `Check N <name> ........ PASS/FAIL  (evidence)`，末尾 `RESULT: n/m PASS` 或 `RESULT: n/m FAIL` + `Failed checks: ...` + `Action: see <plan ref>`。报告路径打印为 `Report: <path>`。Markdown 报告结构见 §4.3。

---

## §6 Ship checklist（W1 Thu Claude Code，30 min）

- [ ] `tools/scripts/gg-gate-check.mjs` 入口脚本（Node 内置 only，ES modules）
- [ ] CLI 解析 `--gate / --manifest / --out / --skip-infra / -h`
- [ ] 6 个 gate 分支：day-1 child process 转发；其余 5 个内置
- [ ] 5 个 internal gate 各自一个 `run<Gate>(manifest, opts)` 函数返回 `{ results, passed, total }`
- [ ] 复用 day-1 的 `loadManifest` / `parseIsoTimestamp` / `parseIsoDate` / `redact` / `isNonEmptyString`
- [ ] `renderConsole(gate, summary)` + `renderMarkdown(gate, summary, manifestPath)`
- [ ] 报告写 `~/.gg-cache/gate-<type>-<date>.md`（目录不存在自建）
- [ ] 退出码 0/1/2
- [ ] **不**调任何外部 API（无 Sheets / GSC / Anthropic call；day-1 子进程有自带的）
- [ ] **不**修改 manifest / 任何文件（只读 + 只写报告）
- [ ] smoke test：每 gate 各 1 个 PASS + 1 个 FAIL fixture；day-1 child forwarding 1 个

---

## §7 不做（边界）

- ❌ **不**做 v2 复杂判决档（Lynne 4-tier trigger 表 plan §6.7.2）——v1 只 binary check
- ❌ **不**调 GSC / GA4 API 直接读 KPI——v1 信 manifest 字段（Ops/wzb 手填 / 后续 cron 自动填）
- ❌ **不**重写 day-1 的 5 check 逻辑——child process 转发（避免双源漂移）
- ❌ **不**自动切 §1B 或自动 trigger Lynne——决策权在 wzb / Lynne（plan §1.4 + §6.6 + §6.7.2 已锁）
- ❌ **不**发 IM / 邮件通知——wzb 手跑 + LOOK
- ❌ **不**写 Sheets / 不动 git / 不动 manifest（继承 day-1 红线）
- ❌ **不**做 cron——wzb 主动跑（避免 timing race）

---

## §8 Verify after ship（dry-run）

```bash
# day-1 转发（manifest 不存在 → exit 2）
node tools/scripts/gg-gate-check.mjs --gate day-1 --manifest /tmp/nope.json --skip-infra --out /tmp/r.md
# expect: exit 2 + child stderr "manifest not found"

# weekly PASS
echo '{"wzb_hours_this_week":16.5,"articles_published_this_week":2,"ops_hours_this_week":5.5}' \
  > /tmp/w.json
node tools/scripts/gg-gate-check.mjs --gate weekly --manifest /tmp/w.json --out /tmp/r.md
# expect: exit 0 + "3/3 PASS"

# day-30 FAIL (Top 10 < 3)
echo '{"day30_top10_count":2,"day30_ai_citation_count":4,"lynne_day30_signoff_at":"2026-06-20T10:00:00+08:00"}' \
  > /tmp/d.json
node tools/scripts/gg-gate-check.mjs --gate day-30 --manifest /tmp/d.json --out /tmp/r.md
# expect: exit 1 + "2/3 FAIL"
```

---

## §9 与 RACI v1 的链接

| RACI 项 | 关联 |
|---------|------|
| §6 P1-2 | 本 spec 是 P1-2 "ship `bin/gg-gate-check --gate weekly|vertical-slice|day-1|day-14|day-30|day-60`" 的实现 reference |
| §6 P0-3 | day-1 子档复用已 ship 的 `gg-day1-gate-check.mjs`，不重写 |
| §3 S-W4-3 | day-14 gate 替代 RACI 原计划的 `bin/gg-day14-check` 独立工具 |
| §3 S-W2-W 17:00 | vertical-slice gate 自检 |
| §3 S-W6-Mon | day-30 retro gate pack 前自检 |
| §3 S-Day-60 | day-60 kill criterion 自检 |

---

## §10 给 wzb 的 30 秒读法

- 6 个判决点，一个命令：`gg-gate-check --gate <type>`
- v1 只问"数字够不够 + Lynne 是否给了答复"；复杂判决（Lynne 4 档 trigger）看报告 + plan §6.6/§6.7.2 手工决策
- 失败时报告 §C 给 plan 行号；不自动通知 / 不动 git / 不动 sheets

**一句话**：把 plan v1.1 6 个判决点收口到 30 min Claude Code 增量。v1 关掉"忘了跑 + 手工核对漂移"两个最大风险。
