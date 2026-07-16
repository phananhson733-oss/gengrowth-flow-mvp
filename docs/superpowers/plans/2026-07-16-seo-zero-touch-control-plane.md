---
title: SEO Zero-touch Control Plane Implementation Plan
date: 2026-07-16
updated: 2026-07-16
type: plan
version: v1.0
status: final
owner: wzb
tags:
  - seo
  - zero-touch
  - repair-controller
  - tdd
aliases:
  - SEO 零人值守控制面实施计划
---

# SEO Zero-touch Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 SEO 失败在生产者边界可靠入队、全局去重并按硬预算收敛，再由独立 reconciler 自动完成回填和终态汇总。

**Architecture:** 原始 observation 保持 append-only，controller 在 per-incident 锁内折叠为唯一 active generation。AstrologyWiki 与 Gengrowth 的失败生产者立即 enqueue + bounded drain；`com.gengrowth.seo-reconcile` 只消费 repair/writeback/run-state，不启动 nightly 或创建新内容。

**Tech Stack:** Node.js ESM、`node:test`、Bash、macOS launchd、JSON durable state、现有 repair adapters/backfill/reconcile 工具。

## Global Constraints

- `com.gengrowth.seo-blog` 是唯一能启动 AstrologyWiki nightly 的调度器；reconciler 绝不调用 nightly、author、scan 或创建新 claim。
- 18:30–22:00 才允许 reconciler 执行定向 repair/regate/publish；发布窗外只允许 writeback、lease、run-state 与只读 readiness 收敛。
- 不删除 queue、claim、WAL 或历史事件；重复记录只能追加 `superseded` transition。
- 新 fingerprint 不得因 stderr、日志长度、offset、runId、时间、PID 或 preview hostname 改变。
- 每个 `site + pageId` 同时最多一个 active generation；总自动尝试最多 3 次，Agent 变更最多 2 次。
- `human_only` 只接受已实际尝试的外部非委托证据；内部预算耗尽必须是 `quarantined`。
- 测试必须设置临时 `GG_FLOW_STATE_DIR`，禁止向生产 state 写入 `PG-TEST-*`。
- 不绕过事实、资产、链接、canonical、Article JSON-LD、CTA、同 SHA 或生产终态验证。

---

### Task 1: Stable Incident Identity, CAS Deduplication, and Compaction

**Files:**
- Modify: `tools/scripts/lib/seo-repair-events.mjs`
- Modify: `tools/scripts/gg-seo-repair-controller.mjs`
- Modify: `tools/scripts/__tests__/seo-repair-events.smoke.test.mjs`
- Modify: `tools/scripts/__tests__/seo-repair-controller-e2e.smoke.test.mjs`

**Interfaces:**
- Produces: `repairIncidentId(event): string`
- Produces: `repairEventFingerprint(event): string`
- Produces: `compactRepairIncident({ queueDir, site, pageId, hold, verificationCredit }): Promise<object>`
- CLI: `node tools/scripts/gg-seo-repair-controller.mjs compact --site <site> --page-id <PID> [--verification-credit 1]`

- [ ] **Step 1: Write RED identity and concurrency tests**

Add tests that use real queue files and a shared temporary directory:

```js
test('growing cumulative stderr remains one active incident', async (t) => {
  const queueDir = await tempQueue(t);
  const first = baseEvent({ eventId: 'e1', stderr: 'authoring failed\n' });
  const second = baseEvent({ eventId: 'e2', stderr: 'authoring failed\nnew unrelated tick output\n' });
  assert.equal(repairEventFingerprint(first), repairEventFingerprint(second));
  await enqueueRepairEvent(first, { queueDir });
  await enqueueRepairEvent(second, { queueDir });
  const active = (await listRepairRecords({ queueDir })).filter((r) => isActiveRepairStatus(r.status));
  assert.equal(active.length, 1);
  assert.equal(active[0].observations, 2);
  assert.deepEqual(active[0].sourceEventIds.sort(), ['e1', 'e2']);
});

test('concurrent producers create one active incident head', async (t) => {
  const queueDir = await tempQueue(t);
  await Promise.all(Array.from({ length: 8 }, (_, index) => enqueueRepairEvent(
    baseEvent({ eventId: `e${index}`, createdAt: new Date(Date.UTC(2026, 6, 16, 4, 0, index)).toISOString() }),
    { queueDir },
  )));
  const active = (await listRepairRecords({ queueDir })).filter((r) => isActiveRepairStatus(r.status));
  assert.equal(active.length, 1);
  assert.equal(active[0].observations, 8);
});

test('changed stable error supersedes the previous generation and preserves budget', async (t) => {
  const queueDir = await tempQueue(t);
  const old = await enqueueRepairEvent(baseEvent({ eventId: 'old', summary: 'missing draft' }), { queueDir });
  await transitionRepairEvent(old, { status: 'repair_pending', totalAttempts: 2 }, { queueDir });
  const next = await enqueueRepairEvent(baseEvent({ eventId: 'new', summary: 'fact gate failed' }), { queueDir });
  const records = await listRepairRecords({ queueDir });
  assert.equal(records.find((r) => r.event.eventId === 'old').status, 'superseded');
  assert.equal(next.generation, 2);
  assert.equal(next.totalAttempts, 2);
  assert.equal(records.filter((r) => isActiveRepairStatus(r.status)).length, 1);
});
```

- [ ] **Step 2: Run RED**

Run: `GG_FLOW_STATE_DIR=$(mktemp -d /tmp/seo-events-red.XXXXXX) node --test tools/scripts/__tests__/seo-repair-events.smoke.test.mjs tools/scripts/__tests__/seo-repair-controller-e2e.smoke.test.mjs`

Expected: FAIL because stderr still changes fingerprint, enqueue is not incident-atomic, and `superseded`/generation fields do not exist.

- [ ] **Step 3: Implement stable identity and per-incident lock**

Implement these semantics in `seo-repair-events.mjs`:

```js
export function repairIncidentId(value) {
  const event = validateRepairEvent(value);
  const owner = event.pageId === 'RUN' ? `${event.site}:${event.lane}:RUN` : `${event.site}:${event.pageId}`;
  return createHash('sha256').update(owner).digest('hex');
}

export function repairEventFingerprint(value) {
  const event = validateRepairEvent(value);
  const stable = normalizeRepairEvidence(event.summary);
  return createHash('sha256')
    .update(`${event.site}\n${event.pageId}\n${event.stage}\n${event.errorKind}\n${stable}`)
    .digest('hex');
}
```

Add `withIncidentLock(queueDir, incidentId, fn)` using an exclusive directory under `.incident-locks/`, owner metadata, bounded retry, dead-owner/expired-lease recovery, and `finally` cleanup. Execute the read/merge/supersede/write sequence inside this lock. Initial records include:

```js
{
  incidentId,
  generation: 1,
  budgetEpoch: 1,
  totalAttempts: 0,
  agentMutationAttempts: 0,
  sourceEventIds: [event.eventId],
  parentGenerationId: null,
}
```

When the active fingerprint changes, atomically transition the previous head to `superseded`, create generation `n + 1`, inherit `totalAttempts`, `agentMutationAttempts`, `budgetEpoch`, and set `parentGenerationId` to the prior event ID.

- [ ] **Step 4: Implement append-only compact CLI**

`compactRepairIncident` must gather every active source record for one incident, sum existing strategy attempts, retain every source event/fingerprint/history, write one `migration_hold` canonical record, then transition every source to `superseded` with `supersededBy`. Re-running compact with the same incident must return the existing canonical record without duplicating attempts or history.

The CLI must refuse missing `--site`/`--page-id`, print JSON, and never delete files.

- [ ] **Step 5: Run GREEN and commit**

Run the RED command again; expected all pass. Then run `git diff --check` and commit:

```bash
git add tools/scripts/lib/seo-repair-events.mjs tools/scripts/gg-seo-repair-controller.mjs tools/scripts/__tests__/seo-repair-events.smoke.test.mjs tools/scripts/__tests__/seo-repair-controller-e2e.smoke.test.mjs
git commit -m "fix(seo): make repair incidents stable and unique"
```

---

### Task 2: Global Repair Budget and Gengrowth Author-stage Recovery

**Files:**
- Modify: `tools/scripts/lib/seo-repair-controller.mjs`
- Modify: `tools/scripts/lib/seo-repair-events.mjs`
- Modify: `tools/scripts/lib/seo-repair-adapter-gengrowth.mjs`
- Modify: `tools/scripts/__tests__/seo-repair-controller.smoke.test.mjs`
- Modify: `tools/scripts/__tests__/seo-repair-adapters.smoke.test.mjs`

**Interfaces:**
- Controller terminal: `quarantined`
- Record fields: `totalAttempts`, `agentMutationAttempts`, `firstDetectedAt`, `windowCount`, `lastArtifactSha`, `noProgressCount`
- Adapter helper: `recoverGengrowthAuthoring(event, deps): Promise<{ target, evidence }>`

- [ ] **Step 1: Write RED budget and author-stage tests**

```js
test('third total attempt quarantines without another adapter call', async (t) => {
  const fixture = await controllerFixture(t, { totalAttempts: 2 });
  const out = await drainRepairQueue({ ...fixture.args, maxTotalAttempts: 3 });
  assert.equal(fixture.adapterCalls(), 1);
  assert.equal(out.terminals[0].terminal, 'quarantined');
  const rerun = await drainRepairQueue({ ...fixture.args, maxTotalAttempts: 3 });
  assert.equal(rerun.processed, 0);
  assert.equal(fixture.adapterCalls(), 1);
});

test('authoring repair does not require a publish-ready draft', async () => {
  const calls = [];
  const adapter = createGengrowthRepairAdapter({
    resolveTarget: async () => { throw new Error('must not resolve before author recovery'); },
    runCommand: async (argv) => { calls.push(argv); return fakeAuthorAndHandoff(argv); },
    resolveAuthoredTarget: async () => readyTarget('PG-SDS-004'),
    verifyTerminal: async () => ({ ok: true, terminal: 'published' }),
  });
  const result = await adapter.execute({ record: authoringRecord('PG-SDS-004'), strategy: 'deterministic_repair' });
  assert.deepEqual(calls.slice(0, 2).map((x) => x.slice(-3)), [
    ['--retry-author', '--task', 'PG-SDS-004'],
    ['--task', 'PG-SDS-004', '--limit', '1'],
  ]);
  assert.equal(result.terminal, 'published');
});
```

- [ ] **Step 2: Run RED**

Run: `GG_FLOW_STATE_DIR=$(mktemp -d /tmp/seo-budget-red.XXXXXX) node --test tools/scripts/__tests__/seo-repair-controller.smoke.test.mjs tools/scripts/__tests__/seo-repair-adapters.smoke.test.mjs`

Expected: FAIL because exhausted strategies return `repair_pending` forever and the adapter resolves a ready draft before considering stage.

- [ ] **Step 3: Implement total budget and terminal ownership**

At lease acquisition increment `totalAttempts` once. Strategies named `agent_content_asset_link`, `agent_diagnosis`, or `agent_code_environment` increment `agentMutationAttempts` only when they actually invoke the Agent. Before invoking an adapter:

```js
if (active.totalAttempts >= maxTotalAttempts
  || active.agentMutationAttempts >= maxAgentMutationAttempts
  || active.noProgressCount >= 2) {
  return transitionToQuarantined(active, {
    type: active.noProgressCount >= 2 ? 'no_progress' : 'repair_budget_exhausted',
  });
}
```

Add `quarantined` to accepted controller terminals and terminal notification ownership, but not to eligible statuses. Build its idempotency key as `quarantined:${incidentId}:${budgetEpoch}`.

- [ ] **Step 4: Implement scoped author/handoff recovery**

For `event.stage` or `event.lane` containing `author`, run only these allowed commands:

```js
['node', join(scriptsDir, 'gg-seo-autopilot.mjs'), '--retry-author', '--task', event.pageId]
['node', join(scriptsDir, 'gg-seo-autopilot.mjs'), '--author', '--task', event.pageId, '--limit', '1']
['node', join(scriptsDir, 'gg-gengrowth-author-handoff.mjs'), '--page-id', event.pageId]
```

Create `gg-gengrowth-author-handoff.mjs` by extracting the existing manifest-pass, draft-sane and byte-copy handoff rules from `gg-gengrowth-author-tick.sh`. It accepts exactly one `--page-id`, refuses paths, copies only `<PID>-en.md/.manifest.json` to `<PID>-<winner>-v8.*`, and outputs one JSON result. The author tick must call the same helper so production and repair cannot drift.

- [ ] **Step 5: Run GREEN and commit**

Run the RED command plus `node --test tools/scripts/__tests__/gg-gengrowth-author-handoff.smoke.test.mjs`. Expected all pass. Run `bash -n tools/scripts/gg-gengrowth-author-tick.sh`, `git diff --check`, then commit:

```bash
git add tools/scripts/lib/seo-repair-controller.mjs tools/scripts/lib/seo-repair-events.mjs tools/scripts/lib/seo-repair-adapter-gengrowth.mjs tools/scripts/gg-gengrowth-author-handoff.mjs tools/scripts/gg-gengrowth-author-tick.sh tools/scripts/__tests__/seo-repair-controller.smoke.test.mjs tools/scripts/__tests__/seo-repair-adapters.smoke.test.mjs tools/scripts/__tests__/gg-gengrowth-author-handoff.smoke.test.mjs
git commit -m "fix(seo): bound repairs and recover authoring targets"
```

---

### Task 3: Producer-side Durable Enqueue and Precise Import Windows

**Files:**
- Create: `tools/scripts/lib/seo-repair-producer.mjs`
- Create: `tools/scripts/__tests__/seo-repair-producer.smoke.test.mjs`
- Modify: `tools/scripts/gg-seo-autopilot.mjs`
- Modify: `tools/scripts/gg-gengrowth-author-tick.sh`
- Modify: `tools/scripts/gg-preview-gate.mjs`
- Modify: `tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs`

**Interfaces:**
- Produces: `persistRepairAndDrain({ event, queueDir, drain, strict }): Promise<object>`
- Produces: `eventFromClaim({ site, runId, pageId, claim, logFile, offsets }): object`

- [ ] **Step 1: Write RED producer durability tests**

```js
test('event is durable before bounded drain starts', async (t) => {
  const order = [];
  const queueDir = await tempQueue(t);
  await persistRepairAndDrain({
    event: baseEvent({ eventId: 'producer-e1' }),
    queueDir,
    enqueue: async (event, options) => { order.push('enqueue'); return enqueueRepairEvent(event, options); },
    drain: async () => { order.push('drain'); throw new Error('simulated SIGTERM boundary'); },
    strict: true,
  }).catch(() => {});
  assert.deepEqual(order, ['enqueue', 'drain']);
  assert.equal((await listRepairRecords({ queueDir })).length, 1);
});

test('v2 producer fails closed when event persistence fails', async () => {
  await assert.rejects(() => persistRepairAndDrain({
    event: baseEvent(), enqueue: async () => { throw new Error('read-only state'); }, drain: async () => {}, strict: true,
  }), /read-only state/);
});
```

Add a runner black-box test whose fake nightly writes a durable event and then kills its parent; after the process ends, assert the event file exists and a later controller drain consumes it without running fake nightly again.

- [ ] **Step 2: Run RED**

Run: `GG_FLOW_STATE_DIR=$(mktemp -d /tmp/seo-producer-red.XXXXXX) node --test tools/scripts/__tests__/seo-repair-producer.smoke.test.mjs tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs`

Expected: FAIL because the producer helper and SIGTERM recovery contract do not exist.

- [ ] **Step 3: Implement and wire producer helper**

`persistRepairAndDrain` must await atomic enqueue before attempting drain. `busy:true` is success because another controller owns the event; enqueue failure in v2 is thrown.

Convert `parkAuthor` and `doMarkFailed` to async tails: write claim under the existing claims lock, release the lock, then await producer enqueue/drain. Update the top-level dispatcher to `await doAuthor(o)` and `await doMarkFailed(o)`. Do not hold `CLAIMS_LOCK` while controller executes.

`gg-preview-gate.mjs` continues to call `--mark-failed`; that command now owns durable enqueue. A controller-recursive regate sees `busy:true` and returns without consuming another attempt.

- [ ] **Step 4: Replace offset 0 with one precise fire window**

In `gg-gengrowth-author-tick.sh`, capture `RUN_ID` and `LOG_OFFSET_START` after loading env and before item work. Remove every per-error import call. At one `EXIT`/normal finalizer call:

```bash
node "$SCRIPT_DIR/gg-seo-repair-controller.mjs" import-v1 --site gengrowth \
  --claims "$CLAIMS" --plan "$PLAN" --log-file "$LOG" --log-offset "$LOG_OFFSET_START" \
  --run-id "$RUN_ID" --run-exit "$RUN_RC" --max-targets "${GG_SEO_REPAIR_MAX_TARGETS:-2}" \
  --budget-seconds "${GG_SEO_REPAIR_BUDGET_SECONDS:-900}"
```

`import-v1` must accept explicit `--run-id`, import only the provided site plan IDs, and ignore unchanged legacy claims already represented by an active incident.

- [ ] **Step 5: Run GREEN and commit**

Run the RED command, `node --test tools/scripts/__tests__/gengrowth-invariants.smoke.test.mjs`, and `bash -n tools/scripts/gg-gengrowth-author-tick.sh`. Expected all pass. Commit:

```bash
git add tools/scripts/lib/seo-repair-producer.mjs tools/scripts/__tests__/seo-repair-producer.smoke.test.mjs tools/scripts/gg-seo-autopilot.mjs tools/scripts/gg-gengrowth-author-tick.sh tools/scripts/gg-preview-gate.mjs tools/scripts/gg-seo-repair-controller.mjs tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs tools/scripts/__tests__/gengrowth-invariants.smoke.test.mjs
git commit -m "fix(seo): persist failures at producer boundaries"
```

---

### Task 4: Site-scoped Terminal Summary

**Files:**
- Modify: `tools/scripts/gg-batch-summary.mjs`
- Modify: `tools/scripts/gg-nightly-seo.sh`
- Modify: `tools/scripts/gg-seo-blog-launchd-tick.sh`
- Modify: `tools/scripts/__tests__/gg-batch-summary.smoke.test.mjs`
- Modify: `tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs`

**Interfaces:**
- CLI adds: `--plan <absolute-plan>` and `--run-id <runId>`
- Summary idempotency key: `batch-terminal:<runId>`

- [ ] **Step 1: Write RED mixed-ledger and ordering tests**

Create a fixture with AstrologyWiki `PG-CELEB-058` and Gengrowth `PG-SDS-004` in one claims file. Run `--site astrologywiki --plan <W22 fixture> --run-id run-1 --dry-run`; assert output contains only `PG-CELEB-058`. Add a runner test asserting summary occurs after `controller drain` and `ledger reconcile`, never inside nightly.

- [ ] **Step 2: Run RED**

Run: `GG_FLOW_STATE_DIR=$(mktemp -d /tmp/seo-summary-red.XXXXXX) node --test tools/scripts/__tests__/gg-batch-summary.smoke.test.mjs tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs`

Expected: mixed Gengrowth claim appears in AstrologyWiki parked output and nightly still owns summary.

- [ ] **Step 3: Implement plan/run filtering and final-only ownership**

Parse allowed page IDs from `--plan`. For legacy claims without `site`, accept only page IDs in the selected plan; claims with explicit mismatched `site` are always excluded. Filter terminal controller records by `site + runId` when available. Pass `--msgUuid` derived from `batch-terminal:<runId>` to notification so repeated finalizer ticks do not duplicate.

Remove the unconditional summary call from `gg-nightly-seo.sh`. Call summary once from the outer finalizer after controller and strict reconcile report terminal health.

- [ ] **Step 4: Run GREEN and commit**

Run the RED command and `bash -n tools/scripts/gg-nightly-seo.sh tools/scripts/gg-seo-blog-launchd-tick.sh`. Expected all pass. Commit:

```bash
git add tools/scripts/gg-batch-summary.mjs tools/scripts/gg-nightly-seo.sh tools/scripts/gg-seo-blog-launchd-tick.sh tools/scripts/__tests__/gg-batch-summary.smoke.test.mjs tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs
git commit -m "fix(seo): emit site-scoped terminal summaries"
```

---

### Task 5: Strict Reconcile, Readiness, and Recovery LaunchAgent

**Files:**
- Modify: `tools/scripts/gg-ledger-reconcile.mjs`
- Create: `tools/scripts/gg-seo-readiness.mjs`
- Create: `tools/scripts/gg-seo-reconcile-tick.sh`
- Create: `tools/launchd/com.gengrowth.seo-reconcile.plist`
- Create: `tools/scripts/__tests__/gg-ledger-reconcile.smoke.test.mjs`
- Create: `tools/scripts/__tests__/gg-seo-readiness.smoke.test.mjs`
- Create: `tools/scripts/__tests__/gg-seo-reconcile-tick.smoke.test.mjs`
- Modify: `tools/scripts/gg-seo-blog-launchd-tick.sh`
- Modify: `tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs`

**Interfaces:**
- Reconcile CLI: `--strict --json`
- Readiness CLI: `--site <site> --plan <path> --run-id <runId> --json`
- Recovery tick: writeback/readiness all day; controller drain only during 18:30–22:00.

- [ ] **Step 1: Write RED strict reconcile tests**

Use dependency injection or fixture CLI bins so no network is called:

```js
test('strict mode fails while writeback remains', async () => {
  const result = await runStrictFixture({ pendingAfter: 1, flipsAfter: 0, activeRepairAfter: 0 });
  assert.equal(result.status, 2);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.pendingWritebackAfter, 1);
});

test('stale zero cannot mask sheet drift', async () => {
  const result = await runReadinessFixture({ staleCount: 0, sheetFlipsAfter: 2 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /sheetFlipsAfter=2/);
});

test('production state rejects test-shaped sidecars', async () => {
  const result = await runReadinessFixture({ pendingIds: ['PG-TEST-001'] });
  assert.equal(result.status, 2);
  assert.deepEqual(result.json.testContamination, ['PG-TEST-001']);
});
```

- [ ] **Step 2: Write RED recovery scheduler tests**

Assert the reconciler never contains or executes `gg-nightly-seo.sh`, `--author`, or scan. At 23:00 it runs strict reconcile/readiness but does not drain content repair. At 19:00 it drains one eligible event, then reconciles. A live owner lock produces a clean busy result; a dead owner/expired lease is recovered within the same tick.

- [ ] **Step 3: Run RED**

Run: `GG_FLOW_STATE_DIR=$(mktemp -d /tmp/seo-reconcile-red.XXXXXX) node --test tools/scripts/__tests__/gg-ledger-reconcile.smoke.test.mjs tools/scripts/__tests__/gg-seo-readiness.smoke.test.mjs tools/scripts/__tests__/gg-seo-reconcile-tick.smoke.test.mjs tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs`

Expected: missing modules/tests and current reconcile exit-0 behavior fail the assertions.

- [ ] **Step 4: Implement machine-readable strict reconcile**

Refactor current main into `runLedgerReconcile({ apply, deps })` returning:

```js
{
  ok,
  pendingWritebackAfter,
  sheetFlipsAfter,
  planUncheckedAfter,
  activeRepairAfter,
  expiredLeasesAfter,
  eligibleNeedsHumanAfter,
  errors,
}
```

Legacy invocation keeps existing text/best-effort behavior. `--strict --json` runs apply, then a second read-only verification pass; any non-zero count or error exits 2.

- [ ] **Step 5: Implement readiness and recovery tick**

`gg-seo-readiness.mjs` combines strict reconcile JSON, queue inspection, claims scoped to site/plan, stale-report and test contamination. It exits 0 only when every required count is zero.

`gg-seo-reconcile-tick.sh` uses a PID/token/lease lock, sources `_gg.env`, calculates the local time, drains controller only inside 18:30–22:00, always runs strict reconcile/readiness, and never invokes a producer. The plist uses `RunAtLoad=true` and `StartInterval=300`, `ProcessType=Background`, and dedicated stdout/stderr logs.

Update the SEO runner to pre-drain/pre-reconcile, run nightly, post-import/drain, strict reconcile, readiness, then final summary. Its final exit code is readiness, not hook success alone.

- [ ] **Step 6: Run GREEN and commit**

Run the RED command, `bash -n tools/scripts/gg-seo-blog-launchd-tick.sh tools/scripts/gg-seo-reconcile-tick.sh`, and `plutil -lint tools/launchd/com.gengrowth.seo-reconcile.plist`. Expected all pass. Commit:

```bash
git add tools/scripts/gg-ledger-reconcile.mjs tools/scripts/gg-seo-readiness.mjs tools/scripts/gg-seo-reconcile-tick.sh tools/launchd/com.gengrowth.seo-reconcile.plist tools/scripts/gg-seo-blog-launchd-tick.sh tools/scripts/__tests__/gg-ledger-reconcile.smoke.test.mjs tools/scripts/__tests__/gg-seo-readiness.smoke.test.mjs tools/scripts/__tests__/gg-seo-reconcile-tick.smoke.test.mjs tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs
git commit -m "feat(seo): add strict zero-touch reconciliation"
```

---

### Task 6: Production Migration and Controlled Enablement

**Files:**
- Modify after code verification: `~/.config/gg/_gg.env`
- Install after code verification: `~/Library/LaunchAgents/com.gengrowth.seo-reconcile.plist`
- Runtime state only: flow-state repair queue and migration audit output

**Interfaces:**
- No source API changes; this task applies the verified control plane.

- [ ] **Step 1: Capture immutable preflight evidence**

Record branch/head/clean status, current env flags without secret values, loaded/disabled launchd labels, process/lock state, six PG-SDS-004 source hashes, claims, pending writeback count, reconcile dry output and exact production URLs.

- [ ] **Step 2: Run full hermetic regression before mutation**

Run every test touched by Tasks 1–5 with one explicit temporary `GG_FLOW_STATE_DIR`, then the repository full script suite. Require zero failures and confirm production queue/pending mtimes did not change.

- [ ] **Step 3: Pause ingest, compact PG-SDS-004, and verify hold**

Stop only the affected Gengrowth author/publish/controller fires after proving no active process owns them. Run compact once, then again to prove idempotency. Require: one `migration_hold` canonical incident, six superseded source records, source hashes unchanged, cumulative attempts 20, active eligible count 0, terminal notifications 0.

- [ ] **Step 4: Install and enable reconciler**

Copy the verified plist to `~/Library/LaunchAgents/`, bootstrap it, and verify `launchctl print` plus `print-disabled`. Preserve `com.gengrowth.seo-blog` as the only nightly starter and keep Codex Automation paused.

- [ ] **Step 5: Grant one PG-SDS-004 verification credit**

Release migration hold with exactly one rollout verification credit tied to the current code commit. Require the adapter to use scoped author/handoff, never top-level nightly, and process only PG-SDS-004.

- [ ] **Step 6: Verify controlled terminal state**

Run deterministic verifiers only after the controller returns. Require PG-SDS-004 either published with every terminal check true or quarantined with no further eligible attempts. Do not force publish or reset budget.

- [ ] **Step 7: Commit runtime documentation only if tracked files changed**

Do not commit secrets or runtime queue files. Record exact commands/results in the daily record and retain the goal for natural cron acceptance.
