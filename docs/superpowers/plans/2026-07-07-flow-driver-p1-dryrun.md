# Flow Driver P1 (dry-run triage) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a **dry-run** flow-driver that reads the autopilot ledger, triages every parked (`needs_human`) article into `retry` / `fix` / `archive`, and prints the plan + a summary — landable and validatable against real parks (e.g. WC-045) **before** any side-effects are wired.

**Architecture:** A pure triage function (`triagePark`, extends the existing `park-classify.mjs`) + a pure planner (`planDriverActions`) + a thin dry-run CLI (`gg-flow-driver.mjs`). No side-effects, no lane, no LLM yet — this is the safe, fully-unit-tested foundation of the overlay driver. Later plans wire the fix/archive/retry actions + the launchd lane.

**Tech Stack:** Node ESM `.mjs`, `node:test` + `node:assert/strict`, no new deps.

## Global Constraints

- **只在 macmini 改 flow 代码;** develop in a vault-external worktree, land via atomic `mv` to `~/gengrowth-flow-mvp`.
- **Full-suite baseline:** `node --test 'tools/scripts/__tests__/*.test.mjs'` — ~1509 pass / 1507 (2 pre-existing codex-timeout failures are the only allowed failures).
- **Master rule:** workflow guarantees, not LLM. P1 is 100% deterministic (no LLM) — triage is pure regex/logic.
- **Backward-compat:** do NOT change `classifyPark`'s existing `'transient'|'permanent'` return — the shipped auto-retry (`doAutoRetryParks`) depends on it. Add `triagePark` alongside it.
- **Every step ends green + committed** (frequent commits).

## File Structure

- **Modify** `tools/scripts/lib/park-classify.mjs` — add `UNFIXABLE_RE` + export `triagePark(claimOrError)`; leave `classifyPark` untouched.
- **Create** `tools/scripts/lib/flow-driver.mjs` — export `planDriverActions(claims)` (pure).
- **Create** `tools/scripts/gg-flow-driver.mjs` — dry-run CLI: read ledger → `planDriverActions` → print plan + summary.
- **Create** `tools/scripts/__tests__/park-triage.smoke.test.mjs` — `triagePark` unit tests.
- **Create** `tools/scripts/__tests__/flow-driver-plan.smoke.test.mjs` — `planDriverActions` + CLI dry-run tests.

---

### Task 1: `triagePark` — 3-class triage (extend park-classify)

**Files:**
- Modify: `tools/scripts/lib/park-classify.mjs` (append after `isTransientPark`, ~line 52)
- Test: `tools/scripts/__tests__/park-triage.smoke.test.mjs`

**Interfaces:**
- Consumes: `classifyPark(claimOrError) → 'transient'|'permanent'` (existing, same file).
- Produces: `triagePark(claimOrError) → 'transient'|'fixable'|'unfixable'` and `const UNFIXABLE_RE`.

- [ ] **Step 1: Write the failing test**

Create `tools/scripts/__tests__/park-triage.smoke.test.mjs`:

```js
// park-triage.smoke.test.mjs — 三分诊 triagePark：transient(工具没跑成)/unfixable(时效死)/fixable(可改稿)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triagePark } from '../lib/park-classify.mjs';

test('transient：工具没跑成 → retry 类', () => {
  assert.equal(triagePark('codex exited 3'), 'transient');
  assert.equal(triagePark('preview-wait timeout'), 'transient');
  assert.equal(triagePark({ error: 'chrome verify failed: HTTP 503' }), 'transient');
});

test('unfixable：时效过期/事件已发生/前提死 → archive 类（改稿救不了）', () => {
  // WC-045 真实 error：review FAIL + stale-match，应判 unfixable（不是白烧自修）
  assert.equal(triagePark('review[codex] FAIL: stale topic — Mexico vs England match already played 2026-07-06'), 'unfixable');
  assert.equal(triagePark('codex FAIL: the event has passed'), 'unfixable');
  assert.equal(triagePark({ error: 'review[astrology] FAIL: premise is false — the match was never scheduled' }), 'unfixable');
});

test('fixable：判决类 FAIL 但可改稿 → fix 类（Jupiter 事实错 / RL4 漂移 / 缺关键词）', () => {
  assert.equal(triagePark('review[astrology] FAIL: Jupiter in Gemini is wrong; it transits Cancer then Leo'), 'fixable');
  assert.equal(triagePark('phase2 FAIL: drifted sections "Common Misreadings"'), 'fixable');
  assert.equal(triagePark({ error: 'review[schema] FAIL: assoc_keywords stray keyword' }), 'fixable');
});

test('无 error → unfixable（保守交人工看，不自动改）', () => {
  assert.equal(triagePark(''), 'unfixable');
  assert.equal(triagePark({ error: '' }), 'unfixable');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/scripts/__tests__/park-triage.smoke.test.mjs`
Expected: FAIL — `triagePark is not a function` (not yet exported).

- [ ] **Step 3: Write minimal implementation**

Append to `tools/scripts/lib/park-classify.mjs` (after the `isTransientPark` line):

```js

// unfixable：改稿救不了的——选题时效过期 / 事件已发生 / 前提根本错。改稿无法挽回 → 应归档带原因，
// 绝不空烧自修（WC-045：Mexico vs England 比赛已踢，赛前预测稿改不活）。
// 保守：只认无歧义的"死"信号；模糊情况留给 fixable（试着修，修不好 N 次后 park 交人工，安全）。
export const UNFIXABLE_RE = new RegExp([
  'already (?:played|happened|occurred|passed|took place|over)',
  'match (?:was|is) (?:played|over)', 'was (?:played|held) (?:on|already)',
  '(?:event|match|game|fixture|deadline|date) (?:has )?(?:passed|expired|elapsed)',
  'no longer (?:upcoming|relevant|scheduled)',
  '\\bstale topic\\b', '\\bexpired\\b',
  'premise (?:is )?(?:false|wrong|invalid|flawed)',
  'never (?:happened|took place|scheduled|existed)',
].join('|'), 'i');

// 三分诊（driver 用）：transient(工具没跑成→retry) / unfixable(时效死→archive) / fixable(可改稿→自修)。
// 顺序：先 transient(工具层)，再 unfixable(内容死)，其余判决类 FAIL 归 fixable。无 error → unfixable(交人工)。
export function triagePark(claimOrError) {
  const err = typeof claimOrError === 'string'
    ? claimOrError
    : String((claimOrError && claimOrError.error) || '');
  if (!err.trim()) return 'unfixable';
  if (classifyPark(err) === 'transient') return 'transient';
  if (UNFIXABLE_RE.test(err)) return 'unfixable';
  return 'fixable';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/scripts/__tests__/park-triage.smoke.test.mjs`
Expected: PASS — `tests 4 / pass 4 / fail 0`.

- [ ] **Step 5: Commit**

```bash
git add tools/scripts/lib/park-classify.mjs tools/scripts/__tests__/park-triage.smoke.test.mjs
git commit -m "flow-driver P1: triagePark 三分诊 (transient/fixable/unfixable)"
```

---

### Task 2: `planDriverActions` — pure planner over the ledger

**Files:**
- Create: `tools/scripts/lib/flow-driver.mjs`
- Test: `tools/scripts/__tests__/flow-driver-plan.smoke.test.mjs`

**Interfaces:**
- Consumes: `triagePark(claim) → 'transient'|'fixable'|'unfixable'` (Task 1).
- Produces: `planDriverActions(claims) → Array<{ pid, triage, action, slug, stage, reason }>` where `action` is `'retry'|'fix'|'archive'`.

- [ ] **Step 1: Write the failing test**

Create `tools/scripts/__tests__/flow-driver-plan.smoke.test.mjs`:

```js
// flow-driver-plan.smoke.test.mjs — planDriverActions：把 ledger 里每个 needs_human park 映射成动作。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDriverActions } from '../lib/flow-driver.mjs';

const CLAIMS = {
  'PG-A': { status: 'done', slug: 'a' },                                          // 非 park → 跳过
  'PG-B': { status: 'pushed-preview', slug: 'b' },                                // 非 park → 跳过
  'PG-TRANS': { status: 'needs_human', stage: 'pushed-preview', slug: 't', error: 'codex exited 3' },
  'PG-FIX': { status: 'needs_human', stage: 'authoring', slug: 'f', error: 'phase2 FAIL: drifted sections' },
  'PG-STALE': { status: 'needs_human', stage: 'pushed-preview', slug: 's', error: 'review[codex] FAIL: stale topic — match already played' },
};

test('planDriverActions：只挑 needs_human，映射 retry/fix/archive', () => {
  const plan = planDriverActions(CLAIMS);
  const byPid = Object.fromEntries(plan.map((a) => [a.pid, a]));
  assert.equal(plan.length, 3, '只 3 个 needs_human');
  assert.equal(byPid['PG-TRANS'].action, 'retry');
  assert.equal(byPid['PG-FIX'].action, 'fix');
  assert.equal(byPid['PG-STALE'].action, 'archive');
  assert.equal(byPid['PG-FIX'].triage, 'fixable');
  assert.match(byPid['PG-STALE'].reason, /already played/);
});

test('planDriverActions：空/无 claims → 空数组', () => {
  assert.deepEqual(planDriverActions({}), []);
  assert.deepEqual(planDriverActions(null), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/scripts/__tests__/flow-driver-plan.smoke.test.mjs`
Expected: FAIL — cannot find module `../lib/flow-driver.mjs`.

- [ ] **Step 3: Write minimal implementation**

Create `tools/scripts/lib/flow-driver.mjs`:

```js
// lib/flow-driver.mjs — overlay driver 的纯规划层：把 ledger 里每个 needs_human park 分诊成一个动作。
// P1 只规划、不执行（dry-run）。action: 'retry'(transient) / 'fix'(fixable,自修) / 'archive'(unfixable)。
import { triagePark } from './park-classify.mjs';

const TRIAGE_TO_ACTION = { transient: 'retry', fixable: 'fix', unfixable: 'archive' };

export function planDriverActions(claims) {
  const out = [];
  for (const [pid, claim] of Object.entries(claims || {})) {
    if (!claim || claim.status !== 'needs_human') continue;
    const triage = triagePark(claim);
    out.push({
      pid,
      triage,
      action: TRIAGE_TO_ACTION[triage],
      slug: claim.slug || '',
      stage: claim.stage || '',
      reason: String(claim.error || '').slice(0, 120),
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/scripts/__tests__/flow-driver-plan.smoke.test.mjs`
Expected: PASS — `tests 2 / pass 2 / fail 0`.

- [ ] **Step 5: Commit**

```bash
git add tools/scripts/lib/flow-driver.mjs tools/scripts/__tests__/flow-driver-plan.smoke.test.mjs
git commit -m "flow-driver P1: planDriverActions 纯规划层 (ledger→动作)"
```

---

### Task 3: `gg-flow-driver.mjs` — dry-run CLI

**Files:**
- Create: `tools/scripts/gg-flow-driver.mjs`
- Test: extend `tools/scripts/__tests__/flow-driver-plan.smoke.test.mjs` (CLI subprocess against a temp ledger)

**Interfaces:**
- Consumes: `planDriverActions(claims)` (Task 2).
- Produces: CLI `node tools/scripts/gg-flow-driver.mjs [--ledger <path>]` — prints one line per action + a summary line `flow-driver: parks=N fix=N retry=N archive=N mode=dry-run`. Exit 0 always (never blocks). `--apply` is accepted but is a NO-OP in P1 (reserved).

- [ ] **Step 1: Write the failing test** (append to `flow-driver-plan.smoke.test.mjs`)

```js
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('gg-flow-driver CLI dry-run：读 ledger 打印计划 + 汇总，exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flowdrv-'));
  const ledger = join(dir, 'claims.json');
  writeFileSync(ledger, JSON.stringify(CLAIMS));
  const r = spawnSync('node', ['tools/scripts/gg-flow-driver.mjs', '--ledger', ledger], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /parks=3 fix=1 retry=1 archive=1 mode=dry-run/);
  assert.match(r.stdout, /PG-STALE.*archive/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/scripts/__tests__/flow-driver-plan.smoke.test.mjs`
Expected: FAIL — CLI file does not exist (`r.status` non-zero / no matching stdout).

- [ ] **Step 3: Write minimal implementation**

Create `tools/scripts/gg-flow-driver.mjs`:

```js
#!/usr/bin/env node
// gg-flow-driver.mjs — overlay driver（P1 dry-run）：读 ledger，把每个 needs_human park 分诊成动作
// (fix/retry/archive) 并打印计划 + 汇总。**P1 只规划不执行**——先落地验证分诊对不对（如 WC-045→archive），
// 再在后续 plan 里接侧效。fail-safe：任何错都 exit 0，绝不阻塞。--apply 预留(P1 空操作)。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { planDriverActions } from './lib/flow-driver.mjs';

const argv = process.argv.slice(2);
const getArg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : ''; };
const DEFAULT_LEDGER = join(homedir(), 'gengrowth-ops/inbox/06-tasks/tasks/.autopilot-claims.json');
const ledgerPath = getArg('--ledger') || DEFAULT_LEDGER;

function main() {
  let claims = {};
  try { claims = JSON.parse(readFileSync(ledgerPath, 'utf8')); }
  catch (e) { console.error(`flow-driver: 读 ledger 失败 ${String(e.message).slice(0, 80)} — 无可规划`); process.exit(0); }
  const plan = planDriverActions(claims);
  for (const a of plan) {
    console.log(`  ${a.pid} [${a.stage}] → ${a.action}\t${a.slug}\t${a.reason}`);
  }
  const n = (act) => plan.filter((a) => a.action === act).length;
  console.log(`flow-driver: parks=${plan.length} fix=${n('fix')} retry=${n('retry')} archive=${n('archive')} mode=dry-run`);
  process.exit(0);
}
main();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/scripts/__tests__/flow-driver-plan.smoke.test.mjs`
Expected: PASS — `tests 3 / pass 3 / fail 0`.

- [ ] **Step 5: Validate against the REAL ledger (manual, no side-effects — it's dry-run)**

Run: `node tools/scripts/gg-flow-driver.mjs`
Expected: prints the current parks; **WC-045 must show `→ archive`** (stale-match), confirming triage is correct on real data. Any surprising classification → adjust `UNFIXABLE_RE`/`TRANSIENT_RE` and re-run Task 1 tests.

- [ ] **Step 6: Full-suite baseline + commit**

Run: `node --test 'tools/scripts/__tests__/*.test.mjs'`
Expected: ~1516 pass / 1514 + the 2 pre-existing codex-timeout failures (P1 adds ~7 new tests, zero regressions).

```bash
git add tools/scripts/gg-flow-driver.mjs tools/scripts/__tests__/flow-driver-plan.smoke.test.mjs
git commit -m "flow-driver P1: gg-flow-driver dry-run CLI (ledger→计划+汇总)"
```

- [ ] **Step 7: Atomic-land to ~/gengrowth-flow-mvp** (per Global Constraints — develop in worktree, land via atomic mv), then push, then clean worktree. Run the adversarial review pass before landing.

---

## Self-Review

- **Spec coverage:** P1 implements spec §4.2's triage (3-class) as the deterministic core. Fix/archive/retry *execution*, the completeness verifier (§4.3), the GSC lane (§4.4), and the launchd lane (§4.1) are explicitly deferred to P1.5/P2/P3 — P1 is the dry-run foundation only. No spec requirement is silently dropped; the deferrals are named.
- **Placeholder scan:** none — every step has real code + real commands + expected output.
- **Type consistency:** `triagePark` returns `'transient'|'fixable'|'unfixable'` (Task 1) → consumed by `planDriverActions` via `TRIAGE_TO_ACTION` (Task 2) → `action` field consumed by the CLI summary (Task 3). Consistent.

## Deferred to next plans (not P1)
- **P1.5:** wire the `fix` action → `gg-gate-repair.mjs --reason <park error>` → re-gate → merge; the `archive` action → mark won't-publish + one notify; the `retry` action → reuse `doAutoRetryParks` requeue. Bounded N, claims-lock, idempotent.
- **P2:** completeness verifier + loop-until-clean backfill.
- **P3:** GSC `browser-use` spike, then wire.
- **Lane:** `com.gengrowth.flow-driver` plist + tick.sh, default off, once the `--apply` path is built.
