# E2E_FLOW.md — 端到端流程拼图（前半段设计 ⨝ 后半段操作）

> **目的**：把 [FRONT_HALF_FLOW.md](./FRONT_HALF_FLOW.md)（找词→选题，设计稿）和 [PIPELINE.md](./PIPELINE.md)（拿到选题→发布，18 步操作手册）拼成**一条链**，并**确认接缝**。
> **状态**：流程梳理（设计），**非落地**。CEO/PM 角色视角见 [OPS_OVERVIEW.md](./OPS_OVERVIEW.md)。
> **记于** 2026-05-29。

---

## 0. 一句话结论

前后两半**不是断的，是重叠的**：PIPELINE.md 的步骤 1-6 本就覆盖了前半段，但它从 `promote(3)` 直接跳到 `fill-v8(4)`，**缺一个"本周写哪些词"的显式选题/队列步骤**。
`gg-queue-build` 填的正是这一刀。接缝**设计上**是**一张表的一行**（选题登记表），字段契约干净（见 §2）。
但**当前未落地状态下接缝并不成立**：promote 还默认写 legacy `1dejq`、后半段读规范表 `1CkjOC`，是两张表（§3.7，最硬的错位）。要对齐的是**两份文档的重叠**、**写表/读表分裂**、**几处机制并存**。

---

## 1. 端到端单链（前设计 ⨝ 后操作）

```
══════════ 前半段（FRONT_HALF_FLOW.md，设计）══════════
 1 mine            DataForSEO → keyword_candidates                     [PIPELINE 1]
 2 approve         人标 wzb_approve=Y（严格大写）                        [PIPELINE 2]
 3 promote         approved → 关键词主表 A-I + 选题登记表 A             [PIPELINE 3]
     └─(新)回填 cluster_id 建议（matcher 首遍猜，仅填空）  ← §4.1(c) 棘轮 ★待落地
 3.6 cluster-init  gg-cluster-init（token/embedding）→ 主题集群表 草稿   [PIPELINE 3.6]
     人设 priority=P0 + week='Week N'（新集群在此作为新行加入）         ← 人只选主题
 3.7 queue-build   gg-queue-build：桶 × cluster优先级 × week × 产能      ★本设计新增的"一刀"
     ├─ 意图门：tool 意图词 → park 留档（不入文章队列）   ← D1 暂搁置 ★待落地
     └─ 文章意图词 → 选题登记表 {A, Status=待写, cluster_id}
 4 fill-v8         人补 F/G/H/I/J/P/R/S/T（brief 内核）+ 确认 cluster_id [PIPELINE 4]  ← 唯一动手处
 5 cluster/CTA     人补 主题集群表 业务字段 + CTA Map 一行              [PIPELINE 5]

━━━━━━━━━━━━━━ 接缝：选题登记表的一行 ━━━━━━━━━━━━━━
   baton = Status 列：  待写（队列态，前半段交付） → 写作中/质检/已发布（后半段推进）
   硬门（bridge fail-loud）：cluster_id 必须命中主题集群表；page_role 必须命中 CTA Map

══════════ 后半段（PIPELINE.md，操作，已成型不动）══════════
 6 bridge          gg-sheet-to-brief：三表 JOIN → override JSON         [PIPELINE 6]
 7 sheet-pull      row → batch fixture                                  [PIPELINE 7]
 8-10 RAG          entity-passport / obsidian / friction → rag.json     [PIPELINE 8-10]
 11 render         batch + override + 3×RAG → v8 prompt（en/zh/both）   [PIPELINE 11]
 12 llm-call       orchestrator：3 LLM 并行 + frontier-strict + retry   [PIPELINE 12]
 13 phase2         structure + RL1-6（共7项）→ PASS 写 manifest          [PIPELINE 13]
 14 publish        PASS → wiki 2 落点 cp                                [PIPELINE 14]
 14b oracle-cv     md → oracle/data/articles/<slug>.ts（zh merge）      [PIPELINE 14b]
 15 commit         wiki repo git commit（不 push，人触发）              [PIPELINE 15]
 16-18 (可选)      deploy / monitor(GSC+GA4) / retro                    [PIPELINE 16-18]
```

★ = 本次设计相对 PIPELINE.md 现状的**增量**，全部为**待落地**（§5.2），现在不实现。

---

## 2. 接缝的数据契约：选题登记表一行，谁填哪列

> 列字母按 spec（`lib/_workbook-spec.mjs`）；代码（`gg-sheet-pull.mjs` HEADER_MAP / `gg-queue-build.mjs` indexPagesHeader）**按 header 名映射，抗列位漂移**——即便 live 表多了 `author` 列致字母偏移，契约仍以"名"为准。

| 列 | 字段 | 填写者 | 时点 | 后半段是否必需 |
|---|---|---|---|---|
| A | Target Keyword | promote(3) | 前 | bridge entry key |
| C/D | 月搜索量/KD | VLOOKUP 公式 | 自动 | — |
| F | Tier | 人 fill-v8(4) | 前 | ✅ 决定字数/红线宽容 |
| G | Template | 人 | 前 | ✅ Pillar/Tutorial/Definition |
| H | Entity | 人 | 前 | ✅ RAG 主体 + RL4 |
| I | Friction | 人 | 前 | ✅ 喂 friction_themes |
| J | Logic | 人 | 前 | ✅ 写作 angle |
| K | CTA | 可选（CTA Map 覆盖） | 前 | 可空 |
| **M** | **Status** | **queue-build 置「待写」→ 人推进** | **接缝 baton** | **待写=入列信号** |
| P | page_id | 人（或 promote slug） | 前 | ✅ 稳定 slug |
| **Q** | **cluster_id** | **queue-build 建议 + 人确认** | 前（§4.1c） | ✅✅ **bridge 不命中即 FATAL** |
| R | page_role | 人 | 前 | ✅✅ **bridge 不命中 CTA Map 即 FATAL** |
| S | content_angle | 人 | 前 | ✅ |
| T | psych_safety_flag | 人 | 前 | ✅ Y→触发 RL6 disclaimer |
| U | journal_prompts | 可选 | 前 | 可空 |

**接缝最硬的两个 key**：`Q cluster_id`（queue-build 已写）与 `R page_role`（仍靠人填）。bridge(6) 对二者 fail-loud——所以**前半段交付后，人必须先填完 brief（尤其 R）才能放行进后半段**，这正是 §2 的"唯一动手处"。契约一致，无缝隙。

---

## 3. 接缝暴露的需对齐项（不是 bug，是梳理点）

### 3.1 两份文档在前半段重叠 → queue-build 是 PIPELINE.md 缺的步
PIPELINE.md 总览 `3 promote → 4 fill-v8` 之间没有显式选题步；`promote --also-draft-pages` 把**所有** approved 词无差别写进选题登记表 A 列。**没有"本周选哪 N 个"的闸**。
→ `gg-queue-build` 即此闸（暂记为 **PIPELINE 步骤 3.7**，区别于本文 §3.7 那条错位发现）。**落地后应把它补进 PIPELINE.md 总览**，否则两份文档对前半段各执一词。

### 3.2 两个 cluster 机制并存 → 创建 ≠ 归属，需分清
- `gg-cluster-init`（PIPELINE 3.6，token/embedding 聚类）= **创建** 主题集群表的集群草稿。
- §4.1(c) 主表 `cluster_id` 列 + 棘轮 = 把**已有关键词归属**到已有集群（JOIN）。
二者**互补不冲突**：cluster-init 建集群、棘轮做归属、queue-build 读归属。文档需点明，避免被当成一回事。

### 3.3 embedding 基建已存在 → §4.1 结论微调（仍选 c）
`gg-cluster-init --algo embedding`（ollama/openai）**已有向量聚类基建**。所以 §4.1 否决"语义匹配"不是因为没基建，而是：**JOIN（归属）用一个确定的、可审计的 cluster_id 列比每词跑 embedding 更简单**；embedding 更适合它已在做的**集群创建**。结论 (c) 不变，理由更精确。

### 3.4 §4.2 新集群可由 cluster-init 起草，非手搓
astrocartography / ai_astrology / rising_signs 等新集群，**就绪时可对未归词重跑 cluster-init 起草**，再 `gg-cluster-fields-suggest` 补业务字段——而非手工建表。（仅设计提示，现在不做。）

### 3.5 意图门（D1 park）在 PIPELINE.md 无落点 → 需定 park 去处
PIPELINE.md 无"tool vs article 意图"概念。park 的 tool 词要有去处不丢失：候选 = 新增 Status 值（如 `暂存`）或一个专用视图 tab。**落地意图门时一并定**。

### 3.6 config 机制前后不对称（提醒，非阻塞）
前半段规则 = Sheet 公式（实时、人改）；后半段阈值 = 代码 + `gg-config-sync` 快照。两套配置源。不阻塞链路，但全局一致性上值得记一笔。

### 3.7 ⚠️【最硬错位】写表/读表分裂 → 当前接缝实际断开
§0 的"接缝是一张表的一行"是**设计目标**，当前**不成立**：`gg-keyword-promote`/`fallback` 默认写 legacy `1dejq`（`GG_SHEETS_WORKBOOK_ID`），而 `gg-queue-build` 与整个后半段读规范表 `1CkjOC`（`GG_SHEETS_FLOW_MVP_WORKBOOK_ID`）。
→ **promote 写进的那行 ≠ bridge 读的那张表**，除非先做 env 改指向（FRONT_HALF_FLOW §5.2 #3）。这是前后半段间最要命的真实错位，不是"config 不对称"那么轻。**落地顺序上，env 改指向应排在 queue-build 意图门之前。**

### 3.8 ⚠️【真 bug，待修】bridge fix-script 把 page_role 指到错列
`gg-sheet-to-brief.mjs:591` `SHEET_COL_FOR = { cluster_id:'Q', page_role:'P' }`——但 spec 里 **P=page_id、R 才是 page_role**。page_role join 失败时，bridge 的 fuzzy fix 提示会让人去改 **P（page_id）列**，改错地方。读字段靠 header 名不受影响，但**人按提示改表会改错列**，恰好反噬本接缝"靠人确认/修 R"的设计。→ 一行常量改 `page_role:'R'` 即修（待落地项，归 §5.2）。

### 3.9 跨凭据 + Status 静默降级（次要依赖）
- 接缝那一行：queue-build 用 **writer SA** 写、sheet-pull/bridge 用 **OAuth** 读，跨凭据（不算 bug，属未点明依赖）。
- `gg-queue-build.mjs:419` 找不到 `Status` 列时 fallback 到 `内容状态`（那是**关键词主表**的列名），两者皆缺则 `statusCol=null`、**静默不写「待写」**→ 新行不进队列也无报错。§2 把 Status 称作"唯一入列信号"，这条静默失败路径需在落地时加断言防护。

---

## 4. 收口：前半段流程梳理完成

- **设计**：✅ 定稿。前半段（本文 + FRONT_HALF_FLOW.md）与后半段（PIPELINE.md）已拼成一条链；接缝 = 选题登记表一行 + Status baton，**字段契约**（§2）确认无缝隙。
- **当前阻断**：写表/读表分裂（§3.7）——**落地第一步必须是 env 改指向，排在 queue-build 意图门之前**，否则前后接的是两张表。
- **增量待落地**（★，逐项放行再做；与 FRONT_HALF_FLOW §5.2 合并）：
  1. **env 改指向 1CkjOC**（§3.7，最优先，解阻断）
  2. queue-build 意图门（park tool 词）+ park 去处（§3.5）
  3. 主表 cluster_id 列 + promote 回填（§4.1c）
  4. 修 bridge `SHEET_COL_FOR` page_role→'R'（§3.8，一行常量）
  5. queue-build Status 列断言防护（§3.9）
  6. 把 queue-build 补进 PIPELINE.md 总览（步骤 3.7）
- **后半段**：不碰（§3.8 的 bug 仅记录待修，不在本次动）。
