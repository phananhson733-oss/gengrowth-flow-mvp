---
title: GenGrowth MVP 半自动化工具栈方案 v1
date: 2026-05-20
updated: 2026-05-20
type: tech-spec
version: v1.0
status: draft-for-review
project: GenGrowth / astrologywiki
supersedes: null
parent: 2026-05-15-gengrowth-internal-growth-mvp-prd-v0.7
tags:
  - gengrowth
  - tooling
  - seo
  - automation
  - astrologywiki
aliases:
  - GenGrowth 工具栈方案 v1
  - gg-tools-stack-v1
---

# GenGrowth MVP 半自动化工具栈方案 v1（拟接受）

## 0. 文档定位

本文档是 PRD v0.7（`docs/03-marketing/2026-05-15-gengrowth-internal-growth-mvp-prd-v0.7.md`）的**工具化执行规格**。

PRD v0.7 回答了"做什么 / 为什么 / 节奏"；本文档回答"用什么工具 / 怎么半自动化 / 哪些保留手工"。

**接受度**：wzb 已在 2026-05-20 对话中拍板"先聚焦 6 个核心工具 + 其他手工，后续再考虑全工具化"。本文档按此分档展开。

**对应 PRD §14.2 系统化路径**：本方案是 **M1.5 → M2 之间的过渡形态**（不是全自动 Agent，每一步保留人工决策口）。M2 起跑前打基础。

---

## 1. 总体策略

把 PRD §7 的 9 步流程拆成 14 个子 step（按"工具化粒度"），按 **做工具的 ROI** 分三档：

| 档位 | 数量 | 处理方式 | 工时收益（周）|
|---|---|---|---|
| **A 核心自动化**（必须做工具）| 3 | 完整 spec + Week-2/3 开发 | +12-16 h |
| **B 辅助半自动化**（值得做可后置）| 3 | 简化 spec + Week-4 开发 | +5-7 h |
| **C 纯手工 + SOP**（不做工具）| 8 | 走现有 SOP + 触发清单 | 维持现状 |
| 合计 | 14 | | +17-23 h/周 ops |

**分档理由**：
- A 档（Step 2-3a / 5 / 7）覆盖 9 步流程中 ~80% 的重复工时
- B 档（Step 2-3c / 8 / 9）是数据回流闭环，缺了 PRD §7.9 刷新规则变摆设
- C 档 8 项要么一次性（PGB / .gs 初始化）、要么频次低（负向词扫桶 / 地区闸门）、要么必须真人在手（社媒发布 / 社区回复 / 外链外联）

---

## 2. 与 oracle 仓库现状的关键事实修订

PRD §1.2「基础设施现状」表写于 2026-05-15，oracle 仓库（`/Users/wzb/Code/oracle`）在 2026-05-18~20 期间已大幅推进。本节列出**对工具栈方案有结构性影响**的事实修订（基于 2026-05-20 6 个并行 agent 的清点）。

| 项 | PRD 写的 | oracle 实际 | 对工具栈的影响 |
|---|---|---|---|
| GA4 | ❌ 未安装（Day-1 建设任务）| ✅ `services/analytics.ts` 已埋 13 类事件（page_view / scroll_depth / external_link_click / cta_clicked / newsletter 漏斗 5 个 / Consent Mode v2 / api_error PII 脱敏）；`VITE_GA4_MEASUREMENT_ID` env 注入即可 | Step 7 `/gg-event-sync` 不用补埋点，只做"GA4 Data API → Sheets 回流"；Step 7 `/gg-cta-inject` 仅需把 CTA Map sheet 的 cta_id 映射到组件 props |
| Newsletter | ❌ 未搭建（Week-1 建设）| ✅ `backend/src/api/newsletter.ts` + Supabase 入库 + Resend 验证邮件 + UTM 透传 + 蜜罐 + 5/h IP rate limit；landing 有 `NewsletterSection.tsx` + e2e 测试 | Week-1 不再有"搭建 newsletter"任务。**但暴露新 gap**：无 double opt-in、未来推送邮件用 Resend marketing 还是另选 ESP 未定 |
| GSC verification | ✅ 已验证 | ⚠️ `index.html:15` 仍 `YOUR_GSC_VERIFICATION_CODE` 占位（多半走 DNS 验证，但 meta tag 误导）| 1 分钟修，不影响工具栈架构 |
| 已发布 6 篇 aura | ✅ 已发布 | ❌ 仓库 grep 不到 aura；`data/articles/` 5 篇是精修线 v0（mercury-retrograde / mars-anger / track-mood / mental-health-apps / how-to-read-birth-chart）。**wzb 确认**：原意是"精选文章 5 篇"，非 aura | 量产线 Aura 1A 真正从 0 起；已发 5 篇升级为精修线 v1（回填 cluster_id + journal_prompts + psych_safety_flag）省 80% 工时 |
| 后端 google-auth | — | 已装 `google-auth-library@^10.5.0`，未装 `googleapis` / `@google-analytics/data` | 工具栈基础设施需补 2 个依赖 + 3 个 env（`GOOGLE_APPLICATION_CREDENTIALS` / `GSC_SITE_URL` / `GA4_PROPERTY_ID`）|
| 现有 wiki 页面骨架 | — | `public/en/wiki/` 已有 house-1~12 / chiron / ascendant / 12 星座 | 精修线 P0 集群「Houses as Life Areas」骨架已有，重切角度即可，不重建 |

**变现路径补充**（PRD §15 待补充的"商业模式"，wzb 已答）：
- 主要变现 = **订阅 + 深度报告**（报告未完成）
- 影响：Newsletter 在 MVP 阶段不是终极 CTA，应作为**报告 waitlist 入口**（高意图 lead magnet）
- 推荐 lead magnet 文案：「加入 waitlist，深度 birth chart report 上线时早鸟价 50% off」

**审核 owner**（PRD §7.5.3「1 人审核」未指名，wzb 已答）：
- wzb 自任唯一 reviewer
- Week-1 真实工时预算 ≈ 14-16 小时（PGB + Brief + 决策 + 审核混合）
- 审核工时封顶 6-8 小时 → Week-1 实产能 ≈ 14 篇（10 T3 + 3 T2 + 1 T1）
- PRD §7.5.3 写的「25 篇/周」**Week-1 不达标，按 14 篇/周校准**，等 Week-2 真实数据出来再调

---

## 3. 锁定的架构决策

基于 2026-05-20 fan-out 调研（6 个并行 agent 的现状/能力清点），以下 5 个决策已锁定，本方案不再讨论：

| 决策 | 选定方案 | 理由 |
|---|---|---|
| 主 SEO 数据 API | **DataForSEO**（pay-as-you-go，月成本 < $10）| 月成本远低于预期（5000 词 + 500 SERP + 200 backlinks ≈ $5.8）；TS SDK 官方维护（`@dataforseo/typescript-client`）；endpoint 全覆盖六源 + by-country + AIO 检测 |
| Ahrefs 角色 | **保留人工交叉验证**，不接 API | 已有订阅；DataForSEO 自动化主流；Ahrefs 用于 us_share 拿不准时人工核查（按 PRD §3.3）|
| GSC/GA4/Sheets 认证 | **统一 Service Account**（1 个 JSON）| 4 步搞定 vs OAuth 7 步；内部工具不需 user consent |
| Sheets 数据通道 | **Sheets API 直连**（`googleapis` Node SDK），不依赖 `.gs` 暴露 webhook | `.gs v3.0` 零交互（无 doPost/onEdit）；外部 skill 走 Sheets API 更灵活；`.gs` 仅做"一次性初始化工作簿" |
| Skill 放置 | `gengrowth-wiki/.claude/skills/gg-*/`（项目级，gstack 目录约定）| 命名空间无冲突；与 PDF 导出脚本同位；先清理现有 3 个失效 symlink（指向 Lynne 机器路径）|

---

## 4. Part A · 核心自动化（3 个完整 spec）

### 4.1 Step 2-3a · `/gg-keyword-mine`

#### 4.1.1 做什么 / 目的

把 `keyword-research-sop.md` v2.4 的"六源挖掘"从**手工 Ahrefs → 复制 → 粘贴**变成**一条命令 → 自动写入主表**。让人工只在 ① 种子词选定 ② 跑完后扫一眼新增行的 track 标注 上花时间，每次省 6-8 小时。

数据流水线起点，下游 Step 2-3b/c/d/5 全部依赖产出的关键词主表。

#### 4.1.2 触发条件

- **上游依赖**：Step 1 PGB 完成（已知量产线/精修线种子词维度 + 不做范围）；⚙️配置!B4 目标国家已填；⚙️配置!A28:A45 NEGATIVE_KEYWORDS 已填初版
- **触发方式**：`/gg-keyword-mine` skill 或 `node tools/scripts/gg-keyword-mine.ts --seeds-file=seeds.json`
- **频次**：新产品 onboard 一次；已上线产品每 2-4 周补一次
- **不该触发**：种子词没改、距离上次 < 14 天

#### 4.1.3 输入

| 来源 | 字段 | 必填 | 说明 |
|---|---|---|---|
| `seeds.json`（手填）| `keyword` / `track`(量产\|精修) / `intent`(info\|compare\|tutorial\|utility\|experience) | ✅ | 5-15 个种子词；v2.4 SOP 禁止单个多义词（`transit`、`node`），必须用 `transit chart`、`north node astrology` |
| ⚙️配置!B4 | 目标国家代码 | ✅ | 自动读，传 DataForSEO `location_code`（US=2840、UK=2826、IN=2356）|
| ⚙️配置!A28:A45 | NEGATIVE_KEYWORDS | ✅ | 自动读，做后处理 + 写入时 O 列公式生效 |
| CLI flag | `--mode minimal\|standard\|deep` | 默认 standard | minimal=keyword_ideas only / standard=+related+suggestions / deep=+前 200 SERP scrape |
| CLI flag | `--max-keywords 500` | 默认 500 | 每种子词扩展上限 |
| CLI flag | `--dry-run` | 默认 false | 只算成本不写 sheet |

#### 4.1.4 实现方式

- **形态**：Node 脚本（无 LLM）+ `/gg-keyword-mine` skill 薄包装（交互式 mode 选择 + dry-run 成本预估）
- **代码位置**：
  - 脚本：`gengrowth-wiki/tools/scripts/gg-keyword-mine.ts`
  - 共用客户端：`gg-lib/dataforseo.ts`、`gg-lib/sheets.ts`
  - Skill：`gengrowth-wiki/.claude/skills/gg-keyword-mine/SKILL.md`
- **认证**：DataForSEO Basic Auth（env `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD`）；Sheets 走 Service Account JSON（env `GOOGLE_APPLICATION_CREDENTIALS`）

**执行步骤**：

```text
1. dry-run 时：估算成本（种子词数 × mode 系数 × 平均 $/task），print → exit
2. 读 ⚙️配置 → 拿 location_code + NEGATIVE_KEYWORDS list
3. 对每个种子词，并行（max 5 concurrency）调 Labs：
     - POST /v3/dataforseo_labs/google/keyword_ideas/live
       { keyword, location_code, language_code:"en", limit:max_keywords }
     - mode=standard|deep 再调 /related_keywords/live + /keyword_suggestions/live
4. 合并去重（key=keyword），多源命中合 source 列（逗号分隔）
5. 批量补数据（一次最多 1000 keywords/batch）：
     - /v3/keywords_data/google_ads/search_volume/live  → C 列 月搜索量
     - Labs /bulk_keyword_difficulty/live              → D 列 KD
6. mode=deep：对 search volume top 200 调
     - /v3/serp/google/organic/live/regular { keyword, location_code, depth:10 }
     - 解析 item_types 是否含 "ai_overview"  → G 列 AIO 标记
     - 解析前 10 organic 的 domain → 批量调 /v3/backlinks/bulk_ranks/live
     - 算前 10 平均 DR → H 列 SERP_弱度 (DR<30=弱、30-50=中、>50=强)
7. NEGATIVE_KEYWORDS 后处理：keyword 含任一负向词 → 标 status=skipped 仍写入
   （让 .gs O 列公式 ❌跳过 接管）
8. 通过 Sheets API batchUpdate 写入「关键词主表」append（不覆盖人工列）
9. 写 tools/scripts/runs/keyword-mine-YYYY-MM-DD-HHMM.json（运行日志）
```

#### 4.1.5 输出

| 输出物 | 位置 | 字段/结构 | 下游消费方 |
|---|---|---|---|
| 关键词主表 append | Google Sheets `关键词主表` | A=keyword / B=source / C=月搜索量 / D=KD / E=cpc / F=competition / G=AIO / H=SERP_弱度 / I=track / J=intent | `.gs` O 列自动分桶；Step 2-3b/c |
| 运行日志 | `tools/scripts/runs/keyword-mine-{ts}.json` | `{seeds, mode, dataforseo_tasks, total_cost_usd, dedup_count, written_rows, skipped_negative_count, failed_seeds, duration_ms}` | 月度成本审计；周报数据源 |
| stdout 摘要 | 终端 | "已写入 487 行；成本 $5.83；含 12 个负向词命中" | 即时反馈 |

#### 4.1.6 人工保留口

| 决策点 | 谁 | 何时 |
|---|---|---|
| 种子词选定 + track + intent | wzb | 跑前编辑 `seeds.json` |
| mode 选择（成本 vs 深度）| wzb | CLI flag |
| 跑完后扫 track 标注 | wzb | 跑后 5 分钟，抽 10 行 |
| 是否补加 NEGATIVE_KEYWORDS | wzb | 看 stdout 意外命中 |

#### 4.1.7 验收

- ✅ 关键词主表新增行数 ≈ 种子词数 × 30-100（mode=standard）
- ✅ 每行 C/D 列有数；C 列为空的占比 < 20%
- ✅ `.gs` O 列自动分桶生效（含 ❌跳过 命中负向词）
- ✅ `runs/*.json` 存在，total_cost_usd < $10
- ✅ 抽 5 行：B 列 source 与 seeds.json 至少一项对应
- ❌ 失败回退：DataForSEO live endpoint 超时 → 自动 fallback 到 Standard queue（task_post + 轮询）

#### 4.1.8 已知风险

1. DataForSEO 月搜索量 by country 对长尾词返回 null → 可接受
2. AIO 检测假阴性（SERP scrape 与真实 24-72h 延迟）→ 可接受
3. 多义词种子绕过 v2.4 规定 → Skill 提示词加 LLM 预检（cheap model 扫 seeds.json）
4. 首次跑 deep mode 成本翻 5 倍 → dry-run 必跑

#### 4.1.9 工时收益

| 维度 | 手工 | 工具化 |
|---|---|---|
| 操作时间 | 0.5-1 天 | 5 min seeds + 10 min 跑 + 5 min 验收 |
| 一致性 | 列名/格式漂移 | sheet schema 强约束 |
| 可重跑性 | 几乎不重跑 | 2-4 周轻松重跑 |
| 成本 | $0（Ahrefs 已付）| ~$5-10/次 DataForSEO |

---

### 4.2 Step 5 · `/gg-content-draft`（核心中的核心）

#### 4.2.1 做什么 / 目的

把 v2.0 内容 SOP 的"五步装配"（SERP 调研 → 大纲 → 装配 → QA → 发布）从 1-4 小时/篇压到 15-90 分钟（按 Tier）。**工具栈里最复杂、ROI 最高的一个**。

按 PRD §7.5 + 附录 A 5 个页面模板，分量产线 T3（快产）和精修线 T1/T2（精修）两条装配链路，单 skill 调度但内部分流。

#### 4.2.2 触发条件

- 上游：选题登记表 v2.1 已建卡（page_id / cluster_id / page_role / tier / template / primary_keyword）；集群级 Brief 已写
- 触发：`/gg-content-draft --page-id=xxx` 单页，或 `--cluster-id=xxx` 一次起 1 集群
- 频次：14-25 次/周（按审核产能上限）

#### 4.2.3 输入

| 来源 | 字段 | 必填 | 说明 |
|---|---|---|---|
| 选题登记表 v2.1 | page_id / cluster_id / page_role / tier / template / primary_keyword / secondary_keywords | ✅ | 单页所有元数据 |
| 主题集群表 | content_angle / psych_safety_flag / link_plan / cta_primary | ✅ | 集群级语境 |
| 集群级 Brief（md）| entity_map / pillar_angle / series_rule / quality_bar / evidence_requirement | ✅ | LLM 装配的"风格约束" |
| 附录 A 模板 | template A-E 中选 1 | ✅ | 装配骨架 |
| 附录 B 心理安全规则 | psych_safety_flag=Y 时强制注入 | 条件 | 仅精修线 healing 页 |
| CLI flag | `--mode draft\|t1-challenge\|preview` | 默认 draft | t1-challenge=调 codex；preview=只拉数据 |

#### 4.2.4 实现方式

- **形态**：Cowork（主 Claude 调度 + sonnet drafter + 条件性 codex challenge）
- **代码位置**：
  - Skill：`gengrowth-wiki/.claude/skills/gg-content-draft/SKILL.md`
  - 模板：`.claude/skills/gg-content-draft/templates/template-{A-E}.md`（对应附录 A 5 模板）
  - Drafter 提示词：`.claude/skills/gg-content-draft/references/drafter-prompt-{tier}.md`
  - Psych safety 检查清单：`.claude/skills/gg-content-draft/references/psych-safety-checklist.md`（抄附录 B）
  - 数据采集：`tools/scripts/gg-content-research.ts`（SERP + Reddit 抓取，无 LLM）

**执行步骤**：

```text
[Phase 1: 数据采集 · 脚本 · 无 LLM]
1. 读选题登记表 + 集群表 + Brief，构造 ctx 对象
2. tools/scripts/gg-content-research.ts:
   a. /v3/serp/google/organic/live/regular { keyword:primary, depth:10 }
      → 前 10 标题/描述/URL/AIO 内容
   b. mode!=preview 时，对 secondary_keywords 各调一次 SERP（最多 5 个）
   c. /v3/serp/google/organic/live/regular { keyword:"primary site:reddit.com", depth:10 }
      → Reddit thread URL 清单
   d. 精修线必抓 quora，量产线跳过
   e. 对 Reddit thread 前 3 个用 WebFetch 抓正文（Quora 同）
3. 输出 tools/scripts/runs/research-{page_id}.json
   { serp_top10, aio_content, reddit_threads, quora_threads, competitor_titles }

[Phase 2: 装配 · Cowork · LLM]
4. 主 Claude 读研究包 + 集群 Brief + 选定的附录 A 模板
5. 按 tier 分路：
   ├─ T3 (量产线 aura/Vedic 长尾):
   │  · 单次 sonnet 调用，prompt = template + ctx + research（精简）
   │  · 输出 1 段 markdown，不调 codex
   │
   ├─ T2 (Series 主力):
   │  · sonnet 起草大纲（5 个 H2）
   │  · sonnet 逐段写
   │  · 主 Claude 检查每个 H2 是否覆盖 Brief 的 entity_map
   │
   └─ T1 (Pillar / 战略页 / 精修线 healing):
      · sonnet 起草完整草稿
      · 主 Claude 提取 3 个"承诺/断言/差异化主张"
      · 调 codex MCP challenge: "找这 3 个主张的反例/矛盾/弱证据"
      · 主 Claude 收到反馈 → 决定重写/补证据/保留
      · 第二轮 sonnet 修订

6. psych_safety_flag=Y 时（仅精修线 healing）:
   · 主 Claude 用附录 B 清单逐条扫
   · 命中"必须避免" → 自动重写
   · 同时生成 journal_prompts 4-6 条（写入选题登记表 v2.1 列 21）

7. 内链注入：读集群表 link_plan → 插 [[wiki-link]] 占位
8. CTA 注入：读 CTA Map sheet → 末尾插 <!-- CTA: {cta_id} --> + 文案

[Phase 3: 输出 · 脚本]
9. 写文件：
   · 量产线 → oracle/public/en/wiki/{slug}.md
   · 精修线 → oracle/data/articles/{slug}.ts
10. 写回选题登记表: Status="待审核" / draft_path / drafted_at
11. stdout 摘要给操作者
```

#### 4.2.5 输出

| 输出物 | 位置 | 下游消费方 |
|---|---|---|
| 草稿文件（主）| `oracle/data/articles/*.ts` 或 `oracle/public/en/wiki/*.md` | 人工审核 → git commit → Vercel deploy |
| 研究包缓存 | `tools/scripts/runs/research-{page_id}.json` | 审核时看竞品/Reddit 原话；重跑复用 |
| 选题登记表 update | Sheets `选题登记表 v2.1` | Status / draft_path / drafted_at |
| journal_prompts | 选题登记表 v2.1 列 21 | 发布后回写到 markdown frontmatter |
| 运行日志 | `tools/scripts/runs/draft-{ts}.json` | 月度成本审计 + 工时校准 |

#### 4.2.6 人工保留口

| 决策点 | 谁 | 何时 |
|---|---|---|
| Tier 选定（T1/T2/T3）| wzb | 建卡时（选题登记表列 6）|
| 模板选定 | wzb | 建卡时（列 7）|
| 草稿审核（T3 ~15min / T2 ~35min / T1 ~90min）| **wzb（唯一 reviewer）** | 跑完后 |
| psych safety 自动重写后最终拍板 | wzb | 审核时确认 |
| CTA 文案微调 | wzb | 审核时改 markdown |
| 内链 wiki-link 真实 URL 填入 | wzb 或后续 `/gg-link-fill` | 发布前 |

#### 4.2.7 验收

- ✅ 单页跑完时间：T3 < 90s / T2 < 3min / T1 < 8min（含 codex）
- ✅ 单页 LLM 成本：T3 < $0.05 / T2 < $0.20 / T1 < $1.50（含 codex）
- ✅ psych safety 触发自动重写时，日志可追溯
- ✅ 草稿无 lorem ipsum、无 "As an AI..." 残留
- ✅ 选题登记表 Status 自动从"待写"→"待审核"
- ❌ 失败回退：DataForSEO 超时 → 退到 mode=preview（无 research，标记 `research_skipped=true`）

#### 4.2.8 工时收益

| Tier | 手工 | 工具化 | 净省 |
|---|---|---|---|
| T3 | 1-2h | 15 min | ~85% |
| T2 | 2-3h | 35 min | ~80% |
| T1 | 4-6h | 90 min | ~75% |

**Week-1 14 篇组合**：手工 ~22h → 工具化 ~6h，**净省 16h/周**。

---

### 4.3 Step 7 · `/gg-event-sync`（数据回流闭环）

> 拆 2 个工具：`/gg-cta-inject`（一次性，注入 CTA 组件）+ `/gg-event-sync`（周期性，回流 GA4/GSC 数据到结果复盘表）。`/gg-cta-inject` 一次性脚本，不展开 spec；下面只展开 `/gg-event-sync`。

#### 4.3.1 做什么 / 目的

把 GSC + GA4 的事件数据**按 page_id 维度自动回填**到「结果复盘表」，让 Day 14/30/60 节点判断有数据基础。**没这个工具，PRD §7.9 刷新规则 = 摆设**。

#### 4.3.2 触发条件

- 每周一 09:00 cron `/gg-event-sync --period=last-week`；或手动 `--page-id=xxx`
- 频次：周自动 + 偶尔手动补数

#### 4.3.3 输入

| 来源 | 字段 | 说明 |
|---|---|---|
| 选题登记表 v2.1 | page_id / URL / drafted_at / published_at | 算 Day 14/30/60 节点 |
| GSC API | `searchanalytics.query` { dimensions:[page,query,country], startDate, endDate } | impressions/clicks/CTR/position |
| GSC URL Inspection | `urlInspection.index.inspect` | 收录 status（Day 14 判断）|
| GA4 Data API | `runReport` { dimensions:[pagePath,eventName], metrics:[eventCount,activeUsers] } | cta_clicked / tool_use / newsletter_submit_success |
| ⚙️配置 | GSC_SITE_URL / GA4_PROPERTY_ID | env 替代 |

#### 4.3.4 实现方式

- 形态：纯脚本（无 LLM）；cron 或手动
- 代码位置：`tools/scripts/gg-event-sync.ts` + `gg-lib/{gsc,ga4,sheets}.ts`
- 认证：Service Account JSON（共用）

**执行步骤**：

```text
1. 读选题登记表 → 拿所有有 URL 的 page_id 清单
2. 算每个 page_id 的"节点状态"：
   · published_at + 14d 在 [last_week_start, last_week_end] → Day 14 节点触发
   · +30d → Day 30；+60d → Day 60
3. 对每个有节点触发的 page_id:
   a. GSC URL Inspection: 是否 indexed
   b. GSC searchanalytics (last 7d): impressions/clicks/CTR/position by query
   c. GSC searchanalytics (last 7d): impressions by country
      → 算 us_share 实测值（vs 集群表的预估三档标签做对比）
   d. GA4 runReport (last 7d): cta_clicked / tool_use / newsletter_submit_success
4. 按 PRD §7.9 规则自动算"建议决策":
   · Day 14: indexed=false → "查 sitemap/内链/noindex"
   · Day 14: impressions=0 且 indexed → "Brief 重做"
   · Day 30: position 1-30 → "保留"; 31-80 → "刷新+补 FAQ"; >80 → "暂缓扩张"
   · Day 60: clicks>0 → "保留+扩 cluster"; 仅 impressions → "优化标题摘要"; 无信号 → "合并/noindex"
5. batchUpdate 写「结果复盘表」对应 outcome_id 行
6. 算「集群 us_share 实测 vs 预估漂移」:
   · 集群级聚合: 该集群所有 page 的 GSC US impressions / 总 impressions = 实测 us_share
   · 与集群表预估三档对比, 漂移>30% 写入周报警报
7. 写 stdout 摘要 + tools/scripts/runs/sync-{ts}.json
```

#### 4.3.5 输出

| 输出物 | 位置 | 下游消费方 |
|---|---|---|
| 结果复盘表 batchUpdate | Sheets `结果复盘表` | Step 8 `/gg-weekly` 数据源；Step 9 `/gg-refresh-scan` 决策 |
| us_share 漂移警报 | stdout + 周报段 | 集群表 us_share 标签校准 |
| 运行日志 | `tools/scripts/runs/sync-{ts}.json` | cron 健康监控 |

#### 4.3.6 人工保留口

| 决策点 | 谁 | 何时 |
|---|---|---|
| "建议决策"列最终拍板 | wzb | Step 9 刷新扫描 |
| 是否人工补数（缺失页面）| wzb | 看 stdout 失败清单 |
| GA4 自定义事件名变更 | wzb | oracle 改埋点后同步 CTA Map sheet |

#### 4.3.7 验收

- ✅ 每周一自动跑完 < 5 min（< 200 页时）
- ✅ 结果复盘表对应 Day 14/30/60 节点行有数
- ✅ us_share 漂移警报触发（拿 nakshatra 集群验证：预估"低"，实测应也低）
- ✅ GSC + GA4 API 调用 0 失败（rate limit 远高于需求）
- ❌ 失败回退：GSC URL 未授权 → 报错明确提示"SA 邮箱需加为 GSC Owner"

#### 4.3.8 工时收益

| 维度 | 手工 | 工具 |
|---|---|---|
| 单页数据复盘 | 5-10 min | 0 |
| 周复盘 | 3-5 h | 0 |

**关键收益不在工时，在"会做"**：手工时无人坚持 Day 14/30/60 复盘 → 工具化变默认。

---

## 5. Part B · 辅助半自动化（3 个简化 spec）

### 5.1 Step 2-3c · `/gg-cluster-build`

| 字段 | 内容 |
|---|---|
| 做什么 | 用 embedding 把关键词主表 R 列=快速胜利/长尾词的行做语义聚类，输出主题集群表草稿 |
| 触发 | Step 2-3a 跑完后；或现有集群划分过期 |
| 输入 | 关键词主表筛选行（300-500 词）+ ⚙️配置目标国家 |
| 实现 | 脚本调 OpenAI `text-embedding-3-small`（< $0.50/次）→ HDBSCAN 聚类 → 主 Claude 给每个簇起 cluster_name / 推测 content_layer / 起草 jtbd |
| 输出 | 主题集群表草稿（含 cluster_id / cluster_name / keywords_included / 推测字段）→ Sheets append |
| 人工口 | track（量产/精修）/ us_share 三档 / pillar_page / content_angle / psych_safety_flag（5 列必须人工填）|
| 工时 | 手工 1 天 → 工具 2 小时（含人工补 5 列）|

### 5.2 Step 8 · `/gg-weekly`

| 字段 | 内容 |
|---|---|
| 做什么 | 周一 09:00 自动生成 `weekly-action-list-YYYY-WW.md`：上周表现 / 本周计划 / 风险 / owner |
| 触发 | cron 每周一；或手动 |
| 输入 | 结果复盘表（`/gg-event-sync` 已填）+ 选题登记表 Status 分布 + CTA Map + 集群表 |
| 实现 | 主 Claude 读 4 张表 → 套周报模板 → markdown → 自动 `git add+commit` 到 `gengrowth-wiki/docs/03-marketing/operations/weekly/` |
| 输出 | weekly markdown + git commit + Telegram 提醒（如配）|
| 人工口 | 审核 + 给每个 action 派 owner / due date |
| 工时 | 手工 3 h → 工具 30 min |

### 5.3 Step 9 · `/gg-refresh-scan`

| 字段 | 内容 |
|---|---|
| 做什么 | 按 PRD §7.9 扫所有 page 的 Day 14/30/60 节点，输出"刷新/合并/暂停"候选清单 |
| 触发 | 每周一手动（在 `/gg-weekly` 之后）；不上 cron 避免对人施压 |
| 输入 | 结果复盘表 + 选题登记表（published_at）|
| 实现 | 纯脚本按规则打标签；刷新候选由主 Claude 起草建议 |
| 输出 | `tools/scripts/runs/refresh-candidates-YYYY-WW.md` + Sheets 决策列 update |
| 人工口 | wzb 决定真做哪个；执行刷新（改 markdown + 重发）|
| 工时 | 手工半天 → 工具 1 h |

---

## 6. Part C · 纯手工 + SOP（8 项不做工具）

| Step | 频次 | 手工做什么 | SOP |
|---|---|---|---|
| Step 0 `.gs` 初始化 | 一次性（每产品 1 次）| 跑 `createGenGrowthKeywordSheet()` + 填 ⚙️配置 3 个 cell | `.gs v3.0` 已就绪 |
| Step 1 PGB | 一次性（每产品 1 次）| 填种子模板 §一 11 字段 + 商业模式 + 竞品 + Day-0 基线 | PRD §7.2 字段表 |
| Step 2-3b 负向词扫桶 | 每月 30 min | 看⚡桶随机 30 行有无垃圾，加 NEGATIVE_KEYWORDS | PRD §7.3.2 |
| Step 2-3d 地区闸门 | 集群规划时 10 集群 × 5 min | 常识判断三档；拿不准查 Ahrefs by-country | PRD §3.3 三档表 |
| Step 4 技术闸门 | 发布前每篇 < 5 min | 手工 GSC URL Inspection + PSI + 查 robots/canonical | PRD §7.4 |
| Step 6a 社媒发布 | 每集群 3-5 条 | Claude 起草拆条 → 真人审 → 手工发 | — |
| Step 6b 社区回复 | 每周 5 条 | Reddit/Quora 搜词 → 判断回不回 → 手工回 | — |
| Step 6c 外链 prospect | 每月 1 次 | Ahrefs 现有订阅手工查 → 人工外联 | — |

**Step 6 不做工具的根本理由**：社媒/社区账号必须真人在手（避免封号 + 避免硬推感）；外链外联是高语境邮件，自动化 ROI 负向。

---

## 7. Part D · 开发顺序与预算

| 周 | 做什么 | 工程工时 | 周回报 ops 工时 |
|---|---|---|---|
| **Week 2 准备** | 基础设施：Service Account + 后端依赖（`googleapis` + `@google-analytics/data` + `@dataforseo/typescript-client`）+ `gg-lib/` 共用 client | 1 天 | 0（前置）|
| **Week 2 开发** | Step 2-3a `/gg-keyword-mine` + Step 7 `/gg-event-sync` | 3-4 天 | +8 h/周 |
| **Week 3 开发** | Step 5 `/gg-content-draft`（最大但最贵）| 5-7 天 | +12-16 h/周 |
| **Week 4 开发** | Step 2-3c `/gg-cluster-build` + Step 8 `/gg-weekly` + Step 9 `/gg-refresh-scan` | 3-4 天 | +5-7 h/周 |
| **合计** | 6 个工具 | ~3 周工程 | +25-30 h/周 ops |

**月度 API 成本上限**：DataForSEO < $30 + GSC/GA4/Sheets 免费 + Claude API（drafter）~$50-100 = **总 < $150/月**。

---

## 8. Part E · 基础设施 setup（Week-2 起跑前）

### 8.1 Service Account 流程（4 步）

1. **GCP 控制台建 SA + 下 JSON**：项目→IAM→Service Accounts→新建→生成 JSON key
2. **启用 3 个 API**：Sheets API / Search Console API / Google Analytics Data API
3. **授权**：
   - Sheets：把 SA 邮箱加为目标工作簿的 Editor
   - GSC：把 SA 邮箱加为 site property 的 Owner（不能 Restricted）
   - GA4：把 SA 邮箱加为 GA4 property 的 Viewer
4. **配置**：JSON 文件放安全位置（gitignore），env 指向

### 8.2 后端依赖增量

```jsonc
// backend/package.json
{
  "dependencies": {
    "google-auth-library": "^10.5.0",   // 已装
    "googleapis": "^...",                // 新增
    "@google-analytics/data": "^...",    // 新增
    "@dataforseo/typescript-client": "^..."  // 新增（如选官方 SDK）
  }
}
```

### 8.3 Env 增量

```bash
# .env / .env.example
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa-key.json
GSC_SITE_URL=sc-domain:astrologywiki.com  # 或 https://www.astrologywiki.com/
GA4_PROPERTY_ID=123456789
DATAFORSEO_LOGIN=...
DATAFORSEO_PASSWORD=...
```

### 8.4 `gg-lib/` 共用 client 接口

```typescript
// tools/scripts/gg-lib/sheets.ts
export class SheetsClient {
  async read(sheetId: string, range: string): Promise<unknown[][]>;
  async append(sheetId: string, range: string, values: unknown[][]): Promise<void>;
  async batchUpdate(sheetId: string, updates: {range: string, values: unknown[][]}[]): Promise<void>;
}

// tools/scripts/gg-lib/gsc.ts
export class GscClient {
  async searchAnalytics(params: {siteUrl, startDate, endDate, dimensions, filters?}): Promise<...>;
  async urlInspection(siteUrl: string, url: string): Promise<...>;
  async submitSitemap(siteUrl: string, sitemapUrl: string): Promise<void>;
}

// tools/scripts/gg-lib/ga4.ts
export class Ga4Client {
  async runReport(params: {propertyId, dimensions, metrics, dateRanges}): Promise<...>;
}

// tools/scripts/gg-lib/dataforseo.ts
export class DataForSeoClient {
  async keywordIdeas(keyword, locationCode): Promise<...>;
  async searchVolume(keywords: string[], locationCode): Promise<...>;
  async serp(keyword, locationCode, depth): Promise<...>;
  async backlinks(...): Promise<...>;
}
```

### 8.5 清理 wiki 失效 symlink

```bash
# gengrowth-wiki/.claude/skills/ 现有 3 个 symlink 指向 /Users/lynne/... 无法访问
cd /Users/wzb/gengrowth-wiki/.claude/skills
rm company-survey production-survey web-clipper  # 失效 symlink
# 或：修复指向 /Users/wzb/gengrowth-wiki/tools/internal/skills/（若实际路径）
```

---

## 9. 待拍板的开放问题

| # | 问题 | 选项 | 推荐 | 阻塞什么 |
|---|---|---|---|---|
| Q1 | Newsletter double opt-in 怎么补 | A) Resend 自建 confirm flow / B) 换 Beehiiv 或 ConvertKit | A（成本低，已用 Resend）| Week-1 不阻塞，Week-2 推送邮件前必须解 |
| Q2 | Newsletter lead magnet 文案策略 | A) 泛 prompts / B) 报告 waitlist 早鸟 / C) 双价值（prompts + waitlist 通知）| B（与变现路径一致）| Week-2 newsletter 改文案前 |
| Q3 | Week-2 工程谁写 | A) wzb 写 / B) Claude Code 协助 / C) worktree subagent 自主开发 | B（成本 vs 速度均衡）| Week-2 起跑前 |
| Q4 | 开发顺序按 §7 表吗 | A) 按表（2-3a + 7 → 5 → 其他）/ B) Step 5 提前 / C) Step 7 优先确保数据回流 | A（数据闭环最小集优先）| Week-2 起跑前 |
| Q5 | `.gs` 是否补 doPost 暴露 webhook | A) 不补，全走 Sheets API / B) 补，让 .gs 也能被外部触发 | A（已锁定）| — |
| Q6 | T1 草稿调 codex challenge 默认 on 还是 opt-in | A) 默认 on（成本 +$1/篇）/ B) opt-in（flag 触发） | A（T1 频次低、值得）| Step 5 spec 终稿 |
| Q7 | Skill 命名前缀 | A) `gg-*` / B) `gengrowth-*` / C) `seo-*` | A（短，与现有命名约定一致）| Week-2 skill 第一份提交前 |

---

## 10. 验收 / 退出标准

### 10.1 v1 方案验收（本文档）

- ✅ 6 个工具的 spec 描述清楚"做什么 / 输入 / 实现 / 输出 / 人工口 / 验收"
- ✅ 8 个手工 step 列了 SOP 引用 + 触发频次
- ✅ 5 个架构决策锁定且有理由
- ✅ 开发顺序 + 工时预算可执行
- ✅ 待拍板问题列出选项 + 推荐

### 10.2 v1 工具实现验收（Week-4 末）

- ✅ 6 个 skill 都可在 wzb 本机 `/gg-*` 直接调
- ✅ DataForSEO + GSC + GA4 + Sheets 4 个 API 联通且 0 认证失败
- ✅ 一个完整 Week-1 集群跑完：Step 2-3a → 2-3c → 5 → 7 → 8 → 9 全链路有数据
- ✅ 月度 API 成本 < $150
- ✅ Week-1 14 篇产出的工时实测 < 8 h（不含 PGB/Brief/决策）

### 10.3 M1.5 完整退出标准（PRD §14.2）

- ✅ 6 个工具稳定跑 4 周以上
- ✅ astrologywiki 60 天日 PV 5000（美国为主）达成
- ✅ 工具化省下的时间真转化为"做更多集群" or "做精修线深度"，非"少干活"
- ✅ 产品 #2 onboard 时跑 `.gs` v3.0 + 填配置 + 跑 `/gg-keyword-mine` 即可开局，证明可复用

---

## 11. 变更记录

| 版本 | 日期 | 状态 | 主要变化 |
|---|---|---|---|
| v0 | 2026-05-20（口头）| draft | wzb 对话中提出"半自动化工具栈"概念 |
| **v1** | **2026-05-20** | **draft-for-review** | **6 工具完整 spec + 8 手工 SOP + 5 架构决策锁定 + 4 周开发计划 + 7 个待拍板问题** |
