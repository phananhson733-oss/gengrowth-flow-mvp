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
- **advisory 期产物必须打 `geo_gate=advisory` 标记**（manifest/发布日志列），并**排除出未来 M1 新页随机实验的样本池**——否则低 citability 页混进实验臂会污染 treatment/control 定义（codex 审查吸收）。

### 3. queue-build / phase2：站内查重闸（三源，统一契约表）

新增确定性检查 `lib/internal-dedup.mjs`。**本表是 G3 的单一权威契约**（geo 设计文档引用此表，不另立口径）：

| 入口 | 时机 | 查什么字段 | 对什么源 | 阈值起步 |
|---|---|---|---|---|
| queue-build | 选词进周计划前 | Target Keyword + Associated Keywords | ①Sheet 台账(全部 page_id 行) ②oracle 语料(slug 短语+标题主段+别名表) ③live sitemap/路由清单 | slug 短语/标题命中 = 挡下人裁；token≥2 = warn |
| phase2 | 产出验证时 | 产出文 H1 + 标题 + 首段 | 同上三源 | 同上；另 n-gram 宽口径只 warn(同簇系列文天然相近,防误杀) |
| autopilot convert | md→.ts 落盘前 | 目标 slug | ②③（防覆盖既有文件） | 存在即挡 |

- 超阈值 → 挡下标 `needs_human`，不自动改写、不自动跳过（报告而非裁决）。
- 别名表与匹配实现参照 geo 仓 `tools/scripts/_sheet-mapping-check.mjs`（ALIASES/corePhrases/matchText，已有 8 测）；移植时连测试一起搬。
- 这是对 RL3（只查 SERP）的盲区补位。**三源而非双源**：`data/articles/` 目录之外的 live 页面（redirect/专题/生成路由）靠 sitemap 兜底（codex 审查吸收）。
- **zh 层对账（实施期必做）**：Sheet `target_keyword_zh` 是 Yes 旗标非关键词，且已实证登记漂移（mahadasha 系 5 篇站上有 zh 版而 Sheet zh 列空）——实施时加 `zh=Yes 集合 × oracle ARTICLES_ZH` 双向 diff，漂移行单列报告。

### 4. autopilot / 手工编辑 / oracle CI：page-lock 检查

- geo 仓产物 `gengrowth-geo/_staging/sheet-mapping/astrologywiki/page-lock.json`（schema **`page-lock/2`**，带基数校验 4+4+8=16 与输入 sha256）。
- **锁的范围不只是"改正文"**（codex blocker 吸收）：①锁定页可见输出（正文/标题/meta/canonical/JSON-LD/lastModified）；②入链与出链图（新增/删除/改锚文本均禁，/en/、/zh/、绝对 URL 三形态）；③站级可见面（sitemap/robots/llms.txt/全站 schema）窗内不动。
- **消费面三层**：autopilot `doScan` convert 前查 slug；`gg-md-to-oracle-ts` 落盘前查；**oracle 任何 PR 合并前**对锁定页渲染输出+链接图做 diff 校验（check:links + 锁窗基线 diff）——只靠前两个脚本入口挡不住手改/模板改/组件波及。
- 锁窗解除 = geo 仓更新 page-lock（人工动作，复测收口后）；到期不解除须显式记录原因。

### 5. Sheet 副本：`source=geo` 注册约定（带溯源字段）

- GEO 诊断产生的新内容需求由 geo 仓写入 **Sheet 副本**选题登记表（新增 `source` 列，值 `geo`），不直写生产表。
- 人工 review 副本条目 → 合格者由人搬入生产表。**搬入时必须携带**：`source / origin_copy_row / review_id / conflict_decision / promoted_at` 五字段；queue-build 对带 `source=geo` 但缺溯源字段的行**直接拒绝**——防无标记 GEO 条目绕过冲突裁决进生产（codex 审查吸收）。
- 副本→生产表**不自动同步**。

## 冲突台账（单一权威；scope=geo_bank 涉实验锁页 / site_sweep=纯 SEO 侧；v2 脚本+审查双路实证）

> **裁决状态（2026-06-10）**：wzb 经 /goal 采纳下表"建议"列为裁决。**执行权威 = geo 仓 `_staging/sheet-mapping/astrologywiki/conflict-decisions.json`**（conflict-decisions/2，11 组，status 状态机：accepted_ready/pending_human_angle/pending_intent_doc/applied）；本表是发现/输入依据。应用动作统一在窗后第一批（不提前），仅 `accepted_ready` 可标 applied_at。

| # | Sheet 侧 | 冲突 | scope | must_decide | 建议 |
|---|---|---|---|---|---|
| 1 | **PG-MAHADASHA-005 "shani mahadasha" 待写** | **双重撞**：语义别名撞 saturn-mahadasha（**B 轨 treatment**，6-08 刚干预上线）+ 词面父主题撞 mahadasha（**control**） | geo_bank | **是** | **不另写新页**：窗后重指既有页 update，或 defer。另写 = 站内蚕食 + 污染复测 |
| 2 | PG-AURA-009 "aura reading" 待写 | oracle `aura-reading.ts` 已上线（global control） | geo_bank | **是** | 重指既有页作 update（窗后） |
| 3 | **PG-TERM-010 "How to Read a Birth Chart: 4-Layer…"（backlog）** | 与 `how-to-read-birth-chart`（EN+ZH 双版在线）**近乎同题重写**——审查抓出的最严重漏报 | site_sweep | **是** | 重指既有页作大改版 update，或砍掉重规划 |
| 4 | PG-VEDIC-002/003/004（vedic birth chart 系，待写） | `vedic-birth-chart-calculator.ts`（EN+ZH）已覆盖"读懂吠陀星盘/calculator"领地 | site_sweep | **是** | 三条合并裁：重指既有页 update / 明确差异化角度后放行 |
| 5 | PG-RISE-004 "What Is Your Ascendant"（backlog） | 语义同 1st-house-meaning（**treatment**；ascendant=rising sign=1st house cusp，词面零交集靠别名表抓出） | geo_bank | **是** | **窗内 defer**；窗后做须 intent-boundary（概念页 vs 宫位页）+ canonical/链接策略 |
| 6 | PG-EMPATH-005/006/007（HSP 簇 backlog） | HSP 簇 = global control 领地；窗内新增同簇页经 sitemap/主题权重/AI 答案竞争扰动 control | geo_bank | **是** | **窗内一律 defer**（codex 改判，推翻初版"可放行"）；窗后按 intent-boundary + cannibalization check 放行 |
| 7 | PG-TERM-008 "Midheaven in Astrology"（backlog） | MC–IC 轴对页：`ic-astrology.ts` 已覆盖轴另一侧（16 处 midheaven） | site_sweep | 否 | 放行条件：标题/H1/FAQ/锚文本锁定 MC intent，不得泛化成轴总览；与 IC 页互链窗后做 |
| 8 | PG-NODE-011 "Rahu and Ketu vs. North and South Nodes"（backlog） | 与 `north-node-vs-south-node` 同实体对比（rahu/ketu=north/south node），查询空间高度重叠（既有文 0 处提 rahu/ketu，角度有差异） | site_sweep | 否 | 人裁角度差异：建议并入既有页扩一节，或差异化为"吠陀 vs 西方命名"专题 |
| 9 | PG-TRANS-006 "mecury in retrograde" 待写 | `mercury-retrograde-vs-moon-anxiety.ts`（EN+ZH）已做水逆×心理机制角度；**且 Sheet 关键词拼写错误（mecury）** | site_sweep | 否 | 修 Sheet 拼写；规划角度（确认偏误）与既有页（焦虑）差异化后可做 |
| 10 | PG-AI-001 "ai astrology app"（待写，T1 Pillar） | `best-astrology-mental-health-apps.ts`（EN+ZH）共享 "astrology app" 头部查询 | site_sweep | 否 | Pillar 评测页 vs 心理健康榜单意图可区分；做时与既有页互链+差异化标题 |
| 11 | PG-HEAL-005 "Pluto in the 6th House"（backlog）；PG-TRANS-008/RISE-008（rising sign 词面） | 与 6th-house / 1st-house 页词面相邻，placement/sign 专题与宫位页意图不同 | site_sweep | 否 | 按新内容处理；放行条件：标题/H1/FAQ/锚文本锁定 placement intent；窗内不得链锁定页 |

> 台账由 geo 仓 `_sheet-mapping-check.mjs` v2 产出（词面+别名+标题三路，tier 标注信度）+ 双路审查语义补全；全量命中与回溯行号见 `gengrowth-geo/_staging/sheet-mapping/astrologywiki/mapping.md`。

## 实施排期与边界（顺序经 codex 审查反转：**先闸后杠杆**）

- **≈6-22（B 轨复测窗收口）前**：只落本 spec + page-lock 消费约定，**不改流水线代码**；站级修复（FAQPage/WebSite schema/Person 署名/llms.txt，geo 仓 fix-tickets 在手）同样压到窗后。
- **窗后第一批（防污染基建，先行）**：§4 page-lock 三层消费 → §3 三源查重 + zh 对账 → §5 source=geo 溯源字段 → G4 claims ledger 消费。理由：先上杠杆后上闸 = 与"不重叠/不冲突第一约束"倒置。
- **窗后第二批（GEO 杠杆）**：§1 render 注入 → §2 RL-GEO（advisory 起步 + `geo_gate=advisory` 标记）。
- 每步独立可验（`node --test` + 1 篇真实产出过闸）。
- **边界**：geo 仓不直改本仓代码（本文即交接物）；测量数字只出自 geo 确定性脚本；M1/B 轨页面的内容生产不进本流水线的自动改写。

## 风险与未决

1. **citability 阈值未校准**：先 advisory。阈值定错会误杀正常文或放水——校准期对照 geo 仓 audit 的 cohort 分布定初值。
2. **internal-dedup 误报**：同簇系列文（如 12 篇 house 系列）天然词面相近，阈值须按"标题+slug 短语"窄口径起步，n-gram 宽口径只 warn。
3. **page-lock 时效**：锁清单由 geo 仓人工维护，若复测一再延期会长期锁 16 页——锁文件里已写明解除条件（w-after1 收口），到期不解除须显式说明原因。
4. **Sheet 副本漂移**：副本是 6-07 快照迁移，与生产表会渐行渐远；GEO 注册条目搬运前人工核对生产表当前状态。
5. **G4 claims ledger 未落地**：schema 已定义（geo 设计文档 §3-G4），文件未建——落地前 G4"事实一致闸"只是意图，不得宣称已生效。首批种子 = B 轨 no-mock checklist 已核条目。
