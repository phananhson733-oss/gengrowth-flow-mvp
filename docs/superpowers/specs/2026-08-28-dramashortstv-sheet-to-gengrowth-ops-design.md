---
title: DramaShortsTV Google Sheet 至 gengrowth-ops Git 文档交付设计
date: 2026-08-28
updated: 2026-08-28
type: plan
version: v1.0
status: review
owner: wzb
tags:
  - dramashortstv
  - google-sheets
  - content-pipeline
  - gengrowth-ops
  - git-delivery
aliases:
  - DramaShortsTV 文档生产线
  - DramaShortsTV Sheet to Git
---

# DramaShortsTV Google Sheet 至 gengrowth-ops Git 文档交付设计

## 1. 背景与已确认边界

GenGrowth Flow MVP 现有两条内容生产与交付路径：Oracle/AstrologyWiki 最终转换为站点代码并经过 Preview、Merge 和网站发布；GenGrowth 最终写入站点内容源并验证线上状态。DramaShortsTV 的需求只复用上游内容生产能力，不复用任何网站发布器。

本设计已经确认以下边界：

- 选题输入来自指定 Google Sheet：`1-Qbv2MLRbiHDHdSi2csdatIVqxqCwkfcclkuGFN1dos`。
- 写作结构、安全边界和 QA 的最高依据是 `gengrowth-ops/inbox-maboyang/05-blog/dramashortstv/2026-08-26-dramashortstv-blog写作SOP-v1.0.md`。
- 最终业务产物只有一份 Markdown，保存到 `gengrowth-ops/inbox-maboyang/05-blog/dramashortstv/`。
- 文档写完并通过 QA 后，由 Flow 对 `phananhson733-oss/gengrowth-ops` 执行文档级精确 commit/push。
- 不生成 hero、内联图、图片计划或任何图片文件。
- 不写网站、不创建 Preview、不部署、不写 Supabase、不修改 Oracle、不运行 sitemap/indexing/结果复盘等发布后流程。
- 不在 `gengrowth-ops` 生成发布历史、publish log、manifest 或其他辅助业务文档。
- Google Sheet 在本 lane 中为只读输入，不回填 Status、URL 或审计字段。

## 2. 目标与非目标

### 2.1 目标

- 用一个显式、可重复的入口读取指定 workbook 的单个 row 或 `page_id`。
- 将 Sheet 的选题变量与指定 SOP 合成为 DramaShortsTV 专属写作 prompt。
- 生成与内容类型匹配的英文 Blog 文档，并执行确定性 QA 与事实审。
- 只将 QA 通过的 Markdown 原子写入规定的 `gengrowth-ops` 目录。
- 只 stage 该目标文档，创建可审计 commit，普通 push 到 `origin/main`。
- 回读远端 SHA 与目标文件，证明 GitHub 已收到与本地一致的文档。
- 所有失败都 fail-closed，不串到 Oracle、GenGrowth 或网站发布路径。

### 2.2 非目标

- 不自动把文档发布到 dramashortstv.com。
- 不修改 Google Sheet，也不把 Sheet 当发布账本。
- 不建立 Day14/30/60、GSC、GA4、sitemap 或索引自动化。
- 不创建 PR、Vercel Preview 或浏览器验站步骤。
- 不把三仓 vault 自愈同步脚本作为文章交付器。
- 不重构 Oracle 或 GenGrowth 的现有 author/publish lanes。
- 不自动清理、stash、reset、合并或提交 `gengrowth-ops` 中的其他本地改动。

## 3. 权威来源与优先级

同一字段或规则发生冲突时，按以下顺序解释：

1. 用户在本任务中的明确边界：只写文档、存入 `gengrowth-ops`、提交指定 GitHub 仓库、不生成图片、不发布网站。
2. DramaShortsTV 写作 SOP：内容类型、章节结构、写作规范、安全边界和 QA。
3. Google Sheet：本次文章的 Target Keyword、Associated Keywords、Entity、Friction、Logic、Content Angle、Tier、Template、cluster 与 page ID。
4. Flow 的通用内容能力：Sheet 读取、RAG/搜证、LLM 编排、事实审、失败分类与确定性校验。

Flow 可以补充事实交叉核验、来源分级、SEO 元数据、内容团队备注和机器可验证的 QA，但不得覆盖 SOP 的内容结构或安全边界。

## 4. 总体架构

```text
显式 workbook + row/page_id
  -> DramaShortsTV Sheet intake（只读）
  -> brief normalization（站点隔离）
  -> SOP template selection
  -> 搜证与事实材料
  -> LLM 生成
  -> DramaShortsTV QA + factual review
  -> 原子写入 gengrowth-ops Markdown
  -> Git preflight
  -> 只 stage 目标 Markdown
  -> commit + 普通 push origin/main
  -> 远端 SHA/文件回读
```

该路径是一条独立的 `document-delivery` lane。它可以复用通用模块，但不能调用 `gg-seo-autopilot` 的 Oracle publish leg、`gg-gengrowth-publish` 或 `illustrate()`。

## 5. 单一入口契约

建议新增一个确定性 CLI 入口：

```bash
node tools/scripts/gg-dramashortstv-doc.mjs \
  --workbook 1-Qbv2MLRbiHDHdSi2csdatIVqxqCwkfcclkuGFN1dos \
  --row 4 \
  --apply
```

也允许以 `--page-id page_dramabox_vs_reelshort` 唯一定位同一行，但 `--row` 与 `--page-id` 不能同时提供。入口默认 dry-run；只有 `--apply` 才允许写 `gengrowth-ops` 和执行 Git commit/push。

每次运行必须显式携带 workbook ID，不读取 Oracle/GenGrowth 的 ambient workbook 默认值。workbook ID 不匹配允许列表时直接失败。

## 6. Sheet 输入与 normalizer

### 6.1 读取范围

只读取以下 tab：

- `选题登记表`：本次文章核心字段。
- `主题集群表`：JTBD、内容层、business role、content angle、internal link rule 和 CTA 类型提示。
- `CTA Map`：只作为文档中的建议性 CTA 信息；占位 URL 不得进入可发布正文，也不阻塞纯文档交付。

不读取 `结果复盘表`、`内容追踪` 或发布后 tab 作为完成条件。

### 6.2 必填字段

- Target Keyword
- Entity
- Friction
- Logic
- page_id
- cluster_id
- page_role
- content_angle
- Template 或可由 cluster 唯一推导的内容类型

缺少任一必填字段时不调用 LLM、不写 Ops、不执行 Git。

### 6.3 内容类型映射

normalizer 将 Sheet 与 cluster 信息确定性映射为 SOP 六类内容：

- `clu_app_trust` + Definition -> 安全指南聚合页
- `clu_app_profiles` + Definition -> App 档案页
- Comparison -> 对比测评
- Brand Playlist -> 品牌剧单
- `clu_actor_gallery` + Case Study -> 演员/角色内容
- Reader Bridge/Topic Hub -> 题材枢纽页或读者视角桥接

映射不能唯一确定时失败，不允许默默回退 Oracle Definition。

### 6.4 数据清理

- Associated Keywords 中的括号说明、数据来源说明或“未找到”备注移入内部 context，不作为关键词。
- `search_volume=未找到` 规范化为空值并保留来源说明。
- CTA 占位符保留为内容团队备注，正文中不得输出虚假链接。
- 现有占星语义的 `实体三角拓扑`、clinical/interpretive `rl6_hint` 不进入 DramaShortsTV prompt。

## 7. 写作与搜证契约

### 7.1 SOP 模板

每个内容类型使用 SOP 对应的锁定结构。Flow 不强制 Oracle/GenGrowth 的固定 9/11-H2、T1/T2/T3 内链阶梯或 Take Action 结构；Tier 仅决定同类型内的投入深度。

### 7.2 允许补充的内容

- Google 真实 SERP、App 商店、Reddit、IMDb、官方 Fandom、官方公司或演员页面的交叉核验。
- 一手与二手来源标识。
- Title 备选、Meta description、关键词覆盖表和 SEO 执行说明。
- 内容团队备注：未核事实、数据时效、版权风险和发布前人工核验项。
- 具体剧名的 Google Trends 新鲜度检查。

### 7.3 禁止内容

- dailymotion、免费看不付费、free coins、mod apk 等盗版意图内容或链接。
- “揭露骗局”式攻击性叙事、夸大投诉代表性或编造具体事实。
- 把二手聚合信息写成一手事实。
- 未核实的精确价格、播放量、生日、身份关系或公司归属。
- hero、inline image、图片 prompt、图片版权素材或任何图片文件。

## 8. QA 与事实审

QA 分两层：

### 8.1 确定性 QA

- 正文直接回答核心意图。
- 至少一个决策支持结构。
- 单段不超过 SOP 限制，长 section 有视觉断点。
- H2/H3 含相关语义且句式不机械重复。
- 无 SOP 列出的 AI 写作痕迹。
- 无盗版关键词或风险链接。
- 具体数字与事实有来源标识。
- FAQ 问题为疑问句且条目间有空行。
- 演员类标题和首段完成同名污染限定。
- 文档中无 raw placeholder、空标题或损坏 Markdown。
- 本次运行没有生成任何图片或 media asset。

### 8.2 事实审

复用独立 factual reviewer，只审发布阻塞事实：实体错误、来源错配、无法支撑的具体数字、投诉范围夸大、同名人物混淆和安全边界违反。事实审非 PASS 时不写 Ops、不提交 Git。

## 9. Markdown 输出契约

### 9.1 路径

唯一允许目录：

`/Users/awayer_mini/gengrowth-ops/inbox-maboyang/05-blog/dramashortstv/`

文件名采用现有约定：

`YYYY-MM-DD-dramashortstv-blog-<topic-slug>.md`

resolved path 必须位于该目录内且扩展名为 `.md`；任何路径穿越或其他目录立即失败。

### 9.2 内容

文档包含：

- 与 H1 一致的 YAML title、date、updated、type、status、tags 和 aliases。
- SOP 要求的正文结构。
- 必要的关键词/SEO说明与内容团队备注。
- 明确标识的发布前核验项。

文档不包含运行 manifest、Git SHA、pipeline 日志或网站发布状态。Git 证据只出现在命令输出和 Flow 本地运行结果中。

### 9.3 原子写入

先在 Flow 自有临时目录生成并验证最终 bytes，再使用同目录临时文件 + rename 方式原子落到目标路径。目标文件已存在且 bytes 不同则失败，不覆盖；bytes 完全相同则作为幂等 no-op，不创建空 commit，直接验证远端 `main` 已包含相同路径与 blob。

## 10. Git 精确交付契约

### 10.1 写前 preflight

在生成文章前验证：

- repo path 为 `/Users/awayer_mini/gengrowth-ops`。
- 当前分支为 `main`。
- fetch/push remote 均为 `https://github.com/phananhson733-oss/gengrowth-ops.git`。
- `git fetch --prune origin` 成功。
- `HEAD...origin/main` 为 `0 0`。
- worktree 与 index 干净。

任一条件不成立都停止。不得自动 stash、reset、clean、rebase、merge 或 force。

### 10.2 精确 staging

写入后必须满足：

- `git status --porcelain` 只出现一个目标 Markdown。
- `git diff --check -- <target>` 通过。
- `git add -- <target>` 后，`git diff --cached --name-only` 精确等于目标相对路径。
- 不使用 `git add .`、`git add -A` 或目录级 staging。

出现任何额外修改时停止并保留现场，不提交。

### 10.3 Commit 与 push

Commit message 使用：

`content(dramashortstv): add <topic-slug>`

随后执行普通 `git push origin main`。禁止 force push。push 因远端推进、权限、网络或冲突失败时保留本地 commit，输出准确错误与本地 SHA，不尝试自动合并。

### 10.4 完成证明

只有以下条件全部成立才报告 GitHub 交付完成：

- commit 成功且仅包含目标 Markdown。
- push 成功。
- `git ls-remote origin refs/heads/main` 返回的 SHA 等于本地 HEAD。
- 远端 HEAD 中存在目标路径且 blob SHA 与本地文件一致。

这只证明文档已进入 GitHub，不代表文章已发布到网站。

## 11. 状态、缓存与失败恢复

- Flow 可在 `.gg-cache/sites/dramashortstv/` 保存 prompt、brief、QA result 和 run result，用于调试与幂等；这些文件不提交到 `gengrowth-ops`。
- QA 失败：保留 Flow 缓存，不写 Ops，不执行 Git。
- Ops preflight 失败：不生成或写入目标文件。
- 文档写入成功但 commit 前出现额外修改：保留文档，停止并报告准确路径。
- commit 成功但 push 失败：保留本地 commit，下一次只允许在用户解决远端状态后重试 push，不重新生成文章。
- push 成功但远端回读不一致：报告未验证，不写“完成”。
- 任意失败都不能调用 Oracle、GenGrowth、图片或网站发布路径兜底。

## 12. 测试设计

### 12.1 Sheet 与 normalizer

- 显式 workbook ID 才能运行；ambient workbook 不生效。
- row/page_id 唯一定位、重复或缺失时 fail-closed。
- 六类内容映射覆盖。
- actor 行括号说明不进入 Associated Keywords。
- CTA 占位符只进入团队备注，不进入正文链接。
- 占星 tier gate 与 rl6_hint 不进入 prompt。

### 12.2 SOP 与 QA

- 六类 fixture 分别验证结构。
- 盗版关键词、攻击性表述、无来源数字、同名污染缺失和 raw placeholder 均失败。
- 正常内容通过可读性、FAQ、来源和无图片检查。
- 事实审非 PASS 时不调用输出器。

### 12.3 文件与 Git

- path jail、扩展名、已存在不同 bytes 和原子 rename。
- dirty worktree、staged-only 修改、错误 remote、非 main、ahead/behind 非零均失败。
- staging 集合多于目标文件时失败。
- push 失败保留 commit，不 reset。
- remote SHA/blob 回读一致才成功。
- 连续执行同一输入时，第二次为无额外 commit 的幂等 no-op。

### 12.4 首个端到端样本

使用 Sheet row 4：`page_dramabox_vs_reelshort`。该行已有参考稿，且覆盖 Comparison 模板、Friction/Logic、事实来源、CTA 占位和 Git 文档交付。验收时使用临时 Git remote 做完整测试；真实仓库只在所有自动化测试通过后进行一次受控 apply。

## 13. 验收标准

一次真实 apply 只有在以下证据齐全时验收：

- 从指定 workbook 的明确 row/page_id 读取。
- 生成内容遵守指定 SOP 和 DramaShortsTV 安全边界。
- QA 与事实审全部 PASS。
- `gengrowth-ops` 只新增目标 Markdown，无 hero/图片或辅助业务文档。
- commit 只包含目标 Markdown。
- 普通 push 成功，远端 SHA 与 blob 回读一致。
- Google Sheet 没有被修改。
- Oracle、GenGrowth、Supabase、Vercel、sitemap 和 indexing 均未被调用。

## 14. 已确认决策

- 采用独立 `document-delivery` lane，不复用网站 publisher。
- Google Sheet 是只读选题输入，SOP 是写作规则 SSOT。
- 最终业务产物只有 `gengrowth-ops` 中的一份 Markdown。
- Flow 直接对 `phananhson733-oss/gengrowth-ops` 做文档级精确 commit/push。
- 采用普通 push `main`，不创建 PR、不 force、不自动合并冲突。
- 任何无关本地修改、远端分叉或不可证明状态都 fail-closed。
- 不生成图片，不发布网站，不写发布历史或发布后回填。
