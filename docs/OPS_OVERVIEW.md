# OPS_OVERVIEW.md — 给 CEO / PM / Ops 看的 SEO 内容工厂全景

> **⚠ 本文档已由 [HANDBOOK.md](./HANDBOOK.md) 取代（2026-05-25 起）**
>
> 新读者请从 `docs/HANDBOOK.md` 开始 —— 那里是非技术 + 技术双覆盖的唯一入口手册，包含完整 22 阶段走读、5 份磁盘 prompt 模板、41 个脚本目录、35 个名词、12 题 FAQ。
> 本文档保留作历史参考与 Sheet 视角的简化版速查。两份内容如有冲突，以 HANDBOOK.md 为准。
>
> ---
>
> 这份文档**不讲代码**。讲三件事：(1) 我们在做什么 (2) 哪里能看到 (3) 哪些点需要人决策。
> 工程细节看 [PIPELINE.md](./PIPELINE.md)。

---

## 一句话讲我们在做什么

**把"我们要做什么关键词"自动变成"上线的英文 SEO 文章"，每一步都留痕、可暂停、可介入。**

链路一头连 DataForSEO Labs（拉关键词数据），另一头连 wiki repo（push 上线）。中间 18 步全部产出落文件 + 写 Sheet，CEO / PM 在 Sheet 上就能看清楚每篇文章卡在哪一步。

---

## 三个角色 × 各自看什么

### 👤 CEO — 看一周吞吐和瓶颈

**入口**：[gengrowth-flow-mvp workbook](https://docs.google.com/spreadsheets/d/1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc/edit) → `publish-log` tab

**关注**：
- 这周 publish 了几篇？（一行一篇）
- 哪个 LLM 出文质量更稳？（看 `phase2_overall` 分布）
- 哪些 cluster 在动，哪些 cluster 停了？（看 `page_id` 关联到 cluster_id）

**决策点**：
- 内容吞吐 < 计划 → 看 `pipeline-status` tab，找瓶颈节点（candidate / approve / phase2 / commit 哪一关堆积）
- 质量下滑 → 看 `quality-metrics` tab，RL4/RL5 fail 率有没有抬头
- 成本上去 → 看 `cost-tracking` tab，哪些 entity 烧 token 最猛

---

### 👤 PM — 看 backlog + 流程节点

**入口**：workbook → `pipeline-status` tab（**每页一行，从 candidate 一路到 commit 的完整进度**）

**列含义**：
| 列 | 解释 |
|----|------|
| candidate_in_sheet | 已经在 keyword_candidates 副表了吗 |
| approved | wzb 标了 Y 吗 |
| promoted | 进主表 + 选题登记表了吗 |
| brief_filled | 选题登记表 21 列填全了吗 |
| override_path | bridge 跑过了吗（路径就是产物） |
| prompt_path | render 跑过了吗 |
| rendered_llms | LLM 调过没（哪几个） |
| phase2_status | 红线通过没 |
| wiki_published_path | publish 到 wiki 没 |
| commit_hash | git commit 落库没 |

**节奏建议**：
- 每周一上午 review `keyword_candidates` 表 → 标 5-10 个 wzb_approve=Y
- 标完后 wzb 触发 `gg-keyword-promote` → page 进选题登记表 backlog
- 周中 fill 21 列 brief + cluster + CTA
- 周四/周五 trigger render + phase2 + publish + commit
- 周末 review `quality-metrics` + `publish-log`

**决策点**：
- backlog 太长（pipeline-status > 50 行 brief_filled=No）→ 减 approve 节奏
- 同一 page render 3 次都 phase2 fail → 改 brief 或换 LLM
- cluster 关联缺失 → 先补主题集群表

---

### 👤 Ops（每天跑链路的人）

**入口**：terminal + workbook

**每天起手 30 秒**：

```bash
node tools/scripts/gg-status.mjs --md | head -40
```

输出一张表：哪些 page 在哪一步，哪些卡住了。

**所有命令的速查在** [PIPELINE.md](./PIPELINE.md) 每个阶段段落。

**典型 1 篇文章的 1 天工作流**：

| 时段 | 动作 | 时长 |
|------|------|------|
| 09:00 | 在 Sheet 标 1 个 approve | 1 分钟 |
| 09:05 | `gg-keyword-promote --also-draft-pages` | 5 秒 |
| 09:10 | Sheet 填 21 列 v8 brief（要思考） | 10 分钟 |
| 09:25 | `gg-sheet-to-brief --row N` | 5 秒 |
| 09:30 | `gg-sheet-pull` + RAG（entity/obsidian） | 1 分钟 |
| 09:35 | `gg-render-batch` | 10 秒 |
| 09:40 | `codex exec < prompt > _staging/X.md` | 2-4 分钟 |
| 09:45 | `_phase2-validate` | 10 秒 |
| 09:50 | 必要时 retry LLM 1 次 | 4 分钟 |
| 09:55 | `gg-publish-to-wiki.sh` + `git commit` | 30 秒 |

**单篇 60-90 分钟**（绝大部分是 LLM 调用 + 思考 brief）。
**真正人工时间约 15 分钟**（其余是机器跑）。

---

## 哪些产物在 Sheet / 哪些只在文件

### Sheet 上的（人可读、可分享、可定位）

| Tab | 内容 | 谁写 |
|------|------|------|
| `keyword_candidates` | 候选关键词 + DataForSEO 元数据 | mine 自动 |
| `关键词主表` | 已采纳的关键词 + 24 列打分 | promote 自动 |
| `选题登记表` | 21 列 page brief | promote 写 A 列 + 人工补 B-U |
| `主题集群表` | cluster 元数据 | 人工填 |
| `CTA Map` | CTA 文案库 | 人工填 |
| `配置` | 目标国家 / TOPIC_KEYWORDS / NEGATIVE_KEYWORDS | 人工填 |
| `pipeline-status` | 每 page 进度（产物路径 + 状态） | `gg-status.mjs --sheet` 重写 |
| `publish-log` | 每篇 publish 记录 | `gg-status.mjs --sheet` append |
| `quality-metrics` | phase2 每次跑的明细 | `gg-status.mjs --sheet` append |
| `cost-tracking` | LLM token / API call 计数 | `gg-llm-orchestrator.mjs` + `gg-keyword-mine.mjs` 自动 append（2026-05-23 接入）|
| `monitor-auto` | GSC + GA4 自动回填（清单 vs 人填的 `内容追踪`） | `gg-monitor.mjs --write-sheet` |
| `config` | 阈值与门控（mine.* / phase2.* / tier*.word_*）| 人改 → `gg-config-sync.mjs` 拉到 `.gg-cache/config-snapshot.json` |

> **2026-05-23 命名更新**：原 8 个 emoji 前缀 tab（⚙️配置 / 🚀趋势词 / ⚡快速胜利 / 🎯战略词 / 📌长尾词 / 📋分桶规则 / 📊内容追踪 / 📈来源分析）已全部 rename 去 emoji，便于 grep 与 IDE 搜索。原 PRD 文档仍保留 emoji 表述（SSOT），sheet 与代码已统一到无 emoji。

### 只在本地文件（需要工具看）

| 路径 | 内容 | 如何看 |
|---|------|------|
| `.gg-cache/overrides/<X>.json` | bridge 产出 brief override | `cat *.json \| jq` |
| `.gg-cache/batches/<X>.json` | sheet-pull 产出 batch | `cat *.json \| jq` |
| `.gg-cache/<page_id>/*.rag.json` | RAG 缓存（entity/obsidian/friction） | `cat *.rag.json` |
| `.gg-cache/prompts/<page_id>.v8-prompt.md` | 喂 LLM 的 prompt 全文 | `less` |
| `_staging/<page_id>-<llm>-v8.md` | LLM 输出的文章 | `less` / 编辑器 |
| `_staging/<page_id>-<llm>-v8.manifest.json` | phase2 检查报告 | `cat \| jq` |

**实时同步策略**：`gg-status.mjs` 会扫这些文件 + 写 Sheet 索引（路径 + size + mtime），所以即使产物只在本地，Sheet 上能看到"page X 的 prompt 文件在 `.gg-cache/prompts/page_X.v8-prompt.md` 30KB，5 分钟前生成"——可定位到本地看。

---

## 中间产物可见性方案（用户提的 #3）

**问题**：很多关键产物（prompt 文件、RAG cache、brief override）是 JSON / MD 在本地，CEO/PM 看不到、不想 SSH。

**方案 A（已实现）—— Sheet 索引 + 状态**：
`gg-status.mjs` 扫所有产物路径，每个 page 一行写入 `pipeline-status` tab，含：
- 文件路径（人可 cd 进去看）
- 文件大小 / 修改时间
- 内容摘要字段（prompt 字符数、RAG snippet 数）

**方案 B（按需启用）—— 自动推 Drive folder**：
建一个 Drive folder `gengrowth-flow-mvp-artifacts/`，每次产物落本地时同步一份到 Drive。需要 Drive scope（让用户跑 oauth-init 加 `drive.file` scope）。

**方案 C（已用一部分）—— 仓库内 HTML / MD dashboard**：
`gg-status.mjs --html` 在 `docs/dashboard.html` 渲染一张所有 page 状态的可点击表格，可以 git push 到 GitHub Pages 让团队所有人开浏览器看。

**当前推荐**：A + C 组合。Sheet 上看摘要，需要细节时点 dashboard 里的链接跳到 raw 文件。B 看后续 Drive 是否真的需要再加。

---

## LLM 选择策略（Frontier-only policy）

> 由 wzb 2026-05-23 设定的硬规则，已存进项目 memory (`feedback_llm_frontier_only`)。

**规则**：SEO 内容生成 **必须**用 wzb 指定的**精确 frontier 配置**。一篇文章 LLM 成本几美分到几元，远小于一篇排名好的文章带来的 ROI。**不允许**为节约 token 降级。

**精确配置**（wzb 2026-05-23）：

| 厂商 | Model | Reasoning effort | 不允许 |
|------|-------|------------------|--------|
| **Claude** | `claude-opus-4-7` | `xhigh`（extended-thinking max） | Sonnet, Haiku（CLI 默认会降级，**必须显式 `--model`**） |
| **ChatGPT / Codex** | `GPT 5.5` | `high` | 4o, o1-mini, 任何 mini |
| **Gemini** | `gemini-2.5-pro`（当前 CLI ceiling — Gemini 3 还没发布；待 Google 上线后升级 cli + 切到 `gemini-3-pro`） | — | Flash, 2.0 |
| **OpenRouter Hermes** | `nousresearch/hermes-3-llama-3.1-405b` | — | 70b, 8b |

**修复 retry 策略**：如果同 model retry 2 次都 phase2 fail → **换更高 frontier 或换厂商**，而不是同 model 第 3 次。例如 hermes-3 fail 2 次 → 换 Opus 4.7 xhigh 或 GPT 5.5 high。Diversity > repetition。

**Frontier 模型验证状态**（2026-05-23 wzb 账户实测）：
- Claude opus-4-7 xhigh：✅ 可用
- GPT 5.5 high (codex CLI)：✅ 可用
- Gemini 2.5-pro：✅ 可用（CLI 0.42.0；Gemini 3 还没发布）
- Hermes-3-405b (OpenRouter)：上次 session 跑过，今天没复测

**成本预期**（per 1500-word article）：
- Opus 4.7 xhigh：约 $0.50-1.50（input 3k + thinking 30k + output 1.5k）
- GPT 5.5 high：约 $0.40-1.20
- Gemini 2.5 pro：约 $0.10-0.30
- hermes-3-405b：约 $0.05-0.10
- → 5 篇文章/周 × 3 LLM diversity ≈ $5-25/周 LLM 总成本。可以接受。

---

## 补充建议（用户提的 #4）

按重要性排：

### 🥇 1. 接入 GSC + GA4 自动闭环（高 ROI）

当前 publish 后看不到效果。建议：
- 每周一个 cron 跑 `gg-gsc-sync.mjs`（待建）：拉 GSC `impressions / clicks / position / CTR` 写入 `publish-log` 表
- 加一列 `organic_clicks_30d` —— publish 后 30 天的真实流量
- 同样接 GA4：`dwell_time / cta_click_count`
- **这样 CEO 一眼看到：这周 publish 的 5 篇文章，30 天后哪几篇真的带来流量**

### 🥈 2. 成本追踪自动化（已落地 2026-05-23）

`cost-tracking` tab 已接入自动写入：
- `gg-llm-orchestrator.mjs`：每篇 page × 每个 model 跑完 append 1 行（tokens_in / tokens_out / cost_usd / api_calls / notes）
- `gg-keyword-mine.mjs`：每次 mine 跑完 append 1 行（DataForSEO $0.002 / 100 candidates）
- 工具入口：`tools/scripts/lib/_cost-log.mjs` — 失败容错（OAuth / 网络问题不阻塞主流程）

未来可扩展：rag-entity / friction-mine / serp-snapshot 也各加 1 行成本记录。

### 🥉 3. cluster 拓扑可视化（中 ROI，长期）

主题集群表是平表，看不出 pillar/spoke 的图结构。建议：
- 加一个 `gg-cluster-viz.mjs` 输出 mermaid graph：每个 cluster 一张图，箭头从 spoke 指 pillar
- 渲染到 dashboard 让 PM 一眼看 cluster 覆盖度

### 4. 阈值动态化（低 ROI，需要时再做）

当前阈值在代码常量。建议：
- `gg-config-sync.mjs`：每次工具启动时从 Sheet `config` tab 拉阈值覆盖代码默认值
- 让 PM 不通过工程师就能调 RL4 jaccard floor
- **风险**：Sheet 改坏会全链路 fail。建议先有 schema 校验

### 5. retry budget + 失败原因聚类（低 ROI，规模后才有用）

当前一个 page render 3 次都失败要人 review。建议：
- `_phase2-validate` fail 时写一行到 `failure-log` tab，记录 fail reason
- 跑 retro 时聚类：1) 80% fail 是 RL4 → 改 prompt template；2) 60% 是 RL3 → 加 SERP cache 覆盖度

### 6. 多语言扩展（远期）

当前只跑 EN US。中文 / 其他语言扩展：
- DataForSEO location_code / language_code 改一下
- prompt template 加 language 变量
- phase2 RL1-3 的关键词列表多语言版本

---

## 决策模板（CEO 5 分钟周度 review）

打开 [workbook](https://docs.google.com/spreadsheets/d/1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc/edit) → 4 个 tab 各看 1 屏：

1. `publish-log` — 这周 publish 了几篇？同环比？
2. `quality-metrics` — phase2 通过率？是不是某条 RL 突然涨？
3. `pipeline-status` — backlog 多长？哪一节点卡住？
4. `cost-tracking` — 这周花了多少？哪个 entity 最贵？

每周一封 5 句话内部 update：
> 本周 publish N 篇，phase2 一次通过率 X%。
> Top entity：A / B / C。
> Bottleneck：[approve / brief-fill / render / phase2 哪一个]。
> 本周 token cost ¥X，DataForSEO API ¥Y。
> 下周 focus：[补哪 cluster / 调哪阈值 / 重跑哪批]。

---

## FAQ

**Q：我能在 Sheet 上直接改 LLM 输出的文章吗？**
A：不能。文章在 `_staging/` 文件。但是可以在 Sheet 上看 `phase2_status`，FAIL 了知道要去本地编辑。

**Q：如果我手动改了 `_staging/` 的 .md，会被覆盖吗？**
A：除非你重跑 LLM call，否则不会。phase2 重新跑会读你改后的版本。

**Q：可以多 LLM 同时跑同一 page 然后选最好的吗？**
A：可以。`_staging/X-claude-v8.md` / `_staging/X-codex-v8.md` / `_staging/X-hermes-v8.md` 三个独立文件，publish 时 `--llms "claude codex hermes"` 全 ship 或挑一个 ship。

**Q：phase2 阈值能放宽吗？**
A：能改 `lib/red-lines.mjs` 里的常量 + 同步改 Sheet config tab。但红线之所以是"红"，是 production-critical（RL1 clinical claim = 法律风险，RL3 plagiarism = SEO 处罚），建议不放宽。
