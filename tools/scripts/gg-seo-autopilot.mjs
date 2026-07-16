#!/usr/bin/env node
// gg-seo-autopilot.mjs — downstream-only SEO publish autopilot.
//
// Scans the latest ops weekly blog-output plan, claims ONE unwritten task whose
// bilingual drafts already exist + passed phase2 in flow-mvp _staging, converts
// it into the oracle repo, validates it, and (unless --dry-run) pushes a preview
// branch. Verification (codex + chrome MCP) marks the ledger via --mark-verified;
// final merge-to-main is refused unless that verified-preview state exists.
//
// This script encodes the gates discovered during Phase 0 dry-run:
//   1. draft-exists   : EN enriched md (_staging/<PID>-en.md) must exist
//   2. phase2-pass    : <PID>-en.manifest.json overall == "pass"
//   3. slug-valid     : frontmatter slug must match /^[a-z0-9][a-z0-9-]*$/
//                       (apostrophes etc. produce invalid JS identifiers)
//   4. author-known   : every authorId on the converted article must be a
//                       registered AuthorPersona in oracle/data/authors/index.ts
//   5. build-gate     : `npm run build` in the publish worktree must succeed
// A task failing 3/4/5 is parked as needs_human in the claim ledger (no merge),
// consistent with the kanban invisible-default direction (gate only on explicit
// human-required conditions).
//
// Conversion recipe (validated Phase 0; EN-only since 2026-07-03 — zh authoring/publish removed):
//   EN: gg-md-to-oracle-ts --source _staging/<PID>-en.md      --slug S --out ART/S.ts
//   then gg-oracle-register-index --slug S --lang en
//
// Usage:
//   node gg-seo-autopilot.mjs [--scan] [--dry-run] [--limit 1]
//   node gg-seo-autopilot.mjs --mark-verified --branch seo/auto/<date>-<PID> --preview-url https://...
//   node gg-seo-autopilot.mjs --mark-failed --branch seo/auto/<date>-<PID> --reason "..."
//   node gg-seo-autopilot.mjs --retry-failed --branch seo/auto/<date>-<PID> --evidence "fixed ..."
//   node gg-seo-autopilot.mjs --prepare-regate --branch seo/auto/<date>-<PID>
//   node gg-seo-autopilot.mjs --reconcile-published [--task <PID>]
//   node gg-seo-autopilot.mjs --merge --branch seo/auto/<date>-<PID>
//   node gg-seo-autopilot.mjs --status
//
// Env (paths localised — defaults are this machine):
//   GG_FLOW_REPO   default ~/gengrowth-flow-mvp
//   GG_ORACLE_DIR  default ~/oracle
//   GG_ORACLE_WORKTREE_ROOT default ~/oracle-worktrees/seo-autopilot
//   GG_OPS_DIR     default ~/gengrowth-ops
//   GG_WINNER_LLM  default claude
//   GG_VERSION     default v8

import { execFile, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname, basename, relative } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { buildAuthorMap, resolveAuthor, isValidAuthorId, normalizeAuthorId } from './lib/author-routing.mjs';
import { detectProtectedFactDrift, summarizeProtectedFactDrift } from './lib/review-fact-guard.mjs';
import { loadEnv, resolveWorkbookId } from './lib/gg-shared.mjs';
import { slugifyPageId } from './gg-sheet-pull.mjs';
import { illustrate } from './lib/illustrate.mjs';
import { keywordLiveSlug } from './lib/oracle-live.mjs';
import { notify } from './lib/gg-notify.mjs';
import { unionMergeIntoWorktree } from './lib/merge-union.mjs';
import { backfillOnLive, enqueueWriteback } from './lib/backfill-tx.mjs';
import { classifyPark } from './lib/park-classify.mjs';
import { stateDir } from './lib/flow-state.mjs';
import { summarizePhase2Failure } from './lib/phase2-failure-summary.mjs';
import {
  authorFailureText,
  mergeAuthorFailures,
  readAuthorFailureMemory,
  writeAuthorFailureMemory,
} from './lib/author-failure-memory.mjs';
import {
  eventFromClaim,
  persistRepairAndDrain,
} from './lib/seo-repair-producer.mjs';
import {
  inspectBoundRepairDraft,
  inspectBoundRepairWorktree,
} from './lib/seo-repair-bindings.mjs';

loadEnv();
const ACTIVE_WORKBOOK_ID = resolveWorkbookId();
if (ACTIVE_WORKBOOK_ID) process.env.GG_SHEETS_WORKBOOK_ID = ACTIVE_WORKBOOK_ID;

const HOME = homedir();
const FLOW = process.env.GG_FLOW_REPO || join(HOME, 'gengrowth-flow-mvp');
const ORACLE = process.env.GG_ORACLE_DIR || join(HOME, 'oracle');
const WORKTREE_ROOT = process.env.GG_ORACLE_WORKTREE_ROOT || join(HOME, 'oracle-worktrees', 'seo-autopilot');
const OPS = process.env.GG_OPS_DIR || join(HOME, 'gengrowth-ops');
const WINNER = process.env.GG_WINNER_LLM || 'claude';
const VERSION = process.env.GG_VERSION || 'v8';

const STAGING = join(FLOW, '_staging');
const CONV = join(FLOW, 'tools', 'scripts', 'gg-md-to-oracle-ts.mjs');
const REG = join(FLOW, 'tools', 'scripts', 'gg-oracle-register-index.mjs');
const INDEX_MONITOR = join(FLOW, 'tools', 'scripts', 'gg-index-monitor.mjs');

// upstream authoring-stage scripts (used by --author when a plan task has no
// passing draft yet): bridge → RAG → render → orchestrator → phase2.
const SCRIPTS = join(FLOW, 'tools', 'scripts');
const SHEET_PULL = join(SCRIPTS, 'gg-sheet-pull.mjs');
const BRIDGE = join(SCRIPTS, 'gg-sheet-to-brief.mjs');
// local-knowledge RAG: gbrain (embedded PGLite brain, hybrid vector+keyword) writes
// the obsidian-rag.json the renderer consumes — replaces gg-obsidian-rag's AND-token
// vault walk that matched 0 notes for multi-word entities like "full moon ritual".
const GBRAIN_RAG = join(SCRIPTS, 'gg-gbrain-rag.mjs');
const ENTITY_PASSPORT = join(SCRIPTS, 'gg-entity-passport.mjs');
const CHART_INJECT = join(SCRIPTS, 'gg-chart-inject.mjs');
const RENDER = join(SCRIPTS, 'gg-render-batch.mjs');
const ORCHESTRATOR = join(SCRIPTS, 'gg-llm-orchestrator.mjs');
// multi-party review: Codex (gpt-5.5 xhigh) critiques → Opus 4.8 revises.
const REVIEW = join(SCRIPTS, 'gg-author-review.mjs');
const PHASE2 = join(SCRIPTS, '_phase2-validate.mjs');
const CONFIG_SNAPSHOT = join(FLOW, '.gg-cache', 'config-snapshot.json');
const PLAN_GLOB_DIR = join(OPS, 'inbox', '06-tasks', 'tasks');
const CLAIMS_PATH = join(PLAN_GLOB_DIR, '.autopilot-claims.json');
const CLAIMS_LOCK = `${CLAIMS_PATH}.lock`;
const CLAIMS_LOCK_TIMEOUT_MS = parseInt(process.env.GG_AUTOPILOT_LOCK_TIMEOUT_MS || '30000', 10);
const CLAIMS_LOCK_STALE_MS = parseInt(process.env.GG_AUTOPILOT_LOCK_STALE_MS || String(2 * 60 * 60 * 1000), 10);
const AUTHOR_GLOBAL_LOCK = process.env.GG_AUTHOR_GLOBAL_LOCK || '/tmp/gg-seo-author-global.lock';
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const HEAD_REF_OID_RE = /^[0-9a-f]{40}$/i;
const execFileAsync = promisify(execFile);

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}
function gitIn(repo, args, opts = {}) { return sh('git', ['-C', repo, ...args], opts); }
function git(args, opts = {}) { return gitIn(ORACLE, args, opts); }
function articlesDir(repo) { return join(repo, 'data', 'articles'); }
function authorsIndex(repo) { return join(repo, 'data', 'authors', 'index.ts'); }
function log(...a) { process.stderr.write(`[autopilot] ${a.join(' ')}\n`); }
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function die(message, code = 1) {
  log(`ERROR: ${message}`);
  process.exit(code);
}

// CRITICAL: the local oracle clone lags prod badly (observed 71 commits behind),
// which yields false build failures and risks re-publishing already-live slugs.
// Keep /oracle itself as the updated GitHub baseline; all article writes happen
// in per-branch worktrees below WORKTREE_ROOT.
function syncOracle() {
  git(['fetch', '--quiet', '--prune', 'origin']);
  const dirty = git(['status', '--porcelain', '--untracked-files=no']).trim();
  if (dirty && process.env.GG_AUTOPILOT_FORCE_ORACLE_CLEAN !== '1') {
    throw new Error(
      `oracle has tracked local changes; refusing to reset ${ORACLE}. ` +
      `Commit/stash them or set GG_AUTOPILOT_FORCE_ORACLE_CLEAN=1 for a dedicated baseline clone.`,
    );
  }
  try { git(['checkout', '-q', 'main']); } catch { /* already on main */ }
  git(['reset', '--hard', '-q', 'origin/main']);
  log(`synced oracle → origin/main @ ${git(['rev-parse', '--short', 'HEAD']).trim()}`);
}

function worktreePath(branch) {
  return join(WORKTREE_ROOT, branch.replace(/[^A-Za-z0-9._-]+/g, '__'));
}

function preparePublishWorktree(branch) {
  mkdirSync(WORKTREE_ROOT, { recursive: true });
  const wt = worktreePath(branch);
  try { git(['worktree', 'remove', '--force', wt]); } catch { /* no stale worktree */ }
  try { git(['branch', '-D', branch]); } catch { /* no stale local branch */ }
  git(['worktree', 'add', '--force', '-B', branch, wt, 'origin/main']);
  // git worktrees don't carry node_modules (gitignored — it lives only in the
  // baseline checkout), so the build gate's `npm run build` can't resolve
  // typescript / next. Symlink the baseline's installed deps into the worktree.
  const baselineModules = join(ORACLE, 'node_modules');
  const wtModules = join(wt, 'node_modules');
  if (existsSync(baselineModules) && !existsSync(wtModules)) {
    try { symlinkSync(baselineModules, wtModules); } catch { /* best-effort, build gate will surface it */ }
  }
  log(`worktree ${branch} → ${wt}`);
  return wt;
}

function cleanupWorktree(worktree) {
  if (!worktree) return;
  try { git(['worktree', 'remove', '--force', worktree]); }
  catch { /* keep best-effort cleanup non-fatal */ }
}

function parseArgs(argv) {
  const o = { limit: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scan') o.scan = true;
    else if (a === '--author') o.author = true;
    else if (a === '--next-unauthored') o.nextUnauthored = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--merge') o.merge = true;
    else if (a === '--mark-verified') o.markVerified = true;
    else if (a === '--mark-failed') o.markFailed = true;
    else if (a === '--retry-failed') o.retryFailed = true;
    else if (a === '--retry-author') o.retryAuthor = true;
    else if (a === '--prepare-regate') o.prepareRegate = true;
    else if (a === '--reconcile-published') o.reconcilePublished = true;
    else if (a === '--auto-retry-parks') o.autoRetryParks = true;
    else if (a === '--clear-needs-hero') o.clearNeedsHero = true;
    else if (a === '--status') o.status = true;
    else if (a === '--stale-report') o.staleReport = true;
    else if (a === '--branch') o.branch = argv[++i];
    else if (a === '--preview-url') o.previewUrl = argv[++i];
    else if (a === '--head-ref-oid') o.headRefOid = argv[++i];
    else if (a === '--worktree') o.worktree = argv[++i];
    else if (a === '--draft') o.draft = argv[++i];
    else if (a === '--draft-sha256') o.draftSha256 = argv[++i];
    else if (a === '--evidence') o.evidence = argv[++i];
    else if (a === '--reason') o.reason = argv[++i];
    else if (a === '--limit') o.limit = parseInt(argv[++i], 10) || 1;
    else if (a === '--task') o.task = argv[++i];
  }
  if (!o.scan && !o.author && !o.nextUnauthored && !o.merge && !o.markVerified && !o.markFailed && !o.retryFailed && !o.retryAuthor && !o.prepareRegate && !o.reconcilePublished && !o.autoRetryParks && !o.status && !o.staleReport) o.scan = true;
  return o;
}

// ── plan discovery + parsing ────────────────────────────────────────────────
function latestPlan() {
  // GG_AUTOPILOT_PLAN override: an explicit plan file (basename under PLAN_GLOB_DIR, or
  // an absolute path) pins exactly which plan this autopilot processes.
  const override = (process.env.GG_AUTOPILOT_PLAN || '').trim();
  if (override) {
    const p = override.includes('/') ? override : join(PLAN_GLOB_DIR, override);
    return existsSync(p) ? p : null;
  }
  const files = readdirSync(PLAN_GLOB_DIR)
    .filter((f) => /blog-output-plan.*\.md$/.test(f))
    // EXCLUDE the gengrowth.ai plan (2026-06-17): this is the astrologywiki/oracle autopilot;
    // it must never claim/author the second site's tasks (cross-site contamination). The
    // gengrowth line publishes via the separate gg-gengrowth-publish ticker (Lane A).
    .filter((f) => !/gengrowth/i.test(f))
    .sort(); // ISO-prefixed names sort chronologically
  if (!files.length) return null;
  return join(PLAN_GLOB_DIR, files[files.length - 1]);
}
function parseTasks(planPath) {
  const tasks = [];
  for (const line of readFileSync(planPath, 'utf8').split('\n')) {
    // - [ ] PG-EMPATH-001 sensitive person   |   - [x] `PG-HOUSE-006` ...
    const m = line.match(/^\s*-\s*\[( |x)\]\s*`?(PG-[A-Z0-9]+-\d+)`?\s*(.*)$/);
    if (m) tasks.push({ checked: m[1] === 'x', pgId: m[2], keyword: m[3].trim() });
  }
  return tasks;
}

// ── claim ledger ────────────────────────────────────────────────────────────
function loadClaims() {
  if (!existsSync(CLAIMS_PATH)) return {};
  try { return JSON.parse(readFileSync(CLAIMS_PATH, 'utf8')); } catch { return {}; }
}
function saveClaims(c) {
  mkdirSync(dirname(CLAIMS_PATH), { recursive: true });
  const tmp = `${CLAIMS_PATH}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n');
  renameSync(tmp, CLAIMS_PATH);
}
function claimStatus(claims, pgId) { return claims[pgId]?.status || null; }

// ── claim lease heartbeat (Task 8) ──────────────────────────────────────────
// Stamp an in-flight claim with the current publish STAGE + a short renewable LEASE so a
// stuck/crashed run is observable (and reportable via --stale-report) WITHOUT a destructive
// auto-reclaim. These fields are net-new; older claims simply lack them (claimIsStale → false).
// 60min default: a single in-lock publish (build + push + PR) can legitimately exceed 30min, and
// --stale-report would then false-flag a healthy in-flight scan as stale. Sized above realistic max.
const CLAIM_LEASE_MS = parseInt(process.env.GG_AUTOPILOT_CLAIM_LEASE_MS || String(60 * 60 * 1000), 10);
function heartbeatClaim(claims, pgId, stage) {
  const c = claims[pgId];
  if (!c) return;
  const now = new Date();
  c.stage = stage;
  c.lockedBy = String(process.pid);
  c.leaseUntil = new Date(now.getTime() + CLAIM_LEASE_MS).toISOString();
  c.updatedAt = now.toISOString();
}
function claimIsStale(claim) {
  return !!(claim && claim.leaseUntil && Date.parse(claim.leaseUntil) < Date.now());
}
function acquireClaimsLock() {
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(CLAIMS_LOCK);
      writeFileSync(join(CLAIMS_LOCK, 'owner'), `${process.pid} ${new Date().toISOString()}\n`);
      return () => rmSync(CLAIMS_LOCK, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try { stale = Date.now() - statSync(CLAIMS_LOCK).mtimeMs > CLAIMS_LOCK_STALE_MS; }
      catch { stale = true; }
      if (stale) {
        log(`removing stale claim lock ${CLAIMS_LOCK}`);
        rmSync(CLAIMS_LOCK, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > CLAIMS_LOCK_TIMEOUT_MS) {
        throw new Error(`claim ledger locked by another autopilot run: ${CLAIMS_LOCK}`);
      }
      sleepSync(250);
    }
  }
}
function withClaimsLock(fn) {
  const release = acquireClaimsLock();
  try { return fn(); }
  finally { release(); }
}

function processStartMarker(pid) {
  try {
    return sh('ps', ['-o', 'lstart=', '-p', String(pid)]).trim().replace(/\s+/g, ' ');
  } catch {
    return '';
  }
}

function readAuthorLockOwner() {
  try {
    return JSON.parse(readFileSync(join(AUTHOR_GLOBAL_LOCK, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

function authorLockOwnerIsLive(owner) {
  const pid = Number(owner?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !owner?.start) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return processStartMarker(pid) === String(owner.start).trim().replace(/\s+/g, ' ');
}

function acquireGlobalAuthorLock(taskId = '') {
  mkdirSync(dirname(AUTHOR_GLOBAL_LOCK), { recursive: true });
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const owner = {
    pid: process.pid,
    start: processStartMarker(process.pid),
    token,
    lane: process.env.GG_SITE || 'astrologywiki',
    taskId,
    acquiredAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      mkdirSync(AUTHOR_GLOBAL_LOCK);
      writeFileSync(join(AUTHOR_GLOBAL_LOCK, 'owner.json'), JSON.stringify(owner, null, 2));
      return {
        acquired: true,
        owner,
        release() {
          const current = readAuthorLockOwner();
          if (current?.token === token) rmSync(AUTHOR_GLOBAL_LOCK, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const current = readAuthorLockOwner();
      if (authorLockOwnerIsLive(current)) return { acquired: false, owner: current };

      // A creator may be between mkdir() and owner.json. Give that tiny window a
      // grace period; otherwise atomically rename the stale directory before
      // removing it so a competing process can never delete a newly acquired lock.
      let ageMs = 0;
      try { ageMs = Date.now() - statSync(AUTHOR_GLOBAL_LOCK).mtimeMs; } catch { continue; }
      if (!current && ageMs < 5000) return { acquired: false, owner: { lane: 'unknown', pid: '?' } };
      const stalePath = `${AUTHOR_GLOBAL_LOCK}.stale-${token}-${attempt}`;
      try {
        renameSync(AUTHOR_GLOBAL_LOCK, stalePath);
        rmSync(stalePath, { recursive: true, force: true });
      } catch (renameError) {
        if (renameError?.code !== 'ENOENT') log(`author lock stale recovery deferred: ${renameError.code || renameError.message}`);
      }
    }
  }
  return { acquired: false, owner: readAuthorLockOwner() || { lane: 'unknown', pid: '?' } };
}

function repairQueueDir() {
  if (process.env.GG_SEO_REPAIR_QUEUE_DIR) return process.env.GG_SEO_REPAIR_QUEUE_DIR;
  const base = stateDir();
  if (!base) throw new Error('flow-state directory unavailable');
  return join(base, 'seo-repair-queue');
}

function lastJsonLine(text) {
  const lines = String(text || '').trim().split('\n').filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch { /* inspect an earlier line */ }
  }
  return null;
}

function repairControllerBudgetSeconds() {
  const parsed = Number(process.env.GG_SEO_REPAIR_BUDGET_SECONDS || 1500);
  if (!Number.isFinite(parsed) || parsed < 1) return 1500;
  return Math.min(86_400, Math.max(1, Math.floor(parsed)));
}

async function drainRepairController(queueDir) {
  const controller = process.env.GG_SEO_REPAIR_CONTROLLER_BIN
    || join(SCRIPTS, 'gg-seo-repair-controller.mjs');
  const budgetSeconds = repairControllerBudgetSeconds();
  const args = [
    controller,
    'drain',
    '--max-targets',
    String(process.env.GG_SEO_REPAIR_MAX_TARGETS || 2),
    '--budget-seconds',
    String(budgetSeconds),
  ];
  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd: FLOW,
      env: {
        ...process.env,
        GG_SEO_REPAIR_QUEUE_DIR: queueDir,
      },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: (budgetSeconds + 300) * 1000,
    });
    const payload = lastJsonLine(result.stdout);
    if (!payload || payload.ok === false) {
      throw new Error(payload?.error || 'repair controller returned no valid result');
    }
    return payload;
  } catch (error) {
    if (error?.killed || error?.signal) {
      throw new Error(`repair controller terminated by ${error.signal || 'timeout'}`);
    }
    const code = Number(error?.code);
    if (Number.isInteger(code)) {
      throw new Error(`repair controller exited ${code}`);
    }
    throw error;
  }
}

async function persistClaimRepair(pageId, claim) {
  if (process.env.GG_SEO_REPAIR_CONTROLLER_V2_ENABLED !== '1') return { skipped: true };
  const queueDir = repairQueueDir();
  const site = String(claim.site || process.env.GG_SITE || 'astrologywiki');
  const createdAt = claim.failedAt || claim.updatedAt || new Date().toISOString();
  const runId = process.env.GG_SEO_REPAIR_RUN_ID
    || `${site}-producer-${createdAt.replace(/[^0-9]/g, '').slice(0, 14)}-${process.pid}`;
  const logFile = process.env.GG_SEO_REPAIR_LOG_FILE || CLAIMS_PATH;
  const offsetStart = Math.max(0, Number(process.env.GG_SEO_REPAIR_LOG_OFFSET_START) || 0);
  let currentLogEnd = offsetStart;
  try { currentLogEnd = Math.max(offsetStart, statSync(logFile).size); } catch {}
  const explicitOffsetEnd = Number(process.env.GG_SEO_REPAIR_LOG_OFFSET_END);
  const offsetEnd = Number.isInteger(explicitOffsetEnd) && explicitOffsetEnd >= offsetStart
    ? Math.min(currentLogEnd, explicitOffsetEnd)
    : currentLogEnd;
  const event = eventFromClaim({
    site,
    runId,
    pageId,
    claim,
    logFile,
    offsets: { start: offsetStart, end: offsetEnd },
    createdAt,
  });
  return persistRepairAndDrain({
    event,
    queueDir,
    drain: async () => drainRepairController(queueDir),
    strict: true,
  });
}
function claimForBranch(claims, branch) {
  const matches = Object.entries(claims).filter(([, c]) => c?.branch === branch);
  if (!matches.length) throw new Error(`no claim ledger entry found for branch ${branch}`);
  if (matches.length > 1) throw new Error(`multiple claim ledger entries found for branch ${branch}`);
  const [pgId, claim] = matches[0];
  return { pgId, claim };
}

function ghPrMeta(branch) {
  try {
    return JSON.parse(sh(
      'gh',
      ['pr', 'view', branch, '--repo', 'xdawayer/oracle', '--json', 'state,mergedAt,closedAt,url'],
      { cwd: ORACLE },
    ));
  } catch {
    return null;
  }
}

function reconcileClaimsWithGitHub(claims) {
  let changed = false;
  for (const [pgId, claim] of Object.entries(claims)) {
    if (!claim) continue;
    if (claim.status === 'done') {
      if (claim.error !== undefined || claim.failedAt !== undefined) {
        delete claim.error;
        delete claim.failedAt;
        changed = true;
      }
      continue;
    }
    if (!claim.branch) continue;
    const pr = ghPrMeta(claim.branch);
    if (!pr || pr.state !== 'MERGED') continue;
    claims[pgId] = {
      ...claim,
      status: 'done',
      pr: claim.pr || pr.url,
      mergedAt: claim.mergedAt || pr.mergedAt || new Date().toISOString(),
      reconciliationNote: claim.reconciliationNote || 'auto-reconciled from merged GitHub PR',
    };
    delete claims[pgId].error;
    delete claims[pgId].failedAt;
    changed = true;
  }
  return changed;
}

function articleRegisteredInOracle(slug) {
  if (!slug || !SLUG_RE.test(slug)) return false;
  if (!existsSync(join(articlesDir(ORACLE), `${slug}.ts`))) return false;
  const index = join(articlesDir(ORACLE), 'index.ts');
  if (!existsSync(index)) return false;
  const src = readFileSync(index, 'utf8');
  return src.includes(`from "./${slug}"`) || src.includes(`from './${slug}'`);
}

async function doReconcilePublished(o) {
  const missingPublishRecords = withClaimsLock(() => {
    syncOracle();
    const claims = loadClaims();
    const publishLogText = existsSync(opsPublishLog()) ? readFileSync(opsPublishLog(), 'utf8') : '';
    const toRecord = [];
    let changed = false;
    for (const [pgId, claim] of Object.entries(claims)) {
      if (o.task && pgId !== o.task) continue;
      if (!claim) continue;
      const slug = claim.slug;
      if (!articleRegisteredInOracle(slug)) continue;
      if (claim.status !== 'done') {
        claims[pgId] = {
          ...claim,
          status: 'done',
          mergedAt: claim.mergedAt || new Date().toISOString(),
          reconciliationNote: claim.reconciliationNote || 'auto-reconciled from oracle main article registration',
        };
        delete claims[pgId].error;
        delete claims[pgId].failedAt;
        log(`PUBLISHED ${pgId} ${slug}`);
        changed = true;
      }
      if (!publishLogText.includes(`| ${pgId} |`)) toRecord.push({ pgId, slug });
    }
    if (changed) saveClaims(claims);
    else if (!toRecord.length) log('reconcile-published: no published claims found');
    return toRecord;
  });
  for (const { pgId, slug } of missingPublishRecords) {
    await appendPublishLog(pgId, slug, { notifyPublished: false });
  }
}

// ── per-task helpers ────────────────────────────────────────────────────────
function enDraft(pgId) { return join(STAGING, `${pgId}-en.md`); }
function enManifest(pgId) { return join(STAGING, `${pgId}-en.manifest.json`); }

function phase2Passed(pgId) {
  const mp = enManifest(pgId);
  if (!existsSync(mp)) return false;
  try { return JSON.parse(readFileSync(mp, 'utf8'))?.phase2_checks?.overall === 'pass'; }
  catch { return false; }
}
function frontmatterSlug(mdPath) {
  const head = readFileSync(mdPath, 'utf8').slice(0, 2000);
  const m = head.match(/^slug:\s*["']?([^"'\n]+?)["']?\s*$/m);
  return m ? m[1].trim() : null;
}
function readMdFrontmatter(mdPath) {
  const src = readFileSync(mdPath, 'utf8');
  const m = src.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { attrs: {}, body: src };
  const attrs = {};
  let currentList = null;
  for (const line of m[1].split('\n')) {
    const item = line.match(/^\s*-\s*(.+?)\s*$/);
    if (item && currentList) {
      attrs[currentList].push(item[1].replace(/^['"]|['"]$/g, ''));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) { currentList = null; continue; }
    const [, key, raw] = kv;
    const value = raw.trim();
    if (!value) {
      attrs[key] = [];
      currentList = key;
      continue;
    }
    currentList = null;
    attrs[key] = value.replace(/^['"]|['"]$/g, '');
  }
  return { attrs, body: m[2] };
}
// Slug the same way the publishing pipeline derives them (_phase2-validate.mjs and
// this script's own keyword fallback): fold diacritics (é→e) so accented names like
// "Kylian Mbappé" don't truncate to "mbapp", lowercase, non-alphanumeric runs collapse
// to a single hyphen, trim leading/trailing hyphens.
function slugify(s) {
  return String(s || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
// Every slug a draft could ALREADY be live under: its own frontmatter slug, plus slugs
// derived from `entity` and `target_keyword`. A human sometimes publishes a draft under a
// renamed slug (e.g. the entity-derived `signs-of-a-highly-sensitive-person` instead of the
// keyword-derived `signs-you-re-a-highly-sensitive-person`), so a frontmatter-slug-only dedup
// misses it and the autopilot republishes identical content under a second slug. entity and
// target_keyword are article-specific (unlike associated_keywords, which are broad head terms
// shared with pillar pages), so checking them does not false-positive on legitimately new pages.
function draftAliasSlugs(mdPath, primarySlug) {
  const slugs = new Set();
  if (primarySlug) slugs.add(primarySlug);
  try {
    const { attrs } = readMdFrontmatter(mdPath);
    for (const field of ['entity', 'target_keyword']) {
      const s = slugify(attrs[field]);
      if (s && SLUG_RE.test(s)) slugs.add(s);
    }
  } catch { /* best-effort: fall back to the primary slug only */ }
  return [...slugs];
}
function registeredAuthorIds(repo) {
  const index = authorsIndex(repo);
  if (!existsSync(index)) return new Set();
  const src = readFileSync(index, 'utf8');
  return new Set([...src.matchAll(/\bid:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]));
}
function articleAuthorIds(repo, slug) {
  const f = join(articlesDir(repo), `${slug}.ts`);
  if (!existsSync(f)) return [];
  const src = readFileSync(f, 'utf8');
  return [...src.matchAll(/authorId:\s*"?([^",\n]*)"?/g)].map((m) => m[1].trim());
}

// A task is claimable for downstream publish iff drafts exist + pass + not done.
function claimable(task, claims) {
  if (task.checked) return { ok: false, reason: 'already checked in plan' };
  const st = claimStatus(claims, task.pgId);
  if (['active', 'pushed-preview', 'verified-preview', 'needs_human'].includes(st)) {
    return { ok: false, reason: `claim=${st}` };
  }
  if (st === 'done') return { ok: false, reason: 'claim=done' };
  if (!existsSync(enDraft(task.pgId))) return { ok: false, reason: 'no EN enriched draft (upstream not done)' };
  if (!phase2Passed(task.pgId)) return { ok: false, reason: 'phase2 not pass' };
  const slug = frontmatterSlug(enDraft(task.pgId));
  if (!slug) return { ok: false, reason: 'EN draft missing frontmatter slug' };
  if (!SLUG_RE.test(slug)) return { ok: false, reason: `invalid slug "${slug}" (needs source fix)` };
  if (st !== 'needs_human') {
    // Skip if THIS slug — or an entity/keyword alias of it — is already live in oracle.
    // The alias check stops the autopilot from republishing a draft a human already
    // published under a renamed slug (the duplicate-content bug, e.g. signs-of- vs signs-you-re-).
    const aliases = draftAliasSlugs(enDraft(task.pgId), slug);
    const liveSlug = aliases.find((s) => existsSync(join(articlesDir(ORACLE), `${s}.ts`)));
    if (liveSlug)
      return {
        ok: false,
        reason: liveSlug === slug
          ? `oracle already has ${slug}.ts`
          : `oracle already has ${liveSlug}.ts (entity/keyword alias of ${slug}) — duplicate content, skipping`,
      };
  }
  return { ok: true, slug };
}

// Register a converted slug for STATIC SEO generation. The site's
// scripts/generate-seo-pages.mjs uses HARDCODED allowlists — `ARTICLE_SLUGS`
// (bilingual, legacy zh-era articles only) and `ARTICLE_SLUGS_EN_ONLY` — to
// decide which articles get crawler-visible static HTML + a sitemap entry.
// Discovery is NOT automatic: an article merged into data/articles/ without
// this stays a client-only SPA route, so crawlers get the empty shell and it
// never enters the sitemap → never indexed. New articles are EN-only, so
// registration always targets ARTICLE_SLUGS_EN_ONLY (ARTICLE_SLUGS is kept
// as-is to serve the pre-2026-07 bilingual back catalog). Idempotent;
// non-fatal if the script/array layout changes.
function registerSeoSlug(repo, slug) {
  const f = join(repo, 'scripts', 'generate-seo-pages.mjs');
  if (!existsSync(f)) { log(`WARN no generate-seo-pages.mjs — ${slug} won't get a static SEO page`); return; }
  let src = readFileSync(f, 'utf8');
  const hasIn = (arr) => {
    const body = (src.match(new RegExp(`const ${arr} = \\[([\\s\\S]*?)\\n\\];`, 'm')) || [])[1] || '';
    return new RegExp(`['"]${slug}['"]`).test(body);
  };
  const insertInto = (arr) => {
    const re = new RegExp(`(const ${arr} = \\[\\n)`);
    if (!re.test(src)) { log(`WARN ${arr} not found in generate-seo-pages.mjs — ${slug} not registered for static SEO`); return false; }
    src = src.replace(re, `$1  '${slug}',\n`);
    return true;
  };

  if (hasIn('ARTICLE_SLUGS') || hasIn('ARTICLE_SLUGS_EN_ONLY')) return;
  if (!insertInto('ARTICLE_SLUGS_EN_ONLY')) return;
  writeFileSync(f, src);
  log(`registered ${slug} → ARTICLE_SLUGS_EN_ONLY (static SEO page + sitemap)`);
}

function convert(repo, pgId, slug) {
  const art = articlesDir(repo);
  sh('node', [CONV, '--source', enDraft(pgId), '--slug', slug, '--out', join(art, `${slug}.ts`)]);
  sh('node', [REG, '--oracle-articles-dir', art, '--slug', slug, '--lang', 'en']);
  registerSeoSlug(repo, slug);
}

function buildGate(repo) {
  try { sh('npm', ['run', 'build'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }); return { ok: true }; }
  catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    const m = out.match(/SEO (?:generation|build)[^\n]*|error[^\n]*/i);
    return { ok: false, error: (m && m[0]) || out.slice(-400) };
  }
}

function buildCommittedGate(repo, branch) {
  const head = gitIn(repo, ['rev-parse', 'HEAD']).trim();
  const buildWorktree = worktreePath(`${branch}--build-${head.slice(0, 12)}-${process.pid}`);
  mkdirSync(WORKTREE_ROOT, { recursive: true });
  try { git(['worktree', 'remove', '--force', buildWorktree]); } catch { /* no stale build worktree */ }
  try {
    git(['worktree', 'add', '--force', '--detach', buildWorktree, head]);
    const baselineModules = join(ORACLE, 'node_modules');
    const wtModules = join(buildWorktree, 'node_modules');
    if (existsSync(baselineModules) && !existsSync(wtModules)) {
      try { symlinkSync(baselineModules, wtModules); } catch { /* build gate surfaces missing deps */ }
    }
    return buildGate(buildWorktree);
  } finally {
    cleanupWorktree(buildWorktree);
  }
}

// ── authoring (upstream) ─────────────────────────────────────────────────────
// When a plan task has no passing draft yet, run the deterministic authoring
// chain so the next --scan can publish it: bridge → RAG → render → orchestrator
// → phase2. The orchestrator spends the LLM $ (Opus); every other stage is plain
// glue. On phase2 PASS we leave _staging/<pid>-en.md (+manifest) and write NO
// claim — the next scan claims it. On ANY stage failure we park the task as
// needs_human with a specific reason, so it is skipped on future ticks instead
// of re-burning an LLM call every 25 min. (Proven manually on PG-SOLAR-001.)
function shFlow(cmd, args, timeout = 120000) {
  // maxBuffer well above any stage's stdout (sheet-pull ~0.5MB, orchestrator logs)
  // so a chatty stage can't make execFileSync throw and trigger a spurious park.
  return sh(cmd, args, { cwd: FLOW, timeout, maxBuffer: 64 * 1024 * 1024 });
}
function errTail(e, n = 180) {
  return `${e.stdout || ''}${e.stderr || ''}${e.stdout || e.stderr ? '' : e.message || e}`
    .toString().replace(/\s+/g, ' ').trim().slice(-n);
}

// First plan task that is unchecked, unclaimed, and not already authored+passing.
function nextUnauthored(tasks, claims) {
  for (const t of tasks) {
    if (t.checked) continue;
    if (claimStatus(claims, t.pgId)) continue; // active/pushed/verified/needs_human/done
    if (existsSync(enDraft(t.pgId)) && phase2Passed(t.pgId)) continue; // ready → scan's job
    return t;
  }
  return null;
}

// cluster_domain → author_id via the config snapshot's author.map (the documented
// auto-routing rule). overrideRaw='' on purpose so a malformed Sheet author column
// (display names like "Aditi Sharma") can't block routing. '' if unresolved.
// Generalist fallback author for cluster_domains that match no author.map rule
// (exact OR whole-word substring). marcus-orion is the documented "everything else /
// unclassified" persona, so a brand-new task with an off-map domain (e.g. "journal
// prompts") AUTHORS instead of parking — keeping the queue self-healing as the plan
// grows. A WARN is logged + the choice is auditable so a genuine miscategorization
// can be corrected in the Sheet author.map. Override via GG_AUTHOR_FALLBACK.
const AUTHOR_FALLBACK = process.env.GG_AUTHOR_FALLBACK || 'marcus-orion';

function resolveAuthorForDomain(clusterDomain) {
  if (!existsSync(CONFIG_SNAPSHOT)) return AUTHOR_FALLBACK;
  let values;
  try { values = JSON.parse(readFileSync(CONFIG_SNAPSHOT, 'utf8')).values || {}; }
  catch { return AUTHOR_FALLBACK; }
  const { map } = buildAuthorMap(values);
  const resolved = resolveAuthor({ clusterDomain, overrideRaw: '', authorMap: map }).author || '';
  if (resolved) return resolved;
  log(`author.map miss for cluster_domain "${clusterDomain}" → generalist fallback ${AUTHOR_FALLBACK} (add a Sheet author.map rule if a specialist fits better)`);
  return AUTHOR_FALLBACK;
}

// Locate this task's row in 选题登记表. {row, brief} or null.
// Write to a file and read it back — the full sheet is ~0.5MB and capturing that
// through execFileSync stdout truncates (pipe limit); a file read is reliable.
//
// Matching order (the 选题登记表 is KEYWORD-indexed, not PG-id-indexed: gg-sheet-pull
// derives page_id = slugifyPageId(target_keyword) when the sheet's page_id column is
// blank, which it now is for every row — so a bare PG-id match finds nothing):
//   1. exact page_id === PG-id   (legacy: only matches a sheet that literally stores PG-ids)
//   2. page_id === slugifyPageId(plan keyword)   (e.g. "Chiron in Taurus" → page_chiron_in_taurus)
//   3. target_keyword === plan keyword (case-insensitive)   (final exact-keyword fallback)
// 2 and 3 are precise (exact derived-slug / exact keyword), so no risk of matching the
// wrong topic; 1 stays first to keep PG-id sheets working.
function findSheetRow(pgId, keyword = '') {
  mkdirSync(join(FLOW, '.gg-cache', 'batches'), { recursive: true });
  const outRel = join('.gg-cache', 'batches', '_allrows.json');
  // wide range: tasks live anywhere in the sheet (observed up to row ~286; trend
  // batches like worldcup2026_astro append at the tail, ~1541). Cover the full sheet.
  shFlow('node', [SHEET_PULL, '--rows', '2-1600', '--limit', '1700', '--out', outRel]);
  let rows;
  try { const j = JSON.parse(readFileSync(join(FLOW, outRel), 'utf8')); rows = j.rows || j; }
  catch { throw new Error('sheet-pull output not parseable'); }
  rows = rows || [];
  const kw = String(keyword || '').trim();
  const kwSlug = kw ? slugifyPageId(kw) : null;
  const kwLower = kw.toLowerCase();
  const r =
    rows.find((x) => String(x.page_id) === pgId) ||
    (kwSlug && rows.find((x) => String(x.page_id) === kwSlug)) ||
    (kwLower && rows.find((x) => String((x.brief && x.brief.target_keyword) || '').trim().toLowerCase() === kwLower)) ||
    null;
  return r ? { row: String(r.source_row), brief: r.brief || {} } : null;
}

async function parkAuthor(pgId, slug, plan, reason) {
  const parked = withClaimsLock(() => {
    const claims = loadClaims();
    claims[pgId] = {
      ...(claims[pgId] || {}),
      status: 'needs_human', slug: slug || claims[pgId]?.slug, owner: 'autopilot',
      stage: 'authoring', plan, error: `authoring: ${reason}`, failedAt: new Date().toISOString(),
    };
    saveClaims(claims);
    return claims[pgId];
  });
  log(`PARK(author) ${pgId}: ${reason}`);
  await persistClaimRepair(pgId, parked);
}

// Mark an authoring claim done because its topic is already published (mirrors
// doReconcilePublished). Used when a "no row in 选题登记表" failure is really a stale
// duplicate of an already-live article, so it does NOT pile up as needs_human noise.
function reconcileAuthorDone(pgId, slug, plan, note) {
  withClaimsLock(() => {
    const claims = loadClaims();
    claims[pgId] = {
      ...(claims[pgId] || {}),
      status: 'done', slug, owner: 'autopilot', stage: 'authoring', plan,
      reconciliationNote: note, mergedAt: claims[pgId]?.mergedAt || new Date().toISOString(),
    };
    delete claims[pgId].error;
    delete claims[pgId].failedAt;
    saveClaims(claims);
  });
  log(`RECONCILE(author→done) ${pgId}: ${note}`);
}

function nextUnauthoredTask() {
  const plan = latestPlan();
  if (!plan) return null;
  return { plan, task: nextUnauthored(parseTasks(plan), loadClaims()) };
}

function doNextUnauthored() {
  const r = nextUnauthoredTask();
  process.stdout.write((r && r.task ? JSON.stringify({ pgId: r.task.pgId, keyword: r.task.keyword }) : '') + '\n');
}

// (removed 2026-06-18) agenticRescuePrompt was the prompt for the old unattended agentic
// `claude -p --allowedTools Bash/Edit/Write --dangerously-skip-permissions` rescue, replaced by
// the text-only gg-author-repair.mjs (Task 3). Deleted to avoid inviting a re-wire of the unsafe path.

// Deterministic-repair escalation (Task 3) — shared by EVERY author park boundary.
// After the feedback loop has failed every attempt, escalate to gg-author-repair.mjs: a TEXT-ONLY
// worker (NO Bash/Edit/Write/Grep/MCP/--dangerously-skip-permissions) that reads the failed draft + the
// phase2 failures and emits a corrected article to a SEPARATE candidate file. `validate(candidate)` runs
// phase2 on that candidate and returns whether it passed; we adopt it ONLY on a pass. One bounded second
// repair is allowed when the first candidate reveals a new exact failure; tooling failures still park.
// Centralized so a new author path can never again
// silently ship WITHOUT the repair safety net (the divergence that parked PG-SOLAR-001: one path
// had the escalation, another did not). Toggle GG_AUTHOR_REPAIR=0. Returns a
// structured result so the caller can park with the repaired candidate's exact
// remaining failures instead of the stale pre-repair failure list.
function tryDeterministicRepair({
  pgId,
  draftV8,
  candidate,
  targetKeyword,
  author,
  failures,
  constraints = {},
  validate,
}) {
  if (process.env.GG_AUTHOR_REPAIR === '0' || !existsSync(join(FLOW, draftV8))) {
    return { passed: false, attempted: false, failure: '' };
  }
  log(`deterministic repair: feedback loop failed — calling gg-author-repair on ${draftV8}`);
  const repModel = process.env.GG_AGENTIC_MODEL || 'claude-sonnet-4-6';
  const repEffort = process.env.GG_AGENTIC_EFFORT || 'high';
  const repAttemptTimeout = parseInt(process.env.GG_AUTHOR_REPAIR_TIMEOUT_MS || '240000', 10);
  // gg-author-repair may use one distinct-model fallback, so the outer process
  // allowance covers two bounded attempts plus startup/cleanup — never the old
  // 30-minute inherited agentic ceiling.
  const repTimeout = (repAttemptTimeout * 2) + 60000;
  let repairFailure = '';
  const maxAttempts = Math.max(1, Math.min(2, parseInt(process.env.GG_AUTHOR_REPAIR_ATTEMPTS || '2', 10)));
  let source = draftV8;
  let currentFailures = failures || '- phase2 failed';
  let attemptsUsed = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsUsed = attempt;
    const attemptCandidate = attempt === 1
      ? candidate
      : candidate.replace(/(\.md)?$/, `-attempt-${attempt}.md`);
    let workerFinished = false;
    try {
      const args = [join(SCRIPTS, 'gg-author-repair.mjs'),
        '--source', source, '--out', attemptCandidate, '--page-id', pgId,
        '--target-keyword', targetKeyword, '--author', author,
        '--failures', currentFailures,
        '--model', repModel, '--effort', repEffort,
        '--timeout-ms', String(repAttemptTimeout)];
      if (constraints.wordMin) args.push('--word-min', String(constraints.wordMin));
      if (constraints.wordMax) args.push('--word-max', String(constraints.wordMax));
      if (constraints.keywordMin) args.push('--keyword-min', String(constraints.keywordMin));
      if (constraints.keywordMax) args.push('--keyword-max', String(constraints.keywordMax));
      if (constraints.maxSentencesPerParagraph) {
        args.push('--max-sentences-per-paragraph', String(constraints.maxSentencesPerParagraph));
      }
      shFlow('node', args, repTimeout);
      workerFinished = true;
      // WE validate the candidate (the worker never runs phase2 itself); adopt only on PASS.
      if (validate(attemptCandidate)) return { passed: true, attempted: true, attempts: attempt, failure: '' };
      repairFailure = '- deterministic repair candidate did not produce a passing phase2 manifest';
    } catch (e) {
      if (workerFinished) {
        repairFailure = summarizePhase2Failure(e);
        log(`deterministic repair candidate ${attempt}/${maxAttempts} failed phase2:\n${repairFailure}`);
      } else {
        repairFailure = `- deterministic repair tooling failure: ${errTail(e, 200)}`;
        log(repairFailure.slice(2));
      }
    }
    if (!workerFinished || attempt >= maxAttempts || !existsSync(join(FLOW, attemptCandidate))) break;
    currentFailures = authorFailureText(mergeAuthorFailures(
      mergeAuthorFailures([], currentFailures),
      repairFailure,
    ));
    source = attemptCandidate;
    log(`deterministic repair: retrying candidate once with new exact failures (${attempt + 1}/${maxAttempts})`);
  }
  log('deterministic repair did not yield a passing draft — parking');
  return { passed: false, attempted: true, attempts: attemptsUsed, failure: repairFailure };
}

function authorRepairConstraints(pgId) {
  const fixturePath = join(FLOW, '.gg-cache', 'prompts', `${pgId}.${VERSION}-fixture.json`);
  try {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    return {
      wordMin: Number(fixture.word_range?.[0]) || 0,
      wordMax: Number(fixture.word_range?.[1]) || 0,
      keywordMin: Number(fixture.kw_count_range?.[0]) || 0,
      keywordMax: Number(fixture.kw_count_range?.[1]) || 0,
      maxSentencesPerParagraph: 7,
    };
  } catch {
    return { maxSentencesPerParagraph: 7 };
  }
}

async function doAuthorUnlocked(o = {}) {
  let sel;
  const claims = loadClaims();
  if (o.task) {
    const plan = latestPlan();
    if (!plan) { log('no blog-output-plan found'); return; }
    const t = parseTasks(plan).find((x) => x.pgId === o.task);
    if (!t) { log(`--task ${o.task} not found in plan`); return; }
    if (claimStatus(claims, t.pgId)) { log(`--task ${o.task} already has a claim (clear it first)`); return; }
    if (existsSync(enDraft(t.pgId)) && phase2Passed(t.pgId)) {
      log(`--task ${o.task} already has a Phase 2 PASS draft — preserving it for the publish scan`);
      return;
    }
    sel = { plan, task: t };
  } else {
    const plan = latestPlan();
    if (!plan) { log('no blog-output-plan found'); return; }
    const task = nextUnauthored(parseTasks(plan), claims);
    sel = task ? { plan, task } : null;
  }
  if (!sel || !sel.task) { log('nothing to author this run'); return; }
  const { task: t } = sel;
  const pgId = t.pgId;
  const planName = basename(sel.plan);
  log(`author candidate ${pgId} (${t.keyword || ''})`);
  const park = (slug, reason) => parkAuthor(pgId, slug, planName, reason);
  const reconcileDone = (slug, note) => reconcileAuthorDone(pgId, slug, planName, note);

  try {
    // 1. locate the Sheet row
    let loc;
    try { loc = findSheetRow(pgId, t.keyword); }
    catch (e) { return park(null, `sheet-pull failed: ${errTail(e)}`); }
    if (!loc) {
      // The topic may already be published under its keyword's slug (the 选题登记表 row was
      // never added because the article already exists). Reconcile to done instead of parking
      // needs_human noise. Fail-safe: any error falls through to the normal park.
      try {
        const live = keywordLiveSlug(t.keyword, ORACLE);
        if (live) {
          reconcileDone(live, `topic already live as ${live}.ts — 选题登记表 row missing but article exists`);
          return;
        }
      } catch { /* fall through to park */ }
      const wb = ACTIVE_WORKBOOK_ID || process.env.GG_SHEETS_WORKBOOK_ID || '(unknown workbook)';
      return park(null, `no row for ${pgId} ("${t.keyword || ''}") in 选题登记表 [workbook=${wb}]`);
    }
    const row = loc.row;

    // 2. bridge → override (no --allow-missing-cta: a missing CTA Map row parks)
    mkdirSync(join(FLOW, '.gg-cache', 'overrides'), { recursive: true });
    const overridePath = join('.gg-cache', 'overrides', `${pgId}.json`);
    try { shFlow('node', [BRIDGE, '--row', row, '--out', overridePath]); }
    catch (e) {
      const m = `${e.stdout || ''}${e.stderr || ''}`.match(/CTA Map[^\n]*/);
      return park(null, m ? `CTA Map gap — ${m[0].trim()}` : `bridge failed: ${errTail(e)}`);
    }

    // 3. fix author (auto-route) + CTA (Chinese→English template) in the override
    const absOverride = join(FLOW, overridePath);
    let ov, entry, keyword, domain, slug;
    try {
      ov = JSON.parse(readFileSync(absOverride, 'utf8'));
      const key = ov[pgId] ? pgId : Object.keys(ov).find((k) => !k.startsWith('_'));
      entry = ov[key];
      keyword = (entry.target_keyword || t.keyword || '').trim();
      domain = entry.cluster_domain || '';
      slug = slugify(keyword || pgId);
    } catch (e) { return park(null, `override unreadable: ${errTail(e)}`); }

    // Clean entity: strip leading interrogatives so we have the topic noun, not the
    // question ("what is a full moon ritual" → "full moon ritual"). Used for RAG
    // search AND (when the Sheet entity is a phrase-salad) for the rendered {{entity}}.
    const fallbackRagEntity = String(entry.entity || '').trim();
    const cleanEntity = keyword
      .replace(/^\s*(what\s+(is|are|to\s+do\s+(on|with|during|after))|how\s+(to|do(es)?)|why\s+(is|are|do(es)?)|when\s+(is|are|to|do(es)?))\s+(a|an|the)?\s*/i, '')
      .replace(/[?？]+\s*$/, '').trim() || keyword;
    const ragEntity = cleanEntity;

    // Per-page author wins (rule 1): honor a VALID Sheet author column (entry.author
    // from bridge, now kebab-normalized so display names like "Julian Thorne" resolve).
    // Only fall back to cluster_domain auto-routing when the Sheet author is absent/invalid.
    const sheetAuthor = normalizeAuthorId(entry.author || '');
    const usePerPage = isValidAuthorId(sheetAuthor);
    const author = usePerPage ? sheetAuthor : resolveAuthorForDomain(domain);
    if (!author) return park(slug, `no author for cluster_domain "${domain}" (author.map miss)`);
    entry.author = author;
    entry.author_source = usePerPage ? 'override' : 'auto';
    if (!String(entry.search_volume ?? '').trim()) entry.search_volume = '0';

    // The Sheet `entity` column is sometimes a phrase-salad of angles
    // ("intentional energy work · lunar phase timing · …") instead of the entity
    // name; rendered verbatim it produces garbage H2s like "## What is intentional
    // energy work · …?". When it looks like a list (·-separated / 3+ comma items),
    // swap in the clean topic noun so headings read naturally.
    const messyEntity = /·/.test(entry.entity || '') || ((entry.entity || '').split(',').length >= 3);
    if (messyEntity && cleanEntity) entry.entity = cleanEntity;

    // CTA is selected upstream from the product's CTA Map. Do not manufacture a
    // Birth Chart (or any other) fallback here: an untraceable CTA must park for
    // Sheet repair instead of being silently published with the wrong destination.
    if (!String(entry.cta_id || '').trim()
      || !String(entry.cta_text || '').trim()
      || !/^https:\/\//.test(String(entry.cta_target_url || '').trim())
      || !String(entry.cta_selection_reason || '').trim()) {
      return park(slug, 'missing eligible semantic CTA; repair CTA Map and rerun bridge');
    }
    try { writeFileSync(absOverride, JSON.stringify(ov, null, 2)); }
    catch (e) { return park(slug, `override write failed: ${errTail(e)}`); }

    // 4. batch fixture
    mkdirSync(join(FLOW, '.gg-cache', 'batches'), { recursive: true });
    const batchPath = join('.gg-cache', 'batches', `${pgId}.json`);
    try { shFlow('node', [SHEET_PULL, '--row', row, '--out', batchPath]); }
    catch (e) { return park(slug, `batch pull failed: ${errTail(e)}`); }

    // 5. RAG: obsidian (local vault) + entity-passport (web sources). Both stages
    //    exit non-zero on benign WARNs (thin vault match / partial source scrape —
    //    some sites block scraping) yet still emit a usable cache, so gate on the
    //    OUTPUT file, not the exit code. render hard-requires both caches to exist.
    const ragDir = join(FLOW, '.gg-cache', pgId);
    const gbrainRagArgs = [GBRAIN_RAG, '--page-id', pgId, '--entity', ragEntity, '--target-keyword', keyword];
    if (fallbackRagEntity && fallbackRagEntity.toLowerCase() !== ragEntity.toLowerCase()) {
      gbrainRagArgs.push('--fallback-entity', fallbackRagEntity);
    }
    try { shFlow('node', gbrainRagArgs, 240000); }
    catch (e) { log(`gbrain-rag exit non-zero: ${errTail(e, 80)}`); }
    if (!existsSync(join(ragDir, 'obsidian-rag.json'))) return park(slug, 'gbrain-rag produced no cache');
    try { shFlow('node', [ENTITY_PASSPORT, '--entity', ragEntity, '--page-id', pgId, '--emit-rag'], 300000); }
    catch (e) { log(`entity-passport exit non-zero (partial sources?): ${errTail(e, 80)}`); }
    const epRag = join(ragDir, 'entity-passport.rag.json');
    if (!existsSync(epRag) || statSync(epRag).size < 512) return park(slug, 'entity-passport produced no RAG');

    // 5b. chart-inject（真星盘数据）：名人 birth-chart 文章 → 抓 Wikipedia 生日 + 算真盘 → 注入 v8 prompt
    //     的 {{CHART_FACTS_BLOCK}}，让 LLM 只解读真实行星位置、不再凭空编星盘（消除 "Horse in Life Palace"
    //     那类幻觉断言）。**fail-safe**：非名人/查不到生日/API 失败 → 不写文件、render 用空块，绝不阻塞授稿。
    try { shFlow('node', [CHART_INJECT, '--entity', fallbackRagEntity || ragEntity, '--keyword', keyword, '--page-id', pgId, '--product', process.env.GG_SITE || 'astrologywiki', '--flow-dir', FLOW], 60000); }
    catch (e) { log(`chart-inject exit non-zero (skipping, no chart facts): ${errTail(e, 80)}`); }

    // 6. render → v8 prompt + fixture (render WARNs on missing SERP cache; gate on file)
    try { shFlow('node', [RENDER, '--batch', batchPath, '--overrides', overridePath]); }
    catch (e) { log(`render exit non-zero: ${errTail(e, 80)}`); }
    const promptPath = join('.gg-cache', 'prompts', `${pgId}.v8-prompt.md`);
    if (!existsSync(join(FLOW, promptPath))) return park(slug, 'render produced no v8 prompt');

    // 7+8. Generate (Opus) → validate (phase2 v4.4/v4.5.1), retrying on failure.
    //   phase2 trips on generation variance — esp. SC3c "section scatter" (≤3 prose
    //   paragraphs per H2 section), the same check PG-SOLAR-001 failed on its first
    //   generation — so regenerate up to GG_AUTHOR_GEN_ATTEMPTS times (different
    //   sampling) before parking. orchestrator overwrites the draft each attempt;
    //   phase2 writes _staging/<pid>-en.md + manifest ONLY on PASS (exit 11 on fail).
    const draftV8 = join('_staging', `${pgId}-${WINNER}-v8.md`);
    const lastFailingDraft = join('_staging', `${pgId}-last-failing-v8.md`);
    const failureMemoryPath = join(FLOW, '_staging', `${pgId}-author-failures.json`);
    const promptAbs = join(FLOW, promptPath);
    const basePrompt = readFileSync(promptAbs, 'utf8');
    const restorePrompt = () => { try { writeFileSync(promptAbs, basePrompt); } catch { /* best-effort */ } };
    // Default 3 (was 5): each Sonnet 4.6 gen is ~10-15 min, so 5 attempts on a
    // failing task burns ~65 min before parking. Historically tasks that pass do so
    // by attempt ≤3 (HEAL-004, NAKSH-005); attempts 4-5 almost never rescue a parker
    // — so 3 cuts ~24 min of waste off each hard/parking task at negligible loss.
    // Override via GG_AUTHOR_GEN_ATTEMPTS.
    const attempts = Math.max(1, parseInt(process.env.GG_AUTHOR_GEN_ATTEMPTS || '3', 10));
    let cumulativeFailures = readAuthorFailureMemory(failureMemoryPath, { pageId: pgId });
    let lastOperationalFailure = '';
    for (let i = 1; i <= attempts; i++) {
      // FEEDBACK-DRIVEN retry: hard topics (Vedic/nakshatra/healing) hit a DIFFERENT
      // phase2 check each blind attempt (RL1 clinical, RL5 keyword-stuffing, SC
      // scatter…), so plain regeneration rarely converges. Feed the previous
      // attempt's EXACT failures back into the prompt so the model fixes those.
      const feedback = authorFailureText(cumulativeFailures);
      if (feedback) {
        writeFileSync(promptAbs, `${basePrompt}\n\n## ⚠️ 之前稿件被自动校验拦下 — 本稿必须同时修掉以下全部未解决约束（否则整篇作废）\n${feedback}\n\n继续遵守上面所有硬规则，同时**对照下表逐条修正**（命中哪条改哪条）：\n- 临床/医疗主张（RL1：heal/treat/cure/diagnose + 焦虑/抑郁/创伤/疾病/疼痛/失眠等病症名）→ 改成象征/反思措辞（"a reflective lens for" / "some people explore this theme" / "is traditionally associated with"）。\n- target_keyword 堆词（RL5：count 超上限）→ 以 fixture 的 kw_count_range 为准；删去多余完整短语，用代词/短形/同义改写替换。\n- drifted sections（RL4）→ 只修被点名的实质 prose H2；Take Action / Related Reading / Sources 由各自结构门禁负责，不要为它们硬塞关键词。\n- 缺免责声明（RL6 / disclaimer，psych-safety 主题必需）→ 在正文结尾**逐字加入这一行**：This is not a clinical interpretation or mental health advice.\n- section scatter（SC3c）→ 被空行散成多段的小节改成「引子句 + 编号列表（\`1. **标签。** 说明\`）」。\n- link distribution（SC4）→ 至少 1 条内链自然内联织进正文前段句子里（首链优先），别全堆结尾。\n`);
      }
      // Sonnet 4.6 xhigh is SLOW (~10 min/generation, measured 585s; ~3× Opus), and
      // the feedback-retry prompt (longer) pushes it longer still. The old 15-min
      // timeout killed attempts 2-5 → "orchestrator produced no draft" parks. Give it
      // 30 min, and drop the orchestrator's blind internal retry to 1 (2 internal ×
      // 10 min would blow the budget) — the autopilot's own 5-attempt FEEDBACK loop is
      // the smart retry. Override via GG_AUTHOR_ORCH_TIMEOUT_MS.
      // --retry 0: the orchestrator's CPU-watchdog self-bounds ONE generation to
      // ≤20 min (kills the process GROUP on a deadlock — no orphans), and the
      // autopilot's own 5-attempt FEEDBACK loop (below) is the smart retry. A blind
      // orchestrator-internal retry would just double the wall-clock under no outer
      // control. The 30-min shFlow timeout is then only a rare backstop (> the 20-min
      // watchdog ceiling), so the in-orchestrator watchdog fires first and cleanly.
      const orchTimeout = parseInt(process.env.GG_AUTHOR_ORCH_TIMEOUT_MS || '1800000', 10);
      try { shFlow('node', [ORCHESTRATOR, '--prompt', promptPath, '--page-id', pgId, '--models', WINNER, '--out-dir', '_staging', '--retry', '0'], orchTimeout); }
      catch (e) { log(`orchestrator exit non-zero (attempt ${i}): ${errTail(e, 80)}`); }
      if (!existsSync(join(FLOW, draftV8))) {
        lastOperationalFailure = '- orchestrator produced no draft';
        continue;
      }
      try { shFlow('node', [PHASE2, '--source', draftV8, '--page-id', pgId, '--tag', 'en', '--author', author]); }
      catch (e) {
        const currentFailure = summarizePhase2Failure(e);
        cumulativeFailures = mergeAuthorFailures(cumulativeFailures, currentFailure);
        writeAuthorFailureMemory(failureMemoryPath, {
          pageId: pgId,
          status: 'failed',
          failures: cumulativeFailures,
        });
        try { writeFileSync(join(FLOW, lastFailingDraft), readFileSync(join(FLOW, draftV8), 'utf8')); } catch { /* best-effort */ }
        log(`phase2 attempt ${i}/${attempts} failed:\n${currentFailure}${i < attempts ? '\n  → regenerating WITH cumulative feedback' : ''}`);
        continue;
      }
      if (existsSync(enDraft(pgId)) && phase2Passed(pgId)) {
        writeAuthorFailureMemory(failureMemoryPath, { pageId: pgId, status: 'passed', failures: [] });
        restorePrompt(); // drop the transient feedback addendum now that a draft passed
        // multi-party review (user-approved 2026-06-03): Codex critiques the
        // phase2-passing draft → Opus revises → re-validate. Adopt the revision
        // ONLY if it still passes phase2 (best-effort improvement, never regress —
        // on any failure _staging/<pid>-en.md stays the original passing draft).
        const revisedV8 = join('_staging', `${pgId}-revised-v8.md`);
        try {
          // Review now runs TWO critics (Codex + Opus 4.8) + a Sonnet 4.6 xhigh
          // reviser; at xhigh these stack up, so allow 30 min (was 25). The reviser
          // is the slow part (~10 min); critiques are shorter. Override via env.
          const reviewTimeout = parseInt(process.env.GG_AUTHOR_REVIEW_TIMEOUT_MS || '1800000', 10);
          const out = shFlow('node', [REVIEW, '--source', draftV8, '--out', revisedV8,
            '--page-id', pgId, '--entity', cleanEntity, '--target-keyword', keyword], reviewTimeout).trim();
          log(out || 'review: (no output)');
          if (/revised/.test(out) && existsSync(join(FLOW, revisedV8))) {
            const originalDraft = readFileSync(join(FLOW, draftV8), 'utf8');
            const revisedDraft = readFileSync(join(FLOW, revisedV8), 'utf8');
            const drift = detectProtectedFactDrift(originalDraft, revisedDraft);
            if (drift.hasDrift) {
              log(`review: revised draft changed protected facts — kept original (${summarizeProtectedFactDrift(drift)})`);
            } else {
              try {
                shFlow('node', [PHASE2, '--source', revisedV8, '--page-id', pgId, '--tag', 'en', '--author', author]);
                log(phase2Passed(pgId) ? 'review: revised draft adopted (passed phase2)' : 'review: revision kept original');
              } catch { log('review: revised draft failed phase2 — kept original'); }
            }
          }
        } catch (e) { log(`review skipped: ${errTail(e, 80)}`); }
        log(`AUTHORED ${pgId} → ${enDraft(pgId)} (author=${author}, attempt ${i}/${attempts}) — ready for next scan to publish`);
        return;
      }
      cumulativeFailures = mergeAuthorFailures(cumulativeFailures, '- phase2 wrote no passing manifest');
      writeAuthorFailureMemory(failureMemoryPath, {
        pageId: pgId,
        status: 'failed',
        failures: cumulativeFailures,
      });
    }
    restorePrompt();

    // DETERMINISTIC REPAIR (2026-06-18, OAuth-CLI-worker plan Task 3): the feedback loop just failed
    // every attempt — usually on gen-quality issues blind regeneration can't fix (e.g. RL4 drift: the
    // model won't anchor the literal keyword in every section). Escalate ONCE to the shared text-only
    // gg-author-repair worker (NO tools / NO --dangerously-skip-permissions), validating the candidate
    // with the EN phase2 gate; adopt only on PASS. Only fires at the park boundary. Toggle GG_AUTHOR_REPAIR=0.
    const repairSource = existsSync(join(FLOW, draftV8)) ? draftV8 : lastFailingDraft;
    const cumulativeFailureText = authorFailureText(cumulativeFailures);
    const repairResult = tryDeterministicRepair({
      pgId, draftV8: repairSource, candidate: join('_staging', `${pgId}-repair-candidate.md`),
      targetKeyword: keyword,
      author,
      failures: cumulativeFailureText || lastOperationalFailure || '- phase2 failed',
      constraints: authorRepairConstraints(pgId),
      validate: (cand) => {
        shFlow('node', [PHASE2, '--source', cand, '--page-id', pgId, '--tag', 'en', '--author', author, '--prompt-version', VERSION]);
        return existsSync(enDraft(pgId)) && phase2Passed(pgId);
      },
    });
    if (repairResult.passed) {
      writeAuthorFailureMemory(failureMemoryPath, { pageId: pgId, status: 'passed', failures: [] });
      log(`AUTHORED ${pgId} → ${enDraft(pgId)} (author=${author}, via deterministic repair) — ready for next scan to publish`);
      return;
    }

    const finalFailure = repairResult.failure || cumulativeFailureText || lastOperationalFailure || '- phase2 failed';
    const repairSuffix = repairResult.attempted
      ? ` + ${repairResult.attempts || 1} deterministic repair attempt(s)`
      : ' + deterministic repair not attempted';
    return park(slug, `${finalFailure.replace(/\n/g, ' | ')} after ${attempts} generation attempt(s)${repairSuffix}`);
  } catch (e) {
    return park(null, `unexpected: ${errTail(e)}`);
  }
}

async function doAuthor(o = {}) {
  const authorLock = acquireGlobalAuthorLock(o.task || '');
  if (!authorLock.acquired) {
    const owner = authorLock.owner || {};
    log(`author executor busy: lane=${owner.lane || 'unknown'} pid=${owner.pid || '?'} task=${owner.taskId || '?'} — skip safely`);
    return;
  }
  try {
    return await doAuthorUnlocked(o);
  } finally {
    authorLock.release();
  }
}

// ── main flows ──────────────────────────────────────────────────────────────
function doScan(o) {
  // Locking is scoped INSIDE doScanLocked now: the claimable→claim SELECTION is atomic, but the
  // minutes-long per-task publish (build/push/PR) runs UNLOCKED so a concurrent --status/--merge
  // doesn't block on it and throw.
  return doScanLocked(o);
}

// Atomic single-claim ledger write: load-modify-save under the claims lock, plus the Task-8
// stage/lease stamp. Used for every write OUTSIDE the short selection phase. Safe to re-load:
// once a claim is 'active' it is owned by this run, so patching the freshly-loaded ledger can
// neither lose nor be lost by another writer.
function stampClaim(pgId, stage, patch = {}) {
  return withClaimsLock(() => {
    const c = loadClaims();
    c[pgId] = { ...(c[pgId] || {}), ...patch };
    heartbeatClaim(c, pgId, stage);
    saveClaims(c);
    return c[pgId];
  });
}

function doScanLocked(o) {
  // PHASE 1 (locked, short): pick claimable tasks and mark them 'active'. Selection (syncOracle +
  // claimable + claim) MUST be atomic so two runs can't double-claim the same task.
  const picked = withClaimsLock(() => {
    const plan = latestPlan();
    if (!plan) { log('no blog-output-plan found'); return []; }
    log(`plan: ${basename(plan)}`);
    syncOracle(); // hard-sync BEFORE claimable() so the "already published" check is accurate
    const claims = loadClaims();
    const tasks = parseTasks(plan);

    const sel = [];
    for (const t of tasks) {
      if (sel.length >= o.limit) break;
      const c = claimable(t, claims);
      if (!c.ok) { log(`skip ${t.pgId}: ${c.reason}`); continue; }
      sel.push({ ...t, slug: c.slug });
    }
    if (!sel.length) { log('nothing claimable this run'); return []; }

    for (const t of sel) {
      log(`claim ${t.pgId} → ${t.slug}`);
      claims[t.pgId] = { status: 'active', slug: t.slug, owner: 'autopilot', plan: basename(plan) };
      heartbeatClaim(claims, t.pgId, 'claim'); // Task 8: stage/lease so a stuck publish is observable
    }
    saveClaims(claims);
    return sel;
  });

  // PHASE 2 (UNLOCKED): the heavy per-task publish. Each ledger write is its own atomic stampClaim()
  // (load-modify-save), so the minutes-long build/push never hold the claims lock — a concurrent
  // --status/--merge no longer blocks on it and throws.
  for (const t of picked) publishOne(o, t);
}

// Publish one already-claimed ('active') task: worktree → convert → author-gate → illustrate →
// build → push+PR. Runs WITHOUT the claims lock; every ledger transition is an atomic stampClaim,
// and the last stamped stage shows where a parked claim failed (--stale-report).
function publishOne(o, t) {
  const branch = `seo/auto/${new Date().toISOString().slice(0, 10)}-${t.pgId}`;
  const worktreeBranch = o.dryRun ? `${branch}-dry-run-${process.pid}` : branch;

  let publishRepo;
  stampClaim(t.pgId, 'worktree');
  try {
    publishRepo = preparePublishWorktree(worktreeBranch);
    stampClaim(t.pgId, 'worktree', { worktree: publishRepo, branch });
  } catch (e) {
    stampClaim(t.pgId, 'worktree', { status: 'needs_human', error: `worktree: ${e.message}` });
    log(`FAIL worktree ${t.pgId}`);
    return;
  }

  stampClaim(t.pgId, 'convert');
  try { convert(publishRepo, t.pgId, t.slug); }
  catch (e) { stampClaim(t.pgId, 'convert', { status: 'needs_human', error: `convert: ${e.message}` }); log(`FAIL convert ${t.pgId}`); return; }

  // author-known gate
  const known = registeredAuthorIds(publishRepo);
  const used = articleAuthorIds(publishRepo, t.slug);
  const missing = used.filter((a) => a && a !== 'undefined' && !known.has(a));
  if (missing.length) {
    const reason = `unregistered author(s): ${[...new Set(missing)].join(',')}`;
    stampClaim(t.pgId, 'author-known', { status: 'needs_human', error: reason });
    log(`PARK ${t.pgId}: ${reason}`);
    return;
  }

  // illustration (best-effort enrichment, NEVER blocks the text publish). A broken image step can't
  // sink a publishable article — illustrate() and this try/catch both fail safe.
  let ill = { hero: false, inline: 0, needsHero: false };
  try {
    ill = illustrate({ repo: publishRepo, slug: t.slug, flowDir: FLOW, log });
    log(`illustrate ${t.pgId}: hero=${ill.hero} inline=${ill.inline}${ill.needsHero ? ' needs_hero' : ''}${ill.qaWarn ? ' qa_warn' : ''}${ill.note ? ` (${ill.note})` : ''}`);
  } catch (e) { log(`illustrate ${t.pgId}: caught ${errTail(e, 80)} — publishing without images`); }
  const heroPatch = ill.needsHero ? { needs_hero: true } : {};

  // Commit only the intended article/registry/assets first. The production build mutates many
  // generated public/ and OG files; running it in the review worktree used to leave unrelated
  // tracked/untracked output behind, so the later immutable Gate correctly parked every article
  // as "worktree dirty". Validate the exact committed tree in a disposable detached worktree
  // instead, keeping the PR/review worktree byte-clean from its first preview onward.
  const addPaths = ['data/articles'];
  if (existsSync(join(publishRepo, 'scripts', 'generate-seo-pages.mjs'))) addPaths.push('scripts/generate-seo-pages.mjs');
  // Commit the generated illustration assets (hero jpg + inline svgs) + the per-article plan.
  if (ill.hero || ill.inline > 0) {
    if (existsSync(join(publishRepo, 'public', 'images', 'blog'))) addPaths.push('public/images/blog');
    if (existsSync(join(publishRepo, 'scripts', 'plans', `auto-${t.slug}.json`))) addPaths.push(`scripts/plans/auto-${t.slug}.json`);
  }
  gitIn(publishRepo, ['add', ...addPaths]);
  gitIn(publishRepo, ['commit', '-q', '-m', `feat(articles): publish ${t.slug} (${WINNER} ${VERSION}) [autopilot]`]);

  stampClaim(t.pgId, 'build-gate');
  const b = buildCommittedGate(publishRepo, worktreeBranch);
  if (!b.ok) {
    stampClaim(t.pgId, 'build-gate', { status: 'needs_human', error: `build: ${b.error}` });
    log(`PARK ${t.pgId}: build failed`);
    return;
  }

  if (o.dryRun) {
    stampClaim(t.pgId, 'dry-run-ok', { status: 'dry-run-ok', ...heroPatch });
    cleanupWorktree(publishRepo);
    log(`DRY-RUN OK ${t.pgId} (${t.slug}) build✓ — not pushed`);
    return;
  }

  stampClaim(t.pgId, 'push');
  // --force: these seo/auto/<date>-<pgid> branches are disposable & autopilot-owned; a re-publish
  // (or a stale remote branch off an older main) otherwise rejects as non-fast-forward.
  gitIn(publishRepo, ['push', '-u', '--force', 'origin', branch]);
  // Open a PR so Vercel posts a Preview deployment; merge happens in --merge after the gate passes.
  let prUrl = '';
  try {
    prUrl = sh('gh', ['pr', 'create', '--repo', 'xdawayer/oracle', '--base', 'main', '--head', branch,
      '--title', `[autopilot] publish ${t.slug}`,
      '--body', `Automated SEO publish of \`${t.pgId}\` → \`${t.slug}\` (EN-only).\n\nAwaiting codex review + chrome MCP verification on the Vercel preview before merge.`],
      { cwd: publishRepo }).trim();
  } catch (e) {
    // Re-publish of the same date+pgId branch hits "a pull request already exists" — fine (we
    // force-pushed the fixed content); reuse the existing PR URL so verify/notify have a number.
    if (/already exists/i.test(e.message || '')) {
      try { prUrl = sh('gh', ['pr', 'view', branch, '--repo', 'xdawayer/oracle', '--json', 'url', '--jq', '.url'], { cwd: publishRepo }).trim(); }
      catch { prUrl = ''; }
    }
    if (!prUrl) prUrl = `(pr-create-failed: ${e.message})`;
  }
  stampClaim(t.pgId, 'pushed-preview', { status: 'pushed-preview', pr: prUrl, ...heroPatch });
  log(`PUSHED preview ${branch} PR=${prUrl} — awaiting codex+chrome verify, then --merge`);
}

// ── Legacy union helper (not callable from a verified merge) ─────────────────
// oracle merge 已被 CLAIMS_LOCK 串行化，唯一残余失败模式是"陈旧分支"：它从较旧 origin/main 切出，
// 期间落地的 merge 追加了同样的两个注册文件（data/articles/index.ts + scripts/generate-seo-pages.mjs）
// → `gh pr merge` 冲突 → 历史上 park 成 needs_human，靠人手动 `git merge origin/main` + union-merge 清。
// 这里把那套手动修复编码成确定性代码：在新鲜 worktree 里把 origin/main union-merge 进 reviewed 分支、
// 断言文章自身字节与 reviewed 一致 + 注册行未丢 + build gate 通过，才 push+merge。任何意外都 abort +
// 抛错 → claim 响亮 park，绝不 ship 未评审内容。GG_MERGE_UNION_SELFHEAL=0 关闭（回退到旧行为：冲突即 park）。
// 并发权衡（有意为之）：自愈里的 `npm run build` 跑在 CLAIMS_LOCK 内（doMerge 全程持锁）。这是串行发布
// 正确性所必需——若中途放锁，另一次 merge 可推进 main → 重新冲突 → 自愈白做。代价：自愈（仅冲突时才发生，
// 罕见）期间本机并发的 --scan/--status/--merge 会阻塞至 30s 锁超时后响亮抛错（不 ship 错内容、不损坏账本；
// 下一 tick 自然重试）。用锁换"冲突也能确定性合并"，值得。
const MERGE_SELFHEAL = process.env.GG_MERGE_UNION_SELFHEAL !== '0';

function ghPrMergeState(branch) {
  try {
    const out = sh('gh', ['pr', 'view', branch, '--repo', 'xdawayer/oracle', '--json', 'mergeable,mergeStateStatus'], { cwd: ORACLE });
    const j = JSON.parse(out);
    return { mergeable: j.mergeable || 'UNKNOWN', state: j.mergeStateStatus || 'UNKNOWN' };
  } catch { return { mergeable: 'UNKNOWN', state: 'UNKNOWN', error: true }; }
}

function currentPrHead(branch) {
  const headRefOid = sh('gh', [
    'pr', 'view', branch,
    '--repo', 'xdawayer/oracle',
    '--json', 'headRefOid',
    '-q', '.headRefOid',
  ], { cwd: ORACLE }).trim();
  if (!HEAD_REF_OID_RE.test(headRefOid)) {
    throw new Error(`could not resolve a valid 40-hex PR head for ${branch}`);
  }
  return headRefOid;
}

// GitHub 异步计算 mergeable：刚 push 后常是 UNKNOWN，稍等几秒会落定 MERGEABLE/CONFLICTING。
// 只对 GitHub 的 'UNKNOWN'（仍在计算）等待；gh 本身出错不会自愈，立即返回（不空等）。
function pollMergeable(branch, tries = 6, waitMs = 2000) {
  let st = ghPrMergeState(branch);
  for (let i = 0; i < tries && st.mergeable === 'UNKNOWN' && !st.error; i++) {
    sleepSync(waitMs);
    st = ghPrMergeState(branch);
  }
  return st;
}

// 在一个 detached 新 worktree（checkout 到 origin/<branch> = reviewed tip）里把 origin/main
// union-merge 进来，断言文章自身未变 + 注册行未丢 + build 通过，push 回 <branch>，返回新 head SHA。
// 任何断言失败都抛错（调用方 park）。完成后清理临时 worktree。
// expectedHead = claim.headRefOid（--mark-verified 时抓的、真正被评审的 commit）。自愈路径绕过了快
// 路径的 --match-head-commit pin，所以这里必须把它当锚点重建 union 的基座 + 完整性参照——绝不能用
// "当前 origin/<branch> tip"（那正是可能被 verify 后 force-push 掉包的东西，且后代 tip 可在文章之外
// 的文件夹带未评审内容，逐篇 .ts 断言挡不住）。所以：分支 tip 必须仍严格等于 expectedHead（任何移动
// = 未评审，直接 park），并在 expectedHead 上开 worktree 重建。expectedHead 缺失（旧 claim）才退回 tip。
function unionRebaseBranch(branch, slug, expectedHead) {
  git(['fetch', '--quiet', '--prune', 'origin']);
  // The unattended baseline is intentionally allowed to be a single-branch
  // clone that tracks only main. Fetch the reviewed SEO branch into its exact
  // remote-tracking ref so rev-parse/CAS never depends on the clone's refspec.
  git([
    'fetch',
    '--quiet',
    'origin',
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]);
  let base = `origin/${branch}`;
  if (expectedHead) {
    let tip = '';
    try { tip = git(['rev-parse', `origin/${branch}`]).trim(); } catch { tip = ''; }
    if (tip !== expectedHead) {
      throw new Error(`union-rebase ${branch}: origin tip ${tip.slice(0, 8) || '?'} != reviewed head ${expectedHead.slice(0, 8)} — refusing self-heal (branch moved since verify → unreviewed)`);
    }
    base = expectedHead; // 在真正被评审的 commit 上重建，而非仅"当前 tip"
  }
  const wt = worktreePath(`${branch}--merge`);
  try { git(['worktree', 'remove', '--force', wt]); } catch { /* no stale */ }
  try {
    git(['worktree', 'add', '--force', '--detach', wt, base]);
    const baselineModules = join(ORACLE, 'node_modules');
    const wtModules = join(wt, 'node_modules');
    if (existsSync(baselineModules) && !existsSync(wtModules)) {
      try { symlinkSync(baselineModules, wtModules); } catch { /* build gate will surface it */ }
    }
    const reviewedHead = gitIn(wt, ['rev-parse', 'HEAD']).trim(); // == expectedHead（或旧 claim 的 tip）

    const res = unionMergeIntoWorktree(wt, 'origin/main', { git: (w, a) => gitIn(w, a) });
    log(`union-rebase ${branch}: merged=${res.merged} conflicted=[${res.conflicted.join(',')}]`);

    // 安全断言 1：文章自身 .ts 与 reviewed head 字节一致（merge 只应带入 main 的其它文件 + 两个
    // 注册文件的 union；文章内容绝不能变）。差异 = 评审过的内容被改动 → 拒绝发布。
    const articleFile = `data/articles/${slug}.ts`;
    try {
      gitIn(wt, ['diff', '--quiet', reviewedHead, 'HEAD', '--', articleFile]);
    } catch {
      throw new Error(`union-rebase ${branch}: ${articleFile} differs from reviewed head — refusing to publish altered content`);
    }
    // 安全断言 2：union 没把本文章的注册行丢掉（防御；build gate 也兜底但更晚）。
    for (const reg of ['data/articles/index.ts', 'scripts/generate-seo-pages.mjs']) {
      const abs = join(wt, reg);
      if (existsSync(abs) && !readFileSync(abs, 'utf8').includes(slug)) {
        throw new Error(`union-rebase ${branch}: ${slug} missing from ${reg} after union — refusing to publish`);
      }
    }
    // 安全断言 3：union 后的树必须编译（generate-seo-pages 静态生成 + tsc）。
    const b = buildGate(wt);
    if (!b.ok) throw new Error(`union-rebase ${branch}: build failed after union merge — ${b.error}`);

    // 通过 → 新 merge commit 必须是 reviewed head 的后代，所以普通 fast-forward push 就足够；
    // 禁止 force。随后用 ls-remote 做远端 CAS 回读，确保 Gate 看到的就是这个新 SHA。
    const newHead = gitIn(wt, ['rev-parse', 'HEAD']).trim();
    if (newHead === reviewedHead) {
      throw new Error(`union-rebase ${branch}: merge produced no new head`);
    }
    gitIn(wt, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
    const remoteHead = gitIn(wt, ['ls-remote', 'origin', `refs/heads/${branch}`])
      .trim().split(/\s+/)[0] || '';
    if (remoteHead !== newHead) {
      throw new Error(
        `union-rebase ${branch}: remote head ${remoteHead.slice(0, 8) || '?'} `
        + `!= prepared head ${newHead.slice(0, 8)}`,
      );
    }
    return newHead;
  } finally {
    cleanupWorktree(wt);
  }
}

function inspectVerifiedRegateWorktree(claim, expectedHead) {
  const worktree = String(claim.worktree || '');
  if (!worktree) throw new Error('prepare-regate requires the verified claim worktree');
  const hasRepairBinding = !!claim.draftFile || !!claim.draftSha256 || !!claim.originalWorktree;
  if (hasRepairBinding) {
    if (!claim.draftFile || !claim.draftSha256) {
      throw new Error('prepare-regate controller claim is missing its draft binding');
    }
    const bound = inspectBoundRepairWorktree({
      worktree,
      expectedHead,
      remoteHead: expectedHead,
    });
    if (!bound.ok) throw new Error(bound.reason);
    const draft = inspectBoundRepairDraft({
      draftFile: claim.draftFile,
      expectedSha256: claim.draftSha256,
    });
    if (!draft.ok) throw new Error(draft.reason);
    return {
      worktree: bound.realpath,
      draftFile: draft.realpath,
      draftSha256: draft.sha256,
      root: dirname(bound.realpath),
    };
  }
  const rel = relative(WORKTREE_ROOT, worktree);
  if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`prepare-regate worktree must be below ${WORKTREE_ROOT}`);
  }
  const head = gitIn(worktree, ['rev-parse', 'HEAD']).trim();
  if (head !== expectedHead) {
    throw new Error(`prepare-regate worktree head ${head.slice(0, 8) || '?'} != reviewed head ${expectedHead.slice(0, 8)}`);
  }
  const dirty = gitIn(worktree, ['status', '--porcelain=v1', '--untracked-files=all']).trim();
  if (dirty) throw new Error(`prepare-regate worktree has uncommitted changes: ${dirty.split('\n')[0]}`);
  return { worktree, draftFile: null, draftSha256: null, root: WORKTREE_ROOT };
}

function materializeRegateWorktree({ branch, pgId, previousWorktree, root, newHead }) {
  mkdirSync(root, { recursive: true });
  const suffix = `regate-${newHead.slice(0, 12)}`;
  const stem = basename(previousWorktree || branch).replace(/[^A-Za-z0-9._-]+/g, '__');
  const worktree = join(root, `${stem}--${suffix}`);
  if (!existsSync(worktree)) {
    git(['worktree', 'add', '--force', '--detach', worktree, newHead]);
  }
  const actualHead = gitIn(worktree, ['rev-parse', 'HEAD']).trim();
  if (actualHead !== newHead) {
    throw new Error(
      `prepare-regate persistent worktree ${pgId} head ${actualHead.slice(0, 8) || '?'} `
      + `!= ${newHead.slice(0, 8)}`,
    );
  }
  const dirty = gitIn(worktree, ['status', '--porcelain=v1', '--untracked-files=all']).trim();
  if (dirty) {
    throw new Error(`prepare-regate persistent worktree ${pgId} is dirty: ${dirty.split('\n')[0]}`);
  }
  const baselineModules = join(ORACLE, 'node_modules');
  const wtModules = join(worktree, 'node_modules');
  if (existsSync(baselineModules) && !existsSync(wtModules)) {
    try { symlinkSync(baselineModules, wtModules); } catch { /* Gate surfaces missing deps later */ }
  }
  return worktree;
}

function doPrepareRegate(o) {
  if (!o.branch) die('--prepare-regate requires --branch', 2);
  return withClaimsLock(() => {
    const claims = loadClaims();
    const { pgId, claim } = claimForBranch(claims, o.branch);
    if (claim.status !== 'verified-preview') {
      throw new Error(
        `cannot prepare regate for ${o.branch} from status "${claim.status}" — expected verified-preview`,
      );
    }
    if (!HEAD_REF_OID_RE.test(String(claim.headRefOid || ''))) {
      throw new Error(`prepare-regate ${o.branch}: verified claim is missing a valid reviewed head`);
    }
    const oldHeadRefOid = claim.headRefOid;
    const currentHead = currentPrHead(o.branch);
    if (currentHead !== oldHeadRefOid) {
      throw new Error(
        `prepare-regate ${o.branch}: current PR head ${currentHead} `
        + `does not match reviewed head ${oldHeadRefOid}`,
      );
    }
    const mergeState = pollMergeable(o.branch);
    if (mergeState.mergeable !== 'CONFLICTING') {
      throw new Error(
        `prepare-regate ${o.branch}: PR is ${mergeState.mergeable}/${mergeState.state}, expected CONFLICTING`,
      );
    }
    const binding = inspectVerifiedRegateWorktree(claim, oldHeadRefOid);
    const newHeadRefOid = unionRebaseBranch(o.branch, claim.slug, oldHeadRefOid);
    const worktree = materializeRegateWorktree({
      branch: o.branch,
      pgId,
      previousWorktree: binding.worktree,
      root: binding.root,
      newHead: newHeadRefOid,
    });
    const next = {
      ...claim,
      status: 'pushed-preview',
      stage: 'pushed-preview',
      worktree,
      headRefOid: newHeadRefOid,
      regateFromHeadRefOid: oldHeadRefOid,
      regatePreparedAt: new Date().toISOString(),
      regateReason: 'additive-only main conflict resolved; complete preview gate required on new head',
    };
    for (const key of [
      'previewUrl',
      'verificationEvidence',
      'verifiedAt',
      'reviewedAt',
      'error',
      'failedAt',
      'retryAt',
    ]) delete next[key];
    claims[pgId] = next;
    heartbeatClaim(claims, pgId, 'pushed-preview');
    saveClaims(claims);
    const result = {
      ok: true,
      pageId: pgId,
      branch: o.branch,
      oldHeadRefOid,
      newHeadRefOid,
      worktree,
      draftFile: binding.draftFile,
      draftSha256: binding.draftSha256,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    log(
      `REGATE PREPARED ${o.branch}: ${oldHeadRefOid.slice(0, 8)} -> `
      + `${newHeadRefOid.slice(0, 8)} worktree=${worktree}`,
    );
  });
}

// 合并一个已 verified-preview 的分支到 main。当前 PR head 必须仍等于 reviewed head，
// 且 gh merge 永远携带 --match-head-commit。任何冲突/rebase 都会产生新 commit，因此这里
// fail closed；调用方必须先修复并在新 SHA 上重跑完整 gate，禁止 verified 后 union self-heal。
function mergeVerifiedBranch(branch, claim, { beforeMerge = null } = {}) {
  if (!HEAD_REF_OID_RE.test(String(claim.headRefOid || ''))) {
    throw new Error(`refusing merge for ${branch}: verified claim is missing a valid 40-hex headRefOid`);
  }
  const currentHead = currentPrHead(branch);
  if (currentHead !== claim.headRefOid) {
    throw new Error(
      `refusing merge for ${branch}: current PR head ${currentHead} does not match reviewed head ${claim.headRefOid}`,
    );
  }
  if (MERGE_SELFHEAL && pollMergeable(branch).mergeable === 'CONFLICTING') {
    throw new Error(
      `MERGE_REGATE_REQUIRED ${branch}: PR is conflicting; additive-only repair may create a new head, then requires a full gate round`,
    );
  }
  if (typeof beforeMerge === 'function') beforeMerge();
  sh('gh', [
    'pr', 'merge', branch,
    '--repo', 'xdawayer/oracle',
    '--merge',
    '--delete-branch',
    '--match-head-commit', claim.headRefOid,
  ], { cwd: ORACLE });
}

function doMerge(o) {
  if (!o.branch) die('--merge requires --branch', 2);
  return withClaimsLock(() => {
    const claims = loadClaims();
    const { pgId, claim } = claimForBranch(claims, o.branch);
    if (claim.status !== 'verified-preview') {
      throw new Error(
        `refusing merge for ${o.branch}: claim status is "${claim.status}", expected "verified-preview". ` +
        `Run --mark-verified only after codex + chrome preview verification pass.`,
      );
    }
    if (!claim.previewUrl) {
      throw new Error(`refusing merge for ${o.branch}: verified claim is missing previewUrl`);
    }
    if (!HEAD_REF_OID_RE.test(String(claim.headRefOid || ''))) {
      throw new Error(`refusing merge for ${o.branch}: verified claim is missing a valid 40-hex headRefOid`);
    }
    const slug = claim.slug;
    const planPath = latestPlan();
    // 串行发布：只允许当前 PR head 与 reviewed head 完全一致，并使用 GitHub CAS pin 合并。
    // 冲突处理会产生新 SHA，必须退出后重新走完整 gate，不能在 verified 状态内自愈。
    mergeVerifiedBranch(o.branch, claim, {
      beforeMerge: () => {
        // Write-ahead after every SHA/mergeability preflight but before the
        // irreversible GitHub merge. If GitHub itself fails, the durable entry
        // remains safe to retry because backfill verifies live state first.
        const wal = enqueueWriteback({
          pageId: pgId,
          slug,
          site: 'astrologywiki',
          planPath,
          done: [],
        });
        if (!wal) {
          throw new Error(`refusing merge for ${pgId}: failed to create the backfill WAL`);
        }
      },
    });

    // GitHub merge is the irreversible publication point. Persist terminal
    // claim state immediately; every operation below is replayable/best-effort
    // and must never make Preview Gate report a published PR as gate-failed.
    claims[pgId].status = 'done';
    claims[pgId].mergedAt = new Date().toISOString();
    delete claims[pgId].error;
    delete claims[pgId].failedAt;
    saveClaims(claims);

    const recorded = appendPublishLog(pgId, slug);
    cleanupWorktree(claim.worktree);
    try {
      syncOracle();
    } catch (e) {
      log(`post-merge oracle sync deferred: ${errTail(e, 120)}`);
    }
    try {
      checkPlanBox(pgId); // 即时勾选；下方回填事务仍会幂等补齐。
    } catch (e) {
      log(`post-merge plan check deferred: ${errTail(e, 120)}`);
    }
    // writing record → ops (self-synced)；返回 promise（尾部是 published 事件通知 + 阶段4 回填事务），
    // 由顶层 dispatcher await 收尾——claims 锁在同步部分结束时即释放，不为通知/回填多持锁。
    log(`MERGED ${o.branch} → main (prod deploy triggered)`);
    // 阶段 4 回填事务（锁外）：merge 成功后 verify-live(sitemap) → 写全套账本
    // （选题登记表 已发布+URL / plan 勾选 / vault 归档），失败入 pending-writeback 由每日对账重试。
    // backfillOnLive 永不抛；deferred（尚未进 sitemap）会留队等每日 drain。不阻塞发布串行。
    return Promise.resolve(recorded)
      .then(() => backfillOnLive({ pageId: pgId, slug, site: 'astrologywiki', planPath }))
      .then((r) => {
        if (r.ok) log(`backfill ${pgId}: sheet+plan+archive done`);
        else log(`backfill ${pgId}: ${r.reason || (r.failed || []).map((f) => f.step).join(',')} — queued for daily reconcile`);
      })
      .catch((e) => log(`backfill ${pgId} error (non-fatal): ${e.message}`));
  });
}

function doMarkVerified(o) {
  if (!o.branch) die('--mark-verified requires --branch', 2);
  if (!o.previewUrl) die('--mark-verified requires --preview-url', 2);
  if (!/^https:\/\/[^/]+/.test(o.previewUrl)) die(`invalid --preview-url: ${o.previewUrl}`, 2);
  if (!o.headRefOid) die('--mark-verified requires --head-ref-oid', 2);
  if (!HEAD_REF_OID_RE.test(o.headRefOid)) die('--head-ref-oid must be a 40-hex SHA', 2);
  const repairBindingValues = [o.worktree, o.draft, o.draftSha256];
  const explicitRepairBinding = repairBindingValues.some((value) => value != null && value !== '');
  if (explicitRepairBinding && repairBindingValues.some((value) => value == null || value === '')) {
    die('repair verification binding requires --worktree, --draft, and --draft-sha256 together', 2);
  }
  return withClaimsLock(() => {
    const claims = loadClaims();
    const { pgId, claim } = claimForBranch(claims, o.branch);
    const retryingParkedPreview = claim.status === 'needs_human' && claim.stage === 'pushed-preview' && !!claim.retryAt;
    if (!['pushed-preview', 'verified-preview'].includes(claim.status) && !retryingParkedPreview) {
      throw new Error(`cannot mark ${o.branch} verified from status "${claim.status}"`);
    }
    const currentHead = currentPrHead(o.branch);
    if (currentHead !== o.headRefOid) {
      throw new Error(
        `cannot mark ${o.branch} verified: current PR head ${currentHead} does not match reviewed head ${o.headRefOid}`,
      );
    }
    let repairWorktree = null;
    let repairDraft = null;
    if (explicitRepairBinding) {
      repairWorktree = inspectBoundRepairWorktree({
        worktree: o.worktree,
        expectedHead: o.headRefOid,
        remoteHead: currentHead,
      });
      if (!repairWorktree.ok) throw new Error(repairWorktree.reason);
      repairDraft = inspectBoundRepairDraft({
        draftFile: o.draft,
        expectedSha256: o.draftSha256,
      });
      if (!repairDraft.ok) throw new Error(repairDraft.reason);
    }
    const reviewedAt = new Date().toISOString();
    claims[pgId] = {
      ...claim,
      status: 'verified-preview',
      previewUrl: o.previewUrl,
      verificationEvidence: o.evidence || 'codex+chrome preview verification passed',
      verifiedAt: reviewedAt,
      reviewedAt,
      headRefOid: o.headRefOid,
      ...(repairWorktree
        ? {
            originalWorktree: claim.originalWorktree || claim.worktree || null,
            worktree: repairWorktree.realpath,
            draftFile: repairDraft.realpath,
            draftSha256: repairDraft.sha256,
          }
        : {}),
    };
    delete claims[pgId].error;
    delete claims[pgId].failedAt;
    saveClaims(claims);
    log(`VERIFIED ${o.branch} preview=${o.previewUrl} head=${o.headRefOid.slice(0, 8)}`);
  });
}

async function doMarkFailed(o) {
  if (!o.branch) die('--mark-failed requires --branch', 2);
  if (!o.reason) die('--mark-failed requires --reason', 2);
  const parked = withClaimsLock(() => {
    const claims = loadClaims();
    const { pgId, claim } = claimForBranch(claims, o.branch);
    if (!['active', 'pushed-preview', 'verified-preview'].includes(claim.status)) {
      throw new Error(`cannot park ${o.branch} from status "${claim.status}"`);
    }
    claims[pgId] = {
      ...claim,
      status: 'needs_human',
      error: o.reason,
      failedAt: new Date().toISOString(),
    };
    saveClaims(claims);
    log(`PARKED ${o.branch}: ${o.reason}`);
    return { pageId: pgId, claim: claims[pgId] };
  });
  await persistClaimRepair(parked.pageId, parked.claim);
}

function doRetryFailed(o) {
  if (!o.branch) die('--retry-failed requires --branch', 2);
  return withClaimsLock(() => {
    const claims = loadClaims();
    const { pgId, claim } = claimForBranch(claims, o.branch);
    if (claim.status !== 'needs_human') {
      throw new Error(`cannot retry ${o.branch} from status "${claim.status}" — expected needs_human`);
    }
    const next = {
      ...claim,
      status: 'pushed-preview',
      retryEvidence: o.evidence || 'human-fixed parked preview; rerun preview gate',
      retryAt: new Date().toISOString(),
    };
    delete next.error;
    delete next.failedAt;
    if (o.clearNeedsHero) delete next.needs_hero;
    claims[pgId] = next;
    heartbeatClaim(claims, pgId, 'pushed-preview');
    saveClaims(claims);
    log(`RETRY ${o.branch}: restored to pushed-preview for gate rerun`);
  });
}

function doRetryAuthor(o) {
  if (!o.task) die('--retry-author requires --task PG-...', 2);
  return withClaimsLock(() => {
    const claims = loadClaims();
    const claim = claims[o.task];
    if (!claim) {
      log(`RETRY(author) ${o.task}: no claim to clear`);
      return;
    }
    if (claim.status !== 'needs_human') {
      throw new Error(`cannot retry authoring ${o.task} from status "${claim.status}" — expected needs_human`);
    }
    if (claim.stage !== 'authoring') {
      throw new Error(`cannot retry authoring ${o.task} from stage "${claim.stage || ''}" — expected authoring`);
    }
    delete claims[o.task];
    saveClaims(claims);
    log(`RETRY(author) ${o.task}: cleared parked authoring claim (${o.reason || 'operator requested rerun'})`);
  });
}

// 阶段 6：transient park 自动重试的尝试计数 sidecar（vault 外 flow-state；即便 claim 被删也存活，
// 保证 CAP 不被"删 claim→重授→重新 park→计数归零"绕过 → 防无限重试真坏稿）。
function parkRetryStatePath() { const d = stateDir(); return d ? join(d, 'park-autoretry.json') : null; }
// 真·可持久化探针（评审 BLOCKING）：光有路径不够——只读/满盘目录 mkdirSync 也 no-op 成功，但真写会
// 失败被 saveParkRetryState 吞掉 → 计数永不落盘 → 无限重试。探一次真写真删，确认能持久化才自愈。
function parkRetryStateWritable() {
  const p = parkRetryStatePath(); if (!p) return false;
  try { const probe = `${p}.probe-${process.pid}`; writeFileSync(probe, '1'); rmSync(probe, { force: true }); return true; }
  catch { return false; }
}
// 读 sidecar：ENOENT(首次)→{}；解析错误(损坏)→null（上层 fail-closed，绝不静默清零 CAP）。
function loadParkRetryState() {
  const p = parkRetryStatePath(); if (!p) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { return (e && e.code === 'ENOENT') ? {} : null; }
}
function saveParkRetryState(m) {
  const p = parkRetryStatePath(); if (!p) return;
  try { const tmp = `${p}.tmp-${process.pid}`; writeFileSync(tmp, JSON.stringify(m, null, 2)); renameSync(tmp, p); } catch { /* 状态层不搞垮业务 */ }
}

// 自动重试 transient park（阶段 6 · 让 LLM 用量窗口造成的临时失败自愈）：找 needs_human 且 error
// 判 transient 的项，按 CAP + backoff 自动重入队——authoring 阶段清 claim（作者 lane 重授）、
// gate 阶段回 pushed-preview（门重跑）。超 CAP → 升级为真 needs_human（不再重试）+ 通知一次。
// permanent park（内容/事实/缺登记）一律不动。永不抛。GG_PARK_AUTORETRY_CAP/BACKOFF_MS 可调。
function doAutoRetryParks() {
  const CAP = Number(process.env.GG_PARK_AUTORETRY_CAP || 10);                                  // ~10 次
  const BACKOFF_MS = Number(process.env.GG_PARK_AUTORETRY_BACKOFF_MS || 35 * 60 * 1000);        // 正常节奏 ~35min（10×35min≈5.8h，覆盖多小时用量窗口）
  const SLOW_BACKOFF_MS = Number(process.env.GG_PARK_AUTORETRY_SLOW_BACKOFF_MS || 2 * 3600 * 1000); // 升级后慢节奏 ~2h（仍自愈超长窗口）
  const TTL_MS = Number(process.env.GG_PARK_AUTORETRY_TTL_MS || 7 * 24 * 3600 * 1000);           // 7d：远长于停机+作者 lane 周期，只回收真泄漏项
  const repairControllerOwnsTerminal = process.env.GG_SEO_REPAIR_CONTROLLER_V2_ENABLED === '1';
  // fail-closed（评审 BLOCKING）：sidecar 是安全计数器；持久化不可用→CAP/backoff 全失效→无限重试。
  // 探真写（非仅路径可算——只读/满盘目录路径仍非空但写会失败），不可写就本轮跳过、宁可不自愈。
  if (!parkRetryStateWritable()) { log('auto-retry-parks: flow-state 不可写 — 本轮跳过（fail-closed，无法保证 CAP）'); return Promise.resolve(); }
  const now = Date.now();
  const escalations = [];
  const permParks = [];
  const retried = [];
  withClaimsLock(() => {
    const claims = loadClaims();
    const sidecar = loadParkRetryState();
    if (sidecar === null) { log('auto-retry-parks: sidecar 损坏 — 本轮跳过（fail-closed，不静默清零 CAP）'); return; }
    // cleanup（评审 BLOCKING+MAJOR）：只清 done；或"claim 已彻底消失(泄漏)"的项超长 TTL 回收。
    // **绝不清一个仍有活 claim(needs_human/pushed-preview/active…) 的计数**——否则停机>TTL 后首 tick
    // 会把停着的 park 预算清零、还丢 escalated 标记 → CAP 归零被绕过。也绝不因"claim 暂时不在/非
    // needs_human"就清（那是 authoring 重试删 claim / gate 转 pushed-preview 的中间态）。
    for (const pid of Object.keys(sidecar)) {
      const c = claims[pid];
      if (c && c.status === 'done') { delete sidecar[pid]; continue; } // 明确成功 → 清
      if (c) continue;                                                 // 有活 claim（任何非 done）→ 计数保留
      if (now - (sidecar[pid].lastAt || now) > TTL_MS) delete sidecar[pid]; // 仅无 claim 的泄漏项 TTL 回收
    }
    for (const [pid, claim] of Object.entries(claims)) {
      if (!claim || claim.status !== 'needs_human') continue;
      if (classifyPark(claim) !== 'transient') {
        // v1：永久 park 去重发一次终态通知。v2：只做队列交接审计，终态完全归 controller；
        // 外层自然 wrapper 紧接着 import-v1 + drain，不允许旧 needs_human 抢跑。
        const sp = sidecar[pid] || { attempts: 0, lastAt: 0 };
        if (repairControllerOwnsTerminal) {
          sp.repairQueued = true;
          sidecar[pid] = sp;
        } else if (!sp.permNotified) {
          sp.permNotified = true;
          sidecar[pid] = sp;
          permParks.push({ pid, slug: claim.slug, error: claim.error });
        }
        continue;
      }
      const s = sidecar[pid] || { attempts: 0, lastAt: 0 };
      const escalated = s.attempts >= CAP;
      const backoff = escalated ? SLOW_BACKOFF_MS : BACKOFF_MS;
      if (now - (s.lastAt || 0) < backoff) continue;     // backoff 未到，等下一轮
      if (escalated && !s.escalated) { s.escalated = true; escalations.push({ pid, slug: claim.slug, error: claim.error, attempts: s.attempts }); }
      if (!escalated) s.attempts += 1;                   // 未到 CAP 才增计数；升级后不再增(非终态、仍慢重试自愈)
      s.lastAt = now; sidecar[pid] = s;
      // 路由（评审）：只有 stage==='pushed-preview'（真推了 preview/有 PR）才回 pushed-preview 重跑门；
      // authoring + pre-preview(worktree/convert/build-gate) 一律删 claim 从 scan 从头重跑，绝不给无 PR
      // 的 claim 设 pushed-preview（否则门空跑幻影分支、静默搁浅）。
      if (claim.stage === 'pushed-preview') {
        const next = { ...claim, status: 'pushed-preview', retryEvidence: `auto-retry transient park #${s.attempts}${escalated ? '(escalated,slow)' : `/${CAP}`}: ${String(claim.error || '').slice(0, 60)}`, retryAt: new Date().toISOString() };
        delete next.error; delete next.failedAt;
        claims[pid] = next;
        heartbeatClaim(claims, pid, 'pushed-preview');
      } else {
        delete claims[pid]; // scan 从头重跑
      }
      retried.push({ pid, stage: claim.stage || 'authoring', attempt: s.attempts, escalated });
      log(`AUTO-RETRY ${pid} (${claim.stage || 'authoring'}, #${s.attempts}${escalated ? ' escalated-slow' : `/${CAP}`}): transient park re-queued`);
    }
    saveClaims(claims);
    saveParkRetryState(sidecar);
  });
  // 升级通知（锁外，返回 promise 供顶层 await）：到 CAP 疑似非临时 → 通知人工一次；但**非终态**——
  // 系统仍每 SLOW_BACKOFF 慢重试，长但临时的窗口最终会自愈。
  return (async () => {
    for (const e of escalations) {
      if (repairControllerOwnsTerminal) {
        log(`AUTO-RETRY ESCALATE ${e.pid} at ${e.attempts} attempts — controller 接管，继续慢重试`);
      } else {
        log(`AUTO-RETRY ESCALATE ${e.pid} at ${e.attempts} attempts — 通知人工（仍会慢重试自愈）`);
        try { await notifyEvent('parked', { site: 'astrologywiki', pid: e.pid, slug: e.slug || '?', reason: `自动重试 ${e.attempts} 次仍未过（疑非临时/配额问题，请人工查；系统仍会每 ${Math.round(SLOW_BACKOFF_MS / 3600000)}h 慢重试）：${String(e.error || '').slice(0, 70)}` }); } catch { /* notify 不搞垮对账 */ }
      }
    }
    for (const p of permParks) {
      log(`PERMANENT PARK ${p.pid} — 彻底停止,去重通知人工(不会自动重试)`);
      try { await notifyEvent('parked', { site: 'astrologywiki', pid: p.pid, slug: p.slug || '?', reason: `彻底停止,需人工（内容/结构问题,不会自动重试）：${String(p.error || '').slice(0, 80)}` }); } catch { /* notify 不搞垮对账 */ }
    }
    if (retried.length) log(`auto-retry-parks: ${retried.length} transient park(s) re-queued; ${escalations.length} escalated; ${permParks.length} permanent-notified`);
    else if (!escalations.length) log('auto-retry-parks: no transient parks to retry');
  })();
}

function checkPlanBox(pgId) {
  const plan = latestPlan();
  if (!plan) return;
  const src = readFileSync(plan, 'utf8');
  const out = src.replace(new RegExp(`(^\\s*-\\s*\\[) (\\]\\s*\`?${pgId}\`?)`, 'm'), '$1x$2');
  if (out !== src) writeFileSync(plan, out);
}

// Commit + push specific OPS files ourselves (path-restricted) so writing records
// sync to the team's ops repo WITHOUT depending on obsidian-git (which only runs
// while the Obsidian app is open and was observed stalled for ~15h). Best-effort:
// never blocks the merge; coexists with obsidian-git by committing only OUR paths
// and rebasing once if the push is rejected.
function syncOpsFiles(absPaths, msg) {
  const rel = absPaths.filter(Boolean).map((p) => p.replace(`${OPS}/`, ''));
  if (!rel.length) return;
  try {
    gitIn(OPS, ['add', ...rel]);
    gitIn(OPS, ['commit', '-q', '-m', `${msg} [autopilot]`, '--', ...rel]);
  } catch { return; } // nothing staged for our paths (already committed) → done
  try { gitIn(OPS, ['push', 'origin', 'HEAD']); }
  catch {
    try { gitIn(OPS, ['pull', '--rebase', '--autostash', 'origin', 'main']); gitIn(OPS, ['push', 'origin', 'HEAD']); }
    catch (e) { log(`ops push deferred (obsidian-git will catch up): ${errTail(e, 80)}`); }
  }
}

// 统一事件层通知（阶段 1 · NOTIFY-CONTRACT.md）：模板文案与 @ 策略集中在
// lib/gg-notify.mjs 的事件表，这里只传结构化字段——不再裸拼字符串、不再散装 AT env。
// GG_AUTOPILOT_NO_NOTIFY=1 的测试抑制门保持原位原语义。
async function notifyEvent(event, fields) {
  if (process.env.GG_AUTOPILOT_NO_NOTIFY === '1') return; // suppressed in tests
  try { await notify(event, fields); } catch { /* best-effort; never blocks */ }
}

function opsPublishLog() { return join(OPS, 'inbox', '06-tasks', 'seo-autopilot-publish-log.md'); }

function enqueueIndexTracking(pgId, slug, title, author, date) {
  if (process.env.GG_AUTOPILOT_NO_INDEX_TRACKING === '1') return;
  if (!existsSync(INDEX_MONITOR)) return;
  try {
    const args = [
      INDEX_MONITOR,
      '--enqueue-published',
      '--page-id', pgId,
      '--slug', slug,
      '--title', title || slug,
      '--published-at', date,
      '--source', 'seo-autopilot',
      '--write-sheet',
    ];
    if (author) args.push('--author', author);
    const out = sh('node', args, { cwd: FLOW, timeout: 60000 });
    const last = String(out).trim().split('\n').filter(Boolean).pop();
    if (last) log(`index-tracking: ${last}`);
  } catch (e) {
    log(`index-tracking skipped: ${errTail(e, 80)}`);
  }
}

// Append one row per published article to the ops publish register (the "写作记录"),
// then sync it + the plan to ops. Title/author come from the en.md frontmatter.
// Async because the trailing `published` event notify is awaited（caller 顶层 await 收尾）.
async function appendPublishLog(pgId, slug, { notifyPublished = true } = {}) {
  try {
    const f = opsPublishLog();
    let title = '', author = '';
    if (existsSync(enDraft(pgId))) {
      const head = readFileSync(enDraft(pgId), 'utf8').slice(0, 1500);
      title = ((head.match(/^title:\s*(.+)$/m) || [])[1] || '').trim().replace(/^["']|["']$/g, '');
      author = (head.match(/^author_id:\s*["']?([a-z0-9-]+)/m) || [])[1] || '';
    }
    const date = new Date().toISOString().slice(0, 10);
    const url = `https://www.astrologywiki.com/en/wiki/${slug}`;
    if (!existsSync(f)) {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, `---\ntitle: SEO Autopilot 发布登记\ntype: log\nupdated: ${date}\n---\n\n# 📝 SEO Autopilot 发布登记（自动维护）\n\n> autopilot 每篇文章发布到 prod 后自动追加一行并 commit+push。\n\n| 日期 | PG-id | slug | 标题 | 作者 | 线上 URL | 状态 |\n|---|---|---|---|---|---|---|\n`);
    }
    let src = readFileSync(f, 'utf8');
    let inserted = false;
    if (!src.includes(`| ${pgId} |`)) {
      src = src.replace(/\nupdated:\s*[\d-]+/, `\nupdated: ${date}`) +
        `| ${date} | ${pgId} | ${slug} | ${title.replace(/\|/g, '/')} | ${author} | ${url} | published |\n`;
      writeFileSync(f, src);
      inserted = true;
    }
    syncOpsFiles([f, latestPlan()], `chore(seo): publish ${slug}`);
    if (!inserted) return { ok: true, inserted: false };
    enqueueIndexTracking(pgId, slug, title, author, date);
    // published 事件（NOTIFY-CONTRACT.md 迁移映射 :1501）
    if (notifyPublished) {
      await notifyEvent('published', {
        site: 'astrologywiki',
        title: title || slug,
        url,
        extra: `作者 ${author || '?'}，已登记到 ops`,
      });
    }
    return { ok: true, inserted: true };
  } catch (e) {
    log(`publish-log skipped: ${errTail(e, 80)}`);
    return { ok: false, inserted: false };
  }
}

function doStatus() {
  return withClaimsLock(() => {
    const claims = loadClaims();
    if (reconcileClaimsWithGitHub(claims)) saveClaims(claims);
    process.stdout.write(JSON.stringify(claims, null, 2) + '\n');
  });
}

// --stale-report (Task 8): READ-ONLY observability of in-flight claims and their lease/stage.
// Surfaces a crashed/stuck publish (active claim past its lease) or a preview that has been
// awaiting the gate too long — WITHOUT any mutation or auto-reclaim (the operator decides).
function doStaleReport() {
  const claims = loadClaims();
  const INFLIGHT = ['active', 'pushed-preview', 'verified-preview'];
  const rows = [];
  for (const [pgId, c] of Object.entries(claims)) {
    if (!c || !INFLIGHT.includes(c.status)) continue;
    rows.push({
      pgId, status: c.status, stage: c.stage || null, lockedBy: c.lockedBy || null,
      leaseUntil: c.leaseUntil || null, updatedAt: c.updatedAt || null,
      branch: c.branch || null, stale: claimIsStale(c),
    });
  }
  rows.sort((a, b) => Number(b.stale) - Number(a.stale));
  process.stdout.write(JSON.stringify({
    now: new Date().toISOString(),
    inflight: rows,
    staleCount: rows.filter((r) => r.stale).length,
  }, null, 2) + '\n');
}

const o = parseArgs(process.argv.slice(2));
// Hard publish-only gate (2026-06-17): in GG_AUTOPILOT_MODE=publish-only the driver REFUSES to
// author or select an unauthored task, even if --author/--next-unauthored is passed — defense in
// depth beyond the tick wrapper. Clean exit 0 with no stdout so callers treat it as "no task".
if (process.env.GG_AUTOPILOT_MODE === 'publish-only' && (o.author || o.nextUnauthored)) {
  process.stderr.write('gg-seo-autopilot: publish-only mode — refusing to author / select unauthored task\n');
  process.exit(0);
}
try {
  if (o.status) doStatus();
  else if (o.staleReport) doStaleReport();
  else if (o.nextUnauthored) doNextUnauthored();
  else if (o.author) await doAuthor(o);
  else if (o.merge) await doMerge(o); // async 尾巴 = published 事件通知（ESM 顶层 await）
  else if (o.markVerified) doMarkVerified(o);
  else if (o.markFailed) await doMarkFailed(o);
  else if (o.retryFailed) doRetryFailed(o);
  else if (o.retryAuthor) doRetryAuthor(o);
  else if (o.prepareRegate) doPrepareRegate(o);
  else if (o.reconcilePublished) await doReconcilePublished(o);
  else if (o.autoRetryParks) await doAutoRetryParks(); // async 尾巴 = 升级通知（ESM 顶层 await）
  else doScan(o);
} catch (e) {
  die(e.message || String(e), 1);
}
