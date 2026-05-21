---
title: GenGrowth MVP · Week-1 第 1 篇 standard-setting 选题 brainstorm 模板
date: 2026-05-20
type: tech-template
author: wzb
status: template
tags:
  - gengrowth
  - mvp
  - keyword-brainstorm
  - geo
aliases:
  - W1 standard-setting brainstorm
  - W1 选题模板
related:
  - "[[G-GenGrowth-MVP-落地plan-v1.1]]"
  - "[[G-GenGrowth-MVP-半自动化工具栈方案-v1.2-lean]]"
  - "[[G-GenGrowth-MVP-OpsPM-PRD-v1.2-lean]]"
---

# W1 第 1 篇 standard-setting 选题 brainstorm

> [!info] 为什么需要这个模板
> Week-1 时 `/gg-keyword-mine`（Tech §4.1）还没 ship（Week-2 才 ship）。  
> 但 plan §2.4.1 要求 Week-1 Mon-Tue 8h 必须产出第 1 篇 standard-setting 精修（树质量基线）。  
> 所以 W1 第 1 篇的选词是**人工版 `/gg-keyword-mine`**：用同样的 GEO 评分公式，工具靠手 + AI 辅助，跑出 1 个新题。

> [!warning] 红线
> - **不动 5 篇精选**（用户决策 2026-05-20）— 这 1 个题必须是**全新发**，不重写老文。
> - 选定后，第 1 篇精修必须满足 plan §2.4.1 的 5 件事：Entity Passport ≥6 源 + Friction ≥3 真 quotes + Phase 1 schema.org 三类 + 跨模型挑战 ≥3 objection + Perplexity-引用-自检。
> - 题目敲定 = W1 Mon 开工有方向。**Day-0 跑完此模板，Mon morning 不再纠结选题。**

---

## §0 这份模板怎么用

| 步骤 | 工时 | 谁做 | 工具 |
|------|------|------|------|
| Step 1 — 填 §1 输入 metadata | 10 min | wzb | 手工 |
| Step 2 — 跑 §2 种子词扩展（10-20 个候选） | 20-30 min | wzb + AI 辅助 | brainstorm + DataForSEO Labs UI（可选）|
| Step 3 — 跑 §3 GEO 机会评分（每个候选 4 列） | 60-90 min | wzb 手工 | Google + AI Overview 检视 + Reddit/Quora `site:` 搜 + Google Trends |
| Step 4 — §4 排序 Top 5-8 + 决策表 | 10 min | wzb | 算公式 |
| Step 5 — §5 wzb 拍板 1 个 + §6 Entity Passport 角度预判 | 20 min | wzb + AI 辅助 | 思路框架 |
| **合计** | **~2-2.5h** | — | — |

预计在 Day-0（plan §1.1）当天跑完。Mon morning 直接进入 Entity Passport 取证（§4.2 Phase 1）。

---

## §1 输入 metadata（wzb 填）

### 1.1 Product / Domain 基线

```yaml
product: astrologywiki.com
product_dimension: astrology, wellness, self-discovery   # Tech §4.1 例子的 --dimension
country: US
audience_lang: en
audience_persona: |
  (1-2 句话描述目标读者：年龄、占星熟悉度、痛点、寻找什么内容)
content_pillar_to_extend: |
  (这 1 篇 standard-setting 想立的内容支柱主题。例如 "occult-knowledge entity authority" / "transit-event timing reliability" / "synastry compatibility methodology")
```

### 1.2 5 篇精选（baseline，不动；仅作领域信号参考）

| # | 标题 | 主关键词 | 当前 SERP 位次 | Cluster |
|---|------|----------|----------------|---------|
| 1 | (填) | (填) | (填) | (填) |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |

> 用法：这 5 篇是"领域已经走通的题"——选 W1 新题时**优先选与这 5 篇同 cluster 但还没覆盖的 GEO 取向子题**（不是另开新 cluster），让权威信号叠加而不是分散。

### 1.3 GEO 取向 hard 约束（v1.2-lean2 §1.1）

每个候选词必须同时满足（任一不满足 → 直接砍）：
- [ ] **真问题**：Reddit OR Quora 过去 90 天 ≥1 条 ≥10 upvote 的真讨论
- [ ] **可建权威**：astrologywiki 已有 5 篇精选中至少 2 篇语义相关（不孤儿）
- [ ] **不是已死战场**：SERP Top10 的 DR 中位数 < 60（Tech §4.1 Phase 3 阈值）
- [ ] **不是 AI Overview 已统治**：若 SERP 已出 AI Overview 卡片，必须留有"细节缺口"可以做更深内容

---

## §2 种子词扩展（10-20 候选）

### 2.1 brainstorm 路径（wzb 手 + AI 辅助）

跑 3 条路径，各出 4-7 个种子，并集去重得 10-20 候选：

**路径 A — 痛点反推**
- 问 ChatGPT / Claude：「面向 [audience_persona]，关于 [content_pillar_to_extend]，他们在 Reddit/Quora 最常吐槽什么？列 7 个具体问题，每个一句话。」
- 把每个问题压缩成 2-5 词 keyword 候选。

**路径 B — 5 篇精选的衍生子题**
- 对 §1.2 每篇精选，问自己：「这篇文章读完后，读者最可能继续搜什么？」每篇出 1-2 个衍生候选。

**路径 C — AI Overview 缺口探测**
- 手动 Google 5-8 个高搜索量种子词，看哪些 SERP 已出 AI Overview 但回答**浅或错或缺案例**——这些是 "AI 已圈地但内容稀薄" 的窗口。

### 2.2 候选清单（填表）

| # | 种子词候选 | 路径来源 (A/B/C) | 直觉判断（强/中/弱机会） |
|---|-----------|-----------------|----------------------|
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |
| 5 | | | |
| 6 | | | |
| 7 | | | |
| 8 | | | |
| 9 | | | |
| 10 | | | |
| ... | | | |

---

## §3 GEO 机会评分（每个候选 4 列）

对 §2.2 的每个候选，跑下表 4 列。**每列工具+判定**严格按 Tech §4.1 Phase 描述：

### 3.1 评分表（人工版 `/gg-keyword-mine`）

| # | 种子词 | (a) SERP Top10 DR 中位数 | (b) AI Overview 状态 | (c) Reddit/Quora 真讨论数 | (d) Trends 趋势（12 mo）| GEO 机会分 |
|---|-------|-------------------------|---------------------|--------------------------|------------------------|-----------|
| 1 | | | | | | |
| 2 | | | | | | |
| ... | | | | | | |

### 3.2 每列怎么填

**(a) SERP Top10 DR 中位数**（弱度判，Tech §4.1 Phase 3）
- 手动 Google 该关键词 → 看 Top 10
- 每个域用 Ahrefs Free Site Explorer 或 Moz Link Explorer 查 DR/DA
- 取中位数
- 写: 数字 + ✅弱(<40) / ⚠️中(40-60) / ❌强(>60)

**(b) AI Overview 状态**（lean2.1 升级，Tech §4.1 Phase 4）
- 手动 Google 该词 → 看是否出 AI Overview 卡片
- 写: `none` / `present-shallow`（卡片浅，可深挖）/ `present-saturated`（卡片已饱和，难突围）
- 仅 `none` 和 `present-shallow` 可入选

**(c) Reddit/Quora 真讨论数**（GEO hard 约束）
- 手动 Google `"[seed]" site:reddit.com` 过去 1 年
- 同样 `site:quora.com`
- 写: 两数相加 + 最高分 thread 的 upvote 数。例: `r:12+q:5 / max-upvote:340`

**(d) Trends 趋势**（Tech §4.1 Phase 4 季节性）
- Google Trends → 12 个月该词
- 写: `up`（明显上升）/ `flat` / `down` / `seasonal-rising`（季节性但峰值在涨）/ `seasonal-flat`

**GEO 机会分**（Tech §4.1 Phase 5 公式）
```
score = (弱度分 + 1) × (讨论分 + 1) × (Trends 分 + 1)
弱度分:    ✅=3,  ⚠️=1,  ❌=0
讨论分:    >20=3,  10-20=2,  5-10=1,  <5=0
Trends 分: up=3,  seasonal-rising=2,  flat=1,  其他=0
```
分数 ≥7 = GEO 机会词（Tech §4.1 验收阈值同步）。

---

## §4 Top 5-8 + 决策表

排序 §3.1 全表，取分数前 5-8。

### 4.1 Top 候选决策表

| 排名 | 种子词 | GEO 机会分 | (a)弱度 | (b)AIO | (c)讨论 | (d)Trends | hard 约束 4 项全过？ |
|------|-------|-----------|---------|--------|--------|-----------|---------------------|
| 1 | | | | | | | ✅/❌ |
| 2 | | | | | | | |
| 3 | | | | | | | |
| 4 | | | | | | | |
| 5 | | | | | | | |

> [!warning] hard 约束 任一 ❌ → 删除候选
> §1.3 的 4 项 hard 约束**任意一项**不满足，直接从决策表里删掉，**不要纠结分数**——分数高但 hard 约束失败，是 selection 陷阱（Tech §4.1 验收警告）。

---

## §5 wzb 拍板 1 个

### 5.1 选定词

```yaml
chosen_keyword: ""            # 1 个，2-5 词
geo_score: 0                  # 必须 ≥7
serp_top10_dr_median: 0       # 写实际数字
ai_overview_status: ""        # none / present-shallow
reddit_quora_signal: ""       # r:N+q:N / max-upvote:N
trends_trajectory: ""         # up / seasonal-rising / flat
hard_constraints_check:
  real_problem: false         # ≥1 条 ≥10 upvote
  buildable_authority: false  # ≥2 篇精选语义相关
  not_dead_battleground: false # DR median < 60
  has_aio_gap: false          # AIO 不饱和
chosen_cluster: ""            # 与 §1.2 哪几篇精选同 cluster
```

### 5.2 选定理由（一句话）

> 写下选这个词的核心理由（≤30 字），后续 Day 30/60 retro 用来检查"当初的假设是否成立"。

---

## §6 Entity Passport 角度预判（W1 Mon 开工铺垫）

按 Tech §4.2 Phase 1 — Entity 搜证要求 ≥6 源 + 5 角度。Day-0 预想这 5 个角度，给 Mon 开工省 ~1h。

### 6.1 5 角度预判模板

| 角度 | 该词在这个角度的可发声点 | 预想 1-2 个源（域名+大致 URL）|
|------|-------------------------|-------------------------------|
| 1. 定义 / 词源 | (该词的精确定义；非占星读者怎么理解) | |
| 2. 历史脉络 | (这个概念什么时候出现；演化路径) | |
| 3. 当代实践 | (现在主流社群怎么用；分歧在哪) | |
| 4. 实证 / 反驳 | (是否有研究 / 科学共识 / 民间观察反例) | |
| 5. 文化对照 | (西占星 vs 印度占星 vs 中国占卜的对照) | |

### 6.2 6 源候选（按 §1.3 sanitizer allowlist 域名）

依 Tech §4.2 Phase 1.4 sanitizer：subdomain 严格匹配。

| # | 源类型 | 候选域名 | 用于 §6.1 哪个角度 |
|---|--------|---------|-------------------|
| 1 | 学术 / 词典 | (Britannica / OED / Wikipedia) | |
| 2 | 权威媒体 | (NYT / Atlantic / The Cut) | |
| 3 | 占星行业权威 | (cafeastrology / astro.com 等) | |
| 4 | Reddit 真讨论 (subdomain 严格) | old.reddit.com OR np.reddit.com / r/astrology /r/AskAstrologers | |
| 5 | Quora 真讨论 | quora.com/q/... | |
| 6 | 自有站 5 篇精选之一 (锚定权威) | astrologywiki.com/... | |

### 6.3 Friction 取证候选（≥3 真 user quotes，Tech §4.2 Phase 1.3）

填 3 条候选 quote 来源（W1 Mon-Tue 时再抓真 quote 原文）：

| # | 出处 (URL 形态) | 大致内容（一句话）| upvote / signal |
|---|----------------|------------------|-----------------|
| 1 | | | |
| 2 | | | |
| 3 | | | |

---

## §7 输出（这份文档跑完后产出）

跑完此模板，应该有：
- [x] §5.1 chosen_keyword（W1 Mon 直接进入精修）
- [x] §6.1 5 角度初稿（Mon 上午 Entity 搜证省 ~1h）
- [x] §6.2 6 源候选清单（Mon 上午直接打开浏览器搜）
- [x] §6.3 3 条 Friction 候选（Mon 下午 Friction 取证起点）
- [x] §3 完整评分表（W1 Friday retro 时用来回看决策是否合理；为 W2 `/gg-keyword-mine` ship 提供 ground-truth 对照集）

---

## §8 W2 `/gg-keyword-mine` ship 时怎么用这份文档

`/gg-keyword-mine` MVP（Tech §4.1）ship 后，跑同一组种子（§2.2）走自动化版本，对照 §3 人工评分表：

| 对照项 | 人工版（本文档）| 工具版（`/gg-keyword-mine`）| 一致性判定 |
|-------|----------------|---------------------------|------------|
| Top 候选集合 | §4.1 Top 5-8 | DataForSEO Labs 扩+SERP 评分 Top 15 | ≥3 重合 = 工具评分基线 ok |
| DR 中位数 | §3.2 (a) 手测 | DataForSEO SERP API 自动 | 误差 ±5 = ok |
| AI Overview 状态 | §3.2 (b) 手 Google | T 列写 `未查 (预判:⚠️疑似)` (Tech §4.1 Phase 4) | 工具仅预判，本文档手测是 ground truth |
| Reddit/Quora 讨论 | §3.2 (c) 手 site: 搜 | 工具暂无 → 仍走人工 | — |

→ 这份文档**还充当 `/gg-keyword-mine` MVP 的回归基线**。W2 工具 ship 时不需要重新人工核对，直接对比即可。

---

## §9 Retro 回看（W1 Friday + Day 30 用）

W1 Friday + Day 30 retro 时回看本文档：
- §5.2 选定理由的"核心假设"是否成立？
- §3 评分中是否有候选其实更应选？
- §6.1 5 角度有没有第 7、8 角度更应该走？

记录到 plan §6.6 Day 30 retro 的输入。

---

## 相关阅读
- [[G-GenGrowth-MVP-落地plan-v1.1]] §2 Week-1 起跑路径
- [[G-GenGrowth-MVP-半自动化工具栈方案-v1.2-lean]] §4.1 `/gg-keyword-mine` GEO 取向 + §4.2 `/gg-content-draft` Phase 1 取证
- [[G-GenGrowth-MVP-OpsPM-PRD-v1.2-lean]] §1.2 GEO 取向 + §2.3 Day 60 KPI
