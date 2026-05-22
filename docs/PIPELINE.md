# PIPELINE.md — 补一篇新 SEO 文章的 12 步 runbook

> 实战来源：2026-05-22 补 4 篇 v8 aura-related 文章（orange / green aura, chakra
> system overview, four-element framework）的完整路径。覆盖从空 page_id 到
> astrologywiki.com 上线的全流程，包含每一步实际跑的命令、预期输出、踩过的坑。
>
> 适用：补 1 篇或一批新文章 + 让现有文章里指向新文章的占位符变成可点击 link。
>
> 不适用：批量重写历史文章 / 改 prompt 模板 / 改 SEO stub 注入逻辑（这 3 件事
> 走另外的流程，见末尾 § "不属于本 runbook"）。

---

## 0. Prerequisites

**Repos**（都要本地 checkout）：

| Repo | Path | 角色 |
|---|---|---|
| `xdawayer/gengrowth-flow-mvp` | `/Users/wzb/gengrowth-flow-mvp` | 工具链 + staging |
| `xdawayer/oracle` | `/Users/wzb/Code/oracle` | 网站源（Vite + React 19 SPA） |
| `xdawayer/gengrowth-wiki` | `/Users/wzb/gengrowth-wiki` | Obsidian vault + 内容资产 |

**Obsidian vault**：`/Users/wzb/gengrowth-wiki/wzb-obsidian/LLM-Wiki/`（**坑 #8**：
`gg-obsidian-rag.mjs` 默认 vault-dir 是 `wzb-obsidian/LLM-Wiki/`，相对 flow-mvp 根目录解析，
所以第一次跑不带 `--vault-dir` 一定失败。修复在 task #42。）

**Env**：

- 不强制要 `OPENROUTER_API_KEY` — 因为 LLM 输出走 Claude Code 主 session（codex MCP +
  Agent fanout），不走 OpenRouter `_call-hermes.mjs`。
- 不需要 `GG_SHEETS_WORKBOOK_ID` — 补充类 page 不在 Sheet 里，走 synth batch fixture。

---

## 1. 设计 brief（手工，6 个必填字段）

对每个新 page_id（约定 `page_<snake_case_entity>`），在
`.gg-cache/overrides/<batch-name>.json` 加一个 entry：

```json
{
  "page_<entity>": {
    "page_id": "page_<entity>",
    "entity": "<Title-Cased Entity>",
    "target_keyword": "<seo phrase>",
    "associated_keywords": ["...", "...", "..."],
    "search_volume": "<n>",
    "cluster_jtbd": "<1 句话讲读者搜这个词的 JTBD>",
    "content_angle": "<怎么写：framing + 区分度 + disclaimer>",
    "internal_link_rule": "all → <pillar> + <siblings> + <chakra ref>",
    "cta_text": "Take the 60-second Aura Reading Quiz to see how your colors map",
    "cta_target_url": "https://astrologywiki.com/tools/aura-reading-quiz",
    "tier_gate_block": "## Tier Gate（T2 Definition）\n\n- 必读 Friction（col J）: ...\n- 必读 Logic（col K）: ...\n- T2 = 标准版 — 字数 1500-1800，结构严格按 7 sections",
    "rl6_hint": "<RL6 内容禁忌的 1-2 句提醒>",
    "friction_themes": [
      { "theme": "<key>", "scrubbed_quote": "<reddit-style quote>", "source_id": "reddit#1", "domain": "old.reddit.com", "mention_count": 8 },
      { "theme": "<key>", "scrubbed_quote": "...", "source_id": "reddit#2", "domain": "...", "mention_count": 6 },
      { "theme": "<key>", "scrubbed_quote": "...", "source_id": "reddit#3", "domain": "...", "mention_count": 5 }
    ],
    "tier": "T2",
    "template": "Definition"
  }
}
```

T1 Pillar 多一个 `child_entities` + `child_count` 字段，`tier="T1"`，`template="Pillar"`。

**参考已有 brief**：`.gg-cache/overrides/aura-colors-batch.json`（6 个完整 brief）+
`.gg-cache/overrides/aura-related-batch.json`（4 个 2026-05-22 补充 brief）。

**辅助工具**：`node tools/scripts/gg-brief-init.mjs --page-id <id> --entity "<X>" --tier T2 --template Definition` → 写一个带 TODO 占位符的骨架到
`.gg-cache/overrides/<page-id>.json`。骨架里有 12 个 `TODO:` 标记（search_volume +
cluster_jtbd + content_angle + internal_link_rule + tier_gate_block 内 2 个 + rl6_hint +
3 × friction_themes 各 2 字段 = 6），用 `grep TODO: .gg-cache/overrides/<id>.json` 找全
位置后逐个替换。

---

## 2. 跑 Phase 0 RAG (entity-passport + obsidian-rag)

```bash
node tools/scripts/gg-entity-passport.mjs \
  --entity "<entity name>" --page-id page_<entity> --emit-rag

node tools/scripts/gg-obsidian-rag.mjs \
  --page-id page_<entity> --entity "<entity name>" \
  --target-keyword "<seo phrase>" \
  --vault-dir /Users/wzb/gengrowth-wiki/wzb-obsidian/LLM-Wiki
```

写出：
- `.gg-cache/page_<entity>/entity-passport.rag.json`（13 源抓取，~30s/page）
- `.gg-cache/page_<entity>/obsidian-rag.json`（扫 ~2258 notes，~0.7s/page）

**4 个 page 并行**：每个进程独立、IO bound，直接 4 个 `&` 后台跑，wait。

**WARN 是预期**：entity-passport 13 源里 reddit + chani + 3-4 个 esoteric 站常是
"partial sources" 警告 — 这是 source rate-limit 或 placeholder 过滤的正常结果，
不影响 rag.json 写出。

**SERP cache 可选**：`gg-serp-snapshot.mjs` 写 `.gg-cache/serp/<page-id>.json`，
缺失时 renderer 注释为 `<!-- SERP cache missing -->`，不阻塞渲染但内容质量略降。

---

## 3. 写 batch fixture（synth，绕过 Sheet）

新 page 不在 Sheet 里 → 不能用 `gg-sheet-pull`。手 mock 一个最小 fixture：

```json
{
  "schema_version": "1",
  "batch_id": "<YYYYMMDDThhmmss>-<slug>-supplement",
  "workbook_id": "synthetic",
  "tab": "supplement",
  "header": ["Target Keyword", "Tier", "Template", "Entity"],
  "slice": { "start": 1, "end": <N> },
  "pulled_at": "<YYYY-MM-DDTHH:MM:SS.000Z>",
  "stats": { "total": <N>, "ready": <N> },
  "rows": [
    {
      "source_row": 1,
      "status": "ready",
      "page_id": "page_<entity>",
      "raw": { "_synthetic": "supplement row" },
      "brief": {
        "target_keyword": "<seo phrase>",
        "entity": "<Entity>",
        "tier": "T2",
        "template": "Definition"
      },
      "todo": []
    }
  ]
}
```

文件名：`.gg-cache/batches/<YYYYMMDDThhmmss>-<slug>-supplement.json`

renderer 只需要 `row.status="ready"` + `row.page_id` 设置正确 — 其他 brief 字段会被
overrides[page_id] 覆盖（见 `composeCfg` in `gg-render-batch.mjs:109`）。

**自动化**（task #39 之后）：`node tools/scripts/gg-batch-synth.mjs --pages "page_X page_Y" --overrides .gg-cache/overrides/<file>.json` → 自动写 batch fixture。

---

## 4. Render v8 prompt（写到 `.gg-cache/prompts/`）

```bash
node tools/scripts/gg-render-batch.mjs \
  --batch .gg-cache/batches/<file>.json \
  --overrides .gg-cache/overrides/<file>.json \
  --dry-run  # 验证 cfg 13 字段齐了

node tools/scripts/gg-render-batch.mjs \
  --batch .gg-cache/batches/<file>.json \
  --overrides .gg-cache/overrides/<file>.json \
  --continue-on-error
```

写出每个 page：
- `.gg-cache/prompts/page_<entity>.v8-prompt.md`（~29K 字符 / ~4200 tokens）
- `.gg-cache/prompts/page_<entity>.v8-fixture.json`（validator 用的 sidecar）
- `.gg-cache/page_<entity>/friction-mine.rag.json`（synth from brief.friction_themes）

---

## 5. LLM 生成（双 LLM × N pages 并行）

在 Claude Code 主 session 里 fanout：

```
N × mcp__codex__codex calls (sandbox=workspace-write, cwd=flow-mvp)
N × Agent(general-purpose) calls
```

每个调用都给同一段 prompt 模板：

> Read `.gg-cache/prompts/page_<X>.v8-prompt.md` (~29KB). That file IS your task spec. Write the complete markdown article to `_staging/page_<X>-<llm>-v8.md`. After writing, print exactly one line: `WROTE: <abs_path>  <word_count> words`.

约束（写到 prompt 里 — codex / Agent 都可能跑偏，要显式 restate）：
- T2 Definition: 7 H2 (`What is X? / Why It Matters for Self-Awareness / X vs Adjacent Concepts: Mechanism + Trade-offs / Quick Reference Table / Reflection Prompts / Related Reading / Take Action`)
- T1 Pillar: 9 H2 (`What are X? / Why It Matters for Self-Awareness / The X at a Glance / The N X: Quick Guide / How Shade and Combination Shift Readings / Common Misreads + Framework Limits / Reflection Prompts / Related Reading / Take Action`)
- Word range: T2 1500-1800 / T1 2500-3500
- target_keyword count: T2 5-8 / T1 8-12
- Wikilinks 用 `[[<TBD-internal-link: <noun phrase>>]]` literal 格式
- 无 YAML frontmatter / 无 preamble before H1 / 无 follow-up after CTA URL

**坑 #3**：codex MCP 不会自然知道项目背景，写到 prompt 里 + 重述硬约束。
**坑 #4**（已修，2026-05-22）：validator 早期 hardcode `## What are <Entity>?` 单一形式，
对单数实体（"Chakra System" / "Four-Element Framework"）不友好。现在两个模板都接受
4 种 `What is X? / What is the X? / What are X? / What are the X?` 变体，LLM 写任意
grammatically-defensible 的形式都过。

---

## 6. Phase 2 validate

```bash
tools/scripts/phase2-validate-batch.sh \
  --pages "<page_id_1> <page_id_2> ..." \
  --llms "claude codex" \
  --version v8 \
  --report /tmp/phase2-<slug>.md \
  --logdir /tmp/phase2-logs-<slug>
```

PASS → 自动给 `_staging/<page>-<llm>-v8.md` 加 YAML frontmatter，写 `phase2_checks`
到 manifest sidecar。FAIL → md/manifest 都不动，看 `/tmp/phase2-<slug>.md`
诊断（结构 mismatch / RL drift）。

**常见 FAIL**：
- **`missing required H2: "..."`** — LLM 写的 H2 名字跟 validator hardcoded 不一致。
  改文章或让 LLM 重写。
- **`drifted sections: "<H2>" (jaccard=0.000)`** — first paragraph of section 没出现
  entity 字面 — 加一句 entity 名进 first para 即可 fix。

---

## 7. publish 到 wiki 双目标

```bash
tools/scripts/gg-publish-to-wiki.sh \
  --pages "<page_id_1> <page_id_2>" \
  --llms "claude codex" \
  --dry-run  # 先看会 cp 哪些

tools/scripts/gg-publish-to-wiki.sh \
  --pages "..." --llms "claude codex"
```

写到：
- `/Users/wzb/gengrowth-wiki/内容资产/astrologywiki/v8-drafts-<YYYY-MM-DD>-claude/`
- `/Users/wzb/gengrowth-wiki/wzb-obsidian/LLM-Wiki/Writing/AstrologyWiki-v8-drafts-<YYYY-MM-DD>-claude/`

只 publish manifest.phase2_checks.overall=pass 的 — FAIL 自动 skip。

---

## 8. 选 winner LLM

约定：默认 claude；当 claude FAIL / codex 内容更好时用 codex。

> 历史：2026-05-22 4 个新 page 里 orange/green 双双 PASS 选 claude（保持 convention），
> chakra/four-element claude FAIL（自由发挥 H2 跟 hardcoded 不匹配） → 选 codex
> winner。这是 mixed-winner 的典型场景。

---

## 9. md → oracle ts（每个 winner 一次单文件 mode）

batch 模式默认 `--winner-llm claude` 单 winner — mixed-winner 走 single-file × N：

```bash
node tools/scripts/gg-md-to-oracle-ts.mjs \
  --source _staging/page_<X>-<winner>-v8.md \
  --slug <slug> \
  --out /Users/wzb/Code/oracle/data/articles/<slug>.ts
```

转换的 body transforms：
1. `[[<TBD-internal-link: X>]]` → resolve via `TBD_LINK_RULES` → 命中 = real
   markdown link / 未命中 = `*X*` italic
2. autoLinkBareUrls — 裸 https URL 包成 `[url](url)`
3. trim + escape `\`` / `${` for TS template

**自动化**（task #41）：batch 模式增加 `--winner-map "page_X:codex,page_Y:claude"`。

---

## 10. 注册 oracle 4 处（手维护）

每个新文章 4 处都要加：

### 10.1 `oracle/data/articles/index.ts`
```ts
import { <varName>En } from "./<slug>";
// ...
const ARTICLES_EN: WikiArticle[] = [
  ..., // existing
  <varName>En,
];
```

### 10.2 `oracle/scripts/generate-seo-pages.mjs`
```js
const ARTICLE_SLUGS_EN_ONLY = [
  ..., // existing
  '<slug>',
];
```

### 10.3 `flow-mvp/tools/scripts/gg-md-to-oracle-ts.mjs` TBD_LINK_RULES
```js
{ match: /\b<entity-regex>\b/i, href: '/en/wiki/<slug>' },
```

**注意 first-match-wins** — 把更窄的规则放上面（`green aura` before `aura colors`，
`four-element` before `chakra`）。

### 10.4 重生 6 篇老文章 .ts
让新文章对应的 italic placeholder 变 link：

```bash
node tools/scripts/gg-md-to-oracle-ts.mjs --batch --winner-llm claude --version v8 \
  --oracle-articles-dir /Users/wzb/Code/oracle/data/articles \
  --pages "page_aura_colors_pillar page_blue_aura_meaning page_yellow_aura_meaning page_purple_aura_meaning page_white_aura_meaning page_red_aura_meaning"
```

**自动化**（task #43 + #44）：TBD_LINK_RULES 自动从 oracle/data/articles/*.ts 同步 +
`gg-md-to-oracle-ts.mjs --refresh-existing` 自动重生所有现存 .ts。

---

## 11. codex review

```
mcp__codex__codex(
  cwd: /Users/wzb/Code/oracle,
  sandbox: read-only,
  approval-policy: never,
  prompt: "<verify imports / sitemap / TBD rules / body diff drift / build chain>"
)
```

返回 **Ship / Wait** + 5-bullet summary。HIGH 问题先修再 commit。

---

## 12. commit + push + Vercel deploy verify

### flow-mvp

```bash
git -C /Users/wzb/gengrowth-flow-mvp add \
  tools/scripts/gg-md-to-oracle-ts.mjs \
  _staging/page_<X>-{claude,codex}-v8.{md,manifest.json} \
  docs/records/wzb/<YYYY-MM-DD>-chat-record.md

git -C /Users/wzb/gengrowth-flow-mvp commit -m "feat(content): v8 supplement N <slug>"
git -C /Users/wzb/gengrowth-flow-mvp push origin main
```

### oracle

```bash
cd /Users/wzb/Code/oracle && git add \
  data/articles/index.ts data/articles/*.ts \
  scripts/generate-seo-pages.mjs
cd /Users/wzb/Code/oracle && git commit -m "feat(wiki): N new <cluster> articles + relink existing"
cd /Users/wzb/Code/oracle && git push origin main
```

### Vercel deploy verify

```bash
until [ "$(gh api repos/xdawayer/oracle/commits/<sha>/status --jq .state 2>/dev/null)" != "pending" ]; do sleep 15; done && \
  gh api repos/xdawayer/oracle/commits/<sha>/status --jq '{state, statuses: [.statuses[] | {context, state, target_url}]}'
```

期望 `state: success`。失败看 `target_url` 的 Vercel 日志。

---

## 踩过的 9 个坑（按时间序）

| # | 坑 | 触发条件 | Workaround | 永久 fix |
|---|---|---|---|---|
| 1 | brief 6 字段全靠手编 | 任何新 page | 抄已有 brief 模板改 | task #38 brief-init |
| 2 | batch fixture 要手写 | page 不在 Sheet 里 | 手 mock 最小 fixture | task #39 synth batch |
| 3 | LLM fanout 要手 fire | 任何渲染 | 主 session 一个 message 里 N × codex + N × Agent | task #45 one-shot |
| 4 | ~~Pillar `What are <X>?` 期望复数~~ ✓ FIXED 2026-05-22 | — | — | validator 接受 4 变体 |
| 5 | RL4 drift fail | section first para 不含 entity 字面 | edit 加一句 entity 进 first para | （hard to fix 自动化） |
| 6 | mixed winner | claude/codex 各赢一些 page | single-file × N 调 gg-md-to-oracle-ts | task #41 winner-map |
| 7 | TBD_LINK_RULES 双源漂移 | 新文章注册时 | 手在 mjs 加 regex | task #43 auto-sync |
| 8 | obsidian-rag 默认 vault-dir 错 | 第一次跑 | 显式 `--vault-dir /Users/wzb/gengrowth-wiki/...` | task #42 default fix |
| 9 | wiki repo `nothing to commit` | publish cp 后 | 不需要手 commit — auto-backup 定时跑 | 已是预期行为 |

---

## 不属于本 runbook（指向其他文档）

- **改 v8 prompt 模板** → `tools/scripts/lib/content-draft-templates/{definition,pillar}.prompt.md`
  + 重跑所有现有 page 的 render
- **改 _phase2-validate 规则** → `tools/scripts/_phase2-validate.mjs` + `lib/red-lines.mjs`
  + 重跑所有 phase2 batch
- **改 SEO stub 注入** → `oracle/scripts/inject-spa-into-stubs.mjs` + 重 build oracle
- **批量重写老文章** → 改 brief + 重跑 step 2-12，每个 page 一次

---

## 单 page 全流程估时（实测 2026-05-22）

| 步 | 时间 | Bottleneck |
|---|---|---|
| 1. brief | 5-15 min | 手写 6 字段 |
| 2. entity-passport + obsidian-rag | ~1 min | 网络 IO（并行 4 个 page 也是 ~1 min） |
| 3. batch fixture | 1 min | 手写 JSON |
| 4. render prompt | 5s | CPU only |
| 5. LLM 双 LLM 生成 | 3-8 min | LLM latency（并行所有 page 同时间） |
| 6. phase2 validate | 10s | sync |
| 7. publish wiki | 1s | cp |
| 8. 选 winner | 0 | 看 phase2 report |
| 9. md → ts | 5s × N |  |
| 10. 注册 4 处 + 重生 6 篇老 | 3 min |  |
| 11. codex review | 30s |  |
| 12. commit + push + deploy verify | 2-3 min | Vercel build |

补 1 篇 ≈ 20-30 min；补 4 篇并行 ≈ 30-40 min（瓶颈在 brief 写作）。

---

## 实战参考

最近一次完整跑通：2026-05-22 补 4 篇 aura-related。

- flow-mvp commit: `b4206d8 feat(content): v8 supplement 4 aura-related articles + TBD_LINK_RULES expand`
- oracle commit: `6e9a5a7 feat(wiki): 4 new aura articles + relink 6 existing aura entries`
- live URLs:
  - https://www.astrologywiki.com/en/wiki/orange-aura-meaning
  - https://www.astrologywiki.com/en/wiki/green-aura-meaning
  - https://www.astrologywiki.com/en/wiki/chakra-system-overview
  - https://www.astrologywiki.com/en/wiki/four-element-framework
