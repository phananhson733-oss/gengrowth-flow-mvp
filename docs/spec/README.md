---
title: docs/spec 索引 — SSOT + 实施层细化
date: 2026-05-23
type: index
status: live
---

# docs/spec · 索引

> **SSOT = `upstream-canon/2026-05-15-gengrowth-internal-growth-mvp-prd-v0.7.md`（wiki PRD v0.7, status=final）**
>
> 本目录的所有"本地稿"都是 PRD v0.7 的**实施层细化**。冲突以 PRD v0.7 为准。
> v0.7 没说的，本地稿说了算；v0.7 说了的，本地稿不得偏离。

## 三层结构

```
docs/spec/
├── upstream-canon/      ← SSOT：wiki 同步的权威文档（禁止本地改稿）
│   ├── README.md
│   ├── 2026-05-15-gengrowth-internal-growth-mvp-prd-v0.7.md   ★ 当前执行基准
│   ├── keyword-research-overview.md  （v0.4 路由总览）
│   ├── keyword-research-sop.md       （v2.5 六源四桶 SOP）
│   └── keyword-sheet-setup.gs        （v3.1 13 张工作表权威 schema）
│
├── *.md                ← 实施层细化（保留，跟 v0.7 互补）
│
└── _archived/          ← 被 v0.7 取代的迭代档案（禁止改稿）
    └── README.md       （归档说明 + 决策时间线）
```

## 实施层文档清单（主目录保留）

| 文档 | 对应 PRD v0.7 章节 | 性质 |
|---|---|---|
| `G-GenGrowth-MVP-半自动化工具栈方案-v1.2.md` | §7.1 + §7.5 + §8 | 工具栈技术实施 |
| `G-GenGrowth-MVP-工具栈方案-v1.2-OpsPM-Brief.md` | 同上 | Ops 视角简版 |
| `G-GenGrowth-MVP-落地plan-v1.1.3.md` | §8 1 周工作台搭建 + §9 首轮落地 | 周度可点 todo |
| `G-GenGrowth-Sheet-schema-v2.1-alignment-checklist.md` | §7.1 + 附录 D | sheet schema 验收 |
| `G-GenGrowth-MVP-RACI-and-execution-flow-v1.md` | §11 文档协同矩阵 | 执行角色分工 |
| `G-GenGrowth-精修文章-端到端-SOP-v1.md` | §7.5（精修线）| 精修线端到端 |
| `G-GenGrowth-content-draft-极简版-spec-v1.md` | §7.5（量产线 T3）| 量产线最小单元 |
| `G-GenGrowth-MVP-W1-keyword-brainstorm-template.md` | §9.2 Week 1 推荐组合 | 模板 |
| `G-GenGrowth-Agent-PRD-Template.md` | — | 后续 Agent 化模板 |
| `G-GenGrowth-Agent-Harness-Review-Checklist.md` | — | Harness 自查 |
| `G-GenGrowth-AI-Coding-Harness-Self-Check-Checklist.md` | — | Coding 自查 |
| `G-GenGrowth-Skill-Eval-MVP-Technical-Plan.md` | — | Skill 评测专题 |

**8 个工具 spec（实施依据）：**
| 工具 | spec | 对应 PRD v0.7 |
|---|---|---|
| `bin/gg-day1-gate-check` | `...day1-gate-check-tool-spec-v1.md` | §8 Day 1 GA4 安装 |
| `/gg-entity-passport` | `...entity-passport-tool-spec-v1.md` | §7.3 entity_map |
| `/gg-facts-audit` | `...facts-audit-tool-spec-v1.md` | §7.5.4 验收 |
| `/gg-friction-mine` | `...friction-mine-tool-spec-v1.md` | §7.5.1 T1 friction |
| `bin/gg-gate-check` | `...gate-check-tool-spec-v1.md` | §7.4 发布前技术闸门 |
| `/gg-keyword-fallback` | `...keyword-fallback-tool-spec-v1.md` | §7.3 关键词 fallback |
| `bin/gg-sop-draft` | `...sop-draft-tool-spec-v1.md` | §8 SOP 模板 |

## 与本地实现 (tools/scripts/) 的对账

完整报告见 `../KEYWORD_MINE_AUDIT.md`。核心问题：

1. ⚠️ `_bootstrap-flow-mvp-workbook.mjs` 没按 PRD v0.7 附录 D 落地（缺 ⚙️配置/视图表/结果复盘表；关键词主表 J–U 列名错）
2. ⚠️ `gg-keyword-mine.mjs` 的 NEGATIVE_KEYWORDS 不读 sheet 配置区（PRD §7.3.2 修法 #1 要求）
3. ❌ "种子词不可用单个多义词"未在 mine 实现（SOP v2.4 + PRD §7.3.2 修法 #3）
4. ❌ 集群生成脚本未建（PRD §7.3.2 修法 #4）
5. ⚠️ mine 写老 sheet (`GG_SHEETS_WORKBOOK_ID`)，不是新 flow-mvp sheet (`GG_SHEETS_FLOW_MVP_WORKBOOK_ID`)

## 维护规则

- **改 SSOT**：去 wiki 改，本目录用 `_sync-canon.sh`（待建）拉取
- **新增实施稿**：在 frontmatter 加 `upstream: upstream-canon/2026-05-15-...-prd-v0.7.md`
- **归档**：移到 `_archived/` 并更新 `_archived/README.md` 表格
- **删除**：永不删除，保留为决策档案
