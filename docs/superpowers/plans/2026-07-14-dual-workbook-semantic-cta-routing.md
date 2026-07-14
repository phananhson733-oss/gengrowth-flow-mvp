---
title: 双工作簿语义 CTA 路由实施计划
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
  - CTA 路由实施计划
  - Semantic CTA Routing Plan
---

# 双工作簿语义 CTA 路由实施计划

## 目标

为 AstrologyWiki 和 GenGrowth 的 SEO 博客建立同一套、可审计的 CTA 选择机制：根据文章语义从各自的 CTA Map 中挑选合适的落地页，而不是把所有文章固定指向同一个 CTA。既有的 blog-to-blog 内链规则、Related Reading 和内部链接字段不纳入 CTA 候选池，也不修改其生成或校验逻辑。

## 实施步骤

### 1. 编写共享的纯 CTA 选择器并先建立测试

- 新增 `tools/scripts/lib/cta-selector.mjs`。
- 输入为文章语义和 CTA Map 行；输出为选中的 `cta_id`、文案、URL、事件名及选择原因。
- 仅接受 `blog_eligible=TRUE`、非 `blog`/`external`/`navigation`、HTTPS、域名属于当前产品且非占位符的记录。
- 排序规则固定为：显式有效 CTA > 目标关键词与实体 > 关联关键词与内容角度 > 意图小幅加分 > priority 降序 > cta_id 字典序。
- 仅允许每个工作簿一个 `*` 兜底候选；不存在匹配时返回不可发布状态，不合成其它产品或 Birth Chart 链接。
- 先在 `tools/scripts/__tests__/lib-cta-selector.smoke.test.mjs` 写失败用例，再实现最小通过代码。

### 2. 让所有写稿路径复用选择器

- 先扩展 `gg-sheet-to-brief`、`gg-content-draft` 和 `gg-seo-autopilot` 的测试，覆盖关键词匹配、域名隔离、唯一兜底、Blog_Article 排除及保留 `internal_link_rule`。
- `gg-sheet-to-brief` 从 A:K 解析 CTA Map，并以共享选择器替换按 `page_role + track` 的固定映射和产品硬编码默认 CTA。
- `gg-content-draft` 改为读取 A:K，并调用同一选择器，保持既有 CLI 与输出字段兼容。
- `gg-seo-autopilot` 不再把空或中文 CTA 改写为 Birth Chart Calculator；无有效 CTA 时将该条目停留在待修复状态。
- `site-profile` 仅提供当前站点允许域名，移除作为正文 CTA 的隐藏默认值。

### 3. 更新工作簿规范和操作文档

- 更新 `tools/scripts/lib/_workbook-spec.mjs` 中 CTA Map 的 A:K 结构、列注释和数据验证。
- 同步更新 `docs/spec/upstream-canon/keyword-sheet-setup.gs` 与 `docs/PIPELINE.md`，明确 `desc`、`cta_kind`、`match_keywords`、`blog_eligible`、`priority` 的用途和唯一通配符约束。
- 不更改内部链接字段、Related Reading 或 blog-to-blog 链接的定义。

### 4. 迁移两个线上 CTA Map

- 重新读取两个 Sheet 的现有内容、格式、数据验证和 URL 后，以批量更新方式追加 G:K 字段。
- AstrologyWiki：为可用工具和 Tools Hub 填写说明、关键词、候选资格和优先级；将 Blog_Article、导航与外部 AI 行标记为不可作为主 CTA，但保留 URL 和原有记录。
- GenGrowth：保留现有跨产品历史行且标为不可用；补充官网 app、pricing、features、use cases 四个站内 CTA 候选，并为通用 app CTA 设置唯一 `*` 兜底。
- 写入后复读两张表，检查表头、候选数、每表仅一个通配符、非 blog 资格、URL 合法性和内部链接行未变。

### 5. 验证与交付

- 运行共享选择器、bridge、content-draft、autopilot 的定向测试；先确认测试为红，再实现至绿。
- 对两站分别运行 bridge 的 dry-run，验证 CTA 来源、域名和选择原因；不执行发布。
- 检查 `git diff --check`、工作区差异和线上 Sheet 最终状态。

## 验收标准

1. 两份 CTA Map 都具备 A:K 字段和可维护的候选描述。
2. 非 blog 的主 CTA 永不从 `Blog_Article`、导航、外部链接或其它产品域名中选择。
3. 每个产品至多一个、且恰好一个启用的 `*` 兜底候选。
4. 既有 blog 内链需求、`internal_link_rule` 与 Related Reading 不被修改或删除。
5. 写稿和发布前处理的所有 CTA 决策都复用同一个选择器，并可通过 `cta_selection_reason` 审计。
