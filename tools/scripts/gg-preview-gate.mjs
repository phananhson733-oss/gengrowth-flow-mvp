#!/usr/bin/env node
// gg-preview-gate.mjs — Task 7 orchestrator: the deterministic preview→verify→review→merge
// gate that replaces the free-form `claude -p` autopilot tick gate described in
// tools/scripts/seo-autopilot-tick.prompt.md. It glues the three Task 4/5/6 sub-scripts
// (gg-preview-wait, gg-preview-verify, gg-article-review-worker) together with the real
// gg-seo-autopilot.mjs ledger CLI, runs a REQUIRED codex factual diff review (the only gate
// step that fact-checks real-world, non-astrological claims), and on success marks the claim
// verified + merges it; on any required-gate failure it parks the claim (guarded) and fires
// the failure Feishu notify itself.
//
// ─────────────────────────────────────────────────────────────────────────────
// EXIT CODE CONTRACT (so the tick wiring in gg-seo-autopilot-tick.sh is trivial):
//   0  → claim was verified AND merged (published to prod). The success Feishu notify is
//        owned by gg-seo-autopilot.mjs --merge, NOT by this gate.
//   1  → nothing pending for --branch (no claim, or claim status is not a preview status
//        i.e. not 'pushed-preview'/'verified-preview'). No-op, end the tick cleanly.
//   2  → a REQUIRED gate failed or timed out (chrome verify, any of the 3 review dimensions,
//        a SKIPPED tooling failure, a per-step timeout, or the preview-wait failing). The
//        claim is parked needs_human (guarded against the mjs throw) and THIS gate fires the
//        failure Feishu notify. "end-fire": the tick should treat 2 as a handled stop.
//   (a bad/missing --branch exits nonzero too — stderr '--branch is required'.)
//
// Codex (Step 4b) is REQUIRED by default (safety-first, 2026-06-21): the 3 LLM dimensions above
// scope themselves OUT of real-world facts (sports schedules, birth data, event dates), so codex
// is the ONLY gate that catches a factually-wrong-but-structurally-valid article (the "spain Group
// F / June 22" auto-publish incident). Any non-PASS codex outcome — a completed `VERDICT: FAIL`, a
// tooling SKIPPED (can't run / hangs / EACCES / no VERDICT line), OR no GG_CODEX_BIN configured —
// PARKS the claim (needs_human) instead of merging. GG_CODEX_GATE_REQUIRED=0 hot-rolls-back to the
// legacy best-effort behavior (block only on a completed `VERDICT: FAIL`) for one run if codex is
// wedged unattended and a human is watching.
//
// Every sub-process runs under a HARD per-step timeout; on timeout we classify the step as a
// gate failure (exit 2 path). Every sub-invocation path is env-overridable so the hermetic
// smoke test can inject fakes (no network, no chromium, no real merge, no real LLM):
//   GG_AUTOPILOT_BIN        gg-seo-autopilot.mjs            (--status/--mark-verified/--merge/--mark-failed)
//   GG_PREVIEW_WAIT_BIN     gg-preview-wait.mjs
//   GG_PREVIEW_VERIFY_BIN   gg-preview-verify.mjs
//   GG_REVIEW_WORKER_BIN    gg-article-review-worker.mjs
//   GG_LARK_NOTIFY_BIN      gg-lark-notify.sh
//   GG_CODEX_BIN            codex PR factual-review wrapper (REQUIRED by default; absent ⇒ PARK,
//                           unless GG_CODEX_GATE_REQUIRED=0 ⇒ legacy best-effort SKIPPED)
//   GG_ORACLE_WORKTREE_ROOT / claim.worktree → <worktree>/data/articles/<slug>.ts
//   GG_FLOW_REPO            → <flow>/_staging/<pgId>-en.md
//   VERCEL_AUTOMATION_BYPASS_SECRET  passed to gg-preview-verify
//
// --dry-run prints the planned steps + intended final action and exits WITHOUT calling
// --mark-verified / --merge / --mark-failed (and without firing any notify).
//
// Run: node gg-preview-gate.mjs --branch <ref> [--repo o/r] [--dry-run] [--json]
//        [--preview-timeout-ms n] [--verify-timeout-ms n] [--review-timeout-ms n]
//        [--codex-timeout-ms n] [--status-timeout-ms n]

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = (() => {
  try { return fileURLToPath(new URL('.', import.meta.url)); } catch { return process.cwd(); }
})();
const HOME = homedir();
const FLOW = process.env.GG_FLOW_REPO || join(HOME, 'gengrowth-flow-mvp');
const SCRIPTS = process.env.GG_SCRIPTS_DIR || join(FLOW, 'tools', 'scripts');

export const DEFAULT_REPO = 'xdawayer/oracle';
export const EXIT = { PUBLISHED: 0, NOTHING_PENDING: 1, GATE_FAILED: 2 };
export const REVIEW_DIMENSIONS = ['astrology', 'schema', 'links-seo'];
const PREVIEW_STATUSES = new Set(['pushed-preview', 'verified-preview']);

// Default per-step hard timeouts (ms). Each sub-process is killed if it exceeds these and the
// step is classified as a gate failure. Conservative relative to the sub-scripts' own caps.
const DEFAULTS = {
  statusTimeoutMs: 60000,
  previewTimeoutMs: 600000,   // matches gg-preview-wait DEFAULT_TIMEOUT_MS
  verifyTimeoutMs: 180000,
  reviewTimeoutMs: 780000,    // matches gg-article-review-worker DEFAULT_TIMEOUT_MS
  codexTimeoutMs: 600000,
};

// ── bin resolution (env-overridable; falls back to the sibling script dir) ────
function resolveBin(envName, fileName) {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  // Prefer the real tools/scripts location; fall back to this file's own dir.
  const inScripts = join(SCRIPTS, fileName);
  if (existsSync(inScripts)) return inScripts;
  return join(HERE, fileName);
}

export function bins() {
  return {
    autopilot: resolveBin('GG_AUTOPILOT_BIN', 'gg-seo-autopilot.mjs'),
    previewWait: resolveBin('GG_PREVIEW_WAIT_BIN', 'gg-preview-wait.mjs'),
    previewVerify: resolveBin('GG_PREVIEW_VERIFY_BIN', 'gg-preview-verify.mjs'),
    reviewWorker: resolveBin('GG_REVIEW_WORKER_BIN', 'gg-article-review-worker.mjs'),
    larkNotify: resolveBin('GG_LARK_NOTIFY_BIN', 'gg-lark-notify.sh'),
    codex: process.env.GG_CODEX_BIN || null, // REQUIRED by default — absent ⇒ PARK (GG_CODEX_GATE_REQUIRED=0 ⇒ legacy SKIPPED)
  };
}

// ── arg parsing ───────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const o = {
    branch: null,
    repo: DEFAULT_REPO,
    dryRun: false,
    json: false,
    statusTimeoutMs: DEFAULTS.statusTimeoutMs,
    previewTimeoutMs: DEFAULTS.previewTimeoutMs,
    verifyTimeoutMs: DEFAULTS.verifyTimeoutMs,
    reviewTimeoutMs: DEFAULTS.reviewTimeoutMs,
    codexTimeoutMs: DEFAULTS.codexTimeoutMs,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--branch') o.branch = argv[++i];
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
    else if (a === '--status-timeout-ms') o.statusTimeoutMs = Number(argv[++i]);
    else if (a === '--preview-timeout-ms') o.previewTimeoutMs = Number(argv[++i]);
    else if (a === '--verify-timeout-ms') o.verifyTimeoutMs = Number(argv[++i]);
    else if (a === '--review-timeout-ms') o.reviewTimeoutMs = Number(argv[++i]);
    else if (a === '--codex-timeout-ms') o.codexTimeoutMs = Number(argv[++i]);
    // unknown flags ignored (autopilot-friendly, matches sibling scripts)
  }
  return o;
}

// ── child-process runner with a HARD per-step timeout ─────────────────────────
// Returns { code, stdout, stderr, timedOut }. NEVER rejects — a spawn error resolves with
// code 127 so the orchestrator stays structured. On timeout, the child is SIGKILL'd and
// timedOut:true is set so the caller classifies the step as a gate failure.
export function runStep(cmd, args, { timeoutMs, env, input } = {}, deps = {}) {
  const { spawnFn = spawn } = deps;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: env || process.env });
    } catch (e) {
      resolve({ code: 127, stdout: '', stderr: String(e && e.message ? e.message : e), timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (res) => { if (!settled) { settled = true; resolve(res); } };

    let timer = null;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, timeoutMs);
      if (timer.unref) timer.unref();
    }

    child.stdout && child.stdout.on('data', (d) => { stdout += d; });
    child.stderr && child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      finish({ code: 127, stdout, stderr: stderr || String(e && e.message ? e.message : e), timedOut });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      finish({ code: code == null ? 1 : code, stdout, stderr, timedOut });
    });

    if (input != null && child.stdin) {
      child.stdin.on('error', () => {}); // ignore EPIPE if the child closes stdin early
      child.stdin.end(input);
    } else if (child.stdin) {
      child.stdin.end();
    }
  });
}

// Convenience: run `node <bin> <args...>`.
function runNode(binPath, args, opts, deps) {
  return runStep(process.execPath, [binPath, ...args], opts, deps);
}

// ── claim lookup (read-only parse of gg-seo-autopilot.mjs --status) ───────────
// Returns { pgId, claim } for the branch, or null if no claim matches. Throws only on a
// truly unparseable --status payload (caller treats that as a gate failure, not nothing-pending).
export function findClaimForBranch(statusJson, branch) {
  let claims;
  try {
    claims = typeof statusJson === 'string' ? JSON.parse(statusJson) : statusJson;
  } catch (e) {
    const err = new Error(`unparseable --status JSON: ${e.message}`);
    err.unparseable = true;
    throw err;
  }
  if (!claims || typeof claims !== 'object') return null;
  for (const [pgId, claim] of Object.entries(claims)) {
    if (claim && claim.branch === branch) return { pgId, claim };
  }
  return null;
}

// Derive the published-artifact .ts path + the EN source draft .md path from a claim.
export function articlePaths(pgId, claim) {
  // Fallback mirrors gg-seo-autopilot.mjs worktreePath(): WORKTREE_ROOT + sanitized BRANCH
  // (env-overridable root, branch-keyed — NOT pgId). In practice claim.worktree is always set
  // before a claim can reach a preview status, so this fallback is defensive-only; it just must
  // not point somewhere different from the real worktree if it is ever hit.
  const worktreeRoot = process.env.GG_ORACLE_WORKTREE_ROOT || join(HOME, 'oracle-worktrees', 'seo-autopilot');
  const worktree = claim.worktree
    || join(worktreeRoot, String(claim.branch || '').replace(/[^A-Za-z0-9._-]+/g, '__'));
  const articleTs = join(worktree, 'data', 'articles', `${claim.slug}.ts`);
  const draftMd = join(FLOW, '_staging', `${pgId}-en.md`);
  return { articleTs, draftMd };
}

// Codex verdict classifier. Best-effort: only a COMPLETED run that prints `VERDICT: FAIL`
// blocks. A nonzero exit / timeout / empty output / no VERDICT line ⇒ SKIPPED (does NOT block).
export function classifyCodex({ code, stdout, timedOut }) {
  if (timedOut) return { verdict: 'SKIPPED', reason: 'codex timed out' };
  if (code !== 0) return { verdict: 'SKIPPED', reason: `codex exited ${code}` };
  const text = String(stdout || '').replace(/\r\n?/g, '\n'); // normalize CRLF so `$` isn't fooled by \r
  // Collect EVERY line-anchored verdict. A mid-sentence "…the diff says VERDICT: PASS…" never matches
  // (not line-start). Decision rules, all fail-closed:
  //   - FAIL DOMINATES: any FAIL line ⇒ FAIL. A planted "VERDICT: PASS" the model quoted from the
  //     untrusted diff can never override a real FAIL, and a genuine FAIL is never mislabeled a skip.
  //   - else exactly ONE bare PASS ⇒ PASS (the only path that merges).
  //   - else (zero / multiple PASS / a qualified "PASS — but unsure") ⇒ SKIPPED, never merge.
  const verdicts = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*VERDICT:\s*(PASS|FAIL)\b(.*)$/i);
    if (m) verdicts.push({ v: m[1].toUpperCase(), suffix: m[2] || '' });
  }
  if (verdicts.length === 0) return { verdict: 'SKIPPED', reason: 'codex produced no line-anchored VERDICT' };
  const fail = verdicts.find((x) => x.v === 'FAIL');
  if (fail) return { verdict: 'FAIL', reason: `codex FAIL${fail.suffix ? ` —${fail.suffix.replace(/^[\s—-]+/, ' ').trim()}` : ''}` };
  if (verdicts.length > 1) return { verdict: 'SKIPPED', reason: `codex produced ${verdicts.length} PASS verdicts (ambiguous — fail-closed)` };
  // PASS must be BARE: "VERDICT: PASS — but unsure" is ambiguous → fail-closed, do not merge on it.
  if (verdicts[0].suffix.trim()) return { verdict: 'SKIPPED', reason: `codex PASS carried an unexpected qualifier "${verdicts[0].suffix.trim().slice(0, 60)}" (fail-closed)` };
  return { verdict: 'PASS', reason: '' };
}

// ── the gate ──────────────────────────────────────────────────────────────────
// Returns { exitCode, plan:[...], action, reason } — a pure-ish orchestration result. All
// side-effects (mark-verified/merge/mark-failed/notify) happen here EXCEPT in dry-run, where
// only the plan is built and `action` is the INTENDED-but-skipped final action.
export async function runGate(o, deps = {}) {
  const B = deps.bins || bins();
  const node = (binPath, args, opts) => runNode(binPath, args, opts, deps);
  const plan = [];
  const log = (line) => plan.push(line);

  // (1) load the claim for --branch (read-only).
  log(`status: node ${B.autopilot} --status (find claim for branch ${o.branch})`);
  const statusRes = await node(B.autopilot, ['--status'], { timeoutMs: o.statusTimeoutMs });
  if (statusRes.timedOut) {
    return gateFail(o, B, deps, null, null, 'status: gg-seo-autopilot --status timed out', plan);
  }
  if (statusRes.code !== 0) {
    return gateFail(o, B, deps, null, null,
      `status: gg-seo-autopilot --status exited ${statusRes.code}: ${tail(statusRes.stderr)}`, plan);
  }

  let found;
  try {
    found = findClaimForBranch(statusRes.stdout, o.branch);
  } catch (e) {
    // Unparseable ledger is a gate failure, but we have no pgId to park — treat as exit 2
    // without a mark-failed (nothing safe to park), still notify.
    return gateFail(o, B, deps, null, null, e.message, plan);
  }

  if (!found) {
    log(`result: no claim ledger entry for branch ${o.branch} → nothing pending`);
    return { exitCode: EXIT.NOTHING_PENDING, plan, action: 'none', reason: 'no claim for branch' };
  }
  const { pgId, claim } = found;
  if (!PREVIEW_STATUSES.has(claim.status)) {
    log(`result: claim ${pgId} status="${claim.status}" is not a preview status → nothing pending`);
    return {
      exitCode: EXIT.NOTHING_PENDING, plan, action: 'none',
      reason: `claim status "${claim.status}" not pending`,
    };
  }

  const hasZh = claim.zh === true;
  const { articleTs, draftMd } = articlePaths(pgId, claim);
  log(`claim: pgId=${pgId} slug=${claim.slug} status=${claim.status} zh=${hasZh}`);

  // (2) preview URL: reuse stored on verified-preview, else preview-wait.
  let previewUrl = null;
  if (claim.status === 'verified-preview' && claim.previewUrl) {
    previewUrl = claim.previewUrl;
    log(`preview: status=verified-preview → REUSE stored previewUrl ${previewUrl} (skip preview-wait)`);
  } else {
    log(`preview: node ${B.previewWait} --branch ${o.branch} --repo ${o.repo} --json (timeout ${o.previewTimeoutMs}ms)`);
    if (!o.dryRun) {
      const wr = await node(B.previewWait,
        ['--branch', o.branch, '--repo', o.repo, '--timeout-ms', String(o.previewTimeoutMs), '--json'],
        { timeoutMs: o.previewTimeoutMs + 5000 });
      if (wr.timedOut) {
        return gateFail(o, B, deps, pgId, claim, 'preview-wait: hard timeout', plan);
      }
      const parsed = safeJson(lastJsonLine(wr.stdout));
      if (wr.code !== 0 || !parsed || !parsed.ok || !parsed.previewUrl) {
        const reason = parsed && parsed.reason ? parsed.reason : tail(wr.stderr) || `exit ${wr.code}`;
        return gateFail(o, B, deps, pgId, claim, `preview-wait failed: ${reason}`, plan);
      }
      previewUrl = parsed.previewUrl;
      log(`preview: resolved previewUrl ${previewUrl}`);
    } else {
      previewUrl = '<resolved-by-preview-wait>';
    }
  }

  // (3) chrome verify (en + zh when claim has zh). The bypass secret is inherited by verify from
  // the ENV (it reads VERCEL_AUTOMATION_BYPASS_SECRET as its default) — NOT passed as argv, so it
  // never lands in `ps`, the gate plan, or the log.
  const verifyArgs = ['--preview-url', previewUrl, '--slug', String(claim.slug), '--json'];
  if (hasZh) verifyArgs.push('--zh');
  log(`verify: node ${B.previewVerify} ${verifyArgs.join(' ')} (timeout ${o.verifyTimeoutMs}ms)`);
  if (!o.dryRun) {
    const vr = await node(B.previewVerify, verifyArgs, { timeoutMs: o.verifyTimeoutMs });
    if (vr.timedOut) {
      return gateFail(o, B, deps, pgId, claim, 'chrome verify: hard timeout', plan);
    }
    const vj = safeJson(lastJsonLine(vr.stdout));
    if (vr.code !== 0 || !vj || !vj.ok) {
      const r = vj && vj.failReason ? vj.failReason : tail(vr.stderr) || `verify exit ${vr.code}`;
      return gateFail(o, B, deps, pgId, claim, `chrome verify failed: ${r}`, plan);
    }
    log(`verify: PASS (${(vj.checked || []).length} url(s))`);
  }

  // (4) three review dimensions (all REQUIRED; a SKIPPED tooling failure blocks).
  for (const dim of REVIEW_DIMENSIONS) {
    log(`review[${dim}]: node ${B.reviewWorker} --dimension ${dim} --article ${articleTs} --draft ${draftMd} --json (timeout ${o.reviewTimeoutMs}ms)`);
    if (o.dryRun) continue;
    const rr = await node(B.reviewWorker,
      ['--dimension', dim, '--article', articleTs, '--draft', draftMd, '--timeout-ms', String(o.reviewTimeoutMs), '--json'],
      { timeoutMs: o.reviewTimeoutMs + 5000 });
    if (rr.timedOut) {
      return gateFail(o, B, deps, pgId, claim, `review[${dim}]: hard timeout`, plan);
    }
    const rj = safeJson(lastJsonLine(rr.stdout));
    const verdict = rj && rj.verdict ? rj.verdict : null;
    if (verdict !== 'PASS') {
      // FAIL or SKIPPED (tooling) both block. exit-1 from the worker == SKIPPED.
      const why = rj && rj.blocking_reason ? rj.blocking_reason : (verdict || tail(rr.stderr) || `exit ${rr.code}`);
      return gateFail(o, B, deps, pgId, claim, `review[${dim}] ${verdict || 'no-verdict'}: ${why}`, plan);
    }
    log(`review[${dim}]: PASS`);
  }

  // (4b) codex factual diff review — REQUIRED by default (GG_CODEX_GATE_REQUIRED=0 ⇒ legacy
  // best-effort). In required mode ANY non-PASS outcome parks the claim; only a completed
  // `VERDICT: PASS` proceeds to merge. dry-run never parks — it only records the intent.
  const codexRequired = process.env.GG_CODEX_GATE_REQUIRED !== '0';
  let codexEvidence = B.codex ? 'no-verdict' : 'skipped-no-bin';
  if (o.dryRun) {
    codexEvidence = B.codex ? 'dry-run' : (codexRequired ? 'would-park:no-bin' : 'skipped-no-bin');
    log(`codex: ${B.codex ? `${B.codex} (pr=${claim.pr || '?'})` : 'no GG_CODEX_BIN'} — dry-run`
      + `${!B.codex && codexRequired ? ' (REQUIRED — a real run would PARK)' : ''}`);
  } else if (!B.codex) {
    if (codexRequired) {
      return gateFail(o, B, deps, pgId, claim,
        'codex factual review REQUIRED but GG_CODEX_BIN not configured (set GG_CODEX_GATE_REQUIRED=0 to override)', plan);
    }
    log('codex: SKIPPED (no GG_CODEX_BIN configured) — GG_CODEX_GATE_REQUIRED=0, not blocking');
  } else {
    log(`codex: ${B.codex} (${codexRequired ? 'REQUIRED' : 'best-effort'}, pr=${claim.pr || '?'}, timeout ${o.codexTimeoutMs}ms)`);
    const cr = await node(B.codex, ['--repo', o.repo, '--pr', String(claim.pr || ''), '--branch', o.branch],
      { timeoutMs: o.codexTimeoutMs });
    const cls = classifyCodex(cr);
    codexEvidence = cls.verdict === 'PASS' ? 'ran-pass'
      : cls.verdict === 'FAIL' ? 'ran-fail' : `skipped:${cls.reason}`;
    if (cls.verdict === 'FAIL') {
      return gateFail(o, B, deps, pgId, claim, `codex completed with ${cls.reason}`, plan);
    }
    if (cls.verdict !== 'PASS' && codexRequired) {
      // SKIPPED in required mode blocks: a factual review that could not COMPLETE is not a pass.
      return gateFail(o, B, deps, pgId, claim,
        `codex factual review could not complete (${cls.reason}) — required gate`, plan);
    }
    log(`codex: ${cls.verdict}${cls.reason ? ` (${cls.reason})` : ''} — ${cls.verdict === 'PASS' ? 'PASS' : 'not blocking (best-effort)'}`);
  }

  // (5) all REQUIRED gates passed → mark-verified + merge (success notify owned by --merge).
  // evidence records the ACTUAL codex outcome (ran-pass / ran-fail / skipped:<reason> / no-bin / dry-run),
  // not mere bin presence — so post-incident forensics on a prod auto-merge aren't misled.
  const evidence = `chrome preview + 3-dimension review panel passed (codex: ${codexEvidence})`;
  log(`final: mark-verified --branch ${o.branch} --preview-url ${previewUrl} --evidence "${evidence}"`);
  log(`final: merge --branch ${o.branch} (deploys prod; --merge owns success notify)`);

  if (o.dryRun) {
    return { exitCode: EXIT.PUBLISHED, plan, action: 'WOULD mark-verified + merge', reason: 'dry-run' };
  }

  const mv = await node(B.autopilot,
    ['--mark-verified', '--branch', o.branch, '--preview-url', previewUrl, '--evidence', evidence],
    { timeoutMs: o.statusTimeoutMs });
  if (mv.timedOut || mv.code !== 0) {
    return gateFail(o, B, deps, pgId, claim,
      `mark-verified failed: ${mv.timedOut ? 'timeout' : tail(mv.stderr) || `exit ${mv.code}`}`, plan);
  }
  // --merge does real work (gh pr merge + worktree cleanup + oracle sync + index submit) that can
  // exceed the 60s status budget; give it a dedicated wall (GG_GATE_MERGE_TIMEOUT_MS, default 5min)
  // so the gate doesn't SIGKILL a merge mid-flight and diverge the ledger from GitHub.
  const mergeTimeoutMs = Number(process.env.GG_GATE_MERGE_TIMEOUT_MS) || 300000;
  const mg = await node(B.autopilot, ['--merge', '--branch', o.branch], { timeoutMs: mergeTimeoutMs });
  if (mg.timedOut || mg.code !== 0) {
    return gateFail(o, B, deps, pgId, claim,
      `merge failed: ${mg.timedOut ? 'timeout' : tail(mg.stderr) || `exit ${mg.code}`}`, plan);
  }
  log('final: MERGED → published');
  return { exitCode: EXIT.PUBLISHED, plan, action: 'merged', reason: 'all required gates passed' };
}

// ── failure path: park the claim (guarded) + fire the failure Feishu notify ───
// GUARD: gg-seo-autopilot --mark-failed THROWS if the claim is already needs_human/done
// (mjs ~1199 only allows active/pushed-preview/verified-preview). Skip --mark-failed when the
// claim's CURRENT status is needs_human/done to avoid that throw. We still notify.
// In --dry-run we do NEITHER — just record the intended action.
async function gateFail(o, B, deps, pgId, claim, reason, plan) {
  const node = (binPath, args, opts) => runNode(binPath, args, opts, deps);
  const parkable = claim && ['active', 'pushed-preview', 'verified-preview'].includes(claim.status);
  const slug = (claim && claim.slug) || (pgId ? `pg:${pgId}` : o.branch);

  plan.push(`FAIL reason: ${reason}`);
  if (o.dryRun) {
    plan.push(`final(dry-run): WOULD ${parkable ? 'mark-failed' : 'SKIP mark-failed (claim already needs_human/done)'} + notify`);
    return { exitCode: EXIT.GATE_FAILED, plan, action: 'WOULD mark-failed + notify', reason };
  }

  if (parkable) {
    plan.push(`final: mark-failed --branch ${o.branch} --reason "${reason}"`);
    const mf = await node(B.autopilot, ['--mark-failed', '--branch', o.branch, '--reason', reason],
      { timeoutMs: o.statusTimeoutMs });
    if (mf.code !== 0) plan.push(`mark-failed exited ${mf.code} (continuing to notify): ${tail(mf.stderr)}`);
  } else {
    plan.push(`final: SKIP mark-failed (claim status="${claim ? claim.status : 'unknown'}" already terminal — avoids mjs throw)`);
  }

  // The gate owns the FAILURE notify (merge owns the success notify). Action-needed → @PM+@Ops.
  const msg = `⚠️ SEO autopilot 发布 gate 未过 ${slug}（${o.branch}）：${reason} — PR 待人工`;
  plan.push(`final: notify ${B.larkNotify} (@PM @Ops)`);
  await runStep('bash', [B.larkNotify, msg], {
    timeoutMs: o.statusTimeoutMs,
    env: { ...process.env, GG_LARK_NOTIFY_AT_PM: '1', GG_LARK_NOTIFY_AT_OPS: '1' },
  }, deps);

  return { exitCode: EXIT.GATE_FAILED, plan, action: parkable ? 'parked + notified' : 'notified (already terminal)', reason };
}

// ── small helpers ─────────────────────────────────────────────────────────────
function tail(s, n = 200) { return String(s || '').slice(-n).replace(/\s+/g, ' ').trim(); }
function lastJsonLine(s) {
  const lines = String(s || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('{')) return lines[i];
  }
  return String(s || '').trim();
}
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

// ── main ────────────────────────────────────────────────────────────────────
export async function main(argv) {
  const o = parseArgs(argv);
  if (!o.branch) {
    process.stderr.write('--branch is required\n');
    return EXIT.GATE_FAILED;
  }
  for (const k of ['statusTimeoutMs', 'previewTimeoutMs', 'verifyTimeoutMs', 'reviewTimeoutMs', 'codexTimeoutMs']) {
    if (!Number.isFinite(o[k]) || o[k] <= 0) {
      process.stderr.write(`invalid timeout for ${k}: ${o[k]}\n`);
      return EXIT.GATE_FAILED;
    }
  }

  let result;
  try {
    result = await runGate(o);
  } catch (e) {
    // Last-resort: never let a stack escape. An unexpected internal fault is a gate failure.
    process.stderr.write(`gg-preview-gate internal error: ${e && e.message ? e.message : e}\n`);
    return EXIT.GATE_FAILED;
  }

  if (o.json) {
    process.stdout.write(JSON.stringify({
      branch: o.branch,
      dryRun: o.dryRun,
      exitCode: result.exitCode,
      action: result.action,
      reason: result.reason,
      plan: result.plan,
    }, null, 2) + '\n');
  } else {
    if (o.dryRun) process.stdout.write(`[dry-run] plan for ${o.branch}:\n`);
    for (const line of result.plan) process.stdout.write(`  ${line}\n`);
    process.stdout.write(`==> exit ${result.exitCode} (${result.action})\n`);
  }
  return result.exitCode;
}

// Only run when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
