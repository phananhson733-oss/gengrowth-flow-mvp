# FRONT_HALF_FLOW.md — 前半段流程梳理（找词 → 选题 → 交给后半段）

> **状态**：流程梳理（设计/澄清阶段），**非落地实施**。
> **配套**：后半段操作手册见 [PIPELINE.md](./PIPELINE.md)；本文只覆盖「找关键词 → 分桶 → 选题 → 交付 brief」这一段。
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
③ 主题集群表设 priority=P0 + week='Week N'        ← 人只选「主题」，不选词（高杠杆）
④ gg-queue-build --week 'Week N' --capacity N      ← 新桥：自动选词入队（默认 dry-run）
⑤ 补 brief 字段（可先 gg-brief-suggest 预填）+ 翻 Status 推进   ← 唯一真正动手
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

### 4.2 ⚠️ 68 个高价值词"无集群可归" = 内容战略缺口
`astrocartography` / `sidereal` / `chinese birth chart` / `past life` / `AI astrology` / `synastry calculator`…
这些是 13 集群战略里**根本没有的方向**，是关键词研究**反向暴露的机会**。
**待决策（创始人级）**：哪些开新集群、哪些并入现有、哪些放弃。

### 4.3 三表合一（消灭 split-brain）
**待决策**：(a) env 改指向——`gg-keyword-promote`/`fallback` **现在仍默认写 legacy `1dejq`**（潜在 bug，promote 的词没进规范主脑表）；(b) `1uVCq` 当面核对差异 → 数据并入 `1CkjOC` → 只读封存。

### 4.4 范围不一致（小坑）
视图公式跑 `A2:X1500`、`gg-status` 只读 `A1:U500` → 第 500 行后的词从漏斗静默消失。统一成一个常量。

---

## 5. 待办 / 待决策清单（梳理阶段，逐项澄清后再落地）

| # | 事项 | 类型 | 状态 |
|---|---|---|---|
| 1 | keyword→cluster join 的长期方案（§4.1 三选一） | 流程决策 | **待定** |
| 2 | 68 未归集群词：开新集群 / 并入 / 放弃（§4.2） | 战略决策 | **待定** |
| 3 | env 改指向 1CkjOC（修 promote/fallback 写错表） | 落地（小） | 待授权 |
| 4 | 1uVCq 核对 → 并入 → 只读封存 | 落地（需当面） | 待授权 |
| 5 | 统一读取范围 1500 vs 500（§4.4） | 落地（小） | 待办 |
| 6 | gg-queue-build 提交（需 `git commit --no-verify`，本仓库 pre-commit 会静默 unstage tools/scripts/） | 落地（小） | 未提交 |
| 7 | 这次试写的 13 行：保留 or 删除 | 决策 | 待定 |

> 落地动作（3/4/5/6）一律等流程梳理定稿后再做，并逐项确认。
