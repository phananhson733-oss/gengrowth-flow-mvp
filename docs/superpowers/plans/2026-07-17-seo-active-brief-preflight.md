---
title: SEO Active Brief Preflight Implementation Plan
date: 2026-07-17
updated: 2026-07-17
type: plan
version: v1.0
status: review
owner: wzb
tags:
  - seo
  - zero-touch
  - topic-register
  - preflight
  - tdd
aliases:
  - SEO Active Brief Preflight 实现计划
---

# SEO Active Brief Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在每个 SEO fire 内先对 pinned plan 的 active existing briefs 做确定性、可证明且不扩张写入范围的语义修复，只有 preflight 成功才进入 nightly author / publish。

**Architecture:** `gg-topic-register.mjs` 增加严格的 `semantic-repair-only` 模式和机器可校验 proof；固定 wrapper 负责环境映射、锁忙强失败和结果文件；新的 `gg-seo-brief-preflight.mjs` 负责从 plan 提取 active IDs、调用 wrapper 并验证 proof；`gg-seo-blog-launchd-tick.sh` 在 legacy 检查后、任何 author / nightly 工作前 fail-closed 调用该 preflight。

**Tech Stack:** Bash 3.2、Node.js ESM、`node:test`、Google Sheets v4、现有 Topic Register 与 SEO LaunchAgent wrappers。

## Global Constraints

- 只处理 `astrologywiki` 当前 pinned W22 plan 的 unchecked existing page IDs。
- 禁止 generate mode、普通 incomplete-row audit、新 page ID、跨产品写入、LLM、evidence discovery 和中间通知。
- 只允许 `semantic-repair` 和零分 deterministic scaffold 的 `semantic-repair-new`；正确 brief 必须 no-op。
- `apply + llm=none` 例外只属于 `semantic-repair-only`；其他路径的 thin-brief guard 保持不变。
- lock busy、wrapper 非零、proof 缺失/损坏/越界或无法安全修复时，必须在 nightly 之前失败。
- 锁忙时不抢锁、不删活锁；由下一次自然 30 分钟 SEO cron 重试。
- 不降低 preview、Phase 2、三维 review、fact、publish 或 live verification gate。
- 不强制 publish，不手工改 Google Sheet，不使用普通文章 Google Indexing API。
- 不手工执行 `git add`、`git commit` 或 `git push`；等待 Obsidian watcher 自动提交，并验证 `HEAD == origin/main`。
- 最终完成标准不是测试通过，而是剩余文章自然发布后连续 3 个自然 cron 窗口无人工介入、无 active repair、无 needs-human/writeback drift。

---

## File Map

### New files

- `tools/scripts/gg-seo-brief-preflight.mjs` — 提取 active plan IDs、以严格环境调用固定 Topic Register wrapper、验证 proof，并向 launcher 返回单一退出码。
- `tools/scripts/__tests__/gg-seo-brief-preflight.smoke.test.mjs` — hermetic fake-wrapper 测试，覆盖合法 apply/no-op、非零、损坏 proof、越界和写入扩张。

### Modified files

- `tools/scripts/gg-topic-register.mjs:115-127, 1870-2225, 2231-2312` — 增加 strict CLI contract、active-only 候选分类、no-op/unsafe 分支、写入限制和 proof schema。
- `tools/scripts/__tests__/gg-topic-register.smoke.test.mjs:180-365` — 增加 semantic-repair-only 的候选、no-op、unsafe、existing-row-only 和 proof 单元测试。
- `tools/scripts/gg-topic-register-tick.sh:11-34, 62-177, 194-267` — 增加 mode/require-run/result-file 环境映射；锁忙在强制模式返回非零；保存 Node JSON proof。
- `tools/scripts/__tests__/gg-topic-register-tick.smoke.test.mjs:11-91` — 增加 command mapping、结果文件和 strict lock tests，同时证明默认 quiet skip 不变。
- `tools/scripts/gg-seo-blog-launchd-tick.sh:27-70, 179-247` — 在 legacy 检查后调用 Active Brief preflight，失败时禁止 drain/nightly。
- `tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs:17-458` — 扩展 runner harness、顺序断言和 preflight fail-closed cases。
- `docs/superpowers/specs/2026-07-17-seo-brief-preflight-design.md` — 实现与回归完成后只把 frontmatter `status` 从 `review` 改为 `final`，正文保持不变。
- `docs/superpowers/plans/2026-07-17-seo-active-brief-preflight.md` — 实现完成后勾选步骤并把 frontmatter `status` 改为 `final`。

---

### Task 1: Topic Register `semantic-repair-only` 核心与 proof

**Files:**
- Modify: `tools/scripts/gg-topic-register.mjs:115-127`
- Modify: `tools/scripts/gg-topic-register.mjs:1870-2225`
- Modify: `tools/scripts/gg-topic-register.mjs:2231-2312`
- Test: `tools/scripts/__tests__/gg-topic-register.smoke.test.mjs:180-365`

**Interfaces:**
- Produces: `semanticRepairRequestFromArgs(args): string[] | null`
- Produces: `semanticMismatchDecision({ page, clusters }): { status, currentCluster, alternative }`
- Extends: `planRows(input)` with `semanticRepairOnly: boolean`
- Produces: `buildSemanticRepairProof({ requestedPageIds, summary }): SemanticRepairProof`
- Consumes: existing `findCandidateRows`, `scoreClusterKeyword`, `chooseClusterForKeyword`, `isDeterministicScaffoldPage`, `valuesBatchForPageRow` and `summarizeProductResult`.

The proof schema is exact:

```js
{
  mode: 'semantic-repair-only',
  status: 'applied' | 'noop',
  product: 'astrologywiki',
  requested_page_ids: string[],
  selected_page_ids: string[],
  changed_page_ids: string[],
  cluster_repairs: Array<{
    page_id: string,
    from: string,
    to: string,
    score: number,
    provenance: 'semantic-repair' | 'semantic-repair-new',
  }>,
  new_cluster_count: number,
  created_page_id_count: 0,
  cross_product_write_count: 0,
}
```

- [ ] **Step 1: Write failing strict-argument tests**

Import `semanticRepairRequestFromArgs` and add:

```js
test('semantic-repair-only accepts only bounded astrologywiki apply requests', () => {
  assert.deepEqual(semanticRepairRequestFromArgs({
    semantic_repair_only: true,
    product: 'astrologywiki',
    apply: true,
    no_notify: true,
    limit: '2',
    repair_page_ids: 'PG-WDIF-002,PG-WDIN-001',
  }), ['PG-WDIF-002', 'PG-WDIN-001']);

  const invalid = [
    { product: 'all', apply: true, no_notify: true, limit: '1', repair_page_ids: 'PG-WDIF-002' },
    { product: 'astrologywiki', no_notify: true, limit: '1', repair_page_ids: 'PG-WDIF-002' },
    { product: 'astrologywiki', apply: true, limit: '1', repair_page_ids: 'PG-WDIF-002' },
    { product: 'astrologywiki', apply: true, no_notify: true, llm: 'claude', limit: '1', repair_page_ids: 'PG-WDIF-002' },
    { product: 'astrologywiki', apply: true, no_notify: true, discover_evidence: true, limit: '1', repair_page_ids: 'PG-WDIF-002' },
    { product: 'astrologywiki', apply: true, no_notify: true, include_incomplete: true, limit: '1', repair_page_ids: 'PG-WDIF-002' },
    { product: 'astrologywiki', apply: true, no_notify: true, reassign_existing: true, limit: '1', repair_page_ids: 'PG-WDIF-002' },
    { product: 'astrologywiki', apply: true, no_notify: true, limit: '2', repair_page_ids: 'PG-WDIF-002' },
  ];
  for (const args of invalid) {
    assert.throws(
      () => semanticRepairRequestFromArgs({ semantic_repair_only: true, ...args }),
      /semantic-repair-only/,
    );
  }
});

test('semantic-repair-only accepts an empty zero-write target set', () => {
  assert.deepEqual(semanticRepairRequestFromArgs({
    semantic_repair_only: true,
    product: 'astrologywiki',
    apply: true,
    no_notify: true,
    limit: '0',
  }), []);
});
```

- [ ] **Step 2: Write failing candidate and no-op tests**

Use complete rows containing every `PAGE_REQUIRED_FIELDS` value and add:

```js
const correctPlan = planRows({
  profile: PRODUCT_PROFILES.astrologywiki,
  pagesRaw: [pageHeader, correctLoveLanguageRow],
  clustersRaw: [CLUSTER_FIELDS, loveLanguageClusterRow],
  limit: 1,
  repairPageIds: new Set(['PG-WDIF-002']),
  activePageIds: new Set(['PG-WDIF-002']),
  semanticRepairOnly: true,
});
assert.equal(correctPlan.selectionMode, 'semantic_repair_only');
assert.deepEqual(correctPlan.updates, []);
assert.deepEqual(correctPlan.promptWrites, []);

assert.throws(() => planRows({
  profile: PRODUCT_PROFILES.astrologywiki,
  pagesRaw: [pageHeader, unsafeWrongRow],
  clustersRaw: [CLUSTER_FIELDS, unrelatedClusterRow],
  limit: 1,
  repairPageIds: new Set(['PG-WDIF-002']),
  activePageIds: new Set(['PG-WDIF-002']),
  semanticRepairOnly: true,
}), /unsafe semantic mismatch.*PG-WDIF-002/i);

assert.throws(() => planRows({
  profile: PRODUCT_PROFILES.astrologywiki,
  pagesRaw: [pageHeader, correctLoveLanguageRow],
  clustersRaw: [CLUSTER_FIELDS, loveLanguageClusterRow],
  limit: 1,
  repairPageIds: new Set(['PG-UNKNOWN-999']),
  activePageIds: new Set(['PG-UNKNOWN-999']),
  semanticRepairOnly: true,
}), /missing existing page id.*PG-UNKNOWN-999/i);
```

`unsafeWrongRow` uses非 scaffold 的 `Friction`/`Logic`、零分错误 cluster，且没有得分至少 `0.55` 的 existing alternative，确保 failure 可重复。

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
node --test tools/scripts/__tests__/gg-topic-register.smoke.test.mjs
```

Expected: FAIL because the validator export and `semanticRepairOnly` branch do not exist.

- [ ] **Step 4: Add the strict CLI contract**

Add after `parseArgs`:

```js
export function semanticRepairRequestFromArgs(args = {}) {
  if (!args.semantic_repair_only) return null;
  const requested = [...csvSet(args.repair_page_ids)].sort();
  const limit = Number(args.limit);
  const forbidden = [
    'llm', 'discover_evidence', 'include_incomplete', 'repair_keywords',
    'reassign_existing', 'overwrite', 'taxonomy_only', 'allow_thin_brief',
  ].filter((field) => Boolean(args[field]));
  if (String(args.product || '') !== 'astrologywiki') {
    throw new Error('semantic-repair-only requires --product astrologywiki');
  }
  if (!args.apply) throw new Error('semantic-repair-only requires --apply');
  if (!args.no_notify) throw new Error('semantic-repair-only requires --no-notify');
  if (forbidden.length) throw new Error(`semantic-repair-only forbids: ${forbidden.join(', ')}`);
  if (!Number.isInteger(limit) || limit !== requested.length) {
    throw new Error(`semantic-repair-only requires --limit ${requested.length}`);
  }
  const invalid = requested.filter((pageId) => !/^PG-[A-Z0-9]+-\d+$/.test(pageId));
  if (invalid.length) throw new Error(`semantic-repair-only invalid page ids: ${invalid.join(', ')}`);
  return requested;
}
```

Call it in `main` immediately after `parseArgs`:

```js
const semanticRepairPageIds = semanticRepairRequestFromArgs(args);
```

Change only the thin-brief condition:

```js
if (args.apply && !args.llm && !args.allow_thin_brief && !args.semantic_repair_only) {
```

- [ ] **Step 5: Add active existing-row classification**

Add beside `isDeterministicScaffoldPage`:

```js
export function semanticMismatchDecision({ page, clusters }) {
  const pageId = String(page?.page_id || '').trim();
  const targetKeyword = String(page?.['Target Keyword'] || page?.['关键词'] || '').trim();
  const clusterId = String(page?.cluster_id || '').trim();
  if (!pageId || !targetKeyword || !clusterId) {
    return { status: 'unsafe', reason: 'missing page_id, target keyword, or cluster_id' };
  }
  const currentCluster = clusters.find((item) => item.cluster_id === clusterId);
  if (!currentCluster) return { status: 'unsafe', reason: `missing cluster ${clusterId}` };
  const currentScore = scoreClusterKeyword(targetKeyword, currentCluster);
  if (currentScore >= 0.3) return { status: 'correct', currentCluster, currentScore };
  const alternative = chooseClusterForKeyword(targetKeyword, clusters);
  if (alternative.kind === 'existing'
    && alternative.cluster_id !== clusterId
    && alternative.score >= 0.55) {
    return { status: 'repairable', currentCluster, currentScore, alternative };
  }
  if (alternative.kind === 'new'
    && currentScore === 0
    && isDeterministicScaffoldPage(page)) {
    return { status: 'repairable-new', currentCluster, currentScore, alternative };
  }
  return { status: 'unsafe', reason: `unsafe semantic mismatch from ${clusterId}` };
}
```

Extend `planRows` with `semanticRepairOnly = false`. Before normal candidate selection, use this complete branch:

```js
let selected;
if (semanticRepairOnly) {
  const requested = [...repairPageIds].sort();
  const counts = new Map();
  for (const page of pages) {
    const pageId = String(page.page_id || '').trim();
    if (pageId) counts.set(pageId, (counts.get(pageId) || 0) + 1);
  }
  const missing = requested.filter((pageId) => !counts.has(pageId));
  const duplicates = requested.filter((pageId) => counts.get(pageId) > 1);
  if (missing.length) throw new Error(`missing existing page id: ${missing.join(', ')}`);
  if (duplicates.length) throw new Error(`duplicate existing page id: ${duplicates.join(', ')}`);
  const repairable = new Set();
  for (const page of pages.filter((row) => repairPageIds.has(String(row.page_id || '').trim()))) {
    const decision = semanticMismatchDecision({ page, clusters });
    if (decision.status === 'unsafe') {
      throw new Error(`unsafe semantic mismatch for ${page.page_id}: ${decision.reason}`);
    }
    if (decision.status === 'repairable' || decision.status === 'repairable-new') {
      repairable.add(page.page_id);
    }
  }
  selected = {
    mode: 'semantic_repair_only',
    candidates: repairable.size
      ? findCandidateRows(pagesRaw, { onlyPageIds: repairable }).slice(0, limit || undefined)
      : [],
    audit_incomplete: 0,
  };
} else {
  selected = selectCandidateRowsForPlan(pagesRaw, {
    includeIncomplete,
    onlyPageIds: repairPageIds,
    onlyKeywords: repairKeywords,
    excludePageIds: completedPageIds,
    limit,
  });
}
```

Keep the automatic semantic branch inside `if (!semanticRepairOnly)`. Pass the boolean from `runProduct`, set returned `promptWrites` to `[]` in strict mode, and skip cache writes:

```js
const promptPaths = args.semantic_repair_only ? [] : writePromptFiles(profile, plan.promptWrites);
```

- [ ] **Step 6: Add proof and zero-target output**

Add `provenance: u.clusterDecision.kind` to each `cluster_repairs` item, then add:

```js
export function buildSemanticRepairProof({ requestedPageIds, summary }) {
  const requested = [...requestedPageIds].sort();
  const repairs = Array.isArray(summary?.cluster_repairs) ? summary.cluster_repairs : [];
  const selected = Array.isArray(summary?.page_ids) ? [...summary.page_ids].sort() : [];
  const newClusterCount = Number(summary?.new_clusters || 0);
  const newRepairCount = repairs.filter((row) => row.provenance === 'semantic-repair-new').length;
  if (newClusterCount !== newRepairCount) throw new Error('semantic-repair-only new cluster provenance mismatch');
  if (selected.some((pageId) => !requested.includes(pageId))) {
    throw new Error('semantic-repair-only selected page id outside request');
  }
  if (repairs.length !== selected.length) {
    throw new Error('semantic-repair-only changed pages require repair provenance');
  }
  return {
    mode: 'semantic-repair-only',
    status: selected.length ? 'applied' : 'noop',
    product: 'astrologywiki',
    requested_page_ids: requested,
    selected_page_ids: selected,
    changed_page_ids: selected,
    cluster_repairs: repairs,
    new_cluster_count: newClusterCount,
    created_page_id_count: 0,
    cross_product_write_count: 0,
  };
}
```

Before writer-SA validation, return this exact empty-request result:

```js
if (semanticRepairPageIds && semanticRepairPageIds.length === 0) {
  const summary = {
    product: 'astrologywiki', applied: false, candidates: 0, updates: 0,
    new_clusters: 0, page_ids: [], cluster_repairs: [],
    selection_mode: 'semantic_repair_only', preprocessor: [], evidence_discovery: [],
  };
  process.stdout.write(JSON.stringify({
    ok: true,
    dry_run: false,
    budget_exhausted: false,
    proof: buildSemanticRepairProof({ requestedPageIds: [], summary }),
    summaries: [summary],
  }, null, 2) + '\n');
  return 0;
}
```

For non-empty strict runs attach `proof` to the root result from the single astrologywiki summary. Update `--help` with `--semantic-repair-only` and its required flags.

- [ ] **Step 7: Add proof tests and verify GREEN**

```js
test('semantic proof proves only requested existing repairs', () => {
  const proof = buildSemanticRepairProof({
    requestedPageIds: ['PG-WDIF-002', 'PG-WDIN-001'],
    summary: {
      page_ids: ['PG-WDIF-002'],
      new_clusters: 1,
      cluster_repairs: [{
        page_id: 'PG-WDIF-002',
        from: 'why_do_i_feel_stuck_in_my_career',
        to: 'what_is_my_love_language',
        score: 0,
        provenance: 'semantic-repair-new',
      }],
    },
  });
  assert.equal(proof.status, 'applied');
  assert.deepEqual(proof.changed_page_ids, ['PG-WDIF-002']);
  assert.equal(proof.created_page_id_count, 0);
  assert.equal(proof.cross_product_write_count, 0);
});

test('semantic proof rejects expanded or unproven writes', () => {
  assert.throws(() => buildSemanticRepairProof({
    requestedPageIds: ['PG-WDIF-002'],
    summary: { page_ids: ['PG-OTHER-001'], new_clusters: 0, cluster_repairs: [] },
  }), /outside request/);
  assert.throws(() => buildSemanticRepairProof({
    requestedPageIds: ['PG-WDIF-002'],
    summary: {
      page_ids: ['PG-WDIF-002'],
      new_clusters: 1,
      cluster_repairs: [{ page_id: 'PG-WDIF-002', from: 'old', to: 'new', score: 0, provenance: 'semantic-repair' }],
    },
  }), /new cluster provenance mismatch/);
});
```

Run:

```bash
node --test tools/scripts/__tests__/gg-topic-register.smoke.test.mjs
node --check tools/scripts/gg-topic-register.mjs
```

Expected: all Topic Register tests pass and syntax exits 0.

- [ ] **Step 8: Wait for watcher checkpoint**

```bash
git status --short
git log -1 --format='%H %ad %s' --date=iso-strict
git rev-parse HEAD
git rev-parse origin/main
```

Expected: clean worktree and equal hashes. Do not stage or commit manually.
