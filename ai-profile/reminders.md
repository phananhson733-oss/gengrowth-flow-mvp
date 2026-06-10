---
title: 跨会话待办提醒
type: reminders
updated: 2026-06-10
---

# 跨会话待办提醒（Reminders）

> 会话开始时若有 `- [ ]` 未完成条目，在第一条回复前列出（见 AGENTS.md §七）。

## 待完成

- [ ] 2026-06-10 | **autopilot 配图依赖 Google 会话保活**：cron 自动配图（hero）需本机 Google/Gemini 登录态，testing-mode cookie 会过期。过期后新文章只发"文字+内联图"并标 `needs_hero`（不阻塞发布）。会话过期时重跑 `node tools/scripts/gg-gemini-cookie-import.mjs`（需在 Chrome 已登录 Google + 钥匙串授权一次），或 `cd ~/.openclaw/workspace/skills/baoyu-danger-gemini-web/scripts && bun main.ts --login`。
- [ ] 2026-06-10 | **验证首篇真实 cron 自动配图**：配图闭环已在 scratch worktree 端到端验过，但尚未经过真实无人值守 tick（W22 队列已 drained）。下批选题（W23）加入、autopilot 发出首篇带图文章后，线上验收 + **人眼看一眼 hero 质量**（QA 的中线接缝检测只是 backstop，非替代人眼；diptych prompt 约束是第一道防线）。
- [ ] 2026-06-10 | **定期清 `needs_hero` 积压**：会话中断期间发布的文章会标 `needs_hero`（claims 里）。目前无自动补图 lane，需人工或重跑补 hero。会话恢复后查 `grep -l needs_hero` autopilot claims 并补图。
- [ ] 2026-06-10 | **（知情，可选）** cron 配图默认开启（`GG_AUTOPILOT_ILLUSTRATE` 未设=开）。若想先观察几篇再全量放开，可在 plist/env 临时设 `GG_AUTOPILOT_ILLUSTRATE=0`（纯文字）或 `GG_ILLUSTRATE_LLM_PLAN=0`（只模板 hero、不出内联）。
- [ ] 2026-06-10 | **（待 wzb 定夺）** cron 配图 provider 维持 gemini-web（零成本、有 ToS 风险）。若要切官方 keyed API（gpt-image-1），设 `GG_GEMINI_SKILL` 指向 baoyu-imagine + 填 OpenAI key，不改码。

## 已完成

- [x] 2026-06-10 | astrologywiki.com 剩余 89 篇 blog 全量配 hero+内联图并上线 prod（89/89 验收通过，commit ca8edde）。
- [x] 2026-06-10 | 配图并入 autopilot cron 闭环（`lib/illustrate.mjs` + `gg-hero-qa.mjs`，三未决项已决策，端到端验证通过）。
