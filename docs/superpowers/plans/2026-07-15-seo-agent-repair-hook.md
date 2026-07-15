---
title: SEO Agent Repair Hook Implementation Plan
date: 2026-07-15
updated: 2026-07-15
type: plan
version: v1.0
status: approved
owner: wzb
tags:
  - seo
  - agentic-repair
  - launchd
  - tdd
aliases:
  - SEO Repair Hook 实现计划
---

# SEO Agent Repair Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让唯一 macOS LaunchAgent 直接运行 SEO nightly，并且只在异常、报错或 eligible `needs_human` 时启动一次性 Codex Agent，最终用确定性证据验证 publish 与回填终态。

**Architecture:** `gg-seo-blog-launchd-tick.sh` 直跑 nightly，再调用一个无 LLM 的 selector/state CLI。selector 为空时结束；非空时由 hook 原子登记 attempt、调用一次性 `codex exec`、再由独立 verifier 判定 published/archived/human-only。运行态状态复用 vault 外 `flow-state`，Codex Automation 和旧 flow-driver scheduler 始终关闭。

**Tech Stack:** macOS launchd、Bash、Node.js ESM、`node:test`、现有 `gg-seo-autopilot`/preview gate/backfill/notify、Codex CLI。

## Global Constraints

- Codex Automation `gengrowth-seo-blog` 必须始终保持 `PAUSED`；不得恢复其 scheduler。
- `com.gengrowth.seo-blog` 是唯一 SEO 时间调度器；不得新增 repair plist/cron，不得加载 `com.gengrowth.flow-driver`。
- clean path 的 `codex exec` 调用数必须为 0；Codex binary 只在 selector 非空时检查。
- 默认 `maxTargets=2`、`maxAttempts=2`、`timeoutSeconds=2700`；首次真实灰度以环境覆盖 `maxTargets=1`。
- 同一错误指纹在 Agent spawn 前原子增加 attempt；状态不可写或不可解析时 fail closed。
- 任何修复必须重过 preview verify、三维 review、Codex fact gate；不得直接改 ledger 为 verified/done。
- 不使用普通文章 Google Indexing API，不无人值守点击 GSC Request Indexing，不覆盖用户 dirty worktree。
- 不读取或跨仓回退到 `ai-profile/lynne-soul.md`；不修改 gengrowth-wiki 内 Lynne 的真实个人档案。
- 生产启用必须在 hermetic fake E2E 和回归通过之后；测试阶段不触发真实文章发布。

---

## File Map

### New files

- `tools/scripts/lib/seo-repair-hook.mjs` — pure plan parser、error normalization/fingerprint、selector 和 state transition。
- `tools/scripts/__tests__/seo-repair-hook.smoke.test.mjs` — selector/fingerprint/cap/state unit tests。
- `tools/scripts/gg-seo-repair-verify.mjs` — published/live/backfill deterministic verifier CLI。
- `tools/scripts/__tests__/gg-seo-repair-verify.smoke.test.mjs` — verifier unit/CLI fixture tests。
- `tools/scripts/gg-seo-repair-hook.mjs` — read run window、persist attempt、invoke Codex、invoke verifier、emit terminal summary。
- `tools/scripts/prompts/gg-seo-repair-hook.txt` — one-shot Agent contract。
- `tools/scripts/__tests__/gg-seo-repair-hook.smoke.test.mjs` — fake Codex/fake verifier E2E。
- `tools/scripts/__tests__/project-instruction-scope.smoke.test.mjs` — flow project identity and no-Lynne-profile invariant。

### Modified files

- `tools/scripts/gg-seo-blog-launchd-tick.sh` — replace always-Codex path with direct nightly + conditional hook。
- `tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs` — static and hermetic runner coverage。
- `AGENTS.md` — correct project identity and remove Lynne soul hardwire。
- `~/.codex/automations/gengrowth-seo-blog/automation.toml` — via Automation update API remove stale scheduler/Lynne statements, preserve `PAUSED`。
- `~/.config/gg/_gg.env` — after verification enable hook and first-window `maxTargets=1` without changing secrets。

---

### Task 1: Pure Selector, Fingerprint, and Attempt State

**Files:**
- Create: `tools/scripts/lib/seo-repair-hook.mjs`
- Create: `tools/scripts/__tests__/seo-repair-hook.smoke.test.mjs`

**Interfaces:**
- Produces: `parseUncheckedPlanIds(planText): Set<string>`
- Produces: `normalizeRepairError(error): string`
- Produces: `repairFingerprint({ pageId, stage, error }): string`
- Produces: `selectRepairTargets(input): { targets, terminalUpdates }`
- Produces: `beginRepairAttempts(state, targets, nowIso): object`
- Consumes: existing `triagePark(claim)` from `tools/scripts/lib/park-classify.mjs`

- [x] **Step 1: Write selector/fingerprint failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUncheckedPlanIds,
  normalizeRepairError,
  repairFingerprint,
  selectRepairTargets,
  beginRepairAttempts,
} from '../lib/seo-repair-hook.mjs';

test('clean plan has no target and old eligible park is selected', () => {
  const planIds = parseUncheckedPlanIds('- [ ] `PG-A-001` alpha\n- [x] `PG-B-001` beta\n');
  assert.deepEqual(selectRepairTargets({ claims: {}, planIds, state: {}, archivedIds: new Set() }).targets, []);
  const out = selectRepairTargets({
    claims: { 'PG-A-001': { status: 'needs_human', stage: 'authoring', error: 'phase2 FAIL: drifted sections' } },
    planIds,
    state: {},
    archivedIds: new Set(),
  });
  assert.equal(out.targets.length, 1);
  assert.equal(out.targets[0].pageId, 'PG-A-001');
});

test('fingerprint removes runtime noise but changes for a real error change', () => {
  const a = repairFingerprint({ pageId: 'PG-A-001', stage: 'authoring', error: '2026-07-15 18:31 pid 123 /tmp/x preview-a.vercel.app timeout' });
  const b = repairFingerprint({ pageId: 'PG-A-001', stage: 'authoring', error: '2026-07-15 18:32 pid 999 /tmp/y preview-b.vercel.app timeout' });
  const c = repairFingerprint({ pageId: 'PG-A-001', stage: 'authoring', error: 'phase2 FAIL: missing H1' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('attempt cap and unfixable archive are terminal, spawn state is written first', () => {
  const claims = {
    'PG-A-001': { status: 'needs_human', stage: 'authoring', error: 'phase2 FAIL: drifted sections' },
    'PG-S-001': { status: 'needs_human', stage: 'pushed-preview', error: 'stale topic — do not publish' },
  };
  const planIds = new Set(Object.keys(claims));
  const first = selectRepairTargets({ claims, planIds, state: {}, archivedIds: new Set(), maxAttempts: 2 });
  assert.deepEqual(first.targets.map((x) => x.pageId), ['PG-A-001']);
  assert.equal(first.terminalUpdates[0].terminal, 'archived');
  const begun = beginRepairAttempts({}, first.targets, '2026-07-15T10:30:00.000Z');
  assert.equal(begun[first.targets[0].fingerprint].attempts, 1);
  assert.equal(begun[first.targets[0].fingerprint].status, 'inflight');
});
```

- [x] **Step 2: Run tests and verify RED**

Run: `node --test tools/scripts/__tests__/seo-repair-hook.smoke.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/seo-repair-hook.mjs`.

- [x] **Step 3: Implement pure selector/state**

```js
import { createHash } from 'node:crypto';
import { triagePark } from './park-classify.mjs';

export function parseUncheckedPlanIds(text) {
  return new Set([...String(text || '').matchAll(/^\s*-\s*\[ \]\s*`?(PG-[A-Z0-9]+-\d+)`?/gm)].map((m) => m[1]));
}

export function normalizeRepairError(value) {
  return String(value || '')
    .replace(/\b\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z?)?\b/g, '<time>')
    .replace(/\bpid\s+\d+\b/gi, 'pid <n>')
    .replace(/\/tmp\/[^\s]+/g, '/tmp/<path>')
    .replace(/(?:https:\/\/)?[a-z0-9.-]+\.vercel\.app/gi, '<preview>.vercel.app')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

export function repairFingerprint({ pageId = 'run', stage = 'run', error = '' }) {
  return createHash('sha256').update(`${pageId}\n${stage}\n${normalizeRepairError(error)}`).digest('hex');
}
```

Implement `selectRepairTargets` so it only considers unchecked plan IDs, maps `triagePark(...)=unfixable` to `terminalUpdates: archived`, skips archived/capped/inflight fingerprints, adds a synthetic `RUN` target for a non-empty `runError`, sorts by plan order, and slices to `maxTargets`. Implement `beginRepairAttempts` as a pure immutable update that writes `{ pageId, stage, error, attempts, status:'inflight', startedAt }` by fingerprint.

- [x] **Step 4: Run tests and verify GREEN**

Run: `node --test tools/scripts/__tests__/seo-repair-hook.smoke.test.mjs`

Expected: all selector/fingerprint/state tests pass.

- [x] **Step 5: Commit Task 1**

```bash
git add tools/scripts/lib/seo-repair-hook.mjs tools/scripts/__tests__/seo-repair-hook.smoke.test.mjs
git commit -m "feat(seo): add repair hook selector and attempt state"
```

---

### Task 2: Deterministic Terminal Verifier

**Files:**
- Create: `tools/scripts/gg-seo-repair-verify.mjs`
- Create: `tools/scripts/__tests__/gg-seo-repair-verify.smoke.test.mjs`

**Interfaces:**
- Produces: `verifyRepairTarget(target, deps): Promise<{ ok, terminal, checks, reason }>`
- CLI consumes: `--targets <json-file> --claims <ledger> --plan <plan-file> [--sheet-fixture <json-file>] --json`
- CLI outputs: `{ ok, results:[...] }` and exits 0 only when every target is published or archived.

- [x] **Step 1: Write failing verifier tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyRepairTarget } from '../gg-seo-repair-verify.mjs';

const target = { pageId: 'PG-A-001', slug: 'alpha', stage: 'authoring' };
const goodDeps = {
  claim: { status: 'done', slug: 'alpha', branch: 'seo/auto/a', mergedAt: '2026-07-15T10:00:00Z' },
  planText: '- [x] `PG-A-001` alpha\n',
  publishLogText: 'PG-A-001 alpha https://www.astrologywiki.com/en/wiki/alpha\n',
  sheetRow: { status: '已发布', published_url: 'https://www.astrologywiki.com/en/wiki/alpha' },
  pendingWriteback: null,
  fetchText: async (url) => url.endsWith('sitemap.xml')
    ? '<loc>https://www.astrologywiki.com/en/wiki/alpha</loc>'
    : '<link rel="canonical" href="https://www.astrologywiki.com/en/wiki/alpha"><script type="application/ld+json">{"@type":"Article"}</script>',
};

test('all deterministic checks pass', async () => {
  const r = await verifyRepairTarget(target, goodDeps);
  assert.equal(r.ok, true);
  assert.equal(r.terminal, 'published');
});

for (const missing of ['claim', 'planText', 'publishLogText', 'sheetRow', 'pendingWriteback', 'page', 'sitemap']) {
  test(`missing ${missing} never reports published`, async () => {
    const deps = { ...goodDeps };
    if (missing === 'claim') deps.claim = { status: 'needs_human' };
    if (missing === 'planText') deps.planText = '- [ ] `PG-A-001` alpha\n';
    if (missing === 'publishLogText') deps.publishLogText = '';
    if (missing === 'sheetRow') deps.sheetRow = { status: '待写', published_url: '' };
    if (missing === 'pendingWriteback') deps.pendingWriteback = { pageId: 'PG-A-001' };
    if (missing === 'page') deps.fetchText = async (url) => url.endsWith('sitemap.xml') ? '<loc>.../alpha</loc>' : '<html></html>';
    if (missing === 'sitemap') deps.fetchText = async (url) => url.endsWith('sitemap.xml') ? '<urlset></urlset>' : goodDeps.fetchText(url);
    assert.equal((await verifyRepairTarget(target, deps)).ok, false);
  });
}
```

- [x] **Step 2: Run tests and verify RED**

Run: `node --test tools/scripts/__tests__/gg-seo-repair-verify.smoke.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [x] **Step 3: Implement verifier and fixture-capable CLI**

The implementation must build named checks for `ledger_done`, `branch_and_merge`, `http_200`, `canonical`, `article_jsonld`, `sitemap`, `plan_checked`, `publish_log`, `sheet_published`, and `writeback_clear`. `fetchText` must use a 15-second `AbortSignal.timeout`; any exception becomes a failed check. Sheet production lookup must run `gg-sheet-pull.mjs --rows 2-1600 --limit 1700 --out <cache>` and match by page ID/target keyword; tests pass `--sheet-fixture` to avoid network.

```js
export async function verifyRepairTarget(target, deps) {
  const url = `https://www.astrologywiki.com/en/wiki/${target.slug}`;
  const checks = {};
  checks.ledger_done = deps.claim?.status === 'done';
  checks.branch_and_merge = Boolean(deps.claim?.branch && deps.claim?.mergedAt);
  let page = '', sitemap = '';
  try { page = await deps.fetchText(url); } catch {}
  try { sitemap = await deps.fetchText('https://www.astrologywiki.com/sitemap.xml'); } catch {}
  checks.http_200 = Boolean(page);
  checks.canonical = new RegExp(`<link[^>]+rel=["']canonical["'][^>]+href=["']${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i').test(page);
  checks.article_jsonld = /application\/ld\+json[\s\S]*"@type"\s*:\s*"Article"/i.test(page);
  checks.sitemap = sitemap.includes(url);
  checks.plan_checked = new RegExp(`^\\s*-\\s*\\[x\\]\\s*\`?${target.pageId}\`?`, 'm').test(deps.planText || '');
  checks.publish_log = String(deps.publishLogText || '').includes(target.pageId) && String(deps.publishLogText || '').includes(target.slug);
  checks.sheet_published = deps.sheetRow?.status === '已发布' && String(deps.sheetRow?.published_url || deps.sheetRow?.url || '').includes(target.slug);
  checks.writeback_clear = !deps.pendingWriteback;
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return { ok: failed.length === 0, terminal: failed.length ? 'pending' : 'published', checks, reason: failed.join(',') };
}
```

- [x] **Step 4: Run verifier tests and verify GREEN**

Run: `node --test tools/scripts/__tests__/gg-seo-repair-verify.smoke.test.mjs`

Expected: all verifier tests pass and no network is called.

- [x] **Step 5: Commit Task 2**

```bash
git add tools/scripts/gg-seo-repair-verify.mjs tools/scripts/__tests__/gg-seo-repair-verify.smoke.test.mjs
git commit -m "feat(seo): add deterministic repair terminal verifier"
```

---

### Task 3: One-Shot Codex Repair Hook

**Files:**
- Create: `tools/scripts/gg-seo-repair-hook.mjs`
- Create: `tools/scripts/prompts/gg-seo-repair-hook.txt`
- Create: `tools/scripts/__tests__/gg-seo-repair-hook.smoke.test.mjs`

**Interfaces:**
- CLI consumes: `--run-start <ISO> --run-exit <int> --log-file <path> --log-offset <bytes> --claims <path> --plan <path>`
- Environment: `GG_SEO_REPAIR_HOOK_ENABLED`, `GG_SEO_REPAIR_CODEX_BIN`, `GG_SEO_REPAIR_TIMEOUT_SECONDS`, `GG_SEO_REPAIR_MAX_TARGETS`, `GG_SEO_REPAIR_MAX_ATTEMPTS`, `GG_FLOW_STATE_DIR`, `GG_REPAIR_VERIFY_BIN`.
- Output: exactly one machine-readable terminal line prefixed `SEO_REPAIR_HOOK_RESULT: `.

- [x] **Step 1: Write fake-Codex failing E2E tests**

Build a temporary plan/ledger/state/log and fake executables. Assert these cases:

```js
test('clean state never invokes fake Codex', () => {
  const c = harness({ claims: {}, log: 'nightly-seo done', enabled: true });
  const r = c.run();
  assert.equal(r.status, 0);
  assert.equal(c.codexCalls(), 0);
});

test('eligible park persists attempt before invoking Codex and passes exact target only', () => {
  const c = harness({
    claims: { 'PG-A-001': { status: 'needs_human', stage: 'authoring', slug: 'alpha', error: 'phase2 FAIL: drifted sections' } },
    enabled: true,
  });
  const r = c.run();
  assert.equal(r.status, 0);
  assert.equal(c.codexCalls(), 1);
  assert.match(c.prompt(), /PG-A-001/);
  assert.doesNotMatch(c.prompt(), /PG-OTHER/);
  assert.equal(Object.values(c.state())[0].attempts, 1);
});

test('third identical fire is capped and never invokes Codex', () => {
  const c = harness({ claims: parkedClaim, stateAttempts: 2, enabled: true });
  c.run();
  assert.equal(c.codexCalls(), 0);
  assert.match(c.stdout(), /human_only/);
});
```

Also cover: disabled+target exits 2, corrupt/unwritable state exits 2 before spawn, run-level nonzero without claim produces one synthetic target, Agent timeout/nonzero consumes an attempt, and archived stale target does not invoke Codex.

- [x] **Step 2: Run tests and verify RED**

Run: `node --test tools/scripts/__tests__/gg-seo-repair-hook.smoke.test.mjs`

Expected: FAIL because hook CLI and prompt template do not exist.

- [x] **Step 3: Write the prompt contract**

`tools/scripts/prompts/gg-seo-repair-hook.txt` must say:

```text
You are the one-shot GenGrowth SEO exception repair agent. Process only TARGETS_JSON.
Do not run gg-nightly-seo.sh. Do not bypass preview verify, three-dimension review, Codex fact gate, or merge guards.
For authoring parks use the pinned plan with --retry-author/--author, then create a one-row targeted scan and run gg-preview-gate.
For preview parks use --retry-failed and rerun gg-preview-gate. For verified pending work continue merge/live/backfill only from the verified state.
Run the existing backfill loop and deterministic verifier. Never edit ledger status to verified-preview or done by hand.
Do not use Google Indexing API or click GSC Request Indexing. Do not load ai-profile/lynne-soul.md or any sibling-repo personal profile.
End only after each target is published+verified, explicitly archived as stale with evidence, or left needs_human with the exact non-bypassable blocker.
```

- [x] **Step 4: Implement hook CLI**

Implementation requirements:

1. Read only the log bytes after `--log-offset`; derive run error from nonzero exit or explicit `PARK|no passing en draft|no branch|gate parked|FAIL` lines.
2. Parse plan/claims, load archived IDs and `seo-repair-hook.json`, call `selectRepairTargets`.
3. Apply terminal archive/cap updates and atomically save state using same-directory temp + rename.
4. If no targets, emit `{ triggered:false, terminal:'clean' }` and exit 0.
5. If target exists but hook disabled/state unsafe/Codex missing, emit human-only infrastructure result and exit 2.
6. Call Codex via `gtimeout <seconds> <codex> exec --sandbox danger-full-access -C <flow> --add-dir <ops> --add-dir <oracle-baseline> -`, with prompt template plus JSON context on stdin.
7. Invoke `gg-seo-repair-verify.mjs` after Codex and update each state entry to `published`, `pending`, `archived`, or `human_only`; never trust Codex prose alone.
8. Emit one `SEO_REPAIR_HOOK_RESULT` JSON line and use existing `gg-notify.mjs raw` only for published/archived/human-only terminal summaries.

- [x] **Step 5: Run hook tests and verify GREEN**

Run: `node --test tools/scripts/__tests__/seo-repair-hook.smoke.test.mjs tools/scripts/__tests__/gg-seo-repair-verify.smoke.test.mjs tools/scripts/__tests__/gg-seo-repair-hook.smoke.test.mjs`

Expected: all tests pass; fake Codex count proves 0 on clean and 1 on eligible park.

- [x] **Step 6: Commit Task 3**

```bash
git add tools/scripts/gg-seo-repair-hook.mjs tools/scripts/prompts/gg-seo-repair-hook.txt tools/scripts/__tests__/gg-seo-repair-hook.smoke.test.mjs
git commit -m "feat(seo): invoke one-shot Codex only for repair targets"
```

---

### Task 4: Switch LaunchAgent Runner to Direct Nightly + Conditional Hook

**Files:**
- Modify: `tools/scripts/gg-seo-blog-launchd-tick.sh`
- Modify: `tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs`

**Interfaces:**
- Runner calls: `bash "$NIGHTLY"` then `node "$REPAIR_HOOK" --run-start ... --run-exit ... --log-file ... --log-offset ... --claims ... --plan ...`
- Test overrides: `GG_SEO_LAUNCHD_FLOW`, `GG_SEO_NIGHTLY_BIN`, `GG_SEO_REPAIR_HOOK_BIN`, `GG_SEO_NIGHTLY_LOG`, `GG_SEO_LAUNCHD_LOG`, `GG_SEO_LAUNCHD_ERR_LOG`, `GG_SEO_LAUNCHD_LOCK`, `GG_SEO_SKIP_LEGACY_CHECK`.

- [x] **Step 1: Replace old static expectation with failing clean/error runner tests**

The static test must assert no `automation.toml`, no `tomllib`, no unconditional `codex exec`, and direct nightly before hook. Hermetic tests use fake nightly/hook binaries:

```js
test('clean runner calls nightly then selector hook; neither runner nor fake hook calls Codex', () => {
  const h = runnerHarness({ nightlyExit: 0, hookExit: 0 });
  const r = h.run();
  assert.equal(r.status, 0);
  assert.deepEqual(h.events(), ['nightly', 'hook']);
  assert.equal(h.codexCalls(), 0);
});

test('nightly nonzero is passed to hook and hook terminal code owns final exit', () => {
  const h = runnerHarness({ nightlyExit: 7, hookExit: 0 });
  const r = h.run();
  assert.equal(r.status, 0);
  assert.match(h.hookArgs(), /--run-exit 7/);
});
```

- [x] **Step 2: Run runner test and verify RED**

Run: `node --test tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs`

Expected: FAIL because current runner reads Automation TOML and always invokes Codex.

- [x] **Step 3: Implement direct runner**

Remove `AUTOMATION` and Python/TOML prompt piping. Source `_gg.env` with `set -a` before reading hook flags, but preserve `GG_AUTOMATION_ORACLE_DIR`. Check Codex only inside the hook. Capture nightly log size before execution, retain `set +e` around nightly, then invoke hook even when nightly exits nonzero. Keep the existing outer lock and legacy executor conflict checks. If hook exits 0, runner exits 0; if hook exits nonzero, runner returns that code and logs both nightly/hook results.

- [x] **Step 4: Run shell/static tests and verify GREEN**

Run:

```bash
bash -n tools/scripts/gg-seo-blog-launchd-tick.sh
node --test tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs tools/scripts/__tests__/gg-seo-repair-hook.smoke.test.mjs
plutil -lint tools/launchd/com.gengrowth.seo-blog.plist
```

Expected: shell/plist valid and all tests pass.

- [x] **Step 5: Commit Task 4**

```bash
git add tools/scripts/gg-seo-blog-launchd-tick.sh tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs
git commit -m "fix(seo): run nightly directly and hook only on exceptions"
```

---

### Task 5: Remove Flow-Level Lynne Soul and Stale Scheduler Instructions

**Files:**
- Modify: `AGENTS.md`
- Create: `tools/scripts/__tests__/project-instruction-scope.smoke.test.mjs`
- Update externally through Automation API: `~/.codex/automations/gengrowth-seo-blog/automation.toml`

**Interfaces:**
- Invariant: flow project instructions contain no `lynne-soul` or cross-repo personal-profile fallback.
- Invariant: Automation status remains `PAUSED` and prompt no longer claims Codex Automation is the scheduler.

- [x] **Step 1: Write failing instruction-scope test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('flow AGENTS identifies Flow MVP and never requires Lynne personal soul', () => {
  const source = readFileSync('AGENTS.md', 'utf8');
  assert.match(source, /GenGrowth Flow MVP/);
  assert.doesNotMatch(source, /ai-profile\/lynne-soul\.md/i);
  assert.doesNotMatch(source, /所有者档案（Owner Profile）/);
});
```

- [x] **Step 2: Run test and verify RED**

Run: `node --test tools/scripts/__tests__/project-instruction-scope.smoke.test.mjs`

Expected: FAIL because AGENTS still says `GenGrowth Wiki` and requires `ai-profile/lynne-soul.md`.

- [x] **Step 3: Correct AGENTS with a precise patch**

Change project name to `GenGrowth Flow MVP`. Remove section 6’s personal soul source and replace it with a project-level statement that personal profiles from sibling repositories are not project instructions. Keep reminders, records, safety and all unrelated rules unchanged.

- [x] **Step 4: Update paused Automation through the Automation update API**

Read the current automation, update only its prompt to remove:

- `ai-profile/lynne-soul.md` read step;
- “Codex automation 是 SEO Blog 流程的唯一调度入口” claim;
- “主入口由 Agent 每 tick 启动 wrapper” wording.

Replace with: macOS `com.gengrowth.seo-blog` directly runs nightly; the Automation remains a paused reference and must not schedule. Preserve CTA intent rules and every safety boundary. Preserve `status = "PAUSED"`.

- [x] **Step 5: Verify instruction cleanup**

Run:

```bash
node --test tools/scripts/__tests__/project-instruction-scope.smoke.test.mjs
rg -n "lynne-soul|Codex automation 是 SEO Blog 流程的唯一调度入口" AGENTS.md ~/.codex/automations/gengrowth-seo-blog/automation.toml
rg -n '^status = "PAUSED"$' ~/.codex/automations/gengrowth-seo-blog/automation.toml
```

Expected: test passes; first `rg` has no matches; status check has exactly one match.

- [x] **Step 6: Commit repository-owned Task 5 files**

```bash
git add AGENTS.md tools/scripts/__tests__/project-instruction-scope.smoke.test.mjs
git commit -m "fix(project): remove Lynne profile from flow instructions"
```

---

### Task 6: Regression, Hermetic End-to-End, and Live Enablement

**Files:**
- Modify after tests: `~/.config/gg/_gg.env`
- Runtime evidence: `~/Library/LaunchAgents/com.gengrowth.seo-blog.plist`, launchctl state, flow-state, launchd logs.

**Interfaces:**
- Enable: `GG_SEO_REPAIR_HOOK_ENABLED=1`
- First real window: `GG_SEO_REPAIR_MAX_TARGETS=1`
- Rollback: set `GG_SEO_REPAIR_HOOK_ENABLED=0`; do not restore any other scheduler.

- [ ] **Step 1: Run targeted repair suite**

```bash
node --test \
  tools/scripts/__tests__/seo-repair-hook.smoke.test.mjs \
  tools/scripts/__tests__/gg-seo-repair-verify.smoke.test.mjs \
  tools/scripts/__tests__/gg-seo-repair-hook.smoke.test.mjs \
  tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs \
  tools/scripts/__tests__/flow-driver-plan.smoke.test.mjs \
  tools/scripts/__tests__/flow-driver-apply.smoke.test.mjs \
  tools/scripts/__tests__/flow-driver-tick.smoke.test.mjs \
  tools/scripts/__tests__/park-autoretry.smoke.test.mjs \
  tools/scripts/__tests__/gg-preview-gate.smoke.test.mjs
```

Expected: all targeted tests pass.

- [ ] **Step 2: Run CTA/backfill regression**

```bash
node --test \
  tools/scripts/__tests__/lib-cta-selector.smoke.test.mjs \
  tools/scripts/__tests__/gg-sheet-to-brief.smoke.test.mjs \
  tools/scripts/__tests__/gg-content-draft.smoke.test.mjs \
  tools/scripts/__tests__/flow-backfill.smoke.test.mjs \
  tools/scripts/__tests__/backfill-tx.smoke.test.mjs \
  tools/scripts/__tests__/gg-batch-summary.smoke.test.mjs
```

Expected: all selected tests pass; no Sheet write occurs because fixtures/env sandbox all external effects.

- [ ] **Step 3: Run full test suite and classify only pre-existing failures**

Run: `node --test tools/scripts/__tests__/*.test.mjs`

Expected: no new failure in changed or dependent modules. Any unrelated existing failure must be rerun individually and recorded with exact command/output before proceeding.

- [ ] **Step 4: Verify scheduler exclusivity and paused Automation**

```bash
crontab -l
launchctl print gui/$(id -u)/com.gengrowth.seo-blog
launchctl print-disabled gui/$(id -u) | rg 'seo-nightly|seo-author|seo-autopilot|seo-author-kicker|flow-driver|lane-watchdog|ledger-reconcile|index-monitor'
launchctl list | rg 'com.gengrowth.(seo-nightly|seo-author|seo-autopilot|seo-author-kicker|flow-driver|lane-watchdog|ledger-reconcile|index-monitor)' || true
rg -n '^status = "PAUSED"$' ~/.codex/automations/gengrowth-seo-blog/automation.toml
```

Expected: `com.gengrowth.seo-blog` loaded; old eight labels disabled/unloaded; Automation paused; no Unix crontab SEO entry.

- [ ] **Step 5: Enable hook with first-window cap**

Use a precise append/update that preserves all existing secret values:

```text
GG_SEO_REPAIR_HOOK_ENABLED=1
GG_SEO_REPAIR_MAX_TARGETS=1
GG_SEO_REPAIR_MAX_ATTEMPTS=2
GG_SEO_REPAIR_TIMEOUT_SECONDS=2700
```

Read back only these four keys. Do not print the whole environment file.

- [ ] **Step 6: Verify the natural launchd window**

After the next natural 18:30–21:30 trigger, isolate the exact `seo-blog launchd tick` window and prove one of:

- clean: nightly ran directly, `selector targets=0`, no `codex exec` repair PID/call;
- exception: selector identified exact target, one Agent attempt started, verifier produced published/archived/human-only terminal evidence.

Also confirm the launchd lock is gone, no orphan `codex exec`/nightly process remains, and `seo-repair-hook.json` matches the logged attempt/result.

- [ ] **Step 7: Final completion audit**

Check every numbered requirement in `docs/superpowers/specs/2026-07-15-seo-agent-repair-hook-design.md` against code, tests, runtime status and logs. Update spec frontmatter `status: final` only after all required evidence exists. Run `git diff --check`, append the terminal state to the daily record, and commit repository-owned final documentation without staging unrelated user changes.
