---
title: DramaShortsTV SOP 全量整改实现计划
date: 2026-08-28
updated: 2026-08-28
type: plan
version: v1.0
status: approved
owner: wzb
tags:
  - dramashortstv
  - sop
  - remediation
aliases:
  - DramaShortsTV SOP Remediation Plan
  - DramaShortsTV 验收整改计划
---

# DramaShortsTV SOP 全量整改实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 2026-08-28 `review-agent` 验收发现的全部 3 项 P1 与 4 项 P2，使 DramaShortsTV lane 在首次真实 `--apply` 前具备真实搜证、审稿绑定、严格 SOP 结构和安全输入契约。

**Architecture:** 新增独立的 evidence contract/provider 两层：provider 只读取 DataForSEO、Apple Search 与 Reddit，contract 决定六类文章的必需来源并生成可哈希证据包。现有 CLI 在 Git 幂等短路后、LLM 生成前收集并校验证据，将同一证据包同时注入写作 prompt 与事实审；事实审输入采用内容寻址的不可变文件。Markdown QA 改为解析 heading 序列及链接/fence，而不是全文关键词命中。

**Tech Stack:** Node.js ESM、`node:test`、DataForSEO Google Organic/Google Trends Live API、Apple Search API、现有 Reddit OAuth helper、Git CLI。

## Global Constraints

- Google Sheet 永远只读，workbook 必须精确等于 `1-Qbv2MLRbiHDHdSi2csdatIVqxqCwkfcclkuGFN1dos`。
- SOP 仍由 `gengrowth-ops/inbox-maboyang/05-blog/dramashortstv/2026-08-26-dramashortstv-blog写作SOP-v1.0.md` 提供，不能由 Sheet 覆盖。
- 最终业务产物仍只有 `gengrowth-ops/inbox-maboyang/05-blog/dramashortstv/` 下的一份 Markdown；缓存只能写 `.gg-cache/sites/dramashortstv/<page_id>/`。
- 不生成 hero、图片、图片 prompt、发布历史，不写网站、Sheet、Supabase、Vercel、sitemap 或 indexing。
- 任一必需来源缺失、来源身份不明、provider 错误、证据过期或事实审非 PASS 都必须在 Ops 写入和 Git 之前 fail-closed。
- 事实审结论必须绑定 draft SHA-256 与 evidence SHA-256；并发运行不得共享可覆盖的审稿文件。
- 所有生产代码变更必须先有能稳定复现缺陷的失败测试，并完成 RED→GREEN。

---

### Task 1: 真实证据 provider 与六类 evidence contract

**Files:**
- Create: `tools/scripts/lib/dramashortstv-evidence-providers.mjs`
- Create: `tools/scripts/lib/dramashortstv-evidence.mjs`
- Create: `tools/scripts/__tests__/lib-dramashortstv-evidence-providers.smoke.test.mjs`
- Create: `tools/scripts/__tests__/lib-dramashortstv-evidence.smoke.test.mjs`

**Interfaces:**
- Consumes: normalized brief `{pageId, contentType, targetKeyword, entity}` and injected `fetchImpl` / `redditSearchImpl`.
- Produces: `collectDramaEvidence({ brief, providers, now })`, `validateDramaEvidence({ brief, evidence, now })`, `buildDramaEvidenceBlock(evidence)`, `sha256Text(value)`.
- Provider exports: `dataForSeoLive()`, `fetchGoogleSerpEvidence()`, `fetchGoogleTrendsEvidence()`, `fetchAppleAppEvidence()`, `fetchRedditEvidence()`.

- [ ] **Step 1: Write provider RED tests**

Add hermetic fixtures asserting DataForSEO HTTP/top-level/task failures reject, Google SERP keeps real URLs and query purpose, Trends preserves `check_url` and treats all-zero/missing data as `insufficient`, Apple results require relevant app-name tokens, and Reddit output drops author while sanitizing title/body.

- [ ] **Step 2: Verify provider tests fail for missing module**

Run:

```bash
node --test tools/scripts/__tests__/lib-dramashortstv-evidence-providers.smoke.test.mjs
```

Expected: FAIL because `dramashortstv-evidence-providers.mjs` does not exist.

- [ ] **Step 3: Implement provider adapters**

Use DataForSEO Basic Auth and double status validation:

```js
await dataForSeoLive({
  endpoint: 'serp/google/organic/live/advanced',
  tasks: querySpecs.map(({ query, purpose }) => ({
    keyword: query,
    location_code: 2840,
    language_code: 'en',
    depth: 10,
    tag: purpose,
  })),
  login,
  password,
  fetchImpl,
});
```

Trends must call `keywords_data/google_trends/explore/live` with `past_12_months` and `google_trends_graph`. Apple must call `https://itunes.apple.com/search` with `country=us&entity=software`; Reddit must use the existing site-wide `redditSearch()` and persist no username.

- [ ] **Step 4: Run provider tests GREEN**

Run the provider test command and require zero failures.

- [ ] **Step 5: Write evidence-contract RED tests**

Cover the exact source matrix:

```js
{
  'safety-guide': ['serp', 'app-store', 'friction'],
  'app-profile': ['serp', 'app-store', 'friction'],
  comparison: ['serp', 'app-store', 'friction'],
  'brand-playlist': ['serp', 'imdb', 'trends'],
  'actor-profile': ['serp', 'imdb', 'same-name'],
  'reader-bridge': ['serp', 'friction'],
}
```

Assert SERP requires at least five relevant organic results across three domains; friction accepts a real Reddit post or a Google result on Reddit/App Store; IMDb accepts only canonical `/name/nm…` or `/title/tt…` URLs; actor same-name search records pollution and qualifier requirement; evidence older than its TTL fails; prompt-injection text is sanitized.

- [ ] **Step 6: Verify evidence-contract tests RED**

Run:

```bash
node --test tools/scripts/__tests__/lib-dramashortstv-evidence.smoke.test.mjs
```

Expected: FAIL because the contract module does not exist.

- [ ] **Step 7: Implement evidence contract and immutable JSON block**

The returned object must use this stable shape:

```js
{
  schemaVersion: '1',
  pageId,
  entity,
  targetKeyword,
  collectedAt,
  sources: { serp, appStore, reddit, imdb, trends, sameName },
  coverage: { required, passed, blocked },
  sha256,
}
```

`sha256` is computed from canonical JSON excluding the `sha256` property. `buildDramaEvidenceBlock()` emits only sanitized fields and source IDs/URLs/snippets, explicitly marked as untrusted evidence.

- [ ] **Step 8: Run both evidence test files GREEN and commit**

```bash
node --test tools/scripts/__tests__/lib-dramashortstv-evidence-providers.smoke.test.mjs tools/scripts/__tests__/lib-dramashortstv-evidence.smoke.test.mjs
git add tools/scripts/lib/dramashortstv-evidence-providers.mjs tools/scripts/lib/dramashortstv-evidence.mjs tools/scripts/__tests__/lib-dramashortstv-evidence-providers.smoke.test.mjs tools/scripts/__tests__/lib-dramashortstv-evidence.smoke.test.mjs
git commit -m "feat(dramashortstv): add fail-closed evidence collection"
```

---

### Task 2: Evidence-aware orchestration、严格 selector 与不可变事实审

**Files:**
- Modify: `tools/scripts/gg-dramashortstv-doc.mjs`
- Modify: `tools/scripts/lib/dramashortstv-doc.mjs`
- Modify: `tools/scripts/__tests__/gg-dramashortstv-doc.smoke.test.mjs`
- Modify: `tools/scripts/__tests__/lib-dramashortstv-doc.smoke.test.mjs`

**Interfaces:**
- Consumes: Task 1 `collectDramaEvidence/validateDramaEvidence/buildDramaEvidenceBlock/sha256Text`.
- Produces: orchestration order `git-preflight → existing → SOP → research → evidence-QA → prompt → generate → draft-QA → factual-review → format → write → Git` and `realFactualReview({draft, brief, evidence})` returning both reviewed hashes.

- [ ] **Step 1: Write CLI/orchestration RED tests**

Add tests asserting:

```js
assert.throws(() => parseDramaArgs(['--workbook', DRAMA_WORKBOOK_ID, '--row', '4garbage']));
assert.throws(() => parseDramaArgs(['--workbook', DRAMA_WORKBOOK_ID, '--row', '4.9']));
```

Also assert page-id lookup omits `--rows 2-1000` and uses an effectively unbounded limit; research/evidence validation occurs before prompt/generation; evidence failure prevents SOP/LLM/Ops/Git; prompt and factual review receive the same evidence SHA; factual PASS with mismatched draft/evidence SHA is rejected.

- [ ] **Step 2: Verify orchestration tests RED**

```bash
node --test tools/scripts/__tests__/gg-dramashortstv-doc.smoke.test.mjs
```

Expected: failures for permissive row parsing, capped page-id lookup, absent research calls and absent hash binding.

- [ ] **Step 3: Implement strict selectors and evidence stage**

Validate the raw row token with `/^[0-9]+$/` before numeric conversion. For page-id lookup, let `gg-sheet-pull` fetch its native unbounded `A:AC` range and pass a limit above Google Sheets' maximum possible data rows; do not pass a bounded `--rows` slice.

Load secrets through the existing local env loader only inside apply-mode research. Dry-run must remain Sheet-only and must not call research, LLM, DataForSEO, Apple, Reddit, Ops writes or Git delivery.

- [ ] **Step 4: Implement content-addressed factual-review input**

Create the review input from the exact evidence block and draft, compute both hashes, and publish it once with `openSync(path, 'wx')`. The filename must contain both hashes; an existing path is accepted only when its bytes are identical. Re-read and hash the file immediately before invoking the reviewer, then require returned `reviewedDraftSha256` and `reviewedEvidenceSha256` to match the in-memory values before formatting or writing.

- [ ] **Step 5: Inject evidence into the authoring prompt**

Change `buildDramaPrompt({ brief, sopText, evidence })` so the evidence block is fenced as untrusted data, every factual statement must cite a supplied source ID through descriptive Markdown anchor text, and missing public facts must be stated as unavailable rather than inferred.

- [ ] **Step 6: Run orchestration/doc tests GREEN and commit**

```bash
node --test tools/scripts/__tests__/gg-dramashortstv-doc.smoke.test.mjs tools/scripts/__tests__/lib-dramashortstv-doc.smoke.test.mjs
git add tools/scripts/gg-dramashortstv-doc.mjs tools/scripts/lib/dramashortstv-doc.mjs tools/scripts/__tests__/gg-dramashortstv-doc.smoke.test.mjs tools/scripts/__tests__/lib-dramashortstv-doc.smoke.test.mjs
git commit -m "fix(dramashortstv): bind evidence and factual review"
```

---

### Task 3: 六类 heading 拓扑、Markdown fence 与链接红线

**Files:**
- Modify: `tools/scripts/lib/dramashortstv-doc.mjs`
- Modify: `tools/scripts/__tests__/lib-dramashortstv-doc.smoke.test.mjs`

**Interfaces:**
- Consumes: normalized brief, Task 1 evidence and generated Markdown.
- Produces: deterministic `validateDramaDraft()` errors for missing/misordered semantic headings, unmatched fences, naked URLs, generic link anchors and non-descriptive source citations.

- [ ] **Step 1: Write one RED test per review reproduction**

Add a Comparison draft that mentions `four question` and `competitor differentiation` only inside Notes and require failure. Add a correctly named but misordered section and require failure. Add drafts ending with an unmatched code fence, containing a naked `https://…`, `[here](…)` and `[click here](…)`; each must fail with a specific error.

- [ ] **Step 2: Add six content-type topology RED tests**

For each type, assert required semantic sections are headings and occur in SOP order:

- safety guide: direct answer → payment mechanism → per-app details → reader protection → data honesty;
- app profile: keyword coverage → question-led body → FAQ → verification checklist → honesty → SEO rationale;
- comparison: decision comparison → question-led body → four-question check → competitor differentiation → FAQ → verification/honesty/SEO notes;
- brand playlist: watch list/title entries → where-to-watch/internal-link destination;
- actor profile: Quick Facts → career background → ReelShort roles → watching entry → Content Team Notes;
- reader bridge: first-person opening → recommendations/reader destination.

- [ ] **Step 3: Verify QA tests RED**

```bash
node --test tools/scripts/__tests__/lib-dramashortstv-doc.smoke.test.mjs
```

Expected: all new negative cases currently return `ok: true` or existing valid fixtures lack enforced topology.

- [ ] **Step 4: Implement heading and Markdown parsers**

Parse only headings outside fenced code. Match semantic heading groups against heading text, require a complete ordered subsequence, and keep body-content checks separate for first-person voice and multiple title entries. Track fence state line by line and reject any unmatched or document-wrapping fence. Parse Markdown links outside code; reject generic anchors and any `http(s)` token not consumed by valid descriptive links.

- [ ] **Step 5: Run QA tests GREEN, then all DramaShortsTV tests**

```bash
node --test tools/scripts/__tests__/lib-dramashortstv-doc.smoke.test.mjs
node --test tools/scripts/__tests__/lib-dramashortstv-evidence-providers.smoke.test.mjs tools/scripts/__tests__/lib-dramashortstv-evidence.smoke.test.mjs tools/scripts/__tests__/lib-dramashortstv-doc.smoke.test.mjs tools/scripts/__tests__/lib-dramashortstv-git.smoke.test.mjs tools/scripts/__tests__/gg-dramashortstv-doc.smoke.test.mjs tools/scripts/__tests__/gg-sheet-to-brief.smoke.test.mjs tools/scripts/__tests__/lib-site-profile.smoke.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add tools/scripts/lib/dramashortstv-doc.mjs tools/scripts/__tests__/lib-dramashortstv-doc.smoke.test.mjs
git commit -m "fix(dramashortstv): enforce locked SOP structure"
```

---

### Task 4: 文档、完整验证与独立验收

**Files:**
- Modify: `tools/README.md`
- Test: all files under `tools/scripts/__tests__/`

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: operator-facing provider/credential/failure documentation and fresh verification evidence.

- [ ] **Step 1: Update operator documentation**

Document apply-mode provider requirements (`GG_DATAFORSEO_LOGIN`, `GG_DATAFORSEO_PASSWORD`; Reddit OAuth optional only when Google SERP already supplies a real friction source), evidence cache shape, fail-closed behavior, DataForSEO request count, dry-run's zero-network boundary and no hero/image/site-history boundary.

- [ ] **Step 2: Run static and focused verification**

```bash
git diff --check
node --check tools/scripts/gg-dramashortstv-doc.mjs
node --check tools/scripts/lib/dramashortstv-evidence-providers.mjs
node --check tools/scripts/lib/dramashortstv-evidence.mjs
node --check tools/scripts/lib/dramashortstv-doc.mjs
```

Run the combined focused command from Task 3 and require zero failures.

- [ ] **Step 3: Run the full repository test suite**

Run the same full `node --test` command used for the pre-change baseline. Compare exact pass/fail/skip counts against the known six baseline failures; no new failing test is acceptable.

- [ ] **Step 4: Run live read-only dry-runs**

```bash
node tools/scripts/gg-dramashortstv-doc.mjs --workbook 1-Qbv2MLRbiHDHdSi2csdatIVqxqCwkfcclkuGFN1dos --row 4 --json
node tools/scripts/gg-dramashortstv-doc.mjs --workbook 1-Qbv2MLRbiHDHdSi2csdatIVqxqCwkfcclkuGFN1dos --page-id page_dramabox_vs_reelshort --json
```

Require both to select the same Sheet row/path without LLM, network research, Ops or Git writes.

- [ ] **Step 5: Independent final review and remediation loop**

Review the entire branch diff against the seven findings, the authoritative SOP and Global Constraints. Any Critical or Important finding must be fixed with covering tests and re-reviewed before completion.

- [ ] **Step 6: Commit documentation**

```bash
git add tools/README.md docs/superpowers/plans/2026-08-28-dramashortstv-sop-remediation.md
git commit -m "docs(dramashortstv): document evidence-gated delivery"
```
