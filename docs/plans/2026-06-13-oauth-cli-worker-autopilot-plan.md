---
title: OAuth CLI Worker Autopilot Implementation Plan
date: 2026-06-13
updated: 2026-06-13
type: plan
version: v0.1
status: draft
owner: wzb
tags:
  - seo-autopilot
  - oauth-cli
  - cron
  - reliability
aliases:
  - OAuth CLI Worker Autopilot Plan
  - SEO Autopilot OAuth CLI Worker Plan
---

# OAuth CLI Worker Autopilot Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep the low-cost OAuth/desktop-subscription LLM path for SEO article writing while making the cron autopilot deterministic, observable, and recoverable on the Mac mini.

**Architecture:** Cron/launchd runs a Node-owned state machine. LLM CLIs such as `claude -p` and `codex exec` remain the default writing/review transport, but they are constrained to pure worker mode: prompt in, Markdown/JSON out, no Bash/Edit/Write/MCP/merge side effects. All file writes, validation, retries, preview verification, PR state changes, and Feishu notifications are performed by deterministic scripts.

**Tech Stack:** Node.js ESM scripts, macOS launchd, existing Claude/Codex OAuth CLIs, GitHub CLI, Playwright, existing JSON claims ledger, existing Phase 2 validator, existing oracle publish worktree flow.

---

## Non-Negotiable Constraints

- Do not make paid API providers the default writing path.
- Preserve OAuth/CLI authoring as the primary cost-saving path.
- Do not let a headless LLM agent call `Bash`, `Edit`, `Write`, MCP, or merge PRs in unattended cron.
- Preserve current `_staging` outputs, phase2 manifests, claim statuses, branch naming, Feishu notifications, and publish register behavior.
- Keep changes incremental. First make the existing JSON claims flow safer; do not introduce SQLite in the first pass unless the JSON lease approach proves insufficient.

## Target State

Current fragile shape:

```text
launchd
  -> bash tick
    -> node deterministic steps
    -> claude -p as agentic total controller
       -> may call tools / MCP / subagents / merge decisions
```

Target shape:

```text
launchd
  -> bash tick
    -> node preflight
    -> node author runner
       -> claude/codex OAuth CLI worker for text only
       -> node writes candidate files
       -> node runs phase2
    -> node scan/push preview
    -> node preview wait
    -> node preview verify
    -> node review workers for JSON verdicts
    -> node mark verified / merge / notify
```

## Phase Order

1. Lock down the Mac mini runtime and preflight.
2. Wrap OAuth CLI calls behind a worker contract without changing default model behavior.
3. Replace agentic rescue with deterministic repair.
4. Script the preview verify/merge gate and retire `claude -p "$(cat seo-autopilot-tick.prompt.md)"` from unattended cron.
5. Improve claim lock/lease observability.

---

### Task 1: Add Mac Mini Runtime Preflight

**Files:**
- Create: `tools/scripts/gg-autopilot-preflight.mjs`
- Modify: `tools/scripts/gg-seo-autopilot-tick.sh`
- Test: `tools/scripts/__tests__/gg-autopilot-preflight.smoke.test.mjs`

**Step 1: Write the failing test**

Create `tools/scripts/__tests__/gg-autopilot-preflight.smoke.test.mjs` with tests for required env/path checks.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
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
  mkdirSync(bin);
  mkdirSync(flow);
  mkdirSync(ops);
  mkdirSync(oracle);
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
```

**Step 2: Run the test to verify it fails**

Run:

```bash
node --test tools/scripts/__tests__/gg-autopilot-preflight.smoke.test.mjs
```

Expected: FAIL because `tools/scripts/gg-autopilot-preflight.mjs` does not exist.

**Step 3: Implement the preflight script**

Create `tools/scripts/gg-autopilot-preflight.mjs`.

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
  GG_OPS_DIR: process.env.GG_OPS_DIR || join(HOME, 'Code', 'gengrowth-ops'),
  GG_ORACLE_DIR: process.env.GG_ORACLE_DIR || join(HOME, 'Code', 'oracle'),
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
  const r = spawnSync('claude', ['-p', 'Return exactly: OK'], {
    encoding: 'utf8',
    timeout: 60000,
    env: process.env,
  });
  if (r.status !== 0 || !String(r.stdout || '').includes('OK')) {
    errors.push(`claude CLI smoke failed: ${String(r.stderr || r.stdout || r.error?.message || '').slice(-200)}`);
  }
}

const result = {
  ok: errors.length === 0,
  dirs: requiredDirs,
  errors,
  warnings,
};

if (json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
else {
  process.stdout.write(result.ok ? 'preflight: ok\n' : 'preflight: failed\n');
  for (const e of errors) process.stdout.write(`ERROR ${e}\n`);
  for (const w of warnings) process.stdout.write(`WARN ${w}\n`);
}
process.exit(result.ok ? 0 : 2);
```

**Step 4: Wire preflight into the tick script**

In `tools/scripts/gg-seo-autopilot-tick.sh`, after env loading and before the loop begins, add:

```bash
(
  set -a; . "$HOME/.config/gg/_gg.env" 2>/dev/null; set +a
  node "$SCRIPT_DIR/gg-autopilot-preflight.mjs" >> "$LOG" 2>&1
) || {
  GG_LARK_NOTIFY_AT_OPERATOR=1 "$SCRIPT_DIR/gg-lark-notify.sh" "⚠️ SEO autopilot preflight failed on Mac mini. See $LOG"
  exit 2
}
```

Also update the plist installation note to require machine-local env:

```xml
<!-- Mac mini install must set GG_FLOW_REPO/GG_OPS_DIR/GG_ORACLE_DIR in ~/.config/gg/_gg.env. -->
```

Do not hard-code `/Users/awayer_mini` for the current machine.

**Step 5: Run test to verify it passes**

Run:

```bash
node --test tools/scripts/__tests__/gg-autopilot-preflight.smoke.test.mjs
```

Expected: PASS.

**Step 6: Commit**

```bash
git add tools/scripts/gg-autopilot-preflight.mjs tools/scripts/gg-seo-autopilot-tick.sh tools/scripts/__tests__/gg-autopilot-preflight.smoke.test.mjs
git commit -m "chore: add seo autopilot runtime preflight"
```

---

### Task 2: Introduce an OAuth CLI Worker Contract

**Files:**
- Create: `tools/scripts/lib/llm-worker.mjs`
- Modify: `tools/scripts/gg-llm-orchestrator.mjs`
- Test: `tools/scripts/__tests__/lib-llm-worker.smoke.test.mjs`

**Step 1: Write the failing test**

Create `tools/scripts/__tests__/lib-llm-worker.smoke.test.mjs`.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runTextWorker, buildWorkerCommand } from '../lib/llm-worker.mjs';

test('buildWorkerCommand keeps claude in text-only mode', () => {
  const cmd = buildWorkerCommand('claude', {
    claudeModel: 'claude-sonnet-4-6',
    claudeEffort: 'high',
  });
  assert.equal(cmd.bin, 'claude');
  assert.deepEqual(cmd.args, ['-p', '--model', 'claude-sonnet-4-6', '--effort', 'high']);
  assert.ok(!cmd.args.includes('--allowedTools'));
  assert.ok(!cmd.args.includes('--dangerously-skip-permissions'));
});

test('runTextWorker writes stdout to output and strips pre-H1 prose', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gg-worker-'));
  const binDir = join(root, 'bin');
  mkdirSync(binDir);
  const fake = join(binDir, 'claude');
  writeFileSync(fake, '#!/bin/sh\nprintf "meta\\n\\n# Title\\n\\nBody\\n"\n', { mode: 0o755 });
  const prompt = join(root, 'prompt.md');
  const output = join(root, 'out.md');
  writeFileSync(prompt, 'prompt');
  const r = await runTextWorker('claude', {
    promptPath: prompt,
    outputPath: output,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH || ''}` },
    timeoutMs: 10000,
    claudeModel: 'claude-sonnet-4-6',
    claudeEffort: 'high',
  });
  assert.equal(r.ok, true);
  assert.equal(readFileSync(output, 'utf8'), '# Title\n\nBody');
});
```

**Step 2: Run the test to verify it fails**

Run:

```bash
node --test tools/scripts/__tests__/lib-llm-worker.smoke.test.mjs
```

Expected: FAIL because `tools/scripts/lib/llm-worker.mjs` does not exist.

**Step 3: Implement the worker module**

Move the subprocess-only logic from `gg-llm-orchestrator.mjs` into `tools/scripts/lib/llm-worker.mjs`. Keep the existing watchdog behavior, but make the contract explicit:

```js
export function buildWorkerCommand(model, opts = {}) {
  if (model === 'claude') {
    return {
      bin: 'claude',
      args: ['-p', '--model', opts.claudeModel, '--effort', opts.claudeEffort],
    };
  }
  if (model === 'codex') {
    return {
      bin: 'codex',
      args: ['exec', '-s', 'read-only', '-c', opts.codexModelConfig, '-c', `reasoning_effort=${opts.codexEffort}`, '-'],
    };
  }
  throw new Error(`unknown worker model: ${model}`);
}
```

Important implementation rules:

- No `--allowedTools`.
- No `--dangerously-skip-permissions`.
- No MCP config.
- No file paths exposed as write targets to the model except stdout capture.
- The caller, not the model, writes output files.

**Step 4: Update the orchestrator to use the worker**

In `tools/scripts/gg-llm-orchestrator.mjs`:

- Import `runTextWorker` and `buildWorkerCommand`.
- Replace local spawn logic with `runTextWorker`.
- Preserve current output file names:
  - `_staging/<pageId>-claude-v8.md`
  - `_staging/<pageId>-codex-v8.md`
  - `_staging/<pageId>-gemini-v8.md`
- Preserve current summary JSON shape as much as possible.

**Step 5: Run targeted tests**

Run:

```bash
node --test tools/scripts/__tests__/lib-llm-worker.smoke.test.mjs
node --test tools/scripts/__tests__/gg-content-draft.smoke.test.mjs
node tools/scripts/gg-llm-orchestrator.mjs --prompt .gg-cache/prompts/PG-WC-001.v8-prompt.md --page-id PG-WC-001 --models claude --out-dir /tmp/gg-worker-smoke --retry 0 --dry-run
```

Expected:

- Worker tests PASS.
- Existing content draft tests PASS.
- Dry-run still prints `claude -p --model ... --effort ... < prompt > output`.

**Step 6: Commit**

```bash
git add tools/scripts/lib/llm-worker.mjs tools/scripts/gg-llm-orchestrator.mjs tools/scripts/__tests__/lib-llm-worker.smoke.test.mjs
git commit -m "refactor: constrain llm cli calls to text workers"
```

---

### Task 3: Replace Agentic Rescue With Deterministic Repair

**Files:**
- Create: `tools/scripts/gg-author-repair.mjs`
- Modify: `tools/scripts/gg-seo-autopilot.mjs`
- Test: `tools/scripts/__tests__/gg-author-repair.smoke.test.mjs`

**Step 1: Write the failing test**

Create `tools/scripts/__tests__/gg-author-repair.smoke.test.mjs`.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const SCRIPT = new URL('../gg-author-repair.mjs', import.meta.url).pathname;

test('author repair writes candidate only, never edits source directly', () => {
  const root = mkdtempSync(join(tmpdir(), 'gg-repair-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const fakeClaude = join(bin, 'claude');
  writeFileSync(fakeClaude, '#!/bin/sh\nprintf "# Fixed\\n\\nBetter article\\n"\n', { mode: 0o755 });
  const source = join(root, 'draft.md');
  const out = join(root, 'candidate.md');
  writeFileSync(source, '# Broken\n\nBad article\n');
  const r = spawnSync(process.execPath, [SCRIPT,
    '--source', source,
    '--out', out,
    '--page-id', 'PG-TEST-001',
    '--target-keyword', 'test keyword',
    '--failures', '- RL4 failed',
    '--model', 'claude-sonnet-4-6',
    '--effort', 'high',
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH || ''}` },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(source, 'utf8'), '# Broken\n\nBad article\n');
  assert.equal(readFileSync(out, 'utf8'), '# Fixed\n\nBetter article');
  assert.ok(!r.stderr.includes('--allowedTools'));
});
```

**Step 2: Run the test to verify it fails**

Run:

```bash
node --test tools/scripts/__tests__/gg-author-repair.smoke.test.mjs
```

Expected: FAIL because `gg-author-repair.mjs` does not exist.

**Step 3: Implement deterministic repair**

Create `tools/scripts/gg-author-repair.mjs`.

Behavior:

- Read source draft.
- Build repair prompt from source, target keyword, author, and phase2 failures.
- Call `runTextWorker('claude', ...)`.
- Write only `--out`.
- Never run phase2 internally.
- Never edit `--source`.

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

**Step 4: Wire repair into autopilot**

In `tools/scripts/gg-seo-autopilot.mjs`, replace the current agentic rescue block with:

```js
if (process.env.GG_AUTHOR_REPAIR !== '0' && existsSync(join(FLOW, draftV8))) {
  const candidate = join('_staging', `${pgId}-repair-candidate.md`);
  shFlow('node', [
    join(SCRIPTS, 'gg-author-repair.mjs'),
    '--source', draftV8,
    '--out', candidate,
    '--page-id', pgId,
    '--target-keyword', keyword,
    '--author', author,
    '--failures', lastFail || '- phase2 failed',
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

Remove unattended use of:

```bash
claude -p ... --allowedTools Bash Read Edit Write Grep --dangerously-skip-permissions
```

**Step 5: Run targeted tests**

Run:

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

### Task 4: Script the Vercel Preview Wait Step

**Files:**
- Create: `tools/scripts/gg-preview-wait.mjs`
- Test: `tools/scripts/__tests__/gg-preview-wait.smoke.test.mjs`

**Step 1: Write the failing test**

Create `tools/scripts/__tests__/gg-preview-wait.smoke.test.mjs`.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const SCRIPT = new URL('../gg-preview-wait.mjs', import.meta.url).pathname;

test('preview wait validates required branch argument', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--branch is required/);
});
```

**Step 2: Run the test to verify it fails**

Run:

```bash
node --test tools/scripts/__tests__/gg-preview-wait.smoke.test.mjs
```

Expected: FAIL because script does not exist.

**Step 3: Implement preview wait**

Create `tools/scripts/gg-preview-wait.mjs`.

Behavior:

- Accept `--branch`, `--repo xdawayer/oracle`, `--timeout-ms`, `--json`.
- Use `gh api repos/<repo>/deployments?ref=<branch>`.
- Poll deployment statuses.
- Return `{ ok: true, previewUrl }` on success.
- Return non-zero with `{ ok: false, reason }` on timeout/failure.

**Step 4: Run dry validation**

Run:

```bash
node tools/scripts/gg-preview-wait.mjs --branch seo/auto/2026-06-12-PG-WC-001 --repo xdawayer/oracle --timeout-ms 1000 --json
```

Expected: Either a preview URL if deployment exists, or a clear timeout/failure JSON. No uncaught stack trace.

**Step 5: Commit**

```bash
git add tools/scripts/gg-preview-wait.mjs tools/scripts/__tests__/gg-preview-wait.smoke.test.mjs
git commit -m "feat: add deterministic preview wait"
```

---

### Task 5: Script Preview Verification With Playwright

**Files:**
- Create: `tools/scripts/gg-preview-verify.mjs`
- Test: `tools/scripts/__tests__/gg-preview-verify.smoke.test.mjs`

**Step 1: Write the failing test**

Create `tools/scripts/__tests__/gg-preview-verify.smoke.test.mjs`.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const SCRIPT = new URL('../gg-preview-verify.mjs', import.meta.url).pathname;

test('preview verify requires preview url and slug', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--preview-url is required/);
  assert.match(r.stderr, /--slug is required/);
});
```

**Step 2: Run the test to verify it fails**

Run:

```bash
node --test tools/scripts/__tests__/gg-preview-verify.smoke.test.mjs
```

Expected: FAIL because script does not exist.

**Step 3: Implement Playwright verifier**

Create `tools/scripts/gg-preview-verify.mjs`.

Behavior:

- Accept `--preview-url`, `--slug`, `--zh`, `--bypass-secret`, `--json`.
- Navigate to:
  - `<previewUrl>/en/wiki/<slug>?x-vercel-protection-bypass=<secret>&x-vercel-set-bypass-cookie=true`
  - `<previewUrl>/zh/wiki/<slug>` when `--zh` is present.
- Fail on:
  - no `h1`
  - no `script[type="application/ld+json"]`
  - visible Vercel login/auth wall
  - empty SPA soft-404 shell
  - uncaught JS exception
  - failed app bundle load
- Ignore benign favicon/font/analytics 404s.
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

**Step 4: Add dependency strategy**

Prefer the repo's existing Playwright dependency if present in oracle. If not available in flow-mvp, use dynamic import and fail with:

```text
Playwright not available. Install in flow-mvp or run from oracle workspace.
```

Do not use Claude MCP for this verifier.

**Step 5: Run tests**

Run:

```bash
node --test tools/scripts/__tests__/gg-preview-verify.smoke.test.mjs
```

Expected: PASS.

Manual smoke when preview exists:

```bash
node tools/scripts/gg-preview-verify.mjs \
  --preview-url "$PREVIEW_URL" \
  --slug world-cup-2026-astrology-prediction \
  --zh \
  --bypass-secret "$VERCEL_AUTOMATION_BYPASS_SECRET" \
  --json
```

Expected: PASS or clear blocker reason.

**Step 6: Commit**

```bash
git add tools/scripts/gg-preview-verify.mjs tools/scripts/__tests__/gg-preview-verify.smoke.test.mjs
git commit -m "feat: verify previews with deterministic playwright"
```

---

### Task 6: Add Structured Review Worker Verdicts

**Files:**
- Create: `tools/scripts/gg-article-review-worker.mjs`
- Modify: `tools/scripts/gg-author-review.mjs` if shared prompt helpers are extracted
- Test: `tools/scripts/__tests__/gg-article-review-worker.smoke.test.mjs`

**Step 1: Write the failing test**

Create `tools/scripts/__tests__/gg-article-review-worker.smoke.test.mjs`.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
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
```

**Step 2: Run the test to verify it fails**

Run:

```bash
node --test tools/scripts/__tests__/gg-article-review-worker.smoke.test.mjs
```

Expected: FAIL because script does not exist.

**Step 3: Implement review worker**

Create `tools/scripts/gg-article-review-worker.mjs`.

Behavior:

- Accept `--dimension astrology|schema|links-seo`.
- Read converted oracle article `.ts` and source draft `.md`.
- Call OAuth CLI text worker.
- Require strict JSON output:

```json
{
  "verdict": "PASS",
  "blocking_reason": "",
  "notes": ["short evidence"]
}
```

- If the worker emits prose, try to extract the first JSON object.
- If no parseable JSON, return:

```json
{
  "verdict": "SKIPPED",
  "blocking_reason": "tooling: no parseable JSON verdict"
}
```

Tooling failures should not silently pass. The caller decides whether a skipped review is allowed.

**Step 4: Run tests**

Run:

```bash
node --test tools/scripts/__tests__/gg-article-review-worker.smoke.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add tools/scripts/gg-article-review-worker.mjs tools/scripts/__tests__/gg-article-review-worker.smoke.test.mjs
git commit -m "feat: add structured article review worker"
```

---

### Task 7: Replace Prompt-Driven Verify/Merge Gate

**Files:**
- Create: `tools/scripts/gg-preview-gate.mjs`
- Modify: `tools/scripts/gg-seo-autopilot-tick.sh`
- Leave: `tools/scripts/seo-autopilot-tick.prompt.md` as deprecated reference for one release
- Test: `tools/scripts/__tests__/gg-preview-gate.smoke.test.mjs`

**Step 1: Write the failing test**

Create `tools/scripts/__tests__/gg-preview-gate.smoke.test.mjs`.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const SCRIPT = new URL('../gg-preview-gate.mjs', import.meta.url).pathname;

test('preview gate requires a branch', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--branch is required/);
});
```

**Step 2: Run the test to verify it fails**

Run:

```bash
node --test tools/scripts/__tests__/gg-preview-gate.smoke.test.mjs
```

Expected: FAIL because script does not exist.

**Step 3: Implement gate orchestration**

Create `tools/scripts/gg-preview-gate.mjs`.

Behavior:

1. Load claim by `--branch` using existing `gg-seo-autopilot.mjs --status` or shared claim helpers.
2. If `status === verified-preview`, skip preview wait and use stored `previewUrl`.
3. Else call `gg-preview-wait.mjs`.
4. Call `gg-preview-verify.mjs`.
5. Call three `gg-article-review-worker.mjs` workers:
   - `astrology`
   - `schema`
   - `links-seo`
6. Optional Codex diff review remains best-effort.
7. If required gates pass, call:

```bash
node tools/scripts/gg-seo-autopilot.mjs --mark-verified --branch "$BRANCH" --preview-url "$PREVIEW_URL" --evidence "$EVIDENCE"
node tools/scripts/gg-seo-autopilot.mjs --merge --branch "$BRANCH"
```

8. If any required gate fails, call:

```bash
node tools/scripts/gg-seo-autopilot.mjs --mark-failed --branch "$BRANCH" --reason "$REASON"
```

9. Feishu notify only on failure. Publish success notification remains owned by `--merge`.

**Step 4: Modify tick script**

In `tools/scripts/gg-seo-autopilot-tick.sh`, replace:

```bash
claude -p "$(cat "$PROMPT_FILE")" ...
```

with:

```bash
node "$SCRIPT_DIR/gg-preview-gate.mjs" --branch "$BRANCH" >> "$LOG" 2>&1
```

To find branch:

```bash
BRANCH="$(node "$AUTO" --status 2>/dev/null | node -e '
const fs=require("fs");
const claims=JSON.parse(fs.readFileSync(0,"utf8"));
for (const c of Object.values(claims)) {
  if (c && (c.status==="pushed-preview" || c.status==="verified-preview")) {
    console.log(c.branch);
    process.exit(0);
  }
}
process.exit(1);
')"
```

Remove `PROMPT_FILE` from active gate usage. Keep the prompt file as documentation until the new gate has run successfully for at least three real articles.

**Step 5: Run tests**

Run:

```bash
node --test tools/scripts/__tests__/gg-preview-gate.smoke.test.mjs
node --test tools/scripts/__tests__/gg-seo-autopilot.smoke.test.mjs
```

Expected: PASS.

**Step 6: Manual dry run**

For current pending PR:

```bash
GG_OPS_DIR=/Users/wzb/Code/gengrowth-ops \
GG_ORACLE_DIR=/Users/wzb/Code/oracle \
node tools/scripts/gg-preview-gate.mjs \
  --branch seo/auto/2026-06-12-PG-WC-001 \
  --dry-run \
  --json
```

Expected: Shows planned preview wait, preview verify, review workers, and final action. Does not merge in dry-run.

**Step 7: Commit**

```bash
git add tools/scripts/gg-preview-gate.mjs tools/scripts/gg-seo-autopilot-tick.sh tools/scripts/__tests__/gg-preview-gate.smoke.test.mjs
git commit -m "feat: replace prompt-driven preview gate"
```

---

### Task 8: Add Claim Lease Heartbeats

**Files:**
- Modify: `tools/scripts/gg-seo-autopilot.mjs`
- Test: `tools/scripts/__tests__/gg-seo-autopilot.smoke.test.mjs`

**Step 1: Add failing tests**

Extend `tools/scripts/__tests__/gg-seo-autopilot.smoke.test.mjs` with:

```js
test('active author claim records stage heartbeat metadata', () => {
  // Use existing harness pattern.
  // Seed a task, run --author with fake scripts, assert claim has:
  // status, stage, lockedBy, leaseUntil, updatedAt.
});

test('stale active claim can be reported without reclaiming by default', () => {
  // Seed active claim with leaseUntil in the past.
  // Run --status --json or new --stale-report.
  // Assert stale entry appears but no destructive mutation occurs.
});
```

**Step 2: Run the test to verify it fails**

Run:

```bash
node --test tools/scripts/__tests__/gg-seo-autopilot.smoke.test.mjs
```

Expected: FAIL because lease metadata is absent.

**Step 3: Add lease helper functions**

In `tools/scripts/gg-seo-autopilot.mjs`, add:

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

Add heartbeats before long stages:

- `sheet-pull`
- `gbrain-rag`
- `entity-passport`
- `render`
- `llm-generate`
- `phase2`
- `review`
- `repair`
- `scan-build`
- `preview-gate`

**Step 4: Add stale report command**

Add CLI option:

```bash
node tools/scripts/gg-seo-autopilot.mjs --stale-report
```

Output stale active/pushed claims without mutating them.

**Step 5: Run tests**

Run:

```bash
node --test tools/scripts/__tests__/gg-seo-autopilot.smoke.test.mjs
```

Expected: PASS.

**Step 6: Commit**

```bash
git add tools/scripts/gg-seo-autopilot.mjs tools/scripts/__tests__/gg-seo-autopilot.smoke.test.mjs
git commit -m "feat: add autopilot claim lease heartbeats"
```

---

### Task 9: Update Operational Documentation

**Files:**
- Create: `docs/2026-06-13-oauth-cli-worker-autopilot-runbook.md`
- Modify: `docs/HANDBOOK.md` only if the new runbook becomes the canonical current operation note

**Step 1: Draft runbook**

Create a short runbook with:

- What changed.
- What still uses OAuth CLI.
- What no longer uses Claude as total controller.
- How to install on Mac mini.
- How to run preflight.
- How to force one safe dry-run.
- How to handle `needs_human`.
- How to inspect stale leases.

**Step 2: Obsidian metadata**

The new runbook must include frontmatter:

```yaml
---
title: OAuth CLI Worker Autopilot Runbook
date: 2026-06-13
updated: 2026-06-13
type: note
tags:
  - seo-autopilot
  - runbook
aliases:
  - OAuth CLI Worker Runbook
---
```

**Step 3: Verify docs**

Run:

```bash
rg -n "seo-autopilot-tick.prompt|gg-preview-gate|GG_AUTHOR_REPAIR|GG_AUTHOR_AGENTIC_RESCUE|OAuth CLI" docs tools/scripts
```

Expected: References clearly show the old prompt gate is deprecated for unattended cron.

**Step 4: Commit**

```bash
git add docs/2026-06-13-oauth-cli-worker-autopilot-runbook.md docs/HANDBOOK.md
git commit -m "docs: document oauth cli worker autopilot"
```

---

### Task 10: End-to-End Verification on One Pending Article

**Files:**
- No code changes unless a defect is found.
- Artifacts checked:
  - `_staging/<PG>-en.md`
  - `_staging/<PG>-en.manifest.json`
  - `/Users/wzb/Code/gengrowth-ops/inbox/06-tasks/tasks/.autopilot-claims.json`
  - oracle PR

**Step 1: Run preflight**

```bash
set -a; . "$HOME/.config/gg/_gg.env"; set +a
GG_OPS_DIR=/Users/wzb/Code/gengrowth-ops \
GG_ORACLE_DIR=/Users/wzb/Code/oracle \
node tools/scripts/gg-autopilot-preflight.mjs
```

Expected: PASS.

**Step 2: Run a dry-run gate on the existing pushed preview**

```bash
GG_OPS_DIR=/Users/wzb/Code/gengrowth-ops \
GG_ORACLE_DIR=/Users/wzb/Code/oracle \
node tools/scripts/gg-preview-gate.mjs \
  --branch seo/auto/2026-06-12-PG-WC-001 \
  --dry-run \
  --json
```

Expected: No merge. Evidence shows what would be checked.

**Step 3: Run one real gate only after dry-run is clean**

```bash
GG_OPS_DIR=/Users/wzb/Code/gengrowth-ops \
GG_ORACLE_DIR=/Users/wzb/Code/oracle \
node tools/scripts/gg-preview-gate.mjs \
  --branch seo/auto/2026-06-12-PG-WC-001
```

Expected:

- If all gates pass: claim moves to `done` through existing merge flow.
- If a blocker exists: claim moves to `needs_human` with a specific reason and Feishu alert.

**Step 4: Run smoke test suite**

```bash
node --test tools/scripts/__tests__/gg-autopilot-preflight.smoke.test.mjs
node --test tools/scripts/__tests__/lib-llm-worker.smoke.test.mjs
node --test tools/scripts/__tests__/gg-author-repair.smoke.test.mjs
node --test tools/scripts/__tests__/gg-preview-wait.smoke.test.mjs
node --test tools/scripts/__tests__/gg-preview-verify.smoke.test.mjs
node --test tools/scripts/__tests__/gg-article-review-worker.smoke.test.mjs
node --test tools/scripts/__tests__/gg-preview-gate.smoke.test.mjs
node --test tools/scripts/__tests__/gg-seo-autopilot.smoke.test.mjs
```

Expected: PASS.

**Step 5: Commit any verification fixes**

```bash
git status --short
git diff
git add <fixed-files>
git commit -m "fix: stabilize oauth cli autopilot verification"
```

---

## Rollback Plan

If the new deterministic gate fails unexpectedly:

1. Set `GG_USE_PROMPT_PREVIEW_GATE=1` in `~/.config/gg/_gg.env` for one temporary run.
2. Keep `GG_AUTHOR_AGENTIC_RESCUE=0`; do not re-enable unattended file-editing rescue unless explicitly approved.
3. Use existing `gg-seo-autopilot.mjs --mark-failed` to park the current branch rather than forcing merge.
4. Revert only the gate wiring commit if needed; keep preflight and worker contract changes.

## Success Criteria

- Cron no longer calls `claude -p "$(cat seo-autopilot-tick.prompt.md)"` in unattended mode.
- OAuth CLI remains the default writer/reviewer path.
- No unattended `claude -p` invocation includes `--allowedTools`, `Edit`, `Write`, `Bash`, MCP, or `--dangerously-skip-permissions`.
- A failed article has a specific stage and reason, not just "Claude failed".
- A stale or long-running job shows `stage`, `lockedBy`, `leaseUntil`, and `updatedAt`.
- At least three real articles pass through author -> phase2 -> preview gate -> merge without manual intervention before deleting the deprecated prompt gate.

## Execution Handoff

Plan complete and saved to `docs/plans/2026-06-13-oauth-cli-worker-autopilot-plan.md`.

Two execution options:

**1. Subagent-Driven (this session)** - Dispatch a fresh subagent per task, review between tasks, and iterate quickly.

**2. Parallel Session (separate)** - Open a new session with `superpowers:executing-plans`, then implement this plan with checkpoints.

Recommended: Option 1 for Tasks 1-3, then pause for one real cron smoke before Tasks 4-8.
