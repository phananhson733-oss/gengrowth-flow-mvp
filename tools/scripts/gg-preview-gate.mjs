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
//   GG_NOTIFY_BIN           gg-notify.mjs（统一事件层 CLI；gate_fail 事件，@ 策略由事件表决定）
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

import { spawn, spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = (() => {
  try { return fileURLToPath(new URL('.', import.meta.url)); } catch { return process.cwd(); }
})();
const HOME = homedir();
const FLOW = process.env.GG_FLOW_REPO || join(HOME, 'gengrowth-flow-mvp');
const SCRIPTS = process.env.GG_SCRIPTS_DIR || join(FLOW, 'tools', 'scripts');

export const DEFAULT_REPO = 'xdawayer/oracle';
// 本 gate 只服务 oracle → astrologywiki.com 一条发布线；事件层的站点标签是字段不是品牌前缀。
export const GATE_SITE = 'astrologywiki';
export const EXIT = { PUBLISHED: 0, NOTHING_PENDING: 1, GATE_FAILED: 2 };
export const REVIEW_DIMENSIONS = ['astrology', 'schema', 'links-seo'];
const PREVIEW_STATUSES = new Set(['pushed-preview', 'verified-preview']);
const HEAD_REF_OID_RE = /^[0-9a-f]{40}$/i;

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

function resolveCodexBin() {
  const fromEnv = process.env.GG_CODEX_BIN;
  if (fromEnv) return fromEnv;
  const inScripts = join(SCRIPTS, 'gg-codex-pr-review.mjs');
  if (existsSync(inScripts)) return inScripts;
  const local = join(HERE, 'gg-codex-pr-review.mjs');
  return existsSync(local) ? local : null;
}

export function bins() {
  return {
    autopilot: resolveBin('GG_AUTOPILOT_BIN', 'gg-seo-autopilot.mjs'),
    previewWait: resolveBin('GG_PREVIEW_WAIT_BIN', 'gg-preview-wait.mjs'),
    previewVerify: resolveBin('GG_PREVIEW_VERIFY_BIN', 'gg-preview-verify.mjs'),
    reviewWorker: resolveBin('GG_REVIEW_WORKER_BIN', 'gg-article-review-worker.mjs'),
    notify: resolveBin('GG_NOTIFY_BIN', 'gg-notify.mjs'), // 统一事件层 CLI（gate_fail；测试放假 bin 记 argv）
    codex: resolveCodexBin(), // REQUIRED by default — absent ⇒ PARK (GG_CODEX_GATE_REQUIRED=0 ⇒ legacy SKIPPED)
    gateRepair: resolveBin('GG_GATE_REPAIR_BIN', 'gg-gate-repair.mjs'), // surgical park-boundary repair (default-on; GG_GATE_REPAIR=0 disables)
  };
}

// ── gate-side surgical repair (GG_GATE_REPAIR=0 disables) ─────────────────────
// gg-gate-repair.mjs returns structured old/new edits for the failing article .ts; we apply
// them deterministically, commit + push, then invalidate the entire previous gate round.
// Cleanup is scoped to the one controlled article file. A failed push keeps the local commit
// as evidence and fails closed; this function never rewrites history or uses reset --hard.
const GATE_REPAIR_TIMEOUT_MS = parseInt(process.env.GG_GATE_REPAIR_TIMEOUT_MS || '450000', 10);

export async function tryGateRepair({
  dim,
  reason,
  articleTs,
  draftMd,
  worktree,
  branch,
  expectedHead,
  node,
  B,
  log,
}) {
  // DEFAULT-ON: one surgical repair attempt at the park boundary before needs_human.
  // Set GG_GATE_REPAIR=0 to disable (roll back to park-immediately).
  if (process.env.GG_GATE_REPAIR === '0') return false;
  if (!B.gateRepair || !existsSync(B.gateRepair)) { log(`repair[${dim}]: no gate-repair bin — skip`); return false; }
  if (!articleTs || !existsSync(articleTs)) { log(`repair[${dim}]: no article .ts — skip`); return false; }
  if (!worktree || !existsSync(worktree)) { log(`repair[${dim}]: no worktree for commit — skip`); return false; }
  const git = (args) => spawnSync('git', ['-C', worktree, ...args], {
    encoding: 'utf8',
    timeout: 60000,
  });
  const inspectRepairWorktree = () => {
    const head = git(['rev-parse', 'HEAD']);
    const headRefOid = String(head.stdout || '').trim();
    if (head.status !== 0 || !HEAD_REF_OID_RE.test(headRefOid)
      || (expectedHead && headRefOid !== expectedHead)) {
      return {
        ok: false,
        reason: `repair worktree head ${headRefOid || '?'} does not match reviewed head ${expectedHead || '?'}`,
      };
    }
    const status = git(['status', '--porcelain=v1', '--untracked-files=normal']);
    if (status.status !== 0) {
      return {
        ok: false,
        reason: `repair worktree status unavailable: ${tail(status.stderr) || `exit ${status.status}`}`,
      };
    }
    if (String(status.stdout || '').trim()) {
      return { ok: false, reason: 'repair worktree has uncommitted changes; refusing mutation' };
    }
    return { ok: true, headRefOid };
  };
  const beforeWorker = inspectRepairWorktree();
  if (!beforeWorker.ok) return { applied: false, reason: beforeWorker.reason };

  log(`repair[${dim}]: gg-gate-repair on ${articleTs} (reason: ${String(reason).slice(0, 80)}…)`);
  const args = ['--article', articleTs, '--dimension', dim, '--reason', String(reason)];
  if (draftMd && existsSync(draftMd)) args.push('--draft', draftMd);
  const rr = await node(B.gateRepair, args, { timeoutMs: GATE_REPAIR_TIMEOUT_MS });
  if (rr.timedOut || rr.code !== 0) { log(`repair[${dim}]: worker ${rr.timedOut ? 'timeout' : `exit ${rr.code}`} — skip`); return false; }
  let out;
  try { out = JSON.parse(lastJsonLine(rr.stdout)); } catch { log(`repair[${dim}]: unparseable worker output — skip`); return false; }
  const edits = Array.isArray(out && out.edits) ? out.edits : [];
  if (!edits.length) { log(`repair[${dim}]: ${(out && out.note) || 'no edits'} — skip`); return false; }
  const afterWorker = inspectRepairWorktree();
  if (!afterWorker.ok) return { applied: false, reason: afterWorker.reason };
  let content;
  try { content = readFileSync(articleTs, 'utf8'); } catch { log(`repair[${dim}]: read failed — skip`); return false; }
  const originalContent = content;
  for (const e of edits) {
    if (!e || typeof e.old_string !== 'string' || typeof e.new_string !== 'string') { log(`repair[${dim}]: malformed edit — abort`); return false; }
    if ((content.split(e.old_string).length - 1) !== 1) { log(`repair[${dim}]: edit not uniquely present — abort`); return false; }
    content = content.replace(e.old_string, e.new_string);
  }
  try { writeFileSync(articleTs, content); } catch { log(`repair[${dim}]: write failed — abort`); return false; }
  const articlePathspec = relative(worktree, articleTs);
  git(['add', '--', articlePathspec]);
  const cm = git(['commit', '-m', `fix(gate-repair): ${dim} — ${String((out && out.note) || 'surgical').slice(0, 72)}`]);
  if (cm.status !== 0) {
    log(`repair[${dim}]: git commit failed — restoring only ${articlePathspec}`);
    const unstage = git(['restore', '--staged', '--', articlePathspec]);
    if (unstage.status === 0) {
      try { writeFileSync(articleTs, originalContent); } catch {}
    }
    return { applied: false, reason: `repair commit failed: ${tail(cm.stderr) || `exit ${cm.status}`}` };
  }
  const newHead = String(git(['rev-parse', 'HEAD']).stdout || '').trim();
  const pu = git(['push', 'origin', branch]);
  if (pu.status !== 0) {
    log(`repair[${dim}]: git push failed — local commit ${newHead.slice(0, 8)} retained as evidence`);
    return {
      applied: false,
      headRefOid: newHead,
      reason: `repair push failed; local commit ${newHead} retained: ${tail(pu.stderr) || `exit ${pu.status}`}`,
    };
  }
  log(`repair[${dim}]: applied ${edits.length} edit(s) + pushed ${newHead.slice(0, 8)} — starting a new full gate round`);
  return true;
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
  return { worktree, articleTs, draftMd };
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

export async function resolveBranchHead(branch, repo, deps = {}) {
  if (typeof deps.resolveBranchHead === 'function') {
    return deps.resolveBranchHead(branch, repo);
  }
  const result = await runStep('gh', [
    'pr', 'view', branch,
    '--repo', repo,
    '--json', 'headRefOid',
    '-q', '.headRefOid',
  ], { timeoutMs: DEFAULTS.statusTimeoutMs }, deps);
  if (result.timedOut || result.code !== 0) return null;
  const headRefOid = String(result.stdout || '').trim();
  return headRefOid || null;
}

export async function inspectReviewedWorktree(worktree, reviewedHeadRefOid, deps = {}) {
  if (typeof deps.inspectReviewedWorktree === 'function') {
    return deps.inspectReviewedWorktree(worktree, reviewedHeadRefOid);
  }
  if (!worktree) return { ok: false, reason: 'review worktree is required' };
  const git = (args) => spawnSync('git', ['-C', worktree, ...args], {
    encoding: 'utf8',
    timeout: DEFAULTS.statusTimeoutMs,
  });
  const head = git(['rev-parse', 'HEAD']);
  if (head.status !== 0) {
    return { ok: false, reason: `review worktree HEAD unavailable: ${tail(head.stderr) || `exit ${head.status}`}` };
  }
  const headRefOid = String(head.stdout || '').trim();
  if (headRefOid !== reviewedHeadRefOid) {
    return {
      ok: false,
      headRefOid,
      reason: `review worktree HEAD mismatch: ${headRefOid || '?'} != ${reviewedHeadRefOid}`,
    };
  }
  const status = git(['status', '--porcelain=v1', '--untracked-files=normal']);
  if (status.status !== 0) {
    return { ok: false, headRefOid, reason: `review worktree status unavailable: ${tail(status.stderr)}` };
  }
  const porcelain = String(status.stdout || '').trim();
  if (porcelain) {
    return {
      ok: false,
      headRefOid,
      dirty: true,
      reason: `review worktree has uncommitted changes: ${porcelain.split('\n')[0]}`,
    };
  }
  return { ok: true, headRefOid, dirty: false };
}

function normalizePreviewUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

export async function verifyPreviewBinding({
  previewUrl,
  branch,
  repo,
  reviewedHeadRefOid,
}, deps = {}) {
  if (typeof deps.verifyPreviewBinding === 'function') {
    return deps.verifyPreviewBinding({ previewUrl, branch, repo, reviewedHeadRefOid });
  }
  const gh = async (args) => runStep('gh', args, {
    timeoutMs: DEFAULTS.statusTimeoutMs,
  }, deps);
  const targetUrl = normalizePreviewUrl(previewUrl);
  const deployments = await gh(['api', `repos/${repo}/deployments?ref=${encodeURIComponent(branch)}`]);
  if (deployments.code === 0) {
    const rows = safeJson(deployments.stdout);
    if (Array.isArray(rows)) {
      const matching = rows.filter((row) => String(row?.sha || '') === reviewedHeadRefOid);
      for (const deployment of matching) {
        const statuses = await gh(['api', `repos/${repo}/deployments/${deployment.id}/statuses`]);
        const statusRows = statuses.code === 0 ? safeJson(statuses.stdout) : null;
        if (Array.isArray(statusRows) && statusRows.some((status) => (
          String(status?.state || '').toLowerCase() === 'success'
          && [status?.environment_url, status?.target_url]
            .map(normalizePreviewUrl)
            .includes(targetUrl)
        ))) {
          return { ok: true, method: 'github-deployment', deploymentId: deployment.id };
        }
      }
      if (matching.length > 0) {
        return {
          ok: false,
          reason: `preview deployment is not bound to reviewed head ${reviewedHeadRefOid}`,
        };
      }
    }
  }

  const statusResult = await gh(['api', `repos/${repo}/commits/${reviewedHeadRefOid}/status`]);
  const statusJson = statusResult.code === 0 ? safeJson(statusResult.stdout) : null;
  const statuses = Array.isArray(statusJson?.statuses) ? statusJson.statuses : [];
  const boundStatus = statuses.find((status) => (
    String(status?.context || '').toLowerCase().includes('vercel')
    && String(status?.state || '').toLowerCase() === 'success'
    && [status?.target_url, status?.details_url, status?.environment_url]
      .map(normalizePreviewUrl)
      .includes(targetUrl)
  ));
  if (!boundStatus) {
    return {
      ok: false,
      reason: `preview URL is not exactly bound by a successful Vercel status on reviewed head ${reviewedHeadRefOid}`,
    };
  }
  return {
    ok: true,
    method: 'vercel-commit-status-url',
    context: String(boundStatus.context || ''),
  };
}

async function runFullGateRound({
  o,
  B,
  node,
  claim,
  articleTs,
  draftMd,
  previewUrl,
  previewBinding,
  reviewedHeadRefOid,
  repairRound,
  log,
}) {
  const checks = {
    preview_binding: previewBinding,
  };
  let failure = null;
  const noteFailure = (candidate) => {
    if (!failure) failure = candidate;
  };
  const pinnedArgs = ['--head-ref-oid', reviewedHeadRefOid];

  const verifyArgs = [
    '--preview-url', previewUrl,
    '--slug', String(claim.slug),
    ...pinnedArgs,
    '--json',
  ];
  log(`round[${repairRound}] verify@${reviewedHeadRefOid.slice(0, 8)}: node ${B.previewVerify} ${verifyArgs.join(' ')} (timeout ${o.verifyTimeoutMs}ms)`);
  const vr = await node(B.previewVerify, verifyArgs, { timeoutMs: o.verifyTimeoutMs });
  if (vr.timedOut) {
    checks.chrome = { status: 'FAIL', reason: 'hard timeout' };
    noteFailure({ reason: 'chrome verify: hard timeout', repairable: false, dim: 'chrome' });
  } else {
    const vj = safeJson(lastJsonLine(vr.stdout));
    if (vr.code !== 0 || !vj || !vj.ok) {
      const reason = vj && vj.failReason ? vj.failReason : tail(vr.stderr) || `verify exit ${vr.code}`;
      checks.chrome = { status: 'FAIL', reason };
      noteFailure({ reason: `chrome verify failed: ${reason}`, repairable: false, dim: 'chrome' });
    } else {
      checks.chrome = { status: 'PASS', checked: (vj.checked || []).length };
      log(`round[${repairRound}] verify: PASS (${(vj.checked || []).length} url(s))`);
    }
  }

  for (const dim of REVIEW_DIMENSIONS) {
    const args = [
      '--dimension', dim,
      '--article', articleTs,
      '--draft', draftMd,
      '--timeout-ms', String(o.reviewTimeoutMs),
      ...pinnedArgs,
      '--json',
    ];
    log(`round[${repairRound}] review[${dim}]@${reviewedHeadRefOid.slice(0, 8)}: node ${B.reviewWorker}`);
    const rr = await node(B.reviewWorker, args, { timeoutMs: o.reviewTimeoutMs + 5000 });
    if (rr.timedOut) {
      checks[dim] = { status: 'FAIL', reason: 'hard timeout' };
      noteFailure({ reason: `review[${dim}]: hard timeout`, repairable: false, dim });
      continue;
    }
    const rj = safeJson(lastJsonLine(rr.stdout));
    const verdict = rj && rj.verdict ? rj.verdict : null;
    const reason = rj && rj.blocking_reason
      ? rj.blocking_reason
      : (verdict || tail(rr.stderr) || `exit ${rr.code}`);
    checks[dim] = { status: verdict || 'NO_VERDICT', reason };
    if (verdict !== 'PASS') {
      noteFailure({
        reason: `review[${dim}] ${verdict || 'no-verdict'}: ${reason}`,
        repairable: verdict === 'FAIL',
        dim,
      });
    } else {
      log(`round[${repairRound}] review[${dim}]: PASS`);
    }
  }

  const codexRequired = process.env.GG_CODEX_GATE_REQUIRED !== '0';
  if (!B.codex) {
    const reason = 'codex factual review REQUIRED but GG_CODEX_BIN not configured';
    checks.codex = { status: 'SKIPPED', reason: 'no configured bin' };
    if (codexRequired) noteFailure({ reason, repairable: false, dim: 'codex' });
  } else {
    const codexArgs = [
      '--repo', o.repo,
      '--pr', String(claim.pr || ''),
      '--branch', o.branch,
      ...pinnedArgs,
    ];
    log(`round[${repairRound}] codex@${reviewedHeadRefOid.slice(0, 8)}: ${B.codex}`);
    const cls = classifyCodex(await node(B.codex, codexArgs, { timeoutMs: o.codexTimeoutMs }));
    checks.codex = { status: cls.verdict, reason: cls.reason };
    if (cls.verdict === 'FAIL') {
      noteFailure({
        reason: `codex completed with ${cls.reason}`,
        repairable: true,
        dim: 'codex',
      });
    } else if (cls.verdict !== 'PASS' && codexRequired) {
      noteFailure({
        reason: `codex factual review could not complete (${cls.reason}) — required gate`,
        repairable: false,
        dim: 'codex',
      });
    } else {
      log(`round[${repairRound}] codex: ${cls.verdict}${cls.reason ? ` (${cls.reason})` : ''}`);
    }
  }

  return {
    pass: failure === null,
    failure,
    checks,
    reviewedHeadRefOid,
    repairRound,
  };
}

// ── the gate ──────────────────────────────────────────────────────────────────
// Returns { exitCode, plan:[...], action, reason } — a pure-ish orchestration result. All
// side-effects (mark-verified/merge/mark-failed/notify) happen here EXCEPT in dry-run, where
// only the plan is built and `action` is the INTENDED-but-skipped final action.
export async function runGate(o, deps = {}) {
  const B = deps.bins || bins();
  const node = deps.node || ((binPath, args, opts) => runNode(binPath, args, opts, deps));
  const resolveHead = deps.resolveBranchHead
    ? ((branch, repo) => deps.resolveBranchHead(branch, repo))
    : ((branch, repo) => resolveBranchHead(branch, repo, deps));
  const repair = deps.tryGateRepair || tryGateRepair;
  const inspectWorktree = deps.inspectReviewedWorktree
    ? ((worktree, head) => deps.inspectReviewedWorktree(worktree, head))
    : ((worktree, head) => inspectReviewedWorktree(worktree, head, deps));
  const bindPreview = deps.verifyPreviewBinding
    ? ((input) => deps.verifyPreviewBinding(input))
    : ((input) => verifyPreviewBinding(input, deps));
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

  const { worktree, articleTs, draftMd } = articlePaths(pgId, claim);
  log(`claim: pgId=${pgId} slug=${claim.slug} status=${claim.status}`);

  if (o.dryRun) {
    log('round[dry-run]: WOULD resolve immutable PR head and run chrome + all reviewers + codex on that SHA');
    log(`final: WOULD mark-verified --branch ${o.branch} --preview-url <sha-bound-preview> --head-ref-oid <reviewed-sha>`);
    log(`final: WOULD merge --branch ${o.branch}`);
    return { exitCode: EXIT.PUBLISHED, plan, action: 'WOULD mark-verified + merge', reason: 'dry-run' };
  }

  const configuredRounds = Number(process.env.GG_GATE_REPAIR_MAX_ROUNDS ?? 2);
  const maxRepairRounds = Math.min(3, Math.max(0,
    Number.isFinite(configuredRounds) ? Math.floor(configuredRounds) : 2));
  let previousFailedHead = null;

  for (let repairRound = 0; repairRound <= maxRepairRounds; repairRound += 1) {
    const reviewedHeadRefOid = await resolveHead(o.branch, o.repo);
    if (!reviewedHeadRefOid) {
      return gateFail(o, B, deps, pgId, claim, 'headRefOid required before gate round', plan);
    }
    if (!HEAD_REF_OID_RE.test(reviewedHeadRefOid)) {
      return gateFail(o, B, deps, pgId, claim,
        `branch head must be a 40-hex SHA, got "${reviewedHeadRefOid}"`, plan);
    }
    if (previousFailedHead === reviewedHeadRefOid) {
      return gateFail(o, B, deps, pgId, claim,
        `repair made no commit progress; head remained ${reviewedHeadRefOid}`, plan);
    }
    log(`round[${repairRound}]: pinned head ${reviewedHeadRefOid}`);

    const worktreeState = await inspectWorktree(worktree, reviewedHeadRefOid);
    if (!worktreeState?.ok) {
      return gateFail(o, B, deps, pgId, claim,
        worktreeState?.reason || 'review worktree is not pinned and clean', plan);
    }

    let previewUrl = null;
    const canReuseStoredPreview = repairRound === 0
      && claim.status === 'verified-preview'
      && claim.previewUrl
      && claim.headRefOid === reviewedHeadRefOid;
    if (canReuseStoredPreview) {
      previewUrl = claim.previewUrl;
      log(`round[${repairRound}] preview: reuse stored URL bound to claim head ${reviewedHeadRefOid.slice(0, 8)}`);
    } else {
      log(`round[${repairRound}] preview: wait for deployment of ${reviewedHeadRefOid.slice(0, 8)}`);
      const wr = await node(B.previewWait, [
        '--branch', o.branch,
        '--repo', o.repo,
        '--timeout-ms', String(o.previewTimeoutMs),
        '--head-ref-oid', reviewedHeadRefOid,
        '--json',
      ], { timeoutMs: o.previewTimeoutMs + 5000 });
      if (wr.timedOut) {
        return gateFail(o, B, deps, pgId, claim, 'preview-wait: hard timeout', plan);
      }
      const parsed = safeJson(lastJsonLine(wr.stdout));
      if (wr.code !== 0 || !parsed || !parsed.ok || !parsed.previewUrl) {
        const reason = parsed && parsed.reason ? parsed.reason : tail(wr.stderr) || `exit ${wr.code}`;
        return gateFail(o, B, deps, pgId, claim, `preview-wait failed: ${reason}`, plan);
      }
      previewUrl = parsed.previewUrl;
    }
    const previewBinding = await bindPreview({
      previewUrl,
      branch: o.branch,
      repo: o.repo,
      reviewedHeadRefOid,
    });
    if (!previewBinding?.ok) {
      return gateFail(o, B, deps, pgId, claim,
        previewBinding?.reason || `preview URL is not bound to reviewed head ${reviewedHeadRefOid}`, plan);
    }

    const outcome = await runFullGateRound({
      o,
      B,
      node,
      claim,
      articleTs,
      draftMd,
      previewUrl,
      previewBinding,
      reviewedHeadRefOid,
      repairRound,
      log,
    });

    if (outcome.pass) {
      const currentHead = await resolveHead(o.branch, o.repo);
      if (!currentHead) {
        return gateFail(o, B, deps, pgId, claim,
          'headRefOid required before mark-verified/merge', plan);
      }
      if (!HEAD_REF_OID_RE.test(currentHead)) {
        return gateFail(o, B, deps, pgId, claim,
          `current PR head must be a 40-hex SHA, got "${currentHead}"`, plan);
      }
      if (currentHead !== reviewedHeadRefOid) {
        return gateFail(o, B, deps, pgId, claim,
          `head drift ${reviewedHeadRefOid} -> ${currentHead}`, plan);
      }

      const evidence = JSON.stringify({
        reviewedHeadRefOid,
        repairRound,
        checks: outcome.checks,
      });
      log(`final: mark-verified --branch ${o.branch} --preview-url ${previewUrl} --head-ref-oid ${reviewedHeadRefOid}`);
      const mv = await node(B.autopilot, [
        '--mark-verified',
        '--branch', o.branch,
        '--preview-url', previewUrl,
        '--evidence', evidence,
        '--head-ref-oid', reviewedHeadRefOid,
      ], { timeoutMs: o.statusTimeoutMs });
      if (mv.timedOut || mv.code !== 0) {
        return gateFail(o, B, deps, pgId, claim,
          `mark-verified failed: ${mv.timedOut ? 'timeout' : tail(mv.stderr) || `exit ${mv.code}`}`, plan);
      }

      const mergeTimeoutMs = Number(process.env.GG_GATE_MERGE_TIMEOUT_MS) || 300000;
      const mg = await node(B.autopilot, ['--merge', '--branch', o.branch], { timeoutMs: mergeTimeoutMs });
      if (mg.timedOut || mg.code !== 0) {
        return gateFail(o, B, deps, pgId, claim,
          `merge failed: ${mg.timedOut ? 'timeout' : tail(mg.stderr) || `exit ${mg.code}`}`, plan);
      }
      log(`final: MERGED reviewed head ${reviewedHeadRefOid}`);
      return { exitCode: EXIT.PUBLISHED, plan, action: 'merged', reason: 'all required gates passed' };
    }

    if (!outcome.failure?.repairable || repairRound === maxRepairRounds) {
      return gateFail(o, B, deps, pgId, claim, outcome.failure?.reason || 'gate round failed', plan);
    }
    const beforeRepairState = await inspectWorktree(worktree, reviewedHeadRefOid);
    if (!beforeRepairState?.ok) {
      return gateFail(o, B, deps, pgId, claim,
        beforeRepairState?.reason || 'review worktree became unsafe before repair', plan);
    }
    const repairResult = await repair({
      dim: outcome.failure.dim,
      reason: outcome.failure.reason,
      articleTs,
      draftMd,
      worktree,
      branch: o.branch,
      expectedHead: reviewedHeadRefOid,
      node,
      B,
      log,
    });
    const applied = repairResult === true || repairResult?.applied === true;
    if (!applied) {
      return gateFail(o, B, deps, pgId, claim,
        repairResult?.reason || `${outcome.failure.reason}; repair was not applied`, plan);
    }
    if (repairResult?.headRefOid === reviewedHeadRefOid) {
      return gateFail(o, B, deps, pgId, claim,
        `repair made no commit progress; head remained ${reviewedHeadRefOid}`, plan);
    }
    previousFailedHead = reviewedHeadRefOid;
  }

  return gateFail(o, B, deps, pgId, claim, 'gate repair budget exhausted', plan);
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

  // Ops policy (2026-06-25): a gate park is an INTERMEDIATE state — an operator/agent
  // very often recovers it (fix the draft / env / links and re-gate). Broadcasting every
  // park spams the Feishu group with errors that get fixed minutes later. So by DEFAULT we
  // do NOT notify the group on a park; we only record the reason in the ledger + this plan
  // (whoever runs the gate sees it and can recover). A genuine ABANDONMENT — the article is
  // given up on and will not ship — is a DELIBERATE action: the operator/agent sends the
  // Feishu message themselves at that point. Set GG_GATE_NOTIFY_ON_PARK=1 to restore the
  // legacy always-notify-on-park behavior.
  const notifyOnPark = process.env.GG_GATE_NOTIFY_ON_PARK === '1';
  if (notifyOnPark) {
    // 统一事件层（NOTIFY-CONTRACT.md）：gate_fail 事件 —— 调用点只传结构化字段，
    // 模板与 @ 策略（PM+OPS）由事件表决定，不再在此拼消息／设 AT env。
    plan.push(`final: notify gate_fail via ${B.notify}（@PM @Ops 由事件表决定）`);
    await node(B.notify, [
      'gate_fail',
      '--site', GATE_SITE,
      '--slug', String(slug),
      '--branch', String(o.branch),
      '--reason', String(reason),
    ], { timeoutMs: o.statusTimeoutMs });
  } else {
    plan.push('final: park notify SUPPRESSED (intermediate state — recover & re-gate, or notify Feishu explicitly only on true abandonment; set GG_GATE_NOTIFY_ON_PARK=1 to re-enable)');
  }

  const notedAction = notifyOnPark
    ? (parkable ? 'parked + notified' : 'notified (already terminal)')
    : (parkable ? 'parked (notify suppressed)' : 'already terminal (notify suppressed)');
  return { exitCode: EXIT.GATE_FAILED, plan, action: notedAction, reason };
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
