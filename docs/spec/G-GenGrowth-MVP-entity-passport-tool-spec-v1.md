---
title: GenGrowth MVP — /gg-entity-passport 工具 spec v1.1
date: 2026-05-21
type: tech-spec
author: wzb
status: draft (W1 Mon ship 前 Claude Code 实现参考)
version: v1.1
tags:
  - gengrowth
  - mvp
  - entity
  - passport
  - tool-spec
aliases:
  - entity passport spec
  - 5 sources 5 angles
related:
  - "[[G-GenGrowth-MVP-RACI-and-execution-flow-v1]]"
  - "[[G-GenGrowth-MVP-落地plan-v1.1]]"
  - "[[G-GenGrowth-MVP-半自动化工具栈方案-v1.2-lean]]"
  - "[[G-GenGrowth-MVP-keyword-fallback-tool-spec-v1]]"
review_trail:
  - "2026-05-21 v1.0 — 初稿。RACI v1 §6 P1-1 W1 Mon 任务（与 /gg-keyword-fallback 并行 ship）。继承 keyword-fallback v1.1 的安全约束（exact hostname allowlist + redact + ingest path validation + sanitizer NFKC/zero-width/base64/injection）。"
  - "2026-05-21 v1.1 — codex review 后砍 scholar_placeholder 假源，明确改为 5 源（5 源 × 5 角度 = 25 cell），第 6 源由 wzb 自补（人工拍 YouTube transcript 或 Google Scholar abstract）。该 placeholder 假装 6 源但不抓数据，制造 false sense of completeness。"
---

# /gg-entity-passport 工具 spec v1.1

> [!info] 为什么有这个工具
> v2.0 内容 SOP 真五步的第 2 步 ==Entity 主权搜证==：每篇精修必须 **5 源 5 角度** 拉取实体上下文（v1.1 起，第 6 源由 wzb 自补），写到 `entity_passport.json`，供后续 Phase 2 AI 组装时作 `facts.json` 的可信源（不混 untrusted reddit/quora）。
> 不做这一步 → Phase 2 drafter 会把 reddit 段子当事实写进去 → AI Overview 直接拒收。
>
> v1.1 codex review 改动：砍掉 `scholar_placeholder` 假源（假装 6 源但不抓数据，制造 false sense of completeness）。v1 仅 5 源 × 5 角度 = 25 cell；第 6 源由 wzb 手补（YouTube transcript / Google Scholar abstract）。

---

## §1 30 秒读完

- **输入**：一个 entity（如 `saturn return`）
- **输出**：`entity_passport.json` 文件 → `~/.gg-cache/entity-passport-<ts>-out.json` + Sheets `entity_passports` tab append
- **wzb 工作量**：30 秒 LOOK 6 源摘要 + DECIDE 是否补第 7 源
- **Ship 时机**：W1 Mon，与 `/gg-keyword-fallback` + `/gg-friction-mine` 并行（Claude Code 0.5h 增量）

---

## §2 5 源 × 5 角度（v1.1）

### 5 源（占星垂类 weather.gov 等价物）

| # | 源 | hostname | 抓什么 | graceful degrade |
|---|----|----------|--------|------------------|
| 1 | Wikipedia | `en.wikipedia.org` | entity 主条目 first 5 段 | 404 → warn，不阻断 |
| 2 | Astrodienst（占星权威）| `www.astro.com` | entity 词条 first 5 段 | 404 → warn |
| 3 | Reddit r/astrology + r/AskAstrologers | `old.reddit.com` | 30d top post title + 1st para（复用 keyword-fallback allowlist）| 403 → warn |
| 4 | Cafe Astrology | `cafeastrology.com` | entity 主页 first 5 段 | 404 → warn |
| 5 | Chani Nicholas（知名占星家）| `chaninicholas.com` | entity 词条 first 5 段 | 404 → warn |

> [!warning] 第 6 源 = wzb LOOK 节点（v1.1 — codex review 后明确）
> 工具只跑 5 源；YouTube transcript / Google Scholar abstract / 占星实操播客 / 私域社群等 token-gated 资源**不实现**。
> 早期 v1.0 曾尝试用 `scholar_placeholder` 占位，但 codex review 指出这是假源（假装 6 源但不抓数据，制造 false sense of completeness），v1.1 已删。
> Phase 1 输出后 wzb 看 5 源摘要，若觉得不够，自己**手补 1 源**（人工拍 YouTube transcript 或 Google Scholar paper abstract）→ 在 Phase 2 ingest JSON 里加 `sources[5]` + 填 `wzb_seventh_source` 字段（兼容字段名沿用，记录第 6 源 URL）。

### 5 角度

每源都尝试抽取 5 个 angle（Phase 2 AI 抽，工具只摆 schema）：

| angle | 含义 | 例（entity = saturn return） |
|-------|------|------------------------------|
| `definition` | What is X？ | "Saturn return is the astrological event when Saturn returns to its natal position..." |
| `mechanism` | How does X work？ | "Saturn's 29.5-year orbit causes..." |
| `individual_application` | How does X show up in someone's chart？ | "First return at 27-30; theme depends on Saturn's natal house..." |
| `cultural_context` | Historical / cultural context | "Hellenistic astrology framed Saturn as..." |
| `critique` | Critiques / limitations | "No peer-reviewed mechanism; effect size = self-report only" |

---

## §3 安全约束（继承 keyword-fallback v1.1）

- **Exact hostname match**（非 subdomain 通配）：`new URL()` 解析 + hostname 严格 in `ALLOWED_HOSTS` Set
- 拒绝 `http://`、user/password、非 443 端口、IP literal、`localhost`
- 每次 fetch redirect 后对 `Location` 重新跑 allowlist 校验
- Sanitizer 剔除零宽/bidi/base64 >100 块/常见 prompt injection 短语（中英韩阿）
- **Per-source graceful degrade**：单源 404/403/超时 → `recordWarn` + 继续；不阻断 pipeline
- **Phase 2 ingest 路径校验**：`realpathSync` + 必须落在 `~/.gg-cache/` + `.json` + ≤1MB + JSON schema 校验
- **Secret redact**：所有 console.log/error 走 `redact()`；runs 表 notes 列做 `errorCode()` 短代码

---

## §4 处理 pipeline（2-phase split，同 keyword-fallback）

### Phase 1 — 6 源抓取 + cache + Claude 喂料

```bash
node tools/scripts/gg-entity-passport.mjs --entity "saturn return"
```

1. 6 源并行 fetch（每源 5 段 ≈ 30 段原文）
2. sanitize 每段（zero-width / base64 / injection）
3. 写 cache：`~/.gg-cache/entity-passport-<ts>-step1.json`
4. console 打印给 Claude 的 prompt：

> 从下列 6 源原文中，对 entity "saturn return" 抽 5 个角度（definition / mechanism / individual_application / cultural_context / critique），每个角度 ≤120 词。
> 输出 JSON schema：
> ```json
> {
>   "entity": "saturn return",
>   "passport_version": 1,
>   "sources": [
>     {"name": "wikipedia", "url": "...", "snippets": [...], "fetched_at": "..."},
>     ...
>   ],
>   "angles": {
>     "definition": "...",
>     "mechanism": "...",
>     "individual_application": "...",
>     "cultural_context": "...",
>     "critique": "..."
>   },
>   "source_count_used": 6,
>   "wzb_seventh_source": null
> }
> ```

### Phase 2 — ingest AI 输出 → 写 entity_passport.json + Sheets

```bash
node tools/scripts/gg-entity-passport.mjs \
  --entity "saturn return" \
  --ingest ~/.gg-cache/entity-passport-<ts>-step2.json
```

1. validate ingest path（traversal 防护）+ schema 校验（5 angle 必填 + sources ≤6（5 automated + 1 wzb 手补）+ 每段 ≤2000 字）
2. 写 `~/.gg-cache/entity-passport-<ts>-out.json`（不写 wiki 项目本身，避免污染）
3. Sheets `entity_passports` tab append（自动 create if missing）

---

## §5 输出 → Sheets `entity_passports` 表

| 列 | 字段 | 来源 |
|----|------|------|
| A | ts | ISO timestamp |
| B | entity | wzb arg |
| C | source_count | sources 数（含可选第 7 源）|
| D | angle_coverage | 5/5 全填 = `5/5`；缺角 = `3/5` 等 |
| E | file_path | `~/.gg-cache/entity-passport-<ts>-out.json` |
| F | status | `ok` / `partial`（部分源 fail）|
| G | notes | redacted error_code 短代码 |

**valueInputOption=RAW 强制**（Tech §5 已规定）。

---

## §6 退出码

| code | 含义 |
|------|------|
| 0 | 全 pass（5 源全成功 + 5 角度全填）|
| 1 | partial（部分源 fail，如 Wikipedia 404；或 angle 缺 1-2 个）|
| 2 | fatal（ingest schema 错 / Sheets 完全写不进去 / 全部源失败）|

---

## §7 wzb LOOK 节点（30 秒）

W1 Mon AM 跑 Phase 1 后：

1. 看 console 打印的 5 源摘要（每源 first snippet）
2. 30 秒判断：5 源是否够？哪个 angle 弱？
3. 若需补第 6 源：手 fetch 1 个 URL（YouTube transcript / Google Scholar abstract / 私域社群截图）→ 把 snippet 塞进 Phase 2 ingest JSON 的 `sources[5]` + 填 `wzb_seventh_source: "<url>"`（字段名沿用，记录第 6 源 URL）
4. 跑 Phase 2 → Sheets `entity_passports` 表 append 1 行

---

## §8 Ship checklist（W1 Mon Claude Code）

- [ ] `tools/scripts/gg-entity-passport.mjs` 入口脚本（≤700 行）
- [ ] 复用 keyword-fallback 的 helpers：`loadEnv` / `getAccessToken` / `gFetch` / `sanitize` / `redact` / `errorCode` / `redactNote` / `validateIngestPath`
- [ ] **扩 ALLOWED_HOSTS**（本工具独立 Set）：`en.wikipedia.org`, `www.astro.com`, `old.reddit.com`, `np.reddit.com`, `cafeastrology.com`, `chaninicholas.com`
- [ ] Phase 1 → cache `~/.gg-cache/entity-passport-<ts>-step1.json` + 打印 Claude prompt
- [ ] Phase 2 → 写 `~/.gg-cache/entity-passport-<ts>-out.json`（不污染 wiki 项目）
- [ ] Sheets `entity_passports` tab append（auto-create if missing）
- [ ] runs 表 append（同 keyword-fallback 同表）
- [ ] dry-run 模式 `--dry-run` 不写 Sheets
- [ ] smoke test 覆盖：allowlist 扩展后的 SSRF / 5 源 schema (v1.1) / Phase 2 ingest path traversal / graceful degrade

---

## §9 不做（明确边界）

- ❌ 不调 LLM API（Phase 2 是 wzb 在 Claude Code 会话内手跑）
- ❌ 不爬 YouTube transcript（token-gated；wzb 手补走第 6 源路径）
- ❌ 不爬 Google Scholar（无 SA token；v1.1 已删 placeholder 假源 — wzb 手补走第 6 源路径）
- ❌ 不做 entity 去重（W2 才有 entity registry，W1 一篇一文件）
- ❌ 不计算 angle_coverage 的语义质量（只看是否有字符串非空；语义靠 Phase 2 prompt）

---

## §10 Verify after ship

W1 Mon 下午 wzb 手跑一次 dry-run 验证：

```bash
node tools/scripts/gg-entity-passport.mjs --entity "saturn return" --dry-run
```

期望输出：
- Phase 1 抓 5 源（部分可能 404，warn 但不阻断）
- console 打印 Claude prompt + cache 路径
- 总耗时 < 60s
- 总成本 = $0（不调付费 API）

W1 Mon AM 跑完 Phase 2 后 Sheets `entity_passports` 表应有 1 行；`status=ok` 表示 5 源 + 5 angle 全齐。

---

## §11 与 RACI v1 的链接

| RACI 项 | 关联 |
|---------|------|
| §2 W1 Mon AM 行 | 本 spec 是该 30 min 行的工具实现 |
| §3 S-W1-1 行 | 本 spec 的输出（`entity_passport.json`）= S-W1-1 Output 列 |
| §3 S-W1-1 Sign-off 列 | "wzb LOOK 补第 6 源（v1.1）" = 本 spec §7 |
| §3 S-W1-1 Fallback 列 | "手抓" = wzb 在 Phase 2 ingest 里手填 sources/angles |
| §6 P1-1 | 本 spec 是 P1-1 中 `/gg-entity-passport` 实现指引 |

---

## §12 给 wzb 的 30 秒读法

- 你不用懂 §3-§5 的实现细节，那是给 Claude Code 看的
- 你要懂的就一句：**W1 Mon AM 你会看到 5 源摘要 + 5 角度待填**，30 秒决定要不要补第 6 源（人工拍 YouTube transcript 或 Scholar abstract）
- 5 源从哪来：Wikipedia + Astrodienst + Cafe Astrology + Chani + Reddit（v1.1 起，原 Google Scholar 占位假源已删）
- 你的 30 秒：扫一眼摘要 → 若觉得够 → 直接进 Phase 2；若觉得缺角度 → 手补 1 个 URL（粘到 ingest JSON 的 `sources[5]`）
