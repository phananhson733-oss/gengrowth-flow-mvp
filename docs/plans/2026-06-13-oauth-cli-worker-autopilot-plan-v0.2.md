---
title: OAuth CLI Worker Autopilot Implementation Plan
date: 2026-06-13
updated: 2026-06-18
type: plan
version: v0.2
status: draft
owner: awayer_mini
tags:
  - seo-autopilot
  - oauth-cli
  - cron
  - reliability
  - multisite
aliases:
  - OAuth CLI Worker Autopilot Plan
  - SEO Autopilot OAuth CLI Worker Plan
---

# OAuth CLI Worker Autopilot Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep the low-cost OAuth/desktop-subscription LLM path for SEO article writing while making the cron autopilot deterministic, observable, and recoverable on **awayer_mini** — the single machine that now does **both authoring and publishing**. Retire the fragile headless `claude -p` publish gate, replace agentic rescue with deterministic repair, and make every long-running stage observable, before re-enabling cron authoring on this machine.

**Architecture:** Cron/launchd runs a Node-owned state machine. LLM CLIs such as `claude -p` and `codex exec` remain the default writing/review transport, but they are constrained to pure worker mode: prompt in, Markdown/JSON out, no Bash/Edit/Write/MCP/merge side effects. All file writes, validation, retries, preview verification, PR state changes, and Feishu notifications are performed by deterministic scripts.

**Tech Stack:** Node.js ESM scripts, macOS launchd, existing Claude/Codex OAuth CLIs, GitHub CLI, Playwright (resolved from `~/oracle`), existing JSON claims ledger, existing Phase 2 validator, existing oracle publish worktree flow.

---

## Consolidation & Scope (v0.2)

This plan was originally written (v0.1, 2026-06-13) for a **single-machine author+publish world**, against **wzb's machine layout** (`/Users/wzb/Code/oracle`, `~/Code/gengrowth-ops`). Since then two things happened that v0.1 was unaware of, both confirmed by the 2026-06-18 audit:

1. The system split into a **two-machine model**: wzb authored off-machine; awayer_mini ran `GG_AUTOPILOT_MODE=publish-only` and never authored in cron.
2. A **second publish lane** (gengrowth.ai, Lane A) was stood up on this same machine via `com.gengrowth.gengrowth-publish.plist`.

**v0.2 reverses the split.** Per the operator decision (2026-06-18):

- **Everything consolidates onto awayer_mini.** Going forward this machine does **both authoring and publishing**; wzb stops writing. All 10 tasks are in scope **here**.
- The **author-on-cron path comes back on this machine** — but flipping `GG_AUTOPILOT_MODE` from `publish-only` to `full` is a **LIVE cutover that happens LAST** (Task 11), after every deterministic piece is built and verified. Until then, the publish-only stand-down stays in force so the working cron is never destabilized mid-build.
- **gengrowth.ai Lane A is in scope and actively improved** (Task 12), not merely guarded. The two cross-site non-negotiables (preserve the `PG-<prefix>-<llm>-v8.md` staging contract; keep the `latestPlan` gengrowth filter) are **regression-tested invariants**, not just prose.

> **Machine identity / paths:** This is **awayer_mini**. Live dirs: `GG_ORACLE_DIR` default `~/oracle` (`/Users/awayer_mini/oracle`), `GG_OPS_DIR` default `~/gengrowth-ops` (`/Users/awayer_mini/gengrowth-ops`). Claims ledger: `/Users/awayer_mini/gengrowth-ops/inbox/06-tasks/tasks/.autopilot-claims.json`. **NEVER** use any `/Users/wzb/...` or `~/Code/...` path — they do not exist on this box. The autopilot's own defaults (`gg-seo-autopilot.mjs:64,66`) are already `~/oracle` + `~/gengrowth-ops` with **no `Code` segment**.

## Non-Negotiable Constraints

- Do not make paid API providers the default writing path.
- Preserve OAuth/CLI authoring as the primary cost-saving path.
- Do not let a headless LLM agent call `Bash`, `Edit`, `Write`, MCP, or merge PRs in unattended cron.
- Preserve current `_staging` outputs, phase2 manifests, claim statuses, branch naming, Feishu notifications, and publish register behavior.
- **Path/identity:** Every default path resolves to the awayer_mini layout (`~/oracle`, `~/gengrowth-ops`). No `~/Code/*` or `/Users/wzb/*` literals anywhere — in code defaults, manual-run examples, or docs.
- **Codex CLI parity:** the codex worker argv stays `['exec','-c','model=gpt-5.5','-c',\`reasoning_effort=${effort}\`,'-']` (effort default `GG_CODEX_EFFORT || 'xhigh'`). There is **no** `-s read-only` flag and **no** `opts.codexModelConfig` variable in the real orchestrator (`gg-llm-orchestrator.mjs:78-84`); do not fabricate them.
- **Playwright resolution:** the preview verifier resolves Playwright via `createRequire(join(GG_ORACLE_DIR,'/')).resolve('playwright')` then imports the resolved `file://` path. A bare `import('playwright')` from flow-mvp throws `ERR_MODULE_NOT_FOUND`.
- **Reuse, don't reimplement:** reuse `lib/strip-preamble.mjs` (`stripPreH1`) for pre-H1 stripping, and `gg-lark-notify.sh` (single positional arg, best-effort exit 0) for failure notifications. Playwright 1.60 + chromium are already installed in `~/oracle`.
- **Live-cron safety:** Never commit a `gg-seo-autopilot-tick.sh` change that can `exit 2` / Feishu-alert on a normal fire until it is verified to pass on awayer_mini. The preflight (Task 1) lands LAST among live-tick edits for exactly this reason.
- **Cross-site invariants (gengrowth.ai Lane A):** Task 2 must preserve the exact `<pageId>-<model>-v8.md` staging convention that `gg-gengrowth-publish.mjs:35` (`DRAFT_RE`) parses. Task 7 must keep the publish-only stand-down (`tick.sh:126`) and the `latestPlan` gengrowth filter (`mjs:197`) intact. Both are covered by regression tests in this plan.
- Keep changes incremental. First make the existing JSON claims flow safer; do not introduce SQLite in the first pass unless the JSON lease approach proves insufficient.

## Current Topology (verified 2026-06-18)

Two launchd jobs run on awayer_mini:

- **Lane B (oracle / astrologywiki.com):** `com.gengrowth.seo-autopilot.plist` → `gg-seo-autopilot-tick.sh` → `gg-seo-autopilot.mjs`. Currently `GG_AUTOPILOT_MODE=publish-only`. **This is the lane this plan rebuilds.** "The cron on this machine," unless explicitly stated otherwise, means **Lane B**.
- **Lane A (gengrowth.ai → Supabase blog):** `com.gengrowth.gengrowth-publish.plist` → `gg-gengrowth-publish-tick.sh` → `gg-gengrowth-publish.mjs --apply`. Separate lock (`/tmp/gg-gengrowth-publish.lock`), no `claude -p` gate, shares **zero** code with the Lane B scripts. Improved in Task 12.

## Target State

Current fragile shape (Lane B, before this plan):

```text
launchd
  -> bash tick (publish-only: never authors here today)
    -> node --scan (deterministic claim+convert+build+push+PR)
    -> claude -p "$(cat seo-autopilot-tick.prompt.md)" as agentic publish gate
       -> --allowedTools Bash Skill Task Agent Read Grep mcp__playwright__browser_*
       -> --dangerously-skip-permissions, --mcp-config (npx @playwright/mcp)
       -> may call tools / MCP / subagents / merge decisions
```

Target shape (Lane B, after this plan, once cutover to `full` lands in Task 11):

```text
launchd
  -> bash tick
    -> node preflight (fail-fast, alerts on missing dirs/env/tools)
    -> [full mode] node author runner
       -> claude/codex OAuth CLI worker for text only (no tools/MCP/merge)
       -> node writes candidate files
       -> node runs phase2
       -> node deterministic repair on phase2 failure (no agentic Edit/Write/Bash)
    -> node scan/push preview (claim -> convert -> illustrate -> build-gate -> push -> PR)
    -> node preview wait (gh deployments poll)
    -> node preview verify (Node Playwright from ~/oracle, Vercel bypass)
    -> node review workers for JSON verdicts (astrology / schema / links-seo)
    -> node mark verified / merge / notify  (tri-state rc 0/1/2 preserved)
```

## Phase Order

1. Build the deterministic publish-leg pieces that the new gate composes (preview wait, preview verify, review workers).
2. Retire the agentic `claude -p` publish gate, replacing it with a deterministic Node gate **and** a real hot-rollback branch — the highest-value live fix.
3. Add claim-lease observability on the publish stages that actually run.
4. Land the path-corrected preflight LAST among live-tick edits.
5. Verify three real previews pass gate → merge.
6. Bring the **authoring** pieces (worker contract, deterministic repair, authoring-stage heartbeats) onto this machine — still off-cron.
7. **Cutover:** flip `GG_AUTOPILOT_MODE` to `full` so cron authors again. LAST.
8. Improve gengrowth.ai Lane A; document everything.

## Recommended Landing Order

`4 → 5 → 6 → 7 → 8 → 1 → 10 → 9 → 2 → 3 → 11(cutover) → 12(Lane A) `

(Authoring tasks 2/3 and the cron-authoring cutover land **last**; Task 1 preflight lands after the deterministic gate is in; Task 12 Lane A work is independent and can interleave but the cross-site regression tests it adds should land before the cutover.)

---

### Task 4: Script the Vercel Preview Wait Step

**Status:** live-fire on the publish-only path. Additive new script, zero live-tick risk. Build first as the gate's first deterministic step.

**Files:**
- Create: `tools/scripts/gg-preview-wait.mjs`
- Test: `tools/scripts/__tests__/gg-preview-wait.smoke.test.mjs`

**Step 1: Write the failing test**

Create `tools/scripts/__tests__/gg-preview-wait.smoke.test.mjs`.

```js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';

const SCRIPT = new URL('../gg-preview-wait.mjs', import.meta.url).pathname;

test('preview wait validates required branch argument', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--branch is required/);
});
```

**Step 2: Run the test to verify it fails**

```bash
node --test tools/scripts/__tests__/gg-preview-wait.smoke.test.mjs
```

Expected: FAIL because script does not exist.

**Step 3: Implement preview wait**

Create `tools/scripts/gg-preview-wait.mjs`.

Behavior:

- Accept `--branch`, `--repo xdawayer/oracle` (default), `--timeout-ms`, `--poll-ms`, `--json`.
- Use `gh api repos/<repo>/deployments?ref=<branch>` → for the newest deployment, poll `deployments/<id>/statuses` for `state==='success'` and read `environment_url`.
- Mirrors the existing prompt-gate logic (`seo-autopilot-tick.prompt.md:14-16`).
- Return `{ ok: true, previewUrl }` on success.
- **Terminal-state handling (audit):** if the newest deployment status is `failure`/`error`/`cancelled`, return non-zero immediately with `{ ok: false, reason }` — do NOT poll forever on a dead deploy.
- On timeout, return non-zero with `{ ok: false, reason: 'timeout' }`.
- No uncaught stack trace on any path.

**Step 4: Run dry validation**

```bash
node tools/scripts/gg-preview-wait.mjs --branch seo/auto/2026-06-12-PG-WC-001 --repo xdawayer/oracle --timeout-ms 1000 --json
```

Expected: Either a preview URL if a deployment exists, or a clear timeout/failure JSON.

**Step 5: Commit**

```bash
git add tools/scripts/gg-preview-wait.mjs tools/scripts/__tests__/gg-preview-wait.smoke.test.mjs
git commit -m "feat: add deterministic preview wait"
```

---

### Task 5: Script Preview Verification With Playwright

**Status:** live-fire, needs-correction. On the live publish path; Playwright 1.60.0 + chromium are installed in `~/oracle` and the bypass secret is present in `_gg.env`. This **replaces** the `@playwright/mcp` npx path (`autopilot-mcp.json` + `mcp__playwright__browser_*`) — an architecture change retired alongside Task 7, not a refactor.

**Files:**
- Create: `tools/scripts/gg-preview-verify.mjs`
- Test: `tools/scripts/__tests__/gg-preview-verify.smoke.test.mjs`

**Step 1: Write the failing test**

Create `tools/scripts/__tests__/gg-preview-verify.smoke.test.mjs`.

```js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';

const SCRIPT = new URL('../gg-preview-verify.mjs', import.meta.url).pathname;

test('preview verify requires preview url and slug', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--preview-url is required/);
  assert.match(r.stderr, /--slug is required/);
});

test('preview verify resolves chromium from GG_ORACLE_DIR', () => {
  // Smoke: with GG_ORACLE_DIR=~/oracle, the verifier must be able to resolve and
  // launch chromium (no ERR_MODULE_NOT_FOUND). Use a tiny --self-check mode that
  // resolves playwright + reports chromium availability without navigating.
  const r = spawnSync(process.execPath, [SCRIPT, '--self-check', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, GG_ORACLE_DIR: process.env.GG_ORACLE_DIR || `${process.env.HOME}/oracle` },
  });
  // self-check exits 0 with { ok:true, chromium:true } when oracle playwright resolves.
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.chromium, true);
});
```

> The chromium self-check is hermetic against the real `~/oracle` install but launches no preview navigation and hits no network. In a CI/sandbox without `~/oracle`, gate it behind `process.env.GG_ORACLE_DIR && existsSync(...)` and skip with `t.skip()`.

**Step 2: Run the test to verify it fails**

```bash
node --test tools/scripts/__tests__/gg-preview-verify.smoke.test.mjs
```

Expected: FAIL because script does not exist.

**Step 3: Implement Playwright verifier (with the createRequire fix)**

Create `tools/scripts/gg-preview-verify.mjs`.

Playwright resolution (the load-bearing correction — a bare `import('playwright')` from flow-mvp throws `ERR_MODULE_NOT_FOUND`):

```js
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ORACLE = process.env.GG_ORACLE_DIR || join(process.env.HOME, 'oracle');
async function loadPlaywright() {
  const require = createRequire(join(ORACLE, '/')); // trailing slash → resolve from oracle/node_modules
  const resolved = require.resolve('playwright');    // ~/oracle/node_modules/playwright/index.js
  const mod = await import(pathToFileURL(resolved).href);
  if (!mod.chromium) throw new Error(`playwright resolved but no chromium export at ${resolved}`);
  return mod;
}
```

Behavior:

- Accept `--preview-url`, `--slug`, `--zh`, `--bypass-secret`, `--self-check`, `--json`, `--timeout-ms`.
- Bypass secret defaults to `process.env.VERCEL_AUTOMATION_BYPASS_SECRET`.
- Navigate, in **one browser context** (so the bypass cookie persists across navigations):
  - `<previewUrl>/en/wiki/<slug>?x-vercel-protection-bypass=<secret>&x-vercel-set-bypass-cookie=true`
  - `<previewUrl>/zh/wiki/<slug>` (plain — the set-bypass-cookie from the EN nav clears protection) when `--zh`.
- Fail on:
  - no `h1`
  - no `script[type="application/ld+json"]`
  - visible Vercel login/auth wall (`vercel.com/login` or a 401 wall)
  - empty SPA soft-404 shell
  - uncaught JS exception
  - failed app bundle load
- Ignore benign favicon/font/analytics 404s.
- **Tooling-failure policy (fail-closed):** if Playwright itself cannot launch (resolution error, chromium missing, browser crash) → exit non-zero with `{ ok: false, reason: 'tooling: <detail>' }`. The gate (Task 7) treats this as a blocker, NOT a pass. Never fail-open on tooling errors that gate production merges.
- Output JSON evidence:

```json
{
  "ok": true,
  "checked": [
    {"url": ".../en/wiki/slug", "h1": "...", "jsonLd": true},
    {"url": ".../zh/wiki/slug", "h1": "...", "jsonLd": true}
  ],
  "warnings": []
}
```

Do not use Claude MCP for this verifier. The `@playwright/mcp` npx server (`autopilot-mcp.json`) is retired with the prompt gate in Task 7.

**Step 4: Run tests**

```bash
node --test tools/scripts/__tests__/gg-preview-verify.smoke.test.mjs
```

Expected: PASS (including the chromium self-check resolving from `~/oracle`).

Manual smoke when a preview exists:

```bash
node tools/scripts/gg-preview-verify.mjs \
  --preview-url "$PREVIEW_URL" \
  --slug world-cup-2026-astrology-prediction \
  --zh \
  --bypass-secret "$VERCEL_AUTOMATION_BYPASS_SECRET" \
  --json
```

Expected: PASS or a clear blocker reason.

**Step 5: Commit**

```bash
git add tools/scripts/gg-preview-verify.mjs tools/scripts/__tests__/gg-preview-verify.smoke.test.mjs
git commit -m "feat: verify previews with deterministic playwright (oracle-resolved)"
```

---

### Task 6: Add Structured Review Worker Verdicts

**Status:** still-valid; lands as-is modulo wiring into Task 7. Additive, low-risk, faithful port of the prompt gate's review step.

**Files:**
- Create: `tools/scripts/gg-article-review-worker.mjs`
- Modify: `tools/scripts/gg-author-review.mjs` only if shared prompt helpers are cleanly extractable (optional; do not destabilize the existing reviewer)
- Test: `tools/scripts/__tests__/gg-article-review-worker.smoke.test.mjs`

**Step 1: Write the failing test**

Create `tools/scripts/__tests__/gg-article-review-worker.smoke.test.mjs`.

```js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const SCRIPT = new URL('../gg-article-review-worker.mjs', import.meta.url).pathname;

test('review worker normalizes JSON verdict from oauth CLI stdout', () => {
  const root = mkdtempSync(join(tmpdir(), 'gg-review-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nprintf "{\\"verdict\\":\\"PASS\\",\\"blocking_reason\\":\\"\\"}\\n"\n', { mode: 0o755 });
  const article = join(root, 'article.ts');
  const draft = join(root, 'draft.md');
  writeFileSync(article, 'export const article = { title: "T" };');
  writeFileSync(draft, '# T\n');
  const r = spawnSync(process.execPath, [SCRIPT,
    '--dimension', 'schema',
    '--article', article,
    '--draft', draft,
    '--json',
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH || ''}` },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict, 'PASS');
});

test('review worker fails closed (SKIPPED) when the CLI emits no parseable JSON', () => {
  const root = mkdtempSync(join(tmpdir(), 'gg-review-noj-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nprintf "sorry, here is some prose\\n"\n', { mode: 0o755 });
  const article = join(root, 'a.ts');
  const draft = join(root, 'd.md');
  writeFileSync(article, 'x'); writeFileSync(draft, '# T\n');
  const r = spawnSync(process.execPath, [SCRIPT, '--dimension', 'schema', '--article', article, '--draft', draft, '--json'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH || ''}` },
  });
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict, 'SKIPPED');
  assert.match(out.blocking_reason, /tooling/);
});
```

**Step 2: Run the test to verify it fails**

```bash
node --test tools/scripts/__tests__/gg-article-review-worker.smoke.test.mjs
```

Expected: FAIL because script does not exist.

**Step 3: Implement review worker**

Create `tools/scripts/gg-article-review-worker.mjs`.

Behavior:

- Accept `--dimension astrology|schema|links-seo`, `--article <.ts>`, `--draft <.md>`, `--timeout-ms` (per-worker hard timeout), `--json`.
- Call the OAuth CLI text worker (`runTextWorker('claude', ...)` once Task 2's lib exists; until then a local text-only spawn that mirrors `['-p','--model',M,'--effort',E]`).
- Require strict JSON output:

```json
{ "verdict": "PASS", "blocking_reason": "", "notes": ["short evidence"] }
```

- If the worker emits prose, try to extract the first JSON object.
- **Fail-closed policy (explicit):** if no parseable JSON, OR the worker times out, return `{ "verdict": "SKIPPED", "blocking_reason": "tooling: no parseable JSON verdict" }`. A `SKIPPED` (tooling failure) must **NOT** silently pass the gate — the caller (Task 7) treats `SKIPPED` on a required dimension as a blocker.

**Step 4: Run tests**

```bash
node --test tools/scripts/__tests__/gg-article-review-worker.smoke.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add tools/scripts/gg-article-review-worker.mjs tools/scripts/__tests__/gg-article-review-worker.smoke.test.mjs
git commit -m "feat: add structured article review worker (fail-closed)"
```

---

### Task 7: Retire the Prompt-Driven Verify/Merge Gate (highest-value live fix)

**Status:** live-fire, **P0**. This is the actual live pain — the headless `claude -p "$(cat seo-autopilot-tick.prompt.md)"` gate, currently band-aided by an uncommitted `rc=2` patch. It is **NOT** a one-line find-and-replace: the real call is the **body** of `publish_if_pending()` (`tick.sh:88-109`), behind a `grep` pre-gate (`tick.sh:89`), wrapped in `gtimeout ${GG_AUTOPILOT_PUBLISH_TIMEOUT:-1800}` (`tick.sh:97`), with `--mcp-config`, and a **tri-state return contract** (`0`=published keep-looping, `1`=nothing, `2`=gate-failed end-fire) consumed by `run_one_cycle` at `tick.sh:119-121`.

**Files:**
- Create: `tools/scripts/gg-preview-gate.mjs`
- Modify: `tools/scripts/gg-seo-autopilot-tick.sh` (rewrite the **body** of `publish_if_pending()`)
- Leave: `tools/scripts/seo-autopilot-tick.prompt.md` as a deprecated reference for one release
- Test: `tools/scripts/__tests__/gg-preview-gate.smoke.test.mjs`
- Test (tick-level): `tools/scripts/__tests__/gg-tick-rollback.smoke.test.mjs`

**Step 1: Write the failing tests**

`tools/scripts/__tests__/gg-preview-gate.smoke.test.mjs`:

```js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';

const SCRIPT = new URL('../gg-preview-gate.mjs', import.meta.url).pathname;

test('preview gate requires a branch', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--branch is required/);
});
```

`tools/scripts/__tests__/gg-tick-rollback.smoke.test.mjs` — assert `GG_USE_PROMPT_PREVIEW_GATE=1` selects the **legacy prompt-gate** path, and unset/`0` selects the **node gate** path. Drive `publish_if_pending` with fake bins (`claude`, `node`, `gtimeout`) on PATH inside a tmp dir, seed a fake `--status` output that contains `"pushed-preview"`, and assert which command was invoked by having each fake bin write a marker file:

```js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const TICK = new URL('../gg-seo-autopilot-tick.sh', import.meta.url).pathname;

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'gg-tick-rb-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  // fake `node`: when called with `--status` prints a claim with pushed-preview;
  // when called with gg-preview-gate.mjs writes marker NODE_GATE and exits 0.
  writeFileSync(join(bin, 'node'),
    '#!/bin/sh\ncase "$*" in\n*--status*) echo \'{"PG-X":{"status":"pushed-preview","branch":"b"}}\'; exit 0;;\n*gg-preview-gate.mjs*) echo node-gate > "'+root+'/NODE_GATE"; exit 0;;\n*) exit 0;; esac\n',
    { mode: 0o755 });
  // fake `claude`: writes marker PROMPT_GATE.
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho prompt-gate > "'+root+'/PROMPT_GATE"\nexit 0\n', { mode: 0o755 });
  // fake `gtimeout`: exec the rest.
  writeFileSync(join(bin, 'gtimeout'), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 });
  return { root, bin };
}
// Each test sources the tick and calls publish_if_pending directly, OR (simpler)
// the implementer extracts publish_if_pending into a sourceable function and the
// test asserts existsSync(NODE_GATE) vs existsSync(PROMPT_GATE) per env var.
```

> Implementation note: keep `publish_if_pending()` small and sourceable enough that the rollback branch is testable without launching the full loop. The test's exact wiring is the implementer's call; the **assertion** is non-negotiable: `GG_USE_PROMPT_PREVIEW_GATE=1` → legacy `claude -p` path runs; unset → `gg-preview-gate.mjs` runs.

**Step 2: Run the tests to verify they fail**

```bash
node --test tools/scripts/__tests__/gg-preview-gate.smoke.test.mjs
node --test tools/scripts/__tests__/gg-tick-rollback.smoke.test.mjs
```

Expected: FAIL (script missing; rollback branch not wired).

**Step 3: Implement gate orchestration**

Create `tools/scripts/gg-preview-gate.mjs`.

Behavior:

1. Load claim by `--branch`. **Read-only lookup:** read the ledger directly (or a read-only helper) rather than `gg-seo-autopilot.mjs --status`, because `--status` runs `reconcileClaimsWithGitHub` and takes the claims lock (a write side-effect that can race the gate's own `--merge`, per `gg-seo-autopilot.mjs:1278`). If `--status` is used for branch discovery in the tick, do the gate's own per-branch read independently.
2. If `status === 'verified-preview'`, skip preview wait and use the stored `previewUrl`.
3. Else call `gg-preview-wait.mjs` (`--timeout-ms` enforced).
4. Call `gg-preview-verify.mjs` (fail-closed on tooling error).
5. Call three `gg-article-review-worker.mjs` workers with per-worker hard timeouts: `astrology`, `schema`, `links-seo`. A required dimension returning `SKIPPED` is a blocker.
6. Optional Codex diff review remains best-effort (non-blocking).
7. **Per-step hard timeouts + tri-state mapping:** `gg-preview-gate.mjs` enforces its own per-step caps (preview-wait timeout, verify timeout, per-worker timeouts) and maps any timeout/error to a **gate-failed** outcome. The script's own exit code is the source of truth for the tick's `rc=2` path.
8. If all required gates pass:

```bash
node tools/scripts/gg-seo-autopilot.mjs --mark-verified --branch "$BRANCH" --preview-url "$PREVIEW_URL" --evidence "$EVIDENCE"
node tools/scripts/gg-seo-autopilot.mjs --merge --branch "$BRANCH"
```

9. If any required gate fails:
   - **Idempotent `--mark-failed`:** first read the claim status. `--mark-failed` throws (`gg-seo-autopilot.mjs:1199`) if the claim is already `needs_human`/`done`. Treat already-parked/done as a no-op; only call `--mark-failed` from `active`/`pushed-preview`/`verified-preview`.
   - **Self-issued Feishu notify:** `--mark-failed` does **NOT** notify (larkNotify is only wired into merge success, `mjs:1271`). The gate must call `gg-lark-notify.sh "⚠️ ..."` itself on failure.
10. Publish-success notification remains owned by `--merge`.

**Step 4: Rewrite the BODY of `publish_if_pending()` in the tick (preserve the 0/1/2 contract + a hard timeout + the rollback branch)**

In `tools/scripts/gg-seo-autopilot-tick.sh`, replace the body of `publish_if_pending()` (`tick.sh:88-109`). Requirements:

- **Preserve the grep pre-gate** (`tick.sh:89`): `node "$AUTO" --status 2>/dev/null | grep -Eq '"(pushed-preview|verified-preview)"' || return 1`.
- **Preserve the tri-state return contract** consumed at `tick.sh:119-121`: `return 0` = published (keep looping), `return 1` = nothing to publish, `return 2` = gate failed/timed out (end this fire so a bad preview can't hammer the gate up to `MAX_CYCLES=50` and hold the PID mutex for hours).
- **Keep a hard wall-clock cap.** Either re-wrap the node gate in `gtimeout "${GG_AUTOPILOT_PUBLISH_TIMEOUT:-1800}"`, OR rely on `gg-preview-gate.mjs`'s own per-step caps and map its non-zero/timeout exit to `rc=2`. Prefer **both** (belt and suspenders): wrap in `gtimeout` and have the node gate self-cap.
- **Wire the `GG_USE_PROMPT_PREVIEW_GATE` rollback branch IN THE SAME COMMIT** (it is currently referenced only in the v0.1 plan and read by no code — making it real is part of this task):

```bash
publish_if_pending() {
  node "$AUTO" --status 2>/dev/null | grep -Eq '"(pushed-preview|verified-preview)"' || return 1
  echo "$(date '+%F %T') preview pending → running verify+merge gate" >> "$LOG"

  if [ "${GG_USE_PROMPT_PREVIEW_GATE:-0}" = "1" ]; then
    # ── HOT ROLLBACK PATH ── legacy headless claude -p prompt gate (unchanged).
    echo "$(date '+%F %T') GG_USE_PROMPT_PREVIEW_GATE=1 → legacy prompt gate" >> "$LOG"
    gtimeout "${GG_AUTOPILOT_PUBLISH_TIMEOUT:-1800}" claude -p "$(cat "$PROMPT_FILE")" \
      --mcp-config "$SCRIPT_DIR/autopilot-mcp.json" \
      --allowedTools "Bash Skill Task Agent Read Grep mcp__playwright__browser_navigate mcp__playwright__browser_snapshot mcp__playwright__browser_console_messages mcp__playwright__browser_evaluate mcp__playwright__browser_close" \
      --dangerously-skip-permissions </dev/null >> "$LOG" 2>&1
    _rc=$?
  else
    # ── DEFAULT PATH ── deterministic node gate (Task 4/5/6 composed).
    BRANCH="$(node "$AUTO" --status 2>/dev/null | node -e '
      const fs=require("fs");
      const claims=JSON.parse(fs.readFileSync(0,"utf8"));
      for (const c of Object.values(claims)) {
        if (c && (c.status==="pushed-preview" || c.status==="verified-preview")) { console.log(c.branch); process.exit(0); }
      }
      process.exit(1);
    ')"
    if [ -z "$BRANCH" ]; then return 1; fi
    gtimeout "${GG_AUTOPILOT_PUBLISH_TIMEOUT:-1800}" \
      node "$SCRIPT_DIR/gg-preview-gate.mjs" --branch "$BRANCH" >> "$LOG" 2>&1
    _rc=$?
  fi

  if [ "$_rc" -ne 0 ]; then
    echo "$(date '+%F %T') publish gate exited rc=$_rc (timeout/err) — ending this fire; launchd retries" >> "$LOG"
    return 2
  fi
  return 0
}
```

- Remove `PROMPT_FILE` from the **default** path (it is now only referenced inside the rollback branch). Keep the prompt file on disk as documentation until the new gate has run successfully for at least three real articles (Task 10).

**Step 5: Preserve the cross-site / mode invariants (regression-tested)**

The rewrite must NOT touch `run_one_cycle`'s publish-only stand-down (`tick.sh:126`) or the `latestPlan` gengrowth filter (`mjs:197`). Add regression tests (these also back the Task 12 invariants):

- `gg-tick-rollback.smoke.test.mjs` already asserts mode-agnostic gate selection.
- Add to `gg-seo-autopilot.smoke.test.mjs`: `latestPlan()` never selects a file matching `/gengrowth/i` (seed a plan dir with both a gengrowth plan and an astrology plan, assert the astrology one wins).
- Add a publish-only assertion: under `GG_AUTOPILOT_MODE=publish-only`, `--author`/`--next-unauthored` exit 0 with no stdout (guards `mjs:1287-1290`).

**Step 6: Run tests**

```bash
node --test tools/scripts/__tests__/gg-preview-gate.smoke.test.mjs
node --test tools/scripts/__tests__/gg-tick-rollback.smoke.test.mjs
node --test tools/scripts/__tests__/gg-seo-autopilot.smoke.test.mjs
```

Expected: PASS.

**Step 7: Manual dry run (awayer_mini paths — no wzb overrides)**

```bash
# ~/oracle + ~/gengrowth-ops are the mjs defaults; no env overrides needed here.
node tools/scripts/gg-preview-gate.mjs \
  --branch seo/auto/2026-06-12-PG-WC-001 \
  --dry-run \
  --json
```

Expected: Shows planned preview wait, preview verify, review workers, and final action. Does not merge in dry-run.

**Step 8: Commit (single commit — gate + rollback + invariant tests together)**

```bash
git add tools/scripts/gg-preview-gate.mjs tools/scripts/gg-seo-autopilot-tick.sh \
  tools/scripts/__tests__/gg-preview-gate.smoke.test.mjs \
  tools/scripts/__tests__/gg-tick-rollback.smoke.test.mjs \
  tools/scripts/__tests__/gg-seo-autopilot.smoke.test.mjs
git commit -m "feat: replace prompt-driven preview gate + wire GG_USE_PROMPT_PREVIEW_GATE rollback"
```

---

### Task 8: Add Claim Lease Heartbeats (publish stages)

**Status:** needs-correction. Premise corrected: `lockedBy`/`leaseUntil`/`updatedAt` are **entirely absent** (not "partly present"); `stage` is only a park-time literal (`mjs:595`, `stage:'authoring'`). Add all three **from scratch** with migration for existing entries. On the publish node, heartbeat the **publish** stages in `doScanLocked` (the authoring-stage list from v0.1 is dead weight until cutover; the authoring heartbeats are added in Task 8b once authoring is live).

**Files:**
- Modify: `tools/scripts/gg-seo-autopilot.mjs`
- Test: `tools/scripts/__tests__/gg-seo-autopilot.smoke.test.mjs`

**Step 1: Add failing tests**

Extend `tools/scripts/__tests__/gg-seo-autopilot.smoke.test.mjs`:

```js
test('active publish claim records stage heartbeat metadata', () => {
  // Seed a claimable task, run --scan with fake worktree/convert/build/push/gh bins,
  // assert the claim gained: status, stage, lockedBy, leaseUntil, updatedAt during the run.
});

test('stale active claim is reported read-only without reclaiming', () => {
  // Seed an active claim with leaseUntil in the past.
  // Run --stale-report.
  // Assert the stale entry appears and NO destructive mutation occurs.
});
```

**Step 2: Run the test to verify it fails**

```bash
node --test tools/scripts/__tests__/gg-seo-autopilot.smoke.test.mjs
```

Expected: FAIL (lease metadata absent; `--stale-report` not parsed).

**Step 3: Add lease helpers (net-new fields)**

In `tools/scripts/gg-seo-autopilot.mjs`:

```js
function heartbeatClaim(claims, pgId, patch = {}) {
  const now = new Date();
  claims[pgId] = {
    ...(claims[pgId] || {}),
    ...patch,
    lockedBy: `${process.pid}`,
    leaseUntil: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    updatedAt: now.toISOString(),
  };
}
function claimIsStale(claim) {
  return claim?.leaseUntil && Date.parse(claim.leaseUntil) < Date.now();
}
```

Note: existing entries lack these fields; `heartbeatClaim` adds them lazily, and `claimIsStale` treats a missing `leaseUntil` as not-stale (the existing 2h directory-mutex sweep, `CLAIMS_LOCK_STALE_MS`, remains the safety net). No destructive migration needed.

**Step 4: Heartbeat the PUBLISH stages in `doScanLocked`**

Call `heartbeatClaim(claims, t.pgId, { stage: '<stage>' })` (and `saveClaims`) before each long publish stage in `doScanLocked` (`mjs:1013-1121`):

- `worktree` (before `preparePublishWorktree`, `mjs:1039`)
- `convert` (before `convert`, `mjs:1052`)
- `illustrate` (before `illustrate`, `mjs:1067`)
- `build-gate` (before `buildGate`, `mjs:1073`)
- `push` (before `git push`, `mjs:1096`)
- `pr-create` (before `gh pr create`, `mjs:1101`)
- `preview-gate` (set by `gg-preview-gate.mjs` via a claim patch, or by the tick before invoking it)

These overwrite the transient `status:'active'` claim with stage metadata; the existing terminal writes (`pushed-preview`/`needs_human`/`dry-run-ok`) still set `status` as before.

**Step 5: Add `--stale-report` (read-only)**

Add `--stale-report` to `parseArgs` (`mjs:160-181`) and a `doStaleReport()` that loads claims and prints (JSON) any `active`/`pushed-preview`/`verified-preview` claim with `claimIsStale(claim) === true`. **No mutation** — pure read, no claims lock write.

**Step 6: Run tests**

```bash
node --test tools/scripts/__tests__/gg-seo-autopilot.smoke.test.mjs
```

Expected: PASS.

**Step 7: Commit**

```bash
git add tools/scripts/gg-seo-autopilot.mjs tools/scripts/__tests__/gg-seo-autopilot.smoke.test.mjs
git commit -m "feat: add autopilot claim lease heartbeats on publish stages + --stale-report"
```

---

### Task 1: Add Mac Mini Runtime Preflight (lands LAST among live-tick edits)

**Status:** needs-correction. **Critical ordering:** land this AFTER the deterministic gate (Task 7) and ONLY after confirming it passes `existsSync` on awayer_mini. As written in v0.1 it would `exit(2)` + Feishu-alert on **every** fire and take the working cron down, because its default paths (`~/Code/...`) do not exist here.

**Files:**
- Create: `tools/scripts/gg-autopilot-preflight.mjs`
- Modify: `tools/scripts/gg-seo-autopilot-tick.sh`
- Test: `tools/scripts/__tests__/gg-autopilot-preflight.smoke.test.mjs`

**Step 1: Write the failing test**

Create `tools/scripts/__tests__/gg-autopilot-preflight.smoke.test.mjs` with tests for required env/path checks.

```js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = new URL('../gg-autopilot-preflight.mjs', import.meta.url).pathname;

test('preflight fails with actionable missing path errors', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GG_FLOW_REPO: '/definitely/missing/flow',
      GG_OPS_DIR: '/definitely/missing/ops',
      GG_ORACLE_DIR: '/definitely/missing/oracle',
      PATH: process.env.PATH || '',
    },
  });
  assert.notEqual(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.includes('GG_FLOW_REPO')));
  assert.ok(out.errors.some((e) => e.includes('GG_OPS_DIR')));
  assert.ok(out.errors.some((e) => e.includes('GG_ORACLE_DIR')));
});

test('preflight passes when required directories and fake bins exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'gg-preflight-'));
  const bin = join(root, 'bin');
  const flow = join(root, 'flow');
  const ops = join(root, 'ops');
  const oracle = join(root, 'oracle');
  for (const d of [bin, flow, ops, oracle]) mkdirSync(d);
  for (const name of ['node', 'git', 'gh', 'claude', 'codex']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  const r = spawnSync(process.execPath, [SCRIPT, '--json', '--skip-live-cli'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GG_FLOW_REPO: flow,
      GG_OPS_DIR: ops,
      GG_ORACLE_DIR: oracle,
      PATH: `${bin}:${process.env.PATH || ''}`,
      VERCEL_AUTOMATION_BYPASS_SECRET: 'test-secret',
    },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
});

test('preflight defaults resolve to ~/oracle and ~/gengrowth-ops (no Code segment)', () => {
  // With no GG_* overrides, dirs printed in the JSON must be HOME/oracle and HOME/gengrowth-ops.
  const r = spawnSync(process.execPath, [SCRIPT, '--json', '--skip-live-cli'], { encoding: 'utf8' });
  const out = JSON.parse(r.stdout);
  assert.ok(out.dirs.GG_ORACLE_DIR.endsWith('/oracle'));
  assert.ok(!out.dirs.GG_ORACLE_DIR.includes('/Code/'));
  assert.ok(out.dirs.GG_OPS_DIR.endsWith('/gengrowth-ops'));
  assert.ok(!out.dirs.GG_OPS_DIR.includes('/Code/'));
});
```

**Step 2: Run the test to verify it fails**

```bash
node --test tools/scripts/__tests__/gg-autopilot-preflight.smoke.test.mjs
```

Expected: FAIL because `tools/scripts/gg-autopilot-preflight.mjs` does not exist.

**Step 3: Implement the preflight script (CORRECTED defaults)**

Create `tools/scripts/gg-autopilot-preflight.mjs`. **The defaults must match `gg-seo-autopilot.mjs:64,66` exactly — `~/oracle` and `~/gengrowth-ops`, NO `Code` segment.** Best practice: import the default-resolution from a shared lib so they can't drift; minimally, hardcode the same values.

```js
#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const HOME = homedir();
const args = new Set(process.argv.slice(2));
const json = args.has('--json');
const skipLiveCli = args.has('--skip-live-cli');

const requiredDirs = {
  GG_FLOW_REPO: process.env.GG_FLOW_REPO || join(HOME, 'gengrowth-flow-mvp'),
  GG_OPS_DIR: process.env.GG_OPS_DIR || join(HOME, 'gengrowth-ops'),   // NO 'Code'
  GG_ORACLE_DIR: process.env.GG_ORACLE_DIR || join(HOME, 'oracle'),     // NO 'Code'
};

function commandExists(name) {
  for (const dir of String(process.env.PATH || '').split(':')) {
    if (dir && existsSync(join(dir, name))) return true;
  }
  return false;
}

const errors = [];
const warnings = [];
for (const [key, value] of Object.entries(requiredDirs)) {
  if (!existsSync(value)) errors.push(`${key} missing: ${value}`);
}
for (const cmd of ['node', 'git', 'gh', 'claude', 'codex']) {
  if (!commandExists(cmd)) errors.push(`command not in PATH: ${cmd}`);
}
if (!process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
  warnings.push('VERCEL_AUTOMATION_BYPASS_SECRET is not exported; preview verification may fail unless _gg.env is sourced later');
}
if (!skipLiveCli && commandExists('claude')) {
  const r = spawnSync('claude', ['-p', 'Return exactly: OK'], { encoding: 'utf8', timeout: 60000, env: process.env });
  if (r.status !== 0 || !String(r.stdout || '').includes('OK')) {
    errors.push(`claude CLI smoke failed: ${String(r.stderr || r.stdout || r.error?.message || '').slice(-200)}`);
  }
}

const result = { ok: errors.length === 0, dirs: requiredDirs, errors, warnings };
if (json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
else {
  process.stdout.write(result.ok ? 'preflight: ok\n' : 'preflight: failed\n');
  for (const e of errors) process.stdout.write(`ERROR ${e}\n`);
  for (const w of warnings) process.stdout.write(`WARN ${w}\n`);
}
process.exit(result.ok ? 0 : 2);
```

**Step 4: Confirm it passes on awayer_mini BEFORE wiring into the tick**

```bash
set -a; . "$HOME/.config/gg/_gg.env" 2>/dev/null; set +a
node tools/scripts/gg-autopilot-preflight.mjs --json
```

Expected on awayer_mini: `ok: true` (dirs `~/oracle`, `~/gengrowth-ops`, `~/gengrowth-flow-mvp` all exist; `node`/`git`/`gh`/`claude`/`codex` on PATH). **Do not proceed to Step 5 unless this prints `ok: true`.**

**Step 5: Wire preflight into the tick (only after Step 4 is green)**

In `tools/scripts/gg-seo-autopilot-tick.sh`, after env loading and before the loop begins:

```bash
(
  set -a; . "$HOME/.config/gg/_gg.env" 2>/dev/null; set +a
  node "$SCRIPT_DIR/gg-autopilot-preflight.mjs" >> "$LOG" 2>&1
) || {
  GG_LARK_NOTIFY_AT_OPS=1 "$SCRIPT_DIR/gg-lark-notify.sh" "⚠️ SEO autopilot preflight failed on awayer_mini. See $LOG"
  exit 2
}
```

Plist install note (no machine hardcoding):

```xml
<!-- awayer_mini install: GG_FLOW_REPO/GG_OPS_DIR/GG_ORACLE_DIR default to ~/gengrowth-flow-mvp, ~/gengrowth-ops, ~/oracle. Override in ~/.config/gg/_gg.env only if the layout differs. -->
```

Do not hard-code `/Users/awayer_mini` for the current machine.

**Step 6: Run test to verify it passes**

```bash
node --test tools/scripts/__tests__/gg-autopilot-preflight.smoke.test.mjs
```

Expected: PASS.

**Step 7: Commit**

```bash
git add tools/scripts/gg-autopilot-preflight.mjs tools/scripts/gg-seo-autopilot-tick.sh tools/scripts/__tests__/gg-autopilot-preflight.smoke.test.mjs
git commit -m "chore: add seo autopilot runtime preflight (~/oracle defaults)"
```

---

### Task 10: End-to-End Verification on Pending Articles (publish leg)

**Status:** needs-correction. The v0.1 "author → phase2 → preview gate → merge" criterion is structurally impossible **while the machine is still publish-only** (`tick.sh:126`, `mjs:1287`). Re-scope the **publish-node acceptance** to: **three real previews pass `gg-preview-gate.mjs` → merge without manual intervention.** The full author→publish chain is validated separately in Task 11 (the cutover), once `full` mode is live.

**Files:**
- No code changes unless a defect is found.
- Artifacts checked:
  - `_staging/<PG>-en.md`
  - `_staging/<PG>-en.manifest.json`
  - `/Users/awayer_mini/gengrowth-ops/inbox/06-tasks/tasks/.autopilot-claims.json`
  - oracle PR (`xdawayer/oracle`)

**Step 1: Run preflight (awayer_mini defaults — no wzb overrides)**

```bash
set -a; . "$HOME/.config/gg/_gg.env"; set +a
node tools/scripts/gg-autopilot-preflight.mjs
```

Expected: PASS.

**Step 2: Run a dry-run gate on an existing pushed preview**

```bash
node tools/scripts/gg-preview-gate.mjs \
  --branch seo/auto/2026-06-12-PG-WC-001 \
  --dry-run \
  --json
```

Expected: No merge. Evidence shows what would be checked.

**Step 3: Run one real gate only after the dry-run is clean**

```bash
node tools/scripts/gg-preview-gate.mjs \
  --branch seo/auto/2026-06-12-PG-WC-001
```

Expected:

- If all gates pass: claim moves to `done` through the existing `--merge` flow (`mjs:1123`).
- If a blocker exists: claim moves to `needs_human` with a specific reason and a Feishu alert (issued by the gate itself).

**Step 4: Run the smoke-test suite**

```bash
node --test tools/scripts/__tests__/gg-preview-wait.smoke.test.mjs
node --test tools/scripts/__tests__/gg-preview-verify.smoke.test.mjs
node --test tools/scripts/__tests__/gg-article-review-worker.smoke.test.mjs
node --test tools/scripts/__tests__/gg-preview-gate.smoke.test.mjs
node --test tools/scripts/__tests__/gg-tick-rollback.smoke.test.mjs
node --test tools/scripts/__tests__/gg-autopilot-preflight.smoke.test.mjs
node --test tools/scripts/__tests__/gg-seo-autopilot.smoke.test.mjs
# authoring-leg tests below land with Tasks 2/3:
node --test tools/scripts/__tests__/lib-llm-worker.smoke.test.mjs
node --test tools/scripts/__tests__/gg-author-repair.smoke.test.mjs
```

Expected: PASS.

**Step 5: Acceptance gate**

After **three real previews** pass `gg-preview-gate.mjs` → merge without manual intervention, the deprecated prompt gate file may be deleted (its rollback branch is retired with it, or kept one more release — operator's call).

**Step 6: Commit any verification fixes**

```bash
git status --short
git diff
git add <fixed-files>
git commit -m "fix: stabilize oauth cli autopilot publish-gate verification"
```

---

### Task 9: Update Operational Documentation

**Status:** still-valid; **write LAST** (after the re-scope and cutover) or it codifies the same errors.

**Files:**
- Create: `docs/2026-06-13-oauth-cli-worker-autopilot-runbook.md`
- Modify: `docs/HANDBOOK.md` only if the new runbook becomes the canonical current operation note

**Step 1: Draft runbook**

Document:

- The **consolidation** to a single machine (awayer_mini authors AND publishes; wzb no longer writes).
- `GG_AUTOPILOT_MODE` history: `publish-only` was the interim mode during the rebuild; `full` is the post-cutover operating mode (Task 11). How to flip it and how to roll back.
- The **two co-resident crons**: Lane B (`com.gengrowth.seo-autopilot.plist`, oracle/astrologywiki.com — this plan's lane) and Lane A (`com.gengrowth.gengrowth-publish.plist`, gengrowth.ai → Supabase). Make every "the cron on this machine" reference unambiguous.
- Corrected paths everywhere: `~/oracle`, `~/gengrowth-ops`, ledger `/Users/awayer_mini/gengrowth-ops/inbox/06-tasks/tasks/.autopilot-claims.json`.
- What still uses the OAuth CLI (authoring + review workers), and what no longer uses Claude as total controller (the publish gate).
- The **real** `GG_USE_PROMPT_PREVIEW_GATE=1` hot rollback (now wired) and the `git revert <gate-commit>` cold rollback.
- How to install on awayer_mini, run preflight, force one safe dry-run, handle `needs_human`, and inspect stale leases (`--stale-report`).

**Step 2: Obsidian metadata**

```yaml
---
title: OAuth CLI Worker Autopilot Runbook
date: 2026-06-18
updated: 2026-06-18
type: note
tags:
  - seo-autopilot
  - runbook
aliases:
  - OAuth CLI Worker Runbook
---
```

**Step 3: Verify docs**

```bash
rg -n "seo-autopilot-tick.prompt|gg-preview-gate|GG_USE_PROMPT_PREVIEW_GATE|GG_AUTHOR_REPAIR|GG_AUTOPILOT_MODE|gengrowth-publish|OAuth CLI" docs tools/scripts
```

Expected: References show the old prompt gate is deprecated/behind the rollback flag, the rollback flag is wired, both crons are named, and paths are awayer_mini.

**Step 4: Commit**

```bash
git add docs/2026-06-13-oauth-cli-worker-autopilot-runbook.md docs/HANDBOOK.md
git commit -m "docs: document consolidated oauth cli worker autopilot"
```

---

### Task 2: Introduce an OAuth CLI Worker Contract (authoring leg, on this machine, still off-cron)

**Status:** needs-correction. With consolidation, this is in scope **here** — but authoring is still off-cron until the Task 11 cutover, so this changes no live-cron behavior when it lands. The orchestrator's claude path is **already worker-shaped/clean** (`mjs:72-77`: `['-p','--model','--effort']`, no `--allowedTools`/skip-permissions), so this task changes **no security posture**; it is a testability refactor. Fix four real defects from v0.1.

**Files:**
- Create: `tools/scripts/lib/llm-worker.mjs`
- Modify: `tools/scripts/gg-llm-orchestrator.mjs`
- Test: `tools/scripts/__tests__/lib-llm-worker.smoke.test.mjs`

**Defects to fix vs v0.1:**

- **(a) Codex argv parity.** Real argv is `['exec','-c','model=gpt-5.5','-c',\`reasoning_effort=${effort}\`,'-']` (`mjs:78-84`), model **hardcoded** `gpt-5.5`, effort from `GG_CODEX_EFFORT || 'xhigh'`. v0.1's `'-s read-only'` and `opts.codexModelConfig` are **fabricated** — do not emit them.
- **(b) Gemini branch.** `buildWorkerCommand` must also handle `gemini` (`['--model','gemini-2.5-pro']`, `stdinFromFile`/`stdoutToFile`) — the orchestrator still iterates `{claude,codex,gemini}` and the diversify path (`mjs:62`) routes through it. Without it, a `--models gemini` or diversify run throws.
- **(c) Not a 1:1 `runAttempt` replacement.** `runAttempt` (`mjs:273-425`) carries load-bearing guards that must be **migrated, not dropped**: the NAKSH-001 CPU-stall watchdog + detached process-group kill (`mjs:310-342`), the Claude downgrade/short-output guard (`detectClaudeDowngrade`), and the Sonnet→Opus rate-limit fallback (`mjs:505-536`, `isRateLimited`). Decide explicitly which guards move into `lib/llm-worker.mjs` vs stay in the orchestrator. Safer option: keep `runAttempt` and adopt only `buildWorkerCommand` for argv.
- **(d) Trim ownership.** `stripPreH1` (`lib/strip-preamble.mjs`) returns a **trailing newline**; the worker test asserts no trailing newline. Either `runTextWorker` does `.trimEnd()` on the stripped output (and you accept the `_staging` byte change vs `CLAUDE_OPUS_MIN_BYTES`, `mjs:212`), or the test expects `'\n'`. **Recommendation:** keep current orchestrator bytes (no trim) and have the test expect the trailing newline, to avoid perturbing `CLAUDE_OPUS_MIN_BYTES` and phase2 manifests.

**Step 1: Write the failing test**

Create `tools/scripts/__tests__/lib-llm-worker.smoke.test.mjs`.

```js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runTextWorker, buildWorkerCommand } from '../lib/llm-worker.mjs';

test('buildWorkerCommand keeps claude in text-only mode', () => {
  const cmd = buildWorkerCommand('claude', { claudeModel: 'claude-sonnet-4-6', claudeEffort: 'high' });
  assert.equal(cmd.bin, 'claude');
  assert.deepEqual(cmd.args, ['-p', '--model', 'claude-sonnet-4-6', '--effort', 'high']);
  assert.ok(!cmd.args.includes('--allowedTools'));
  assert.ok(!cmd.args.includes('--dangerously-skip-permissions'));
});

test('buildWorkerCommand emits real codex argv (no -s read-only, hardcoded gpt-5.5)', () => {
  const cmd = buildWorkerCommand('codex', { codexEffort: 'xhigh' });
  assert.equal(cmd.bin, 'codex');
  assert.deepEqual(cmd.args, ['exec', '-c', 'model=gpt-5.5', '-c', 'reasoning_effort=xhigh', '-']);
  assert.ok(!cmd.args.includes('-s'));
});

test('buildWorkerCommand handles gemini', () => {
  const cmd = buildWorkerCommand('gemini', {});
  assert.equal(cmd.bin, 'gemini');
  assert.deepEqual(cmd.args, ['--model', 'gemini-2.5-pro']);
});

test('runTextWorker writes stdout to output and strips pre-H1 prose (keeps trailing newline)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gg-worker-'));
  const binDir = join(root, 'bin');
  mkdirSync(binDir);
  writeFileSync(join(binDir, 'claude'), '#!/bin/sh\nprintf "meta\\n\\n# Title\\n\\nBody\\n"\n', { mode: 0o755 });
  const prompt = join(root, 'prompt.md');
  const output = join(root, 'out.md');
  writeFileSync(prompt, 'prompt');
  const r = await runTextWorker('claude', {
    promptPath: prompt, outputPath: output,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH || ''}` },
    timeoutMs: 10000, claudeModel: 'claude-sonnet-4-6', claudeEffort: 'high',
  });
  assert.equal(r.ok, true);
  // stripPreH1 keeps the trailing newline; runTextWorker does NOT trim (preserve orchestrator bytes).
  assert.equal(readFileSync(output, 'utf8'), '# Title\n\nBody\n');
});
```

**Step 2: Run the test to verify it fails**

```bash
node --test tools/scripts/__tests__/lib-llm-worker.smoke.test.mjs
```

Expected: FAIL because `tools/scripts/lib/llm-worker.mjs` does not exist.

**Step 3: Implement the worker module (reuse strip-preamble)**

Create `tools/scripts/lib/llm-worker.mjs`. Import `stripPreH1` from `./strip-preamble.mjs` (do not reimplement). `buildWorkerCommand`:

```js
export function buildWorkerCommand(model, opts = {}) {
  if (model === 'claude') {
    return { bin: 'claude', args: ['-p', '--model', opts.claudeModel, '--effort', opts.claudeEffort] };
  }
  if (model === 'codex') {
    const effort = opts.codexEffort || process.env.GG_CODEX_EFFORT || 'xhigh';
    return { bin: 'codex', args: ['exec', '-c', 'model=gpt-5.5', '-c', `reasoning_effort=${effort}`, '-'] };
  }
  if (model === 'gemini') {
    return { bin: 'gemini', args: ['--model', 'gemini-2.5-pro'] };
  }
  throw new Error(`unknown worker model: ${model}`);
}
```

Rules: no `--allowedTools`, no `--dangerously-skip-permissions`, no MCP config, no write-target paths exposed to the model except stdout capture (the caller writes files). `runTextWorker` writes `stripPreH1(stdout)` to `outputPath` (no trim — preserve current orchestrator bytes).

**Step 4: Update the orchestrator to use the worker (carefully)**

In `tools/scripts/gg-llm-orchestrator.mjs`:

- Import `buildWorkerCommand` (and `runTextWorker` if you route through it).
- **Preserve** all four guards from defect (c). Safest: have `buildCommand` (`mjs:66-97`) delegate argv to `buildWorkerCommand` while `runAttempt` keeps the watchdog/process-group-kill/downgrade/rate-limit-fallback logic.
- Preserve output filenames: `_staging/<pageId>-claude-v8.md` / `-codex-v8.md` / `-gemini-v8.md` (`mjs:462`) and the diversify name `<pageId>-<model>-then-<escalated>-v8.md` (`mjs:543`). **Cross-site invariant:** these must keep matching `gg-gengrowth-publish.mjs:35` `DRAFT_RE` (`^(PG-<W25prefix>-\d+)-[a-z0-9]+-v8\.md$`). Add a regression assertion (Step 5).
- Preserve the summary JSON shape (`<pageId>-orchestrator.json`, `mjs:695`).
- Ensure callers pass `claudeModel=GG_CLAUDE_MODEL||'claude-sonnet-4-6'` and `claudeEffort=GG_CLAUDE_EFFORT||'high'`, or default behavior silently changes to `undefined --model`.

**Step 5: Run targeted tests (incl. the cross-site filename invariant)**

```bash
node --test tools/scripts/__tests__/lib-llm-worker.smoke.test.mjs
node --test tools/scripts/__tests__/gg-content-draft.smoke.test.mjs
# regression: orchestrator output name still matches gg-gengrowth-publish DRAFT_RE
node --test tools/scripts/__tests__/lib-gengrowth-staging-contract.smoke.test.mjs
node tools/scripts/gg-llm-orchestrator.mjs --prompt .gg-cache/prompts/PG-WC-001.v8-prompt.md --page-id PG-WC-001 --models claude --out-dir /tmp/gg-worker-smoke --retry 0 --dry-run
```

> Add `lib-gengrowth-staging-contract.smoke.test.mjs`: import `DRAFT_RE` shape (or assert against `PG-WLS-001-claude-v8.md`) and assert the orchestrator's `<pageId>-<model>-v8.md` naming matches it. This is the cross-site landmine guard.

Expected: worker tests PASS; content-draft tests PASS; the staging-contract regression PASSES; dry-run still prints `claude -p --model ... --effort ... < prompt > output`.

**Step 6: Commit**

```bash
git add tools/scripts/lib/llm-worker.mjs tools/scripts/gg-llm-orchestrator.mjs \
  tools/scripts/__tests__/lib-llm-worker.smoke.test.mjs \
  tools/scripts/__tests__/lib-gengrowth-staging-contract.smoke.test.mjs
git commit -m "refactor: constrain llm cli calls to text workers (codex/gemini parity, strip-preamble reuse)"
```

---

### Task 3: Replace Agentic Rescue With Deterministic Repair (authoring leg, on this machine)

**Status:** real, correct security win — removes an unattended `claude -p ... --allowedTools 'Bash Read Edit Write Grep' --dangerously-skip-permissions` agent (`mjs:984-1002`, guarded by `GG_AUTHOR_AGENTIC_RESCUE`). It fires only inside `doAuthor`, which publish-only mode hard-refuses (`mjs:1287`), so it is **dormant until the Task 11 cutover** — do NOT let it gate Task 7. With consolidation it is in scope here and should land before authoring goes live in cron.

**Files:**
- Create: `tools/scripts/gg-author-repair.mjs`
- Modify: `tools/scripts/gg-seo-autopilot.mjs`
- Test: `tools/scripts/__tests__/gg-author-repair.smoke.test.mjs`

**Step 1: Write the failing test**

Create `tools/scripts/__tests__/gg-author-repair.smoke.test.mjs`.

```js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const SCRIPT = new URL('../gg-author-repair.mjs', import.meta.url).pathname;

test('author repair writes candidate only, never edits source directly', () => {
  const root = mkdtempSync(join(tmpdir(), 'gg-repair-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nprintf "# Fixed\\n\\nBetter article\\n"\n', { mode: 0o755 });
  const source = join(root, 'draft.md');
  const out = join(root, 'candidate.md');
  writeFileSync(source, '# Broken\n\nBad article\n');
  const r = spawnSync(process.execPath, [SCRIPT,
    '--source', source, '--out', out,
    '--page-id', 'PG-TEST-001', '--target-keyword', 'test keyword',
    '--failures', '- RL4 failed', '--model', 'claude-sonnet-4-6', '--effort', 'high',
  ], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH || ''}` } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(source, 'utf8'), '# Broken\n\nBad article\n'); // source untouched
  assert.equal(readFileSync(out, 'utf8'), '# Fixed\n\nBetter article\n');  // candidate written (strip-preamble keeps trailing \n)
  assert.ok(!r.stderr.includes('--allowedTools'));
});
```

**Step 2: Run the test to verify it fails**

```bash
node --test tools/scripts/__tests__/gg-author-repair.smoke.test.mjs
```

Expected: FAIL because `gg-author-repair.mjs` does not exist.

**Step 3: Implement deterministic repair**

Create `tools/scripts/gg-author-repair.mjs`. Behavior:

- Read source draft.
- Build a repair prompt from source + target keyword + author + phase2 failures.
- Call `runTextWorker('claude', ...)` (text-only — no tools, no MCP, no skip-permissions).
- Write only `--out` (apply `stripPreH1`; keep the trailing newline to match orchestrator bytes).
- Never run phase2 internally. Never edit `--source`.

CLI contract:

```bash
node tools/scripts/gg-author-repair.mjs \
  --source _staging/PG-X-claude-v8.md \
  --out _staging/PG-X-repair-candidate.md \
  --page-id PG-X \
  --target-keyword "..." \
  --author marcus-orion \
  --failures /tmp/failures.txt
```

Prompt rule:

```text
Output the complete corrected article only. Do not describe your changes.
Keep the exact H1/H2 structure unless the failure explicitly says a section is missing.
Do not add tools, commands, or meta commentary.
```

**Step 4: Wire repair into autopilot (replace the agentic block)**

In `tools/scripts/gg-seo-autopilot.mjs`, replace the `GG_AUTHOR_AGENTIC_RESCUE` block (`mjs:984-1002`) with deterministic repair:

```js
if (process.env.GG_AUTHOR_REPAIR !== '0' && existsSync(join(FLOW, draftV8))) {
  const candidate = join('_staging', `${pgId}-repair-candidate.md`);
  shFlow('node', [
    join(SCRIPTS, 'gg-author-repair.mjs'),
    '--source', draftV8, '--out', candidate,
    '--page-id', pgId, '--target-keyword', keyword,
    '--author', author, '--failures', lastFail || '- phase2 failed',
  ], parseInt(process.env.GG_AUTHOR_REPAIR_TIMEOUT_MS || '1800000', 10));
  try {
    shFlow('node', [PHASE2, '--source', candidate, '--page-id', pgId, '--tag', 'en', '--author', author]);
    if (existsSync(enDraft(pgId)) && phase2Passed(pgId)) {
      log(`AUTHORED ${pgId} -> ${enDraft(pgId)} (via deterministic repair)`);
      return;
    }
  } catch {
    log('deterministic repair candidate failed phase2');
  }
}
```

Remove the unattended `claude -p ... --allowedTools Bash Read Edit Write Grep --dangerously-skip-permissions` invocation entirely.

**Step 5: Run targeted tests**

```bash
node --test tools/scripts/__tests__/gg-author-repair.smoke.test.mjs
node --test tools/scripts/__tests__/gg-seo-autopilot.smoke.test.mjs
```

Expected: PASS.

**Step 6: Commit**

```bash
git add tools/scripts/gg-author-repair.mjs tools/scripts/gg-seo-autopilot.mjs tools/scripts/__tests__/gg-author-repair.smoke.test.mjs
git commit -m "fix: replace agentic rescue with deterministic repair"
```

---

### Task 8b: Authoring-Stage Heartbeats (lands with the cutover)

**Status:** the authoring-stage half of Task 8, now in scope on this machine but only meaningful once authoring runs in cron (Task 11). Add `heartbeatClaim(claims, pgId, { stage })` before the long `doAuthor` stages: `sheet-pull`, `gbrain-rag`, `entity-passport`, `render`, `llm-generate`, `phase2`, `review`, `repair`. Reuse the helpers from Task 8. Land alongside or immediately before the cutover so authoring claims are observable from the first `full`-mode fire.

**Files:** Modify `tools/scripts/gg-seo-autopilot.mjs`; extend `gg-seo-autopilot.smoke.test.mjs`.

**Commit:**

```bash
git commit -m "feat: add authoring-stage claim heartbeats"
```

---

### Task 11: Cron-Authoring Cutover (publish-only → full) — LAST live change

**Status:** the live cutover. Everything deterministic (Tasks 4/5/6/7/8/1/10) and the authoring leg (Tasks 2/3/8b) must be built, tested, and verified FIRST. Only then flip `GG_AUTOPILOT_MODE` from `publish-only` to `full` so cron authors again on awayer_mini.

> **Why last:** flipping to `full` re-enables `doAuthor` in cron — the exact path the publish-only mode was introduced to suppress (the ~40% nested-`claude -p` hang documented in `docs/FLOW-content-production-to-vault.md`). It is only safe AFTER Task 3 has removed the agentic rescue and Task 2 has the worker contract, so the author leg no longer spawns an unconstrained nested agent.

**Files:**
- Modify: `~/Library/LaunchAgents/com.gengrowth.seo-autopilot.plist` (operator action — set `GG_AUTOPILOT_MODE=full`, or remove the override to use the tick's `:-full` default)
- No repo code change required (the tick already branches on `MODE`, `tick.sh:38,126`).

**Step 1: Pre-cutover checklist (all must be green)**

- Tasks 4/5/6/7 landed; three real previews passed `gg-preview-gate.mjs` → merge (Task 10 acceptance).
- Task 3 landed: no `--allowedTools`/`--dangerously-skip-permissions` anywhere in the author path (`rg --allowedTools tools/scripts/gg-seo-autopilot.mjs` returns nothing).
- Task 2 landed: orchestrator worker contract + cross-site filename regression green.
- Task 8b landed: authoring-stage heartbeats present.
- Preflight (Task 1) green on awayer_mini.

**Step 2: Flip the mode (reversible)**

Set `GG_AUTOPILOT_MODE=full` in the loaded plist (or `_gg.env`). Keep `GG_USE_PROMPT_PREVIEW_GATE` unset (deterministic gate). Reload launchd.

**Step 3: Observe the first full-mode fire**

Watch `$LOG` for: an author attempt that completes via the orchestrator worker + deterministic repair (no nested-agent hang), then `--scan` → preview → gate → merge. Confirm `--stale-report` shows live authoring-stage heartbeats during the author leg.

**Step 4: Cutover acceptance**

At least one real article passes the FULL chain (author → phase2 → preview gate → merge) in cron without manual intervention and without a nested-`claude` hang.

**Rollback:** set `GG_AUTOPILOT_MODE=publish-only` (instant return to publish-only); or `GG_USE_PROMPT_PREVIEW_GATE=1` for the gate specifically; both are reversible in `_gg.env`.

---

### Task 12: Actively Improve gengrowth.ai Lane A (with regression-tested invariants)

**Status:** in scope (operator decision). Lane A (`com.gengrowth.gengrowth-publish.plist` → `gg-gengrowth-publish.mjs --apply` → Supabase `blog_posts`) is to be actively improved, not just guarded. It shares **zero** code with the Lane B scripts (verified: `gg-gengrowth-publish.mjs` / `gg-md-to-gengrowth-blog.mjs` import none of `{gg-llm-orchestrator, gg-seo-autopilot, gg-author-review, llm-worker, strip-preamble}`), so improvements here cannot regress Lane B.

**Non-negotiable invariants (regression-tested, shared with Tasks 2 & 7):**

- **Staging contract:** Lane A's `DRAFT_RE` (`gg-gengrowth-publish.mjs:35`, `^(PG-<W25prefix>-\d+)-[a-z0-9]+-v8\.md$`) must keep matching the orchestrator's `<pageId>-<model>-v8.md` output. Backed by `lib-gengrowth-staging-contract.smoke.test.mjs` (Task 2 Step 5).
- **Manifest gate:** Lane A only publishes drafts whose sibling `.manifest.json` has `phase2_checks.overall === 'pass'` (`gg-gengrowth-publish.mjs:64-67`) — preserve this.
- **Plan isolation:** the Lane B `latestPlan` gengrowth filter (`mjs:197`) must remain so the oracle autopilot never claims a gengrowth W25 task. Backed by the regression test added in Task 7 Step 5.

**Improvement scope (to be specified during execution — examples, pick per priority):**

- Add a Lane A **preview/verify step** analogous to Task 5 (if gengrowth.ai gains a preview deployment), reusing `gg-preview-verify.mjs` with a gengrowth-specific URL shape via `lib/site-profile.mjs`.
- Add **lease/stale observability** to Lane A's ticker mirroring Task 8 (`--stale-report` for gengrowth claims) if Lane A grows a claims ledger.
- Harden Lane A's `SB_KEY`-missing fail-safe and Feishu alerting parity with Lane B.

**Files:** `tools/scripts/gg-gengrowth-publish.mjs`, `tools/scripts/gg-gengrowth-publish-tick.sh`, `tools/scripts/lib/site-profile.mjs`, plus new `tools/scripts/__tests__/lib-gengrowth-staging-contract.smoke.test.mjs`.

**Step 1: Land the invariant regression tests FIRST** (they double as the Task 2/Task 7 guards). **Step 2:** then iterate on the chosen improvement with its own smoke test. **Step 3:** commit per-improvement.

```bash
git commit -m "feat(gengrowth): <improvement> + staging-contract regression"
```

---

## Rollback Plan

If the new deterministic gate (Lane B) misbehaves unexpectedly:

1. **Hot rollback (now real):** set `GG_USE_PROMPT_PREVIEW_GATE=1` in `~/.config/gg/_gg.env`. The `publish_if_pending()` rollback branch (wired in Task 7) re-selects the legacy `claude -p` prompt gate on the next fire. Backed by `gg-tick-rollback.smoke.test.mjs`.
2. **Cold rollback:** `git revert <Task-7 gate-wiring commit>` to fully remove the node gate wiring; keep preflight, preview-wait/verify, review workers, and lease heartbeats (they are additive and safe).
3. **Cutover rollback:** set `GG_AUTOPILOT_MODE=publish-only` to instantly stop cron authoring (returns to the verified publish-only behavior).
4. Keep agentic rescue retired (Task 3): do not re-enable unattended file-editing rescue.
5. Use `gg-seo-autopilot.mjs --mark-failed` (idempotent via the gate's status check) to park a branch rather than forcing a merge.

## Success Criteria

- Cron's **default** path no longer calls `claude -p "$(cat seo-autopilot-tick.prompt.md)"`; the only path that does is the explicit `GG_USE_PROMPT_PREVIEW_GATE=1` rollback branch, and a smoke test proves the flag selects it.
- OAuth CLI remains the default writer/reviewer path.
- No unattended `claude -p` invocation in the **default** path includes `--allowedTools`, `Edit`, `Write`, `Bash`, MCP, or `--dangerously-skip-permissions`.
- The agentic rescue (`--allowedTools 'Bash Read Edit Write Grep' --dangerously-skip-permissions`) is removed from the author path (Task 3).
- A failed article has a specific stage and reason (lease `stage` + `--mark-failed --reason`), not just "Claude failed", and the gate self-issues a Feishu alert on failure.
- A stale or long-running publish job shows `stage`, `lockedBy`, `leaseUntil`, and `updatedAt` via `--stale-report`.
- **Publish-leg acceptance:** at least three real previews pass `gg-preview-gate.mjs` → merge without manual intervention (Task 10).
- **Cutover acceptance:** after the flip to `full` (Task 11), at least one real article passes author → phase2 → preview gate → merge in cron without a nested-`claude` hang.
- **Cross-site invariants hold:** `latestPlan` never selects a gengrowth plan; the orchestrator's `*-v8.md` staging names still match `gg-gengrowth-publish.mjs:35` `DRAFT_RE`; Lane A's manifest `overall==='pass'` gate is intact — all regression-tested.
- All paths/examples use awayer_mini layout (`~/oracle`, `~/gengrowth-ops`); no `~/Code/*` or `/Users/wzb/*` literals remain.

## Changelog vs v0.1

What the 2026-06-18 audit (+ operator scope decisions) changed:

- **Machine identity / paths (critical):** v0.1 targeted wzb's machine. v0.2 retargets **awayer_mini**. Every `~/Code/oracle`, `~/Code/gengrowth-ops`, `/Users/wzb/Code/*` replaced with `~/oracle` + `~/gengrowth-ops` (the real `gg-seo-autopilot.mjs:64,66` defaults). Preflight defaults corrected (no `Code` segment); all manual-run examples drop the wzb overrides; ledger path → `/Users/awayer_mini/gengrowth-ops/...`.
- **Consolidation (scope decision 1):** the two-machine split is **retired**. awayer_mini now does authoring AND publishing; all 10 original tasks are in scope here. Added **Task 11 (cron-authoring cutover)** — flipping `GG_AUTOPILOT_MODE` from `publish-only` to `full` is the LAST live change, after every deterministic + authoring piece is built and verified. Added **Task 8b** (authoring-stage heartbeats) to land with the cutover.
- **Second site (scope decision 2):** added **Task 12** to actively improve gengrowth.ai Lane A, plus two **regression-tested invariants** (preserve the `PG-<prefix>-<llm>-v8.md` staging contract; keep the `latestPlan` gengrowth filter) wired into Tasks 2 and 7. v0.1 never mentioned Lane A at all.
- **Task 7 rollback (scope decision 3):** `GG_USE_PROMPT_PREVIEW_GATE` was vaporware in v0.1 (referenced only in the plan, read by no code). v0.2 makes it **real** — the rollback branch is implemented in `publish_if_pending()` **in the same commit** as the gate replacement, with a smoke test (`gg-tick-rollback.smoke.test.mjs`) asserting the flag selects the legacy prompt-gate path.
- **Task 7 edit target (correction):** v0.1's "find-and-replace one `claude -p` line" is wrong. v0.2 rewrites the **BODY of `publish_if_pending()`** (`tick.sh:88-109`), preserving the tri-state `0/1/2` return contract (consumed at `tick.sh:119-121`) and a hard `gtimeout` cap, with idempotent `--mark-failed` (guards the `mjs:1199` throw) and a self-issued `gg-lark-notify.sh` failure alert (`--mark-failed` does not notify).
- **Codex argv (correction):** v0.1's `['exec','-s','read-only','-c',opts.codexModelConfig,...]` is fabricated. v0.2 keeps the real `['exec','-c','model=gpt-5.5','-c',\`reasoning_effort=${effort}\`,'-']` (effort `GG_CODEX_EFFORT||'xhigh'`).
- **Playwright resolution (correction):** v0.1's bare dynamic `import('playwright')` throws `ERR_MODULE_NOT_FOUND` from flow-mvp. v0.2 resolves via `createRequire(join(GG_ORACLE_DIR,'/')).resolve('playwright')` + import the `file://` path, with a chromium self-check test. Also notes this **replaces** the `@playwright/mcp` npx path (retired with Task 7), not a refactor.
- **Task 8 lease fields (correction):** `lockedBy`/`leaseUntil`/`updatedAt` are **net-new** (entirely absent, not "partly present"); `stage` was only a park-time literal. v0.2 instruments the **publish** stages in `doScanLocked` (worktree/convert/illustrate/build-gate/push/pr-create) for the publish node, with authoring-stage heartbeats moved to Task 8b.
- **strip-preamble reuse + trim ownership (correction):** v0.2 reuses `lib/strip-preamble.mjs` and **keeps the trailing newline** (no trim) to avoid perturbing `CLAUDE_OPUS_MIN_BYTES` and phase2 manifests; the worker test expects `'# Title\n\nBody\n'`.
- **Task 2 not a 1:1 swap (correction):** v0.2 enumerates the load-bearing guards that must be migrated, not dropped — the NAKSH-001 CPU watchdog + detached process-group kill, the Claude downgrade guard, the Sonnet→Opus rate-limit fallback, and the gemini/diversify paths — and recommends keeping `runAttempt` while adopting only `buildWorkerCommand` for argv.
- **Preflight ordering (critical):** Task 1 moved to land **LAST among live-tick edits**, after confirming it passes `existsSync` on awayer_mini, so it can never `exit(2)` and take down the working cron.
- **Task 10 acceptance (correction):** re-scoped to publish-leg ("three real previews pass preview-gate → merge"); the full author→merge chain is validated in the Task 11 cutover, not on a publish-only machine.
- **Landing order:** `4 → 5 → 6 → 7 → 8 → 1 → 10 → 9 → 2 → 3 → 11(cutover) → 12(Lane A)` — deterministic publish leg first, authoring + cutover last.
- **Frontmatter:** version `v0.1 → v0.2`, status `draft`, owner `wzb → awayer_mini`, added `multisite` tag.

## Execution Handoff

Plan complete (v0.2 draft). It will be copied into `docs/plans/` only AFTER the in-progress live publish run finishes (this draft lives at the scratch path `/tmp/gg-landing-staging/2026-06-13-oauth-cli-worker-autopilot-plan.v0.2.md`).

Two execution options:

**1. Subagent-Driven** — Dispatch a fresh subagent per task, review between tasks, and iterate quickly.

**2. Parallel Session** — Open a new session with `superpowers:executing-plans`, then implement with checkpoints.

Recommended: Tasks 4/5/6 first (additive, zero live-tick risk), then pause for one real publish-gate dry-run before Task 7 (the live fix). Tasks 2/3/8b/11 (authoring + cutover) and Task 12 (Lane A) land only after the deterministic publish leg is proven on three real articles.
