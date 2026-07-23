---
title: Cluster Recap Gate and Related Cards Implementation Plan
date: 2026-07-23
updated: 2026-07-23
type: plan
version: v1.0
status: approved
owner: wzb
tags:
  - seo
  - internal-linking
  - result-recap
  - related-cards
aliases:
  - Cluster Recap Implementation
  - 内链复盘与相关文章卡片
---

# Cluster Recap Gate and Related Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Smart Backfill 使用结果复盘表准入，并把受管链接渲染为组件级相关文章卡片。

**Architecture:** 发布成功后，Flow 先登记 index-tracking 并同步结果复盘表；linker 以发布日志、Oracle 注册、选题登记表、复盘表四源一致性构建快照。Oracle 的静态和 SPA 渲染器把受管 marker 块转换为卡片，不作为正文列表。

**Tech Stack:** Node.js ESM、Google Sheets API、Bash、Vitest、React。

## Global Constraints

- `cluster_id` 只取 OPS 手填的选题登记表。
- 复盘匹配键为 `page_id` 与 `/en/wiki/<slug>`，不要求 `day14_收录=Y`。
- 复盘同步失败只阻止本轮内链审核 PR，不回滚已发布文章。
- Pillar 保留所有已发布 Series；受管链接以卡片呈现，不计入正文 8 条。

---

### Task 1: Flow 复盘表准入与同步

**Files:**
- Modify: `tools/scripts/gg-cluster-internal-links.mjs`
- Modify: `tools/scripts/gg-seo-blog-launchd-tick.sh`
- Modify: `tools/scripts/__tests__/gg-cluster-internal-links.smoke.test.mjs`
- Test: `tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs`

- [ ] 写失败测试：`buildClusterLinkInput` 在 `recapRows: []` 时抛出 `recap_gate_failed page_id=PG-001 expected_url=/en/wiki/aura-colors-guide`；匹配行通过；错误 URL 或冲突 URL 失败；`day14_收录` 的空、N、Y 都通过。
- [ ] 运行 `node --test tools/scripts/__tests__/gg-cluster-internal-links.smoke.test.mjs`，确认新增测试先失败。
- [ ] 实现 `readResultRecapRows()` 与 `assertRecapGate()`；launcher 在 cluster linker 前调用既有 `--enqueue-published --write-sheet` 与 `--sync-recap --write-sheet`。任一失败时跳过 linker 和 cluster PR。
- [ ] 运行 `node --test tools/scripts/__tests__/gg-cluster-internal-links.smoke.test.mjs tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs`，确认通过。
- [ ] 提交 Flow 变更：`feat(seo): gate cluster backfill on recap`。

### Task 2: Oracle 相关文章卡片

**Files:**
- Modify: `components/wiki/WikiArticleDetailPage.tsx`
- Modify: `scripts/lib/md-to-html.mjs`
- Modify: `tests/unit/wiki-article-embedded-tool.test.tsx`
- Modify: `tests/unit/md-to-html.test.ts`

- [ ] 写失败测试：受管 marker 块渲染为 `section[aria-label="Related Reading"]`，包含两个 `data-testid="cluster-related-card"` 链接；不输出 marker 或正文 `<ul>` 管理列表。marker 外人工列表保持不变。
- [ ] 运行 `npm test -- --run tests/unit/wiki-article-embedded-tool.test.tsx tests/unit/md-to-html.test.ts`，确认新增卡片断言先失败。
- [ ] 在 SPA 和静态转换器收集精确的 `gg-cluster-links:start/end` 块，将其中链接渲染为 `related-reading-cards`；继续忽略 marker；只处理该受管块。
- [ ] 运行 `npm test -- --run tests/unit/wiki-article-embedded-tool.test.tsx tests/unit/md-to-html.test.ts && node scripts/check-internal-links.mjs && npm run build`，确认通过。
- [ ] 提交 Oracle 变更：`feat(seo): render managed links as related cards`。

### Task 3: 合并与验收

- [ ] 创建 review-only PR，检查 diff 只含上述文件和测试。
- [ ] 合并后用生产 `/en/wiki/saturn-return-guide` 验证管理标记数为 0、全部受管链接在卡片组件；用 `/en/wiki/venus-in-gemini` 验证 Birth Chart Calculator 链接仍在。
- [ ] 仅在四源准入、卡片渲染、测试、构建和生产抽验都有证据后，更新 7/21 主 PRD 为完成；保留两篇误报和不删除旧 Cluster 的用户豁免。

## 自检

- 覆盖发布后时序、四源一致性、失败重试、组件例外和生产验收。
- 所有功能变更均以失败测试开始，且不引入 LLM 集群推断或自动 PR 合并。
