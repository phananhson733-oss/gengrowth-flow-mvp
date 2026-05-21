---
title: GenGrowth MVP 落地 plan v1.1.2（lean2.1 + autoplan R3 architectural land）
date: 2026-05-20
updated: 2026-05-20
type: implementation-plan
companion_doc:
  - G-GenGrowth-MVP-OpsPM-PRD-v1.2-lean.md (PRD)
  - G-GenGrowth-MVP-半自动化工具栈方案-v1.2-lean.md (技术版)
status: ready-to-execute
owner: wzb
co_owner: Ops（Q-LEAN2-1 待定）
phase: Week-0 (Day-0 起跑)
red_line:
  wzb_hours_per_week: 18
  ops_hours_per_week: 5-8
target:
  geo_top10: ">=3 篇 Day 60"
  ai_overview_cites: ">=3 篇 Day 60"
  refined_articles_5w: 9-12（v1.1.2 砍 Week-1 第 2 篇推 W2；下限 9=1+2+3+2+1，上限 12=1+2+3+3+3）
  monthly_cost_cap: 100
revision_history:
  - v1.0 (2026-05-20 深夜): 初版，基于 lean2 双档翻译为可点 todo。5 周 / wzb 18h / Ops 5-8h / 12-15 篇精修 / Day 60 GEO 验收
  - v1.1 (2026-05-20 深夜+1): lean2.1 校准 patch。autoplan re-review（Codex + 2 Claude subagent）一致指出 5 项 CRITICAL + 7 项 HIGH。13 项校准 land。详见 §13。
  - v1.1.1 (2026-05-20 深夜+2): 第三轮最终验收 autoplan 3-voice mechanical fixes（6 条；A-F1/F6/F7 + Codex P1-2/P1-3/P2-4）。详见 §13。
  - v1.1.2 (2026-05-20 深夜+3): 3 条 architectural decisions 全 land（wzb 三选 A）：D1 Week-1 砍载到 ~16h（1 篇 + 2 SOP，5 周精修 9-12）；D2 Day 30/60 kill judge = Lynne（wzb 不投票）；D3 Day-1 gate 真 binary 5/5（删 24h buffer）。详见 §13。
tags:
  - gengrowth
  - mvp
  - landing-plan
  - lean2
  - lean2.1
  - quality-first
  - geo
aliases:
  - GenGrowth 落地 plan
  - landing plan v1.1
  - landing plan v1.1.2
  - lean2.1 校准 patch
  - autoplan R3 architectural land
  - 5 周执行计划
---

# GenGrowth MVP 落地 plan v1.1（lean2.1 校准版）

> [!danger] DEPRECATED 2026-05-21 — 整份 plan v1.x 系列 SUPERSEDED
> 本文档及其后继版本 v1.1.3 都是基于 RACI v1 的企业级 over-engineering，**对 1-2 人小团队不适用**。
> 真正 canonical 文档是 Lynne 已写好的 3 份：
> - `docs/03-marketing/03-seo/keyword-research-sop.md` v2.5
> - `docs/03-marketing/03-seo/keyword-sheet-setup.gs` v3.1
> - `docs/03-marketing/2026-05-15-gengrowth-internal-growth-mvp-prd-v0.7.md`
>
> 本文档**仅作历史参考**，不要按此执行。

> 这份是 wzb + Ops 的**执行 checklist**。每条都是 actionable 任务，含 owner / 工时 / 完成标准 / 阻塞链。
>
> **配套阅读**：[[G-GenGrowth-MVP-OpsPM-PRD-v1.2-lean]]（PRD，业务目标）+ [[G-GenGrowth-MVP-半自动化工具栈方案-v1.2-lean]]（技术细节）。
>
> 本文**不重复**PRD/Tech 里的论证，只把它们沉淀的决策**翻译为可点的 todo**。

> [!warning] 进度更新约定
> - 每条 todo 完成时 wzb 直接改 `[ ]` → `[x]`，**不要删行**
> - 每周一 09:30 wzb + Ops 同步会议时 review 本文进度
> - 红线/降级触发时，**先改本文**，再改 PRD（lean2 内文已写死红线机制，本文是镜像）
> - 任一周底 wzb 工时 > 18h → 立刻触发"工具开发停摆，只产精修"的 §5 自动降级

---

## §0 决策概览（lean2.1 校准）

> [!info] 一图看懂落地范围（lean2.1）
> - **5 周时间**（Week-0 起跑 + Week-1~5 主线）+ **Week-6 Day 30 retro gate**（新增）
> - **wzb 18h/周红线 + Ops 5-8h/周**（红线不可破，破即砍 scope）
> - **目标产出**：**10-13 篇精修** + 4 skill + 3 bin + 5 Ops SOP + 1 facts-audit
> - **核心 KPI**：Day 60 Top 10 ≥ 3 篇 + AI Overview/Perplexity 引用 ≥ 3 篇
> - **月度成本**：$70-100/月（硬顶 $150）
> - **⚠️ Day-1 binary kill gate on Ops**（详见 §1.4）：Day-1 18:00 前 Ops 合同未签 → 切换 §1B solo-fallback plan

### 0.1 5 周里程碑速览（lean2.1 校准）

| 周 | 工具/SOP 交付 | 精修产出 | wzb / Ops 工时 | gate |
|----|--------------|---------|---------------|------|
| **Week-0**（Day-0~Day-1）| Ops 协调 + **Lynne Day 30/60 kill 投票权 commit** + GCP billing + 5 篇决策 + **Day-1 Ops binary gate（v1.1.2 真 binary 4/4）** | — | wzb 4h / Ops 0h | Day-1 Ops 合同签 + Lynne sign-off → Week-1 主线；任一缺 → §1B solo-fallback |
| **Week-1** | facts-audit（automated diff）+ **2 Ops SOP**（M9/Monday；Reddit 推 W2）+ Claude spike binary 通过 | **1 篇精修**（standard-setting 8h；v1.1.2 砍第 2 篇推 W2）| wzb ~16h ✅ / Ops 2h | spike binary 通过 + facts-audit 0 CRITICAL contradiction |
| **Week-2** | `/gg-keyword-mine` + gg-lib 4 模块 + **manifest schema lock** + **多语言 sanitizer fixture**（前移）+ ai-monitor SOP + **Reddit SOP（v1.1.2 从 W1 推迟）** | **2 篇精修**（v1.1.2 含 W1 顺延的第 2 篇 + W2 本周新发 1 篇）| wzb 17h / Ops 4h | Day 3-4 manage 自检 binary 过 + sanitizer fixture 全拒 |
| **Week-3** | `/gg-content-draft` 精修工具（消费 W2 锁好的 schema + sanitizer）+ social-distribute SOP | **3 篇精修** | wzb 18h ⚠️ / Ops 5h | AI 引用监测启动（≥95% 精修覆盖）|
| **Week-4** | **3 件 ship**：`bin/publish-backfill` + `/gg-cta-inject` + `bin/event-export` MVP（无 `--catch-up`）| **2-3 篇精修** | wzb 17h ✅ / Ops 6h | Ops 全接 M9 + 数据复盘 |
| **Week-5** | **2 件 ship**：`/gg-distribute-draft` + `bin/seo-gate-scan` + 稳态 + 月度 KPI 汇总 | **1-2 篇精修** | wzb 16h ✅ / Ops 5h | 工具/行为验收（非业务）|
| **Week-6**（新增 retro）| Day 30 retro gate + Ops 合同续签 + Week-6~9 稳态计划 | **2-3 篇/周稳态** | wzb 12h / Ops 5h | Day 30 信号 ≥1/3 → 续；0/3 → office-hours |

**5 周累计（Week-1~5）**：wzb ~84h + Ops 22h = 106h（v1.1.2 W1 18h→16h）
**含 Week-0 启动**：4h 不计入主线
**6 周完整 plan**：wzb ~100h + Ops 27h = 127h
**精修发布**：Week-1~5 累计 9-12 篇（v1.1.2 砍 W1 第 2 篇推 W2；下限 9=1+2+3+2+1，上限 12=1+2+3+3+3）；Week-6 起 2-3/周稳态

### 0.2 7 个交付物清单（lean2.1 重排）

| # | 交付物 | 类型 | 责任周 | 业务 owner | 工程实施 | 日常运营 |
|---|--------|------|-------|------------|---------|---------|
| 1 | `/gg-keyword-mine`（GEO 取向） | skill | Week-2 | wzb | Claude Code | Ops 做 P 列分桶 review |
| 2 | `/gg-content-draft`（合并 MVP-1/2） | skill | Week-3 | wzb | Claude Code | — |
| 3 | `bin/publish-backfill`（M9 解锁 Ops） | bin | **Week-4** | wzb | Claude Code | Ops 跑 M9 SOP |
| 4 | `/gg-cta-inject` | skill | **Week-4** | wzb | Claude Code | Ops 维护 CTA Map |
| 5 | `bin/event-export` MVP（无 `--catch-up`）| bin | **Week-4** | wzb | Claude Code | Ops 周一跑 |
| 6 | `/gg-distribute-draft`（精修深度版） | skill | **Week-5**（lean2.1 推迟）| wzb | Claude Code | Ops 执行发布 |
| 7 | `bin/seo-gate-scan`（含 schema.org 校验） | bin | **Week-5**（lean2.1 推迟）| wzb | Claude Code | Ops 看报告，wzb 拍板 |
| + | `facts-audit.md` 全绿（automated diff）| script | Week-1 | wzb | wzb 自跑 | — |
| + | manifest schema JSON（锁定） | schema | **Week-2**（lean2.1 新增）| wzb | Claude Code | — |
| + | sanitizer 多语言 fixture | test | **Week-2**（lean2.1 前移）| wzb | Claude Code | — |
| + | 5 个 Ops SOP（分 3 周写完） | doc | Week-1(3) + W2(1) + W3(1) | wzb 写，Ops 跑 | — | Ops |
| + | `bin/event-export --catch-up` 增强 | bin 增强 | **Week-6+**（lean2.1 推迟）| wzb | Claude Code | Ops 周一跑 |

> [!tip] lean2.1 关键重排
> - **Week-4 5 件 ship 砍到 3 件**（autoplan 共识 C2）：保 publish-backfill（解锁 Ops M9）+ cta-inject（newsletter funnel 收入）+ event-export MVP（无 `--catch-up`，让 Week-2 wzb 能看数据）。`/gg-distribute-draft` + `bin/seo-gate-scan` 推 Week-5 稳态时 ship。
> - **多语言 sanitizer fixture 前移 W3→W2**：是 sanitizer-level test 不是 content-draft-level test，应该在 Week-3 `/gg-content-draft` 消费 sanitizer 前先打磨
> - **manifest schema 锁为 W2 JSON 文件**：避免 W3 写 content-draft 时 schema 仍流动，W4 publish-backfill `--confirm` 才发现字段不齐
> - **5 SOP 拆 3 周写**（autoplan H2）：M9/Monday/Reddit Week-1（每份 30-40 min × 3 = 1.5h 真实）；ai-monitor Week-2（Q-LEAN2-3 答完才写）；social-distribute Week-3（`/gg-distribute-draft` 推 Week-5 但模板可 W3 起草）

> [!tip] 砍了什么（lean2 + lean2.1 决策）
> - ~~MVP-1 T3 量产工具~~（lean2 autoplan F1：GEO 时代量产长尾不被 AI 引用）
> - ~~benchmark gate~~（lean2：没有量产对照实验）
> - ~~`/gg-refresh-scan` 自动~~（Day 60 节点手工扫）
> - ~~Week-4 5 件 ship 并行~~（lean2.1 autoplan C2：fantasy schedule）
> - ~~"5 SOP in 2h"~~（lean2.1 autoplan H2：每份至少 30 min）
> - ~~Week-1 "2-3 篇" 模糊目标~~（lean2.1 autoplan C1：明定 2 篇，1 篇 standard-setting 8h）

---

## §1 Week-0（Day-0/Day-1 起跑包 + Day-1 binary gate）

> [!warning] Day-0/1 是阻塞链上游
> 这 3 件不办，Week-1 没法起跑。**今天就要动**。Day-1 18:00 还有 Ops binary kill gate。

### 1.1 wzb Day-0 4 动作（并行，预计 4.5h；v1.1.2 加 Lynne commit）

| # | 任务 | 工时 | 完成标准 | 阻塞下游 | 状态 |
|---|------|------|---------|----------|------|
| 1 | **协调 Ops 落实**（Q-LEAN2-1）| 1.5h | 人选确定 + 5-8h/周工时合同签 + Week-2 起跑日期定 + **backup person 名单** | Day-1 binary gate | ⏳ |
| 2 | **GCP billing 绑卡**（非 LLM，3 个 Google API + IAM）| 1h | GCP project 已建 + billing 绑卡 + Sheets/GSC/GA4 API enabled + **GA4 property ID / GSC domain access / main workbook ID / test sheet / reader-writer SA 已可读写验证** | 阻塞 Week-1 facts-audit | ⏳ |
| 3 | **决定 5 篇已发精选哪几篇重写 / 哪几篇 sunset**（Q-LEAN2-2）| 1.5h | **Day-0 前先读 5 篇**（不算 1.5h 内），1.5h 用来记录决策清单：重写 N 篇 / sunset M 篇 / hold N 篇 | 阻塞 Week-1 精修基线选什么主题 | ⏳ |
| 4 | **Lynne Day 30/60 kill 投票权 commit conversation**（v1.1.2 新增，Q-LEAN2-5）| 0.5h | Lynne 同意拥有 Day 30 retro + Day 60 kill criterion binary 投票权；wzb 提供数据但**不投票**；4-tier 判决表（§6.7.2）由 Lynne 看数据 trigger | 阻塞 Day-1 binary gate item 5 | ⏳ |

> [!warning] Day-0 #3 现实性 patch（autoplan operator finding）
> 5 篇决策需要新鲜头脑（taste call）。建议把 5 篇阅读放在 Day-0 之前的"Day -1"晚上，Day-0 当天的 1.5h 只用来记录决策。否则 GCP/Ops grind 之后 30 min 草率拍板 = Week-1 选错主题损失 4-5h。

### 1.2 Day-0 检查清单

- [x] DataForSEO 账号已正式登录 + API key 可用（lean2 已确认，无需 KYC 等待） ✅ 2026-05-21
- [ ] GCP 项目 ID 记入 [[G-GenGrowth-MVP-半自动化工具栈方案-v1.2-lean]] §7.5 config/_gg.env
- [ ] **GA4 property ID 已记 _gg.env**
- [ ] **GSC domain property（astrologywiki.com）SA 已 Full User access**
- [ ] **MAIN_WORKBOOK_ID 已记 _gg.env**
- [x] **test sheet 已创建 + reader/writer SA 可读写验证（手工跑一次 Sheets API ping）** ✅ 2026-05-21
- [x] Ops 候选名字 + 联系方式 + 工时合同 → 记入本文 §9 凭据登记表 ✅ 2026-05-21
- [ ] **Ops backup person 名单**（至少 1 人）→ 记入本文 §9
- [ ] 5 篇精选决策表 → 记入本文 §9
- [x] **Lynne Day 30/60 kill 投票权 sign-off**（v1.1.2 新增）→ 记入本文 §9 + Lynne 邮件/IM 确认存档 ✅ 2026-05-21
- [x] Anthropic Claude API key 可用（已有） ✅ 2026-05-21
- [x] OpenAI Codex API key 可用（T1 跨模型挑战用） ✅ 2026-05-21
- [x] oracle repo 在本机可 PR + merge（M9 git mechanics 前置） ✅ 2026-05-21

### 1.3 Day-0 输出

> [!example] Day-0 结束时 wzb 应该有
> - 一个 GCP project，billing 绑卡成功，3 个 API enabled，且 GA4/GSC/Sheets workbook 真实 ID 都已落 _gg.env
> - 一份 Ops 合同/承诺草稿（Day-1 18:00 前签字）+ backup person 名字
> - 一份 5 篇决策清单，明确 Week-1 写哪 2 篇
> - 一句话告诉自己：Day-1 18:00 我会知道是主线 plan 还是 §1B solo-fallback

### 1.4 Day-1 Ops binary kill gate（v1.1.2 真 binary 4/4：autoplan R3 Subagent B + Codex 共识 P1）

> [!warning] Day-1 18:00 强制 check（不可延期）
> 这是 lean2 战略的 load-bearing 假设。Ops 是 Week-3/4/5 critical path。**v1.1.2 修正**：删 2/4 buffer 档（是 lean1 软启动逃生口）。改真 binary：5/5 pass / 否则立刻 §1B。

**Pass criteria（v1.1.2 同时满足全部 5 项）**：
- [x] Ops 合同已签字（工时 + 起始日期 + 6 周承诺） ✅ 2026-05-21
- [ ] Ops 已读 PRD §19 + 本文 §6 Week-5 + §11 进度看板
- [ ] Ops Week-2 起跑日期在合同里（不是 "尽快开始"）
- [ ] Ops backup person 名单 ≥ 1 人
- [ ] **Lynne Day 30/60 kill 投票权 sign-off 已确认**（v1.1.2 新增，Day-0 #4 落地）

**Day-1 18:00 真 binary 判决**：
- **5/5 满足** → Pass，主线 plan 起跑
- **≤4/5 满足**（任一缺失，**不论缺哪一条**）→ **立刻 switch to §1B solo-fallback plan**，不等 buffer，不"明天再补"

**v1.1.2 删除 2/4 buffer 档的理由**（autoplan R3 共识）：
- Subagent B P1-3：2/4 24h buffer 就是设计好的逃生口。"明天再补签字" 必走此路径 → 假 Ops 真超工时 → Week-4 cascade
- Codex P1-1：合同签字 + 起跑日是 load-bearing，不能 buffer
- §1.4 自己已经红字警告"软上线 = lean1 引回"，2/4 档就是软上线本身

**为什么不"试 24h"**：autoplan operator 指出，§7.4 fallback "Ops 不可用 → wzb 红线临时放宽到 24h" 是 lean2 修好的问题。Day-1 软启动 = 同 class 错误的 entry point。**Ops 在合同上签字这件事不能 24h 缓冲。**

---

## §1B Solo-fallback plan（Ops 未落实时切换）

> [!warning] 触发条件
> §1.4 Day-1 18:00 / Day-2 18:00 Ops binary gate 未过 → 自动进入此 plan。**不要混合 lean2.1 主线和 §1B**。

### 1B.1 §1B 与主线的关键差别

| 维度 | 主线 lean2.1 | §1B solo-fallback |
|------|-------------|-------------------|
| 时长 | 5 周 | 6 周（多 1 周 buffer） |
| 精修目标 | 10-13 篇 | **6-8 篇** |
| 工具数 | 4 skill + 3 bin | **2 skill + 1 bin**（content-draft + cta-inject + publish-backfill）|
| wzb 红线 | 18h/周 | **20h/周**（接受单人 +2h）|
| 砍掉的工具 | — | `/gg-keyword-mine`（手工 brainstorm 10 词）+ `/gg-distribute-draft`（手工 4 平台 2-3 候选）+ `bin/event-export`（wzb 手工跑 GSC/GA4 csv）+ `bin/seo-gate-scan`（手工 lighthouse）|
| 砍掉的 SOP | — | 5 SOP 全砍（无 Ops 接）|
| Ops 工作 | 5-8h/周 | 0h（wzb 全接）|
| Reddit / 社媒 | Ops 执行 | wzb 1 篇/周轻度发 |
| AI 引用监测 | Ops 周二跑 | wzb 月底一次性扫 |
| Day 60 目标 | ≥3 Top 10 + ≥3 AI 引用 | **≥2 Top 10 + ≥1 AI 引用**（调低）|

### 1B.2 §1B 6 周里程碑

| 周 | 主线工作 | 精修 | wzb 工时 |
|----|---------|------|---------|
| Week-1 | facts-audit + 第 1 篇 standard-setting 8h + Claude spike 4h | 1 篇 | 18h |
| Week-2 | gg-lib 4 模块 + manifest schema lock + sanitizer fixture | 1 篇 | 18h |
| Week-3 | `/gg-content-draft` ship + 第 2-3 篇用工具 | 2 篇 | 20h ⚠️ |
| Week-4 | `bin/publish-backfill` ship + 第 4 篇 | 1 篇 | 18h |
| Week-5 | `/gg-cta-inject` ship + 第 5-6 篇 | 2 篇 | 18h |
| Week-6 | 稳态 + 月度 KPI + Day 30 retro | 1-2 篇 | 16h |

**6 周累计**：wzb 108h + Ops 0h = 108h；精修 8 篇（中位）

### 1B.3 §1B 失败保护

- 任一周 wzb > 20h → 停精修，只产 1 篇/周维持基础
- Week-3 `/gg-content-draft` ship 失败 → Week-4 续，Week-5 砍 cta-inject 推 v1.3
- Day 60 < 2 Top 10 + < 1 AI 引用 → wzb 决定是否进 office-hours 重新评估 astrologywiki 项目

### 1B.4 何时回主线

- Ops 在 Week-2/3 才落实 → 不切换；保持 §1B（避免切换成本）
- Ops 在 Day 30~60 间落实 → Week-6 起按主线 lean2.1 节奏接，但目标降至 8-10 篇 5 周

---

## §2 Week-1（产能 baseline + 自检环境，v1.1.2 诚实化砍载到 ~16h）

> [!info] Week-1 主线（v1.1.2 砍载）
> wzb ~16h（不顶红线，留 2h buffer）；**1 篇 standard-setting 精修建质量标准**；**2 份 SOP**（M9 + Monday；Reddit 推 W2、ai-monitor 推 W2、social-distribute 推 W3）；周四 morning 4h Claude spike（不放周五避免 fried-head 自检）；Ops 接受培训。

### 2.1 Week-1 wzb 工时分配（v1.1.2 诚实化 ~16h，承认 standard-setting 教学增量）

```
 8h  内容产出：第 1 篇 standard-setting 8h（含 Ops shadow 教学增量 ~3h 真实分摊）+ 第 2 篇推 W2
 1h  运营协调（Ops onboarding 同步 + brand voice 对齐）
 0h  工程管理（Week-1 还没起工具）
 7.5h 决策/PGB：facts-audit 2h + 2 SOP 写 1h（M9+Monday）+ Claude spike 4h + spike retro 0.5h
────
~16.5h ≤ 18h 红线 ✅（留 1.5h buffer 应对突发；不再 "暗中加 3h 教学增量"）
```

**v1.1.2 算式说明**（autoplan R3 Subagent B P0-1 修正）：
- **v1.1 (lean2.1) 误算**：把 standard-setting 的 "shadow 教学增量 3h" 暗中塞回 8h 内 → declared 18h，real ~24h。
- **v1.1.2 诚实化**：standard-setting 8h **包含** 教学增量分摊（不再拆出来再加回去）；第 2 篇 + Reddit SOP 推 W2 让数字真闭合。
- Week-1 精修：**1 篇**（standard-setting），不是 2 篇。
- Week-1 SOP：**2 份**（M9 + Monday；30 min/份 = 1h），不是 3 份。Reddit SOP 推 W2 起草（30 min）。
- 5 周总精修：**9-12 篇**（下限 9=1+2+3+2+1，上限 12=1+2+3+3+3）。Day 60 KPI 不变（≥3 Top 10 + ≥3 AI 引用）。

### 2.2 Week-1 Ops 工时分配（2h 培训）

- 2h Ops 影子带训：wzb 写第 1 篇 standard-setting 精修时 Ops 在旁观，wzb 解释精修工序（Entity Passport / Friction / Phase 1 取证 / Tier 评估）
- **注**：autoplan operator H3 警告 shadow training 真实 wzb 时间 ≈ Ops 时间 × 1.5。Ops 2h shadow → wzb 真实投入 ~3h（已部分计入第 1 篇 standard-setting 8h 预算的"教学增量"）

### 2.3 Week-1 day-by-day（wzb 视角，v1.1.2 砍载重排）

| 日 | 主要工作 | 工时 | 阻塞 |
|----|---------|------|------|
| Mon | 第 1 篇 standard-setting 精修开工：Entity Passport + Friction 取证 + Phase 1 schema.org | 4h | — |
| Tue | 第 1 篇精修完成 + 跨模型挑战手工 1 次 + 自审 + M9 自跑做 SOP 范本 | 4h | — |
| Wed | facts-audit.md 跑 binary（autoplan F4，2h）+ Ops onboarding 1h + buffer ~1h | ~3h | facts-audit 阻塞 Week-2 |
| **Thu morning** | **4h Claude spike**（fresh head，不放周五避免 fried-head 自检）| 4h | spike binary 决定 Week-2 范围 |
| Thu afternoon | 2 SOP 写 1h（M9 + Monday；Reddit 推 W2）+ spike retro 0.5h | 1.5h | SOP 阻塞 Week-2 Ops M9 影子 |
| Fri | buffer / 应急 / W2 备稿 | ~0-2h | — |

> [!info] v1.1.2 Friday 留 buffer
> 砍掉第 2 篇精修 + Reddit SOP 后，Friday 主动留 buffer。Mon-Thu 任一日超工时 → Fri 吸收；都按计划 → Fri 给 Week-2 准备 2 篇精修选材 + 关键词 brainstorm。

### 2.4 Week-1 必交付清单

#### 2.4.1 精修内容（v1.1.2 砍到 1 篇 standard-setting）

- [ ] **第 1 篇精修：standard-setting**（8h 预算，**含** Ops 影子教学增量 ~3h 真实分摊；v1.1.2 不再额外加 3h）
  - 含 Entity Passport（≥6 源 + 5 角度）
  - 含 Friction 取证（≥3 真 user quotes）
  - 含 Phase 1 schema.org（Article + FAQPage + Citation 三类注入）
  - 含跨模型挑战手工 1 次（codex 提 ≥3 objection，wzb resolved 全部）
  - 含 M9 完整跑通（wzb 自跑做 Ops M9 SOP 范本）
  - **acceptance check before publish**：wzb 自问"这篇会不会被 Perplexity 引用？" 若答 yes → 发布；若 no → 改到 yes
  - manifest 记录 review_duration_min + accepted_without_edits + wzb_codex_objections_resolved（建立 T1/T2 基准）
- [ ] ~~第 2 篇精修~~（v1.1.2 推 W2，理由：autoplan R3 Subagent B P0-1 算式诚实化；W2 已计入"2 篇精修"，含此推迟件）
- [ ] ~~第 3 篇精修~~（lean2.1 已砍）

#### 2.4.2 facts-audit.md（2h，autoplan F4 + lean2.1 H3 binary 定义）

> [!warning] lean2.1 校准：facts-audit "全绿" 改为 automated diff 断言
> "5 份 JSON 无 contradiction" 是 human-judgment（autoplan H3 theater 警告）。lean2.1 改为**预写断言 + 自动 diff**：每条断言 binary pass/fail，<100% pass → Week-2 gate 失败。

- [ ] `oracle_events.json` — AST parse `/Users/wzb/Code/oracle/services/analytics.ts` 全部 trackEvent 事件名 + 出现位置（file path + line + commit SHA）
- [ ] `cta_map_events.json` — Sheets CTA Map sheet E 列（GA4 事件白名单事实源）当前所有 event 名（手工 export 或 Sheets API 读）
- [ ] `ga4_observed_events.json` — GA4 Data API 拉过去 30 天真实发生的事件名
- [ ] `sheet_schema.json` — keyword-sheet-setup.gs 解析所有列（A-Y）+ 公式列硬禁清单（J/K/M/N/O/R/S/U）
- [ ] `plan_claims_check.md` — 把 PRD/Tech 里说"oracle 已有 X"的所有断言贴 SHA + 行号（防 Q-NEW-6 class drift）

**预写断言清单（lean2.1，必须在跑 facts-audit 前列出）**：
1. CTA Map E 列 events SET == oracle/services/analytics.ts trackEvent names SET（set 相等性，自动 diff）
2. newsletter_submit_success 在 oracle commit 546ae6d / NewsletterSection.tsx:54 存在（Q-NEW-6 已 closed 复核）
3. GA4 Data API 30 天观察到的事件 ⊇ CTA Map E 列声明事件（observed superset of declared）
4. keyword-sheet-setup.gs 公式列硬禁清单 == J/K/M/N/O/R/S/U（无新增/缺失）
5. PRD 现状表"GA4 ✅已埋" 与 GA4 Data API 实测一致（≥5 事件类型出现 ≥1 次）

**Severity 分级**：
- **CRITICAL** 断言（#1, #2, #4）失败 → Week-2 工程 stop，先修；不允许 ship `/gg-keyword-mine`
- **HIGH** 断言（#3）失败 → 允许 Week-2 开工但 Week-3 ship 前必须修
- **LOW** 断言（#5）失败 → 只记账，不阻塞

#### 2.4.3 Ops Onboard SOP（v1.1.2 改：Week-1 只 2 份，剩 3 份后续）

每份按 [[G-GenGrowth-MVP-OpsPM-PRD-v1.2-lean]] §19.2 的 6 项内容写（触发条件 / 前置 / 步骤 / 完成标准 / 报告格式 / fallback）。

**Week-1 写 2 份**（1h 预算，30 min/份 真实节奏，v1.1.2 砍 Reddit SOP 推 W2）：
- [ ] `ops-sop-m9-publish.md` — M9 git mechanics 9 步操作（wzb 自跑过第 1 篇后写）
- [ ] `ops-sop-monday-data.md` — 周一手工拉 GSC/GA4 + 数据填表 + 行为 KPI 自查（Week-4 `bin/event-export` ship 后再升级）

**Week-2 写 2 份**（1h，v1.1.2 加 Reddit）：
- [ ] `ops-sop-reddit.md` — Reddit 候选选 + 发 + 互动 + 规则避坑（v1.1.2 从 W1 推迟）
- [ ] `ops-sop-ai-monitor.md` — AI Overview / Perplexity 引用监测方法（Q-LEAN2-3 落地后写）

**Week-3 写 1 份**（30 min，`/gg-distribute-draft` 模板可起草，工具 Week-5 ship 时再 finalize）：
- [ ] `ops-sop-social-distribute.md` — 4 平台社媒发布执行 + UTM 校验

#### 2.4.4 Thursday morning 4h Claude 工程 spike（autoplan F6 + lean2.1 binary gate）

> [!warning] 这是 Week-2 gate（lean2.1 改为 Thursday morning fresh head）
> 4h 内必须跑过最薄闭环。**lean2.1 改为 binary pass/fail**（autoplan H1 反对 fuzzy 三档树）。

**Binary pass criteria（同时满足）**：
- [ ] CLI 骨架可执行（接 `--dry-run` flag）
- [ ] config/astrologywiki.json + config/_gg.env 解析跑通
- [ ] Sheets fake client 写一个内存版（不接 prod）
- [ ] Sheets real dry-run：1 个 read（读 keyword 主表行 1）+ 1 个 append（写一行到测试 sheet）
- [ ] runs 表 append：started/finished 各写一行
- [ ] formula column guard：尝试写 J 列 → 抛 FormulaColumnViolation
- [ ] 一条 vitest pass（最薄场景：fake sheets append 行）
- [ ] **honest self-check**: wzb 写 3 句话 "我会不会赌 $500 这个闭环撑住 `/gg-keyword-mine` Week-2 ship？" Yes/No

**Pass = 全部 7 项 + Self-check Yes**：Week-2 全范围（gg-lib 4 模块 + `/gg-keyword-mine`）
**Fail = 任意 ≤6 项 / Self-check No**：Week-2 砍到 2 lib + 0 工具（base-client + sheets-client + formula guard + runs append + 1 fake test + 1 real dry-run），`/gg-keyword-mine` 推 Week-3
**Catastrophic（manage > 5h 仍未跑 closure）**：Week-2 砍到 1 lib + facts-audit 二次复核 + wzb 重评 lean2.1 整体节奏

**为什么 Thursday morning not Friday EOD**：autoplan H1 警告，"22h 累的人在周五傍晚自己给 spike 打分" = 最差时机。改 Thursday morning fresh head；spike 失败有 Friday 余地调整 Week-2 plan。

### 2.5 Week-1 Gate（周五 17:00 review，v1.1.2 砍载重定义）

- [ ] facts-audit.md 0 CRITICAL contradiction（5 条断言中 #1/#2/#4 全 pass）
- [ ] **2** 份 Ops SOP（M9 + Monday；v1.1.2 砍 Reddit 推 W2）完成
- [ ] Claude spike binary 通过（7 项 + self-check Yes）
- [ ] **1 篇精修发布**（standard-setting；v1.1.2 砍第 2 篇推 W2）
- [ ] 第 1 篇 standard-setting accepted by wzb（"会被 Perplexity 引用" 自检 Yes）
- [ ] wzb 实际工时 ≤ 18h（v1.1.2 计划 ~16h，留 2h buffer；如 > 18h 触发 §7 降级）

---

## §3 Week-2（gg-lib + `/gg-keyword-mine` + manifest schema lock + 多语言 sanitizer fixture 前移）

> [!info] Week-2 主线（lean2.1 校准）
> Claude Code 起 gg-lib 4 模块 + `/gg-keyword-mine` MVP + **manifest schema JSON 锁定**（避免 W3 写 content-draft 时 schema 仍流动）+ **多语言 sanitizer fixture**（前移自 Week-3，因为是 sanitizer-level test 不是 content-draft-level test）+ ai-monitor SOP 写完（Q-LEAN2-3 落地）；wzb manage 4h；Ops 影子带训 M9 + Monday 数据复盘上手。

### 3.1 Week-2 wzb 工时（17h，lean2.1 重算）

```
 9h  内容产出：2 篇精修（依托 Week-1 末备稿）
 2h  运营协调（Ops 影子带训 M9 + Monday 复盘带训 1h；shadow training true 加成 ~3h 已在 9h 内容时间内分摊）
 4h  工程管理：4h manage（不再有 "Week-1 顺延 spike 2h"，spike 已在 Week-1 Thursday 完结）
 2h  决策/PGB（关键词 brainstorm 启动 + Q-LEAN2-3 决策 + ai-monitor SOP 0.5h）
────
17h
```

**lean2.1 数字闭环**：Week-1 spike 4h 已完整算在 Week-1 Thursday，Week-2 不再有 "spike 顺延 2h"。修复 plan v1.0 的 19h vs 17h 自相矛盾。

### 3.2 Week-2 Ops 工时（4h）

- 2h：跟 wzb 跑 M9 影子带训（看完整流程，先不独立跑）
- 1h：Monday 数据复盘带训（wzb 演示手工拉 GSC/GA4 csv + 填复盘表）
- 1h：关键词主表 P 列分桶 review（lean2 §4.1，跑完 `/gg-keyword-mine` 后看 Top 15 词）

### 3.3 Week-2 工程交付（Claude Code）

#### 3.3.1 gg-lib 4 模块（lean2 §7.2）

- [ ] `gg-lib/base-client.ts`（retry + token bucket + circuit breaker + Result<T, E>）
- [ ] `gg-lib/sheets-client.ts`（batchUpdate + 公式列禁写 + 200 行批次 + runs 表 append）
- [ ] `gg-lib/cost-tracker.ts`（仅 `--max-cost-usd` 拦截 + **`bin/cost-summary --week / --month` 报告器**，lean2.1 新增以避免月底才发现超支）
- [ ] `gg-lib/sanitizer.ts`（allowlist + prompt injection 剔除 + PII 5 类）

#### 3.3.2 `/gg-keyword-mine` MVP（GEO 取向）

- [ ] CLI 入口 + flag 解析（含 `--geo-mode --target-opportunities 15`）
- [ ] Phase 1-7 跑通（lean2 §4.1）
- [ ] DataForSEO Labs / SERP fixture 落档
- [ ] Phase 4 AI Overview 风险预判（T 列 `未查 (预判:⚠️疑似)`）
- [ ] Phase 5 GEO 机会评分（Y 列 1-10）
- [ ] Sheets append 只动手动列（A-I + 可选 L/T + Y）
- [ ] runs 表 append 含 `geo_opportunities_count`
- [ ] `valueInputOption=RAW` 强制（autoplan F5）
- [ ] FormulaColumnViolation 单测 3 种 range 格式过

#### 3.3.3 manifest schema JSON 锁定（lean2.1 新增，autoplan H6）

> [!warning] Week-3 `/gg-content-draft` 消费此 schema，必须 Week-2 先锁定
> 否则 W3 写 content-draft 时 schema 仍流动，W4 publish-backfill `--confirm` 才发现字段不齐 → 回填 = wzb 额外工时

- [ ] `config/manifest.schema.json` 写完（JSON Schema 形式）
- [ ] 字段全集：page_id / run_id / content_hash / idempotency_key / state_machine_state / schema_org_injected / codex_challenge_ran / codex_objections_raised / wzb_codex_objections_resolved / review_duration_min / accepted_without_edits / tier / template / target_keyword / cost_usd
- [ ] `--print-schema` 自动从 JSON Schema 派生
- [ ] vitest schema contract test pass

#### 3.3.4 多语言 sanitizer fixture（lean2.1 前移，autoplan S2）

> [!warning] 前移理由
> 这是 sanitizer-level test，不是 content-draft-level test。Week-3 `/gg-content-draft` 消费 hardened sanitizer 而不是同周打磨 sanitizer。

- [ ] `tests/fixtures/sanitizer-multilang/` 目录
  - [ ] 英文 `ignore previous instructions`
  - [ ] 中文 `忽略以上指示`（含全角标点变体）
  - [ ] 韩文 `이전 지시를 무시하세요`
  - [ ] 阿拉伯文 `تجاهل التعليمات السابقة`
  - [ ] base64 编码
  - [ ] 零宽空格
  - [ ] leetspeak
- [ ] sanitizer.ts 必拒全部 fixture（vitest 全 pass）
- [ ] subdomain 严格 allowlist 单测（old.reddit.com / np.reddit.com / quora.com/q/... 显式列出，不能 wildcard）

#### 3.3.5 测试矩阵（lean2 §7.3）

- [ ] Schema contract（`--print-schema` 对齐 manifest.schema.json）
- [ ] Sheets fake 公式列禁写 + RAW 强制断言
- [ ] DataForSEO 每日 smoke（1 seed × 1 SERP < $0.01，检测 API drift，autoplan F7）

### 3.4 Day 3-4 manage 自检（强制 gate，lean2.1 改 vertical-slice 判定，autoplan H1）

> [!warning] Wednesday 17:00 强制 check
> lean2.1 改：不看模块数（可以被空壳模块作弊），看 **vertical slice 是否打通**。

**Vertical slice 必跑通**：
- [ ] base-client + sheets-client + formula guard + runs append + 1 fake test + 1 real dry-run
- [ ] manage 工时记录：____ h

**判决（lean2.1 binary）**：
- **vertical slice 跑通 + manage ≤ 4h** → Week-2 全范围保留
- **vertical slice 跑通 + manage 4-5h** → Week-2 砍 sanitizer fixture 前移到 Week-3（spike 多语言部分）
- **vertical slice 未跑通**（任一缺失）→ Week-2 只 ship 2 lib + 0 工具，`/gg-keyword-mine` 推 Week-3

### 3.5 Week-2 必交付（精修内容 + ai-monitor SOP）

- [ ] 第 3 篇精修发布（首批用 standard，含 manifest review_duration_min + accepted_without_edits）
- [ ] 第 4 篇精修发布
- [ ] Ops 跟跑 1 次 M9 完整流程（影子，不独立）
- [ ] Ops 跟跑 1 次 Monday 数据复盘（影子）
- [ ] `ops-sop-ai-monitor.md` 写完（Q-LEAN2-3 决定方式后；30 min 预算）
- [ ] `ops-sop-reddit.md` 写完（v1.1.2 从 W1 推迟；30 min 预算）

### 3.6 Week-2 Gate（周五 17:00）

- [ ] gg-lib 4 模块全跑通
- [ ] `/gg-keyword-mine` MVP --dry-run pass
- [ ] **manifest schema JSON 锁定**（vitest contract test pass）
- [ ] **sanitizer 多语言 fixture 全拒**（vitest pass）
- [ ] 2 篇精修发布
- [ ] Ops M9 + Monday 影子各 1 次完成
- [ ] ai-monitor SOP 完成
- [ ] Reddit SOP 完成（v1.1.2 W1 推迟件）
- [ ] wzb 工时 ≤ 17.5h（v1.1.2 加 W1 推迟的第 2 篇 + Reddit SOP，挤进 W2 决策/PGB 2h）

---

## §4 Week-3（`/gg-content-draft` 精修工具）

> [!info] Week-3 主线
> 精修工具 ship（合并 MVP-1/2）+ 多语言 injection fixture + 关键词 brainstorm；Ops 开始接 M9 + 数据复盘。

### 4.1 Week-3 wzb 工时（18h 顶红线）

```
 9h  内容产出：3 篇精修（首批用 /gg-content-draft）
 2h  运营协调（Ops 数据复盘上手）
 5h  工程管理（manage /gg-content-draft ship）
 2h  决策/PGB（10-15 真机会词 brainstorm + AI 引用监测启动）
```

### 4.2 Week-3 Ops 工时（5h）

- 1.5h：M9 git mechanics（Ops 独立跑 3 篇，wzb PR review 介入 ~15 min）
- 1.5h：Reddit 候选选发 + 互动（Ops 独立跑，wzb brand voice 拍板候选）
- 1h：周一 event-export 跑 + 数据填表（首次独立）
- 1h：周二 AI 引用监测（Ops 用 perplexity.ai 手搜 + Google AI Overview 看）

### 4.3 Week-3 工程交付

#### 4.3.1 `/gg-content-draft`（精修工具，lean2 合并 MVP-1/2，§4.2）

> [!info] lean2.1 校准
> 消费 Week-2 锁定的 `config/manifest.schema.json` 和打磨过的 `sanitizer.ts`（不再同周打磨）

- [ ] Phase 1 取证（准入 + Entity + Friction/Logic）+ Phase 1 抽取 schema 校验（sonnet output 严格 enum/numeric，自由 string 拒绝，autoplan F3）
- [ ] Phase 2 文稿生成（Anthropic Claude sonnet）+ `--pause-after-phase2 true` 默认开
- [ ] Phase 3 跨模型挑战（codex challenge，T1 默认开）
- [ ] manifest 写入按 Week-2 锁定的 schema（idempotency_key / state_machine_state / schema_org_injected / codex_challenge_ran / codex_objections_raised / wzb_codex_objections_resolved 等全集字段）
- [ ] WriteSequence 状态机化（planned → started → staged → sheet_written → published → backfilled → reconciled，autoplan F5）
- [ ] content-addressed idempotency key（`{page_id}_{run_id}_{content_hash}`）
- [ ] 6 红线 ≥95% pass
- [ ] T1 budget ≤ $1.5、T2 ≤ $0.5

#### 4.3.2 ~~多语言 injection fixture~~（lean2.1 前移至 Week-2 §3.3.4）

> 已前移至 Week-2 §3.3.4。Week-3 `/gg-content-draft` 直接消费 hardened sanitizer。

#### 4.3.3 人工关键词 brainstorm（wzb 决策，§4.1）

- [ ] 跑 `/gg-keyword-mine --geo-mode --target-opportunities 15`
- [ ] Ops 在 P 列分桶 review（Top 15 词）
- [ ] wzb 拍板 ★ 标的词（10-15 真机会词）
- [ ] cluster_id 全人工填（Tech §12 已知问题 #2，可接受）

#### 4.3.4 social-distribute SOP 起草（Week-3 写，Week-5 `/gg-distribute-draft` ship 时 finalize）

- [ ] `ops-sop-social-distribute.md` 起草版（30 min，按 PRD §19.2 6 项内容；finalize 等 Week-5 工具 ship）

### 4.4 Week-3 必交付（精修内容）

- [ ] 第 5 篇精修发布（首批用 `/gg-content-draft`）
- [ ] 第 6 篇精修发布
- [ ] 第 7 篇精修发布

### 4.5 Week-3 Gate（周五 17:00）

- [ ] `/gg-content-draft` --dry-run 全 phase pass
- [ ] 3 篇精修发布
- [ ] Ops 独立跑 3 次 M9（wzb 仅 PR review）
- [ ] AI 引用监测启动（**Ops 覆盖 ≥95% 精修文章**，对齐 PRD §6.2 措辞，lean2.1 修正"100%"过紧）
- [ ] social-distribute SOP 起草完成
- [ ] wzb 工时 ≤ 18h

### 4.6 Week-3 末降级触发

> [!warning] Week-3 末 AI 引用 0 篇 → wzb retro
> 调整精修 SOP：Entity Passport 取证深度 / Friction 选材角度 / 内链布局。
> 注：Week-3 才启动监测，第 3 篇之前的文章可能仍在 indexing 期，0 引用不等于失败信号；连续 2 周 0 引用才触发 retro。

---

## §5 Week-4（3 工具 ship + Ops 全接，lean2.1 砍载）

> [!warning] lean2.1 关键重排（autoplan 共识 C2）
> 原 plan v1.0 Week-4 = 5 件 ship + 3 篇 + 20h 是 fantasy schedule。lean2.1 砍 5→3（保 critical path：publish-backfill + cta-inject + event-export MVP），剩下 `/gg-distribute-draft` + `bin/seo-gate-scan` 推 Week-5。wzb 工时降到 17h ≤ 18h 红线。

### 5.1 Week-4 wzb 工时（17h，lean2.1 不破红线）

```
 7h  内容产出：2-3 篇精修（精修产能稳态）
 2h  运营协调（Ops 已接大头）
 6h  工程管理：manage 3 件 new ships（每件 2h，含 review + 测试 + 修边界）
 2h  决策/PGB（cost burn-rate 月底前 check + Day 14 节点数据 review）
────
17h ≤ 18h 红线 ✅
```

**lean2.1 数字闭环**：原 plan 7h manage 5 件 = 1.4h/件（autoplan H 不可信）；改 6h manage 3 件 = 2h/件，符合 review + 测试 + 修边界真实成本。

### 5.2 Week-4 Ops 工时（6h，必须真接到位）

- 1.5h：M9（全接，wzb 仅 PR review 5 min/篇）
- 0.5h：周一数据复盘填表（**Week-4 周一仍手工拉 GA4/GSC csv**——Codex finding：`bin/event-export` Fri 才 ship，circular dependency 已显化；**Week-5 起**才用脚本）
- 0.5h：周二 AI 引用监测
- 1.5h：Reddit 运营
- 1.5h：社媒选发执行（手工 4 平台 × 2-3 候选；`/gg-distribute-draft` 工具 Week-5 才 ship）
- 0.5h：关键词主表分桶 review（月初一次）

### 5.3 Week-4 工程交付（3 件 ship + 串行 release train）

> [!info] lean2.1 串行 release train
> 原 plan 5 件并行 ship 忽略共享依赖（publish-backfill 依赖 manifest 字段，event-export 依赖 runs schema）。lean2.1 改为串行：
> **Mon-Tue ship #1 `bin/publish-backfill`**（解锁 Ops M9 自动化）
> **Wed-Thu ship #2 `/gg-cta-inject`**（newsletter funnel）
> **Fri ship #3 `bin/event-export` MVP**（无 `--catch-up`，让 Ops 周一能用）

#### 5.3.1 `bin/publish-backfill`（Week-4 #1 ship，Mon-Tue）

> [!warning] lean2.1 修正（autoplan S1 红线警告）
> 原 plan 写"M9 SOP 9 步自动化（git tag / Sheets W 列回填 / runs 表 finished）"违反 Tech §3.6 红线"脚本绝不动 git"。lean2.1 改为"辅助回填 + 校验，不自动执行任何 git/PR/merge/tag 操作"。

- [ ] **辅助 M9 SOP 9 步的步骤 4-9**（git 操作步骤 1-3 wzb/Ops 手工跑，不自动化）：
  - [ ] 校验 manifest 强制字段（review_duration_min / accepted_without_edits / wzb_codex_objections_resolved 非空，[L-20]）
  - [ ] 注入 schema.org 三类 frontmatter（Article + FAQPage + Citation）
  - [ ] Sheets W 列 URL 回填
  - [ ] runs 表 `finished_at` + `status='completed'` 写入
- [ ] `--confirm` 校验 manifest 强制字段（不通过则阻止 Sheets 写）
- [ ] `--audit` 扫选题登记表 W 列漏填
- [ ] **明禁**：脚本不调用 git / gh / oracle 任何写操作

#### 5.3.2 `/gg-cta-inject`（Week-4 #2 ship，Wed-Thu）

- [ ] CTA Map sheet 读 **E 列（GA4 事件白名单事实源，对齐 Tech §3.7 / §4.3）**
- [ ] 文章末注入 CTA（**Q-NEW-6 closed**：oracle 已落 newsletter funnel 5 事件 attempt/success/existed/rate_limited/error，commit 546ae6d / NewsletterSection.tsx）；`paid_signup` 不在 oracle 当前 17 个 trackEvent 列表内，**Week-4 ship 前**先由 Week-1 facts-audit AST parse 验证；未验证则 cta-inject 仅注入已 trackEvent 落地的事件名
- [ ] UTM 参数自动构造
- [ ] manifest 记录注入位置 + CTA 类型

#### 5.3.3 `bin/event-export` MVP（Week-4 #3 ship，Fri；无 `--catch-up`）

> [!info] lean2.1 砍 `--catch-up`
> `--catch-up` 自动识别缺失周需要复杂状态管理，Week-4 没空。MVP 只支持 `--week 2026-W22` 手工指定周；`--catch-up` 推 Week-6+

- [ ] 拉 GA4 Data API + GSC searchAnalytics.query
- [ ] 数据填入复盘表（按 page_id 维度）
- [ ] `--week YYYY-Www` 手工指定周（无 `--catch-up`，推 Week-6+ enhancement）
- [ ] < 60s 跑 30 页（lean2 精修线规模，对齐 Tech §10.3 现代数字）

#### 5.3.4 ~~`/gg-distribute-draft`~~（lean2.1 推 Week-5 §6.3.4）

#### 5.3.5 ~~`bin/seo-gate-scan`~~（lean2.1 推 Week-5 §6.3.5）

### 5.4 Week-4 必交付（精修 + Ops 全接）

- [ ] 第 8 篇精修发布
- [ ] 第 9 篇精修发布
- [ ] 第 10 篇精修发布（可选，时间允许）
- [ ] Ops 全接 M9（wzb 退到 PR review 5 min/篇）
- [ ] Ops 全接周一数据复盘 + 周二 AI 监测
- [ ] **首批 Day 14 节点到达**（Week-1 发的 2 篇精修真实 Day 14 = Week-3 末/Week-4 初；Week-4 末时是 Day 16-18，看收录 ≥80%）

### 5.5 Week-4 Gate（周五 17:00）

- [ ] **3 件**工具/脚本全 ship（不再是 5 件）
- [ ] 2-3 篇精修发布
- [ ] Ops 6h 实际投入达成（如 < 5h 触发 §7.4 应急）
- [ ] wzb 工时实测（如 > 18h 触发自动降级）
- [ ] **首批 2-3 篇 Day 14 收录率 ≥ 80%**（不再是 "5 篇"；数字对齐 Week-1 实际发布 2 篇）
- [ ] cost burn-rate 月底前 check：runs 表 F 列累加 ≤ $80（留 $20 buffer）

### 5.6 Week-4 失败保护

> [!warning] Week-3 末就要预判 Week-4
> - **Week-3 Ops onboard 不顺利**（独立跑 M9 < 2 次）→ Week-4 再砍工具范围（只保 `bin/publish-backfill` + `bin/event-export` MVP，`/gg-cta-inject` 推 Week-5）
> - **Week-4 任一新工具翻车** → 推到 Week-5，**同步砍 Week-5 推迟工具一件**到 Week-6（distribute-draft 优先砍，seo-gate-scan 优先砍——已无 buffer absorb）；不并行 debug
> - **wzb 工时 > 20h 任一天** → 强制停工具开发，只产内容
> - **cost burn 超 $90/月** → 暂停 T1 codex challenge 一周，月底重评算

---

## §6 Week-5（稳态运维 + 验收）

> [!info] Week-5 主线
> 稳态精修（2-3 篇）+ bug fix + 月度 KPI 自动汇总 + Day 60 准备。

### 6.1 Week-5 wzb 工时（16h，lean2.1 加 2 件推迟 ship + 数字闭环）

```
 5h  内容产出：1-2 篇精修（稳态，少 1 篇为推迟工具腾时间）
 2h  运营协调
 7h  工程管理：4h manage 2 件推迟 ship（distribute-draft + seo-gate-scan，2h/件）+ 3h bug fix + 行为 KPI 月度汇总自动化
 2h  决策/PGB（月度行为 KPI 汇总 + Day 60 准备）+ 月度回顾 review
────
16h ≤ 18h 红线 ✅
```

**lean2.1 数字闭环**：原 plan v1.0 declared 14h 但分项 6+2+2+2=12h 不闭合。lean2.1 加 2 件推迟工具 + 重新拆分项 = 真 16h。

### 6.2 Week-5 Ops 工时（5h，稳态）

- 1.5h：M9
- 0.5h：周一数据复盘（用 W4 ship 的 `bin/event-export` MVP）
- 0.5h：周二 AI 监测
- 1.5h：Reddit + 社媒（W5 ship 完 `/gg-distribute-draft` 后转为用工具跑）
- 1h：月底行为 KPI 汇总（runs 表自动算 + 周报模板 hard gate）

### 6.3 Week-5 必交付

#### 6.3.1 精修内容
- [ ] 第 11 篇精修发布（必达 10 篇底线 + 1 篇）
- [ ] 第 12 篇精修发布（可选，目标 11-12）

#### 6.3.2 稳态运维
- [ ] 手工周报跑（不再有 cron 自动）
- [ ] 手工刷新扫描（lean2 §11，不依赖 `/gg-refresh-scan`）
- [ ] bug fix 池 clean
- [ ] 月度行为 KPI 自动汇总（`bin/event-export --report behavior`）

#### 6.3.3 Day 60 准备
- [ ] AI 引用监测周覆盖率历史归档
- [ ] Top 10 / Top 50 排名快照（首批 Week-1 文章已到 Day 30 节点）
- [ ] 月度成本汇总（应 ≤ $100）

#### 6.3.4 `/gg-distribute-draft`（lean2.1 从 W4 推迟 ship）

- [ ] 4 平台 × 3 候选社媒草稿（**X (Twitter) / Threads / Reddit / Newsletter**，对齐 Tech §4.5 输出目录结构）
- [ ] subdomain 严格 allowlist（已在 Week-2 sanitizer fixture 落实）
- [ ] UTM 校验单测
- [ ] 单篇 < 5 min（精修少篇，预算松）

#### 6.3.5 `bin/seo-gate-scan`（lean2.1 从 W4 推迟 ship）

- [ ] Article / FAQPage / Citation schema.org 校验
- [ ] Technical SEO 闸门（meta / h1 / canonical / sitemap）
- [ ] 输出报告 Ops 看，wzb 拍板

### 6.4 Week-5 末验收：**Implementation Acceptance**（不是 Business Acceptance）

> [!warning] lean2.1 关键区分（autoplan H verdict）
> Week-5 末只验**产能 / 行为 / 工具**三层，**业务 KPI 必须 Day 60 验**。原 plan 标题"三层 GEO KPI 验收"误导，会出现"Week-5 通过但 Day 60 失败"盲点。

#### 6.4.1 产能验收（Week-5 末）
- [ ] 5 周累计精修发布 ≥ 10 篇（lean2.1 下限；理想 11-13）
- [ ] 周产精修 ≥ 2 篇连续 3 周
- [ ] Day 14 收录率 ≥ 80%（基于实际已到 Day 14 的文章数，至少 5-6 篇）
- [ ] 月度成本 ≤ $100

#### 6.4.2 行为验收（Week-5 末）
- [ ] wzb 实际 review 分钟数：T1 < 90 / T2 < 45 min（manifest 汇总）
- [ ] **默认通过率 < 20%**（精修线应改更多，lean2 收紧）
- [ ] 随机抽查失败率 < 10%
- [ ] M9 漏填率 < 5%
- [ ] 每周一 `bin/event-export` 实跑 5/5
- [ ] AI 引用监测周覆盖率 100%（**覆盖 ≥95% 精修文章**，对齐 PRD §6.2）
- [ ] Ops 协调健康度（周二会议 ≥ 1 次/周）
- [ ] wzb codex objections 处理率 100%（T1 必处理）
- [ ] wzb 周工时 ≤ 18h 实测达成率 5/5 周

#### 6.4.3 工具验收（Week-5 末）
- [ ] 6 红线 ≥ 95%
- [ ] Sanitizer 多语言 injection 全拒（Week-2 已落实）
- [ ] WriteSequence partial failure tests 全过
- [ ] Sheets row positional drift test 过
- [ ] facts-audit 0 CRITICAL contradiction（Week-1 已落实）
- [ ] Claude spike binary 已通过（Week-1 已落实）

> [!warning] Week-5 末通过 ≠ 项目成功
> 仅意味着"工具体系按设计 ship"。业务假设（GEO 时代 12-13 篇精修 ≥ 60 篇量产）必须 Day 60 验证。

### 6.5 Week-5 末 → Day 60 中间期（lean2.1 重写）

> [!info] Week-6~Week-9（lean2.1 加 retro gate，不再叫 buffer 期）
> 原 plan v1.0 说"buffer 期"是误导。Week-6 是 **Day 30 retro gate**，不是"无事可做"。

### 6.6 Week-6 Day 30 retro gate（lean2.1 新增，autoplan H4 + S7）

> [!warning] Week-6 是 lean2 战略假设的中点检验
> autoplan 一致警告：Week-6~Day 60 是 4 周黑洞，无工时/无 gate/Ops 合同到期/无 kill 标准。lean2.1 加 retro gate。

**Week-6 wzb 工时（12h）+ Ops 工时（5h）**

**Week-6 必做事项**：
- [ ] Day 30 retro：扫 **age ≥ 30 天的精修 cohort**（Week-1~2 发的 4 篇为主，Week-3 早发的篇可选含入；按 age 不按篇号，避免混入 Week-3 末未成熟样本——Codex finding）
  - GSC: 收录率 + impressions + 平均位置
  - GA4: 自然搜索流量 + newsletter_submit_success 事件
  - AI 引用监测：perplexity.ai + Google AI Overview 手动 query
- [ ] **Ops 合同续签**（Week-6~9 4 周延伸，5h/周 × 4 = 20h）；如未签，进 Ops 退出 fallback
- [ ] Week-6~9 稳态计划落档：2-3 篇/周精修 + 周一/周二 Ops 节奏不变

**Day 30 信号 binary 判决**（决定 Day 60 路线，v1.1.2 judge = Lynne 不是 wzb）：

> [!warning] v1.1.2 关键修正
> **judge = Lynne**（Day-0 #4 sign-off）。wzb 准备数据（GSC 收录率 + 排名 + GA4 流量 + AI 监测截图），交给 Lynne 看；**Lynne 按下表 trigger 行动档**，wzb 不投票。理由：autoplan R3 Subagent B P0-2 — wzb 自审自判 = sunk-cost 永动循环。

| 信号档 | 标准 | 行动 |
|--------|------|------|
| ✅ 正向 | ≥1 篇进 Top 50 + ≥1 篇有 AI Overview 出现（不必引用）| 续 Week-6~9 稳态，Day 60 期待 ≥3 Top 10 + ≥3 AI 引用 |
| ⚠️ 微弱 | 0 篇 Top 50 但 Ops 监测 ≥3 篇有 SERP feature snippet | 续，但调整选词（弃强 SERP，重 GEO 机会分 ≥8） |
| ❌ 0/3 | 0 Top 50 + 0 AI 任何形式露出 | **Lynne trigger /office-hours retro**：lean2 GEO 假设可能错；评估 (a) 重选 vertical / (b) 改回量产试 / (c) 终止 astrologywiki 项目 |

### 6.7 Day 60 业务验收（lean2.1 Business Acceptance）

> [!warning] 这是 lean2 战略假设的真验收
> "12-13 篇精修 ≥ 60 篇量产 PV" 假设的成立或证伪。

#### 6.7.1 Day 60 成功标准
- [ ] **Top 10 排名（核心 KPI）**：≥ 3 篇精修进美国 GSC Top 10
- [ ] **AI Overview / Perplexity 引用**：≥ 3 篇被 AI 答案引用
- [ ] Top 50 排名：≥ 10 篇进 Top 50（含 Top 10）

#### 6.7.2 Day 60 失败时的 kill criterion（v1.1.2: judge = Lynne，删 wzb self-judge）

> [!warning] v1.1.2 关键修正
> **judge = Lynne 不是 wzb**（Day-0 #4 sign-off）。wzb 准备 Day 60 数据包；**Lynne 按下表 trigger 决策档**，wzb 不投票。理由：autoplan R3 Subagent B P0-2 — judge=被告的 partial-success 逃生通道在 wzb 自审下 90% 概率走"再给 4 周"。

| Day 60 结果 | 决策（Lynne trigger） |
|-------------|----------------------|
| ≥3 Top 10 + ≥3 AI 引用 | ✅ lean2 thesis 成立，进 v1.3（产品 #2 onboard + scale） |
| ≥1 Top 10 + ≥1 AI 引用 | ⚠️ partial success；**Lynne 决定**：续 Day 90 vs 直接进 v1.3 stage。wzb 不投票。 |
| 0 Top 10 + 0 AI 引用 + ≥3 Top 50 | ⚠️ thesis 部分对；**Lynne 决定**：调整选词 + entity 取证 + 持续 30 天 vs trigger §1B retro。wzb 不投票。 |
| **0/3 全 0** | ❌ thesis 错；**Lynne trigger /office-hours**：评估 (a) GenGrowth 转其他 vertical / (b) 暂停 GenGrowth + pivot 个人重心。wzb 给数据 + 听 office-hours 结论 + 接受。|

**这是预先承诺，不是建议**：v1.1.2 把 wzb 从 judge 角色撤出来，避免 sunk-cost armor。Day-0 #4 commit conversation 是这条 enforcement 的法律基础。

---

## §7 自动降级机制（lean2.1 校准）

> [!warning] 红线触发后立即执行
> 这是合同条款，不是建议。**lean2.1 关键修正**：Ops 不可用 ≥1 周时**不要**放宽 wzb 红线到 24h（lean2 已证伪），而是降 scope。

### 7.1 wzb 工时红线

| 触发 | 立即动作 |
|------|---------|
| 任一周 wzb > 18h | 停工具开发，只产精修内容（自动降级）|
| 任一天 wzb > 6h | 当周已超载，跳到当周末提前 review |
| 连续 2 周 > 18h | 触发"Ops 不够用"应急路径（§7.4）|
| **Week-4 实际 > 18h（重大警告）** | 推延 Week-4 1-2 件工具到 Week-5 / Week-6，不要硬扛 |

### 7.2 Claude spike 失败（lean2.1 binary）

| 触发 | 立即动作 |
|------|---------|
| Week-1 Thursday spike：7 项 binary check 任一未过 | Week-2 砍到 2 lib + 0 工具，`/gg-keyword-mine` 推 Week-3 |
| Week-1 spike self-check 答 No（不赌 $500） | 同上，Week-2 砍范围 |
| Catastrophic（manage > 5h 仍未跑 closure）| Week-2 砍到 1 lib + facts-audit 二次复核 + wzb 重评 lean2.1 整体节奏 |
| Week-2 Day 3-4 vertical slice 未跑通 | Week-2 只 ship 2 lib + 0 工具，`/gg-keyword-mine` 推 Week-3 |
| Week-4 任一新工具翻车 | 推到 Week-5，其他工具照常（已对齐 Week-4 lean2.1 3 件 ship） |

### 7.3 GEO 信号 0（lean2.1 加 Day 30 retro + Day 60 kill criterion）

| 触发 | 立即动作 |
|------|---------|
| Week-3 末 AI 引用 0 篇（首 3 篇精修）| 注：Ops 才启动监测，0 引用不等于失败信号；连续 2 周 0 引用才触发 retro |
| **Week-4~5 连续 2 周 0 AI 引用** | wzb retro 调整精修 SOP（取证深度 / 选材角度 / 内链布局）|
| **Day 30 retro（Week-6）**：0/3 全 0 | 进 /office-hours retro（详见 §6.6 判决表）|
| **Day 60 0/3 全 0** | 触发 §6.7.2 kill criterion 判决 |

### 7.4 Ops 中途退出（lean2.1 修正：不放宽红线，降 scope）

| 触发 | 立即动作 |
|------|---------|
| Ops 不可用 ≥ 1 周 | **lean2.1：不要放宽 wzb 红线到 24h**（lean2 已证伪 24h 不可持续）。直接降 scope：Reddit/社媒停 1 周 + 工具开发推延 1 周 + Week-5 buffer 吸收 |
| Ops 永久退出 | **lean2.1 修正工具优先级**：保 content-draft + **event-export**（wzb solo 更需要数据） + publish-backfill；砍 cta-inject（newsletter funnel 二级）+ distribute-draft + seo-gate-scan |
| Ops 工时 < 5h/周 持续 2 周 | 协调扩 Ops 到 8h（或换 backup person，Day-0 已备）|
| Ops 在 Week-1/Week-2 无法独立 M9 | 触发 Day-1 binary gate 复评：是否切换 §1B solo-fallback |
| **Lynne sign-off 撤回**（v1.1.2 新增）| **立刻切 §1B solo-fallback** + wzb 重新 Day-0 #4 commit conversation；未恢复前不进主线 |

### 7.5 成本红线（lean2.1 措辞与 Tech §8.1 对齐）

| 触发 | 立即动作 |
|------|---------|
| 月度成本 > $90（lean2.1 提前 alert，留 $10 buffer） | wzb 决策保持还是降配；检查 `bin/cost-summary --month` |
| 月度成本 > $100 | 暂停 T1 codex challenge 一周 + wzb 拍板下月预算 |
| 月度成本 > $150 硬顶 | **阻断所有写 API**（对齐 Tech §8.1 措辞，不再说"T2 only"）|
| DataForSEO 单次跑 > $5 | `--max-cost-usd 5` 拦截，wzb 复核 |
| 周 burn > $25 | Week-2 起 `bin/cost-summary --week` 报告 Ops 周一同步看 |

---

## §8 待决问题（Q-LEAN2-*）

> 跟 [[G-GenGrowth-MVP-OpsPM-PRD-v1.2-lean]] §14 同步。完成时回填本表 + PRD。

| Q | 阻塞什么 | 推荐 | 落地时点 | 状态 |
|---|---------|------|---------|------|
| **Q-LEAN2-1** Ops 具体人选 + 时间确认 | Week-1 Ops onboard SOP 写完 | Day 0 wzb 协调 | Day-0 | ⏳ |
| **Q-LEAN2-2** 已发 5 篇精选哪几篇重写 / sunset | Week-1 内容产出 | wzb 看 5 篇内容自决 | Day-0 / Week-1 Day 1 | ⏳ |
| **Q-LEAN2-3** AI Overview / Perplexity 引用监测方式 | 行为 KPI 周覆盖率 | Week-2 Ops 用人工 + perplexity.ai 手搜 + Google AI Overview | Week-2 | ⏳ |
| **Q-LEAN2-4** SaaS hybrid（Frase 等）后续是否启动 | 不阻塞 lean2 | 全自建；Week-3 末 < 2 篇/周则 Week-4 加 Frase $45/月 | Week-3 末复盘 | — |
| **Q-LEAN2-5** Lynne Day 30/60 kill 投票权 sign-off（v1.1.2 新增）| Day-1 binary gate item 5 + §6.6 Day 30 retro + §6.7.2 Day 60 kill | Day-0 wzb 与 Lynne commit conversation，邮件/IM 存档 | Day-0 | ⏳ |
| Q-NEW-3 产品 #2 是否 60 天内 onboard | ProductConfig 抽象 | 暂定否 | Day 60 复盘 | — |
| Lead magnet 文案策略 | 不阻塞 | Week-2 末有 GSC 数据再定 | Week-2 末 | — |
| 健康类敏感主题边界 | psych safety scope | wzb 自决 | 任意 | — |

---

## §9 数据源 / 配置 / 凭据登记表

> Day-0 起逐项填写，避免到 Week-1 Day 1 再找。

| 资源 | 用途 | 位置 | 状态 |
|------|------|------|------|
| DataForSEO API key | `/gg-keyword-mine` | `_gg.env` `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | ✅ |
| Anthropic Claude API key | `/gg-content-draft` Phase 2 | `_gg.env` `ANTHROPIC_API_KEY` | ⏳ |
| OpenAI Codex API key | Phase 3 跨模型挑战 | `_gg.env` `OPENAI_API_KEY` | ⏳ |
| GCP project ID | Sheets / GSC / GA4 容器 | `_gg.env` `GCP_PROJECT_ID` | ⏳ Day-0 |
| GCP billing 状态 | enable API | GCP console | ⏳ Day-0 |
| 3 SA JSON（base64）| reader / writer / admin | Vercel env vars | ⏳ Week-1 |
| GSC property（domain）| astrologywiki.com | GSC console | ⏳ Week-1 验 |
| GA4 property ID | 行为数据拉取 | `_gg.env` `GA4_PROPERTY_ID` | ⏳ |
| 主 workbook ID | Sheets 操作 | `_gg.env` `MAIN_WORKBOOK_ID` | ⏳ |
| oracle repo path | M9 git mechanics | `_gg.env` `ORACLE_REPO_PATH=/Users/wzb/Code/oracle` | ✅ |
| Vercel project | astrologywiki 部署 | Vercel | ✅ |
| **Lynne Day 30/60 kill sign-off**（v1.1.2 新增）| §6.6 retro judge + §6.7.2 kill judge | wzb-Lynne 邮件/IM 存档 + 本文 §9 | ⏳ Day-0 |

> [!warning] 凭据安全
> - **绝不** commit 任何 API key / SA JSON 进 git
> - SA JSON 走 base64 → Vercel env vars（lean2 §7.1）
> - 本地走 `_gg.env`（已 gitignore）
> - 月度轮换 admin SA

---

## §10 工具/脚本最终输出清单（lean2.1 重排，Week-5 末验收用）

### 10.1 Skill（4 个）
- [ ] `/gg-keyword-mine`（Week-2）
- [ ] `/gg-content-draft`（Week-3）
- [ ] `/gg-cta-inject`（**Week-4** lean2.1 保留）
- [ ] `/gg-distribute-draft`（**Week-5** lean2.1 从 Week-4 推迟）

### 10.2 Bin（3 个 MVP + 1 个 enhancement）
- [ ] `bin/publish-backfill`（**Week-4** lean2.1，辅助 M9 不动 git）
- [ ] `bin/event-export` MVP（**Week-4** lean2.1，无 `--catch-up`）
- [ ] `bin/seo-gate-scan`（**Week-5** lean2.1 从 Week-4 推迟）
- [ ] `bin/event-export --catch-up` 增强（**Week-6+** 推迟）
- [ ] `bin/cost-summary --week/--month`（**Week-2** lean2.1 新增，避免月底才发现超支）

### 10.3 lib（4 个 module）
- [ ] `gg-lib/base-client.ts`（Week-2）
- [ ] `gg-lib/sheets-client.ts`（Week-2）
- [ ] `gg-lib/cost-tracker.ts`（Week-2 + cost-summary 报告器）
- [ ] `gg-lib/sanitizer.ts`（Week-2 + 多语言 fixture）

### 10.4 配置 / 数据
- [ ] `config/astrologywiki.json`（Week-2）
- [ ] `config/_gg.env`（Day-0 起填）
- [ ] `config/manifest.schema.json`（**Week-2** lean2.1 新增，schema lock）
- [ ] `runs/` 目录结构
- [ ] DataForSEO fixture（Week-1）
- [ ] GSC / GA4 fixture（Week-4，对接 `bin/event-export`）

### 10.5 文档
- [ ] `facts-audit.md`（Week-1，automated diff 形式）
- [ ] 5 份 Ops SOP（M9/Monday/Reddit Week-1 + ai-monitor Week-2 + social-distribute Week-3）
- [ ] **PRD §1.2 + §7.5.3 + §8.1 校准 patch**（Week-1 末，lean2.1 扩展自原 plan §10.5 只写 §1.2）
- [ ] **PRD §7 ASCII 工时图同步**（Week-1 末，6h 改 4h 或反之）
- [ ] **Tech §1.2 "3 skill" 措辞同步**（Week-1 末，应为 "4 skill"）
- [ ] Week-6 Day 30 retro 报告
- [ ] Day 60 业务验收报告（lean2 thesis 成立或证伪）

---

## §11 进度看板（lean2.1 拆 planned / actual + 加 Week-0/6）

> [!tip] 每周一 09:30 wzb + Ops 同步会议时填
> Ops 主填，wzb 签字。连续 2 周空 → autoplan 重 review。

### 11.1 工时看板

| 周 | wzb 计划 | wzb 实际 | Ops 计划 | Ops 实际 | gate 状态 | 当周风险 |
|----|---------|---------|---------|---------|----------|---------|
| Week-0 (Day-0/1) | 4.5h | — | 0h | — | ⏳ Day-1 Ops binary gate 5/5（v1.1.2）+ Lynne sign-off | — |
| Week-1 | ~16h ✅（v1.1.2 砍载） | — | 2h | — | ⏳ spike binary + facts-audit | — |
| Week-2 | 17.5h（v1.1.2 +W1 推迟件） | — | 4h | — | ⏳ vertical slice | — |
| Week-3 | 18h ⚠️ | — | 5h | — | ⏳ AI 监测启动 | — |
| Week-4 | 17h ✅ | — | 6h | — | ⏳ 3 件 ship + Day 14 数据 | — |
| Week-5 | 16h ✅ | — | 5h | — | ⏳ 2 件 ship + 工具验收 | — |
| **Week-1~5 累计** | **~84.5h** | — | **22h** | — | — | — |
| Week-6 retro | 12h | — | 5h | — | ⏳ Day 30 retro gate（Lynne judge）| — |
| **6 周累计**（含 Week-6）| **~100.5h** | — | **27h** | — | — | — |

### 11.2 精修发布看板

| 周 | 计划发布数 | 实际发布数 | 累计 (计划) | 累计 (实际) |
|----|----------|----------|------------|------------|
| Week-1 | 1 (standard-setting 8h；v1.1.2 砍第 2 篇推 W2) | — | 1 | — |
| Week-2 | 2 (含 W1 推迟件 + W2 新发 1 篇) | — | 3 | — |
| Week-3 | 3 | — | 6 | — |
| Week-4 | 2-3 | — | 8-9 | — |
| Week-5 | 1-2 | — | 9-11 | — |
| Week-6+ 稳态 | 2-3/周 | — | — | — |
| **5 周累计** | **9-11**（最高 12 含 W5 上限 2 篇）| — | — | — |

### 11.3 GEO KPI 看板

| 指标 | Day 14（首批）| Day 30（Week-6 retro）| Day 60（kill criterion）|
|------|--------------|---------------------|----------------------|
| Top 50 篇数 | — | ≥1 才续 | ≥10 才算 partial |
| Top 10 篇数 | — | — | ≥3 才成功 |
| AI Overview / Perplexity 引用篇数 | — | ≥1 SERP feature | ≥3 才成功 |
| 收录率 | ≥80% | — | — |

### 11.4 cost 看板

| 周 | 周 burn 计划 | 周 burn 实际 | 月累计计划 | 月累计实际 |
|----|-----------|-----------|-----------|-----------|
| Week-1 | $5 | — | $5 | — |
| Week-2 | $15 (DataForSEO 启动) | — | $20 | — |
| Week-3 | $25 (codex challenge 启动) | — | $45 | — |
| Week-4 | $25 | — | $70 | — |
| Week-5 | $15 | — | $85 | — |
| **月底 cap** | — | — | **$100** | — |
| **硬顶 cap** | — | — | **$150** | — |

---

## §12 关联文档

| 文档 | 角色 |
|------|------|
| [[G-GenGrowth-MVP-OpsPM-PRD-v1.2-lean]] | 业务 / KPI / 角色 / FAQ（PM/Ops 视角）|
| [[G-GenGrowth-MVP-半自动化工具栈方案-v1.2-lean]] | 工程实施 / 数据 schema / API / 测试矩阵 |
| [[G-GenGrowth-MVP-工具栈方案-v1.2-OpsPM-Brief]] | 上版 OpsPM 简版（保留参考）|
| [[G-GenGrowth-MVP-半自动化工具栈方案-v1.2-Review-Report]] | autoplan 评审报告 |
| [[A-AstrologyWiki-项目更新日志]] | 项目主时间线（精修发布每篇要记一行）|

---

## §13 修订历史

| 版本 | 日期 | 关键变化 |
|------|------|---------|
| v1.0 | 2026-05-20 深夜 | 初版，基于 lean2 双档（PRD + Tech）翻译为可点 todo。5 周 / wzb 18h / Ops 5-8h / 12-15 篇精修 / Day 60 GEO 验收 |
| **v1.1** | **2026-05-20 深夜+1** | **lean2.1 校准 patch**。autoplan re-review（Codex gpt-5.2 high + 2 Claude subagent）一致指出 5 项 CRITICAL + 7 项 HIGH。本次修：(1) 加 Day-1 binary kill gate on Ops + §1B solo-fallback plan；(2) Week-4 ship 砍 5→3（publish-backfill + cta-inject + event-export MVP），剩下 distribute-draft + seo-gate-scan 推 Week-5；(3) Week-1 诚实预算（2 篇 + 3 SOP）；(4) 多语言 sanitizer fixture Week-3→Week-2 前移；(5) manifest schema 锁为 Week-2 JSON 文件；(6) 加 §6.6 Week-6 Day 30 retro gate + §6.7.2 Day 60 kill criterion；(7) facts-audit "全绿" 改 automated diff 断言 + severity 分级；(8) `bin/publish-backfill` 描述去 "git tag" 自动化（违反 Tech 红线）；(9) §6.3.4 `/gg-distribute-draft` 平台名改对（X / Threads / Reddit / Newsletter，原 LinkedIn/Bluesky 不存在）；(10) Week-2 / Week-5 工时算式闭环 + §0.1 vs §11 数字对齐；(11) §7.4 Ops 退出 fallback 不再放宽 wzb 红线到 24h；(12) §7.5 $150 硬顶降级措辞对齐 Tech "阻断所有写 API"；(13) bin/cost-summary 新增 Week-2 交付物 |
| **v1.1.1** | **2026-05-20 深夜+2** | **第三轮最终验收 mechanical fixes**（autoplan 3-voice：Subagent A 事实一致性 + Subagent B 现实性 operator + Codex 第三独立声音）：(a) §11.2 W5 累计 10-12 → 10-13 闭合；(b) revision_history §5.3.2 → §6.3.4 引用修正；(c) §5.3.2 cta-inject `paid_signup` 加 facts-audit AST 验证 gate（Tech §2.1 17 trackEvent 不含此事件，Q-NEW-6 只覆盖 newsletter funnel 5 事件）；(d) §5.2 Week-4 周一 Ops 用 event-export 改"手工 csv，W5 起脚本"（Codex 发现 circular dependency：工具 Fri ship 但 Ops 周一就要用）；(e) §5.6 W4 翻车推 W5 加"同步砍 W5 一件到 W6"（Codex 发现无 absorb buffer）；(f) §6.6 Day 30 "扫第 1-5 篇" → "扫 age ≥ 30 天 cohort"（Codex 发现按篇号扫会混入未成熟 W3 末样本）。**未动 architectural decisions**（Week-1 18h 数学幻觉、Day 60 self-judge、Day-1 binary 2/4 buffer 档），见验收报告留待 wzb 决策。|
| **v1.1.2** | **2026-05-20 深夜+3** | **3 条 architectural decisions 全 land**（wzb 三选 A，autoplan R3 共识）：(D1) **Week-1 砍载到 ~16h**——1 篇 standard-setting + 2 SOP，第 2 篇 + Reddit SOP 推 W2；总精修 9-12 篇（v1.1 10-13 → v1.1.2 9-12）；承认 standard-setting 8h **包含** shadow 教学增量 ~3h 真实分摊（不再"暗中加 3h"）。(D2) **Day 30 + Day 60 kill judge = Lynne 不是 wzb**；§6.6 + §6.7.2 改 Lynne trigger 行动档，wzb 准备数据但不投票；Day-0 #4 Lynne sign-off commit conversation 新增；§9 凭据表 + §7.4 Lynne 撤回 → §1B trigger；Q-LEAN2-5 新增。(D3) **Day-1 binary gate 改真 4/4 → 5/5 pass**（5 = 4 + Lynne sign-off）；删 2/4 24h buffer 档（lean1 软启动逃生口）；任一缺立刻 §1B。**v1.1.2 总变化**：5 周累计 wzb 86h → ~84.5h；精修 10-13 → 9-12；Day-0 4 动作 → 4 动作 4.5h；Day-1 gate 4 → 5 criteria。Day 60 KPI（≥3 Top10 + ≥3 AI 引用）不变；Day 60 judge 改 Lynne。|

---

**一句话结尾（v1.1.2）**：这份是 lean2 双档的**执行映射表 + 现实性校准 + 三轮 autoplan adversarial review 的 architectural land**。每一条 `[ ]` 都来自 PRD/Tech 决策，经 autoplan 3-voice × 3 轮复审做执行诚实性修正 + architectural 砍载。**勾掉一条就近一步**，不勾就是阻塞。Day-1 18:00 真 binary gate（5/5 必满足，含 Lynne sign-off）是分叉点——过 → 主线；任一缺 → §1B solo-fallback。**今天就动 Day-0 4 件事**（Ops + GCP + 5 篇决策 + Lynne sign-off）。

— landing plan v1.1.2 / autoplan R3 architectural land / 2026-05-20 深夜+3
