---
title: upstream-canon — 关键词与增长系统 SSOT
date: 2026-05-23
type: index
status: live
---

# upstream-canon · 上游权威文档

> **本目录是关键词模块与 GenGrowth 增长系统的 single source of truth（SSOT）。**
> 所有 spec/ 内的本地稿都从属于本目录中的文档；冲突以本目录为准。
> 复制自 wiki `/Users/wzb/gengrowth-wiki/docs/03-marketing/`，禁止在本目录内做单独的"改稿"——
> 上游变更后用 `tools/scripts/_sync-canon.sh`（待建）重新拉取。

## 文档清单

| 文档 | 上游路径 | 性质 | 引用方 |
|------|---------|------|--------|
| `2026-05-15-gengrowth-internal-growth-mvp-prd-v0.7.md` | `wiki/docs/03-marketing/` | **当前执行基准**（status=final，v0.6 取代） | `docs/spec/*` 全部本地稿的 upstream |
| `keyword-research-overview.md` | `wiki/docs/03-marketing/01-strategy/` | 跨获客方式 + 跨业务 + 跨站点阶段的关键词路由总览（v0.4） | mine / promote / fallback 上层方法论 |
| `keyword-research-sop.md` | `wiki/docs/03-marketing/03-seo/` | 六源挖掘 → 四桶分级 SOP（v2.5）| `gg-keyword-mine.mjs` / `gg-keyword-promote.mjs` 直接对标 |
| `keyword-sheet-setup.gs` | `wiki/docs/03-marketing/03-seo/` | Google Apps Script v3.1，一键生成 13 张工作表的权威 schema 实现 | `tools/scripts/_bootstrap-flow-mvp-workbook.mjs` 必须按本文件复刻 |

## 与 spec/ 内本地稿的关系

```
upstream-canon/PRD v0.7  (SSOT, 现行基准)
        │
        │ 实施层细化（保留在 docs/spec/）
        ├── 工具栈方案 v1.2          ← 落地 §7.1 (.gs v3.0) / §7.5 (v2.0 SOP)
        ├── 工具栈方案 v1.2-OpsPM    ← Ops 视角简版
        ├── 落地plan v1.1.3          ← §8 1 周工作台搭建的执行细化
        ├── Sheet schema v2.1 align  ← §7.1 + 附录 D 验收 checklist
        ├── 8 个工具 spec            ← gg-day1-gate / entity-passport / friction-mine 等
        ├── RACI-and-execution-flow  ← §11.2 文档职责矩阵的执行细化
        ├── 精修文章端到端 SOP        ← §7.5 v2.0 内容 SOP 的本地化
        └── content-draft 极简版     ← §7.5 量产线最小生产单元
        │
        │ 已被 v0.7 取代（归档）
        └── _archived/ → 见该目录 README
```

## 关键决策（v0.7 现行基准）

- **执行单位 = 主题集群**（不是关键词，不是单个页面）— §2.3
- **内容双线**：量产线 / 精修线（不再叫"双轨"）— §3
- **地区闸门 us_share**（三档 高/中/低）— §3.3
- **6-ID 体系一个工作簿 13 张表** — §6 + 附录 D
- **垃圾词修法 = .gs NEGATIVE_KEYWORDS + O 列前置否决**（不设常设人工流程）— §7.3.2
- **CTA：Week-1 工具页优先；newsletter 上线后精修线转 co-primary** — §10
- **审核瓶颈：1 人 / 周 25 篇 ≈ 11h；T1 每周 ≤ 3 篇** — §7.5.3

## 与本地实现的对账

| PRD v0.7 章节 | 本地实现 | 状态 |
|---|---|---|
| §7.1 .gs v3.0 单一工作簿（附录 D 规格）| `tools/scripts/_bootstrap-flow-mvp-workbook.mjs` | ⚠️ 当前实现是占位 schema，**未按附录 D 落地**（缺 ⚙️配置/视图表/结果复盘表；关键词主表 J–U 列名错） |
| §7.3.2 修法 #1 NEGATIVE_KEYWORDS | `gg-keyword-mine.mjs` `isNegativeMatch` | ⚠️ 只读 CLI/env，未读 sheet ⚙️配置区 |
| §7.3.2 修法 #3 种子词不可用单个多义词 | mine.mjs | ❌ 未实现校验 |
| §7.3.2 修法 #4 集群生成只喂 R=快速胜利/长尾词 | 集群生成脚本（未建）| ❌ 未建 |
| §6 6-ID 体系 | promote 写 page_id；选题登记表附录 C 21 列 | ✅ 列结构正确 |
| §3.3 us_share 三档标签 | 主题集群表 col I | ✅ 列存在，但没有写入流程 |

详细 audit 见 `docs/KEYWORD_MINE_AUDIT.md`。
