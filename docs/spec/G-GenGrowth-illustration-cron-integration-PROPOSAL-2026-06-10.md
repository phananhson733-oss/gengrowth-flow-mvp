---
title: 配图并入 autopilot cron 闭环（已决策 + 已实现）
date: 2026-06-10
updated: 2026-06-10
type: spec
status: active
tags: [workflow, illustration, autopilot, cron]
---

# 配图并入 autopilot cron 闭环

> 用户要求把配图并入"之前定义的 cron 全自动推送流程（自动检测 + 写作/插图 + 推送上线 + 检测验收）"，并授权我评估未决项给出决策。
> 2026-06-10 已落地。关联：[[G-GenGrowth-illustration-and-H3-workflow-2026-06-09]]（两层配图系统）。

## 三项决策（已拍板）

1. **会话失败/过期 → 绝不阻塞文字上线。** 配图是 best-effort 富化。gemini 会话死/hero 生成失败 → 照常发**纯文字 + 内联图**（内联 SVG 确定性、不依赖网络），hero 缺省并打 `needs_hero`，同时设**会话冷却**（默认 60 分钟，避免每 tick 浪费 ~90s 重试死会话）；会话恢复后由后续 tick 或人工补 hero。
2. **双联拼接质量 → 廉价确定性 backstop + 保守动作。** `gg-hero-qa.mjs`（sharp）检测两类可自动判定的缺陷：尺寸/空文件、**正中竖缝 diptych**（中列梯度相对中位数的 prominence ≥4× 且贯穿 ≥72% 行高——区别于天秤立柱/塔/树干等中央主体，实测 juno/2nd-house/塔等不误报，合成 diptych 准确命中）。**动作保守**：硬失败（无图/尺寸错/<20KB）才删 hero+defer；仅接缝可疑 → 重生 1 次，仍疑则**保留 hero + 记 qa_warn**（绝不误删中央主体好图）。生成 prompt 的 "one continuous scene, no split" 仍是第一道防线，本门是第二道。诚实标注：本门不替代人眼，只挡明显硬缝。
3. **ToS 风险 → 维持 gemini-web（用户此前已确认不接 OpenAI key），provider 由 env 可切换。** 不引入新风险（与 wzb 手动同机制、零成本）。`GG_GEMINI_SKILL` 可切到官方 keyed API（gpt-image-1 via baoyu-imagine），执行层 provider 无关，不改码。

## 实现

**插入点**：`gg-seo-autopilot.mjs` 的 `doScanLocked()`，在 author-gate 之后、`buildGate()` 之前调用 `illustrate()`；整段 try/catch 包裹，`illustrate()` 自身也全程 fail-safe——**任何失败都不抛进发布路径，最坏只是少图/无图**。

**新文件**：
- `tools/scripts/lib/illustrate.mjs` — 编排：① LLM 规划（`claude -p` 写 `scripts/plans/auto-<slug>.json`，hero 氛围 prompt + 0-3 内联，anchor 自验；JSON 自校验 + 解析端容错去尾逗号/围栏；失败 → **确定性模板 hero（无内联）**兜底）② `gen-infographic.mjs` 出内联 SVG ③ `illustrate-article.mjs` 出 hero(gemini)+wire ④ hero QA + 兜底策略 ⑤ 会话冷却。
- `tools/scripts/gg-hero-qa.mjs` — sharp 中线接缝/尺寸 QA（`GG_SHARP_BASE` 指向 worktree 解析 sharp）。

**资产落点**：`public/images/blog/<slug>.jpg` + `<slug>-i<idx>-<lang>.svg`（单目录，区别于手动回填的 per-cluster 目录）。commit 时 addPaths 增加 `public/images/blog` + `scripts/plans/auto-<slug>.json`。

**env 开关**：
- `GG_AUTOPILOT_ILLUSTRATE=0` 整步关闭（默认开）
- `GG_ILLUSTRATE_LLM_PLAN=0` 跳过 LLM、只用模板 hero（默认开 LLM）
- `GG_ILLUSTRATE_MODEL`（默认 claude-sonnet-4-6）/ `GG_ILLUSTRATE_PLAN_TIMEOUT_MS`（默认 600000）
- `GG_GEMINI_SKILL` provider 路径覆盖

**渲染**：oracle SPA + stub 早已支持 hero(image 字段) + 内联(`![](svg)`)，无需改渲染。
**发布后验证**：现有 `tools/scripts/verify-live`（或 `/tmp/verify-live-illustrations.mjs`）验 stub hero/内联/资源 200。

## 已知残余 / 运维

- **会话需登录态**：本机 cookie 从 Chrome 注入（`/tmp/import-gemini-cookies.mjs`，需钥匙串授权）；testing-mode 会过期，过期则走冷却 + needs_hero，文字照发。
- **QA 是启发式**：subtle 构图问题（非硬缝）不挡；low-volume cron（每 tick ~1 篇）下可接受，必要时人工 review `qa_warn`/`needs_hero` 标记。
- **LLM plan 偶发无效 JSON**：已加自校验 + 容错解析；仍失败则模板 hero（无内联）兜底，不影响发布。
- **needs_hero 补图 lane**：目前标记写进 claims（`needs_hero:true`）；后续可加专门 lane 在会话恢复后批量补 hero（暂依赖人工或重跑）。
