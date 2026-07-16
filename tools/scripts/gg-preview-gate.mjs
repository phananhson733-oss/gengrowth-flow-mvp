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
import { createHash, randomUUID } from 'node:crypto';
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { homedir, tmpdir } from 'node:os';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  artifactShaForEvidence,
  artifactShaFromFiles,
  failureFingerprintFor,
  sitemapUrlsFromXml,
  verifyRenderedArtifacts,
} from './lib/seo-final-artifacts.mjs';
import {
  inspectBoundRepairDraft,
  inspectBoundRepairWorktree,
} from './lib/seo-repair-bindings.mjs';

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
const SHA256_RE = /^[0-9a-f]{64}$/i;
const LIVE_ORIGIN = 'https://www.astrologywiki.com';
const LIVE_SITEMAP = `${LIVE_ORIGIN}/sitemap.xml`;

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
  slug,
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
  const artifactShaBefore = artifactShaFromFiles({
    worktree,
    articlePath: articleTs,
    slug: String(slug || ''),
  });
  for (const e of edits) {
    if (!e || typeof e.old_string !== 'string' || typeof e.new_string !== 'string') { log(`repair[${dim}]: malformed edit — abort`); return false; }
    if ((content.split(e.old_string).length - 1) !== 1) { log(`repair[${dim}]: edit not uniquely present — abort`); return false; }
    content = content.replace(e.old_string, e.new_string);
  }
  try { writeFileSync(articleTs, content); } catch { log(`repair[${dim}]: write failed — abort`); return false; }
  const artifactShaAfter = artifactShaFromFiles({
    worktree,
    articlePath: articleTs,
    slug: String(slug || ''),
  });
  if (artifactShaAfter === artifactShaBefore) {
    try { writeFileSync(articleTs, originalContent); } catch {}
    return {
      applied: false,
      artifactShaBefore,
      artifactShaAfter,
      reason: 'repair produced no article/asset byte progress',
    };
  }
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
  // Controller repair worktrees are intentionally detached at the reviewed SHA.
  // `git push origin <branch>` would therefore push the stale local branch ref,
  // not the new detached HEAD commit, while still exiting 0 ("up to date").
  const remoteRef = `refs/heads/${branch}`;
  const pu = git(['push', 'origin', `HEAD:${remoteRef}`]);
  if (pu.status !== 0) {
    log(`repair[${dim}]: git push failed — local commit ${newHead.slice(0, 8)} retained as evidence`);
    return {
      applied: false,
      headRefOid: newHead,
      reason: `repair push failed; local commit ${newHead} retained: ${tail(pu.stderr) || `exit ${pu.status}`}`,
    };
  }
  const remote = git(['ls-remote', 'origin', remoteRef]);
  const remoteHead = String(remote.stdout || '').trim().split(/\s+/)[0] || '';
  if (remote.status !== 0 || remoteHead !== newHead) {
    return {
      applied: false,
      headRefOid: newHead,
      reason: `repair push did not converge remote ${remoteRef}: ${remoteHead || '?'} != ${newHead}`,
    };
  }
  log(`repair[${dim}]: applied ${edits.length} edit(s) + pushed ${newHead.slice(0, 8)} — starting a new full gate round`);
  return {
    applied: true,
    headRefOid: newHead,
    artifactShaBefore,
    artifactShaAfter,
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
    else if (a === '--worktree') o.worktree = argv[++i];
    else if (a === '--head-ref-oid') o.headRefOid = argv[++i];
    else if (a === '--draft') o.draft = argv[++i];
    else if (a === '--draft-sha256') o.draftSha256 = argv[++i];
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
export function articlePaths(pgId, claim, binding = null) {
  // Fallback mirrors gg-seo-autopilot.mjs worktreePath(): WORKTREE_ROOT + sanitized BRANCH
  // (env-overridable root, branch-keyed — NOT pgId). In practice claim.worktree is always set
  // before a claim can reach a preview status, so this fallback is defensive-only; it just must
  // not point somewhere different from the real worktree if it is ever hit.
  const worktreeRoot = process.env.GG_ORACLE_WORKTREE_ROOT || join(HOME, 'oracle-worktrees', 'seo-autopilot');
  const worktree = binding?.worktree || claim.worktree
    || join(worktreeRoot, String(claim.branch || '').replace(/[^A-Za-z0-9._-]+/g, '__'));
  const articleTs = join(worktree, 'data', 'articles', `${claim.slug}.ts`);
  const draftMd = binding?.draft || join(FLOW, '_staging', `${pgId}-en.md`);
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

export async function inspectDraftSnapshot(draftMd, deps = {}) {
  if (typeof deps.inspectDraftSnapshot === 'function') {
    return deps.inspectDraftSnapshot(draftMd);
  }
  if (!draftMd || !existsSync(draftMd)) {
    return { ok: true, exists: false, bytes: 0, sha256: null };
  }
  try {
    const bytes = readFileSync(draftMd);
    return {
      ok: true,
      exists: true,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (error) {
    return {
      ok: false,
      exists: null,
      bytes: null,
      sha256: null,
      reason: `draft snapshot unavailable: ${error?.message || String(error)}`,
    };
  }
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeArticlePathspec(worktree, articleTs) {
  const pathspec = relative(worktree, articleTs).replaceAll('\\', '/');
  if (!pathspec || pathspec === '.' || pathspec.startsWith('../') || isAbsolute(pathspec)) {
    throw new Error(`article path is outside review worktree: ${articleTs}`);
  }
  return pathspec;
}

function defaultSnapshotRoot() {
  const stateRoot = process.env.GG_FLOW_STATE_DIR
    || join(tmpdir(), 'gengrowth-flow-state');
  return join(stateRoot, 'preview-gate-review-snapshots');
}

export async function materializeReviewBundle({
  worktree,
  articleTs,
  draftMd,
  reviewedHeadRefOid,
  pgId,
  repairRound,
  snapshotRoot,
}, deps = {}) {
  try {
    if (!HEAD_REF_OID_RE.test(reviewedHeadRefOid || '')) {
      throw new Error(`reviewed head must be a 40-hex SHA, got "${reviewedHeadRefOid || ''}"`);
    }
    const articlePathspec = safeArticlePathspec(worktree, articleTs);
    const root = resolve(snapshotRoot || deps.snapshotRoot || defaultSnapshotRoot());
    const liveWorktree = resolve(worktree);
    if (root === liveWorktree || root.startsWith(`${liveWorktree}${sep}`)) {
      throw new Error('review snapshot root must be independent of the live worktree');
    }

    let articleBytes;
    if (typeof deps.readArticleAtHead === 'function') {
      articleBytes = Buffer.from(await deps.readArticleAtHead({
        worktree,
        reviewedHeadRefOid,
        articlePathspec,
      }));
    } else {
      const object = `${reviewedHeadRefOid}:${articlePathspec}`;
      const shown = spawnSync('git', ['-C', worktree, 'show', object], {
        encoding: null,
        timeout: DEFAULTS.statusTimeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      });
      if (shown.error || shown.status !== 0) {
        const stderr = Buffer.isBuffer(shown.stderr)
          ? shown.stderr.toString('utf8')
          : String(shown.stderr || '');
        throw new Error(
          `git object unavailable ${object}: ${shown.error?.message || tail(stderr) || `exit ${shown.status}`}`,
        );
      }
      articleBytes = Buffer.from(shown.stdout || Buffer.alloc(0));
    }
    if (articleBytes.length === 0) throw new Error('review article snapshot is empty');

    if (!draftMd || !existsSync(draftMd)) {
      throw new Error(`review draft unavailable: ${draftMd || '<missing path>'}`);
    }
    const draftBytes = readFileSync(draftMd);
    if (draftBytes.length === 0) throw new Error('review draft snapshot is empty');

    mkdirSync(root, { recursive: true, mode: 0o700 });
    const snapshotId = [
      String(pgId || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '_'),
      reviewedHeadRefOid.slice(0, 12),
      `r${Number.isInteger(repairRound) ? repairRound : 0}`,
      randomUUID(),
    ].join('-');
    const directory = join(root, snapshotId);
    mkdirSync(directory, { recursive: false, mode: 0o700 });
    const articlePath = join(directory, 'article.ts');
    const draftPath = join(directory, 'draft.md');
    writeFileSync(articlePath, articleBytes, { flag: 'wx', mode: 0o400 });
    writeFileSync(draftPath, draftBytes, { flag: 'wx', mode: 0o400 });
    chmodSync(articlePath, 0o444);
    chmodSync(draftPath, 0o444);
    chmodSync(directory, 0o555);

    const bundle = {
      ok: true,
      snapshotId,
      directory,
      reviewedHeadRefOid: reviewedHeadRefOid.toLowerCase(),
      article: {
        path: articlePath,
        gitObject: `${reviewedHeadRefOid.toLowerCase()}:${articlePathspec}`,
        bytes: articleBytes.length,
        sha256: sha256Bytes(articleBytes),
      },
      draft: {
        path: draftPath,
        sourcePath: draftMd,
        bytes: draftBytes.length,
        sha256: sha256Bytes(draftBytes),
      },
    };
    const verified = await verifyReviewBundle(bundle);
    if (!verified.ok) return verified;
    return bundle;
  } catch (error) {
    return {
      ok: false,
      reason: `review snapshot materialization failed: ${error?.message || String(error)}`,
    };
  }
}

export async function verifyReviewBundle(bundle, deps = {}) {
  if (typeof deps.verifyReviewBundle === 'function') {
    return deps.verifyReviewBundle(bundle);
  }
  try {
    if (!bundle?.ok || !HEAD_REF_OID_RE.test(bundle.reviewedHeadRefOid || '')) {
      throw new Error('review snapshot metadata is invalid');
    }
    for (const [label, input] of Object.entries({
      article: bundle.article,
      draft: bundle.draft,
    })) {
      if (!input?.path || !/^[0-9a-f]{64}$/i.test(input.sha256 || '')) {
        throw new Error(`${label} snapshot metadata is invalid`);
      }
      const bytes = readFileSync(input.path);
      const actualSha256 = sha256Bytes(bytes);
      if (bytes.length !== input.bytes) {
        throw new Error(`${label} snapshot byte length mismatch (${bytes.length} != ${input.bytes})`);
      }
      if (actualSha256 !== input.sha256) {
        throw new Error(`${label} snapshot digest mismatch (${actualSha256} != ${input.sha256})`);
      }
      if ((statSync(input.path).mode & 0o222) !== 0) {
        throw new Error(`${label} snapshot is writable`);
      }
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `review snapshot integrity failed: ${error?.message || String(error)}`,
    };
  }
}

function reviewBundleEvidence(bundle) {
  return {
    reviewedHeadRefOid: bundle.reviewedHeadRefOid,
    snapshotId: bundle.snapshotId,
    article: {
      gitObject: bundle.article.gitObject,
      bytes: bundle.article.bytes,
      sha256: bundle.article.sha256,
    },
    draft: {
      bytes: bundle.draft.bytes,
      sha256: bundle.draft.sha256,
    },
  };
}

function sameDraftSnapshot(left, right) {
  return Boolean(left?.ok && right?.ok)
    && left.exists === right.exists
    && left.bytes === right.bytes
    && left.sha256 === right.sha256;
}

function parseCodexInputEvidence(stdout) {
  const prefix = 'GG_CODEX_INPUT_EVIDENCE=';
  const lines = String(stdout || '').replace(/\r\n?/g, '\n').split('\n');
  const line = [...lines].reverse().find((row) => row.startsWith(prefix));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(prefix.length));
  } catch {
    return null;
  }
}

function normalizePreviewUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function trustedVercelPreviewUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== 'https:' || !url.hostname.toLowerCase().endsWith('.vercel.app')) return null;
    return normalizePreviewUrl(url.origin);
  } catch {
    return null;
  }
}

function trustedVercelInspectorUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || (hostname !== 'vercel.com' && hostname !== 'www.vercel.com')) {
      return null;
    }
    return normalizePreviewUrl(url.toString());
  } catch {
    return null;
  }
}

function structuredVercelCommentBindings(body) {
  const bindings = [];
  for (const match of String(body || '').matchAll(/\[vc\]: #[^:\r\n]+:([A-Za-z0-9+/=]+)/g)) {
    try {
      const metadata = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
      for (const project of Array.isArray(metadata?.projects) ? metadata.projects : []) {
        const previewUrl = trustedVercelPreviewUrl(project?.previewUrl);
        const inspectorUrl = trustedVercelInspectorUrl(project?.inspectorUrl);
        if (!previewUrl || !inspectorUrl || String(project?.nextCommitStatus || '') !== 'DEPLOYED') continue;
        bindings.push({
          project: String(project?.name || ''),
          previewUrl,
          inspectorUrl,
        });
      }
    } catch {}
  }
  return bindings;
}

function failedArtifactEvidence(kind, reason) {
  return {
    ok: false,
    checked: [],
    failed: [{ reason }],
    ignored: [],
    kind,
  };
}

export async function verifyPreviewFinalArtifacts({
  previewUrl,
  slug,
  reviewBundle,
  reviewedHeadRefOid,
  previewEvidence,
}, deps = {}) {
  if (previewEvidence?.final_links && previewEvidence?.final_assets) {
    const final_links = previewEvidence.final_links;
    const final_assets = previewEvidence.final_assets;
    const ok = final_links?.ok === true && final_assets?.ok === true;
    return {
      ok,
      inputAvailable: previewEvidence.inputAvailable !== false,
      reviewedHeadRefOid,
      artifactSha: artifactShaForEvidence({
        articleSha: reviewBundle.article.sha256,
        finalAssets: final_assets,
      }),
      failureFingerprint: ok ? null : failureFingerprintFor({
        final_links: final_links?.failed || [],
        final_assets: final_assets?.failed || [],
      }),
      final_links,
      final_assets,
    };
  }

  const rawFetch = deps.fetchFinalArtifact || globalThis.fetch?.bind(globalThis);
  if (typeof rawFetch !== 'function') {
    const reason = 'final artifact fetch implementation unavailable';
    const final_links = failedArtifactEvidence('final_links', reason);
    const final_assets = failedArtifactEvidence('final_assets', reason);
    return {
      ok: false,
      inputAvailable: false,
      reviewedHeadRefOid,
      artifactSha: artifactShaForEvidence({
        articleSha: reviewBundle.article.sha256,
        finalAssets: final_assets,
      }),
      failureFingerprint: failureFingerprintFor({ final_links: final_links.failed, final_assets: final_assets.failed }),
      final_links,
      final_assets,
    };
  }
  const boundedFetch = (url, init = {}) => rawFetch(url, {
    ...init,
    signal: init.signal || AbortSignal.timeout(30_000),
  });
  const previewPageUrl = new URL(`/en/wiki/${slug}`, `${normalizePreviewUrl(previewUrl)}/`).toString();
  const previewOrigin = new URL(previewPageUrl).origin;
  const livePageUrl = `${LIVE_ORIGIN}/en/wiki/${slug}`;
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '';
  const previewHeaders = {
    'user-agent': 'gg-preview-final-artifacts/1',
    ...(bypassSecret
      ? {
        'x-vercel-protection-bypass': bypassSecret,
      }
      : {}),
  };
  const finalArtifactFetch = (url, init = {}) => {
    const targetOrigin = new URL(url).origin;
    const headers = { ...(init.headers || {}) };
    if (bypassSecret && targetOrigin === previewOrigin) {
      headers['x-vercel-protection-bypass'] = bypassSecret;
    } else {
      delete headers['x-vercel-protection-bypass'];
    }
    // `x-vercel-set-bypass-cookie` is for browser navigation. Direct fetches
    // authenticate every preview-origin request with the bypass header itself;
    // asking Vercel to set a cookie here produces a 307 that a stateless fetch
    // cannot use and must never be mistaken for broken article content.
    delete headers['x-vercel-set-bypass-cookie'];
    return boundedFetch(url, { ...init, headers });
  };

  let pageHtml = '';
  let sitemapText = '';
  try {
    const [page, liveSitemap] = await Promise.all([
      boundedFetch(previewPageUrl, { redirect: 'manual', headers: previewHeaders }),
      boundedFetch(LIVE_SITEMAP, {
        redirect: 'follow',
        headers: { 'user-agent': 'gg-preview-final-artifacts/1' },
      }),
    ]);
    if (Number(page?.status || 0) !== 200) {
      throw new Error(`preview article HTTP ${Number(page?.status || 0)}`);
    }
    if (Number(liveSitemap?.status || 0) !== 200) {
      throw new Error(`live sitemap HTTP ${Number(liveSitemap?.status || 0)}`);
    }
    [pageHtml, sitemapText] = await Promise.all([page.text(), liveSitemap.text()]);
  } catch (error) {
    const reason = `final artifact input unavailable: ${error?.message || String(error)}`;
    const final_links = failedArtifactEvidence('final_links', reason);
    const final_assets = failedArtifactEvidence('final_assets', reason);
    return {
      ok: false,
      inputAvailable: false,
      reviewedHeadRefOid,
      artifactSha: artifactShaForEvidence({
        articleSha: reviewBundle.article.sha256,
        finalAssets: final_assets,
      }),
      failureFingerprint: failureFingerprintFor({ final_links: final_links.failed, final_assets: final_assets.failed }),
      final_links,
      final_assets,
    };
  }
  const sitemapUrls = sitemapUrlsFromXml(sitemapText);
  const allowedRoutes = new Set(
    [...sitemapUrls].map((entry) => {
      try { return new URL(entry).pathname; } catch { return ''; }
    }).filter(Boolean),
  );
  const verified = await verifyRenderedArtifacts({
    html: pageHtml,
    pageUrl: livePageUrl,
    assetBaseUrl: previewPageUrl,
    allowedRoutes,
    sitemapUrls,
    fetch: finalArtifactFetch,
    decodeImage: deps.decodeImage,
    allowedAssetHosts: deps.allowedAssetHosts,
    resolveAssetHost: deps.resolveAssetHost,
    articleSha: reviewBundle.article.sha256,
    reviewedHeadRefOid,
  });
  return { ...verified, inputAvailable: true };
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
  let matchingDeploymentSeen = false;
  const deployments = await gh(['api', `repos/${repo}/deployments?ref=${encodeURIComponent(branch)}`]);
  if (deployments.code === 0) {
    const rows = safeJson(deployments.stdout);
    if (Array.isArray(rows)) {
      const matching = rows.filter((row) => String(row?.sha || '') === reviewedHeadRefOid);
      matchingDeploymentSeen = matching.length > 0;
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
    }
  }

  const statusResult = await gh(['api', `repos/${repo}/commits/${reviewedHeadRefOid}/status`]);
  const statusJson = statusResult.code === 0 ? safeJson(statusResult.stdout) : null;
  const statuses = Array.isArray(statusJson?.statuses) ? statusJson.statuses : [];
  const successfulVercelStatuses = statuses.filter((status) => (
    String(status?.context || '').toLowerCase().includes('vercel')
    && String(status?.state || '').toLowerCase() === 'success'
  ));
  const boundStatus = successfulVercelStatuses.find((status) => (
    [status?.target_url, status?.details_url, status?.environment_url]
      .map(normalizePreviewUrl)
      .includes(targetUrl)
  ));
  if (boundStatus) {
    return {
      ok: true,
      method: 'vercel-commit-status-url',
      context: String(boundStatus.context || ''),
    };
  }

  const targetVercelUrl = trustedVercelPreviewUrl(targetUrl);
  const successfulInspectorUrls = new Set(successfulVercelStatuses
    .flatMap((status) => [status?.target_url, status?.details_url, status?.environment_url])
    .map(trustedVercelInspectorUrl)
    .filter(Boolean));
  if (targetVercelUrl && successfulInspectorUrls.size > 0) {
    const pullsResult = await gh(['api', `repos/${repo}/commits/${reviewedHeadRefOid}/pulls`]);
    const pulls = pullsResult.code === 0 ? safeJson(pullsResult.stdout) : null;
    const openReviewedPulls = Array.isArray(pulls)
      ? pulls.filter((pull) => (
        String(pull?.state || '').toLowerCase() === 'open'
        && String(pull?.head?.sha || '') === reviewedHeadRefOid
        && pull?.number != null
      ))
      : [];
    const expectedProject = String(repo || '').split('/').at(-1);
    for (const pull of openReviewedPulls) {
      const commentsResult = await gh(['api', `repos/${repo}/issues/${pull.number}/comments`]);
      const comments = commentsResult.code === 0 ? safeJson(commentsResult.stdout) : null;
      if (!Array.isArray(comments)) continue;
      for (let index = comments.length - 1; index >= 0; index -= 1) {
        const comment = comments[index];
        if (!/^vercel(\[bot\])?$/i.test(String(comment?.user?.login || '').trim())) continue;
        const trustedBinding = structuredVercelCommentBindings(comment?.body).find((binding) => (
          binding.project === expectedProject
          && binding.previewUrl === targetVercelUrl
          && successfulInspectorUrls.has(binding.inspectorUrl)
        ));
        if (trustedBinding) {
          return {
            ok: true,
            method: 'vercel-reviewed-pr-comment',
            pullNumber: pull.number,
          };
        }
      }
    }
  }

  return {
    ok: false,
    reason: matchingDeploymentSeen
      ? `preview deployment is not bound to reviewed head ${reviewedHeadRefOid}`
      : `preview URL is not exactly bound by a successful Vercel status on reviewed head ${reviewedHeadRefOid}`,
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
  draftSnapshot,
  reviewBundle,
  verifyReviewInputs,
  verifyFinalArtifacts,
  reviewedHeadRefOid,
  repairRound,
  log,
}) {
  const checks = {
    preview_binding: previewBinding,
    draft_snapshot: draftSnapshot,
    review_inputs: reviewBundleEvidence(reviewBundle),
  };
  let failure = null;
  const noteFailure = (candidate) => {
    if (!failure) failure = candidate;
  };
  const pinnedArgs = ['--head-ref-oid', reviewedHeadRefOid];
  let previewEvidence = null;

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
      previewEvidence = vj;
      log(`round[${repairRound}] verify: PASS (${(vj.checked || []).length} url(s))`);
    }
  }

  for (const dim of REVIEW_DIMENSIONS) {
    const bundleIntegrity = await verifyReviewInputs(reviewBundle);
    if (!bundleIntegrity?.ok) {
      const reason = bundleIntegrity?.reason || 'review snapshot integrity unavailable';
      checks[dim] = { status: 'SKIPPED', reason };
      noteFailure({
        reason: `review[${dim}] snapshot integrity failed: ${reason}`,
        repairable: false,
        dim,
      });
      continue;
    }
    const args = [
      '--dimension', dim,
      '--article', reviewBundle.article.path,
      '--draft', reviewBundle.draft.path,
      '--timeout-ms', String(o.reviewTimeoutMs),
      ...pinnedArgs,
      '--article-sha256', reviewBundle.article.sha256,
      '--draft-sha256', reviewBundle.draft.sha256,
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
    const inputEvidenceOk = rj?.reviewedHeadRefOid === reviewedHeadRefOid
      && rj?.inputSha256?.article === reviewBundle.article.sha256
      && rj?.inputSha256?.draft === reviewBundle.draft.sha256;
    if (!inputEvidenceOk) {
      const reason = 'review worker input evidence does not match immutable snapshot bundle';
      checks[dim] = { status: 'SKIPPED', reason };
      noteFailure({
        reason: `review[${dim}] ${reason}`,
        repairable: false,
        dim,
      });
      continue;
    }
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
    const codexResult = await node(B.codex, codexArgs, { timeoutMs: o.codexTimeoutMs });
    const cls = classifyCodex(codexResult);
    const codexEvidence = parseCodexInputEvidence(codexResult.stdout);
    const codexEvidenceOk = codexEvidence?.reviewedHeadRefOid === reviewedHeadRefOid
      && HEAD_REF_OID_RE.test(codexEvidence?.baseRefOid || '')
      && /^[0-9a-f]{64}$/i.test(codexEvidence?.inputSha256 || '')
      && Number.isInteger(codexEvidence?.bytes)
      && codexEvidence.bytes > 0;
    checks.codex = {
      status: cls.verdict,
      reason: cls.reason,
      input: codexEvidence,
    };
    if (cls.verdict === 'PASS' && !codexEvidenceOk) {
      const reason = 'codex input evidence does not bind the reviewed head';
      checks.codex = { status: 'SKIPPED', reason, input: codexEvidence };
      noteFailure({
        reason: `codex ${reason}`,
        repairable: false,
        dim: 'codex',
      });
    } else if (cls.verdict === 'FAIL') {
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

  let finalArtifacts;
  try {
    finalArtifacts = await verifyFinalArtifacts({
      previewUrl,
      slug: String(claim.slug),
      articleTs,
      draftMd,
      reviewBundle,
      reviewedHeadRefOid,
      repairRound,
      previewEvidence,
    });
  } catch (error) {
    const reason = `final artifact verifier crashed: ${error?.message || String(error)}`;
    finalArtifacts = {
      ok: false,
      inputAvailable: false,
      reviewedHeadRefOid,
      artifactSha: artifactShaForEvidence({
        articleSha: reviewBundle.article.sha256,
        finalAssets: { checked: [], failed: [] },
      }),
      failureFingerprint: failureFingerprintFor({ reason }),
      final_links: failedArtifactEvidence('final_links', reason),
      final_assets: failedArtifactEvidence('final_assets', reason),
    };
  }
  const artifactEvidenceHeadOk = finalArtifacts?.reviewedHeadRefOid === reviewedHeadRefOid;
  checks.final_links = finalArtifacts?.final_links || failedArtifactEvidence(
    'final_links',
    'structured final_links evidence missing',
  );
  checks.final_assets = finalArtifacts?.final_assets || failedArtifactEvidence(
    'final_assets',
    'structured final_assets evidence missing',
  );
  if (!artifactEvidenceHeadOk) {
    noteFailure({
      reason: 'final artifact evidence does not bind the reviewed head',
      repairable: false,
      dim: 'final_artifacts',
    });
  } else if (finalArtifacts?.inputAvailable === false) {
    noteFailure({
      reason: checks.final_links.failed?.[0]?.reason
        || checks.final_assets.failed?.[0]?.reason
        || 'final artifact input unavailable',
      repairable: false,
      dim: 'final_artifacts',
    });
  } else if (checks.final_links.ok !== true) {
    noteFailure({
      reason: `final_links failed: ${checks.final_links.failed?.[0]?.reason || 'unknown link failure'}`,
      repairable: true,
      dim: 'final_links',
      repairDim: 'links-seo',
    });
  } else if (checks.final_assets.ok !== true) {
    noteFailure({
      reason: `final_assets failed: ${checks.final_assets.failed?.[0]?.reason || 'unknown asset failure'}`,
      repairable: false,
      dim: 'final_assets',
    });
  } else {
    log(`round[${repairRound}] final artifacts: PASS links=${checks.final_links.checked?.length || 0} assets=${checks.final_assets.checked?.length || 0}`);
  }

  const failureFingerprint = failure
    ? failureFingerprintFor({
        dim: failure.dim,
        reason: failure.reason,
        check: checks[failure.dim] || null,
      })
    : null;
  return {
    pass: failure === null,
    failure,
    checks,
    reviewedHeadRefOid,
    repairRound,
    artifactSha: finalArtifacts?.artifactSha || artifactShaForEvidence({
      articleSha: reviewBundle.article.sha256,
      finalAssets: checks.final_assets,
    }),
    failureFingerprint,
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
  const inspectDraft = deps.inspectDraftSnapshot
    ? ((draftMd) => deps.inspectDraftSnapshot(draftMd))
    : ((draftMd) => inspectDraftSnapshot(draftMd, deps));
  const resolveArticlePaths = deps.articlePaths || articlePaths;
  const materializeInputs = deps.materializeReviewBundle
    ? ((input) => deps.materializeReviewBundle(input))
    : ((input) => materializeReviewBundle({
      ...input,
      snapshotRoot: deps.reviewSnapshotRoot,
    }));
  const verifyReviewInputs = deps.verifyReviewBundle
    ? ((bundle) => deps.verifyReviewBundle(bundle))
    : ((bundle) => verifyReviewBundle(bundle));
  const verifyFinalArtifacts = deps.verifyFinalArtifacts
    ? ((input) => deps.verifyFinalArtifacts(input))
    : ((input) => verifyPreviewFinalArtifacts(input, deps));
  const inspectRepairWorktree = deps.inspectBoundRepairWorktree
    ? ((input) => deps.inspectBoundRepairWorktree(input))
    : ((input) => inspectBoundRepairWorktree(input));
  const inspectRepairDraft = deps.inspectBoundRepairDraft
    ? ((input) => deps.inspectBoundRepairDraft(input))
    : ((input) => inspectBoundRepairDraft(input));
  const plan = [];
  const log = (line) => plan.push(line);
  const repairBindingValues = [o.worktree, o.headRefOid, o.draft, o.draftSha256];
  const explicitRepairBinding = repairBindingValues.some((value) => value != null && value !== '');
  if (explicitRepairBinding) {
    if (repairBindingValues.some((value) => value == null || value === '')) {
      const reason = 'complete repair binding requires --worktree, --head-ref-oid, --draft, and --draft-sha256';
      log(`FAIL reason: ${reason}`);
      return { exitCode: EXIT.GATE_FAILED, plan, action: 'invalid repair binding', reason };
    }
    if (!isAbsolute(o.worktree)) {
      const reason = '--worktree repair binding must be an absolute path';
      log(`FAIL reason: ${reason}`);
      return { exitCode: EXIT.GATE_FAILED, plan, action: 'invalid repair binding', reason };
    }
    if (!HEAD_REF_OID_RE.test(o.headRefOid)) {
      const reason = '--head-ref-oid repair binding must be a 40-hex SHA';
      log(`FAIL reason: ${reason}`);
      return { exitCode: EXIT.GATE_FAILED, plan, action: 'invalid repair binding', reason };
    }
    if (!isAbsolute(o.draft)) {
      const reason = '--draft repair binding must be an absolute path';
      log(`FAIL reason: ${reason}`);
      return { exitCode: EXIT.GATE_FAILED, plan, action: 'invalid repair binding', reason };
    }
    if (!SHA256_RE.test(o.draftSha256)) {
      const reason = '--draft-sha256 repair binding must be 64 hex characters';
      log(`FAIL reason: ${reason}`);
      return { exitCode: EXIT.GATE_FAILED, plan, action: 'invalid repair binding', reason };
    }
  }

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

  const repairInputBinding = explicitRepairBinding
    ? { worktree: o.worktree, draft: o.draft }
    : null;
  const { worktree, articleTs, draftMd } = resolveArticlePaths(pgId, claim, repairInputBinding);
  log(`claim: pgId=${pgId} slug=${claim.slug} status=${claim.status}`);

  if (o.dryRun) {
    log('round[dry-run]: WOULD resolve immutable PR head and run chrome + all reviewers + codex on that SHA');
    log(`final: WOULD mark-verified --branch ${o.branch} --preview-url <sha-bound-preview> --head-ref-oid <reviewed-sha>`);
    log(`final: WOULD merge --branch ${o.branch}`);
    return { exitCode: EXIT.PUBLISHED, plan, action: 'WOULD mark-verified + merge', reason: 'dry-run' };
  }

  const configuredRounds = Number(process.env.GG_GATE_REPAIR_MAX_ROUNDS ?? 2);
  const maxRepairRounds = Math.min(3, Math.max(1,
    Number.isFinite(configuredRounds) ? Math.floor(configuredRounds) : 2));
  const configuredTotalBudget = Number(process.env.GG_GATE_REPAIR_TOTAL_BUDGET ?? 3);
  const totalRepairBudget = Math.min(3, Math.max(1,
    Number.isFinite(configuredTotalBudget) ? Math.floor(configuredTotalBudget) : 3));
  const perDimensionBudget = 2;
  let previousFailedHead = null;
  let previousFailurePair = null;
  let noProgressCount = 0;
  let totalRepairEdits = 0;
  const repairEditsByDimension = {};
  let activeExpectedHead = explicitRepairBinding ? o.headRefOid : null;

  for (let repairRound = 0; repairRound <= maxRepairRounds; repairRound += 1) {
    const remoteHeadRefOid = await resolveHead(o.branch, o.repo);
    if (explicitRepairBinding && remoteHeadRefOid !== activeExpectedHead) {
      return gateFail(o, B, deps, pgId, claim,
        `remote PR head ${remoteHeadRefOid || '?'} does not match expected repair head ${activeExpectedHead}`, plan);
    }
    const reviewedHeadRefOid = explicitRepairBinding ? activeExpectedHead : remoteHeadRefOid;
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

    const worktreeState = explicitRepairBinding
      ? await inspectRepairWorktree({
          worktree,
          expectedHead: reviewedHeadRefOid,
          remoteHead: remoteHeadRefOid,
        })
      : await inspectWorktree(worktree, reviewedHeadRefOid);
    if (!worktreeState?.ok) {
      return gateFail(o, B, deps, pgId, claim,
        worktreeState?.reason || 'review worktree is not pinned and clean', plan);
    }
    const boundDraftState = explicitRepairBinding
      ? await inspectRepairDraft({
          draftFile: draftMd,
          expectedSha256: o.draftSha256,
        })
      : null;
    if (explicitRepairBinding && !boundDraftState?.ok) {
      return gateFail(o, B, deps, pgId, claim,
        boundDraftState?.reason || 'repair draft is not bound to the expected digest', plan);
    }
    const reviewBundle = await materializeInputs({
      worktree,
      articleTs,
      draftMd,
      reviewedHeadRefOid,
      pgId,
      repairRound,
    });
    if (!reviewBundle?.ok) {
      return gateFail(o, B, deps, pgId, claim,
        reviewBundle?.reason || 'review snapshot materialization failed before gate round', plan);
    }
    const initialBundleIntegrity = await verifyReviewInputs(reviewBundle);
    if (!initialBundleIntegrity?.ok) {
      return gateFail(o, B, deps, pgId, claim,
        initialBundleIntegrity?.reason || 'review snapshot integrity failed before gate round', plan);
    }
    const draftSnapshot = explicitRepairBinding
      ? {
          ok: true,
          exists: true,
          bytes: boundDraftState.bytes,
          sha256: boundDraftState.sha256,
        }
      : {
          ok: true,
          exists: true,
          bytes: reviewBundle.draft.bytes,
          sha256: reviewBundle.draft.sha256,
        };
    log(`round[${repairRound}] draft: ${draftSnapshot.exists
      ? `${draftSnapshot.sha256.slice(0, 12)} (${draftSnapshot.bytes} bytes)`
      : 'missing'}`);
    log(`round[${repairRound}] review snapshot: ${reviewBundle.snapshotId || 'materialized'} article=${reviewBundle.article.sha256.slice(0, 12)}`);

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
      draftSnapshot,
      reviewBundle,
      verifyReviewInputs,
      verifyFinalArtifacts,
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
      const finalWorktreeState = explicitRepairBinding
        ? await inspectRepairWorktree({
            worktree,
            expectedHead: reviewedHeadRefOid,
            remoteHead: currentHead,
          })
        : await inspectWorktree(worktree, reviewedHeadRefOid);
      if (!finalWorktreeState?.ok) {
        return gateFail(o, B, deps, pgId, claim,
          finalWorktreeState?.reason
          || 'review worktree changed after local checks; refusing mark-verified', plan);
      }
      log(`round[${repairRound}]: final local worktree recheck PASS for ${reviewedHeadRefOid.slice(0, 8)}`);
      const finalBundleIntegrity = await verifyReviewInputs(reviewBundle);
      if (!finalBundleIntegrity?.ok) {
        return gateFail(o, B, deps, pgId, claim,
          finalBundleIntegrity?.reason
          || 'review snapshot integrity changed after local checks; refusing mark-verified', plan);
      }
      log(`round[${repairRound}]: final review snapshot integrity PASS`);
      const finalDraftSnapshot = explicitRepairBinding
        ? await inspectRepairDraft({
            draftFile: draftMd,
            expectedSha256: o.draftSha256,
          })
        : await inspectDraft(draftMd);
      if (!sameDraftSnapshot(draftSnapshot, finalDraftSnapshot)) {
        return gateFail(o, B, deps, pgId, claim,
          finalDraftSnapshot?.reason
          || 'draft bytes changed after local checks; refusing mark-verified', plan);
      }
      log(`round[${repairRound}]: final draft snapshot recheck PASS`);

      const evidence = JSON.stringify({
        reviewedHeadRefOid,
        repairRound,
        checks: outcome.checks,
        artifactSha: outcome.artifactSha,
        failureFingerprint: outcome.failureFingerprint,
        noProgressCount,
        totalRepairEdits,
        repairEditsByDimension,
      });
      log(`final: mark-verified --branch ${o.branch} --preview-url ${previewUrl} --head-ref-oid ${reviewedHeadRefOid}`);
      const mv = await node(B.autopilot, [
        '--mark-verified',
        '--branch', o.branch,
        '--preview-url', previewUrl,
        '--evidence', evidence,
        '--head-ref-oid', reviewedHeadRefOid,
        ...(explicitRepairBinding
          ? [
              '--worktree', worktree,
              '--draft', draftMd,
              '--draft-sha256', o.draftSha256,
            ]
          : []),
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

    if (!SHA256_RE.test(outcome.artifactSha || '') || !SHA256_RE.test(outcome.failureFingerprint || '')) {
      return gateFail(o, B, deps, pgId, claim,
        `${outcome.failure?.reason || 'gate round failed'}; artifact progress evidence missing`, plan);
    }
    const failurePair = `${outcome.artifactSha}:${outcome.failureFingerprint}`;
    noProgressCount = failurePair === previousFailurePair ? noProgressCount + 1 : 0;
    previousFailurePair = failurePair;
    if (noProgressCount >= 2) {
      return gateFail(o, B, deps, pgId, claim,
        `no_progress artifactSha=${outcome.artifactSha} failureFingerprint=${outcome.failureFingerprint}`, plan);
    }
    if (!outcome.failure?.repairable || repairRound === maxRepairRounds) {
      return gateFail(o, B, deps, pgId, claim, outcome.failure?.reason || 'gate round failed', plan);
    }
    const budgetDimension = outcome.failure.dim || 'unknown';
    if (totalRepairEdits >= totalRepairBudget) {
      return gateFail(o, B, deps, pgId, claim,
        `total repair edit budget exhausted (${totalRepairBudget})`, plan);
    }
    if ((repairEditsByDimension[budgetDimension] || 0) >= perDimensionBudget) {
      return gateFail(o, B, deps, pgId, claim,
        `repair edit budget exhausted for ${budgetDimension} (${perDimensionBudget})`, plan);
    }
    const beforeRepairState = explicitRepairBinding
      ? await inspectRepairWorktree({
          worktree,
          expectedHead: reviewedHeadRefOid,
          remoteHead: remoteHeadRefOid,
        })
      : await inspectWorktree(worktree, reviewedHeadRefOid);
    if (!beforeRepairState?.ok) {
      return gateFail(o, B, deps, pgId, claim,
        beforeRepairState?.reason || 'review worktree became unsafe before repair', plan);
    }
    const repairResult = await repair({
      dim: outcome.failure.repairDim || outcome.failure.dim,
      reason: outcome.failure.reason,
      articleTs,
      draftMd,
      worktree,
      branch: o.branch,
      expectedHead: reviewedHeadRefOid,
      slug: claim.slug,
      artifactSha: outcome.artifactSha,
      failureFingerprint: outcome.failureFingerprint,
      totalRepairEdits,
      repairEditsByDimension: { ...repairEditsByDimension },
      node,
      B,
      log,
    });
    const applied = repairResult === true || repairResult?.applied === true;
    if (!applied) {
      return gateFail(o, B, deps, pgId, claim,
        repairResult?.reason || `${outcome.failure.reason}; repair was not applied`, plan);
    }
    if (explicitRepairBinding && !HEAD_REF_OID_RE.test(repairResult?.headRefOid || '')) {
      return gateFail(o, B, deps, pgId, claim,
        'repair did not return the exact pushed head for the next bound gate round', plan);
    }
    if (repairResult?.headRefOid === reviewedHeadRefOid) {
      return gateFail(o, B, deps, pgId, claim,
        `repair made no commit progress; head remained ${reviewedHeadRefOid}`, plan);
    }
    if (!SHA256_RE.test(repairResult?.artifactShaBefore || '')
      || !SHA256_RE.test(repairResult?.artifactShaAfter || '')) {
      return gateFail(o, B, deps, pgId, claim,
        'repair artifact hash evidence missing; refusing unaccounted edit', plan);
    }
    if (repairResult.artifactShaAfter !== repairResult.artifactShaBefore) {
      totalRepairEdits += 1;
      repairEditsByDimension[budgetDimension] = (repairEditsByDimension[budgetDimension] || 0) + 1;
      log(`repair budget: total=${totalRepairEdits}/${totalRepairBudget} ${budgetDimension}=${repairEditsByDimension[budgetDimension]}/${perDimensionBudget}`);
    } else {
      log(`repair budget: unchanged artifact bytes — edit not counted (${budgetDimension})`);
    }
    if (explicitRepairBinding) activeExpectedHead = repairResult.headRefOid;
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
  const node = deps.node || ((binPath, args, opts) => runNode(binPath, args, opts, deps));
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
