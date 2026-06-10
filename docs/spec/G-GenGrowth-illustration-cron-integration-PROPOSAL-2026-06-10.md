---
title: 配图并入 autopilot cron 闭环（提案）
date: 2026-06-10
type: spec
status: proposal
tags: [workflow, illustration, autopilot, cron, proposal]
---

# 配图并入 autopilot cron 闭环（提案 — 待 wzb 确认）

> 背景：用户要求把配图并入"之前定义的 cron 全自动推送流程（自动检测 + 写作/插图 + 推送上线 + 检测验收）"。
> 本文是**提案**，不是已落地。回填 89 篇完成 + 用户确认后再实施。
> 关联：[[G-GenGrowth-illustration-and-H3-workflow-2026-06-09]]（两层配图系统）。

## 现状：autopilot 闭环里没有配图

`tools/scripts/gg-seo-autopilot.mjs` 的 publish 链（`doScan`）：

```
claimable 任务 → convert(md→.ts) → buildGate(npm build) → commit → push → PR → gh pr merge → Vercel 部署 main→prod
```

`convert()`（:446）只产出**纯文字** `.ts`。新文章上线即**无 hero、无内联图**——这正是现在 106→（回填后）剩余文章缺图的来源：autopilot 持续产出无图文章。

## 插入点：`convert()` 之后、`buildGate()` 之前

`.ts` 已生成、slug 已知、build 尚未跑。在此插一步 `illustrate()`：

```
convert → ✦illustrate(slug)✦ → buildGate(覆盖 hero/inline 渲染) → commit → …
```

`buildGate` 的 `npm run build` 会重渲 stub + OG，天然覆盖新插入的 hero/inline。

## `illustrate(slug)` 三个子步

| 子步 | 实现 | 性质 |
|---|---|---|
| 1. 规划 | 新建 `gg-illustrate-plan.mjs`：1 次 LLM 调用（复用 orchestrator 的 `claude -p` 模式）读全文 → 产 `scripts/plans/auto-<slug>.json`（hero prompt + 0-3 内联规格，anchor 须 grep 命中、双语标签） | LLM（每文 1 次，类比 authoring 的 orchestrator 调用） |
| 2. 出图 | `gen-infographic.mjs --plan` 出 SVG + `illustrate-article.mjs --plan` 调 gemini-web 出 hero 并 wire | 确定性 glue |
| 3. 验收 | 新建 `gg-illustrate-gate.mjs`：程序化检查（hero 文件 >20KB、尺寸 1200×675、SVG 无 undefined/截断、anchor 命中数对）；**hero 视觉验收（双联拼接检测）暂无自动手段** | 半自动 |

## 必须先解决的可靠性问题（unattended cron 特有）

1. **Google 会话过期**：gemini-web 骑已登录 Google 会话，cookie 会失效（今天首次就是空会话 + 403）。cron 无人值守时会话一断，hero 步骤每 tick 失败。
   - **缓解**：hero 失败**不阻塞发布**（illustrate-article 已是"hero 失败仍 wire inline"）；改为 hero 失败时**仍发文（无 hero）+ park 一个 `needs_hero` 标记**，会话恢复后用单独 lane 补 hero。绝不让配图失败挡住文字上线。
   - 或：定期 `--login` 刷新 + 会话健康检查（tick 开头探活，失败则跳过配图直接发文）。
2. **双联拼接等 diffusion 坑无自动 QA**：扩散模型偶发把 hero 拼成左右双联。当前靠人 Chrome 截图看。cron 里需要一个轻量自动判据（如长宽比/中线对称性启发式，或一个便宜的 vision 判别调用），否则可能上线坏 hero。**这是接入 cron 前的最大未决项。**
3. **会话 ToS 风险**：`danger-` 前缀已表明 gemini-web 是重放会话 cookie 打内部接口，违反 Google ToS。无人值守高频调用放大风险。需用户接受或改走官方 `gpt-image-1`（需 OpenAI key）。
4. **repo 体积**：每文 hero(JPEG ~150KB) + N×SVG 永久进 git。cron 长期跑需评估 + 可能迁 CDN/对象存储。
5. **LLM 成本**：每篇多 1 次规划 LLM 调用（读全文 ~ 几千 token）。

## 建议落地顺序

1. **先批量回填**（本轮，89 篇，人盯 QA）——验证两层系统在全量上的质量。✅ 进行中
2. 回填稳定后，先做**最低风险的 cron 接入**：只在 tick 开头探活 Google 会话；活则发文带 hero（规划+出图+程序化 gate），不活则发纯文字文 + `needs_hero` park。**不接内联图自动化**（内联图规划质量更吃 LLM 判断，先留人工批次）。
3. 补**双联拼接自动判据**后，再放开内联图自动化。

## 决策点（需用户拍板）

- 是否接受 unattended cron 调 gemini-web 的 ToS 风险？还是切官方 image API（填 key）？
- hero 失败时：发纯文字文 + 补图 lane（推荐）vs 卡住不发？
- 内联图自动化：先人工批次，还是一并进 cron？
