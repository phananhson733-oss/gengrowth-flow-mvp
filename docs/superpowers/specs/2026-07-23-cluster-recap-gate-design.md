---
title: Cluster Smart Backfill 结果复盘准入设计
date: 2026-07-23
updated: 2026-07-23
type: plan
version: v1.0
status: draft
owner: wzb
tags:
  - seo
  - internal-linking
  - smart-backfill
  - result-recap
aliases:
  - Cluster Recap Gate
  - 内链复盘准入
---

# Cluster Smart Backfill 结果复盘准入设计

## 1. 背景

7/21 内链优化需求要求 Smart Backfill 从「选题登记表 + 结果复盘表」识别同集群已发布页面。当前实现只将发布日志与 Oracle 注册文章作为发布证据，无法证明页面已进入运营复盘追踪。

结果复盘表不能作为文章上线前的前置：复盘记录只能在文章真实发布后创建。它应成为发布成功后、Smart Backfill 生成审核 PR 前的准入条件。

## 2. 目标与非目标

### 目标

- 文章发布成功后，先将该文章写入既有索引追踪并同步至「结果复盘表」，再运行 Smart Backfill。
- Smart Backfill 仅接受同时满足发布日志、Oracle 文章注册、选题登记表和结果复盘表的页面。
- 复盘行以 `page_id` 与规范 URL `/en/wiki/<slug>` 精确对应为准；不要求 `day14_收录=Y`。
- 复盘同步失败时，不回滚已发布文章；停止本次内链回填，保留明确失败原因，由后续自然 fire 重试。

### 非目标

- 不等待 Google 收录，不把 Day14/Day30/Day60 指标作为内链前置。
- 不改变内容质量、审核、Oracle 发布或 Google Indexing 的既有 gate。
- 不手工创建、修改或补写结果复盘表。
- 不把缺少复盘行的页面静默排除后继续生成不完整的集群 PR。

## 3. 已确认的流程

```text
文章发布并确认 Oracle 注册
  -> 写入/刷新 index-tracking 发布记录
  -> 同步结果复盘表
  -> 校验 page_id + canonical URL 对应的复盘行存在
  -> 构建 Cluster Smart Backfill 输入
  -> 创建受管内链审核 PR
```

若复盘同步或校验失败：文章保持已发布；本轮停止在内链阶段，不创建或合并内链 PR；下一次自然 SEO fire 重新同步并重试。

## 4. 数据与准入契约

### 4.1 四源一致性

每个候选页面必须同时有：

1. 发布日志中的已发布记录（`page_id`、`slug`、`title`）；
2. Oracle 中已注册的对应文章文件；
3. 选题登记表中的人工 `cluster_id` 与 `page_role`；
4. 结果复盘表中相同 `page_id` 且 URL 规范化后为 `/en/wiki/<slug>` 的记录。

结果复盘表的 `cluster_id` 不作为本次硬匹配字段；集群归属仍以 OPS 手填的选题登记表为唯一来源，避免复盘历史值覆盖人工修正。

### 4.2 失败语义

- 缺少复盘行、复盘 `page_id` 与 URL 不一致、同一 `page_id` 对应多条冲突 URL，均为 `recap_gate_failed`。
- 任一发布候选触发 `recap_gate_failed` 时，整批 Smart Backfill 不生成审核 PR，避免 Pillar 或同组页面依据不完整集合生成链接。
- 错误输出必须列出受阻 `page_id`、预期 URL 和稳定 reason code；不得自动修正 Sheet。

## 5. 集成边界

### 5.1 发布后的复盘同步

复用既有 `gg-index-monitor.mjs` 的确定性写入路径：先登记已发布页面到 `index-tracking`，再运行 `--sync-recap --write-sheet`。调用发生在发布成功、页面已经在 Oracle 注册且可由 sitemap/发布元数据识别之后。

该同步属于发布收尾阶段。其失败只使整轮 SEO fire 的内链阶段失败；不撤销已经成功的 Oracle 发布，也不额外发送独立通知，沿用最终 fire 汇总。

### 5.2 Linker 输入构建

`gg-cluster-internal-links.mjs --build-input` 读取结果复盘表，并在构建输入前执行四源一致性校验。链接规划器继续只消费通过校验的快照，不直接访问 Google Sheet。

`gg-seo-blog-launchd-tick.sh` 必须保证顺序：发布收尾复盘同步成功后，才调用 linker 的 `--build-input`。当 linker 返回 `recap_gate_failed` 时，停止 cluster 审核 PR 阶段并记录可重试原因。

## 6. 测试与验收

### 6.1 测试先行

- 缺少复盘行时，`buildClusterLinkInput` 失败并给出 `recap_gate_failed`。
- 相同 `page_id` 但 URL 不同、或一个 page_id 对应冲突 URL 时失败。
- `page_id` 与规范 URL 匹配时输入构建成功；`day14_收录` 为空、`N`、`Y` 都不影响准入。
- 同步失败时 launcher 不调用 cluster linker/不创建审核 PR，也不触碰已经发布的 Oracle 内容。
- 同步成功后 launcher 按既有集群规则继续回填。

### 6.2 上线验收

- 在一次自然发布中，确认新页面先进入 index-tracking 和结果复盘表，再出现在 cluster 输入快照中。
- 复盘表缺行的 fixture 能阻止整批回填，并输出可重试的 page_id 与 URL。
- 正常 fixture 能生成审核 PR；合并后的生产页保留正确内链，且不展示管理边界标记。
- 重新执行现有 Cluster、SEO launcher、Index Monitor 相关 smoke 测试，并运行 Oracle 内链检查和生产构建。

## 7. 设计自检

- 无待定字段：匹配键、时序、失败边界、重试行为和验收条件均已定义。
- 不与现有 OPS 手填 Cluster 决策冲突：复盘表只提供发布/追踪证据，不拥有集群归属。
- 不扩大为收录 gate：Day14 收录明确不参与准入。
- 范围限定在发布收尾与 Cluster Smart Backfill，不重构 SEO 内容发布流程。
