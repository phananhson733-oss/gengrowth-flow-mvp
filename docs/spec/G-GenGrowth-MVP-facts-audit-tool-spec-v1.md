---
title: GenGrowth MVP — /gg-facts-audit 工具 spec v1
date: 2026-05-21
type: tech-spec
author: wzb
status: draft (W0 PM 1.5h ship 后 wzb 验收参考)
version: v1.0
tags:
  - gengrowth
  - mvp
  - facts-audit
  - tool-spec
aliases:
  - facts audit spec
  - automated diff binary
related:
  - "[[G-GenGrowth-MVP-RACI-and-execution-flow-v1]]"
  - "[[G-GenGrowth-MVP-落地plan-v1.1]]"
  - "[[G-GenGrowth-MVP-keyword-fallback-tool-spec-v1]]"
  - "[[G-GenGrowth-MVP-day1-gate-check-tool-spec-v1]]"
review_trail:
  - "2026-05-21 v1.0 — 落地 plan §2.4.2 L288-343 facts-audit.md 的 binary 自动化版本，把 5 条预写断言改成 automated diff（不再 human-judgment 5 份 JSON 对照）"
---

# /gg-facts-audit 工具 spec v1

> [!info] 这是什么
> 把 plan §2.4.2 的 "facts-audit.md 5 条预写断言" 改成 **automated binary diff**。
> 每条断言 binary pass/fail；CRITICAL 任一 fail → 退出码 1 + wzb 必看 + Week-2 工程 stop。
> wzb 在 W1 Fri gate 之前手跑一次，30 秒看 §A 主结论就够。

---

## §1 30 秒读完

**输入**：facts-audit 配置 YAML（首次跑自动建模板）+ oracle src dir + Sheets `cta_map` / `keyword_candidates` / `runs` tab + GSC 7d top queries
**输出**：5 条断言 binary 报告（CRITICAL/HIGH/INFO 三级），markdown 写到 `~/.gg-cache/facts-audit-<date>.md`
**wzb 工作量**：30 秒看 §A 结论；FAIL 时看 §B 5 行表 + §D 行动建议
**Ship 时机**：W0 PM（RACI v1 §6 P0-1）

---

## §2 5 条预写断言（plan §2.4.2 L299-343 落地）

| # | 断言 | severity | 失败动作 |
|---|------|----------|---------|
| 1 | oracle `trackEvent` ⊇ PRD §3.1/§4.1 expected events | CRITICAL | Week-2 工程 stop，先修 oracle 埋点 |
| 2 | Sheets `cta_map!E:E` ⊆ oracle `trackEvent` | CRITICAL | Week-2 工程 stop，先修 cta_map 或 oracle |
| 3 | Sheets `keyword_candidates!1:1` 表头 == 11 列固定 schema | HIGH | 允许 Week-2 开工，Week-3 ship 前必须修 |
| 4 | `pii_blacklist` 关键词全部不在 GSC 7d top queries 中 | CRITICAL | Week-2 工程 stop，先重跑 GSC export sanitizer |
| 5 | GSC observed queries vs PRD expected events | INFO | 只记账，cold-start empty 也 pass |

**断言 #1 / #2 graceful skip**：oracle src 路径不存在时退化为 INFO（不算 fail），报告写明 `oracle source not found`。

---

## §3 实现细节

### 3.1 oracle trackEvent 扫描

> [!warning] AST 方案选择：**B. 正则**（MVP 够用）
> 不引 acorn / babel npm 依赖，符合工具栈 "Pure Node 内置 only" 约定。
> **已知盲区**：`trackEvent(varName)` 动态调用扫不到。工具会单独统计可疑动态调用数 + 列前 10 处文件路径，wzb 在报告 §C 看到后人工 review。
> 若后续 oracle 大量使用 enum-driven 动态 event name，再升级到 acorn AST parse。

正则：
```
/\btrackEvent\s*\(\s*['"`]([A-Za-z_][A-Za-z0-9_.-]{0,80})['"`]/g
```

扫描范围：
- 文件扩展名：`.ts` / `.tsx` / `.js` / `.jsx`
- 跳过：`node_modules` / `.next` / `dist` / `build` / `.git`
- 单文件 size 上限 2MB；总文件数上限 5000（防失控）

oracle src 路径探测顺序（首个存在即用）：
1. `--oracle-src` CLI 指定
2. `~/oracle/src`
3. `~/gengrowth/oracle/src`
4. `~/Code/oracle/src`
5. `~/Code/oracle`

### 3.2 Sheets reader

- SA：`~/.config/gg/gg-reader-sa.json`（reader scope，复用 day1-gate-check 同款）
- scope：`spreadsheets.readonly`
- 读 2 个 range：
  - `cta_map!E:E` — 跳过 header 行（"event" / "event_name" / "ga4_event"）+ identifier 正则过滤
  - `keyword_candidates!1:1` — 与 `EXPECTED_KEYWORD_HEADERS` 11 列做严格 ordinal diff

### 3.3 GSC reader

- 同款 reader SA + `webmasters.readonly` scope
- query：`searchAnalytics/query` 7 天 top 25 queries
- 用途：
  - 断言 #4：grep `pii_blacklist` 关键词（case-insensitive substring）
  - 断言 #5：纯 INFO 记账

### 3.4 config 文件 `facts-audit.yml`

首次跑自动写模板到 `~/.gg-cache/facts-audit.yml`：

```yaml
expected_events:
  - newsletter_submit_success
  - newsletter_submit_attempt
  - cta_click
  - article_view
  - signup_click

pii_blacklist:
  - email
  - "@gmail.com"
  - phone
  - "tel:"
  - "ip:"
  - raw_gsc_query
```

wzb 修改后下次跑即生效。**不要 commit 到 git** 如果内含产品私有事件名。

### 3.5 退出码

| 退出码 | 含义 |
|--------|------|
| 0 | 全 pass（含 HIGH/INFO fail，但 CRITICAL 全过；status=ok 或 partial） |
| 1 | 任一 CRITICAL fail（status=fail） |
| 2 | fatal（config IO 错 / 报告写盘失败） |

> [!warning] severity 行为表
> - **CRITICAL fail** → 退出码 1 + 报告 §A 标红 + §D "不要 ship /gg-keyword-mine"
> - **HIGH fail** → 退出码 0 + 报告 §A 标黄 "Week-3 ship 前必修"
> - **INFO fail** → 退出码 0 + 仅记账

---

## §4 wzb LOOK 节点（30 秒）

W1 Fri 17:00（或 W0 ship 后）手跑一次：

```bash
node tools/scripts/gg-facts-audit.mjs
```

打开 `~/.gg-cache/facts-audit-<date>.md`：
1. 看 §A 主结论（PASS / PARTIAL / FAIL 一行字）
2. PASS → 关掉，进 W1 plan
3. PARTIAL → 看 §B HIGH 行，记到 W3 待修清单
4. FAIL → 看 §B CRITICAL 行 + §D 行动建议；**不要 ship `/gg-keyword-mine`**

---

## §5 Ship checklist（W0 PM Claude Code）

- [x] `tools/scripts/gg-facts-audit.mjs` 入口脚本（≤700 行，纯 Node 内置）
- [x] `tools/scripts/__tests__/gg-facts-audit.smoke.test.mjs` 32 测试覆盖 5 断言 × pass/fail + sandbox oracle dir 扫描 + YAML reader + redact 复用 + errorCode 映射
- [x] 复用 `gg-keyword-fallback.mjs` 同款 `loadEnv` / `getAccessToken` / `gFetch` / `redact` / `errorCode`
- [x] config YAML 不存在时自动写模板（含 5 默认 expected_events + 6 默认 pii_blacklist）
- [x] oracle src 未找到时 #1/#2 graceful skip → INFO
- [x] `--dry-run` / `--skip-network` flag 支持
- [x] runs 表 append：`runs!A:G` 写 `[ts, 'facts-audit', '', 5, sev_summary_json, status, redacted_notes]`
- [x] secret redact：所有 console.log + 报告 §B evidence 列过 redact

---

## §6 不做（明确边界）

- ❌ 不调任何 LLM API（5 条断言全 binary，不需要 human judgment）
- ❌ 不写 oracle / 不动 cta_map（只读，diff 出来后给 wzb 人工修）
- ❌ 不跑 cron（W0 一次性 ship，W1 Fri / W3 Fri 前手跑）
- ❌ 不爬任何第三方（GSC / Sheets 走 Google 官方 API）
- ❌ 不替代 Tech §4 GEO 取向 cluster check（那是 `/gg-keyword-mine` 的事）

---

## §7 Verify after ship

W0 ship 后立刻 dry-run 一次验证：

```bash
# offline smoke（不调任何 API）—验证断言逻辑 + 报告写盘
node tools/scripts/gg-facts-audit.mjs --skip-network --dry-run

# online smoke（实跑全 5 断言；需先配 _gg.env + gg-reader-sa.json + GG_SHEETS_WORKBOOK_ID + GG_GSC_SITE）
node tools/scripts/gg-facts-audit.mjs --dry-run

# 完整跑（写 runs 表）
node tools/scripts/gg-facts-audit.mjs
```

**accept 标准**：
- offline smoke 退出码 0 或 1（不应该是 2 = fatal）
- online dry-run 5 条断言全部有 PASS/FAIL 结论（不允许 "断言执行失败" 这种 fatal）
- 报告 §A 主结论 1 行字 wzb 30 秒能读懂

---

## §8 与 plan / RACI 的链接

| 来源 | 关联 |
|------|------|
| plan §2.4.2 L288-343 | 5 条预写断言 spec，本工具是落地实现 |
| plan §2.4.2 L307 | "CRITICAL 失败 → Week-2 工程 stop，不允许 ship /gg-keyword-mine" |
| RACI v1 §6 P0-1 | W0 PM 1.5h 任务定义，本 spec 是交付物 reference |
| `gg-keyword-fallback.mjs` | 复用 helpers（env / JWT / redact / errorCode）+ runs 表 append 同表结构 |
| `gg-day1-gate-check.mjs` | 复用 reader SA pattern + markdown 报告渲染同型号 |

---

## §9 给 wzb 的 30 秒读法

- 你不用懂 §3 实现细节，那是给 Claude Code 看的
- 你要懂的就一句：**W1 Fri 之前手跑一次 `node tools/scripts/gg-facts-audit.mjs`**，看报告 §A 一行字
- PASS → 继续 W1 plan；FAIL → 不要 ship `/gg-keyword-mine`，等修完 CRITICAL 再说
- config 在 `~/.gg-cache/facts-audit.yml`，期望事件名 + PII 黑名单都可自己改
