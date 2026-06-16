---
title: 内容生产 → 部署 → 收录 → 归档 全流程 Runbook
date: 2026-06-16
type: runbook
status: canonical
tags:
  - flow
  - runbook
  - seo
  - astrologywiki
---

# 内容生产 → 部署 → 收录 → 归档 全流程

astrologywiki.com SEO 文章从选题到上线、收录推送、知识库归档的完整流程。
2026-06-16 W22 World Cup 批次（PG-WC-011~015）跑通并固化。

> 本机生成不稳定的硬约束：autopilot 的 orchestrator 嵌套 `claude` CLI 在本机 ~40% 卡死。
> **撰写一律由主 LLM（Claude）/ workflow 子代理直接产出草稿**，不走 autopilot 生成。

---

## 阶段 0 — 选题 + 事实核实（最关键）

- 选题来自 W22 plan：`~/Code/gengrowth-ops/inbox/06-tasks/tasks/2026-05-27-W22-blog-output-plan.md`（取唯一未勾选 `[ ]` 批次）。
- **先用 WebSearch 锁定每篇的真实事实**（生日→太阳星座、球队晋级、相位几何、赛程）。
  占星事实准确性是 Codex 每次必抓的失败点；**先核实再撰写**能把 Codex CRITICAL 降到 0。
- 固定 2026 事实基准（Codex 已验证）：World Cup 6/11–7/19；开幕 Estadio Azteca（非 MetLife）；
  **Jupiter 在 Cancer 到 6/29，6/30 入 Leo**；Saturn 在 Aries 2025–28；
  相位按星座间隔数：合 0 / 六分 2 / 刑 3 / 拱 4 / 梅花 5 / 冲 6；土星回归 ~29.4y（~29/~59 岁），天王星对分 ~40–42 岁（别把 40 岁当土星回归）。

## 阶段 1 — 撰写 + phase2（结构二元门）

- 每篇遵循 **WC-007 的 11-H2 Definition 骨架**（_staging/PG-WC-007-en.md 为范本）。
- 自跑 `tools/scripts/_phase2-validate.mjs --source _staging/<PID>-claude-v8.md --tag en --page-id <PID> --entity "<干净短实体>" --target-keyword "<字面无所有格无重音>" --associated-keywords "..." --author <id> --tier <T2|T3> --template Definition --cta-target-url <url> [--kw-min 3(长尾)] --prompt-version v8 --allow-missing-serp` 迭代到 `OVERALL: PASS`（PASS 自动写 `_staging/<PID>-en.md`）。
- 关键门：词数 1500–1800；关键词字面 3–8 次；narrative H2 含关键词词元（防 RL4 漂移）；首个内链在前 150 词织进正文；CTA 真 markdown 链接；表格无空格；FAQ 标题 "Common Questions"；作者红线 RL7（julian 禁 "you will"/"guaranteed"，传 `--banned-tokens` 强校）；marcus 表头禁 "energy" 用 "Natal Placement"。
- **H3 规则**：H2 下有大段叙述墙时用 H3 破开（SC3c 按 H2/H3 子节计段）。短 Definition 篇通常无墙；一旦某节 >5–6 段，插 H3 子标题。

## 阶段 2 — Codex 占星硬审（不同模型家族对抗）

- `mcp__codex__codex`（read-only，cwd=flow-mvp，**默认 gpt-5.5 @ xhigh**，见 `~/.codex/config.toml`，不传 model override）。
- 喂 2026 事实基准 + 每篇应有事实，要求只审占星/足球事实（相位几何、星座、赛程、生命周期、未验证的虚构星位）。
- 修 CRITICAL/MINOR → 改 `_staging/<PID>-claude-v8.md` → 重跑 phase2 复验。

## 阶段 3 — 转换 + 内链解析

- `gg-md-to-oracle-ts.mjs --source _staging/<PID>-en.md --slug <slug> --out <oracle>/data/articles/<slug>.ts`
- **TBD 内链**：`gg-md-to-oracle-ts.mjs` 的 `TBD_LINK_RULES` 把 `[[<TBD-internal-link: desc>]]` 描述映射到真实 slug；未匹配 → 斜体死链。
  **新集群上线前必须先补 TBD_LINK_RULES 规则**（否则 pillar/兄弟内链全成斜体死链，孤儿页复发——见 unindexed 审计）。

## 阶段 4 — 配图（hero + 内联）

- `lib/illustrate.mjs` `illustrate({repo, slug, flowDir})`，需 `GG_GEMINI_SKILL=~/.claude/skills/baoyu-danger-gemini-web/scripts/main.ts` + 清 `.gg-cache/illustrate-cooldown.json`。
- hero 1200×675 经 gemini-web 逆向会话（靠 cookie，会话死需用户重导 cookie）；内联 SVG 由 `<oracle>/scripts/gen-infographic.mjs`（sequence/compare/timeline）数据驱动。
- 计划缓存在 `<oracle>/scripts/plans/auto-<slug>.json`；改了 gen-infographic 后可 `node scripts/gen-infographic.mjs --plan scripts/plans/auto-<slug>.json` **确定性重生成同名 SVG**（不动 hero）。
- **compare 卡片样式**：金色 accent bar 在卡片**左侧竖条**（非顶部横条）；name 顶部居中。

## 阶段 5 — 错峰部署（worktree off origin/main）

- oracle 工作区常脏（别的会话 WIP）→ **从 origin/main 开 git worktree** 部署，绝不碰主工作区：
  `git worktree add -b <branch> <wt> origin/main` + 软链 node_modules。
- **并行准备**（convert + illustrate 各写各的，无冲突）+ **串行错峰上线**（间隔 20–25min）。
- 每篇 go-live（**逐篇 branch off 最新 main 避 index.ts 合并冲突**）：
  1. `gg-oracle-register-index.mjs --slug <slug> --lang en`（改 index.ts import+array）
  2. 手动把 slug 加进 `<oracle>/scripts/generate-seo-pages.mjs` 的 `ARTICLE_SLUGS_EN_ONLY`
  3. `npm run build`（gate；需 tsx/bun 在 PATH；catch og-images destructure 崩）
  4. **只提交源文件 + 图片**（`data/articles/<slug>.ts` + index.ts + generate-seo-pages.mjs + `public/images/blog/<slug>*.{jpg,svg}`），**不提交 build 重生成的 public stub / sitemap**（Vercel 部署时自己 `npm run build` 重生成；提交会全站刷 lastmod）
  5. 验 committed export（`git show HEAD:<ts> | grep export`）→ push → PR → **Chrome 验收 preview** → merge → Vercel prod
  6. 验证 live **看 prod sitemap 含 slug**（非 HTTP200——SPA 全 200）

## 阶段 6 — Chrome 验收（含 GSC 收录验收）

- preview 渲染：hero、标题、副标题、作者（披露式 persona）、内联图、内链、CTA。
- **GSC 收录验收**：在 GSC「网址检查」查每篇 URL 的可收录性（有无 noindex/被屏蔽/抓取错误）。
- **请求编入索引**：GSC UI 点「请求编入索引」（对内容页**唯一有效**的 push）。
  - ⚠️ **每日配额 ~10/天**，发布量大时会「超出了配额」，当天剩余只能次日。
  - ⚠️ `scripts/gsc-index-submit.mjs`（Google **Indexing API**）对文章页**无效**——Indexing API 官方只对 JobPosting/直播页建索引，文章页返回 accepted 但不收录。保留可触发一次爬取，但**不要指望它收录**。
  - 真正收录杠杆：**内链（阶段3已修）+ 外链权威(DR) + sitemap + 时间**。
- **后续 cron（待建）**：定期（次日/间隔）只读检测文章是否真被 Google 收录（URL Inspection），而非强推。

## 阶段 7 — 归档进知识库 vault（gbrain/RAG 信息源）

- `gg-archive-to-vault.mjs --pages "<PID>:<slug> ..." --oracle <oracle-or-worktree>`
- **复制（非移动）**最终 EN 文章为 OFM 笔记：`gengrowth-wiki/内容资产/<site>/<发布日期>/<官方标题>.md`（文件名用网站正式标题，非 slug 代称）。
- 图片资源单独放 `内容资产/<site>/attachments/`（slug 命名，笔记内 `![[<slug>.jpg]]` 嵌入）。
- 富化：富 frontmatter（tags 从关键词、aliases、url、hero、author、page_id、tier）+ 发布元信息 callout + **批内标题互链** `[[标题]]` + TBD→wikilink + 全文（供 RAG 检索）。
- 待办：① 老内容（全部已上线 astrologywiki）回填进 vault；② gengrowth.ai blog 迁入 `内容资产/gengrowth/`。

## 阶段 8 — 收尾

- 勾选 W22 plan 对应批次 `[x]` + slug + LIVE。
- ZH 版作为二轮 backfill（CLI `--language zh --zh-keyword <中文> --entity <中文实体> --cta-target-url /zh/...`；广告法禁词；CTA 标题 "下一步行动"）。
- 把当次系统性改进沉淀回 flow-mvp（TBD_LINK_RULES / gen-infographic 样式 / 本 runbook）。

---

## 复用脚本（flow-mvp）
- `_phase2-validate.mjs` — 结构二元门
- `gg-md-to-oracle-ts.mjs` — md→.ts + TBD 内链解析（TBD_LINK_RULES）
- `gg-oracle-register-index.mjs` — index.ts 注册
- `lib/illustrate.mjs` — hero+内联配图
- `gg-archive-to-vault.mjs` — 归档进知识库 vault（本批新建）
- `<oracle>/scripts/gen-infographic.mjs` — 内联信息图（compare accent 左竖条）
- `<oracle>/scripts/gsc-index-submit.mjs` — Google Indexing API（对文章页无效，仅 Bing 走 ping-indexnow）
