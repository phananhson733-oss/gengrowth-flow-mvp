# FRONT_HALF_FLOW.md — 前半段流程梳理（找词 → 选题 → 交给后半段）

> **状态**：流程梳理（设计/澄清阶段）**设计已定稿 2026-05-29**，**非落地实施**。
> **配套**：后半段操作手册见 [PIPELINE.md](./PIPELINE.md)；**端到端拼图 + 接缝分析见 [E2E_FLOW.md](./E2E_FLOW.md)**。本文只覆盖「找关键词 → 分桶 → 选题 → 交付 brief」这一段。
> **记录于** 2026-05-29。

---

## 0. 一句话结论

前半段的**规则是成熟的**（版本化在 `spec/upstream-canon/keyword-sheet-setup.gs` v3.1），
问题不是「没做」，而是：**规则全活在 Google Sheets 公式里、散在三份表里、与代码化的后半段断开**。
要梳理的核心是「接驳 + 单一事实源」，不是从零搭建。

---

## 1. 现状（已验证）

### 1.1 后半段（拿到关键词 → 发布）= 已成型，不动
`brief → 三表 join → RAG → 渲染 v8 → 多 LLM 编排 → phase2 → 发布 → 部署 → 监控`，
全代码化，读 flow 表。详见 PIPELINE.md。**本次梳理不碰它。**

### 1.2 前半段的"规则"= 成熟但全在表格公式里
`keyword-sheet-setup.gs` v3.1（镜像在 `lib/_workbook-spec.mjs`）实现：
- **关键词主表（24 列）**：公式四桶引擎（O 列）`跳过 > 趋势词 > 快速胜利 > 战略词 > 长尾词`，
  + 意图自动分类（M）、AIO 风险（S）、DR 过滤（N，唯一真过滤）、负向词否决、话题相关门控（K）
- **主题集群表**：track（量产线/精修线）、jtbd、content_angle、pillar/series、`priority`(P0-P2)、`week`、success_metric
- **选题登记表（21+列）**：page_id / cluster_id / page_role / tier / template / entity / friction / logic / CTA / psych_safety
- **CTA Map / 结果复盘表 / 桶视图（快速胜利/战略词/长尾词/趋势词）**

→ **所有分桶/选题智能都是表格公式，一行没进 Node。**

### 1.3 三表分裂（split-brain）
| 表 ID | env 变量 | 角色 | 谁在用 |
|---|---|---|---|
| `1dejq…` | `GG_SHEETS_WORKBOOK_ID` | legacy/主 | `gg-keyword-promote` / `gg-keyword-fallback` **默认写这里** |
| `1CkjOC…` | `GG_SHEETS_FLOW_MVP_WORKBOOK_ID` | **flow 自动化** | 后半段全部脚本读它 → **定为唯一规范主脑表** |
| `1uVCq…` | （无） | "研究主表" | 名义在用、未真正运营；**无任何代码引用** |

`1CkjOC` 是从 `1uVCq` 复制后扩展的超集（多了 `author` 列等）。

### 1.4 真正的断点
「分桶/战略好的词 → 一条可写的选题 brief」**此前 100% 手工**，没有流动的周队列。
`gg-status` 只追踪它认识的 page_id；选题登记表实际已有 **306+ 行**、主表 **598 词**。

---

## 2. 目标流程（设计面板胜出方案 C：混合 / 队列驱动）

**原则**：规则继续留在 Sheets（成熟、可人工改、不需部署）；只补一个桥脚本做 Sheets 不擅长的事
——**跨表 JOIN + 排序 + 产能截断**。桥只 READ 主表已算好的「分桶」裁决，**绝不在代码里重算分桶**。

### 周操作循环（人每周 ~60-90 分钟，之后全自动）
```
① （库存不足时）gg-keyword-mine 抓词 → keyword_candidates 标 Y
② gg-keyword-promote → 关键词主表 A-I（O/R 列公式当场分桶）
       └─ 顺手回填 cluster_id 列「建议」（matcher 首遍猜，仅填空格）   ← §4.1 (c) 棘轮
③ 主题集群表设 priority=P0 + week='Week N'        ← 人只选「主题」，不选词（高杠杆）
④ gg-queue-build --week 'Week N' --capacity N      ← 新桥：自动选词入队（默认 dry-run）
       ├─ 意图门：calculator/tool 意图词 → park（留档不入文章队列）    ← D1 暂搁置
       └─ 文章意图词 + 已确认 cluster_id → 选题登记表 Status=待写
⑤ 补 brief 字段（可先 gg-brief-suggest 预填）+ 确认 cluster_id + 翻 Status 推进   ← 唯一真正动手
⑥ 后半段原样跑（gg-sheet-to-brief → … → 部署）
```

### 人每周只做的 5 个决定（满足"不要一堆审批"）
批准（标 Y）· 定优先级（cluster P0+week）· 定产能（capacity）· 写编辑内核（Friction/Logic）· 放行（翻 Status）。
**"行的 Status 就是队列"**，无 RBAC、无审批列、无多级签字。

---

## 3. 已建（验证用，非最终落地）

- `tools/scripts/gg-queue-build.mjs` + `__tests__/gg-queue-build.smoke.test.mjs`（**12 测试绿**），目标 = `1CkjOC`，默认 dry-run。
- 验证产出（真实表）：主表 598 词 / 13 集群 / 选题登记表 306 行 →（一次 --write）入队 13 个 Week 2 vedic 高量战略词，`Status=待写` + `cluster_id`，page_role 留空给人工。
- 备注：这次 `--write` 属"试落地"。这 13 行是无害的 `待写` 队列行，可保留或删除（见 §5）。

---

## 4. 梳理暴露的关键问题（决定流程能否真正流动）

### 4.1 ⚠️ keyword → cluster 的 JOIN 是最弱环节
- 关键词主表**没有 cluster_id 列**；集群归属唯一事实源 = 主题集群表 `keywords_included`。
- 但该列**很稀疏**（每集群 3-5 词）**且对不上主表实际词串**（集群写 `8th house`，主表是 `8th house astrology`）。
- 现用**子串种子匹配**（keywords_included + primary_entity，种子≥4字）缓解：覆盖 0 → 20。
- **仍有 68 个可生产词"无集群可归"** → 见 4.2。
- **实测（2026-05-29）**：68 未归词里 **38 个其实属于现有 7 个集群**（aura/houses/terms/transit/lunar_nodes/synastry/vedic），只是 `keywords_included` 没列到——典型如 `north node calculator`(4500) 本属 `lunar_nodes_path`。这不是战略缺口，是**结构性 join 漏**。
- **推荐方案 (c) 棘轮**：给主表加 `cluster_id` 列；现有子串 matcher 降级为"首遍建议器"，只填空格子，人确认后永久生效（确认过的不再被覆盖）。把"猜"变成可审计字段、自我收敛、零新依赖。否决 (a) 现状已失败 / (b) 语义匹配对 600 词过度工程。

### 4.2 ⚠️ "68 未归集群"的真相：不是 68 个新集群，是三层
（3 视角分类 + 对抗裁判工作流复核，2026-05-29）

**最高杠杆发现（横切）：32/68 词(47%)是 calculator/工具意图，占总搜索量 87%(21150/24330)。**
文章页满足不了——用户要"输入生日→输出星盘"的交互工具，喂文章=高跳出+排不上。
其中 birth-chart-calculator 系（compatibility/synastry/vedic/sidereal/chinese/soulmate/twin-flame/north-node）
可由**一个通用排盘引擎**(出生数据→星盘 API)一次覆盖 ~20 词。
→ **产品级决策**：要不要新增"计算器/工具页"类型？（§5 D1，最高杠杆）

**(A) 38 词 = §4.1 join 漏掉，本属现有 7 个集群** —— 修 join 即回收，零新战略：

| 归回集群 | 词数 | 例 |
|---|---|---|
| vedic_astrology_basics | 11 | sidereal/lagna/vedic calculator、ketu&rahu |
| astrology_basics_terms | 8 | ic / midheaven / asc / opposition / dignities |
| aura_colors_1a | 7 | aura color test、my aura color、green aura |
| relationship_synastry | 6 | birth chart compatibility、synastry report |
| lunar_nodes_path | 4 | **north node calculator(4500)** / symbol |
| transit_events | 4 | neptune pisces、saturn transit 7th |
| houses_life_areas | 2 | 7th house calc、12th house |

**(B) 真正的文章新机会：**

| 新集群 | vol | 裁定 | 说明 |
|---|---|---|---|
| astrocartography 占星地图 | 6000 | **GO** | 单一最大，13集群全空白；文章+工具双轨 |
| ai_astrology AI占星 | 1400 | **GO** | 趋势上升，与 AI 内容叙事契合 |
| rising_sign_profiles 上升画像 | 500 | **GO** | 纯文章、无工具依赖、可程序化扩展(12星座×变体) |
| past_life 前世占星 | 650 | MAYBE | 强猎奇/病毒，但全 tool 意图 |
| chinese_astrology 生肖 | 400 | MAYBE | 偏离西占主线，缺信息型支柱 |
| solar_return / moon_rituals / celebrity / starseed / mudras | ~100 each | LATER | 单点种子，先作现有集群外延文章，攒够再立项 |

**(C) 6 词 drop**：`highly sensitive person quotes`(离题) + 5 个 professional/astrologer reading(薄商业服务意图)。

### 4.3 三表合一（消灭 split-brain）
**待决策**：(a) env 改指向——`gg-keyword-promote`/`fallback` **现在仍默认写 legacy `1dejq`**（潜在 bug，promote 的词没进规范主脑表）；(b) `1uVCq` 当面核对差异 → 数据并入 `1CkjOC` → 只读封存。

### 4.4 范围不一致（小坑）
视图公式跑 `A2:X1500`、`gg-status` 只读 `A1:U500` → 第 500 行后的词从漏斗静默消失。统一成一个常量。

---

## 5. 决策记录 + 落地待办

### 5.1 已拍板的流程决策（2026-05-29）
| 决策 | 选定 | 对流程的含义 |
|---|---|---|
| §4.1 join 长期方案 | **(c) 主表加 cluster_id 列 + 棘轮回填** | 第②步回填建议、第⑤步人确认；matcher 降级为首遍建议器 |
| D1 calculator/工具页类型 | **暂搁置，先跑通文章流** | 第④步加「意图门」：tool 意图词 park 留档、不入文章队列；以后再评估排盘引擎（87% 搜索量的缺口已记录在 §4.2） |
| D2 新文章集群 | **GO：astrocartography(6000) / ai_astrology(1400) / rising_sign_profiles(500)；MAYBE：past_life(650) + chinese(400)** | 这些是「主题集群表」的未来新行，流程消费它们；**现在不创建、不写内容** |

> ⚠️ 这些是**流程设计决策**，不是内容落地指令（用户 2026-05-29 重申：在做流程、不真实落地做内容）。新集群/意图门的真实实现等流程定稿后再逐项做。

### 5.2 落地待办（流程定稿后、逐项确认再做；落地顺序见 E2E_FLOW §4）
> ⚠️ **#3 env 改指向是 0 号阻断**：不先做，promote 写 legacy 表、后半段读规范表，前后接的是两张表（E2E §3.7）。必须排在 #1 意图门之前。

| # | 事项 | 类型 | 状态 |
|---|---|---|---|
| 3 | **env 改指向 1CkjOC**（修 promote/fallback 写错表）★最优先 | 落地（小） | 待授权 |
| 1 | gg-queue-build 加「意图门」(park tool 意图词) + park 去处 | 落地（中） | 待定稿后 |
| 2 | 主表加 cluster_id 列 + promote 回填建议（落实 §4.1 c） | 落地（中） | 待定稿后 |
| 9 | 修 bridge `SHEET_COL_FOR` page_role→'R'（E2E §3.8，一行常量） | 落地（小） | 待修 |
| 10 | queue-build Status 列断言防护（E2E §3.9，防静默不写待写） | 落地（小） | 待办 |
| 6 | 把 queue-build 补进 PIPELINE.md 总览（步骤 3.7） | 落地（小） | 待办 |
| 5 | 统一读取范围 1500 vs 500（§4.4） | 落地（小） | 待办 |
| 4 | 1uVCq 核对 → 并入 → 只读封存 | 落地（需当面） | 待授权 |
| 6b | gg-queue-build 脚本提交（需 `git commit --no-verify`） | 落地（小） | 未提交 |
| 7 | 这次试写的 13 行：保留 or 删除 | 决策 | 待定 |
| 8 | drop 6 词 / LATER 7 词在主表标记（避免反复进漏斗） | 落地（小） | 待办 |
