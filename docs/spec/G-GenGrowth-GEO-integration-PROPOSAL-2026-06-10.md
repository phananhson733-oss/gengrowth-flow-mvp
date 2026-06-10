---
title: GEO 融合进 flow-mvp 流水线（提案）
date: 2026-06-10
type: spec
status: proposal
tags: [workflow, geo, phase2, queue-build, autopilot, proposal]
---

# GEO 融合进 flow-mvp 流水线（提案 — 待 wzb 确认）

> 背景：用户拍板「GEO 流程以 gengrowth-geo 仓为主，融合 flow-mvp；不与既有 SEO 内容重叠/冲突是第一约束；GEO 侧用 Sheet 副本（`1UaTxBQNdgeSomL6qlNJZMSRxovsSL5SasyWmuO5ny7M`）」。
> 本文是**提案**，不是已落地。实施窗口 = astrologywiki B 轨复测窗收口（≈2026-06-22）之后。
> 设计真相在 geo 仓：`gengrowth-geo/docs/00-design/2026-06-10-flow-mvp-geo-integration.md`；数据底座：`gengrowth-geo/_staging/sheet-mapping/astrologywiki/`。

## 现状：流水线对 AI 搜索可见性（GEO）是零感知

- 现有 "GEO score"（`gg-keyword-mine.mjs:computeGeo`）是关键词层 AIO 风险分，**不是生成式引擎优化**。
- 生成端无 citability 要求：geo 仓审计实测 astrologywiki 16 个目标页 **statistics=0、外链引用 0-3**——GEO 文献（Aggarwal KDD2024）实证的两个最强引用杠杆全缺。基线采样 114/114：AI 引擎对本站提及率 0%、引用 0。
- 查重单源：RL3 只查 SERP 抄袭；选题查重只对 Sheet 台账。**实证盲区**：选题登记表 PG-AURA-009 "aura reading" 标`待写`，而 oracle `data/articles/aura-reading.ts` 已上线——规划者不知道页面存在。该风险与 GEO 无关，纯 SEO 流程今天就会产重复页。

## 改动点（5 个，全部零 npm 依赖，沿用现有 config-snapshot 阈值机制）

### 1. render：v8 prompt 注入 GEO 杠杆块

fixture 新增 `geo_brief` 字段（由 brief/override 链路传入），render 模板加一段硬性要求：

- 正文须含 **≥2 条带源统计数据**（具体数字 + 具名来源 + 外链），优先权威源（Pew/政府统计/百科）。
- 须含 **≥2 个权威站外引用**（非社交、非自家域）。
- **RL8 针眼**：禁止"research shows/studies prove"类模糊归因——必须"按 X（来源，链接），数字为 Y"句式。具名+链接的表述可过 RL8，模糊断言照旧被挡。两闸兼容，不豁免 RL8。

### 2. phase2：新增 RL-GEO（citability 闸）

- 移植 geo 仓 `measurement/lib/citability.mjs`（纯函数零依赖，clean-room 自公开论文推导）进 `tools/scripts/lib/`。
- 检查产出文的 statistics_count / citation_signal_count / citability_score；阈值进 Sheet `config` tab（沿用 changed_at/changed_by/rationale 惯例）。
- **先 advisory（warn 不挡）跑 2-4 周校准阈值，再转 enforcing**——避免新闸一上来误杀存量模板。

### 3. queue-build / phase2：站内查重闸（双源）

- 新增确定性检查 `lib/internal-dedup.mjs`：候选选题（queue-build 时）与产出正文（phase2 时）对 **双源**查重——① Sheet 台账（Target Keyword/Associated Keywords/page_id）；② oracle `data/articles/` 全集（slug 短语 + 标题 n-gram 重叠）。
- 超阈值 → 挡下标 `needs_human`，不自动改写、不自动跳过（报告而非裁决）。
- 这是对 RL3（只查 SERP）的盲区补位，防站内自我蚕食。

### 4. autopilot / 手工编辑：page-lock 检查

- geo 仓产物 `gengrowth-geo/_staging/sheet-mapping/astrologywiki/page-lock.json`（schema `page-lock/1`）列出干预窗锁定页（当前 16 页：4 treatment + 4 control + 8 global control）。
- autopilot `doScan` 在 convert 前、以及 `gg-md-to-oracle-ts` 落盘前检查：目标 slug 在锁内 → 跳过并记 park 原因；产出内容含指向锁内页的**新增**站内链 → 挡下。
- 锁窗解除 = geo 仓更新 page-lock（人工动作，复测收口后）。

### 5. Sheet 副本：`source=geo` 注册约定

- GEO 诊断产生的新内容需求由 geo 仓写入 **Sheet 副本**选题登记表（新增 `source` 列，值 `geo`），不直写生产表。
- 人工 review 副本条目 → 合格者由人搬入生产表进 queue-build。副本→生产表**不自动同步**。

## 待 wzb 裁决：4 条已实证的选题冲突（geo 仓 mapping.md 全量回溯）

| # | Sheet 侧 | 冲突 | 建议 |
|---|---|---|---|
| 1 | **PG-MAHADASHA-005 "shani mahadasha" 待写** | Shani = Saturn 梵文名 → 与 saturn-mahadasha（**B 轨 treatment 页**，6-08 刚干预上线）同主题 | **不另写新页**：重指既有页作 update（窗后），或 defer。另写 = 站内蚕食 + 污染复测 |
| 2 | PG-AURA-009 "aura reading" 待写 | oracle `aura-reading.ts` 已上线（geo global control） | 重指既有页作 update（窗后） |
| 3 | PG-EMPATH-005 "HSP Books Ranked"（backlog） | HSP 簇领地，意图与既有页不同 | 可作新内容放行；窗内不得新增指向锁定页的站内链 |
| 4 | PG-EMPATH-007 "HSP Debunked?"（backlog） | 同上 | 同上 |
| 5 | **PG-VEDIC-003 "vedic birth chart calculator online free" 待写** | oracle `vedic-birth-chart-calculator.ts` 已上线（非 geo 页，纯 SEO 侧自我蚕食） | 重指既有页作 update，或合并进 -004 一并裁 |
| 6 | **PG-VEDIC-004 "best vedic birth chart calculator" 待写** | 同上 | 同上 |

> 低优先（仅提示）：PG-HEAL-005 "Pluto in the 6th House" 与既有 `6th-house-astrology.ts` 词面相邻，但 placement 专题与宫位总览意图不同，按新内容处理即可。

## 实施排期与边界

- **≈6-22（B 轨复测窗收口）前**：只落本 spec + page-lock 消费约定，**不改流水线代码**；站级修复（FAQPage/WebSite schema/Person 署名/llms.txt，geo 仓 fix-tickets 在手）同样压到窗后。
- **窗后**：按本文 1→5 顺序小步实施，每步独立可验（`node --test` + 1 篇真实产出过闸）。
- **边界**：geo 仓不直改本仓代码（本文即交接物）；测量数字只出自 geo 确定性脚本；M1/B 轨页面的内容生产不进本流水线的自动改写。

## 风险与未决

1. **citability 阈值未校准**：先 advisory。阈值定错会误杀正常文或放水——校准期对照 geo 仓 audit 的 cohort 分布定初值。
2. **internal-dedup 误报**：同簇系列文（如 12 篇 house 系列）天然词面相近，阈值须按"标题+slug 短语"窄口径起步，n-gram 宽口径只 warn。
3. **page-lock 时效**：锁清单由 geo 仓人工维护，若复测一再延期会长期锁 16 页——锁文件里已写明解除条件（w-after1 收口），到期不解除须显式说明原因。
4. **Sheet 副本漂移**：副本是 6-07 快照迁移，与生产表会渐行渐远；GEO 注册条目搬运前人工核对生产表当前状态。
