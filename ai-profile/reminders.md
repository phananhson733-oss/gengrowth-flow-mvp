---
title: 跨会话待办提醒（Reminders）
type: reminders
updated: 2026-08-27
---

# 跨会话待办提醒（Reminders）

> 会话开始时若有 `- [ ]` 未完成条目，在第一条回复前列出（见 AGENTS.md §七）。

## 待完成

## 已完成

- [x] 2026-06-18 | **两条 publish-only cron 拉起来**：Lane A `com.gengrowth.gengrowth-publish`（每小时，扫 ready 草稿→bridge `--emit rest` 幂等 upsert 到 gengrowth.ai blog_posts，已 live 的跳过）；Lane B `com.gengrowth.seo-autopilot`（25min，`GG_AUTOPILOT_MODE=publish-only` 永不撰写，`latestPlan` 排除 gengrowth plan，publish-gate 套 gtimeout，driver 级硬闸）。均加载在 gui/Aqua 域（去掉 LimitLoadToSessionType=Background）。Codex 复核 + 15/15 smoke。
- [x] 2026-06-18 | gengrowth.ai 发布桥 `gg-md-to-gengrowth-blog.mjs`（md→sanitize-html→blog_posts，pillar=seo_content，`--emit rest/sql`）；supabase CLI 流程通畅（2.106）。
- [x] 2026-06-10 | astrologywiki.com 剩余 89 篇 blog 全量配 hero+内联图并上线 prod（89/89 验收通过，commit ca8edde）。
- [x] 2026-06-10 | 配图并入 autopilot cron 闭环（`lib/illustrate.mjs` + `gg-hero-qa.mjs`，三未决项已决策，端到端验证通过）。
