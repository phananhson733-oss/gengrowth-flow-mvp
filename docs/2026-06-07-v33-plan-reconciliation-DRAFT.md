---
title: keyword-sheet v3.3 计划 × flow-mvp 实况 — reconciliation 反馈（草稿）
date: 2026-06-07
type: feedback-draft
status: draft-for-review
author: wzb
audience: 创始人（拟同步进 gengrowth-wiki）
source: docs/03-marketing/2026-06-05-keyword-sheet-v3.3-migration-collaboration.md
tags:
  - gengrowth
  - seo
  - google-sheet
  - reconciliation
---

# keyword-sheet v3.3 计划 × flow-mvp 实况 — reconciliation 反馈

> **草稿，未进 wiki。** 待 wzb 过目后再决定是否作为新文件放入 `gengrowth-wiki`（不覆盖创始人原文）。
>
> **定位（按 artifact 分归属的 SSOT 模型）：**
> - PRD / 战略 / 选题方法论 → 创始人在 wiki 主笔为准，flow-mvp 镜像消费。
> - 活表 as-built schema / 工具链行为 → **flow-mvp 为准**（这里是真实运行处）。
> - 本文档把 v3.3 计划与 flow-mvp 实况冲突的地方挑出来，供创始人据此**修订 wiki 中的 v3.3 计划**，而不是用 v3.3 去覆盖活表。

评审对象：wiki `keyword-sheet-setup.gs` v3.3 + PRD v0.8 + `2026-06-05-keyword-sheet-v3.3-migration-collaboration.md`。
总体结论：**v3.3 设计方向正确（sound），但迁移 runbook 有缺口，且与 flow-mvp 活表实况存在 schema 错位，照计划原样执行不安全。**

---

## 0. 先肯定：v3.3 的核心设计是对的

把「是否进入生产」（V 生产准入_自动 / W 手动生产准入 / X 生产准入，公式 `=IF(W<>"",W,V)`）与「生产进度」（Y 生产状态）拆开，真正修掉了旧逻辑的缺陷：旧 `DR过滤 ❌跳过` 会把高 DR/KD 但属集群骨架的 Pillar / 核心实体 / 系列母题词直接从架构里删掉。新逻辑 N 改「竞争建议」只提示不删 + `W=集群必需` 兜底，方向正确。"先复制副本、不要重跑脚本覆盖活表"的风险姿态也对。下面的问题都是在保留这个设计的前提下提出的。

---

## Part A — 活表 as-built schema 与 v3.3 canonical 的错位（flow-mvp 为准，计划需迁就）

**这是最关键的一条。** v3.3 的新增 V–AB 七列全部加在**关键词主表**（不是选题登记表）。但 flow-mvp 的活表主表（线上同一张表 `1CkjOC…`，约 600 行数据）的 V–Y 区**已经被占用且与 canonical 完全不同**：

| 列 | flow-mvp 活表实况（as-built） | wiki v3.3 canonical 想要 |
|---|---|---|
| V (22) | 内容状态 | 生产准入_自动 |
| W (23) | 发布URL | 手动生产准入 |
| X (24) | 备注 | 生产准入 |
| Y (25) | **cluster_id**（flow-mvp 工具自行追加，canonical 主表根本没有这列） | 生产状态 |
| Z (26) | — | page_id |
| AA (27) | — | 发布URL |
| AB (28) | — | 备注 |

**后果：**

1. **迁移说明 §3「在 U 列后插入 V–AB」的前提不成立。** 它假设活表是干净的 canonical A–U；但 flow-mvp 活表 V/W/X 已是 内容状态/发布URL/备注，Y 是 cluster_id。直接"在 U 后插入"会与既有列碰撞，或把新 V/W/X 公式接到错误的源列，全表算出"看似合理实则错误"的生产准入。
2. **真冲突：`tools/scripts/gg-keyword-promote.mjs` 硬编码把 cluster_id 写主表 `Y` 列**（`MASTER_CLUSTER_ID_COL = 'Y'`）。而 v3.3 的 Y = 生产状态。迁移后这两者直接撞车——要么 promote 把 cluster_id 写进生产状态列，要么 Y 列的生产状态下拉/数据被覆盖。
3. **§3 step 4 的旧字段映射对不上 flow-mvp。** 计划写"旧 发布URL→AA、旧 备注→AB"，但 flow-mvp 活表的 发布URL 在 W、备注 在 X（不是 canonical 位置），且计划完全不知道 flow-mvp 多了个 cluster_id@Y。

**给创始人的请求：** v3.3 迁移说明里需要为 flow-mvp 活表加一段**专属列 reconciliation**——明确 flow-mvp 活表当前 V/W/X/Y 实际是什么、cluster_id 迁到哪、旧 内容状态/发布URL/备注 各自落到新 Y/AA/AB 的哪一格，再谈"插列"。这部分以 flow-mvp 实况为准。

---

## Part B — v3.3 计划/文档自身的 runbook 缺口（创始人在 wiki 内修订）

| 级别 | 问题 | 建议修订 |
|---|---|---|
| **HIGH** | §4「创始人负责处理有争议的意见」**整节空白**。但 §5 任务模板与 §6 验收都把最重要的判断（高 DR Pillar 词）汇到这里。 | 补：(a) 输入=§5 迁移报告争议清单；(b) 固定周转（如报告送达 1 个工作日内）；(c) 决策写回该行 AB 备注（最终 W 值 + 一句原因）；(d) 兜底默认——Pillar/核心实体词拿不准时默认 `W=集群必需`，绝不判无关。 |
| **HIGH** | `.gs` 文件内部自相矛盾：v3.2 changelog（行 13-14）仍写"V=生产状态、🧩生产候选视图按 V 筛"，但 v3.3 实现是 V=3值准入（行 290）、视图**按 X 筛**（行 606）。 | 把 .gs 的 v3.2 changelog 标注"已被 v3.3 取代"，或删去 V=生产状态/视图按 V 的措辞；只保留 v3.3 header + X-based 视图为权威。 |
| MED | `N=待填`（G/I 的 DR 没填）→ V 公式自动判「暂缓」→ 被 🧩生产候选 排除（视图只收 可生产/集群必需）。 | 迁移加一步：统计 N=待填 的行数并确认其中没有 P0/Pillar 词；或让 V 区分"待填(缺数据)"与"暂缓(竞争性延后)"。§5 模板加一项"有多少词只是因 DR 没填而被判暂缓"。 |
| MED | 旧 ❌跳过 要求逐行人工判，无数量估算/时间盒/批处理。 | 迁移前先 count 旧 ❌跳过 行数并时间盒；NEGATIVE_KEYWORDS 命中→自动 无关，DR-only-高→留空让 V 处理，只对候选 Pillar 集逐行人工。复用 PRD §7.3.2 的"一次性扫桶"框架。 |
| MED | §6 验收是定性断言，不是可跑 query；P0 集群没列清单。 | 每条改成 query+期望计数：如 `FILTER X=可生产\|集群必需 返回 N 行，抽查 10`；`每个 P0 集群（列清单，PRD §9.1 有）确认 ≥1 行 W=集群必需 且 page_role=Pillar`；`0 行 O=❌无关 但 X=可生产`。 |
| MED | 活表插列无 layout diff；§3 step1（复制副本）与 step3（在现有表插列）互相矛盾；无冻结窗口/无回滚。 | 二选一并写清：(a) 副本只作回滚快照，迁移在活表原地+冻结窗口进行；或 (b) 副本变新主表、窗口内增量 merge。明确：谁停产、停多久、同窗口编辑如何对账；插列前先 diff 活表 A–U 实际表头 vs v3.3 表头；插列前快照=回滚件。 |

---

## Part C — flow-mvp 侧待办（本仓内，**仅在活表真正迁 v3.3 时**才动）

> 以下脚本改动**依赖活表迁移决策**，本次只同步了本地镜像规格，未动任何脚本。

1. **`gg-keyword-promote.mjs`**：cluster_id 写 `Y` 与 v3.3 `Y=生产状态` 冲突——迁移时要么 cluster_id 改写到别的列，要么这条逻辑改成按表头名解析目标列（别再硬编码 `Y`）。
2. **`gg-queue-build.mjs`**：v3.2 `DR过滤→竞争建议` 改名会让 `dr_filter` 字段变空（仅信息列、不 gate 选择，非阻断）——加 `竞争建议` 别名即可；并建议开始消费新的 `X 生产准入` gate，让队列反映人工准入。
3. **`gg-sheet-pull.mjs`**：抓取范围 `A:Z`（26 列）会截断 v3.3 主表 AA/AB——拓到 `A:AB`。
4. **`lib/_workbook-spec.mjs`**：本地 canonical schema 仍是 v3.1（主表表头含 `DR过滤`、25 列止于 cluster_id）——需跟到 v3.3（N→竞争建议、主表 A–AB、新增 🧩生产候选 视图）。注意它驱动 `gg-sheet-to-brief` 的 fix-col 字母，不更新会让"修单"指错列。
5. **不受影响（已核实，勿误改）**：`gg-content-draft.mjs` 读的是**选题登记表** V/W=author，v3.3 不动选题登记表结构 → 安全。`gg-sheet-to-brief` / `gg-sheet-audit` 全按表头名 join，抗插列稳健。
   - （flow-mvp 内部另有一处需单独清理：`_workbook-spec` 把选题登记表 V 建模为 `target_keyword_zh`，而 `gg-content-draft` 把 V 当 author——这是 flow-mvp 自身的列定义不一致，与 wiki v3.3 无关，单列跟进。）

---

## 建议的"迁移前置检查清单"（可直接并入 wiki §3 之前）

- [ ] 导出活表 `1CkjOC…` 当前快照（=回滚件）。
- [ ] diff 活表关键词主表实际表头 A–U(及 V–Y) vs v3.3 表头；产出列对照表。
- [ ] 明确 flow-mvp 的 cluster_id@Y、内容状态@V、发布URL@W、备注@X 各自迁到 v3.3 的哪一列。
- [ ] count 旧 ❌跳过 行数 + 其中 N=待填 行数；标出 P0/Pillar 候选。
- [ ] 声明冻结窗口（谁停产、多久）与同窗口编辑对账方式。
- [ ] 迁移后跑 §6 的 query 式验收（含 P0 集群 Pillar 检查）。
- [ ] 活表稳定后再改 Part C 的脚本。

---

*本草稿由 flow-mvp 评审产出，结论已对照 wiki v3.3 .gs / PRD v0.8 / 迁移说明 + flow-mvp `lib/_workbook-spec.mjs`、`gg-keyword-promote.mjs`、`gg-content-draft.mjs`、`gg-queue-build.mjs` 源码核实。*
