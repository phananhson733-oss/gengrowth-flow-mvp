---
title: SEO Universal Repair Controller Implementation Plan
date: 2026-07-15
updated: 2026-07-15
type: plan
version: v1.0
status: final
owner: wzb
tags:
  - seo
  - agentic-repair
  - tdd
  - launchd
aliases:
  - SEO Repair Controller 实施计划
  - SEO 全流程修复控制器实施计划
---

# SEO Universal Repair Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Every production-code task must use `superpowers:test-driven-development`; completion claims require `superpowers:verification-before-completion`.

**Goal:** 将 AstrologyWiki 与 Gengrowth 的 SEO 可修复异常统一送入 durable repair queue，由单一 controller 自动修复、重过 gate、发布、线上验证和回填；只有不可委托的外部动作才进入 `human_only`。

**Architecture:** 现有 launchd 与业务 wrapper 保持为正常链路和自然唤醒源。异常由 `seo-repair-events` 原子入队；`seo-repair-controller` 在全局单飞锁内按优先级、aging 与 lease 逐条处理；站点 adapter 只暴露白名单 canonical actions 与确定性 verifier。controller 是 `published`、`archived`、`human_only` 的唯一通知所有者。`GG_SEO_REPAIR_CONTROLLER_V2_ENABLED=1` 同时启用 v2 drain 和 legacy repairable 告警抑制。

**Tech Stack:** Node.js ESM、`node:test`、Bash、macOS launchd、现有 Codex CLI、AstrologyWiki preview/review/merge/backfill 工具、Gengrowth phase2/fact gate/Supabase publish 工具。

## Global Constraints

- 不新增 cron、LaunchAgent、轮询 supervisor 或第二 repair scheduler；只复用现有自然 wrapper 唤醒。
- Codex Automation `gengrowth-seo-blog` 保持 `PAUSED`。
- `GG_SEO_REPAIR_CONTROLLER_V2_ENABLED` 关闭时完整保留 v1 行为；开启时事件处理与 legacy repairable 告警抑制必须同时生效。
- controller 全局并发固定为 1；入队不依赖 controller lock。
- `maxTargets` 只限制单次 drain 数量；未执行事件保持 queued，不能变为 `human_only`。
- attempt cap 只触发策略升级或 backoff；不能单独构成 `human_only`。
- `human_only` 仅用于 OAuth 登录、验证码、人工审批、账号所有者授权、无权限且安全授权路径已失败，或缺少不可安全推断的权威来源。
- 内容、事实、结构、SVG/图片文字、内部链接、pipeline code、工具抖动、发布和回填都属于自动修复范围。
- 不绕过 preview/review/Codex gate、reviewed-head guard、CTA Map、Supabase/live verifier；不手工把 claim/plan 改成通过。
- pipeline code 修复只能发生在隔离 worktree/branch 中，先复现再修复，不修改活跃运行 checkout。
- 普通文章不调用 Google Indexing API，不无人值守点击 GSC Request Indexing。
- 事件文件不保存 secret；`canonicalRetry` 必须是 argv 数组并由 adapter 白名单校验。
- 不读取或跨仓回退到个人 soul/profile。

---

## File Map

### New files

- `tools/scripts/lib/seo-repair-events.mjs` — v2 schema、error normalization/fingerprint、原子 spool、去重、lease、priority aging。
- `tools/scripts/lib/seo-repair-controller.mjs` — taxonomy、策略状态机、单并发 drain、终态决策和幂等通知。
- `tools/scripts/lib/seo-repair-adapter-astrologywiki.mjs` — AstrologyWiki canonical action、Agent target 与终态 verifier。
- `tools/scripts/lib/seo-repair-adapter-gengrowth.mjs` — Gengrowth reviewer/publish/live/backfill action 与 verifier。
- `tools/scripts/gg-seo-repair-controller.mjs` — `enqueue`、`drain`、`import-v1`、`inspect` CLI 和全局锁。
- `tools/scripts/prompts/gg-seo-repair-controller.txt` — 站点无关的一次性目标修复契约。
- `tools/scripts/__tests__/seo-repair-events.smoke.test.mjs` — schema、spool、dedupe、lease、aging 单测。
- `tools/scripts/__tests__/seo-repair-controller.smoke.test.mjs` — taxonomy、策略升级、budget、terminal notify 单测。
- `tools/scripts/__tests__/seo-repair-controller-e2e.smoke.test.mjs` — fake Agent/gate/publish/backfill 双站 E2E。
- `tools/scripts/__tests__/seo-repair-adapters.smoke.test.mjs` — 双 adapter argv 白名单、target contract 和 verifier 单测。

### Modified files

- `tools/scripts/gg-seo-repair-hook.mjs` — 保留 v1 CLI 参数，v2 开启时转换成 event 并委托 controller。
- `tools/scripts/lib/seo-repair-hook.mjs` — 复用 normalize/triage；移除 v2 下 cap→human-only 语义。
- `tools/scripts/gg-seo-repair-verify.mjs` — 增加站点分派与 Gengrowth product verifier。
- `tools/scripts/gg-gengrowth-publish.mjs` — 保留 reviewer raw stderr；v2 下入队并抑制 repairable needs_human 告警。
- `tools/scripts/gg-gengrowth-publish-tick.sh` — publisher 后调用一次 controller drain；busy 时只保留队列。
- `tools/scripts/gg-gengrowth-author-tick.sh` — author/phase2/timeout 异常入队；v2 下不直接发 repairable 终态。
- `tools/scripts/gg-seo-autopilot.mjs` — `permanent` 只表达 no-blind-retry；v2 下入队而非“彻底停止”通知。
- `tools/scripts/gg-nightly-seo.sh` — AstrologyWiki 主链结束后调用 controller drain。
- `tools/scripts/gg-batch-summary.mjs` — v2 下 pending 显示为自动修复队列，不显示待人工。
- `tools/scripts/gg-seo-blog-launchd-tick.sh` — v2 下以 controller inspect/verifier 输出生成最终汇总。
- `tools/scripts/__tests__/gg-seo-repair-hook.smoke.test.mjs` — v1 shim 与 v2 delegation 回归。
- `tools/scripts/__tests__/gg-seo-repair-verify.smoke.test.mjs` — 两站 published/backfilled 证据矩阵。
- `tools/scripts/__tests__/gg-gengrowth-publish-notify.smoke.test.mjs` — v2 event/raw stderr/no direct notify 与 v1 fallback。
- `tools/scripts/__tests__/park-autoretry.smoke.test.mjs` — v2 no-blind-retry 不产生 permanent 人工告警。
- `tools/scripts/__tests__/gg-batch-summary.smoke.test.mjs` — v2 pending 文案与 legacy fallback。
- `tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs` — 自然唤醒、busy enqueue、无第二 scheduler。
- `tools/scripts/__tests__/lib-gg-notify.smoke.test.mjs` — controller terminal 幂等键和 legacy ownership invariant。
- `~/.config/gg/_gg.env` — 全部 hermetic/回归通过且旧运行锁释放后原子开启 v2。

---

### Task 1: Durable Event Spool, Fingerprint, Lease, and Fair Ordering

**Files:**
- Create: `tools/scripts/lib/seo-repair-events.mjs`
- Create: `tools/scripts/__tests__/seo-repair-events.smoke.test.mjs`

**Interfaces:**
- `validateRepairEvent(value): RepairEvent`
- `normalizeRepairEvidence(value): string`
- `repairEventFingerprint(event): string`
- `enqueueRepairEvent(event, { queueDir, now, randomUUID }): Promise<QueueRecord>`
- `listEligibleRepairEvents({ queueDir, now, agingMs }): Promise<QueueRecord[]>`
- `acquireRepairLease(record, { queueDir, owner, now, leaseMs }): Promise<QueueRecord | null>`
- `transitionRepairEvent(record, transition, { queueDir, now }): Promise<QueueRecord>`
- `recoverExpiredLeases({ queueDir, now }): Promise<number>`

- [ ] **Step 1: Write RED schema and atomic-spool tests**

```js
test('validates argv retry and bounds stderr without retaining secrets', () => {
  const event = validateRepairEvent({
    schemaVersion: 2,
    eventId: '11111111-1111-4111-8111-111111111111',
    runId: 'gengrowth-publish-20260715T213000',
    site: 'gengrowth', lane: 'publish', pageId: 'PG-WLS-007',
    slug: 'chatgpt-seo', stage: 'fact_gate', errorKind: 'tool_exit',
    summary: 'codex exited 3', stderr: 'stderr tail', logFile: '/tmp/fact.log',
    logOffsetStart: 10, logOffsetEnd: 90,
    canonicalRetry: ['node', 'tools/scripts/gg-codex-pr-review.mjs', '--source', '/tmp/article.md'],
    createdAt: '2026-07-15T13:30:00.000Z',
  });
  assert.deepEqual(event.canonicalRetry.slice(0, 2), ['node', 'tools/scripts/gg-codex-pr-review.mjs']);
  assert.throws(() => validateRepairEvent({ ...event, canonicalRetry: 'node reviewer.mjs' }), /argv array/);
});

test('same active fingerprint merges observations and writes one visible json record', async () => {
  const first = await enqueueRepairEvent(baseEvent, deps);
  const second = await enqueueRepairEvent({ ...baseEvent, eventId: nextUuid, createdAt: later }, deps);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(second.observations, 2);
  assert.equal((await readdir(queueDir)).filter((name) => name.endsWith('.json')).length, 1);
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tools/scripts/__tests__/seo-repair-events.smoke.test.mjs`

Expected: `ERR_MODULE_NOT_FOUND` for `lib/seo-repair-events.mjs`.

- [ ] **Step 3: Implement schema, atomic temp+rename, dedupe, quarantine, lease recovery, and aging**

Queue records use:

```js
{
  event,
  fingerprint,
  status: 'queued|repairing|regating|repair_pending|published|archived|human_only',
  observations: 1,
  strategy: 'deterministic_retry',
  strategyAttempts: {},
  nextEligibleAt: null,
  lease: null,
  parentFingerprints: [],
  terminalNotificationKey: null,
}
```

Priority score must use `baseWeight[lane] + floor(waitMs / agingMs)`, sort descending score and then ascending `event.createdAt`. `backfill=500`, `merge/live=400`, `publish/preview=300`, `author=200`, `run=100`.

- [ ] **Step 4: Run GREEN and deterministic repeat**

Run: `node --test tools/scripts/__tests__/seo-repair-events.smoke.test.mjs && node --test tools/scripts/__tests__/seo-repair-events.smoke.test.mjs`

Expected: both invocations pass; no temp files or live leases remain in fixture directories.

- [ ] **Step 5: Commit Task 1**

```bash
git add tools/scripts/lib/seo-repair-events.mjs tools/scripts/__tests__/seo-repair-events.smoke.test.mjs
git commit -m "feat(seo): add durable repair event spool"
```

---

### Task 2: Controller Taxonomy and Strategy State Machine

**Files:**
- Create: `tools/scripts/lib/seo-repair-controller.mjs`
- Create: `tools/scripts/__tests__/seo-repair-controller.smoke.test.mjs`

**Interfaces:**
- `classifyRepairEvent(event, evidence): RepairClass`
- `nextRepairStrategy(record, outcome): StrategyDecision`
- `isNondelegableEvidence(evidence): boolean`
- `drainRepairQueue(options): Promise<DrainSummary>`
- `terminalNotificationKey(record): string`

- [ ] **Step 1: Write RED taxonomy/cap/fairness/terminal tests**

```js
test('exit 3 is transient and a factual FAIL is agent_fixable', () => {
  assert.equal(classifyRepairEvent({ ...base, errorKind: 'tool_exit', summary: 'codex exited 3' }), 'transient');
  assert.equal(classifyRepairEvent({ ...base, errorKind: 'gate_fail', summary: 'SVG says Saturn Square occurs around age 14' }), 'agent_fixable');
});

test('attempt exhaustion escalates or backs off but never manufactures human_only', () => {
  const decision = nextRepairStrategy({ ...record, strategy: 'agent_content', strategyAttempts: { agent_content: 2 } }, { ok: false, evidence: 'same gate fail' });
  assert.equal(decision.status, 'repair_pending');
  assert.notEqual(decision.status, 'human_only');
  assert.equal(decision.strategy, 'agent_code_environment');
});

test('human_only requires a nondelegable external action with attempted safe path', () => {
  assert.equal(isNondelegableEvidence({ type: 'oauth_login', safeAuthorizationAttempted: true, stillBlocked: true }), true);
  assert.equal(isNondelegableEvidence({ type: 'tool_exit', attempts: 9 }), false);
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tools/scripts/__tests__/seo-repair-controller.smoke.test.mjs`

Expected: missing module or missing exported state-machine functions.

- [ ] **Step 3: Implement pure classification and strategy escalation**

Required strategy order:

```text
transient: deterministic_retry -> agent_diagnosis -> agent_code_environment -> repair_pending
deterministic_fixable: deterministic_repair -> agent_diagnosis -> agent_code_environment -> repair_pending
agent_fixable: agent_content_asset_link -> agent_code_environment -> repair_pending
nondelegable: safe_authorization_path -> human_only
unpublishable: archive_with_evidence -> archived
```

Each outcome persists exact evidence before the next transition. A changed fingerprint starts a child diagnosis generation but preserves `parentFingerprints` and cumulative observations.

- [ ] **Step 4: Implement single-concurrency drain with injected adapter/notify/clock**

`drainRepairQueue` must rescan after every target, stop only on `maxTargets` or total budget, release/expire leases safely, and notify only terminal states. A failed terminal notification records its idempotency key and hands payload to the existing notification outbox without re-running repair.

- [ ] **Step 5: Run GREEN**

Run: `node --test tools/scripts/__tests__/seo-repair-controller.smoke.test.mjs`

Expected: taxonomy, escalation, `maxTargets=1`, aging, crash recovery and terminal-notify tests all pass.

- [ ] **Step 6: Commit Task 2**

```bash
git add tools/scripts/lib/seo-repair-controller.mjs tools/scripts/__tests__/seo-repair-controller.smoke.test.mjs
git commit -m "feat(seo): add universal repair state machine"
```

---

### Task 3: Unified CLI, Global Lock, and v1 Compatibility Shim

**Files:**
- Create: `tools/scripts/gg-seo-repair-controller.mjs`
- Modify: `tools/scripts/gg-seo-repair-hook.mjs`
- Modify: `tools/scripts/lib/seo-repair-hook.mjs`
- Modify: `tools/scripts/__tests__/gg-seo-repair-hook.smoke.test.mjs`
- Create: `tools/scripts/__tests__/seo-repair-controller-e2e.smoke.test.mjs`

**CLI contract:**

```text
node tools/scripts/gg-seo-repair-controller.mjs enqueue --event-json <path>
node tools/scripts/gg-seo-repair-controller.mjs drain [--max-targets N] [--budget-seconds N]
node tools/scripts/gg-seo-repair-controller.mjs import-v1 --targets-json <path>
node tools/scripts/gg-seo-repair-controller.mjs inspect [--page-id PG-...]
```

- [ ] **Step 1: Write RED CLI and lock tests**

Cover: valid event enqueue; malformed event quarantined with exit 2; first drain owns `/tmp/gg-seo-repair-controller.lock`; concurrent drain exits 0 with `busy=true`; `maxTargets=1` leaves remaining records queued; v1 hook delegates only when the v2 flag is `1`; flag off retains v1 JSON/state semantics.

- [ ] **Step 2: Run RED**

Run: `node --test tools/scripts/__tests__/gg-seo-repair-hook.smoke.test.mjs tools/scripts/__tests__/seo-repair-controller-e2e.smoke.test.mjs`

Expected: unified CLI missing and v2 delegation assertions fail.

- [ ] **Step 3: Implement CLI and directory-lock lifecycle**

The CLI loads `~/.config/gg/_gg.env` through the existing env loader, defaults queue root to `~/gengrowth-agents/flow-state/seo-repair-queue`, and creates the controller lock with owner metadata. Stale ownership is reclaimed only after PID liveness plus lease expiry checks. Signal handlers persist current evidence and release only a lock owned by the current PID.

- [ ] **Step 4: Implement v1 shim without rewriting legacy behavior**

When v2 is enabled, convert every selected v1 target and run-level error into schema v2 events, enqueue them, call one drain, and return the controller summary. When disabled, execute the existing v1 code path byte-for-byte behaviorally.

- [ ] **Step 5: Run GREEN and syntax checks**

Run: `node --test tools/scripts/__tests__/gg-seo-repair-hook.smoke.test.mjs tools/scripts/__tests__/seo-repair-controller-e2e.smoke.test.mjs && node --check tools/scripts/gg-seo-repair-controller.mjs`

Expected: all pass and concurrent-drain fixture spawns exactly one fake Agent.

- [ ] **Step 6: Commit Task 3**

```bash
git add tools/scripts/gg-seo-repair-controller.mjs tools/scripts/gg-seo-repair-hook.mjs tools/scripts/lib/seo-repair-hook.mjs tools/scripts/__tests__/gg-seo-repair-hook.smoke.test.mjs tools/scripts/__tests__/seo-repair-controller-e2e.smoke.test.mjs
git commit -m "feat(seo): add unified repair controller cli"
```

---

### Task 4: Gengrowth Adapter and Raw Reviewer Evidence

**Files:**
- Create: `tools/scripts/lib/seo-repair-adapter-gengrowth.mjs`
- Create: `tools/scripts/__tests__/seo-repair-adapters.smoke.test.mjs`
- Modify: `tools/scripts/gg-gengrowth-publish.mjs`
- Modify: `tools/scripts/gg-seo-repair-verify.mjs`
- Modify: `tools/scripts/__tests__/gg-gengrowth-publish-notify.smoke.test.mjs`
- Modify: `tools/scripts/__tests__/gg-seo-repair-verify.smoke.test.mjs`

**Adapter contract:**
- `createGengrowthRepairAdapter(deps)` returns `{ recover, repair, regate, publish, verifyTerminal }`.
- The adapter may invoke only exact argv prefixes registered in `allowedActions`.
- Fact reviewer retry: `node tools/scripts/gg-codex-pr-review.mjs --source <absolute staging source>`.
- Publish retry: `node tools/scripts/gg-gengrowth-publish.mjs --apply --pages <pageId> --limit 1`.

- [ ] **Step 1: Write RED `PG-WLS-007` regression**

Fake reviewer exits 3 with stderr on the first call and returns `VERDICT: PASS` on the controller retry. Assert: event contains bounded raw stderr; direct publisher notify calls are zero under v2; controller invokes reviewer once and scoped publisher once; terminal verifier requires Supabase published row, production 200/canonical/Article JSON-LD/sitemap, W25 checked, Sheet URL/status, vault archive and no pending-writeback.

- [ ] **Step 2: Run RED**

Run: `node --test tools/scripts/__tests__/gg-gengrowth-publish-notify.smoke.test.mjs tools/scripts/__tests__/seo-repair-adapters.smoke.test.mjs tools/scripts/__tests__/gg-seo-repair-verify.smoke.test.mjs`

Expected: raw stderr/event assertions fail and Gengrowth adapter is missing.

- [ ] **Step 3: Preserve stderr and enqueue before legacy notification**

Change publisher review result passed to classification from `{ code, stdout, timedOut }` to `{ code, stdout, stderr, timedOut }`. Under v2, `SKIPPED/tool_exit`, fact FAIL, publish failure and writeback failure enqueue exact events and do not call `notify('fact_gate_fail', ...)`. Under v1, keep the current alert behavior.

- [ ] **Step 4: Implement Gengrowth canonical recovery and verifier**

The adapter resolves page data from manifest/W25 plan instead of accepting arbitrary paths, validates all argv, retries the reviewer, escalates a real FAIL to target Agent, and only publishes after reviewer PASS. `verifyTerminal` produces named checks and never trusts Agent stdout.

- [ ] **Step 5: Run GREEN**

Run: `node --test tools/scripts/__tests__/gg-gengrowth-publish-notify.smoke.test.mjs tools/scripts/__tests__/seo-repair-adapters.smoke.test.mjs tools/scripts/__tests__/gg-seo-repair-verify.smoke.test.mjs`

Expected: exit3 end-to-end fixture publishes and backfills; v1 fallback alert test still passes.

- [ ] **Step 6: Commit Task 4**

```bash
git add tools/scripts/lib/seo-repair-adapter-gengrowth.mjs tools/scripts/gg-gengrowth-publish.mjs tools/scripts/gg-seo-repair-verify.mjs tools/scripts/__tests__/seo-repair-adapters.smoke.test.mjs tools/scripts/__tests__/gg-gengrowth-publish-notify.smoke.test.mjs tools/scripts/__tests__/gg-seo-repair-verify.smoke.test.mjs
git commit -m "feat(seo): route gengrowth failures through repair controller"
```

---

### Task 5: AstrologyWiki Adapter for Assets, Links, Merge, and Backfill

**Files:**
- Create: `tools/scripts/lib/seo-repair-adapter-astrologywiki.mjs`
- Modify: `tools/scripts/__tests__/seo-repair-adapters.smoke.test.mjs`
- Modify: `tools/scripts/gg-seo-repair-verify.mjs`
- Modify: `tools/scripts/__tests__/gg-seo-repair-verify.smoke.test.mjs`

**Adapter contract:**
- `createAstrologyWikiRepairAdapter(deps)` returns `{ recover, repair, regate, publish, verifyTerminal }`.
- `buildAstrologyRepairTarget(event, context)` includes exact worktree, branch, claim, gate evidence, changed assets and verified-link candidates.
- `verifyInternalLinkCandidate(slug, deps)` requires repo route or sitemap membership plus production/preview 200.

- [ ] **Step 1: Write RED `PG-TRANS-016` asset and `PG-TRANS-018` link regressions**

For `PG-TRANS-016`, fixture body is factually correct but the SVG contains `Saturn Square — age 14`; assert target includes the SVG and the full changed diff is re-reviewed after repair. For `PG-TRANS-018`, fixture has three italicized intended links; assert only candidates passing route/sitemap/HTTP validation enter the Agent target and fabricated slugs are rejected.

- [ ] **Step 2: Run RED**

Run: `node --test tools/scripts/__tests__/seo-repair-adapters.smoke.test.mjs tools/scripts/__tests__/gg-seo-repair-verify.smoke.test.mjs`

Expected: AstrologyWiki adapter exports/asset/link assertions fail.

- [ ] **Step 3: Implement stage-specific canonical actions**

Map author/phase2 to scoped `--retry-author --task`; preview/review to scoped `--retry-failed --branch` and `gg-preview-gate.mjs`; merge/live/backfill to existing reviewed-head guard, merge, deployment wait, and `gg-backfill-one`. Adapter must refuse missing or dirty target worktrees and return `agent_code_environment` evidence instead of modifying the active checkout.

- [ ] **Step 4: Implement deterministic verified-link candidate generation**

Collect candidates from repo routes, sitemap and current production pages; normalize locale/canonical forms; require a positive verification signal; include anchor intent and source evidence in target JSON. No free-form Agent slug generation is accepted by `regate`.

- [ ] **Step 5: Run GREEN**

Run: `node --test tools/scripts/__tests__/seo-repair-adapters.smoke.test.mjs tools/scripts/__tests__/gg-seo-repair-verify.smoke.test.mjs`

Expected: both real-failure fixtures converge to published/backfilled and invalid link candidates fail closed.

- [ ] **Step 6: Commit Task 5**

```bash
git add tools/scripts/lib/seo-repair-adapter-astrologywiki.mjs tools/scripts/gg-seo-repair-verify.mjs tools/scripts/__tests__/seo-repair-adapters.smoke.test.mjs tools/scripts/__tests__/gg-seo-repair-verify.smoke.test.mjs
git commit -m "feat(seo): repair astrology assets and verified links"
```

---

### Task 6: Target Agent Contract and Isolated Code-Repair Path

**Files:**
- Create: `tools/scripts/prompts/gg-seo-repair-controller.txt`
- Modify: `tools/scripts/lib/seo-repair-controller.mjs`
- Modify: `tools/scripts/__tests__/seo-repair-controller-e2e.smoke.test.mjs`

- [ ] **Step 1: Write RED prompt/Agent invocation tests**

Assert the fake Agent receives exactly one target JSON containing event, authoritative log window, site context, allowed actions, asset files, verified-link candidates and terminal verifier command. Assert it never receives a top-level nightly command, secrets, personal profile path, gate-disable instruction, or permission to mutate claim status directly.

- [ ] **Step 2: Run RED**

Run: `node --test tools/scripts/__tests__/seo-repair-controller-e2e.smoke.test.mjs`

Expected: target-contract assertions fail before prompt wiring.

- [ ] **Step 3: Write prompt contract and spawn adapter**

The prompt requires: inspect exact failure layer; make the minimum target change; for pipeline code create/reuse an isolated `codex/seo-repair-<pageId-lower>-<fingerprint8>` worktree; write a failing regression before code; run targeted tests; call only adapter-provided actions; return structured outcome/evidence. Controller treats the response as diagnostics only and always calls `regate` plus `verifyTerminal` itself.

- [ ] **Step 4: Add crash/timeout/new-fingerprint E2E**

Fake Agent timeout records evidence and backoff; process crash leaves a recoverable lease; a changed gate failure creates a child generation; none of these send a human alert. A fake OAuth block after safe authorization path produces exactly one `human_only` notification.

- [ ] **Step 5: Run GREEN**

Run: `node --test tools/scripts/__tests__/seo-repair-controller.smoke.test.mjs tools/scripts/__tests__/seo-repair-controller-e2e.smoke.test.mjs`

Expected: all Agent contract, timeout, crash and terminal ownership tests pass.

- [ ] **Step 6: Commit Task 6**

```bash
git add tools/scripts/prompts/gg-seo-repair-controller.txt tools/scripts/lib/seo-repair-controller.mjs tools/scripts/__tests__/seo-repair-controller-e2e.smoke.test.mjs
git commit -m "feat(seo): define safe target repair agent contract"
```

---

### Task 7: Legacy Notification Ownership and Wrapper Wiring

**Files:**
- Modify: `tools/scripts/gg-seo-autopilot.mjs`
- Modify: `tools/scripts/gg-nightly-seo.sh`
- Modify: `tools/scripts/gg-gengrowth-publish-tick.sh`
- Modify: `tools/scripts/gg-gengrowth-author-tick.sh`
- Modify: `tools/scripts/gg-batch-summary.mjs`
- Modify: `tools/scripts/gg-seo-blog-launchd-tick.sh`
- Modify: `tools/scripts/__tests__/park-autoretry.smoke.test.mjs`
- Modify: `tools/scripts/__tests__/gg-batch-summary.smoke.test.mjs`
- Modify: `tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs`
- Modify: `tools/scripts/__tests__/lib-gg-notify.smoke.test.mjs`

- [ ] **Step 1: Write RED ownership/static tests**

Under v2: `classifyPark=permanent` enqueues `agent_fixable`/`unpublishable` evidence and never renders “彻底停止”; batch pending text says `自动修复队列`; both site wrappers call the same controller CLI; a busy controller is not an error; source scan finds no repairable direct `needs_human` notify outside controller. Under v1: current messages and calls remain compatible.

- [ ] **Step 2: Run RED**

Run: `node --test tools/scripts/__tests__/park-autoretry.smoke.test.mjs tools/scripts/__tests__/gg-batch-summary.smoke.test.mjs tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs tools/scripts/__tests__/lib-gg-notify.smoke.test.mjs`

Expected: current permanent/pending/direct-notify assertions fail under v2 fixtures.

- [ ] **Step 3: Wire event enqueue and natural drain**

Both site wrappers call `enqueue` on exact failure and then attempt one `drain`. They do not wait when `busy=true`. Nightly and publisher locks stay separate from the global controller lock, so an event is durable even if the invoking wrapper exits.

- [ ] **Step 4: Make controller the sole terminal notifier**

Use idempotency key `terminal:site:pageId:fingerprint`. Queued/repairing/regating/repair_pending are log-only. Batch summary may show local pending counts but never @ users or label them human-required under v2.

- [ ] **Step 5: Run GREEN plus shell syntax**

Run: `node --test tools/scripts/__tests__/park-autoretry.smoke.test.mjs tools/scripts/__tests__/gg-batch-summary.smoke.test.mjs tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs tools/scripts/__tests__/lib-gg-notify.smoke.test.mjs && bash -n tools/scripts/gg-nightly-seo.sh tools/scripts/gg-gengrowth-publish-tick.sh tools/scripts/gg-gengrowth-author-tick.sh tools/scripts/gg-seo-blog-launchd-tick.sh`

Expected: tests pass and `bash -n` exits 0.

- [ ] **Step 6: Commit Task 7**

```bash
git add tools/scripts/gg-seo-autopilot.mjs tools/scripts/gg-nightly-seo.sh tools/scripts/gg-gengrowth-publish-tick.sh tools/scripts/gg-gengrowth-author-tick.sh tools/scripts/gg-batch-summary.mjs tools/scripts/gg-seo-blog-launchd-tick.sh tools/scripts/__tests__/park-autoretry.smoke.test.mjs tools/scripts/__tests__/gg-batch-summary.smoke.test.mjs tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs tools/scripts/__tests__/lib-gg-notify.smoke.test.mjs
git commit -m "feat(seo): centralize repair terminal notifications"
```

---

### Task 8: Full Hermetic Regression and Atomic Rollout Guard

**Files:**
- Modify only files required by failures proven in this task.

- [ ] **Step 1: Run the focused v2 suite**

```bash
node --test \
  tools/scripts/__tests__/seo-repair-events.smoke.test.mjs \
  tools/scripts/__tests__/seo-repair-controller.smoke.test.mjs \
  tools/scripts/__tests__/seo-repair-controller-e2e.smoke.test.mjs \
  tools/scripts/__tests__/seo-repair-adapters.smoke.test.mjs \
  tools/scripts/__tests__/gg-seo-repair-hook.smoke.test.mjs \
  tools/scripts/__tests__/gg-seo-repair-verify.smoke.test.mjs \
  tools/scripts/__tests__/gg-gengrowth-publish-notify.smoke.test.mjs \
  tools/scripts/__tests__/park-autoretry.smoke.test.mjs \
  tools/scripts/__tests__/gg-batch-summary.smoke.test.mjs \
  tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs \
  tools/scripts/__tests__/lib-gg-notify.smoke.test.mjs
```

Expected: all pass; fake Agent count is zero for clean paths and one per claimed repair lease.

- [ ] **Step 2: Run all script tests and classify any pre-existing failures**

Run: `node --test tools/scripts/__tests__/*.test.mjs`

Expected: exit 0. If it fails, save exact failing test/output, reproduce from the implementation base, and only modify failures caused by this branch.

- [ ] **Step 3: Run static and invariant scans**

```bash
bash -n tools/scripts/*.sh
node --check tools/scripts/gg-seo-repair-controller.mjs
rg -n "彻底停止|暂停待人工|fact_gate_fail|needs_human" tools/scripts
rg -n "lynne-soul|GG_CODEX_GATE_REQUIRED.?=.?0|indexing.googleapis.com" tools/scripts/prompts/gg-seo-repair-controller.txt tools/scripts/lib/seo-repair-*.mjs
```

Expected: syntax exits 0; each repairable notification hit is either v1-flagged legacy fallback, controller terminal logic, or a test fixture; safety scan has no forbidden prompt/runtime hit.

- [ ] **Step 4: Verify the live checkout is safe to update**

Run: `ps -axo pid,etime,command | rg 'gg-(seo-blog-launchd-tick|nightly-seo|gengrowth-publish|seo-repair)' || true` and inspect `/tmp/gg-seo-blog-launchd.lock`, `/tmp/gg-nightly-seo.lock`, `/tmp/gg-gengrowth-publish.lock`, `/tmp/gg-seo-repair-controller.lock`.

Expected: no active old SEO/publish/repair process and no owned lock. Do not merge or enable v2 until this is true.

- [ ] **Step 5: Commit regression-only corrections**

```bash
git add <only files changed by proven regression fixes>
git commit -m "test(seo): harden universal repair controller rollout"
```

Skip the commit if no file changed.

---

### Task 9: Enable v2 and Import the Three Current Incidents

**Files:**
- Modify: `~/.config/gg/_gg.env`
- Runtime queue: `~/gengrowth-agents/flow-state/seo-repair-queue/`

- [ ] **Step 1: Capture a pre-rollout evidence bundle**

Record current branch/head, clean status, paused Codex Automation, loaded launchd labels, env values without secret contents, active locks/processes, current claims/manifest/W25 plan/Sheet rows, and exact live URLs for the three targets.

- [ ] **Step 2: Update the single feature flag only after code is in the runtime checkout**

Use an exact edit to set `GG_SEO_REPAIR_CONTROLLER_V2_ENABLED=1`. Keep `GG_SEO_REPAIR_HOOK_ENABLED` for v1 rollback compatibility. Re-read the line from disk; do not print unrelated env values.

- [ ] **Step 3: Atomically enqueue current incidents**

Create/import exactly:

```text
gengrowth / PG-WLS-007 / fact_gate / tool_exit / codex exited 3
astrologywiki / PG-TRANS-016 / preview_fact_gate / asset_fail / SVG Saturn Square age 14
astrologywiki / PG-TRANS-018 / links_seo_review / link_fail / intended links rendered as italic text
```

Use authoritative current log offsets and canonical target retry argv. Inspect queue and assert three active fingerprints with no duplicate v1 terminal state.

- [ ] **Step 4: Start one controller drain through the existing wrapper-compatible CLI**

Run: `node tools/scripts/gg-seo-repair-controller.mjs drain --max-targets 3 --budget-seconds 5400`

Expected: one global controller, sequential leases, no legacy needs-human notification. If budget ends, records remain queued/repair_pending and the next existing wrapper wake continues them.

---

### Task 10: Real Production Repair and Terminal Acceptance

**Files:**
- Target article/asset/pipeline files selected by exact incidents in isolated site worktrees.
- No direct manual ledger/Sheet completion writes.

- [ ] **Step 1: Converge `PG-WLS-007 / chatgpt-seo`**

Require: rerun fact reviewer PASS; scoped Gengrowth publish succeeds; Supabase row is published; production returns 200 with exact canonical and Article JSON-LD; sitemap includes slug; W25 plan checked; Sheet status/URL, vault archive and pending-writeback converge.

- [ ] **Step 2: Converge `PG-TRANS-016 / saturn-return-age-29`**

Require: SVG factual text corrected in target worktree; full article+asset diff passes preview verify, three reviews and Codex gate; reviewed head merges; production/live/canonical/JSON-LD/sitemap pass; claim, plan, Sheet, publish log and backfill converge.

- [ ] **Step 3: Converge `PG-TRANS-018 / saturn-return-in-capricorn`**

Require: intended internal links use verified existing slugs and render as anchors; links-seo plus full gate pass; reviewed head merges; production/live/canonical/JSON-LD/sitemap pass; claim, plan, Sheet, publish log and backfill converge.

- [ ] **Step 4: Run final controller/product verification**

```bash
node tools/scripts/gg-seo-repair-controller.mjs inspect --page-id PG-WLS-007
node tools/scripts/gg-seo-repair-controller.mjs inspect --page-id PG-TRANS-016
node tools/scripts/gg-seo-repair-controller.mjs inspect --page-id PG-TRANS-018
node tools/scripts/gg-seo-repair-verify.mjs --site gengrowth --page-id PG-WLS-007 --json
node tools/scripts/gg-seo-repair-verify.mjs --site astrologywiki --page-id PG-TRANS-016 --json
node tools/scripts/gg-seo-repair-verify.mjs --site astrologywiki --page-id PG-TRANS-018 --json
```

Expected: all three are `published+backfilled`; every named verifier check is true; queue has no active matching fingerprint.

- [ ] **Step 5: Verify notification and process convergence**

Inspect the exact rollout log window and notification audit/outbox. Require one success terminal per target, no duplicate `needs_human`/“彻底停止”, empty outbox, no controller/lane/Agent/publish/backfill process, and no owned repair/publish/nightly lock.

- [ ] **Step 6: Run final focused regression after production convergence**

Run the Task 8 focused v2 suite again plus `git diff --check`.

Expected: all pass and `git diff --check` exits 0.

- [ ] **Step 7: Commit target repairs and rollout evidence**

Stage only reviewed implementation/target/evidence files that belong to this task; preserve unrelated user or scheduler changes. Commit with an incident-specific message after all deterministic gates pass.

---

## Completion Checklist

- [ ] `GG_SEO_REPAIR_CONTROLLER_V2_ENABLED=1` is active and v1 rollback path remains intact.
- [ ] Clean paths invoke zero Agents.
- [ ] Both sites use the same durable queue and one controller lock.
- [ ] `maxTargets=1` leaves later events queued and aging eventually schedules them.
- [ ] Attempt exhaustion never alone creates `human_only`.
- [ ] Legacy lanes send no repairable terminal notification under v2.
- [ ] `PG-WLS-007`, `PG-TRANS-016`, `PG-TRANS-018` are all live and backfilled with deterministic evidence.
- [ ] Queue, leases, locks, Agents, publisher and writeback processes are fully converged.
- [ ] Focused v2 suite and full script regression pass.

