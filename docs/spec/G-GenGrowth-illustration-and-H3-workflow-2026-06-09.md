---
title: 配图工作流 + H3 叙述墙规则（2026-06-09 沉淀）
date: 2026-06-09
type: spec
status: active
tags: [workflow, illustration, structure, h3, sop]
---

# 配图工作流 + H3 叙述墙规则

> 2026-06-09 沉淀。原则（用户）：**所有改进统一写进 flow-mvp 工作流，不是一次性补 1-2 篇**。
> 本文固化今天的两块产出：① 通用文章配图系统；② H3 叙述墙规则。

---

## 一、通用文章配图系统（两层架构）

文章配图是 **flow-mvp 生成正文 → 转 oracle `.ts` → 配图 → 部署** 链路里独立的一步。
工具在 oracle repo（`/Users/wzb/Code/oracle/scripts/`），因为它作用于已转好的 oracle 文章。

### 架构：① LLM 规划层 + ② 执行层

- **① 规划层**：fan-out 规划 agent（按 cluster 并行）读每篇全文，**逐篇决定**：
  - **hero 固定 1 张**（封面）；
  - **内联图数量可变**（0/1/2/3…，哪里需要就配），从可渲染类型里选：`sequence` / `compare` / `timeline`；
  - 输出结构化 JSON plan（**双语 afterHeading 锚点 + 双语标签**），年限/数据须核对原文。
- **② 执行层**：
  - **hero / 场景图** → `baoyu-danger-gemini-web`（**免 API key**，骑已登录 Google 会话；偶发 "No image returned" 内置 3 次重试）；
  - **内联信息图** → `scripts/gen-infographic.mjs`（**数据驱动 SVG**，纯形状不依赖系统字形 → 文字 100% 可靠，终端浏览器不缺字）；
  - **wire** → `scripts/illustrate-article.mjs`（hero 双语本地化 alt；内联按 `<slug>-i<idx>-<lang>.svg` 确定性命名插到章节末；hero 失败不跳过 inline）。

### 硬标准（今天定）

- **hero 比例统一 `1200×675` (16:9)**：`optimize()` 用 cover-resample + center-crop（不失真），被抓取/社交不变形。
- **内联图手机优先**：SVG 是固定图不能 reflow，超宽横版缩到手机宽（~340px）字会糊到 3-4px。故内联图用**竖版**（左侧 spine + 每项满宽 + 放大字号），手机满宽下主标 ~10-11px 可读。
- **视觉系统**：深靛蓝星空 panel + 星云辉光 + 金箔奖章节点 + sparkle 装饰 + 双金边（celestial editorial，与 hero 绘画感同调）。
- **QA gate（不可跳）**：生成后用本地 `python3 -m http.server` + Chrome MCP 截图**逐张视觉验收**（含手机 360px 模拟）；hero 逐张看（diffusion 会出双联拼接等坑，需重生成）。
- **部署后验证**：node-fetch 验 stub `hero=1/内联数/h1=1` + 图片资源 HTTP 200 + ZH 本地化 alt。

### 复用方式（下批不改码）

规划 agent 决策 → 写 `scripts/plans/batch-<x>-illustration.json` → `gen-infographic.mjs` 出 SVG → `illustrate-article.mjs` wire → 部署。

### 坑

- 双语文章有 En+Zh 两个 export，wire 须全局/分语言处理；
- QA 页（svg-qa.html / hero-qa.html）放 oracle `public/` 下，**build 前必删**否则会被部署；
- 沙箱里 `curl`/`sort`/`wc` 偶发 command-not-found → 用 `node --input-type=module` fetch 稳；
- `gg-deploy-oracle.sh` 在 flow-mvp，`cd oracle` 后相对路径失效 → 用绝对路径。

---

## 二、H3 叙述墙规则（2026-06-09）

**问题**（用户截图 yellow-aura）：内容更丰富时，叙述型章节（"Why It Matters" / "vs Adjacent Concepts" / "How to Read"）堆成 6-9 段 prose 墙；**全用编号列表分割不现实**，加 `### H3` 小标题效果更好。

**根因**：旧 schema 在两处禁 H3 —— ① 生成 prompt 明令 "0 个 H3"；② SC3c 把 H2 下所有 prose 段累加计数（加 H3 也过不了）。

**沉淀（两层一致）**：

1. **校验层 `lib/structure-checks.mjs` 的 SC3c**：改为**按 H2/H3 子节计 prose 段数**（H3 重置子计数）。长章节只要**每个 H2/H3 子节 ≤3 段**即 PASS；"多段 + 无 H3 + 非列表"的真墙仍 FAIL。→ H3 成为一等破墙方式。新增 2 个单测锁定（H3 破墙→PASS / 无 H3→FAIL）。
2. **生成层 4 个 prompt 模板**（`content-draft-templates/{definition,pillar}.prompt{,.zh}.md`）：禁令翻转为"**`### H3` 仅用于超长叙述章节内分组**（某叙述章节会达 4+ 段时，2-3 个 H3 拆成每组 ≤3 段；H3 非必须，短章节/编号章节不加；章节标题仍必须 `## H2`，FAQ 仍用加粗问句不用 H3）"。

**渲染**：oracle 两端早已支持 H3（SPA `WikiArticleDetailPage` + stub `md-to-html.mjs` 的 `#{1,6}→<hN>`），无需改渲染。

**适用范围**：新文章经 SC3c gate 自动合规；存量"墙"文章（aura 集群 8 篇）需 retrofit 加 H3（SC3c 可逐篇标出具体墙章节）。
