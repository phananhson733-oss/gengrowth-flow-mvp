---
title: _archived — 被 PRD v0.7 取代的迭代档案
date: 2026-05-23
type: index
status: archived
---

# _archived · 决策档案

> **本目录的文档已被 `upstream-canon/2026-05-15-gengrowth-internal-growth-mvp-prd-v0.7.md`（SSOT）取代。**
> 保留用途：
> 1. 记录"为什么走到 v0.7"的论证链（评审报告）
> 2. 给新人理解版本演进（v1 → v1.1 → v1.2 → lean → 被 v0.7 重新框定）
> 3. lean 版的某些细节（如 12-15 篇精修周度工时表）未进入 v0.7 但仍可作 ops 参考

**禁止在本目录内做改稿。** 如需补充，去 spec/ 主目录或写到 v0.7 上游（wiki）。

## 归档清单

| 文档 | 归档日期 | 取代它的文档 | 档案价值 |
|------|---------|-------------|---------|
| `G-GenGrowth-MVP-半自动化工具栈方案-v1.md` | 2026-05-23 | upstream-canon/PRD v0.7 §7 + spec/工具栈方案 v1.2 | 初版方案；4 reviewer REJECTED 的起点 |
| `G-GenGrowth-MVP-半自动化工具栈方案-v1.1.md` | 2026-05-23 | 同上 | 吸收 v1 review 后的迭代版 |
| `G-GenGrowth-MVP-半自动化工具栈方案-v1.2-lean.md` | 2026-05-23 | 同上 | 质量优先 pivot 的论证；周度工时表（v0.7 未含）|
| `G-GenGrowth-MVP-工具栈方案-v1-Review-Report.md` | 2026-05-23 | — | **决策档案**：4-reviewer 一致反对 v1 的论证 |
| `G-GenGrowth-MVP-半自动化工具栈方案-v1.1-Review-Report.md` | 2026-05-23 | — | **决策档案**：v1.1 为何 still need v1.2 |
| `G-GenGrowth-MVP-半自动化工具栈方案-v1.2-Review-Report.md` | 2026-05-23 | — | **决策档案**：5-reviewer cross-model 一致提"工具本身在变成目标" → 触发 lean pivot |
| `G-GenGrowth-MVP-OpsPM-PRD-v1.2-lean.md` | 2026-05-23 | upstream-canon/PRD v0.7 | Ops/PM 视角早期版本 |
| `G-GenGrowth-MVP-OpsPM-PRD-v1.3.md` | 2026-05-23 | upstream-canon/PRD v0.7 | 与 wiki v0.7 同层级；wiki 是 final |
| `G-GenGrowth-MVP-落地plan-v1.1.md` | 2026-05-23 | spec/G-GenGrowth-MVP-落地plan-v1.1.3.md（仍保留）| lean2 → 可点 todo 的第一版翻译 |

## 如果你想看决策时间线

按上游 wiki 的 PRD 版本发布顺序：

1. **v0.5 之前**：spec/ 内的 v1 → v1.1 → v1.2 → lean1 → lean2 → lean2.1（这部分的全部演进）
2. **2026-05-15**：wiki PRD v0.6（spec 内的 OpsPM-PRD v1.3 接近此版）
3. **2026-05-18**：wiki PRD **v0.7 final**（status=final，supersedes v0.6）→ **当前 SSOT**

v0.7 的 §0.1 列了 7 处修订，回答了为何 spec 内的版本不再是基准。
