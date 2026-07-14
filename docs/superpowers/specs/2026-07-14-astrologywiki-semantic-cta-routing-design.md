---
title: 双产品语义 CTA 路由设计
date: 2026-07-14
updated: 2026-07-14
type: plan
version: v1.0
status: approved
owner: awayer_mini
tags:
  - gengrowth
  - seo
  - cta
  - google-sheets
aliases:
  - semantic CTA routing
  - CTA Map 语义选择
  - 双产品 CTA 路由
---

# 双产品语义 CTA 路由设计

## 目标

让 AstrologyWiki 与 GenGrowth 的英文 SEO blog 在生成时，从各自 Google Sheet 的 `CTA Map` 选择与文章主题匹配的站内产品或功能 CTA；不再把“工具页”或“星盘页”统一解析为 Birth Chart Calculator，也不再让 GenGrowth 使用 AstrologyWiki 的旧 CTA Map 数据。

## 范围

- 覆盖 AstrologyWiki 与 GenGrowth 的英文 SEO blog；两个 workbook 使用相同 schema、各自独立维护候选池与站内 URL。
- CTA Map 仍是 CTA 文案、目标 URL 与 GA4 事件的唯一事实源；代码不再用站外或跨产品的默认 CTA 覆盖它。
- `Blog_Article` 行仅供文章内链登记，永远不能作为文章主 CTA 候选；保留其现有 URL、内容及任何既有互链需求。
- `internal_link_rule`、Related Reading 与内链数量/可达性检查保持原状；本次不迁移、不重写、不降低任何内链规则。
- 不批量改写已发布文章；新生成或重新生成的文章使用新选择器。

## 候选方案与决策

1. 让写作模型直接阅读 CTA Map 的自然语言描述后自由选择。覆盖面灵活，但输出不可复现，也会把 Sheet 文本带入提示词决策面。
2. 仅用文章的 `page_role`、`track` 或旧的“工具页”方向词映射。实现最小，但不能区分 rising sign、moon sign、Saturn return 等不同意图，正是当前问题。
3. 建立结构化候选池并使用确定性打分。描述帮助维护者理解 CTA，关键词和类型负责机器选择；排序、兜底和失败都可审计。

采用方案 3。

## CTA Map 数据模型

保留已有 A:G 列，并新增 H:K：

| 列 | 字段 | 规则 |
| --- | --- | --- |
| A | `cta_id` | 稳定主键。文章页若要人工指定 CTA，只能填写这个 ID 或完整 URL。 |
| B | `page_role` | 保留历史兼容，不再决定语义选择。 |
| C | `cta_文案` | 英文读者可见的锚文本；不得写运维说明或中文注释。 |
| D | `target_url` | 真实、可访问的站内 URL。 |
| E | `ga4_event_name` | 既有埋点事实源。 |
| F | `track` | 保留历史兼容。 |
| G | `desc` | 面向维护者的短描述：这个 CTA 解决什么需求、何时适用。 |
| H | `cta_kind` | `tool`、`feature`、`hub`、`product`、`navigation`、`blog` 或 `external`。 |
| I | `match_keywords` | 英文短语，使用分号分隔；`*` 只允许用于一个通用兜底候选。 |
| J | `blog_eligible` | `TRUE` 才能参加 blog 主 CTA 选择。 |
| K | `priority` | 正整数；同分候选先按较高值，再按 `cta_id` 升序决胜。 |

AstrologyWiki 本次启用已验证的主题工具和一个工具总览兜底候选。`Blog_Article`、导航、外部 AI 链接、未确认的 Compatibility Calculator 与其他非产品链接均设为不可选。

GenGrowth 保留原有 7 条错误的 AstrologyWiki 历史行，但全部设为 `blog_eligible=FALSE`；另新增 GenGrowth 自己的 app、pricing、features 与 use cases 候选。它们分别覆盖试用/高意图、价格比较、功能/自动化能力和行业场景意图；不再依赖代码硬编码的 `https://gengrowth.ai/app` 兜底。

## 选择规则

输入为文章的 `target_keyword`、`entity`、`associated_keywords`、`content_angle` 与旧 CTA 单元格。

1. 若旧 CTA 单元格是已启用的 `cta_id` 或真实 URL，作为显式覆盖；URL 必须对应 CTA Map 中一个可选候选。
2. 旧值“工具页”或“星盘页”仅表示 `tool` 意图，不再是 Birth Chart Calculator 的别名。
3. 从 `blog_eligible=TRUE`、非 `blog`、非 `external`、目标 URL 有效的行中筛选候选。
4. 对每个候选的 `match_keywords` 进行归一化短语匹配：目标关键词或实体精确命中优先于关联词和内容角度命中；旧 `tool` 意图只作为较低权重加分。
5. 没有主题命中时，只能选择唯一的 `match_keywords=*` 通用兜底候选；没有该候选时桥接失败并停车，绝不随机选 Birth Chart Calculator。
6. 输出 `cta_id`、`cta_text`、`cta_target_url` 与可读的 `cta_selection_reason` 到 override，供审核和问题追踪。

## 生成链路与安全边界

新共享选择器由 `gg-sheet-to-brief.mjs` 与 `gg-content-draft.mjs` 共用，避免两个写作入口各自退化。它从 active workbook 读取候选池，并只接受该产品允许的站内域名：AstrologyWiki 为 `astrologywiki.com`，GenGrowth 为 `gengrowth.ai`。Autopilot 收到已选择 CTA 后必须保留它的文案与 URL；不再因文案含中文或为空而改成统一的 Birth Chart 文案。缺失或不合规的选择结果应 park 当前文章，而不是生成错误链接。

选择器只消费结构化字段，不将 `desc` 当作写作模型指令。CTA URL 必须是 active workbook 对应产品的真实 HTTPS 站内 URL，且不得是占位符或 blog article URL。

## 验收标准

1. AstrologyWiki 的“rising sign”“moon sign”“Saturn return”“Chinese zodiac”等文章分别命中对应工具 CTA。
2. GenGrowth 的价格、功能/自动化、行业场景与试用意图分别命中 pricing、features、use cases 与 app CTA。
3. `Blog_Article`、外部 AI、导航和 `blog_eligible=FALSE` 的行无法被选为主 CTA，且现有内链规则保持不变。
4. 没有特定候选命中的文章仅使用各自产品唯一的通用兜底候选，不使用跨产品或隐式 Birth Chart 兜底。
5. 同一输入重复选择的结果、理由与排序完全一致。
6. override 保留选定的 CTA 文案与 URL，autopilot 不再把它改写为统一 CTA。
7. bridge、content-draft 与 autopilot 相关 Node 测试通过；两个 live Sheet 的候选行、字段、URL 和实际生成的 dry-run override 复核一致。
