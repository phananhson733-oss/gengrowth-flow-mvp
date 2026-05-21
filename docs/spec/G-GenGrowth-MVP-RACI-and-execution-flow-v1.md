---
title: GenGrowth MVP — RACI + Execution Flow v1
date: 2026-05-21
type: tech-review
author: wzb
status: draft (pending wzb sign-off)
version: v1.0 (3-voice fan-out output)
tags:
  - gengrowth
  - mvp
  - raci
  - review
  - execution-flow
aliases:
  - RACI v1
  - GenGrowth execution flow v1
related:
  - "[[G-GenGrowth-MVP-落地plan-v1.1]]"
  - "[[G-GenGrowth-MVP-半自动化工具栈方案-v1.2-lean]]"
  - "[[G-GenGrowth-MVP-OpsPM-PRD-v1.2-lean]]"
  - "[[G-GenGrowth-MVP-W1-keyword-brainstorm-template]]"
review_trail:
  - "2026-05-21 v1.0 — 3-voice fan-out (Codex GPT-5 + planner subagent + architect subagent) 合并产出。不动 plan/PRD/Tech 本体，本文档是 step-level RACI 补丁。"
---

# GenGrowth MVP — RACI + Execution Flow v1

> [!danger] DEPRECATED 2026-05-21 — 整份文档 SUPERSEDED
> 本文档（RACI 8 列矩阵 + 18 gap + 50 decision compression）是企业级 over-engineering，**对 1-2 人小团队不适用**。
> 真正 canonical 文档是 Lynne 已写好的 3 份：
> - `docs/03-marketing/03-seo/keyword-research-sop.md` v2.5（六源 + 四桶 + 三关过滤 + 占星品类切入规律）
> - `docs/03-marketing/03-seo/keyword-sheet-setup.gs` v3.1（24 列关键词主表 + 6-ID 体系 + 13 张表）
> - `docs/03-marketing/2026-05-15-gengrowth-internal-growth-mvp-prd-v0.7.md`（量产线/精修线 + 主题集群 + 心理安全规则）
>
> 本文档**仅作历史参考**，不要按此执行。新的端到端 SOP 看 `G-GenGrowth-精修文章-端到端-SOP-v1.md`（待按 Lynne 三档对齐重写）。

> [!info] 本文档定位（历史快照）
> 不动方案本体（plan v1.1.2 + Tech v1.2-lean2.1 + PRD v1.2-lean2.1 保持 canonical）。
> 本文档 = **wzb "只看 + 填" 角色的 step-level 落地表**，回答 "每个时刻谁做什么/谁触发/谁验收"。
> wzb sign-off 后进 plan v1.1.3 作为 §0.3 RACI 矩阵 incorporated。

---

## §0 TL;DR（30 秒读完）

3 个核心 verdict（3 voice 独立各自 R3 review 收敛）：

| Voice | 核心发现 | 数字证据 |
|-------|---------|---------|
| **Planner** | 真实负担**不在工时，在心智 load**。W3/W4 决策密度 4h+ 吃掉 plan 给的 2h buffer 2 倍 | 50 个 wzb decision points，44 个可压缩，6 个 must-keep（全围绕"人事+关系+forcing function"）|
| **Architect** | wzb 在 **5 周中 4 周 surface count ≥7**（红色），"只看+填" 角色严重违反 | 5 周里 W1=7 / W2=8 / W3=7 / W4=7 / W5=6 surface |
| **Codex** | Owner ≠ RACI。当前 owner 表只到工具级，缺每 step 的 **Trigger/R/A/C/I/Sign-off/fallback** 维度 | 18 个 gap（5 P0 + 9 P1 + 4 P2），全文 line 引用 |

**改造收益**：5 周累计可节省 wzb 时间 **~8-12h**（相当于 W3/W4 各省一天）+ surface count 从 4 周红色降到 2 周

**改造投入**：W0 PM 加 1.5h + W1 Mon 加 1h + W1 Thu 加 30 min + W2 Wed 加 1h ≈ **4h 一次性**

**ROI ≈ 2.5x**

---

## §1 18 个 RACI Gap（按 severity）

> P0 必修 5 项 / P1 应修 9 项 / P2 可推迟 4 项
> 每个 gap 标注 3 voice agreement（✓✓✓ = 3 voice 都提到 / ✓✓ = 2 voice / ✓ = 1 voice 独家）

### P0 关键路径（5 项，本周必修）

#### G1 — facts-audit 5 断言谁实现/谁触发（W1 Wed 2h） ✓✓✓

| 维度 | 内容 |
|------|------|
| step | plan §2.4.2 W1 Wed facts-audit.md (2h) |
| 当前 owner 声明 | plan: wzb 自跑；Tech: facts-audit 脚本（未实现） |
| 真实 owner 推断 | **wzb 手工拼 AST parse + Sheets/GA4 导出 + 三档断言 diff**；无固定 CLI 入口 |
| 文档原文 | plan L97 / L293-297 / Tech L159-164 |
| 改造 | W0 PM ship `bin/gg-facts-audit --assertions facts-audit.yml`（Claude Code 出，ts-morph AST parse + GSC/GA4 API + .gs 解析 + 5 断言 diff + severity 报告）→ W1 Wed wzb 只**LOOK** report + **DECIDE** CRITICAL pass/fail（<2 min） |
| ROI | W1 Wed 2h → 30 min；省 1.5h |

#### G2 — W2 keyword-mine fallback 无工具路径 ✓✓✓

| 维度 | 内容 |
|------|------|
| step | plan §3 W2 `/gg-keyword-mine` ship + W2 第 2 篇精修选题 |
| 当前 owner 声明 | `/gg-keyword-mine`: Claude Code；业务 owner: wzb |
| 真实 owner 推断 | W1 spike 失败 → 工具推 W3 → W2 仍要发 2 篇精修但**没人定义谁用什么流程选词** → 落回 wzb 手工 brainstorm |
| 文档原文 | plan L341-342 / L270-271 |
| 改造 | 补 no-tool fallback：Claude/Codex 用 WebSearch + 现有 GSC 数据生成 20 候选词 + GEO score 草表 → Ops 在 P 列分桶 → wzb batch approve 10 个 ★，不让 wzb 从空白页手选 |
| ROI | W2 keyword 决策 30 min → 10 min（即使 spike fail）|
| ⬆️ 2026-05-21 升级 | **GSC 30d baseline 实测 = empty**（site total ~250 imp, 唯一 ≥100 imp query 是品牌词 "astrology wiki"）→ fallback 路径**从 "W2 spike 失败救援" 升级为 W1 default path**：ship 时机从 "W2 同步" 提前到 **W1 Mon 与 entity-passport 同窗口并行 ship**（Claude Code 1.5h 并行不增 wzb 工时）。落地见 §6 P1-1 行扩。|

#### G3 — `bin/event-export` 错误声称包含 AI Overview 引用监测 ✓✓✓

| 维度 | 内容 |
|------|------|
| step | PRD §3.1/§4.1 `bin/event-export` + AI Overview / Perplexity 引用检测 |
| 当前 owner 声明 | PRD: event-export 自动拉 GSC + GA4 + AI 引用监测 |
| 真实 owner 推断 | 技术流程**没有** Perplexity/Google AIO 自动采集；实际 = Ops 手搜 + wzb 周报手判 |
| 文档原文 | PRD L121 / L159-160 / Tech L563-570 / L1071 "AI 引用监测半手工" |
| 改造 | 拆清责任：(a) `bin/event-export` **只**管 GSC + GA4 自动拉；(b) `ops-sop-ai-monitor.md` 或 `bin/ai-monitor-report` 负责 AI 引用监测（Ops 手做 perplexity.ai + Google AIO 截图）；(c) PRD §3.1 错误描述改 superseded 标注 |
| ROI | 消除 PRD 错误 claim；明确 Ops 真工作量；可选 P1 改造 →（如 perplexity 有 API）补 programmatic |

#### G4 — Ops 退出 fallback 三档矛盾（24h vs §1B） ✓

| 维度 | 内容 |
|------|------|
| step | plan §7.4 / Tech §6.3 §8.5 / PRD §11 Ops 中途退出 |
| 三档原文不一致 | plan L824-828: "Ops 退出 不放宽 wzb 红线"；Tech L767/L924: "wzb 红线临时放宽到 24h"；PRD L497/L520: "放宽到 24h" 但 PRD L610: "不再放宽 wzb 红线" |
| 风险 | 执行压力下双轨解释，Ops 缺口转嫁 wzb，wzb 反复决策 |
| 改造 | 统一口径只保留**一条**：Ops 不可用 ≥1 周 → R=Ops/wzb 通知，A=wzb 执行降 scope，**不能** 24h；Ops 永久退出 → 直接切 §1B。Tech/PRD 24h 段全部标 SUPERSEDED |
| ROI | 消除决策路径分叉；改造时间 = wzb 5 min 改三档 标注 |

#### G5 — 全局 RACI 列缺失（meta）✓✓✓

| 维度 | 内容 |
|------|------|
| step | 全文 §0.2 工具表 + PRD §8.1/§8.2 角色表 |
| 当前 | 工具级 owner（业务/工程/运营）；wzb 独占 PM/审稿/战略 |
| 真实 | 缺 step-level RACI；很多 A/R/I 被压缩成"wzb 拍板" → wzb 实际既是决策人、验收人、异常处理人、质量 reviewer，又常是隐性执行人 |
| 文档原文 | plan L88-100 / PRD L377-388 |
| 改造 | 进 plan v1.1.3 §0.3 加一张 step-level RACI 矩阵：每个 recurring step 必填 `Trigger / R / A / C / I / Output / Sign-off / fallback`（本文档 §3 已出 draft）|
| ROI | 消除 wzb 隐性执行陷阱；其他 17 项 gap 的 root cause |

---

### P1 应修（9 项，W1-W2 内补）

#### G6 — AI 引用监测半自动化 ✓✓

| step | PRD §19 / plan §8 Q-LEAN2-3 + Week-3 起 Ops 周二跑 |
|------|---|
| 当前 | Ops 手搜 perplexity.ai + Google AIO，30 min/周 |
| 改造 | `bin/gg-ai-citation-check --page-id X --engines perplexity,googleAIO,chatgpt`（perplexity 有 API；Google AIO 用 SerpAPI 或 BrightData）。前置：定义 `ai-monitor.csv` 字段 `page_id/query/engine/appeared/cited_url/screenshot_path/confidence/checked_by` |
| ROI | Ops 30 min/周 → 5 min；释放 25 min/周做 Reddit |
| 何时改 | Week-4 ship `bin/gg-ai-citation-check`（不在 W4 release train 内，独立加）|

#### G7 — codex objections + Perplexity 自检过载（每篇 30 min × 9-12 篇）✓✓✓

| step | Tech §4.2 Phase 2 hold + Codex challenge |
|------|---|
| 当前 | 每篇 wzb 必决策 codex objections accept/dismiss + Perplexity 自检 Yes/No |
| 真实负担 | 5 周 9-12 篇 × 2 micro-decision × 30 min = **4.5-6h 决策时间**贯穿全程 |
| 改造 | manifest 加 `confidence_score` + `default_action` 字段。confidence > 0.8 默认 accept + wzb 24h 反悔窗口；confidence ≤ 0.8 escalate wzb。Perplexity 自检改 AI 用 rubric（Entity Passport ≥6 源 + Citation count + Friction depth）打分，≥ 阈值默认 Yes + wzb 周末抽查 1 篇 |
| ROI | 每篇 30 min → 8 min（仅 escalate）；5 周累计省 4-5h |
| 何时改 | W3 `/gg-content-draft` ship 时同步加 confidence 字段 |

#### G8 — 5 篇精选 Day-0 决策无 AI 预判 ✓✓

| step | plan §1.1 Day-0 #3 / PRD §14 Q-LEAN2-2 |
|------|---|
| 当前 | wzb Day-0 1.5h 手读 5 篇 + 决策 rewrite/sunset/hold |
| 真实负担 | Day-0 GCP 绑卡 + Ops 协调 + 5 篇决策 同窗口抢注意力 |
| 改造 | Claude/Codex 先生成 5 篇 scorecard（GSC status + GEO fit + content gap + rewrite effort + recommended action），默认方案 `rewrite top 2 / hold 1 / sunset 2`，wzb 只批量改选择 |
| ROI | 1.5h → 30 min（taste 阅读时间留 Day -1 晚）|
| 何时改 | 已 OBSOLETE（wzb 已决"5 篇不动全新增"，本 gap 不再适用本次 MVP）|

> [!note] G8 状态更新
> 2026-05-20 wzb 已决定 5 篇精选**全部不动只新增**，Q-LEAN2-2 closed。本 gap 不再适用本轮 MVP，但同类决策模式（"AI 预判 + wzb batch approve"）仍 P1 应修。

#### G9 — distribute-draft 选发过载 ✓

| step | Tech §4.5 `/gg-distribute-draft` + PRD Story 4 |
|------|---|
| 当前 | 每篇 4 平台 × 3 候选 = 12 个候选 wzb 选 brand voice |
| 改造 | 工具输出 `recommended=true` + 理由：每平台默认 1 条、备选 1 条、风险项。Ops 按 default 执行；wzb 只在 flagged 或首两周抽查 |
| ROI | 每篇 wzb 5 min → 1 min（仅抽查时介入）|
| 何时改 | W5 `/gg-distribute-draft` ship 时同步 |

#### G10 — Day 30/60 数据包 wzb 仍是事实筛选人 ✓✓✓

| step | plan §6.6 / §6.7 Day 30/60 Lynne judge |
|------|---|
| 当前 | judge 已从 wzb 移给 Lynne（√）；但**数据包仍由 wzb 准备**，90 min/次 |
| 改造 | `bin/gg-retro-pack --day 30|60` 由脚本 + AI 汇总生成：GSC/GA4/runs 自动拉数 + Ops 附 AI 截图 + Claude/Codex 生成 fixed template；wzb 只 C=补充上下文，**不能改原始指标**；Lynne A=sign-off |
| ROI | wzb 90 min → 15-30 min（仅审 + 补充）|
| 何时改 | W5 末 ship（Day 30 retro 前一周）|

#### G11 — seo-gate-scan 报告 BLOCKER/WARN/INFO 无分级 owner ✓✓

| step | plan §6.3.5 / Tech §4.4 `bin/seo-gate-scan` |
|------|---|
| 当前 | "Ops 看报告，wzb 拍板"；无 BLOCKER/WARN/INFO 分级；wzb 实际逐条读 SEO report |
| 改造 | 报告分 `BLOCKER/WARN/INFO`：BLOCKER 自动 fail（工具阻断）；WARN Ops 按 SOP 初判；只有 `override requested` 才到 wzb。sign-off: green=Ops / yellow=wzb / red=工具阻断 |
| ROI | wzb 月底 30 min → 5 min；释放 Ops |
| 何时改 | W5 ship 时同步 |

#### G12 — M9 + publish-backfill 权限 preflight 缺失 ✓✓

| step | Tech §4.7 Manual SOP M9 + `bin/publish-backfill` |
|------|---|
| 当前 | Ops 主跑 M9；脚本不动 git；wzb merge 5 min/篇 |
| 真实风险 | M9 含 git branch/copy/commit/push/GitHub merge。**如 Ops 没权限或不熟 git，wzb 接回大段手工** |
| 改造 | W1 Ops onboard SOP 加 preflight checklist：repo access ✓ / branch push ✓ / PR 创建 ✓ / Vercel preview 查看 ✓。R=Ops 创建 PR，A=wzb merge；preflight 不满足 = 真 owner 标 wzb（**不隐藏**）|
| ROI | 消除 wzb 隐性接管 git mechanics；每周 1-3h 风险防御 |
| 何时改 | W1 Thu Ops onboard SOP 写时同步 |

#### G13 — Day-1 binary gate 文案 4/5 不一致 ✓

| step | plan §1.4 Day-1 Ops binary kill gate |
|------|---|
| 当前 | plan L73: "v1.1.2 真 binary 4/4"；L160 "真 binary 4/4"；L165-174 列 **5 项** 并写 "≤4/5 满足 立刻 switch"；L1003 revision_history "改真 4/4 → 5/5 pass" |
| 风险 | 5/5 真 binary 是 v1.1.2 锁定决策，文档残留 4/4 旧标记，执行时误判 |
| 改造 | 全文统一 `5/5 pass`；删除所有 4/4；标 A=wzb 执行切换 / C=Lynne sign-off / I=Ops |
| ROI | 5 min wzb 改三档；消除 binary gate 模糊 |

#### G14 — AI 引用 0 触发条件三档不一致 ✓✓

| step | plan §4.6 / §7.3 / Tech §8.5 / PRD §11 |
|------|---|
| 当前 | plan: 连续 2 周 0；Tech: 3 篇发布后 0；PRD: Day 7-14 / 连续 3 篇 0 / 第一篇 3-7 天 |
| 改造 | 统一 age-based trigger：**仅看 `age ≥ 14d` 的 mature cohort**；mature cohort 连续 2 周 0 AIO/Perplexity → Ops 自动 escalate → wzb retro |
| ROI | 消除假阳性 retro 触发；Ops 不再来回确认 |
| 何时改 | wzb sign-off 后立刻改三档 |

---

### P2 可推迟（4 项，W3+ 或 v1.3）

| gap | 内容 | 改造 |
|-----|------|------|
| **G15** cost monitoring 模糊 ✓✓ | `email 提醒`/`周 burn > $25`/`硬顶阻断` 谁触发/谁验收不清 | cost-tracker hard-block at write time；周一 Ops `bin/cost-summary --week --append-report`；email 若不实现就删 |
| **G16** DataForSEO smoke 无触发 ✓ | "每日 smoke" 但全局又说"不用 cron"，没人跑 | 改 `preflight smoke`：`/gg-keyword-mine` real run 前自动跑 |
| **G17** Week-5 accept ≥10 vs ≥12 不一致 ✓ | plan L701-707: ≥10 篇；Tech L994: ≥12（理想 15）；PRD L260: ≥12-15 | 验收口径只留 plan §6.4 ≥10；PRD/Tech 老标记 historical snapshot |
| **G18** cluster_id 全人工 ✓✓ | wzb 1h brainstorm cluster | AI cluster proposer（Top 15 词 + SERP intent + 现有文章 → cluster/page_role/content_angle default）；wzb batch approve |

---

### Architect 补 4 个 codex 没提的 gap

| ID | 内容 | 改造 |
|----|------|------|
| **A1** GCP bootstrap 一键化 | Day-0 wzb 1h GCP console 点击 | `bin/gg-bootstrap-gcp --project-id X` 自动 enable API + create 3 SA + share workbook |
| **A2** Lynne sign-off 自动归档 | wzb 手记 §9 凭据表 + IM 截图 | `bin/gg-record-decision --who lynne --decision day30-judge --evidence <path>` 写审计日志 |
| **A3** SOP draft 5 份起草自动化 | W1-W3 wzb 30 min × 5 = 2.5h | `/gg-sop-draft --type m9|monday|reddit|ai-monitor|social-distribute` 读 PRD §19.2 模板 + sonnet 起草 → wzb 改 voice |
| **A4** Reddit subreddit 规则审查 | Ops 1.5h/周看候选 + 对照规则手审 | `bin/gg-reddit-rule-check --subreddit X --candidate Y` reddit API + sonnet 判 |

---

## §2 wzb daily routine 表（改造后 W0-W6）

> 每行格式：时段 / wzb 行为(LOOK|FILL|DECIDE) / AI 自动 / Ops / surface / 决策预算
> **粗体** = wzb 必做；`code` = AI/工具自动；普通 = Ops 做

### Day -1（GCP / 5 篇阅读储备）

| 时段 | wzb | AI | Ops | surface | 预算 |
|------|-----|------|------|---------|------|
| 晚上 | **LOOK** 5 篇精选全文（taste 储备）| — | — | Obsidian / 网页 | 1h |

### Day 0（Day-0 起跑，3 件事 / 实际只剩 1）

> 2026-05-20 user update: Ops 已落实（Q-LEAN2-1 closed）/ GCP/GSC/GA4 已链（仍需 SA 落地）/ 5 篇全新增（Q-LEAN2-2 closed）。**Day-0 实际只剩 Lynne sign-off + W1 选题 brainstorm（已在 §6.6 完成 path C/saturn return）**

| 时段 | wzb | AI | Ops | surface | 预算 |
|------|-----|------|------|---------|------|
| AM | **DECIDE** Lynne Day 30/60 kill commit conversation | — | — | 邮件/IM | 30 min |
| AM | `bin/gg-bootstrap-gcp` 跑（自建 3 SA / 落 _gg.env）| `gcloud iam sa create` × 3 + 落 `_gg.env` | — | 终端 | 5 min（只 LOOK 输出）|
| PM | `bin/gg-facts-audit` ship + 跑 | Claude Code 出脚本 + 跑 | — | VS Code | 1.5h（W0 加 ship 投入）|

### Day 1（binary gate 18:00）

| 时段 | wzb | AI | Ops | surface | 预算 |
|------|-----|------|------|---------|------|
| 18:00 | **LOOK** `bin/gg-day1-gate-check` 输出 5/5 + **DECIDE** 主线 vs §1B | `bin/gg-day1-gate-check` 读 §9 凭据表 + Lynne sign-off 文件 → binary 报告 | — | 终端 | 10 min |

### Week-1（standard-setting 1 篇 + facts-audit + Claude spike）

| 时段 | wzb | AI | Ops | surface | 预算 |
|------|-----|------|------|---------|------|
| **W1 Mon AM** | **LOOK** 6 源摘要 + **DECIDE** 是否补第 7 源 | `/gg-entity-passport --page-id saturn-return-at-28`（薄版：WebFetch 6 URL + sonnet 抽 entity → `entity_passport.json`）| — | Obsidian | 30 min |
| **W1 Mon PM** | **LOOK** quotes 候选 + **DECIDE** 选 3 条 ★ | `/gg-friction-mine`（WebFetch reddit/quora SERP + sanitize → `friction_pack.json`）| — | Obsidian | 30 min |
| **W1 Tue AM** | **LOOK** schema.org frontmatter + **DECIDE** 字段微调 | `bin/gg-schema-inject` 读 draft 自动注入 Article/FAQPage/Citation JSON-LD | — | Obsidian | 15 min |
| **W1 Tue PM** | **LOOK** codex objections × 1-3 条 + **FILL** `wzb_codex_objections_resolved` + **DECIDE** accept/dismiss（confidence > 0.8 已 default accept，wzb 仅审高风险）| codex 提 objection + AI 打 confidence | — | Obsidian / manifest.json | 10 min（仅高风险 escalate）|
| **W1 Tue** | **DECIDE** Perplexity 引用自检 Yes/No（AI rubric 已打 Yes 默认）| AI 算 Entity ≥6 源 + Friction depth + Citation count rubric | — | Obsidian | 3 min |
| **W1 Tue PM** | wzb 手跑 M9 9 步 + **DECIDE** 每步记 SOP 范本 | — | — | 终端 + GitHub | 1h |
| **W1 Wed AM** | **LOOK** report + **DECIDE** CRITICAL pass/fail | `bin/gg-facts-audit` 跑 5 断言 binary diff | — | 终端 | 5 min |
| **W1 Wed PM** | Ops onboarding 主导 + **DECIDE** 教学要点 | — | Ops 旁观 | 屏共 | 1h |
| **W1 Thu AM** | **LOOK** 7 binary 项过没过 + **DECIDE** "$500 bet" Yes/No（fresh head） | Claude Code 跑 4h spike：CLI + config + Sheets fake + dry-run + runs append + formula guard + 1 vitest | — | VS Code | 4h（含 Claude spike，wzb 全程参与）|
| **W1 Thu PM** | **LOOK** 2 份 SOP draft + **FILL** brand voice + **DECIDE** 发布 | `/gg-sop-draft --type m9` + `--type monday` 读 PRD §19.2 + Tue M9 操作日志 → sonnet 起草 | — | Obsidian | 20 min |
| **W1 Thu PM** | **DECIDE** Week-2 范围（全/砍） | — | — | Obsidian retro | 10 min |
| **W1 Fri** | **DECIDE** W2 选题 2 篇（从 zero-baseline AI 候选选）| `/gg-keyword-fallback` 出 20 候选 + GEO 估分（zero-baseline default path；GSC site total 30d ~250 imp 已验证 2026-05-21）| — | Sheets P 列 | 10 min |
| **W1 Fri 17:00** | **LOOK** weekly gate binary + **DECIDE** §7 降级 yes/no | `bin/gg-gate-check --gate weekly` 读 §11 看板 + runs 表 + Sheets → binary 报告 | — | Obsidian §11 | 5 min |

**W1 wzb 总工时**：~14h（改造前 16h；省 2h Entity 取证 + SOP 起草）  
**W1 surface count**：5（Obsidian / 终端 / VS Code / GitHub / Sheets；改造前 7） **从红色降到黄边**

### Week-2（gg-lib + /gg-keyword-mine + manifest schema lock）

| 时段 | wzb | AI | Ops | surface | 预算 |
|------|-----|------|------|---------|------|
| **W2 Mon** | **LOOK** PR diff + **DECIDE** merge | Claude Code 出 gg-lib 4 模块 + JSON Schema lock + 多语言 fixture | — | VS Code | 2h |
| **W2 Mon** | **DECIDE** budget cap + **LOOK** Top 15 输出 + **FILL** P 列 ★ Top 10-15 | `/gg-keyword-mine --geo-mode --dry-run` 7 phase 自动 | — | Sheets | 15 min |
| **W2 Tue** | **LOOK** Phase 2 draft × 2 篇 + **FILL** manifest + **DECIDE** 发布 | `/gg-content-draft-minimal` 薄版（Phase 1+2，省 Phase 3）| — | Obsidian | 1.5h × 2 = 3h |
| **W2 Wed 17:00** | **LOOK** vertical slice 报告 + **DECIDE** W2 全范围 vs 砍 | `bin/gg-vertical-slice-check` 跑 fake test + dry-run + formula guard binary | — | 终端 | 3 min |
| **W2 Wed** | Ops M9 影子带训 + **DECIDE** 教学补充 | — | Ops 旁观 | 屏共 + GitHub | 1h |
| **W2 Mon (cron)** | 0 wzb action（Ops 看 + alert wzb 仅 > $25/周）| `bin/cost-summary --week` Ops 周一跑 | Ops | Slack/IM | 0 min |
| **W2 Thu** | **LOOK** + **FILL** voice + **DECIDE** 发布 × 2 SOP | `/gg-sop-draft --type ai-monitor` + `--type reddit` sonnet 起草 | — | Obsidian | 20 min |
| **W2 Fri** | Ops Monday SOP 影子带训 + **DECIDE** 教学 | `bin/event-export` 已 W2 提前 ship → Ops 已能用 | Ops 旁观 | GSC UI + Sheets | 30 min |
| **W2 Fri 17:00** | **LOOK** weekly gate + **DECIDE** 降级 | `bin/gg-gate-check --gate weekly` | — | Obsidian | 5 min |

**W2 wzb 总工时**：~15h（改造前 17.5h；省 2.5h `/gg-content-draft-minimal` 接走 + SOP 自动）  
**W2 surface count**：5（Sheets / Obsidian / 终端 / VS Code / GitHub） **从最红 8 降到 5**

### Week-3（/gg-content-draft full ship + 3 篇精修 + AI 监测启动）

| 时段 | wzb | AI | Ops | surface | 预算 |
|------|-----|------|------|---------|------|
| **W3 Mon** | **LOOK** PR + **DECIDE** merge | Claude Code 出 `/gg-content-draft` full（Phase 1+2+3+ confidence 字段） | — | VS Code | 2h |
| **W3 Mon-Wed** | **LOOK** Phase 2 draft × 3 + **FILL** review_duration + **DECIDE** 发布 × 3（codex objections AI 默认 + wzb 仅审高风险）| `/gg-content-draft --tier T1 --codex-challenge true` × 3 | — | 终端 + Obsidian | 1h × 3 = 3h |
| **W3 Tue** | **LOOK** Ops 周报覆盖率（不 surface 切换）| `bin/gg-ai-citation-check` 起草（W4 ship）；W3 Ops 仍手做 | Ops 手做 30 min | Sheets 周报 | 3 min |
| **W3 Wed** | **FILL** Sheets P 列 ★ + **DECIDE** cluster_id 批量 approve | `/gg-keyword-mine` + AI cluster proposer 出 default cluster | — | Sheets | 15 min |
| **W3 Wed** | **LOOK** PR + **DECIDE** merge × 3 | Ops 跑 M9 全 9 步（preflight 已 W1 验证）| Ops | GitHub | 9 min（3 min/篇）|
| **W3 Thu** | **LOOK** SOP + **FILL** voice + **DECIDE** | `/gg-sop-draft --type social-distribute` | — | Obsidian | 10 min |
| **W3 Fri 17:00** | **LOOK** gate + AI 引用 mature cohort 数 + **DECIDE** retro 触发 | `bin/gg-gate-check --gate weekly --include-ai-citation` | — | Obsidian | 5 min |

**W3 wzb 总工时**：~16h（改造前 18h；省 2h codex objections default + cluster AI proposer + AI 监测自动）  
**W3 surface count**：5（VS Code / Obsidian / 终端 / Sheets / GitHub） **从红色 7 降到 5**

### Week-4（3 件 ship 串行 release train + AI 监测自动化 + Day 14 节点）

| 时段 | wzb | AI | Ops | surface | 预算 |
|------|-----|------|------|---------|------|
| **W4 Mon-Tue** | **LOOK** PR + **DECIDE** merge | Claude Code ship `bin/publish-backfill` full | — | VS Code | 2h |
| **W4 Mon** | 0 wzb action | `bin/event-export --week 2026-Wxx` Ops 跑 | Ops + 填决策列 | Sheets | 0 min |
| **W4 Tue** | **DECIDE** sunset/refresh/observe × 已发文章（30 min 周报会议） | — | Ops 主持会议 | Sheets + 视频 | 30 min |
| **W4 Wed-Thu** | **LOOK** PR + **DECIDE** merge | Claude Code ship `/gg-cta-inject` | — | VS Code | 2h |
| **W4 Fri** | **LOOK** PR + **DECIDE** merge | Claude Code ship `bin/gg-ai-citation-check`（替代 release train 砍掉的 1 件）| — | VS Code | 2h |
| **W4 Mon-Fri** | **LOOK** draft × 2-3 + **FILL** + **DECIDE** | `/gg-content-draft` × 2-3 | — | 终端 + Obsidian | 1h × 2.5 = 2.5h |
| **W4 Fri** | **LOOK** Day 14 report + **DECIDE** 收录率 ≥80% pass | `bin/gg-day14-check --since W1` 自动 | — | 终端 | 5 min |
| **W4 Fri** | 仅 alert 时 LOOK + DECIDE | `bin/cost-summary --month` auto-alert if > $80 | — | Slack | 0-3 min |
| **W4 Fri 17:00** | **LOOK** weekly gate + **DECIDE** | `bin/gg-gate-check` | — | Obsidian | 5 min |

**W4 wzb 总工时**：~16h（改造前 17h；省 1h Ops 接周一 + AI 监测自动）  
**W4 surface count**：5（VS Code / Sheets / Obsidian / GitHub / 视频）**从红色 7 降到 5**

### Week-5（2 件推迟 ship + 稳态 + 月度行为 KPI）

| 时段 | wzb | AI | Ops | surface | 预算 |
|------|-----|------|------|---------|------|
| **W5 Mon-Tue** | **LOOK** PR + **DECIDE** merge | Claude Code ship `/gg-distribute-draft` + `bin/seo-gate-scan`（含 BLOCKER/WARN/INFO 分级） | — | VS Code | 2h |
| **W5 Mon-Fri** | **LOOK** draft × 1-2 + **DECIDE** | `/gg-content-draft` × 1-2 | — | Obsidian | 1h × 1.5 = 1.5h |
| **W5 Wed** | **LOOK** seo-gate WARN 总数 + **DECIDE** override（仅 yellow 升 wzb，green Ops 自处理） | `bin/seo-gate-scan` 分级输出 | Ops 处理 green | 终端 | 10 min |
| **W5 Tue** | 仅会议 30 min | Ops cron + AI citation auto | Ops | 视频 | 30 min |
| **W5 Fri** | **LOOK** monthly behavior report + **DECIDE** 行为 KPI pass/fail | `bin/event-export --report behavior` | — | Obsidian | 10 min |
| **W5 Fri** | **LOOK** acceptance binary + **DECIDE** Week-6 pass | `bin/gg-acceptance-check` 跑 §6.4 三层 binary | — | Obsidian | 15 min |

**W5 wzb 总工时**：~15h  
**W5 surface count**：5

### Week-6（Day 30 retro，Lynne judge）

| 时段 | wzb | AI | Ops | surface | 预算 |
|------|-----|------|------|---------|------|
| **W6 Mon** | **LOOK** data pack + **DECIDE** 补充上下文 | `bin/gg-retro-pack --day 30` 自动 GSC + GA4 + runs + AI 监测截图 | Ops 补截图 | 终端 + Obsidian | 15 min |
| **W6 Tue** | **DECIDE** 发包给 Lynne | — | — | 邮件/IM | 5 min |
| **W6 Tue-Wed** | wzb 不投票，只 **LOOK** Lynne 决定 | — | — | IM | 0 min |
| **W6 Wed** | **DECIDE** Ops 续签条款（must keep wzb）| — | — | 邮件/IM | 30 min |
| **W6 Thu** | **LOOK** W7-9 计划 draft + **FILL** 调整 + **DECIDE** | `/gg-week-plan --weeks 7-9` 复用 W5 稳态模板 | — | Obsidian | 20 min |
| **W6 周内** | 同 W4-W5 精修 × 2-3 | `/gg-content-draft` | — | 终端 | 1h × 2.5 = 2.5h |

**W6 wzb 总工时**：~13h（不重，retro 周）  
**W6 surface count**：4（含 IM + Obsidian + 终端 + GitHub）

### Week-7-9 稳态 + Day 60

| 时段 | wzb | AI | Ops | surface | 预算 |
|------|-----|------|------|---------|------|
| 每周 Mon | **DECIDE** 2-3 篇选题（AI 出 3-2-1 推荐）| `/gg-pick-topic --weeks 1 --recommend 3-2-1` | — | Sheets | 10 min |
| 每周 Tue-Thu | **LOOK** draft × 2-3 + **DECIDE** | `/gg-content-draft` × 2-3 | — | Obsidian | 1h × 2.5 = 2.5h |
| 每周 Tue | 同 W4-W5 会议 | — | Ops | 视频 | 30 min |
| 每周 Fri | **LOOK** gate + **DECIDE** | `bin/gg-gate-check` | — | Obsidian | 5 min |
| Day 60 | **LOOK** Day 60 pack + **DECIDE** 发 Lynne | `bin/gg-retro-pack --day 60` | Ops 补截图 | Obsidian | 30 min |

**稳态 wzb 工时**：每周 ~9-10h（原 12h；省 ~2.5h）

---

## §3 step-level RACI 矩阵 draft（进 plan v1.1.3 §0.3）

> 格式：每 recurring step 必填 8 列。本表是 draft，wzb sign-off 后 incorporate 进 plan v1.1.3 §0.3。

| Step ID | step | Trigger | R (责任执行) | A (问责验收) | C (咨询) | I (告知) | Output | Sign-off owner | Fallback |
|---------|------|---------|------------|------------|---------|---------|--------|--------------|----------|
| S-D0-1 | Lynne kill commit conversation | wzb Day-0 启动 | wzb | wzb | Lynne | Ops, AI | 邮件存档 | wzb | 切 §1B |
| S-D0-2 | GCP/SA 落地 | wzb Day-0 启动 | AI `bin/gg-bootstrap-gcp` | wzb | — | Ops | `_gg.env` + 3 SA JSON | wzb LOOK 输出 | 手 fallback CGP console |
| S-D1-1 | Day-1 binary 5/5 gate | Day-1 18:00 cron | AI `bin/gg-day1-gate-check` | wzb | Lynne(sign-off) | Ops | binary 报告 | wzb DECIDE 主线/§1B | 切 §1B |
| S-W1-1 | 第 1 篇 Entity Passport | wzb cmd `/gg-entity-passport` | AI 薄版 | wzb | — | Ops | `entity_passport.json` | wzb LOOK 补第 7 源 | 手抓 |
| S-W1-2 | 第 1 篇 Friction 取证 | wzb cmd `/gg-friction-mine` | AI 薄版 | wzb | — | Ops | `friction_pack.json` | wzb DECIDE 选 3 条 | 手抓 |
| S-W1-3 | codex objections | wzb cmd 精修 Phase 3 | AI + codex | wzb（仅 confidence < 0.8 时） | — | — | objection list | AI default accept + wzb 24h 反悔 | wzb 全审 |
| S-W1-4 | Perplexity 自检 | 精修发布前 | AI rubric | wzb（周末抽查）| — | — | confidence score | AI default Yes + wzb 抽查 | wzb 全审 |
| S-W1-5 | facts-audit | W1 Wed cron | AI `bin/gg-facts-audit` | wzb | — | Ops | severity 报告 | wzb DECIDE CRITICAL pass | 手 audit |
| S-W1-6 | Claude spike $500 self-check | W1 Thu AM 4h spike 后 | wzb（must keep）| wzb | — | — | bet Yes/No | wzb（fresh head）| W2 砍范围 |
| S-W1-7 | M9 PR merge | Ops PR 提交 | Ops 创建 PR | wzb merge | — | — | merged PR | wzb LOOK PR diff | Ops 权限不足 → wzb 接管（标显）|
| S-W2-1 | gg-lib + manifest schema | wzb session Claude Code | AI Claude Code | wzb merge | — | Ops | PR | wzb LOOK + merge | manage > 4h 砍 sanitizer |
| S-W2-2 | `/gg-keyword-mine` 跑 | wzb cmd | AI tool | wzb | Ops（P 列 review）| — | A-I 列 + Y 列 | Ops FILL P 列 + wzb FILL ★ | preflight smoke fail OR GSC empty baseline（2026-05-21 已验证）→ `/gg-keyword-fallback` default path |
| S-W2-3 | Vertical slice 自检 | W2 Wed 17:00 cron | AI `bin/gg-vertical-slice-check` | wzb | — | — | binary 报告 | wzb DECIDE 全范围/砍 | 砍 sanitizer fixture |
| S-W3-1 | `/gg-content-draft` 精修 × 3 | wzb cmd × 3 | AI tool | wzb | — | Ops | manifest + draft.md | wzb DECIDE 发布（confidence default）| Phase 2 hold 拒绝 → 重做 |
| S-W3-2 | AI citation 监测 | 周二例行 | Ops（W3-W4 手做 → W4 ship 后 `bin/gg-ai-citation-check`）| wzb（周报）| Lynne（Day 30/60）| — | ai-monitor.csv | wzb LOOK 覆盖率 | mature cohort 2 周 0 → escalate |
| S-W3-3 | cluster_id 批量 | W3 Wed cron 后 | AI cluster proposer | wzb batch approve | — | — | 默认 cluster | wzb DECIDE batch | wzb 手填 |
| S-W4-1 | publish-backfill ship | wzb session | AI Claude Code | wzb merge | — | Ops | PR | wzb LOOK + merge | 砍 audit |
| S-W4-2 | cta-inject ship | wzb session | AI Claude Code | wzb merge | — | — | PR | wzb LOOK | facts-audit fail → 不注入 paid_signup |
| S-W4-3 | Day 14 cohort report | W4 Fri cron | AI `bin/gg-day14-check` | wzb | — | — | 收录率报告 | wzb DECIDE ≥80% pass | sunset 决策 |
| S-W4-4 | cost monthly burn | 月底 auto-alert | AI `bin/cost-summary --month` | wzb（仅 alert 时）| — | Ops | burn report | wzb DECIDE 降配 / hard-block | hard-block 写 API |
| S-W4-5 | Ops 周报会议 | 周二 cron | Ops 主持 | wzb | — | — | 决策列 FILL | wzb DECIDE sunset/refresh | — |
| S-W5-1 | seo-gate-scan | wzb cmd / 发布前 | AI tool | green=Ops / yellow=wzb / red=工具 | — | — | BLOCKER/WARN/INFO 分级 | 分级 owner | red block 发布 |
| S-W5-2 | distribute-draft | 精修发布后 | AI tool (recommended=true 标默认) | Ops（按 default 执行）| wzb（首两周抽查）| — | 4 平台 × 3 候选 | Ops 默认 + wzb override | 砍平台 |
| S-W5-3 | acceptance check | W5 Fri cron | AI `bin/gg-acceptance-check` | wzb | — | Lynne | 三层 binary | wzb DECIDE pass | retro |
| S-W6-1 | Day 30 retro pack | W6 Mon cron | AI `bin/gg-retro-pack --day 30` | wzb（补上下文）| Lynne (A=judge) | Ops | data pack | Lynne sign-off | — |
| S-D60-1 | Day 60 retro pack | Day 60 cron | AI `bin/gg-retro-pack --day 60` | wzb（补上下文）| Lynne (A=judge) | Ops | data pack | Lynne sign-off | office-hours 触发 |
| S-G-1 | 工时 > 18h 红线 | 任一周自动 | AI 工时跟踪 | wzb（仅 ack）| — | Ops | alert | wzb ack（plan 已写死降级动作）| 降 scope |
| S-G-2 | Ops < 5h/周 持续 2 周 | 自动检测 | AI 周报跟踪 | wzb（must keep）| Lynne | — | escalate alert | wzb DECIDE 扩 8h / 换 backup / 切 §1B | §1B |
| S-G-3 | mature cohort 2 周 0 AI 引用 | age-based auto | AI 自动 escalate | wzb | — | Ops | retro trigger | wzb DECIDE retro | 调精修 SOP |

---

## §4 50 wzb 决策点 → 6 must-keep + 44 压缩汇总

详见 planner subagent 输出（见 task #26 完整版）。摘要：

| 压缩类型 | 数量 | 节省（5 周累计）| 代表 |
|----------|------|----------------|------|
| **must-keep wzb** | 6 | 0 | D1 (Ops 拍板) / D4 (Lynne commit) / D5 (Day-1 binary) / D10 (spike self-check) / D38 (Ops 续签) / D47 (Ops backup) |
| default + 24h 反悔 | 12 | ~4h | D7 codex objections / D11/D19/D24/D31/D36 各周 Gate / D46 cost alert |
| delegate to AI | 10 | ~3h | D2 5 篇分类（OBSOLETE）/ D16 80 种子词 / D23 cluster_id / D37/D43 数据包 |
| delegate to Ops | 6 | ~1.5h | D3 GCP ID / D17 ★ 词分桶 / D28 publish-backfill audit / D49 Day 14 status |
| batch | 4 | ~1h | D2+D6 / D40+D50 |
| default rule (plan 已写死) | 12 | ~1.5h | D29 paid_signup / D32 砍工具 / D45 红线 |
| **合计节省** | 44 项 | **~11h** | — |

**洞察**：wzb 6 个 must-keep 全围绕 **人事/关系 + forcing function**，技术内容决策（codex/cluster/Perplexity 自检/选题）全可压。这与 wzb 自述"只看+填" 角色高度一致。

---

## §5 surface count 改造前后 + 飞书 CLI 表格

### 5.1 改造前后对比

| 周 | 改造前 surface | 改造后 surface | 改进 |
|----|----------|----------|------|
| W0 | 4 (绿) | 4 (绿) | 无变化 |
| W1 | 7 (**红**) | 5 (黄边) | 砍 Reddit/Quora + VS Code 合并 |
| W2 | 8 (**红红**) | 5 (黄边) | content-draft minimal 接走 + Ops 接 csv |
| W3 | 7 (**红**) | 5 (黄边) | AI 监测自动 + cluster AI |
| W4 | 7 (**红**) | 5 (黄边) | Ops 接周一 csv + AI 监测自动 |
| W5 | 6 (黄) | 5 (黄边) | seo-gate 分级 owner |
| W6 | 5 (黄) | 4 (绿) | retro pack 自动 |
| 稳态 W7-9 | 5 (黄) | 4 (绿) | week plan 模板 |

**改造目标达成**：5 周中 4 周 ≥7 → 5 周中 0 周 ≥7

### 5.2 飞书 CLI 表格落地候选

| 项 | 当前 surface | 迁移飞书？ | 理由 |
|----|------------|----------|------|
| 复盘表决策列（sunset/refresh）| Google Sheets | ✅ 迁移（W4 起）| 飞书移动端 + 多人协同 + IM 联动顺手 |
| §11 进度看板 | Obsidian | ✅ 迁移（W2 起）| 飞书表格 + 通知机制比 Obsidian 顺 |
| 周报会议决策列 | Sheets / Obsidian | ✅ 迁移（W4 起会议时）| 飞书会议纪要 + 表格联动 |
| 关键词主表（24 列含 8 公式列）| Google Sheets | ❌ 保留 | `keyword-sheet-setup.gs` 公式列硬禁；飞书 array formula 兼容性未验证 |
| CTA Map（E 列事件白名单）| Google Sheets | ❌ 保留 | 与 `/gg-cta-inject` 强耦合 |
| 选题登记表（21 列）| Google Sheets | ❌ 保留 | 与精修工具流程强耦合 |
| `manifest.json` machine-readable | JSON file | ❌ 保留 | wzb 在 Obsidian 看渲染版即可 |

---

## §6 落地清单（按优先级）

### P0 立刻做（W0 起跑前 / Day-0 之内）

| # | 内容 | 谁做 | 时间 |
|---|------|------|------|
| P0-1 | ship `bin/gg-facts-audit`（5 断言 binary diff + severity）| AI Claude Code | W0 PM 1.5h |
| P0-2 | ship `bin/gg-bootstrap-gcp`（3 SA + enable API + share workbook + 落 _gg.env）| AI Claude Code | W0 PM 1h（替代 wzb 手 console 1h，净省 0）|
| P0-3 | ship `bin/gg-day1-gate-check`（读 §9 凭据表 + Lynne sign-off → binary） | AI Claude Code | W0 PM 30 min |
| P0-4 | 改 plan / Tech / PRD 三档 G4（Ops 退出 24h vs §1B 统一）+ G13（Day-1 5/5 统一）+ G14（age-based AI citation trigger 统一） | wzb 改 markdown | 15 min |

### P1 W1 内完成

| # | 内容 | 谁做 | 时间 |
|---|------|------|------|
| P1-1 | ship `/gg-entity-passport` + `/gg-friction-mine` + **`/gg-keyword-fallback`**（zero-baseline keyword discovery；WebFetch + sonnet 三个并行 ship） | AI Claude Code | W1 Mon 1.5h（含 fallback 0.5h 增量；并行不增 wzb 工时） |
| P1-2 | ship `bin/gg-gate-check --gate weekly|vertical-slice|day-1|day-14|day-30|day-60`（统一 gate-check） | AI Claude Code | W1 Thu 30 min |
| P1-3 | ship `/gg-sop-draft --type m9|monday|reddit|ai-monitor|social-distribute`（5 in 1） | AI Claude Code | W1 Thu 30 min |
| P1-4 | manifest schema 加 `confidence_score` + `default_action` 字段（codex objections / Perplexity 自检 default + 24h 反悔） | AI Claude Code | W3 `/gg-content-draft` ship 时同步 |

### P2 W2 内完成

| # | 内容 | 谁做 | 时间 |
|---|------|------|------|
| P2-1 | ship `/gg-content-draft-minimal`（Phase 1+2 薄版）+ `bin/publish-backfill --confirm` 薄版 | AI Claude Code | W2 Wed 1h |
| P2-2 | `bin/event-export` 从 W4 Fri 提前到 W3 Fri ship | AI Claude Code | W3 加 1h |
| P2-3 | step-level RACI 矩阵进 plan v1.1.3 §0.3 incorporate | wzb 编辑 | 15 min |

### P3 W3-W4 完成

| # | 内容 | 谁做 | 时间 |
|---|------|------|------|
| P3-1 | ship `bin/gg-ai-citation-check`（perplexity API + SerpAPI Google AIO） | AI Claude Code | W4 加 1.5h |
| P3-2 | ship `bin/gg-retro-pack --day 30|60`（自动 GSC + GA4 + runs + Ops 截图模板） | AI Claude Code | W5 末 1h |
| P3-3 | AI cluster proposer + AI 5 篇 scorecard（如有同类决策） | AI tool | W3 cluster_id 时同步 |
| P3-4 | seo-gate-scan BLOCKER/WARN/INFO 分级 + owner 标 | AI Claude Code | W5 ship 时同步 |

### P4 v1.3 后置

| # | 内容 |
|---|------|
| P4-1 | distribute-draft `recommended=true` + Ops default 执行 |
| P4-2 | DataForSEO smoke 改 preflight + cost-tracker hard-block at write |
| P4-3 | Reddit subreddit rule check 自动化 |

---

## §7 改造后预期 KPI

| KPI | 改造前 | 改造后 | 改进 |
|-----|--------|--------|------|
| W1 wzb 工时 | 16h | 14h | -2h |
| W2 wzb 工时 | 17.5h | 15h | -2.5h |
| W3 wzb 工时 | 18h | 16h | -2h |
| W4 wzb 工时 | 17h | 16h | -1h |
| W5 wzb 工时 | 16h | 15h | -1h |
| W6 wzb 工时 | 14h | 13h | -1h |
| **5 周累计** | **84.5h** | **76h** | **-8.5h** |
| 稳态 W7-9 周工时 | 12h | 9-10h | -2-3h/周 |
| W1-W4 红色 surface 周数 | 4/4 | 0/4 | 完全消除 |
| wzb decision 次数（5 周）| ~80 micro | ~30 micro | -50（含 codex/Perplexity 自检 default）|
| wzb 心智 load | W3/W4 4h+ 决策 | W3/W4 1.5h | 回到 plan buffer 内 |

---

## §8 wzb sign-off checklist

提交前 wzb 逐项确认：

- [ ] **§1 18 个 RACI gap**：5 P0 + 9 P1 必修，4 P2 推迟（同意 / 调整 P 级 / 删除）
- [ ] **§2 daily routine 表**：W0-W6 每日 wzb 行为表（同意 / 哪里要补 / 哪里 wzb 实际要多做）
- [ ] **§3 step-level RACI 矩阵**：30 条 step 8 列（同意 / 哪些 column 多余 / 哪些 step 漏）
- [ ] **§4 50 决策点压缩**：6 must-keep + 44 压缩（同意 / must-keep 漏哪个 / 压缩太激进）
- [ ] **§5 飞书 CLI 表格落地**：复盘表 + §11 看板迁移（同意 / 时间点调整）
- [ ] **§6 落地清单**：P0/P1/P2/P3 优先级（同意 / 哪些推后 / 哪些前置）
- [ ] **§7 KPI**：5 周省 8.5h（同意 / 改 KPI 数）
- [ ] **本文档进 plan v1.1.3 §0.3 incorporate**（同意 / 不同意 / 维持本文档独立）

签字日期：________  
签字人：wzb  
版本：v1.0 → v1.1（如修改后）

---

## 相关阅读

- [[G-GenGrowth-MVP-落地plan-v1.1]] §1-§13（不动方案本体，本文档是 step-level RACI 补丁）
- [[G-GenGrowth-MVP-半自动化工具栈方案-v1.2-lean]] §3-§7（工具栈定义，RACI 复用）
- [[G-GenGrowth-MVP-OpsPM-PRD-v1.2-lean]] §19（Ops SOP 模板，本文档 P1-3 落地依据）
- [[G-GenGrowth-MVP-W1-keyword-brainstorm-template]]（W1 第 1 篇选题流程模板，已应用 path C/saturn return）
