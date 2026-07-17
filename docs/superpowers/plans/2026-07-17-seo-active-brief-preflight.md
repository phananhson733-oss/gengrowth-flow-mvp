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

---

### Task 2: Fixed wrapper strict mode、锁语义与结果文件

**Files:**
- Modify: `tools/scripts/gg-topic-register-tick.sh:11-34`
- Modify: `tools/scripts/gg-topic-register-tick.sh:62-177`
- Modify: `tools/scripts/gg-topic-register-tick.sh:194-267`
- Test: `tools/scripts/__tests__/gg-topic-register-tick.smoke.test.mjs:11-91`

**Interfaces:**
- Consumes env: `GG_TOPIC_REGISTER_SEMANTIC_REPAIR_ONLY=1`
- Consumes env: `GG_TOPIC_REGISTER_REQUIRE_RUN=1`
- Consumes env: `GG_TOPIC_REGISTER_RESULT_FILE=/absolute/path/result.json`
- Produces command flag: `--semantic-repair-only`
- Produces result file: exact Node stdout JSON, or structured lock failure JSON
- Preserves: default lock skip exit 0 when `GG_TOPIC_REGISTER_REQUIRE_RUN` is unset.

- [ ] **Step 1: Write failing command and strict-lock tests**

Add:

```js
test('wrapper maps strict semantic repair to one bounded command', () => {
  const r = printCommand({
    GG_TOPIC_REGISTER_PRODUCTS: 'astrologywiki',
    GG_TOPIC_REGISTER_LIMIT: '2',
    GG_TOPIC_REGISTER_LLM: 'none',
    GG_TOPIC_REGISTER_DISCOVER_EVIDENCE: '0',
    GG_TOPIC_REGISTER_APPLY: '1',
    GG_TOPIC_REGISTER_NO_NOTIFY: '1',
    GG_TOPIC_REGISTER_REPAIR_PAGE_IDS: 'PG-WDIF-002,PG-WDIN-001',
    GG_TOPIC_REGISTER_SEMANTIC_REPAIR_ONLY: '1',
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /--product astrologywiki/);
  assert.match(r.stdout, /--limit 2/);
  assert.match(r.stdout, /--semantic-repair-only/);
  assert.match(r.stdout, /--apply/);
  assert.match(r.stdout, /--no-notify/);
  assert.match(r.stdout, /--repair-page-ids PG-WDIF-002,PG-WDIN-001/);
  assert.doesNotMatch(r.stdout, /--llm|--discover-evidence|--include-incomplete|--reassign-existing/);
});

test('require-run turns an active lock into structured rc 75', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gg-topic-register-strict-lock-'));
  const lock = join(tmp, 'lock');
  const logDir = join(tmp, 'logs');
  const resultFile = join(tmp, 'result.json');
  mkdirSync(lock);
  mkdirSync(logDir);
  writeFileSync(join(lock, 'pid'), String(process.pid));
  const r = spawnSync('bash', [wrapper], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GG_TOPIC_REGISTER_ENV_FILE: '/dev/null',
      GG_TOPIC_REGISTER_LOCK: lock,
      GG_TOPIC_REGISTER_LOG_DIR: logDir,
      GG_TOPIC_REGISTER_REQUIRE_RUN: '1',
      GG_TOPIC_REGISTER_RESULT_FILE: resultFile,
      GG_TOPIC_REGISTER_APPLY: '1',
      GG_TOPIC_REGISTER_LLM: 'none',
    },
  });
  assert.equal(r.status, 75, `${r.stdout}${r.stderr}`);
  assert.deepEqual(JSON.parse(readFileSync(resultFile, 'utf8')), {
    ok: false,
    skipped: true,
    reason: 'lock_active',
    active_pid: String(process.pid),
  });
});
```

Keep the existing default lock test unchanged: it must still assert exit 0 and `"skipped": true` in the log.

- [ ] **Step 2: Run wrapper tests and verify RED**

```bash
node --test tools/scripts/__tests__/gg-topic-register-tick.smoke.test.mjs
```

Expected: FAIL because the mode mapping and strict lock behavior do not exist.

- [ ] **Step 3: Map new environment without changing defaults**

Add these names to `OVERRIDE_NAMES` and derive them with the other settings:

```bash
SEMANTIC_REPAIR_ONLY="${GG_TOPIC_REGISTER_SEMANTIC_REPAIR_ONLY:-0}"
REQUIRE_RUN="${GG_TOPIC_REGISTER_REQUIRE_RUN:-0}"
RESULT_FILE="${GG_TOPIC_REGISTER_RESULT_FILE:-}"
```

Add inside `build_cmd`:

```bash
if [ "$SEMANTIC_REPAIR_ONLY" = "1" ]; then
  CMD+=(--semantic-repair-only)
fi
```

`LLM=none` and `DISCOVER_EVIDENCE=0` must continue to omit both Node flags.

- [ ] **Step 4: Emit one atomic result artifact**

Add before lock handling:

```bash
write_result() {
  local json="$1"
  if [ -n "$RESULT_FILE" ]; then
    mkdir -p "$(dirname "$RESULT_FILE")"
    local tmp_result="${RESULT_FILE}.tmp.$$"
    printf '%s\n' "$json" > "$tmp_result"
    mv "$tmp_result" "$RESULT_FILE"
  fi
}
```

Replace `log_skip_json` with:

```bash
log_skip_json() {
  local reason="$1"
  local active_pid="${2:-}"
  local ok="true"
  if [ "$REQUIRE_RUN" = "1" ]; then ok="false"; fi
  local json
  if [ -n "$active_pid" ]; then
    json="$(printf '{"ok":%s,"skipped":true,"reason":"%s","active_pid":"%s"}' "$ok" "$reason" "$active_pid")"
  else
    json="$(printf '{"ok":%s,"skipped":true,"reason":"%s"}' "$ok" "$reason")"
  fi
  printf '%s\n' "$json" >> "$LOG"
  write_result "$json"
}
```

For both `lock_active` and `lock_race`, use:

```bash
if [ "$REQUIRE_RUN" = "1" ]; then exit 75; fi
exit 0
```

Capture pure Node stdout while preserving stderr and the daily log:

```bash
RUN_OUTPUT="${RESULT_FILE:-${TMPDIR:-/tmp}/gg-topic-register-result.$$.json}"
RUN_OUTPUT_TEMP=0
if [ -z "$RESULT_FILE" ]; then RUN_OUTPUT_TEMP=1; fi
echo "$(date '+%F %T') command: $(print_cmd)" >> "$LOG"
if command -v gtimeout >/dev/null 2>&1; then
  gtimeout -k 30 "$TIMEOUT" "${CMD[@]}" > "$RUN_OUTPUT" 2>> "$LOG"
else
  "${CMD[@]}" > "$RUN_OUTPUT" 2>> "$LOG"
fi
rc=$?
if [ -f "$RUN_OUTPUT" ]; then cat "$RUN_OUTPUT" >> "$LOG"; fi
if [ "$RUN_OUTPUT_TEMP" = "1" ]; then rm -f "$RUN_OUTPUT"; fi
```

When `RESULT_FILE` is set, Node writes directly to it. Do not append wrapper status text to the result artifact. Preserve the existing `topic-register ok/failed/timeout` log lines and final exit code.

- [ ] **Step 5: Verify wrapper GREEN and syntax**

```bash
node --test tools/scripts/__tests__/gg-topic-register-tick.smoke.test.mjs
bash -n tools/scripts/gg-topic-register-tick.sh
```

Expected: all wrapper tests pass and syntax exits 0.

- [ ] **Step 6: Wait for watcher checkpoint**

```bash
git status --short
git rev-parse HEAD
git rev-parse origin/main
```

Expected: clean worktree and equal hashes after the watcher checkpoint.

---

### Task 3: Proof validator 与 SEO launcher fail-closed 接入

**Files:**
- Create: `tools/scripts/gg-seo-brief-preflight.mjs`
- Create: `tools/scripts/__tests__/gg-seo-brief-preflight.smoke.test.mjs`
- Modify: `tools/scripts/gg-seo-blog-launchd-tick.sh:27-70`
- Modify: `tools/scripts/gg-seo-blog-launchd-tick.sh:179-247`
- Modify: `tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs:17-458`

**Interfaces:**
- CLI: `node tools/scripts/gg-seo-brief-preflight.mjs --plan <absolute.md> --topic-register-wrapper <absolute.sh> --json`
- Produces stdout: validated `SemanticRepairProof` JSON only.
- Exit 0: valid proof, including empty-target no-op.
- Exit 1: wrapper execution, JSON parsing, schema or boundary failure.
- Launcher env override: `GG_SEO_BRIEF_PREFLIGHT_BIN`.
- Consumes: `GG_TOPIC_REGISTER_RESULT_FILE` from the fixed wrapper.

- [ ] **Step 1: Write failing validator and fake-wrapper E2E tests**

Create `gg-seo-brief-preflight.smoke.test.mjs` with a harness that writes a plan and an executable fake wrapper. The wrapper records its strict environment and writes the supplied JSON into `GG_TOPIC_REGISTER_RESULT_FILE`.

The success case:

```js
test('preflight derives active ids and calls the fixed wrapper with zero-touch bounds', () => {
  const h = harness({
    plan: '- [ ] `PG-WDIF-002` love language\n- [x] `PG-DONE-001` done\n- [ ] `PG-WDIN-001` intuition\n',
    result: validResult({
      requested: ['PG-WDIF-002', 'PG-WDIN-001'],
      changed: ['PG-WDIF-002'],
    }),
  });
  const run = h.run();
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.deepEqual(JSON.parse(run.stdout).changed_page_ids, ['PG-WDIF-002']);
  assert.deepEqual(h.env(), {
    products: 'astrologywiki',
    limit: '2',
    llm: 'none',
    discover: '0',
    apply: '1',
    notify: '1',
    targets: 'PG-WDIF-002,PG-WDIN-001',
    semantic: '1',
    requireRun: '1',
  });
});
```

`validResult` must emit root `{ ok:true, dry_run:false, budget_exhausted:false, proof, summaries:[] }` and the exact proof keys defined in Task 1.

Add table-driven exit-1 cases:

```js
for (const [name, mutate] of [
  ['malformed JSON', () => '{'],
  ['wrong mode', (value) => ({ ...value, proof: { ...value.proof, mode: 'generate' } })],
  ['wrong product', (value) => ({ ...value, proof: { ...value.proof, product: 'gengrowth' } })],
  ['request mismatch', (value) => ({ ...value, proof: { ...value.proof, requested_page_ids: ['PG-OTHER-001'] } })],
  ['selected outside active set', (value) => ({ ...value, proof: { ...value.proof, selected_page_ids: ['PG-OTHER-001'] } })],
  ['created page id', (value) => ({ ...value, proof: { ...value.proof, created_page_id_count: 1 } })],
  ['cross-product write', (value) => ({ ...value, proof: { ...value.proof, cross_product_write_count: 1 } })],
  ['skipped run', (value) => ({ ...value, proof: { ...value.proof, status: 'skipped' } })],
]) {
  test(`preflight rejects ${name}`, () => {
    const h = harness({ mutate });
    assert.equal(h.run().status, 1);
  });
}
```

Add separate cases for wrapper rc 75, missing result file, duplicate active IDs, wrong new-cluster provenance, and an empty plan producing a valid no-op without Sheet credentials.

- [ ] **Step 2: Run new tests and verify RED**

```bash
node --test tools/scripts/__tests__/gg-seo-brief-preflight.smoke.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `gg-seo-brief-preflight.mjs`.

- [ ] **Step 3: Implement exact proof validation**

Create `gg-seo-brief-preflight.mjs` with:

```js
#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, uncheckedTaskPageIds } from './gg-topic-register.mjs';

export function activePageIdsFromPlan(text) {
  return [...uncheckedTaskPageIds(text)].sort();
}

function sameArray(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

export function validateSemanticRepairProof(value, expectedPageIds) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.ok !== true) {
    throw new Error('topic-register result is not successful');
  }
  if (value.dry_run !== false || value.budget_exhausted !== false) {
    throw new Error('topic-register did not complete an apply run');
  }
  const proof = value.proof;
  const expectedKeys = [
    'mode', 'status', 'product', 'requested_page_ids', 'selected_page_ids',
    'changed_page_ids', 'cluster_repairs', 'new_cluster_count',
    'created_page_id_count', 'cross_product_write_count',
  ].sort();
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)
    || !sameArray(Object.keys(proof).sort(), expectedKeys)) {
    throw new Error('semantic repair proof schema mismatch');
  }
  if (proof.mode !== 'semantic-repair-only' || proof.product !== 'astrologywiki') {
    throw new Error('semantic repair proof mode or product mismatch');
  }
  if (!['applied', 'noop'].includes(proof.status)) throw new Error('semantic repair run was skipped');
  if (!sameArray(proof.requested_page_ids, expectedPageIds)) throw new Error('requested page ids mismatch');
  const expectedSet = new Set(expectedPageIds);
  for (const field of ['selected_page_ids', 'changed_page_ids']) {
    if (!Array.isArray(proof[field]) || proof[field].some((pageId) => !expectedSet.has(pageId))) {
      throw new Error(`${field} outside active set`);
    }
  }
  if (!sameArray(proof.selected_page_ids, proof.changed_page_ids)) {
    throw new Error('selected and changed page ids differ');
  }
  if (proof.created_page_id_count !== 0 || proof.cross_product_write_count !== 0) {
    throw new Error('semantic repair expanded write scope');
  }
  if (!Number.isInteger(proof.new_cluster_count) || proof.new_cluster_count < 0) {
    throw new Error('invalid new cluster count');
  }
  if (!Array.isArray(proof.cluster_repairs)
    || proof.cluster_repairs.length !== proof.changed_page_ids.length) {
    throw new Error('repair provenance count mismatch');
  }
  const repairIds = proof.cluster_repairs.map((row) => row.page_id).sort();
  if (!sameArray(repairIds, [...proof.changed_page_ids].sort())) {
    throw new Error('repair provenance page ids mismatch');
  }
  const newRepairs = proof.cluster_repairs.filter((row) => row.provenance === 'semantic-repair-new');
  if (proof.cluster_repairs.some((row) => !['semantic-repair', 'semantic-repair-new'].includes(row.provenance))
    || newRepairs.length !== proof.new_cluster_count) {
    throw new Error('new cluster provenance mismatch');
  }
  if ((proof.status === 'noop') !== (proof.changed_page_ids.length === 0)) {
    throw new Error('semantic repair status mismatch');
  }
  return proof;
}
```

- [ ] **Step 4: Implement wrapper orchestration and CLI**

Add:

```js
export function runBriefPreflight({ planPath, wrapperPath, spawn = spawnSync }) {
  const requested = activePageIdsFromPlan(readFileSync(planPath, 'utf8'));
  const work = mkdtempSync(join(tmpdir(), 'gg-seo-brief-preflight-'));
  const resultFile = join(work, 'topic-register-result.json');
  try {
    const run = spawn('bash', [wrapperPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GG_TOPIC_REGISTER_PRODUCTS: 'astrologywiki',
        GG_TOPIC_REGISTER_LIMIT: String(requested.length),
        GG_TOPIC_REGISTER_LLM: 'none',
        GG_TOPIC_REGISTER_DISCOVER_EVIDENCE: '0',
        GG_TOPIC_REGISTER_APPLY: '1',
        GG_TOPIC_REGISTER_NO_NOTIFY: '1',
        GG_TOPIC_REGISTER_REPAIR_PAGE_IDS: requested.join(','),
        GG_TOPIC_REGISTER_SEMANTIC_REPAIR_ONLY: '1',
        GG_TOPIC_REGISTER_REQUIRE_RUN: '1',
        GG_TOPIC_REGISTER_RESULT_FILE: resultFile,
      },
    });
    if (run.status !== 0) throw new Error(`topic-register wrapper failed rc=${run.status}`);
    const value = JSON.parse(readFileSync(resultFile, 'utf8'));
    return validateSemanticRepairProof(value, requested);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
```

The CLI resolves and requires `--plan` and `--topic-register-wrapper`, prints only the validated proof with `--json`, and returns 1 with one stderr reason on failure. It must not log inherited environment values or secrets.

- [ ] **Step 5: Verify validator GREEN**

```bash
node --test tools/scripts/__tests__/gg-seo-brief-preflight.smoke.test.mjs
node --check tools/scripts/gg-seo-brief-preflight.mjs
```

Expected: all proof and fake-wrapper E2E tests pass.

- [ ] **Step 6: Write launcher ordering and failure tests**

Extend `runnerHarness` with `briefPreflightExit = 0` and a fake helper that appends `brief-preflight` to `GG_TEST_EVENTS`, records argv, prints valid proof JSON, and exits with the configured code. Add `GG_SEO_BRIEF_PREFLIGHT_BIN` to direct and env-file wiring.

The clean sequence becomes:

```js
[
  'brief-preflight', 'drain', 'reconcile', 'notify', 'nightly', 'hook',
  'drain', 'reconcile', 'notify', 'readiness', 'summary',
]
```

Add:

```js
test('active brief preflight failure stops before drain and nightly', () => {
  const h = runnerHarness({ briefPreflightExit: 9 });
  const result = h.run();
  assert.equal(result.status, 9, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['brief-preflight']);
  assert.match(h.log(), /active brief preflight failed.*abort before nightly/i);
});
```

In the clean case assert `--plan` equals `h.plan` and `--topic-register-wrapper` equals the fixed wrapper. Keep explicit writeback notifications at exactly two, proving preflight adds none.

- [ ] **Step 7: Run launcher tests and verify RED**

```bash
node --test tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs
```

Expected: FAIL because the runner does not resolve or call the preflight.

- [ ] **Step 8: Integrate preflight before all nightly work**

Add binary paths:

```bash
BRIEF_PREFLIGHT="${GG_SEO_BRIEF_PREFLIGHT_BIN:-$FLOW/tools/scripts/gg-seo-brief-preflight.mjs}"
TOPIC_REGISTER="${GG_SEO_TOPIC_REGISTER_BIN:-$FLOW/tools/scripts/gg-topic-register-tick.sh}"
```

Add checks:

```bash
[[ -f "$BRIEF_PREFLIGHT" ]] || { echo "SEO brief preflight unavailable: $BRIEF_PREFLIGHT"; exit 1; }
[[ -x "$TOPIC_REGISTER" ]] || { echo "Topic Register wrapper unavailable: $TOPIC_REGISTER"; exit 1; }
```

Immediately after legacy checks and before `RUN_START`:

```bash
echo "running active brief semantic preflight"
set +e
GG_LARK_NOTIFY_SILENCE=1 node "$BRIEF_PREFLIGHT" \
  --plan "$PLAN" \
  --topic-register-wrapper "$TOPIC_REGISTER" \
  --json
BRIEF_PREFLIGHT_RC=$?
set -e
if [[ "$BRIEF_PREFLIGHT_RC" -ne 0 ]]; then
  echo "active brief preflight failed rc=$BRIEF_PREFLIGHT_RC; abort before nightly"
  exit "$BRIEF_PREFLIGHT_RC"
fi
echo "active brief preflight passed"
```

Do not flush writeback notifications on this failure path; preflight owns no writeback sidecars and already enforces no-notify.

- [ ] **Step 9: Verify launcher GREEN and syntax**

```bash
node --test tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs
bash -n tools/scripts/gg-seo-blog-launchd-tick.sh
```

Expected: clean sequence starts with preflight and every preflight failure ends before drain/nightly/hook.

- [ ] **Step 10: Wait for watcher checkpoint**

```bash
git status --short
git rev-parse HEAD
git rev-parse origin/main
```

Expected: clean worktree and equal hashes after the watcher checkpoint.
