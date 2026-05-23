# PIPELINE.md — gengrowth-flow-mvp v8 完整链路操作手册

> **覆盖范围**：从"我们要做什么关键词"到"文章 commit 进 wiki repo"的全部 18 步。
>
> **读者**：Ops（每天跑链路）、Engineer（调工具）、PM（看流程节点）。
> CEO/PM 想要的高级别概览见 [OPS_OVERVIEW.md](./OPS_OVERVIEW.md)。
>
> **配套**：
> - 实时状态：[gengrowth-flow-mvp workbook](https://docs.google.com/spreadsheets/d/1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc/edit) — 5 个业务 tab + 5 个自动产物索引 tab
> - 旧版纯下游 runbook：[PIPELINE-v1-downstream-runbook.md](./PIPELINE-v1-downstream-runbook.md)（补 1 篇文章的最小路径）
> - 本地 dashboard：`node tools/scripts/gg-status.mjs --md` → 当前所有 page 的进度表

---

## 0. 前置：环境与凭据

| Env 变量 | 用途 | 怎么获得 |
|---|---|---|
| `GG_SHEETS_FLOW_MVP_WORKBOOK_ID` | v8 链路用的新 Sheet | `1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc`（直接写进 `~/.config/gg/_gg.env`） |
| `GG_SHEETS_WORKBOOK_ID` | 旧 Sheet（继续保留，不动） | 跟之前一样 |
| `GG_DATAFORSEO_LOGIN` / `PASSWORD` | DataForSEO Labs（Basic Auth） | dataforseo.com 后台 |
| `GG_OAUTH_*` | 用户 OAuth（spreadsheets/GSC/GA4 scope） | `node tools/scripts/oauth-init.mjs` 一次 consent |
| `GG_WRITER_SA_JSON` | writer SA JSON 路径 | `~/.config/gg/gg-writer-sa.json` |

**Service Account 必须共享到新 Sheet**：在新 workbook 点 Share → 加 `gg-writer-sa@aqueous-sandbox-496915-i1.iam.gserviceaccount.com` → Editor。否则 promote / mine / status 全部写不进去。

**两个 LLM CLI 任选其一**：
- `claude` (Claude Code 自带) — 免费内置，但容易输出元评论
- `codex exec` (OpenAI Codex CLI) — 输出最稳定，推荐
- `_call-hermes.mjs` (OpenRouter Nous Hermes 3) — 需 `OPENROUTER_API_KEY`

---

## 链路总览

```
[上游：选题 / 关键词 / 桥]
1. mine          DataForSEO Labs → keyword_candidates 副表
2. approve       人在 Sheet 标 K 列 wzb_approve=Y
3. promote       approved → 关键词主表 A-I + 选题登记表 col A
4. fill-v8       人补选题登记表 B-U 21 列 v8 brief
5. cluster/CTA   人补主题集群表 + CTA Map 一行业务数据
6. bridge        选题登记表 × 主题集群表 × CTA Map → brief override JSON

[中游：RAG / Prompt]
7. sheet-pull    选题登记表 row → batch fixture JSON
8. rag-entity    13-source entity passport → rag.json
9. rag-obsidian  本地 Obsidian vault 检索 → rag.json
10. rag-friction Reddit / community scrape → rag.json（缺则 SYNTH placeholder）
11. render       batch + override + 3 个 RAG → v8 prompt + fixture sidecar

[下游：LLM / 验证 / 发布]
12. llm-call     prompt → claude/codex/hermes → _staging/X.md
13. phase2       6 red lines 验证 → PASS 写 manifest
14. publish      PASS 文章 → wiki 2 destinations cp
15. commit       wiki repo git commit
16. (可选) deploy oracle 网站 Vite build → Vercel
17. (可选) monitor GSC 点击 + GA4 行为
18. (可选) retro 周度回顾，调阈值 / 重跑失败 page
```

---

## 阶段 1 — mine：拉关键词候选

| 项 | 值 |
|---|---|
| 工具 | `tools/scripts/gg-keyword-mine.mjs` |
| API | DataForSEO Labs `keyword_suggestions/live` |
| 输入 | `--seeds "a,b,c" --entity "x"` |
| 输出 | Sheet `keyword_candidates!A:K` 追加 N 行 |
| 默认阈值 | `kd ≤ 50, volume ≥ 50, max 15 results`（见 config tab `mine.*`） |
| 关键代码 | `parseLabsItem()` line 173, `keyword_properties.keyword_difficulty`（**不是** `keyword_info`） |
| 打断点 | `--dry-run` 不写 Sheet，stdout 出 JSON |
| 自定义 | `--max-kd 30 --min-vol 200 --max-results 20 --negatives "free,vs"` |
| 失败模式 | 0/5 seed 成功 → exit 2；部分成功仍 ok |
| 成本 | DataForSEO Labs $0.002 / 100 candidates；典型 5 seed = $0.05 |

**实操命令**：

```bash
node tools/scripts/gg-keyword-mine.mjs \
  --seeds "blue aura,red aura,yellow aura,green aura,purple aura" \
  --entity "aura"
```

**怎么看产出**：Sheet `keyword_candidates` tab。每行：`query / volume / kd / cpc / serp_features / geo_score / ai_recommend / wzb_approve`。

**`ai_recommend` 列含义**：`⚠️疑似高风险` = SERP 已有 AI Overview，蓝海词被吃风险大；空 = 正常。

**`geo_score` 算法**：综合 volume + KD + CPC + intent，越高越值得做。当前 aura 长尾词 KD 全 0 → GEO 退化为 volume 排序。

---

## 阶段 2 — approve：人工筛 wzb_approve=Y

| 项 | 值 |
|---|---|
| 触发 | 人在 Sheet 上把 `keyword_candidates!K` 改成 `Y` |
| 严格规则 | `isApproved()` line 54：**必须严格 `'Y'`**，小写 `y` / `yes` / `是` 都拒绝 |
| 判断依据 | I 列 geo_score（高优先）+ J 列 ai_recommend（避开 ⚠️）+ 业务直觉 |
| 中断 | 任意时候改 K 列 |

**节奏建议**：每周一次性 review 一批，标 5-10 个，不要一次标 50 个（promote 一次 batch 太大）。

---

## 阶段 3 — promote：approved → 主表 + 选题登记表

| 项 | 值 |
|---|---|
| 工具 | `tools/scripts/gg-keyword-promote.mjs` |
| 输入 | Sheet 自动读 `keyword_candidates` + `关键词主表` |
| 输出 | 主表 `A-I` 追加；可选选题登记表 `A` 追加 |
| dedupe | `filterApprovedNotYetPromoted()` line 110，主表 A 列 lowercase 比对 |
| 公式列保护 | `buildMasterRow()` line 60 — 只写 9 列，公式列 J/K/M/N/O/R/S/U 绝对不碰 |
| 打断点 | `--dry-run` 看 JSON 预览 |
| 常用 flag | `--also-draft-pages`（同时往选题登记表写一行 col A） |
| Schema 漂移防护 | `validateCandidateHeader()` — 副表 header 缺 `query`/`wzb_approve` 会 fatal |

**实操命令**：

```bash
node tools/scripts/gg-keyword-promote.mjs --also-draft-pages
# 或先 dry-run
node tools/scripts/gg-keyword-promote.mjs --dry-run --also-draft-pages
```

**报告输出**：stderr 写 `promoting N approved candidate(s) → 关键词主表!A:I`，stdout 列每个被 promote 的 query。

---

## 阶段 4 — fill-v8：选题登记表 21 列补完（人工）

| 列 | 字段 | 必填？ | 作用 |
|----|------|-------|------|
| A | Target Keyword | promote 已填 | bridge 的 entry key |
| F | Tier | ✅ | `Tier 1 (重装)` / `Tier 2 (标准)` — 决定字数 + 红线宽容度 |
| G | Template | ✅ | `Pillar` / `Tutorial` / `Definition` |
| H | Entity | ✅ | RAG 主体；**用简短名（"Blue Aura" 而非 "Aura / Blue Aura"）**，否则 RL4 escape hatch 不生效 |
| I | Friction | ✅ | 用户痛点 3-5 句（喂 LLM friction_themes） |
| J | Logic | ✅ | 写作 angle 一句话（喂 LLM 的 differentiator） |
| K | CTA | 可选 | URL（CTA Map 会覆盖；空着也行） |
| P | page_id | ✅ | 稳定 slug，正则 `/^[A-Za-z0-9_-]{1,64}$/` |
| Q | cluster_id | ✅ | 关联 主题集群表 A 列 |
| R | page_role | ✅ | 关联 CTA Map B 列 |
| S | content_angle | ✅ | 写作角度（也供 LLM） |
| T | psych_safety_flag | ✅ | `Y` / `N` — 严格大写。Y 则文章必须含 disclaimer（RL6） |
| U | journal_prompts | 可选 | 反思问题，用 `|` 分隔 |

**HEADER_MAP 在哪**：`tools/scripts/gg-sheet-pull.mjs:144`。
**任何 schema 改动**：在 HEADER_MAP 里加映射条目即可，bridge/pull 都会用上。

---

## 阶段 5 — cluster/CTA：填业务元数据（人工）

**主题集群表（20 列）**，关键字段：

| 列 | 字段 | 解释 |
|---|------|------|
| A | cluster_id | 主键，被选题登记表 Q 列引用 |
| C | track | `量产线` / `战略线` |
| G | jtbd | Jobs-to-be-done 一句话 |
| H | content_angle | 整个 cluster 的 angle |
| N | internal_link_rule | 站内链规则（pillar / sibling 链接套路） |
| O | cta_primary | 主推 CTA 的 page_role（匹配 CTA Map B 列） |
| P | psych_safety_flag | cluster 级 Y/N（page 级 OR cluster 级 → 任一 Y 即触发 RL6） |

**CTA Map（6 列）**，关键字段：

| 列 | 字段 | 解释 |
|---|------|------|
| A | cta_id | 主键 |
| B | page_role | 被主题集群表 O / 选题登记表 R 引用 |
| C | cta_文案 | 显示给用户的文案 |
| D | target_url | 落地页 URL |
| E | ga4_event_name | 用于 GA4 事件追踪 |

**Schema 在代码哪**：`tools/scripts/gg-sheet-to-brief.mjs:77 CLUSTER_HEADER_MAP` + `:102 CTA_HEADER_MAP`。

---

## 阶段 6 — bridge：3-way join → brief override JSON

| 项 | 值 |
|---|---|
| 工具 | `tools/scripts/gg-sheet-to-brief.mjs` |
| 输入 | Sheet 三张表 + `--row N` 或 `--rows N-M` |
| 输出 | `.gg-cache/overrides/<X>.json` |
| 路径监狱 | `validateOutPath()`：只能写 `.gg-cache/overrides/` 或 `_staging/`，防 `..` traversal |
| Fail-loud gate | cluster_id 不在主题集群表 → FATAL（除非 `--allow-missing-cluster`） |
| Fail-loud gate | page_role 不在 CTA Map → FATAL（除非 `--allow-missing-cta`） |
| 打断点 | `--dry-run` stdout 出 JSON，不写文件 |

**实操命令**：

```bash
node tools/scripts/gg-sheet-to-brief.mjs --row 310 --out .gg-cache/overrides/aura-color-blue.json
```

**输出验证**：

```bash
cat .gg-cache/overrides/aura-color-blue.json | jq '."page_aura_color_blue" | {cluster_jtbd, cta_text, cta_target_url, psych_safety_flag, content_angle}'
```

字段不空 = cluster / CTA join 真接上了。空 = 检查选题登记表 Q/R 列拼写 + 三张表 join key 一致性。

---

## 阶段 7 — sheet-pull：batch fixture

| 项 | 值 |
|---|---|
| 工具 | `tools/scripts/gg-sheet-pull.mjs` |
| 输出 | `.gg-cache/batches/<ISO>-<tab>-rows-<slice>.json` |
| 与 bridge 区别 | sheet-pull 不 join cluster/CTA（下游 renderer 再 merge override） |

```bash
node tools/scripts/gg-sheet-pull.mjs --row 310 --out .gg-cache/batches/aura-color-blue.json
```

---

## 阶段 8 — rag-entity：13-source 实体证据

| 项 | 值 |
|---|---|
| 工具 | `tools/scripts/gg-entity-passport.mjs --emit-rag` |
| 输出 | `.gg-cache/<page_id>/entity-passport.rag.json` |
| 数据源 | Wikipedia, Reddit, Quora, 3-4 个 esoteric 站, etc.（13 个） |
| 耗时 | ~30s / page |
| WARN 是预期 | 部分 source rate-limit / placeholder 过滤 — 不阻塞 |

```bash
node tools/scripts/gg-entity-passport.mjs --entity "aura color blue" --page-id page_aura_color_blue --emit-rag
```

---

## 阶段 9 — rag-obsidian：本地 vault 检索

| 项 | 值 |
|---|---|
| 工具 | `tools/scripts/gg-obsidian-rag.mjs` |
| 输出 | `.gg-cache/<page_id>/obsidian-rag.json` |
| 数据源 | `/Users/wzb/gengrowth-wiki/wzb-obsidian/LLM-Wiki/` 默认 vault |
| 耗时 | ~0.7s / page（扫 2258 notes） |
| 0 match 不算 fail | 写入 `gap_note` 让 renderer 知道 |

```bash
node tools/scripts/gg-obsidian-rag.mjs --page-id page_aura_color_blue --entity "aura color blue" --target-keyword "aura color blue"
```

---

## 阶段 10 — rag-friction：Reddit 社区抓取

| 项 | 值 |
|---|---|
| 工具 | `tools/scripts/gg-friction-mine.mjs` |
| 输出 | `.gg-cache/<page_id>/friction-mine.rag.json` |
| 缺数据时 | renderer 自动 SYNTH placeholder（`TODO: scrubbed quote`）— **文章质量下降** |
| RAG cache root | 默认仓库 `.gg-cache/`（曾误配为 `~/.gg-cache/` 已修） |

**重要**：友邻爬虫需要 Reddit OAuth credential（在 `_gg.env`），目前可选；如果没配，render 会用 SYNTH placeholder，phase2 不 fail 但文章 friction section 是 TODO 文字。

---

## 阶段 11 — render：组装 v8 prompt

| 项 | 值 |
|---|---|
| 工具 | `tools/scripts/gg-render-batch.mjs` |
| 输入 | `--batch X.json --overrides Y.json` |
| 输出 | `.gg-cache/prompts/<page_id>.v8-prompt.md`（≈30 KB / 3k tokens）+ `<page_id>.v8-fixture.json` |
| Skip 条件 | RAG cache 缺、cfg 字段缺 → skip + hint |
| 关键代码 | `lib/_render-aura-shared.mjs:renderAuraPrompt()` |

```bash
node tools/scripts/gg-render-batch.mjs \
  --batch .gg-cache/batches/aura-color-blue.json \
  --overrides .gg-cache/overrides/aura-color-blue.json
```

**看 prompt 内容**：直接 `less .gg-cache/prompts/<page_id>.v8-prompt.md`。
**stderr 信号**：
- `All placeholders replaced ✓` = 模板字段全填上
- `SERP cache: MISSING` = 阶段 11 之前没跑 `gg-serp-snapshot`，phase2 RL3 会 skip
- `Obsidian RAG: gap` = 阶段 9 0 match，正常

---

## 阶段 12 — llm-call：prompt → 文章

> ⚠️ **Frontier-only policy**（wzb 2026-05-23）：SEO 内容生成必须用**精确**的 frontier 配置。一篇文章 LLM 成本（几美分到几元）远小于排名 ROI。**不允许**为省 token 降级。

**精确 model 配置**：

| 厂商 | Model | Reasoning | 命令 |
|------|-------|-----------|------|
| **Claude (本机 CLI)** | `claude-opus-4-7` | `xhigh`（extended-thinking max） | `claude -p --model claude-opus-4-7 < prompt > out.md` |
| **ChatGPT / Codex (本机)** | `GPT 5.5` | `high` | `codex exec -c model=gpt-5.5 -c reasoning_effort=high - < prompt > out.md` |
| **Gemini (本机 CLI)** | `gemini-3.0-pro` | — | `gemini --model gemini-3.0-pro < prompt > out.md` |
| **OpenRouter (任一)** | `anthropic/claude-opus-4` / `openai/gpt-5.5` / `google/gemini-3-pro` / `nousresearch/hermes-3-llama-3.1-405b` | — | `node tools/scripts/_call-hermes.mjs --prompt X --output Y --model <id>` |

⚠️ **Claude CLI 默认会降级到 Sonnet**，必须显式 `--model claude-opus-4-7`。
⚠️ **Retry 规则**：同 model 跑 2 次都 phase2 fail → 换更高 frontier model（diversity > repetition）。例如 hermes 失败 2 次 → 切 Opus 4.7 xhigh，不要第 3 次 hermes。

**output 文件名约定**：`_staging/<page_id>-<llm>-v8.md`（publish 脚本靠这命名 matrix）

**坑**：claude/codex 第一轮容易啰嗦或字数不达标，准备好 retry。retry prompt 加显式 fix 提示能 1-2 轮收敛。

**多 LLM 并行**：3 个 LLM 后台跑同 prompt，phase2 都过 → 选最好的一篇 publish（diversity benefits）。

---

## 阶段 13 — phase2：6 红线验证

| 检查 | 工具 | 阈值 (config tab) | FAIL 表现 |
|------|------|------|----------|
| Structure | `_phase2-validate.mjs:164` | H1=1, H2 列表 expected, words 范围 | 缺 H2 / 字数 < min |
| RL1 clinical | `lib/red-lines.mjs:checkRL1` | 禁用 `clinical/treatment/cure/disorder/syndrome` | 命中即 fail |
| RL2 competitor | `:checkRL2` | 6 个竞品名 ±200 char 范围内禁负面词 | 任意命中 fail |
| RL3 plagiarism | `:checkRL3` | SERP top-10 n-gram overlap | `> 12 tokens` fail |
| RL4 anchor | `:284` | jaccard < `0.05` AND shingle < `0.10` → drift | `≥ 2` drifted → fail；entity escape hatch line 319 |
| RL5 stuffing | `:checkRL5` | target_keyword 出现次数 | `> 12` fail |
| RL6 psych | `:367` | psych_safety=Y 时必须含 disclaimer | 缺 disclaimer fail（strict mode） |

**实操命令**：

```bash
node tools/scripts/_phase2-validate.mjs \
  --source _staging/page_aura_color_blue-codex-v8.md \
  --page-id page_aura_color_blue \
  --tag codex-v8
```

**PASS 时**：写 `_staging/<page_id>-<llm>-v8.manifest.json`（`phase2_checks.overall = "pass"`）→ publish 才会捡。
**FAIL 时**：不写 manifest → publish 跳过这一篇。

**修法**：
- 字数不够 → retry LLM 加 "1500-1800 words" hint
- RL4 drift → 在 drifted section 第一句加 entity 字面短语
- RL5 stuffing → 把多余 keyword 换同义词
- RL6 缺 disclaimer → 文章末尾加 `> This is not a clinical/mental health interpretation/advice` 类语句

---

## 阶段 14 — publish：cp 到 wiki

| 项 | 值 |
|---|---|
| 工具 | `tools/scripts/gg-publish-to-wiki.sh` |
| 判断 | 只 publish `manifest.phase2_checks.overall == "pass"` 的 |
| 落点 1 | `/Users/wzb/gengrowth-wiki/内容资产/astrologywiki/<batch-dir>/<date>-<slug>-<llm>.md` |
| 落点 2 | `/Users/wzb/gengrowth-wiki/wzb-obsidian/LLM-Wiki/Writing/AstrologyWiki-<batch-dir>/...` |
| Slug | 从 page_id 派生：`page_aura_color_blue` → `aura-color-blue` |
| 打断点 | `--dry-run` 看 matrix |

```bash
bash tools/scripts/gg-publish-to-wiki.sh --pages "page_X" --llms "codex" --dry-run
bash tools/scripts/gg-publish-to-wiki.sh --pages "page_X" --llms "codex"
```

---

## 阶段 15 — commit：wiki repo

```bash
cd /Users/wzb/gengrowth-wiki
git add "内容资产/astrologywiki/<batch-dir>/<file>" "wzb-obsidian/LLM-Wiki/Writing/AstrologyWiki-<batch-dir>/<file>"
git commit -m "feat(wiki): publish v8 <page_id> article"
```

**不 push** — push 由人显式触发（避免被自动化推到远程）。

---

## 阶段 16-18（可选）—— deploy + monitor + retro

**16. deploy**：oracle 仓库 `npm run build` → Vercel auto-deploy（其他 repo 自动检测 wiki repo 变化）
**17. monitor**：GSC 看 impressions / clicks；GA4 看 dwell time / CTA CTR
**18. retro**：每周一次跑 `gg-status.mjs` 看通过率，调阈值，重跑失败 page

---

## 故障定位速查表

| 症状 | 大概率原因 | 修复 |
|------|----------|------|
| mine "no candidates" | seeds 太罕见 / DataForSEO API 抖动 | 加 seed 数 / 退而 `keyword_overview` 单查 |
| mine status 401 | DataForSEO cred 失效 | 重新生成 + 改 `_gg.env` |
| promote "no approved" | 主表 dedupe / wzb_approve 不是严格 'Y' | 看 K 列实际字符，必须大写 Y |
| bridge "cluster fetch failed" | 主题集群表不存在 / SA 无权限 | share SA editor / 跑 bootstrap |
| render "skipped — missing RAG" | 阶段 8/9 没跑 | 按 page_id 跑 entity-passport + obsidian-rag |
| phase2 RL4 drifted | 第一段不含 entity literal | fixture entity 改单一短名 / 文章首句加 entity |
| phase2 RL6 missing disclaimer | psych_safety=Y 但文章无 disclaimer | 文末加 disclaimer 行 |
| publish "0 published" | manifest.overall != pass | 跑 phase2 → fix → 重跑 |

---

## 阈值调整流程

1. 在 Sheet `config` tab 改 value
2. 同步改代码 — `lib/red-lines.mjs` (`RL3_N_GRAM`, `RL4_JACCARD_FLOOR`, etc.) 或 `gg-keyword-mine.mjs` (`maxKd` / `minVolume`)
3. 在 config tab 的 `changed_at` / `changed_by` / `rationale` 填记录
4. 必要时跑 retro 看历史 RL pass 率变化

> ⚠️ Sheet config tab 当前是 **only-doc**（人可读），代码并不自动从 Sheet 读阈值。改阈值要改两处（Sheet + 代码）保持同步。
> 后续可加 `gg-config-sync.mjs` 让代码从 Sheet 读阈值（在 [OPS_OVERVIEW.md "建议补充"](./OPS_OVERVIEW.md#补充建议) 中讨论）。

---

## 文件目录速查

```
tools/scripts/
├── gg-keyword-mine.mjs          # 1
├── gg-keyword-promote.mjs       # 3
├── gg-sheet-to-brief.mjs        # 6
├── gg-sheet-pull.mjs            # 7
├── gg-entity-passport.mjs       # 8
├── gg-obsidian-rag.mjs          # 9
├── gg-friction-mine.mjs         # 10
├── gg-render-batch.mjs          # 11
├── _call-hermes.mjs             # 12 (OpenRouter)
├── _phase2-validate.mjs         # 13
├── gg-publish-to-wiki.sh        # 14
├── gg-status.mjs                # dashboard（手册没单步）
├── _bootstrap-flow-mvp-workbook.mjs  # 一次性建表
├── lib/red-lines.mjs            # 红线引擎（阈值在顶部）
├── lib/_render-aura-shared.mjs  # prompt 组装
├── lib/gg-shared.mjs            # SA token, gFetch
└── lib/_oauth-token.mjs         # OAuth token

.gg-cache/
├── overrides/<X>.json           # bridge 产出（阶段 6）
├── batches/<X>.json             # sheet-pull 产出（阶段 7）
├── prompts/<page_id>.v8-prompt.md     # render 产出（阶段 11）
├── prompts/<page_id>.v8-fixture.json  # phase2 自动读
└── <page_id>/
    ├── entity-passport.rag.json  # 阶段 8
    ├── obsidian-rag.json         # 阶段 9
    └── friction-mine.rag.json    # 阶段 10

_staging/
├── <page_id>-<llm>-v8.md         # 阶段 12
└── <page_id>-<llm>-v8.manifest.json  # 阶段 13 PASS 时写

docs/
├── PIPELINE.md                  # 本文档
├── OPS_OVERVIEW.md              # CEO/PM 视角
├── PIPELINE-v1-downstream-runbook.md  # 旧 12 step runbook（补 1 篇）
└── records/                     # 对话记录
```
