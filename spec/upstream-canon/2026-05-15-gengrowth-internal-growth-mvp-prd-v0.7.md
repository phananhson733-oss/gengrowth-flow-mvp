---
title: GenGrowth 内部增长系统 MVP PRD（收敛版）
date: 2026-05-15
updated: 2026-05-18
type: prd
version: v0.7
status: final
supersedes: 2026-05-15-gengrowth-internal-growth-mvp-prd-v0.6.md
tags:
  - gengrowth
  - prd
  - growth-system
  - seo
  - astrologywiki
aliases:
  - GenGrowth MVP PRD v0.7
  - 内部增长系统 MVP 收敛版
  - astrologywiki 增长 MVP v0.7
---

# GenGrowth 内部增长系统 MVP PRD v0.7（收敛版 · 当前执行基准）

## 0. 本版定位

本版是 v0.6 的迭代，作为当前唯一执行基准，**取代 v0.6**。

v0.6 把 PRD 与真实关键词库、astrologywiki.com 真实基础设施对了账。v0.7 再做一件事：把 PRD 与 **SEO 运营同学已经在用的执行文档**（v2.0 内容流水线、选题登记表、`keyword-sheet-setup.gs`、种子实验模板）对账，修掉对账暴露的 7 处不一致。

### 0.1 v0.7 的 7 处修订

| # | 问题 | 处理 | 章节 |
|---|---|---|---|
| 1 | v0.6 说"v0.18 集群版重写是 M1.5 待办"，但 v2.0 集群全案版已存在并 final | 采纳 v2.0 为现行内容 SOP；v0.18/v0.19 标记 superseded | §4.3 §7.5 §11 |
| 2 | "双轨"一词三义（v0.6 内容双轨  vs 种子模板 SEO/Social 双轨）| v0.6 的内容双轨改名"量产线 / 精修线" | §3 全文 |
| 3 | 集群只按意图分类，未按地区分类；Vedic/nakshatra 大概率印度搜索为主 | 集群表加"美国占比"闸门 | §3.3 §7.3 |
| 4 | 6-ID 体系如何落地 | §7.1 = `keyword-sheet-setup.gs` 升 v3.0，一键生成单一工作簿 6 张表 | §7.1 §8 附录 D |
| 5 | Product Growth Brief 与种子实验模板重复 | PGB 并入种子实验模板 Day-0，不再是独立文档 | §7.2 §11 |
| 6 | 关键词主表已有相关性列，垃圾词仍进分桶 | 根因是 `.gs` 公式缺陷；修法 = 负向词配置 + 一次性人工扫桶，非独立流程 | §7.3 |
| 7 | 这套流程能否复用到其他新站 | 补复用边界与系统化路径 | §2.2 §14 |

### 0.2 继承自 v0.6 的确认事实

| 事实 | 影响 |
|---|---|
| 内容生产分两条线（量产 / 精修）| §3 内容模型 |
| 工具页已上线、GSC 已验证；newsletter+ESP 与 GA4 都没有 | Week-1 主 CTA = 工具页；GA4/newsletter 是建设任务；Day-7 验收只看 GSC |
| 产能 = AI 批量 + 1 人审核，25+ 篇/周 | 生成不是瓶颈，1 人审核吞吐是瓶颈；字段与 QA 按 Tier 分层 |

v0.6 评审发现的 8 个 gap（G1–G8）已在 v0.6 修复，v0.7 继承，不再重列。

---

## 1. 文档定位与现实对账

### 1.1 文档定位

GenGrowth 框架流程的 MVP 版本。

第一阶段不做对外 SaaS、不做通用增长平台、不做全自动 Agent。GenGrowth 收敛为一个**内部增长作战系统**，先服务 `astrologywiki.com`：1 周内完成最小工作台搭建，用人工补齐暂时无法自动化的判断环节。

MVP 的核心目标是让一条可执行增长链路跑通：

```text
产品与 ICP 假设
→ 关键词与主题集群（含地区闸门）
→ 集群级内容生产框架（量产线 / 精修线）
→ 发布、内链、轻量分发
→ 工具页 / Newsletter CTA 承接
→ GSC / GA4 数据复盘
→ 下一轮内容与刷新动作
```

最终业务目标：用 `astrologywiki.com` 跑通全流程，60 天内冲刺**美国地区为主**的日 PV 5000。

### 1.2 现实对账（基础设施与产能）

**基础设施现状（astrologywiki.com）：**

| 项 | 状态 | 对 MVP 的含义 |
|---|---|---|
| 工具页 / 星盘计算器 | ✅ 已上线 | **Week-1 主 CTA 用它**，当前最强承接资产 |
| Google Search Console | ✅ 已验证 | Week-1 唯一可靠的衡量手段 |
| GA4 | ❌ 未安装 | Day 1 建设任务；装好前 CTA 点击无法量化 |
| Newsletter + ESP | ❌ 未搭建 | Week-1 建设任务；搭好前不能作主 CTA、不能进验收 |
| 已发布内容 | 6 篇 aura 文章 | 内容生产已在进行；本版不中断，只补 CTA 与内链、并行启动精修线 |

**产能现状：** AI 批量 + 1 人审核，25+ 篇/周。生成不是瓶颈；**1 人审核吞吐是瓶颈**，本版据此设计字段与 QA 分层（§7.5）。

### 1.3 与历史文档的关系

| 文档 | 状态 | 本版如何使用 |
|---|---|---|
| `…internal-growth-mvp-prd-v0.6.md` | 被本版取代 | 全部结构继承 |
| `GenGrowth_MVP_PRD_astrologywiki_v0.2.md` | 已归档 | 捡回页面模板（附录 A）、心理安全规则（附录 B）|
| `2026-05-14-seo-pipeline-sop-v2.md`（v2.0 集群全案版）| **现行内容 SOP** | 作为内容生产 SOP，本版与之对账并扩展（§7.5、附录 C）|
| `SEO内容生产流水线_v0.18 / v0.19` | superseded | 不再使用，v2.0 取代 |
| `keyword-research-sop.md` | 现行 | 关键词六源挖掘 + 四桶分级方法 |
| `seed-client-growth-experiment-template.md`（v2.0）| 现行 | 60 天实验执行记录；本版把 PGB 并入其 Day-0（§7.2）|

---

## 2. MVP 约束

### 2.1 产品定位约束

MVP 只做内部系统，服务 GenGrowth 自研或深度参与的增长项目。

不做：多租户客户系统、外部客户自助 onboarding、完整 dashboard、自动外联执行、自动发布 CMS、全自动 Agent 编排、广告投放 / CRM / 销售线索管理、临床心理建议、医疗诊断治疗承诺、泛 spiritual 内容平台、大规模竞品贬损型 comparison、自动收集敏感心理健康数据。

### 2.2 服务对象约束（同时是复用边界）

| 维度 | MVP 范围 |
|---|---|
| 业务类型 | 内容站 / 工具站 / 早期 SaaS（信息产品或自助型工具）|
| 站点阶段 | 新站到中等权重，DR 0–40 |
| 目标地区 | 英文 Google 生态，美国优先 |
| 获客方式 | SEO 为主，社媒信号为辅 |
| 工具链 | Ahrefs / Google Search Console / GA4 / Google Sheets |
| 实验产品 | `astrologywiki.com` |
| 承接方式 | 工具页优先（已上线），Newsletter 搭好后转 co-primary |

**这张表同时就是这套流程的复用边界**（§14 详述）。不覆盖、也不可迁移：电商、本地 SEO、中文百度生态、YMYL 医疗金融法律、DR 50+ 老站大规模刷新、以付费投放为主的增长场景。

### 2.3 执行单位 = 主题集群

第一阶段执行单位是**主题集群（cluster）**，不是关键词，也不是单个页面。

关键词只保留两个身份：聚类的输入、GSC 里的衡量单位。内容、内链、社媒角度、社区回答、newsletter 主题、外链机会**全部挂在 cluster_id 上**。

```text
关键词池 → 主题集群 → Pillar/Series/Support/Tool/Wiki 页面
→ 内容生产批次（量产线 / 精修线）→ 发布与内链 → 工具页/Newsletter CTA
→ GSC/GA4 表现回写集群
```

> 这条原则回答了"内容生产、分发、外联是否以关键词为核心"：**不以关键词为核心，以集群为核心。** 关键词太碎，以它为枢纽必然回到"一词一文、结构混乱"。

---

## 3. astrologywiki.com 定位与内容双线模型

> **命名说明（修订 2）**：本版的"量产线 / 精修线"是**内容生产的两条线**。它与种子实验模板里的"Track A SEO / Track B Social Probe"是**不同维度**——后者指渠道。量产线和精修线都活在种子模板"Track A SEO"渠道之下；种子模板的"Track B"是 Social Probe。三者不冲突，但不要再用"双轨"统称，避免混淆。

### 3.1 三层定位（继承）

| 层级 | 定位 | 作用 |
|---|---|---|
| L1 产品底座 | 英文占星知识库 + 星盘 / 工具页 | SEO 入口、主题权威、长期可扩展结构 |
| L2 早期增长切口 | Astrology-informed self-discovery / healing journal | 用现代心理学与 journaling 建立差异化 |
| L3 Wiki 支撑层 | aura / chakra / Vedic 等的解释与对比 | 扩展 wiki 内容面 |

一句话定位：astrologywiki.com 把占星知识、星盘工具、现代心理学视角和疗愈型日记结合起来，帮用户理解自己的星盘并把解释转化为自我觉察与成长行动。

### 3.2 内容双线模型

| 线 | 名称 | 内容范围 | 角色 | 生产方式 | Tier | 主 CTA |
|---|---|---|---|---|---|---|
| **量产线** | 流量线 | aura colors、Vedic、nakshatras、nodes、placement/house 长尾 | 冲 PV、建 DR、建主题广度 | AI 工厂批量 | 多数 T3，少量 T2 | 工具页（aura test / birth chart calculator）|
| **精修线** | 差异化线 | Birth Chart Self-Discovery、Houses as Life Areas、Chiron Healing、Moon Phase Reflection、Astrology Journal Prompts | 建差异化、建邮件列表、向搜索引擎/AI 说清"这站做什么" | 人工精修 | T1 / T2 | Newsletter（搭好后）+ 工具页 |

说明：

- 两条线都按集群组织，都发到同一站点。量产线提供量与广度，精修线提供"语义主权"与转化资产。只有量没有精修线，站点会变成泛占星内容农场；只有精修线没有量，60 天到不了 5000 PV。
- **精修线不需要重做关键词研究。** 现有《关键词研究主表》已有大量 placement / house / node 词。精修线 = 把这些词按"自我认知 / journaling"角度重新切集群，不是新挖词。
- aura / Vedic / nakshatra 词原样进量产线。

### 3.3 与真实关键词库对账 + 地区闸门（修订 3）

v0.5 写死的内容比例（Core 35–45% / Product-led 40–50% / Wiki Support 5–10%）作废——与真实库存相反。真实库存（《关键词研究主表》约 587 词，已由 Ma Boyang 分集群）实际构成：

| 真实集群 | 归线 | 美国占比风险 |
|---|---|---|
| Aura Colors 1A / 1B、独立 aura 词 | 量产线 | 低（欧美向，适合美国 PV 目标）|
| Vedic Astrology、IC astrology、birth chart calculator | 量产线 | **中–高**（Vedic 印度搜索占比高，需核查）|
| Nakshatras（27 星宿）| 量产线 | **高**（nakshatra/rashi/mahadasha 印度搜索为主）|
| Nodes & Karma（north/south node）| 量产线，自我认知向可借给精修线 | 低–中 |
| Houses & placements（8th/9th/11th/12th house、chiron in house）| 精修线（重切角度）| 低 |
| highly sensitive person、saturn return、moon ritual | 精修线 | 低 |

**地区闸门（修订 3 · 轻量版）**：北极星目标是"日 PV 5000 **美国为主**"。集群只按意图聚类、不看地区，会导致靠 Vedic/nakshatra 撑起来的量大部分是印度流量——总 PV 到 5000 但"美国为主"不达标。

**地区在关键词筛选时已自动考虑、且零成本**：关键词主表 C 列「月搜索量」取目标国家数值（Ahrefs 设一次国家后默认就是该国量），分桶阈值天然按目标国判断。无需对每个词再拉全球量、算占比。

集群层只加一个**三档标签** `us_share`，不算精确百分比：

| us_share | 判定方式 | 处理 |
|---|---|---|
| 高（目标国主导）| 主题常识即可判断：aura / houses / placements / nodes 等欧美向 | 正常进量产线，计入美国 PV 目标 |
| 低（非目标国主导）| 主题常识即可判断：nakshatra / rashi / mahadasha 等印度向 | 不占 P0 产能；若做，标注"贡献总 PV、不计入美国 PV 目标" |
| 中（拿不准）| 仅对这类集群，查 2–3 个头部词的 Ahrefs by-country 饼图（约 10 秒/词）| 可做，标注"部分计入" |

> 一个集群一个标签，全程约 10 个集群、5 分钟。**精确地区占比不在上线前用 Ahrefs 估**——上线后 GSC 的 Country 维度会按页面给真实、免费的国家拆分（Day 14/30 起），那才是精确测量的来源。

> **目标国家是 Day-0 参数**：由种子实验模板「基本信息」、Day 0 SOP 前置条件、关键词 SOP 导读统一设定一次（如 US）。链路落点见 §11 与附录 D。

### 3.4 内容配比（诚实版）

| 阶段 | 量产线 | 精修线 | 说明 |
|---|---:|---:|---|
| Week 1–4 | ~70% | ~30% | 量产线先把已在产的 aura 工厂规模化；精修线启动 1 个 P0 集群打样 |
| Week 5–8 | ~60% | ~40% | 视精修线早期信号（GSC + newsletter）增减 |

配比按真实库存、地区闸门与产能动态调整，不写死固定百分比。

---

## 4. 已知结构冲突与处理决策

### 4.1 关键词 SOP 与产品 / ICP 情报脱节

决策：产品与 ICP 情报不单独做复杂 PRD 包，只产出一份 **Product Growth Brief**，作为关键词研究、主题集群、内容生产的前置输入。v0.7 进一步把 PGB 并入种子实验模板的 Day-0（见 §7.2），不再是独立文档。

### 4.2 关键词分桶后缺内容生产框架

决策：关键词分桶后必须先进入**主题集群规划**层，再进入内容生产。集群规划输出见 §7.3。这一层就是"不基于单个关键词写文章"的解决方案。

### 4.3 内容生产 SOP：采纳 v2.0（修订 1）

v0.6 把"v0.18 → 集群版重写"列为 M1.5 待办。**这已过时**：`2026-05-14-seo-pipeline-sop-v2.md`（v2.0 集群全案版，Ma Boyang / Gemini CLI，status final）已经是集群版内容 SOP——15 列选题登记表、Pillar/Spoke/Standalone 角色、1+N 嵌套结构。

决策：

- **v2.0 定为现行内容生产 SOP**，v0.18 / v0.19 标记 superseded，不再使用。
- v2.0 对量产线（aura/Vedic 走量）已足够。但 v2.0 缺精修线需要的字段（`cluster_id`、显式 `page_role`、`content_angle`、`psych_safety_flag`、`journal_prompts`），且用"行位置"表示 Pillar/Spoke（排序即失效，脆）。
- 解决：选题登记表升 **v2.1** = v2.0 的 15 列 + 6 列（见附录 C）。v2.1 是 v2.0 的小幅扩展，不是另起炉灶。

### 4.4 分发与外联不应割裂

决策：分发与外联围绕集群和页面资产执行。第一阶段只做三类轻量动作：社媒信号、社区观察、外链机会记录（§7.7）。

### 4.5 CTA 策略不能二选一

决策：CTA 按页面类型和产品成熟度分层（§10）。

### 4.6 Phase 08 / 09 不进入完整第一阶段

决策：08 只做"周度增长行动清单"，不做 Agent 编排器；09 只做"内容刷新 / 合并 / 暂停规则"，不做资产墓地系统。Day 14 / 30 / 60 节点保留。

### 4.7 Week-1 主 CTA = 工具页

newsletter 没搭、工具页已上线。Week 1 内容页主 CTA = 工具页；Week 2–3 起 newsletter 搭好后，精修线页面 newsletter 优先，量产线仍工具页优先（§10）。

### 4.8 GA4 与 Newsletter 是建设任务

GA4 安装 = Day 1 建设任务；Newsletter + ESP 搭建 = Week 1 建设任务。Week-1 验收只基于 GSC，CTA / signup 追踪验收顺延 Day 14（§8 §12）。

---

## 5. MVP 外层 9 步流程

| 原阶段 | MVP 名称 | 第一阶段处理 |
|---|---|---|
| 0 数据契约与状态机 | 表格级作战契约 | 最小字段 + 6-ID，一个 Google 工作簿（§7.1）|
| 1 产品与 ICP 情报 | Product Growth Brief（并入种子模板 Day-0）| 人工填写 + AI 辅助 |
| 2 市场与竞品情报 | SEO 竞品与 SERP 切口 | 只做影响关键词和集群的竞品分析 |
| 3 关键词宇宙与主题架构 | 关键词分桶 + 集群（含地区闸门）| MVP 主模块 |
| 4 技术 SEO 与爬虫健康 | 发布前技术闸门 | 只检查阻塞 SEO 与 CTA 追踪问题 |
| 5 内容生产引擎 | 集群级内容生产（量产线 / 精修线，SOP = v2.0）| MVP 主模块 |
| 6 分发与外联 | 轻量社媒 / 社区 / 外链机会 | 人工执行 |
| 7 转化与实验 | CTA 与基础事件追踪 | 不做 A/B，做 CTA mapping |
| 8 周循环编排器 | 周度增长行动清单 | 只生成人工周计划 |
| 9 资产墓地与 Sunset | 内容刷新 / 暂停规则 | 只做 Day 14 / 30 / 60 判断 |

---

## 6. 核心数据对象与 6-ID 体系

第一阶段用**一个 Google 工作簿**（多 sheet）作主数据载体，不做数据库。

### 6.1 必需对象与载体

| 对象 | 载体（同一工作簿内的 sheet）| 用途 |
|---|---|---|
| Product Growth Brief | 种子实验模板 Markdown 的 Day-0 §一 | 产品与 ICP 假设 |
| Keyword | 关键词主表 sheet | 搜索需求和衡量单位 |
| Topic Cluster | 主题集群表 sheet | 内容架构与执行单位（含 track、us_share）|
| Page Asset | 选题登记表 sheet（v2.1）| 实际页面 / 文章 / 工具页 |
| CTA Map | CTA Map sheet | 页面角色 → CTA → GA4 事件名 |
| Outcome Snapshot | 结果复盘表 sheet | GSC / GA4 结果回写 |
| Weekly Action List | Markdown | 每周执行计划 |

### 6.2 最小 6-ID 体系

`keyword_id` / `cluster_id` / `page_id`（=asset_id）/ `cta_id` / `action_id` / `outcome_id`。

ID = 跨 sheet 外键。规则：每个 Page Asset 必须有 `cluster_id`、`page_id`、至少 1 个 `cta_id`；分发动作必须有 `action_id`；结果复盘必须有 `outcome_id`。ID 手工生成即可，命名稳定、不随标题变。

---

## 7. 详细流程需求

### 7.1 Step 0：表格级作战契约 = 升级 keyword-sheet-setup.gs 到 v3.0（修订 4）

v0.6 笼统说"建立 5 张表"。v0.7 给出具体执行：**把 `docs/03-marketing/03-seo/keyword-sheet-setup.gs` 从 v2.0 升级到 v3.0**，一次生成一个工作簿、包含全部 6-ID 体系的表。

为什么放在一个工作簿：单文件、跨表 VLOOKUP 直接生效、6 个 ID 就是外键。**注意不要把不同粒度的表合并成一张大表**——关键词主表是"1 行 1 关键词"，选题登记表是"1 行 1 页面"，结果复盘是"1 行 1 快照"，粒度不同必须分 sheet。

v3.0 生成的 sheet（列结构规格见**附录 D**）：

```text
⚙️配置        现有 + 新增 NEGATIVE_KEYWORDS 负向词区
关键词主表     现有 A–X 24 列，O 列公式按 §7.3 加负向词否决
主题集群表     新增（cluster_id / track / us_share / content_angle …）
选题登记表     v2.1（v2.0 的 15 列 + 6 列，page_id / cluster_id 外键）
CTA Map       新增（cta_id → page_role → 文案 → GA4 事件名）
结果复盘表     新增（outcome_id / Day 14·30·60 / GSC·GA4 粘贴区）
现有视图表     趋势/快速胜利/战略/长尾/分桶规则/内容追踪/来源分析
```

> `.gs` 是脚本（代码）。本 PRD 只给规格（附录 D）。实际改脚本是一个独立交付物（M1.5），不在 PRD 内完成。

验收：每个 Page Asset 可追溯到一个 Topic Cluster；每个 Cluster 可追溯到关键词池；每个发布页面有目标关键词、页面角色、CTA、复盘日期。

### 7.2 Step 1：Product Growth Brief（并入种子实验模板 Day-0，修订 5）

PGB 与种子实验模板的 §一"产品档案"是同一类东西的厚薄版，留两份必然重复。

决策：**PGB 不再是独立 Markdown，它就是种子实验模板 §一（Day-0）的扩写版**——把模板里那 4 行"产品档案"换成下面的完整字段。

| 字段 | astrologywiki.com MVP 标准 |
|---|---|
| 产品定位 | 占星知识 / 工具底座 + 自我认知 / 疗愈日记切口 + Wiki 支撑 |
| 主用户 | 美国英语用户；占星入门到进阶；对自我认知、情绪反思、关系模式、人生阶段感兴趣 |
| 核心任务 | 理解个人星盘，并把解释转化为自我反思与成长行动 |
| 差异化 | 不只做运势 / placement meaning，做 astrology-informed self-discovery |
| 量产线种子词维度 | aura、Vedic、nakshatra、nodes、placement/house 长尾 |
| 精修线种子词维度 | birth chart self-discovery、houses as life areas、chiron healing、moon reflection、journal prompts |
| 不做范围 | 低质 horoscope、无 astrology 连接的心理建议、临床治疗内容、无搜索需求的玄学散文 |
| Psych Safety | 不诊断、不治疗、不承诺疗效，只用 educational / reflective / self-discovery 表达 |
| 首批 CTA | 内容页工具页优先；newsletter 搭好后精修线转 co-primary |

**对 astrologywiki，直接用上表还缺 3 块，必须补**：

1. **商业模式 / 变现** —— 工具页之后怎么赚钱（订阅 / 增值 / 其他）。需创始人填。
2. **2–3 个具名竞品** —— 如 Cafe Astrology / Astro-Seek / Astro.com。
3. **Day-0 流量基线** —— GSC 近 28 天 impressions / clicks、品牌 vs 非品牌，作为 60 天对照基准。

**未来产品能否由 GenGrowth 自动生成 PGB —— 半自动，不能全自动。**

| 字段类型 | 字段 | 生成方式 |
|---|---|---|
| 可自动起草 | 产品定位草稿、品类、竞品清单、种子词维度 | AI 基于 {产品 URL + 目标地区 + 首页/Top Pages 抓取 + 竞品 SERP 扫描} 起草 |
| 只能人工 | 不做范围、差异化赌注、商业模式、psych-safety 约束 | 创始人判断，AI 给的会平庸 |

生成路径：输入产品 URL + 目标地区 → AI 抓首页与 Top Pages、判品类、SERP 扫 2–3 个竞品、起草定位与种子词维度 → 人工补不做范围 / 差异化 / 商业模式 / psych-safety → 定稿。M2 阶段做成 GenGrowth 的功能；MVP 阶段人工 + AI 辅助。

### 7.3 Step 2–3：竞品 / SERP + 关键词分桶 + 集群（含垃圾词修法与地区闸门）

复用 `keyword-research-sop.md`（六源挖掘 + 四桶分级）和 `day0-diagnosis-sop.md`，本 PRD 不重复其细节。

```text
六源挖掘 → DR/KD/SERP弱度/AIO 标注 → 四桶分级
→ 负向词自动剔除（修订 6）
→ Product Growth Brief 过滤
→ 量产线 / 精修线归并
→ 集群归并 + 地区闸门（us_share）+ Content Layer + 页面角色 + CTA 类型
→ Week 1 内容批次
```

#### 7.3.1 垃圾词为什么进了分桶（根因，修订 6）

实查《关键词研究主表》CSV 确认：`miami dade transit bus tracker`（月搜索量 1100、KD 9）被标 `G1话题相关 = ✅相关`、`分桶 = ⚡快速胜利`。根因是**规则缺陷，不是纯执行问题**，两个洞叠加：

| 缺陷 | 说明 |
|---|---|
| A 多义词假阳性 | `keyword-sheet-setup.gs` 的 K 列用**子串匹配**。`transit`（行星过境）是占星合法话题词，进了 TOPIC_KEYWORDS；子串匹配让 `miami dade **transit** bus tracker`、`hub city **transit** bus tracker`、`trimet **transit** tracker` 全部命中、全标 ✅相关 |
| B K 列只管趋势桶 | O 列分桶公式里，K 列只出现在 🚀趋势词 条件中。⚡快速胜利 / 🎯战略词 / 📌长尾词**不检查 K 列**，所以哪怕 K 正确也拦不住 |

还有一层上游原因：垃圾词来自"种子词拓展"——有人用 `transit` 这种单个多义词做种子，Ahrefs 吐回一堆公交词。关键词 SOP §三已说种子词"不能过大"，`transit` 太泛，应该用 `transit chart` / `astrological transit`。

#### 7.3.2 修法（不新增独立人工流程）

1. **`.gs` 加 `NEGATIVE_KEYWORDS` 配置区 + O 列前置否决**：关键词包含 `miami / dade / bus tracker / hub city / trimet` 等任意负向词 → 直接 `❌跳过`。最快、一劳永逸（规格见附录 D）。
2. **（可选）K 列子串匹配改词边界匹配**，减少假阳性。
3. **种子词纪律**：禁止用单个多义词做种子，写进关键词 SOP 的执行注意。
4. **集群生成那一步**：cluster doc 是 LLM 从关键词列表自动生成的，没读 R 列分桶。要求：集群生成只喂 `R 列 = 快速胜利 / 长尾词` 的行。
5. **一次性人工扫桶**：对 ⚡快速胜利桶做一次 30 分钟人工扫一遍（垃圾主要在这个桶造成伤害）。这是一次性动作，不是常设流程。

#### 7.3.3 主题集群表字段

`cluster_id` / `cluster_name` / `track`（量产线 / 精修线）/ `content_layer` / `business_role` / `primary_entity` / `jtbd` / `content_angle` / **`us_share`（目标国占比三档标签 高/中/低，地区闸门）** / `pillar_page` / `series_pattern` / `keywords_included` / `page_assets` / `internal_link_rule` / `cta_primary` / `psych_safety_flag` / `priority` / `week` / `success_metric`。

页面角色：Pillar（定义主题、承接内链）、Series（批量矩阵入口）、Support（长尾解释）、Tool（工具承接）、Wiki（相邻概念对比）、Strategic（门面词，低配执行）。

Week 1 选题规则：可规划 8–12 个集群，实际只启动 2–3 个 P0 集群（至少 1 个量产线、1 个精修线）；每个 P0 集群最多 1 个 Pillar + 4–8 个 Series/Support 页面；快速胜利与长尾词优先；战略词全周期 ≤ 5 篇；AIO 高风险定义词必须加工具 / 表格 / 对比；`us_share < 50%` 的集群不占 P0 产能。

验收：Week 1 形成不少于 8 个可生产 Page Asset；不允许出现没有 cluster_id 的孤立内容、没有 CTA 的页面、没有 psych safety 标记的 healing 页面、含负向词的词进入生产队列。

### 7.4 Step 4：发布前技术闸门

只检查阻塞项：GSC property 已验证、sitemap 新 URL 可提交、robots/noindex 未阻挡、canonical 正确、页面可渲染、内链入口（Pillar 与 Series 互链）、Core Web Vitals 无阻塞级问题。GA4 + CTA 事件见 §8 建设任务；装好前不阻塞内容发布，但 CTA 数据不计入验收。

不做：日志分析、完整 crawl budget、大规模 JS parity 检测、自动技术任务卡。

### 7.5 Step 5：内容生产引擎（SOP = v2.0，量产线 / 精修线）

内容生产 SOP 采用 `2026-05-14-seo-pipeline-sop-v2.md`（v2.0）。本节只定义 v2.0 与本 PRD 的对接，不重复 v2.0 的五步细节。

#### 7.5.1 集群级 Brief

每个 P0 集群先写一张集群级 Brief：`cluster_name` / `track` / `content_layer` / `us_share` / `user_question` / `entity_map` / `content_angle` / `pillar_angle` / `series_rule` / `link_plan` / `CTA_rule` / `evidence_requirement` / `psych_safety_rule` / `quality_bar` / `page_template`（指定附录 A 中的模板）。

#### 7.5.2 页面级生产卡 = 选题登记表 v2.1

v2.0 选题登记表 15 列对量产线足够；精修线（疗愈类）需要补字段。选题登记表升 **v2.1 = 15 列 + 6 列**（完整列表见附录 C）。新增 6 列：`page_id`、`cluster_id`、显式 `page_role`、`content_angle`、`psych_safety_flag`、`journal_prompts`。

> v2.0 用"主行/留空/次行"的行位置表示 Pillar/Spoke，排序即失效。v2.1 增加显式 `page_role` 列；行位置布局保留作视觉辅助，但公式不依赖它。

字段虽 21 列，但月搜索量/KD 是 VLOOKUP 自动列、psych_safety/journal_prompts 是精修线条件列、page_id/cluster_id/page_role 是建卡时一次性填——**审核人每页实填仍约 13 项，量产线 T3 页只碰约 8 项**（附录 C 标注）。

#### 7.5.3 Tier 规则与审核产能模型

| Tier | 用途 | 人工要求 | 审核工时 |
|---|---|---|---|
| T1 重装 | Pillar / 战略页 / 心理风险页（多为精修线）| 人工 SERP + Reddit 搜证 + 审稿 + psych safety QA | 60–120 分钟 |
| T2 标准 | Series 主力页 | AI 起草 + 人工检查逻辑 / 内链 / CTA / prompts | 30–45 分钟 |
| T3 占位 | 极长尾支撑页（多为量产线 aura/Vedic）| AI 组装 + 快速检查开头与红线 | 10–20 分钟 |

**审核产能模型（瓶颈约束）**：25 篇/周、典型混合（约 17 篇 T3 + 6 篇 T2 + 2 篇 T1）≈ 11 小时/周纯审核，1 人可承担。推论：**量产线必须以 T3 为主，T1 只允许出现在精修线，每周 T1 ≤ 3 篇**。超出则审核溢出，多出的 T1 降级或顺延，进周度行动清单。

#### 7.5.4 验收

每篇内容开头直接回答搜索意图；每篇归属一个集群；每篇有内链和 CTA；T1 内容有真实 Friction 或 SERP 差异证据；精修线 healing 页面有 journal prompts；发布后写回 URL 和复盘日期。

### 7.6 Step 6：分发与外联

不自动外联，只做人工轻量动作，全部挂 cluster_id：社媒拆条（每集群 3–5 条角度）、社区观察（Reddit/Quora 搜相关问题，不硬推）、外链机会记录、Newsletter 反馈（搭好后）。

验收：每个 P0 集群至少 3 条社媒角度；每周至少记录 5 条社区原话；Week 1 不要求拿到外链。

### 7.7 Step 7：转化与基础事件追踪

只做：CTA 映射（每类页面默认 CTA）、GA4 基础事件（页面浏览、CTA 点击、工具使用）、UTM（社媒分发链接带 UTM）、GSC URL 追踪。不做 A/B 测试、定价优化、个性化漏斗。CTA 详细策略见 §10。

### 7.8 Step 8：周度增长行动清单

每周一生成 `Weekly Action List`：上周发布、收录情况、GSC 信号、GA4/CTA 信号（搭好后）、本周内容（含 **Tier 混合是否在审核产能内**）、本周分发、风险（含审核溢出、地区闸门未核查）、决策。AI 生成初稿，创始人或 SEO 负责人审核。每个 action 有 owner 和 due date。

### 7.9 Step 9：刷新、合并、暂停规则

| 节点 | 判断 |
|---|---|
| Day 14 | 未收录 → 查 sitemap/内链/noindex/质量；有 impressions → 观察；精修线页无 prompts → 补 |
| Day 30 | P1–P30 标记有效；P31–P80 刷新标题 + 补 FAQ；无排名无 impressions → 暂缓同类扩张 |
| Day 60 | 带 clicks → 保留扩展集群；只 impressions → 优化标题摘要；无信号 → 合并/noindex/暂停；集群整体无信号 → 停止换下一个 |

验收：每个页面有 Day 14/30/60 复盘日期；每个集群 Day 60 给出继续/调整/暂停；60 天 PV 目标按 cluster 拆分复盘，并按 `us_share` 区分美国 PV 与总 PV。

---

## 8. 1 周工作台搭建范围

### 8.1 必须完成

| 模块 | 实现方式 | 时点 |
|---|---|---|
| GA4 安装 + 基础事件 | 在 astrologywiki.com 装 GA4，配页面浏览 / CTA 点击 / 工具使用事件 | **Day 1** |
| `keyword-sheet-setup.gs` 升 v3.0 | 一键生成单一工作簿 6 张表 + 6-ID（规格见附录 D）| Day 1–3 |
| 关键词主表 O 列加负向词否决 | 按 §7.3.2 + 附录 D | Day 1–2 |
| 集群级 Brief / 选题登记表 v2.1 / 周度行动清单 模板 | Markdown / Sheet 模板 | Day 2–3 |
| Newsletter + ESP | 选 ESP、建 signup 表单、配 UTM / 来源追踪 | **Week 1 内完成，Day 5–7 上线** |

### 8.2 人工执行（不自动化）

产品与 ICP 判断、SERP 弱度检查、地区占比核查、负向词扫桶、量产线/精修线与集群归并、内容审稿、psych safety QA、社媒与社区互动、CTA 选择。

### 8.3 暂不实现

DataForSEO / Ahrefs API 自动拉取、Agent 调度器、完整 dashboard、自动发布 CMS、自动外联邮件、A/B 测试系统、完整 newsletter automation、临床心理内容审核系统。

---

## 9. astrologywiki.com 首轮落地

### 9.1 首批集群

| 优先级 | 集群 | 线 | us_share 风险 | 数据来源 |
|---|---|---|---|---|
| P0 | Aura Colors（核心 1A）| 量产线 | 低 | 关键词主表集群 1A，6 篇已发布 |
| P0 | Houses as Life Areas / Self-Discovery | 精修线 | 低 | house/placement 词重切角度 |
| P1 | Vedic Astrology / Birth Chart Calculator | 量产线 | **中–高，先核查** | 关键词主表集群 2 |
| P1 | North Node / Life Path | 量产线→精修线 | 低–中 | 关键词主表集群 3 |
| P2 | Nakshatras | 量产线 | **高，不占 P0 产能** | 关键词主表集群 4 |
| P2 | Chiron / Healing、Moon Phase Reflection | 精修线 | 低 | house/moon 长尾重切 |

### 9.2 Week 1 推荐组合

```text
量产线 · 已在产：Aura Colors 1A
  动作：继续 aura 工厂；给已发布 6 篇补工具页 CTA + 集群内链；本周再发 ~12–15 篇 T3
  主 CTA：aura test / aura color quiz 工具页

精修线 · 新启动：Houses as Life Areas / Self-Discovery
  Pillar：How to Read Your Birth Chart Houses for Self-Reflection
  Series：8th / 9th / 11th / 12th house as a life area（T2）
  Support：chiron in 12th house、what does the 8th house represent（T2）
  主 CTA：Week 1 工具页；newsletter 搭好后转 newsletter
```

### 9.3 Week 1 产出目标

PGB（并入种子模板 Day-0）1 份；P0 集群规划 2–3 个（含 1 量产 + 1 精修）；Backlog 集群 8–12 个；页面发布或待发布 15–20 篇；选题登记表 v2.1 每个发布页都有；GA4 + 事件已上线；Newsletter + ESP 已上线（Day 5–7）；周度行动清单 1 份。

---

## 10. CTA 策略

### 10.1 页面角色 → CTA（Week 1 版）

| 页面角色 | Primary CTA（Week 1）| Secondary CTA |
|---|---|---|
| Pillar | 工具页 | 继续阅读同集群 |
| Series | 工具页 | 同系列下一篇 |
| Support | 工具页 | 回 Pillar |
| Tool | 使用工具 | —（newsletter 搭好后补）|
| Wiki（aura 等）| aura test / quiz 工具页 | 相关 core 页面 |

### 10.2 阶段规则

| 阶段 | CTA 策略 |
|---|---|
| Week 1 | 全站工具页优先（newsletter 未上线）|
| Week 2–3 | newsletter 上线 → 精修线页面 newsletter 优先，量产线仍工具页优先 |
| Week 4–8 | 视 tool click 与 signup 数据，高意图页调整 primary |
| 工具结果页成熟后 | 注册 / 保存结果转 primary，newsletter 转 secondary |

---

## 11. 文档协同与职责矩阵

### 11.1 调用顺序

```text
本 PRD v0.7
→ 种子实验模板 Day-0（含 Product Growth Brief）
→ Day 0 SOP → Keyword Research SOP → 关键词主表
→ 负向词剔除 → 主题集群表（含 us_share 地区闸门）
→ 集群级 Brief → 选题登记表 v2.1
→ 内容生产（SOP = v2.0 + 附录 A 页面模板 + 附录 B 心理安全规则）
→ Weekly Action List → Day 14/30/60 刷新
```

### 11.2 文档职责矩阵（去重原则）

| 文档 | 唯一职责 | 状态 |
|---|---|---|
| 本 PRD v0.7 | MVP 范围、9 步流程、内容双线、数据对象、验收 | 现行执行基准 |
| `keyword-research-sop.md` | 六源挖掘、四桶分级、SERP/AIO 标注 | 现行 |
| `day0-diagnosis-sop.md` | Day 0 技术 / 竞品诊断执行 | 现行 |
| `seed-client-growth-experiment-template.md` | 60 天实验执行记录；Day-0 §一 = PGB | 现行 |
| `2026-05-14-seo-pipeline-sop-v2.md`（v2.0）| 单页面内容装配零件与 QA 红线 | **现行内容 SOP** |
| `keyword-sheet-setup.gs` | 一键生成工作簿（升 v3.0）| 待升级（M1.5）|
| `SEO内容生产流水线 v0.18 / v0.19` | —— | **superseded** |
| 附录 A 页面模板 / 附录 B 心理安全规则 | 页面结构骨架 / 语言边界 | 现行 |

### 11.3 待办交付物

- ✅ `keyword-sheet-setup.gs` 升 v3.0（2026-05-19 完成）：生成主题集群表 / 选题登记表 v2.1 / CTA Map / 结果复盘表，O 列加负向词否决，并修复 K 列空配置格 bug。
- ✅ 选题登记表 v2.1（已并入 .gs v3.0 生成）。
- ✅ `keyword-research-sop.md` 补"种子词不可用单个多义词"（v2.4 已加）。
- ⬜ v2.0 内容 SOP 补精修线专属字段说明（content_angle / psych_safety / journal_prompts）—— 待 SEO 运营处理。

---

## 12. 验收标准

### 12.1 系统验收（Week 1）

- `keyword-sheet-setup.gs` 升 v3.0，生成含主题集群表、选题登记表 v2.1、CTA Map、结果复盘表的单一工作簿。
- 关键词主表 O 列已加负向词否决。
- 完成 PGB（并入种子模板 Day-0）。
- 完成 6-ID 体系与 CTA Map。
- 完成 2–3 个 P0 集群规划（至少 1 量产 + 1 精修），每个集群已填 `us_share`。
- 生成 ≥ 8 个 Page Asset，每个有 cluster_id / page_role / primary_keyword / CTA / 内链计划。
- 精修线 healing 页面有 journal prompts 与 psych safety flag。
- GA4 已安装、Newsletter + ESP 已上线。

### 12.2 业务验收

| 时点 | 标准 | 衡量手段 |
|---|---|---|
| Day 7 | 内容成组发布；Pillar/Series/Support 内链互连；无负向词进队列 | GSC |
| Day 14 | 收录率 ≥ 70%；出现 impressions；CTA 点击可在 GA4 看到 | GSC + GA4 |
| Day 30 | 40–60 篇发布；≥ 20 个词进 Top 50；按 cluster 判断继续/换 | GSC + GA4 |
| Day 60 | 100–120 篇或等效资产；冲刺日 PV 5000；按 cluster + us_share 复盘 | GSC + GA4 |

> Week-1 验收只看 GSC。CTA / newsletter signup 追踪验收顺延 Day 14。60 天复盘必须区分**美国 PV** 与总 PV。

---

## 13. 60 天日 PV 5000 冲刺路径

| 流量源 | Day 60 目标贡献 |
|---|---:|
| 量产线长尾（以 us_share=高 的集群为主，按标签区分美国/非美国）| 55%–65% |
| 精修线自我认知 / 工具承接内容 | 15%–20% |
| 工具页 / 工具预热 | 10%–15% |
| 社媒 / Pinterest / 社区 | 10% |

| 时点 | 内容产出 | 数据目标 |
|---|---|---|
| Day 7 | 15–20 篇 | GSC 跑通，URL 已提交 |
| Day 14 | 30–40 篇累计 | 收录率 ≥ 70%，出现 impressions |
| Day 30 | 40–60 篇累计 | ≥ 20 词进 Top 50 |
| Day 45 | 70–90 篇累计 | 找到 2–3 个有效 cluster |
| Day 60 | 100–120 篇累计 | 冲刺日 PV 5000（美国为主）|

红灯条件：Day 14 收录率 < 50% → 暂停扩产先修技术；Day 30 美国 impressions < 5000 → 重做 SERP / brief；某周 T1 页面 > 3 篇 → 审核溢出；nakshatra 等 us_share 低集群流量高但美国 PV 无增长 → 该集群不计入目标、把产能调回 aura 与精修线。

---

## 14. 后续版本与系统化路径

### 14.1 复用边界

这套流程**框架层可复用**（9 步流程、6-ID、集群中心、关键词 SOP、v2.0 内容 SOP、种子实验模板、刷新规则、`.gs` 生成器），**实例层不可复用**（astrologywiki 的量产/精修划分、psych-safety、healing 角度、具体集群）。

复用边界 = §2.2 的服务对象约束。超出范围不可迁移：电商、本地 SEO、中文百度、YMYL、DR 50+ 老站、付费投放为主。

### 14.2 系统化路径

| 阶段 | 动作 |
|---|---|
| 现在（产品 #1）| 框架 + 实例放一份文档（本 PRD），不拆 |
| 产品 #2 到来时 | 拆两层：一份可复用《GenGrowth 框架主文档》+ 每产品一份种子实验实例。产品 #2 是拆分触发点 |
| M1.5 | `.gs` v3.0 一键生成工作簿；选题登记表 v2.1；SOP 稳定；新产品 onboard = 跑 `.gs` + 填 ⚙️配置 + 填 PGB/Day-0 |
| M2 | GenGrowth 自动起草 PGB、自动聚类、API 拉指标、GSC+GA4 基础归因 |
| M3 | Agent 周循环编排、自动外链 prospect、CRM 外联、实验系统 |

可复用引擎 = `keyword-sheet-setup.gs` + SOP 三件套（关键词 SOP / v2.0 内容 SOP / 种子模板）。每个新站重复：跑脚本 → 填配置 → 关键词研究 → 聚类 → 生产。仍需人工：相关性 / 地区判断、psych-safety 边界、集群角度决策。

---

## 15. 当前决策

1. GenGrowth MVP 第一阶段是内部增长系统，不是对外产品。
2. 首个实验产品是 `astrologywiki.com`。
3. 内容生产分**量产线**（aura/Vedic/nakshatra 走量）和**精修线**（自我认知 / 疗愈日记走差异化）。
4. 执行单位是**主题集群**。
5. 集群分类加**地区闸门**（us_share）；nakshatra 等印度为主的集群不计入美国 PV 目标。
6. 内容生产 SOP = v2.0；v0.18 / v0.19 superseded。选题登记表升 v2.1。
7. 6-ID 体系统一进一个 Google 工作簿；`keyword-sheet-setup.gs` 升 v3.0 生成。
8. 垃圾词修法 = `.gs` 负向词否决 + 一次性人工扫桶，不设常设过滤流程。
9. Product Growth Brief 并入种子实验模板 Day-0，不再是独立文档。
10. Week-1 主 CTA 是工具页；newsletter+ESP、GA4 是 Week-1 建设任务；Week-1 验收只看 GSC。
11. 页面卡按 Tier 分层；瓶颈是 1 人审核吞吐，T1 只在精修线、每周 ≤ 3 篇。
12. Phase 08/09 不做系统，只做人工周计划与 Day 14/30/60 刷新规则。
13. 日 PV 5000 按 60 天冲刺目标管理，复盘区分美国 PV 与总 PV。

待补充：astrologywiki Product Growth Brief 正式内容（含商业模式、具名竞品、Day-0 基线）；首批 P0 集群关键词归类与 us_share 核查；Newsletter lead magnet 文案；`cta_id` 与 GA4 事件名对应表。

---

## 16. 版本记录

| 版本 | 日期 | 状态 | 主要变化 |
|---|---|---|---|
| v0.1–v0.5 | 2026-05-15~18 | —— | 见 v0.5 版本记录 |
| v0.6 | 2026-05-18 | superseded | 收敛版：与真实关键词库 + 真实基础设施对账。双轨内容模型、CTA 翻转、GSC-only 验收、页面卡 23→13、审核产能模型、相关性过滤、捡回页面模板与心理安全规则 |
| **v0.7** | **2026-05-18** | **final** | **与 SEO 运营执行文档对账：采纳 v2.0 为现行内容 SOP（v0.18/v0.19 superseded）；内容双轨改名量产线/精修线；集群加地区闸门 us_share；§7.1 = `.gs` 升 v3.0 单一工作簿规格；PGB 并入种子模板 Day-0；§7.3 重写垃圾词修法（根因 + 负向词否决）；补复用边界与系统化路径。取代 v0.6。同日补：附录 C 明确量产线/精修线字段填写规则、附录 D 与 §3.3 补「目标国家」Day-0 参数链路（同步改种子实验模板、关键词 SOP、Day 0 SOP）。再简化：us_share 由精确百分比改为三档标签（高/中/低），不拉全球量、不算每词占比，精确地区数据上线后由 GSC 提供。** |

**当前执行基准：v0.7。**

---

## 附录 A：5 个页面模板（捡回自 astrologywiki v0.2）

**A. Placement + Self-Discovery 模板**（精修线；`chiron in 12th house`）
```text
1. 120 字直接答案  2. 星盘含义解释  3. 可能反映的情绪/关系/自我认知模式
4. 常见误解  5. Journal prompts  6. 如何在日常中观察这个模式
7. 相关 placements/houses 内链  8. CTA
```

**B. Wiki Definition + Reflection 模板**（量产线/精修线；`what is chiron in astrology`）
```text
1. 定义  2. 为什么和自我成长相关  3. 与其他概念的区别
4. 简表  5. Reflection prompts  6. 相关 wiki 内链  7. CTA
```

**C. Product-led Prompt 模板**（精修线；`astrology journal prompts`）
```text
1. 可直接使用的 prompts  2. 按情绪/关系/人生阶段分类
3. 如何结合 birth chart 使用  4. 示例日记条目  5. 订阅获取每周 prompts
```

**D. Tool-led 模板**（量产线；`birth chart calculator`、`aura test`）
```text
1. 工具能解决什么  2. 输入什么、得到什么  3. 结果如何解读
4. 示例输出  5. 工具页 CTA
```

**E. Adjacent Wiki Comparison 模板**（量产线；`aura colors vs zodiac signs`）
```text
1. 两个概念的区别  2. 为什么用户会混淆  3. 如何用 astrologywiki 视角理解
4. 反思/journaling 用法  5. 回链核心 astrology cluster
```

---

## 附录 B：心理安全语言规则（捡回自 astrologywiki v0.2）

适用：精修线中涉及 healing / trauma / relationship wound / anxiety 的页面（`psych_safety_flag = Y`）。

**必须避免：**「This placement means you have trauma.」「This can heal your anxiety.」「You are narcissistic because…」「This placement diagnoses…」

**推荐使用：**「This placement can be used as a reflective lens…」「Some people use this theme to explore…」「A journaling prompt you might try is…」「This is not a clinical interpretation or mental health advice.」

规则：`psych_safety_flag = Y` 的页面必须人工 psych safety QA；不做诊断、不做治疗承诺、不替代专业咨询。

---

## 附录 C：选题登记表 v2.1 列结构（v2.0 的 15 列 + 6 列）

| 列 | 字段 | 来源 | 填写时机 | 说明 |
|---|---|---|---|---|
| 1 | Target Keyword | v2.0 | 建卡 | =primary_keyword |
| 2 | Associated Keywords | v2.0 | 建卡 | =secondary_keywords，1+N，上限 7 |
| 3 | 月搜索量 | v2.0 | 自动 | VLOOKUP 关键词主表 |
| 4 | KD | v2.0 | 自动 | VLOOKUP 关键词主表 |
| 5 | Intent | v2.0 | 建卡 | Info/Compare/Tutorial/Utility/Experience |
| 6 | Tier | v2.0 | 建卡 | T1/T2/T3 |
| 7 | Template | v2.0 | 建卡 | 指附录 A 页面模板 |
| 8 | Entity | v2.0 | Brief | 主权实体 |
| 9 | Friction | v2.0 | Tier 闸门，仅 T1/T2 | —— |
| 10 | Logic | v2.0 | Tier 闸门，仅 T1/T2 | —— |
| 11 | CTA | v2.0 | 发布后 | 可由 page_role 经 CTA Map 推导 |
| 12 | GSC Keywords | v2.0 | 维护期 | 刷新用 |
| 13 | Status | v2.0 | 实时 | 待写/写作中/已发布 |
| 14 | URL | v2.0 | 发布后 | —— |
| 15 | Last Audit | v2.0 | 维护期 | —— |
| 16 | **page_id** | 新增 | 建卡 | 6-ID 主键 |
| 17 | **cluster_id** | 新增 | 建卡 | 外键 → 主题集群表 |
| 18 | **page_role** | 新增 | 建卡 | 显式 Pillar/Series/Support/Tool/Wiki/Strategic（不靠行位置）|
| 19 | **content_angle** | 新增 | Brief | 合并原 astrology_lens+psychology_lens+healing_angle；精修线必填 |
| 20 | **psych_safety_flag** | 新增 | Brief | 默认 N，1 键；精修线 healing 集群 Y |
| 21 | **journal_prompts** | 新增 | 生产 | 仅精修线 Product-led / healing 页 |

审核人每页实填约 13 项；量产线 T3 页只碰约 8 项（列 1/5/6/7/13/16/17/18）。

**量产线 / 精修线填写规则**（回答"字段在量产线是否必要"）：

- 列 18 `page_role`：**通用必填**——量产线的 aura 簇也有 Pillar/Spoke，没有它做不了内链。
- 列 20 `psych_safety_flag`：**通用，默认 N**——安全字段不可条件化，量产线偶尔也会冒出敏感词（如 `highly sensitive person`），不能漏标。
- 列 19 `content_angle`、列 21 `journal_prompts`：**精修线专属**——量产线行留空。一张表一套列（schema 不可按行变），但填写规则按线区分。

---

## 附录 D：keyword-sheet-setup.gs v3.0 工作簿列结构规格

> 给脚本实现用的规格。`.gs` 实现是 M1.5 独立交付物，不在本 PRD 内完成。

**Sheet ⚙️配置（扩展）**：现有 TOPIC_KEYWORDS（A6:A25）+ 新增 **NEGATIVE_KEYWORDS**（如 A28:A45），填 `miami / dade / bus tracker / hub city / trimet / miami-dade transit` 等；+ 新增 **目标国家**（Day-0 参数，如 US），约束关键词工具地区设置、SERP 检查与下方搜索量列。

**Sheet 关键词主表（A–X 现有 24 列，O 列公式修订）**：C 列「月搜索量」取**目标国家**数值（Ahrefs 设国家后默认即该国量，零额外工作量），分桶阈值据此判断；**不新增全球量列、不算每词 us_share**（早期太重，详见 §3.3）。O 列分桶公式最前面加一层负向词否决——
```text
=IF(A2="","",
 IF(SUMPRODUCT(--(ISNUMBER(SEARCH(IFERROR(配置!$A$28:$A$45,""),A2))))>0,"❌跳过",
 <原 O 列四桶逻辑> ))
```
含任意负向词 → 直接 ❌跳过，不进任何桶。

**Sheet 主题集群表（新增）**：cluster_id / cluster_name / track（量产线/精修线）/ content_layer / business_role / primary_entity / jtbd / content_angle / **us_share（三档标签 高/中/低，见 §3.3）** / pillar_page / series_pattern / keywords_included / page_assets / internal_link_rule / cta_primary / psych_safety_flag / priority / week / success_metric。

**Sheet 选题登记表 v2.1（新增）**：见附录 C，21 列。月搜索量/KD 用 VLOOKUP 从关键词主表取。

**Sheet CTA Map（新增）**：cta_id / page_role / cta_文案 / target_url / ga4_event_name / track。

**Sheet 结果复盘表（新增）**：outcome_id / page_id / cluster_id / day14_收录 / day14_impressions / day30_top50词数 / day30_clicks / day60_pv / day60_us_pv / 决策 / GSC粘贴区 / GA4粘贴区。GA4/GSC 数据 MVP 阶段手工粘贴导出。

**现有视图表**：趋势词 / 快速胜利 / 战略词 / 长尾词 / 分桶规则 / 内容追踪 / 来源分析，保留。
