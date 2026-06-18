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
// Conversion recipe (validated Phase 0):
//   EN: gg-md-to-oracle-ts --source _staging/<PID>-en.md      --slug S --out ART/S.ts
//   ZH: gg-md-to-oracle-ts --source _staging/zh-demo/<PID>-zh.md --slug S --out ART/S.zh.ts --language zh
//       (ZH out MUST differ from EN .ts so mergeSibling appends Zh into S.ts)
//   then gg-oracle-register-index --slug S --lang en|zh
//
// Usage:
//   node gg-seo-autopilot.mjs [--scan] [--dry-run] [--limit 1]
//   node gg-seo-autopilot.mjs --mark-verified --branch seo/auto/<date>-<PID> --preview-url https://...
//   node gg-seo-autopilot.mjs --mark-failed --branch seo/auto/<date>-<PID> --reason "..."
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

import { execFileSync } from 'node:child_process';
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
import { buildAuthorMap, resolveAuthor, isValidAuthorId, normalizeAuthorId } from './lib/author-routing.mjs';
import { detectProtectedFactDrift, summarizeProtectedFactDrift } from './lib/review-fact-guard.mjs';
import { slugifyPageId } from './gg-sheet-pull.mjs';
import { illustrate } from './lib/illustrate.mjs';

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
const RENDER = join(SCRIPTS, 'gg-render-batch.mjs');
const ORCHESTRATOR = join(SCRIPTS, 'gg-llm-orchestrator.mjs');
// multi-party review: Codex (gpt-5.5 xhigh) critiques → Opus 4.8 revises.
const REVIEW = join(SCRIPTS, 'gg-author-review.mjs');
const LARK_NOTIFY = join(SCRIPTS, 'gg-lark-notify.sh'); // Feishu push (best-effort)
const PHASE2 = join(SCRIPTS, '_phase2-validate.mjs');
const CONFIG_SNAPSHOT = join(FLOW, '.gg-cache', 'config-snapshot.json');
const PLAN_GLOB_DIR = join(OPS, 'inbox', '06-tasks', 'tasks');
const CLAIMS_PATH = join(PLAN_GLOB_DIR, '.autopilot-claims.json');
const CLAIMS_LOCK = `${CLAIMS_PATH}.lock`;
const CLAIMS_LOCK_TIMEOUT_MS = parseInt(process.env.GG_AUTOPILOT_LOCK_TIMEOUT_MS || '30000', 10);
const CLAIMS_LOCK_STALE_MS = parseInt(process.env.GG_AUTOPILOT_LOCK_STALE_MS || String(2 * 60 * 60 * 1000), 10);
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

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
    else if (a === '--status') o.status = true;
    else if (a === '--stale-report') o.staleReport = true;
    else if (a === '--branch') o.branch = argv[++i];
    else if (a === '--preview-url') o.previewUrl = argv[++i];
    else if (a === '--evidence') o.evidence = argv[++i];
    else if (a === '--reason') o.reason = argv[++i];
    else if (a === '--limit') o.limit = parseInt(argv[++i], 10) || 1;
    else if (a === '--task') o.task = argv[++i];
  }
  if (!o.scan && !o.author && !o.nextUnauthored && !o.merge && !o.markVerified && !o.markFailed && !o.status && !o.staleReport) o.scan = true;
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
    const m = line.match(/^\s*-\s*\[( |x)\]\s*`?(PG-[A-Z]+-\d+)`?\s*(.*)$/);
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
const CLAIM_LEASE_MS = parseInt(process.env.GG_AUTOPILOT_CLAIM_LEASE_MS || String(30 * 60 * 1000), 10);
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
    if (!claim?.branch || claim.status === 'done') continue;
    const pr = ghPrMeta(claim.branch);
    if (!pr || pr.state !== 'MERGED') continue;
    claims[pgId] = {
      ...claim,
      status: 'done',
      pr: claim.pr || pr.url,
      mergedAt: claim.mergedAt || pr.mergedAt || new Date().toISOString(),
      reconciliationNote: claim.reconciliationNote || 'auto-reconciled from merged GitHub PR',
    };
    changed = true;
  }
  return changed;
}

// ── per-task helpers ────────────────────────────────────────────────────────
function enDraft(pgId) { return join(STAGING, `${pgId}-en.md`); }
function zhDraft(pgId) { return join(STAGING, 'zh-demo', `${pgId}-zh.md`); }
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
// this script's own keyword fallback): lowercase, non-alphanumeric runs collapse to a
// single hyphen, trim leading/trailing hyphens.
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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

function zhBackfillCandidate(task, claims) {
  const claim = claims[task.pgId] || {};
  return Boolean(
    task.checked &&
    claim.status === 'done' &&
    claim.slug &&
    claim.zh !== true &&
    existsSync(enDraft(task.pgId)) &&
    phase2Passed(task.pgId) &&
    existsSync(zhDraft(task.pgId)),
  );
}

// A task is claimable for downstream publish iff drafts exist + pass + not done.
function claimable(task, claims) {
  const zhBackfill = zhBackfillCandidate(task, claims);
  if (task.checked && !zhBackfill) return { ok: false, reason: 'already checked in plan' };
  const st = claimStatus(claims, task.pgId);
  if (['active', 'pushed-preview', 'verified-preview', 'needs_human'].includes(st)) {
    return { ok: false, reason: `claim=${st}` };
  }
  if (st === 'done' && !zhBackfill) return { ok: false, reason: 'claim=done' };
  if (!existsSync(enDraft(task.pgId))) return { ok: false, reason: 'no EN enriched draft (upstream not done)' };
  if (!phase2Passed(task.pgId)) return { ok: false, reason: 'phase2 not pass' };
  const slug = (zhBackfill ? (claims[task.pgId] || {}).slug : null) || frontmatterSlug(enDraft(task.pgId));
  if (!slug) return { ok: false, reason: 'EN draft missing frontmatter slug' };
  if (!SLUG_RE.test(slug)) return { ok: false, reason: `invalid slug "${slug}" (needs source fix)` };
  if (st !== 'needs_human' && !zhBackfill) {
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
// (bilingual) and `ARTICLE_SLUGS_EN_ONLY` (EN-only) — to decide which articles
// get crawler-visible static HTML + a sitemap entry. Discovery is NOT automatic:
// an article merged into data/articles/ without this stays a client-only SPA
// route, so crawlers get the empty shell and it never enters the sitemap → never
// indexed. Insert the slug into the right array so `npm run build`
// (→ generate-seo-pages) + the Vercel prod deploy emit its static page + sitemap
// URL. Idempotent; non-fatal if the script/array layout changes.
function registerSeoSlug(repo, slug, zh) {
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
  const removeFrom = (arr) => {
    src = src.replace(new RegExp(`^\\s*['"]${slug}['"],\\n`, 'm'), '');
  };

  if (zh) {
    if (hasIn('ARTICLE_SLUGS')) return;
    const wasEnOnly = hasIn('ARTICLE_SLUGS_EN_ONLY');
    if (wasEnOnly) removeFrom('ARTICLE_SLUGS_EN_ONLY');
    if (!insertInto('ARTICLE_SLUGS')) return;
    writeFileSync(f, src);
    log(`${wasEnOnly ? 'promoted' : 'registered'} ${slug} → ARTICLE_SLUGS (static SEO page + sitemap)`);
    return;
  }

  if (hasIn('ARTICLE_SLUGS') || hasIn('ARTICLE_SLUGS_EN_ONLY')) return;
  if (!insertInto('ARTICLE_SLUGS_EN_ONLY')) return;
  writeFileSync(f, src);
  log(`registered ${slug} → ARTICLE_SLUGS_EN_ONLY (static SEO page + sitemap)`);
}

function convert(repo, pgId, slug) {
  const art = articlesDir(repo);
  sh('node', [CONV, '--source', enDraft(pgId), '--slug', slug, '--out', join(art, `${slug}.ts`)]);
  sh('node', [REG, '--oracle-articles-dir', art, '--slug', slug, '--lang', 'en']);
  let zh = false;
  if (existsSync(zhDraft(pgId))) {
    sh('node', [CONV, '--source', zhDraft(pgId), '--slug', slug, '--out', join(art, `${slug}.zh.ts`), '--language', 'zh']);
    sh('node', [REG, '--oracle-articles-dir', art, '--slug', slug, '--lang', 'zh']);
    zh = true;
  }
  registerSeoSlug(repo, slug, zh);
  return { zh };
}

function buildGate(repo) {
  try { sh('npm', ['run', 'build'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }); return { ok: true }; }
  catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    const m = out.match(/SEO (?:generation|build)[^\n]*|error[^\n]*/i);
    return { ok: false, error: (m && m[0]) || out.slice(-400) };
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

// Checked plan items that are already published in EN (claim=done) but still lack
// the upstream ZH source draft. These are NOT scan-claimable yet — scan only knows
// how to publish a zh backfill once _staging/zh-demo/<PG>-zh.md exists — so --author
// needs a second lane that manufactures that missing source.
function needsZhSourceBackfill(task, claims) {
  const claim = claims[task.pgId] || {};
  return Boolean(
    task.checked &&
    claim.status === 'done' &&
    claim.zh !== true &&
    existsSync(enDraft(task.pgId)) &&
    phase2Passed(task.pgId) &&
    !existsSync(zhDraft(task.pgId)),
  );
}

function nextZhSourceBackfill(tasks, claims) {
  for (const t of tasks) {
    if (needsZhSourceBackfill(t, claims)) return t;
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

function parkAuthor(pgId, slug, plan, reason) {
  withClaimsLock(() => {
    const claims = loadClaims();
    claims[pgId] = {
      ...(claims[pgId] || {}),
      status: 'needs_human', slug: slug || claims[pgId]?.slug, owner: 'autopilot',
      stage: 'authoring', plan, error: `authoring: ${reason}`, failedAt: new Date().toISOString(),
    };
    saveClaims(claims);
  });
  log(`PARK(author) ${pgId}: ${reason}`);
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

// Agentic-rescue prompt: hand `claude -p` the failed draft + the exact phase2
// failures and have it SURGICALLY repair (never rewrite) + self-check via phase2
// until it passes. Validated on NAKSH-001 (rigid blind-regen: 8 parks; agentic: 1
// iteration → PASS) — works because it can READ "section X lacks the keyword" and
// edit that section, which blind regeneration can't.
function agenticRescuePrompt(pgId, keyword, author, draftRel, fails) {
  return [
    `你在修复一篇 SEO 文章草稿（结构已生成，但卡在自动 QA 的若干条）。只做外科式（surgical）修正，绝不整篇重写。`,
    `本次是自动化修复子任务：忽略仓库 CLAUDE.md 的对话记录/会话提醒维护规则，只做下面的修复，不要碰其它文件。`,
    ``,
    `文件（相对仓库根 ${FLOW}）：${draftRel}`,
    `target_keyword 字面短语 = "${keyword}"`,
    ``,
    `phase2 QA 卡在以下条目（逐条修掉）：`,
    fails,
    ``,
    `对症修法：`,
    `- RL4 漂移 / drifted sections（某 H2 节 target-recall=0）→ 在被点名的每个小节里，把某处代词/"this system"/泛指自然替换成字面 "${keyword}"，每节至少 1 次，自然不堆砌。`,
    `- RL5 stuffing（count 超限）→ 多余的完整短语用代词/短形/同义替换，降到限内。`,
    `- 缺免责声明（RL6/psych-safety）→ 结尾逐字加：This is not a clinical interpretation or mental health advice.`,
    `- RL1 临床主张 → 改象征/反思措辞。`,
    `- SC3c 段落散乱 → 该小节合并成 1-2 连贯段，或 "1. **标签。** 说明" 编号列表。`,
    `- 其它条目按 phase2 提示对症修。`,
    ``,
    `硬约束：H2 标题逐字不动、同序同数；总词数尽量 1500-1800；保留免责声明 + CTA + Sources；不新增 [[...]] 链接数。`,
    ``,
    `流程（最多 3 次迭代）：1) Read 草稿 2) Edit 外科修正 3) 自检运行 \`node tools/scripts/_phase2-validate.mjs --source ${draftRel} --page-id ${pgId} --tag en --author ${author} 2>&1 | tail -30\` 读输出 4) 仍 fail 就再修 5) PASS 或 3 次后停。`,
    ``,
    `只输出一行：最终 phase2 是否 PASS。不要发布、不要 git。`,
  ].join('\n');
}

function doAuthor(o = {}) {
  let sel;
  const claims = loadClaims();
  if (o.task) {
    const plan = latestPlan();
    if (!plan) { log('no blog-output-plan found'); return; }
    const t = parseTasks(plan).find((x) => x.pgId === o.task);
    if (!t) { log(`--task ${o.task} not found in plan`); return; }
    const zhBackfill = needsZhSourceBackfill(t, claims);
    if (claimStatus(claims, t.pgId) && !zhBackfill) { log(`--task ${o.task} already has a claim (clear it first)`); return; }
    sel = { plan, task: t, mode: zhBackfill ? 'zh-backfill' : 'en-author' };
  } else {
    const plan = latestPlan();
    if (!plan) { log('no blog-output-plan found'); return; }
    const tasks = parseTasks(plan);
    const task = nextUnauthored(tasks, claims) || nextZhSourceBackfill(tasks, claims);
    sel = task
      ? { plan, task, mode: needsZhSourceBackfill(task, claims) ? 'zh-backfill' : 'en-author' }
      : null;
  }
  if (!sel || !sel.task) { log('nothing to author this run'); return; }
  const { task: t } = sel;
  const pgId = t.pgId;
  const modeZhBackfill = sel.mode === 'zh-backfill';
  const planName = basename(sel.plan);
  log(`${modeZhBackfill ? 'zh-backfill candidate' : 'author candidate'} ${pgId} (${t.keyword || ''})`);
  const park = (slug, reason) => parkAuthor(pgId, slug, planName, reason);

  try {
    const enSourcePath = enDraft(pgId);
    const enMeta = existsSync(enSourcePath) ? readMdFrontmatter(enSourcePath) : { attrs: {}, body: '' };

    if (modeZhBackfill) {
      const fm = enMeta.attrs || {};
      const slug = ((claims[pgId] || {}).slug || fm.slug || (t.keyword || pgId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')).trim();
      const keyword = String(fm.target_keyword || t.keyword || '').trim();
      const cleanEntity = String(fm.entity || keyword || t.keyword || '')
        .replace(/^\s*(what\s+(is|are|to\s+do\s+(on|with|during|after))|how\s+(to|do(es)?)|why\s+(is|are|do(es)?)|when\s+(is|are|to|do(es)?))\s+(a|an|the)?\s*/i, '')
        .replace(/[?？]+\s*$/, '').trim() || keyword;
      const author = String(fm.author_id || fm.author || '').trim();
      const associatedKeywords = Array.isArray(fm.associated_keywords) ? fm.associated_keywords.filter(Boolean) : [];
      const template = String(fm.template || 'Definition').trim() || 'Definition';
      const tier = String(fm.tier || 'T2').trim() || 'T2';
      const track = String(fm.track || '量产线').trim() || '量产线';
      const zhKeyword = String(fm.target_keyword_zh || '').trim();
      const enBody = String(enMeta.body || '').trim();
      if (!author) return park(slug, 'EN draft missing author_id for zh backfill');
      if (!keyword) return park(slug, 'EN draft missing target_keyword for zh backfill');
      if (!enBody) return park(slug, 'EN draft body empty — cannot synthesize zh backfill prompt');

      mkdirSync(join(FLOW, '.gg-cache', 'prompts'), { recursive: true });
      const promptPath = join('.gg-cache', 'prompts', `${pgId}.v8.zh-prompt.md`);
      const promptAbs = join(FLOW, promptPath);
      const promptBase = `# Role\n你是 AstrologyWiki 的中文内容编辑。你的任务不是逐句翻译，而是基于一篇已经通过英文 Phase 2 的成稿，产出一篇可直接进入中文 Phase 2 的简体中文版本。\n\n# Hard requirements\n- 输出纯 Markdown 正文，不要 YAML frontmatter，不要解释过程。\n- 不要沿用英文 H2 文案；必须把英文语义改写进中文 Phase 2 认可的 11 个 H2 骨架。\n- H1 必须是自然中文标题；正文与 H2 全部用简体中文。\n- 第一部分必须用 \`## <你选定的中文主词> 是什么？\` 开头；首段里要有 1 个**加粗定义短语**，随后**紧跟正好 3 个 bullet**。\n- 第二部分 H2 必须逐字写成 \`## 为什么了解它能帮助自我觉察\`。\n- 第三部分 H2 必须写成 \`## <你选定的中文主词> 与相近概念：运作方式 + 取舍\`，每个对比都要写出明确取舍。\n- 第四部分必须用“识别”而不是“阅读/判断”作 H2 动词：星盘/宫位/行运类主题用 \`## 如何在你的星盘里识别 <你选定的中文主词>\`；其他主题用 \`## 如何在自己身上识别 <你选定的中文主词>\`。\n- 第五到第十一部分依次必须覆盖：常见误读、速查表/一览、常见问题/问答、自我觉察小提示、延伸阅读、下一步行动、参考来源。\n- \`## 自我觉察小提示\` 标题后第一行必须直接开始 \`1.\` / \`2.\` / \`3.\` 三条编号提示，不能先写引导段。\n- 至少放入 5 条 \`[[<TBD-internal-link: ...>]]\` 中文内链占位符；不要输出 0 条内链。\n- 主中文关键词全篇总出现次数控制在 5-8 次之间；不要在每个 H2 都机械重复，能用“它 / 这个主题 / 这张盘 / 该相位”等代词时就改写。\n- \`参考来源\` 里出现的权威名，正文里必须先具名提到；不要在 Sources 里新增正文没出现过的人名或条目。\n- 保留反思性 / 象征性语气，禁止诊断、治疗、治愈、改善病症等医疗承诺。\n- 明确避开广告/承诺词：不要写 承诺 / 保证 / 立刻见效 / 改命 / 改运 / 疗愈创伤 / 修复焦虑 这类表述。\n- 结尾必须保留免责声明，用中文表达“这不是临床解读或心理健康建议”。\n- 将 CTA 改写为中文，并指向 https://astrologywiki.com/zh/wiki/how-to-read-birth-chart 。\n- 如原文出现 astrologywiki.com/en/ 内链或 CTA，请改成 /zh/ 对应路径；拿不准时只保留 CTA 这一个确定链接。\n- 不要照搬英文句子；允许为中文读者做自然重写，但核心含义必须忠于英文稿。\n- 不要输出 TODO、占位符、方括号备注或英文审校说明。\n${zhKeyword ? `- 主中文关键词固定使用：${zhKeyword} 。H1 与至少多数主体段落自然回扣它，避免换成别的说法导致锚点漂移。\n` : '- 自行选择一个自然的中文主关键词，并在 H1 与正文主体里稳定复用，避免同义改写过度导致锚点漂移。\n'}\n# Metadata\n- page_id: ${pgId}\n- slug: ${slug}\n- author_id: ${author}\n- target_keyword_en: ${keyword}\n- entity: ${cleanEntity || keyword}\n- template: ${template}\n- tier: ${tier}\n- track: ${track}\n- associated_keywords_en: ${(associatedKeywords.length ? associatedKeywords.join(', ') : '(none)')}\n\n# Source English article (semantic source of truth, not heading template)\n\n${enBody}\n`;
      writeFileSync(promptAbs, promptBase);

      const defaultDraftV8 = join('_staging', 'zh-demo', `${pgId}-${WINNER}-v8.md`);
      const orchestratorMeta = join('_staging', 'zh-demo', `${pgId}-orchestrator.json`);
      const zhModels = process.env.GG_ZH_BACKFILL_MODELS || process.env.GG_AUTHOR_MODELS || (WINNER === 'claude' ? 'claude,codex,gemini' : WINNER);
      const attempts = Math.max(1, parseInt(process.env.GG_AUTHOR_GEN_ATTEMPTS || '3', 10));
      let lastFail = '';
      for (let i = 1; i <= attempts; i++) {
        if (lastFail && i > 1) {
          writeFileSync(promptAbs, `${promptBase}\n\n## ⚠️ 上一稿被自动校验拦下 — 本稿必须逐条修掉\n${lastFail}\n\n补救要求：\n- 保持中文，不要回退英文标题或英文小节。\n- RL4 漂移 → 在被点名小节自然补回主中文关键词；不要只在开头堆一次。\n- RL5 堆词 → 重复过密处改成代词 / 短称 / 解释句，但别把主关键词完全丢掉。\n- RL6 / 合规 → 改成象征、反思、传统关联，不要承诺疗效或心理治疗作用。\n- 结构 FAIL → 以英文稿结构为准，小修，不整篇推倒重写。\n`);
        }
        const orchTimeout = parseInt(process.env.GG_AUTHOR_ORCH_TIMEOUT_MS || '1800000', 10);
        try { shFlow('node', [ORCHESTRATOR, '--prompt', promptPath, '--page-id', pgId, '--models', zhModels, '--out-dir', '_staging/zh-demo', '--retry', '0'], orchTimeout); }
        catch (e) { log(`zh orchestrator exit non-zero (attempt ${i}): ${errTail(e, 80)}`); }
        let draftV8 = defaultDraftV8;
        if (!existsSync(join(FLOW, draftV8)) && existsSync(join(FLOW, orchestratorMeta))) {
          try {
            const meta = JSON.parse(readFileSync(join(FLOW, orchestratorMeta), 'utf8'));
            const okEntry = Object.values(meta.results || {}).find((r) => r && r.ok && r.output_path);
            if (okEntry && okEntry.output_path) draftV8 = relative(FLOW, okEntry.output_path);
          } catch { /* best-effort */ }
        }
        if (!existsSync(join(FLOW, draftV8))) { lastFail = `- orchestrator produced no zh draft (models=${zhModels})`; continue; }
        const phase2Args = ['node', [PHASE2, '--source', draftV8, '--page-id', pgId, '--tag', 'zh', '--language', 'zh', '--author', author, '--entity', cleanEntity || keyword, '--target-keyword', keyword, '--template', template, '--tier', tier, '--track', track, '--prompt-version', VERSION]];
        if (associatedKeywords.length) phase2Args[1].push('--associated-keywords', associatedKeywords.join(', '));
        if (zhKeyword) phase2Args[1].push('--zh-keyword', zhKeyword);
        try { shFlow(phase2Args[0], phase2Args[1]); }
        catch (e) {
          const out = `${e.stdout || ''}${e.stderr || ''}`;
          const fails = [...out.matchAll(/✗\s*(?:FAIL\s*)?([^\n]+)/g)].map((m) => `- ${m[1].trim()}`).filter((s) => s.length > 6).slice(0, 8);
          lastFail = fails.length ? fails.join('\n') : '- zh phase2 FAIL (no detail captured)';
          log(`zh phase2 attempt ${i}/${attempts} failed:\n${lastFail}${i < attempts ? '\n  → regenerating WITH feedback' : ''}`);
          continue;
        }
        if (existsSync(zhDraft(pgId))) {
          log(`AUTHORED ZH ${pgId} → ${zhDraft(pgId)} (author=${author}, attempt ${i}/${attempts}) — ready for next scan to publish bilingual backfill`);
          return;
        }
        lastFail = '- zh phase2 wrote no passing draft';
      }
      return park(slug, `${(lastFail || 'zh phase2 failed').replace(/\n/g, ' | ')} after ${attempts} zh attempt(s)`);
    }

    // 1. locate the Sheet row
    let loc;
    try { loc = findSheetRow(pgId, t.keyword); }
    catch (e) { return park(null, `sheet-pull failed: ${errTail(e)}`); }
    if (!loc) return park(null, `no row for ${pgId} ("${t.keyword || ''}") in 选题登记表`);
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
      slug = (keyword || pgId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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

    // The Sheet `entity` column is sometimes a phrase-salad of angles
    // ("intentional energy work · lunar phase timing · …") instead of the entity
    // name; rendered verbatim it produces garbage H2s like "## What is intentional
    // energy work · …?". When it looks like a list (·-separated / 3+ comma items),
    // swap in the clean topic noun so headings read naturally.
    const messyEntity = /·/.test(entry.entity || '') || ((entry.entity || '').split(',').length >= 3);
    if (messyEntity && cleanEntity) entry.entity = cleanEntity;

    // CTA normalization by lane:
    // - EN authoring keeps the prior English fallback.
    // - ZH backfill needs a native Chinese CTA; otherwise the generated Chinese draft
    //   inherits an English CTA block, which is jarring and weakens the whole point
    //   of the bilingual backfill.
    if (/[㐀-鿿]/.test(entry.cta_text || '') || !(entry.cta_text || '').trim()) {
      if (!/^https?:\/\//.test(entry.cta_target_url || '')) {
        entry.cta_target_url = modeZhBackfill
          ? 'https://astrologywiki.com/zh/wiki/how-to-read-birth-chart'
          : 'https://astrologywiki.com/en/wiki/how-to-read-birth-chart';
      }
      entry.cta_text = modeZhBackfill
        ? `免费生成你的本命盘，继续了解${cleanEntity}。`
        : `Generate your free birth chart to explore ${cleanEntity}.`;
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

    // 6. render → v8 prompt + fixture (render WARNs on missing SERP cache; gate on file)
    const renderArgs = ['node', [RENDER, '--batch', batchPath, '--overrides', overridePath]];
    if (modeZhBackfill) renderArgs[1].push('--language', 'zh');
    try { shFlow(renderArgs[0], renderArgs[1]); }
    catch (e) { log(`render exit non-zero: ${errTail(e, 80)}`); }
    const promptPath = join('.gg-cache', 'prompts', `${pgId}.v8${modeZhBackfill ? '.zh' : ''}-prompt.md`);
    if (!existsSync(join(FLOW, promptPath))) return park(slug, `render produced no ${modeZhBackfill ? 'ZH ' : ''}v8 prompt`);

    if (modeZhBackfill) {
      const defaultDraftV8 = join('_staging', 'zh-demo', `${pgId}-${WINNER}-v8.md`);
      const orchestratorMeta = join('_staging', 'zh-demo', `${pgId}-orchestrator.json`);
      const promptAbs = join(FLOW, promptPath);
      const basePrompt = readFileSync(promptAbs, 'utf8');
      const restorePrompt = () => { try { writeFileSync(promptAbs, basePrompt); } catch { /* best-effort */ } };
      const attemptsRaw = Number.parseInt(process.env.GG_AUTHOR_GEN_ATTEMPTS || '3', 10);
      const attempts = Number.isFinite(attemptsRaw) && attemptsRaw > 0 ? attemptsRaw : 3;
      const zhModels = process.env.GG_ZH_BACKFILL_MODELS || process.env.GG_AUTHOR_MODELS || (WINNER === 'claude' ? 'claude,codex,gemini' : WINNER);
      let lastFail = '';
      for (let i = 1; i <= attempts; i++) {
        if (lastFail && i > 1) {
          writeFileSync(promptAbs, `${basePrompt}\n\n## ⚠️ 上一稿被自动校验拦下 — 本稿必须逐条修掉\n${lastFail}\n\n补救要求：\n- 这是中文稿，保留中文 H2 与正文，不要退回英文。\n- RL4 漂移 → 被点名的小节里自然补回主中文关键词或对应主题短语。\n- RL5 堆词 → 过密处改成代词 / 近义表达，别机械重复。\n- RL6 / 合规 → 保留反思性、非疗效、非诊断措辞；不要写治疗、改善病症、调理体质。\n- 结构类 FAIL → 只做外科式修正，不整篇重写。\n`);
        }
        const orchTimeout = parseInt(process.env.GG_AUTHOR_ORCH_TIMEOUT_MS || '1800000', 10);
        try { shFlow('node', [ORCHESTRATOR, '--prompt', promptPath, '--page-id', pgId, '--models', zhModels, '--out-dir', '_staging/zh-demo', '--retry', '0'], orchTimeout); }
        catch (e) { log(`zh orchestrator exit non-zero (attempt ${i}): ${errTail(e, 80)}`); }
        let draftV8 = defaultDraftV8;
        if (!existsSync(join(FLOW, draftV8)) && existsSync(join(FLOW, orchestratorMeta))) {
          try {
            const meta = JSON.parse(readFileSync(join(FLOW, orchestratorMeta), 'utf8'));
            const okEntry = Object.values(meta.results || {}).find((r) => r && r.ok && r.output_path);
            if (okEntry && okEntry.output_path) draftV8 = relative(FLOW, okEntry.output_path);
          } catch { /* best-effort */ }
        }
        if (!existsSync(join(FLOW, draftV8))) { lastFail = `- orchestrator produced no zh draft (models=${zhModels})`; continue; }
        try { shFlow('node', [PHASE2, '--source', draftV8, '--page-id', pgId, '--tag', 'zh', '--language', 'zh', '--author', author]); }
        catch (e) {
          const out = `${e.stdout || ''}${e.stderr || ''}`;
          const fails = [...out.matchAll(/✗\s*(?:FAIL\s*)?([^\n]+)/g)].map((m) => `- ${m[1].trim()}`).filter((s) => s.length > 6).slice(0, 8);
          lastFail = fails.length ? fails.join('\n') : '- zh phase2 FAIL (no detail captured)';
          log(`zh phase2 attempt ${i}/${attempts} failed:\n${lastFail}${i < attempts ? '\n  → regenerating WITH feedback' : ''}`);
          continue;
        }
        if (existsSync(zhDraft(pgId))) {
          restorePrompt();
          log(`AUTHORED ZH ${pgId} → ${zhDraft(pgId)} (author=${author}, attempt ${i}/${attempts}) — ready for next scan to publish bilingual backfill`);
          return;
        }
        lastFail = '- zh phase2 wrote no passing draft';
      }
      restorePrompt();
      return park(slug, `${(lastFail || 'zh phase2 failed').replace(/\n/g, ' | ')} after ${attempts} zh attempt(s)`);
    }

    // 7+8. Generate (Opus) → validate (phase2 v4.4/v4.5.1), retrying on failure.
    //   phase2 trips on generation variance — esp. SC3c "section scatter" (≤3 prose
    //   paragraphs per H2 section), the same check PG-SOLAR-001 failed on its first
    //   generation — so regenerate up to GG_AUTHOR_GEN_ATTEMPTS times (different
    //   sampling) before parking. orchestrator overwrites the draft each attempt;
    //   phase2 writes _staging/<pid>-en.md + manifest ONLY on PASS (exit 11 on fail).
    const draftV8 = join('_staging', `${pgId}-${WINNER}-v8.md`);
    const promptAbs = join(FLOW, promptPath);
    const basePrompt = readFileSync(promptAbs, 'utf8');
    const restorePrompt = () => { try { writeFileSync(promptAbs, basePrompt); } catch { /* best-effort */ } };
    // Default 3 (was 5): each Sonnet 4.6 gen is ~10-15 min, so 5 attempts on a
    // failing task burns ~65 min before parking. Historically tasks that pass do so
    // by attempt ≤3 (HEAL-004, NAKSH-005); attempts 4-5 almost never rescue a parker
    // — so 3 cuts ~24 min of waste off each hard/parking task at negligible loss.
    // Override via GG_AUTHOR_GEN_ATTEMPTS.
    const attempts = Math.max(1, parseInt(process.env.GG_AUTHOR_GEN_ATTEMPTS || '3', 10));
    let lastFail = '';
    for (let i = 1; i <= attempts; i++) {
      // FEEDBACK-DRIVEN retry: hard topics (Vedic/nakshatra/healing) hit a DIFFERENT
      // phase2 check each blind attempt (RL1 clinical, RL5 keyword-stuffing, SC
      // scatter…), so plain regeneration rarely converges. Feed the previous
      // attempt's EXACT failures back into the prompt so the model fixes those.
      if (lastFail && i > 1) {
        writeFileSync(promptAbs, `${basePrompt}\n\n## ⚠️ 上一稿被自动校验拦下 — 本稿必须修掉以下每一条（否则整篇作废）\n${lastFail}\n\n继续遵守上面所有硬规则，同时**对照下表逐条修正**（命中哪条改哪条）：\n- 临床/医疗主张（RL1：heal/treat/cure/diagnose + 焦虑/抑郁/创伤/疾病/疼痛/失眠等病症名）→ 改成象征/反思措辞（"a reflective lens for" / "some people explore this theme" / "is traditionally associated with"）。\n- target_keyword 堆词（RL5：count 超 8）→ 完整短语全文**只出现 5–8 次**，多余的用代词/短形/同义改写替换。\n- drifted sections（RL4）→ 在被点名的**每个** H2 小节里，让 target_keyword 完整短语自然出现至少 1 次（实质回扣主题，别泛泛）。\n- 缺免责声明（RL6 / disclaimer，psych-safety 主题必需）→ 在正文结尾**逐字加入这一行**：This is not a clinical interpretation or mental health advice.\n- section scatter（SC3c）→ 被空行散成多段的小节改成「引子句 + 编号列表（\`1. **标签。** 说明\`）」。\n- link distribution（SC4）→ 至少 1 条内链自然内联织进正文前段句子里（首链优先），别全堆结尾。\n`);
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
      if (!existsSync(join(FLOW, draftV8))) { lastFail = '- orchestrator produced no draft'; continue; }
      try { shFlow('node', [PHASE2, '--source', draftV8, '--page-id', pgId, '--tag', 'en', '--author', author]); }
      catch (e) {
        const out = `${e.stdout || ''}${e.stderr || ''}`;
        const fails = [...out.matchAll(/✗\s*(?:FAIL\s*)?([^\n]+)/g)].map((m) => `- ${m[1].trim()}`).filter((s) => s.length > 6).slice(0, 8);
        lastFail = fails.length ? fails.join('\n') : '- phase2 FAIL (no detail captured)';
        log(`phase2 attempt ${i}/${attempts} failed:\n${lastFail}${i < attempts ? '\n  → regenerating WITH feedback' : ''}`);
        continue;
      }
      if (existsSync(enDraft(pgId)) && phase2Passed(pgId)) {
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
      lastFail = '- phase2 wrote no passing manifest';
    }
    restorePrompt();

    // AGENTIC RESCUE (user-approved 2026-06-05): the deterministic feedback loop just
    // failed `attempts`× — usually on gen-quality issues blind regeneration can't fix
    // (e.g. RL4 drift: the model won't anchor the literal keyword in every section).
    // Escalate ONCE to an agentic `claude -p` that reads the failure + draft and
    // SURGICALLY repairs it, self-checking via phase2 until it passes. Only fires on
    // the park boundary, so it never slows the common (≤3-attempt) path. The shFlow
    // timeout bounds it; phase2-on-PASS writes <pid>-en.md, which is our success test.
    // Toggle GG_AUTHOR_AGENTIC_RESCUE=0.
    if (process.env.GG_AUTHOR_AGENTIC_RESCUE !== '0' && existsSync(join(FLOW, draftV8))) {
      log(`agentic rescue: deterministic loop failed ${attempts}× — escalating to agentic surgical repair of ${draftV8}`);
      const agModel = process.env.GG_AGENTIC_MODEL || 'claude-sonnet-4-6';
      const agEffort = process.env.GG_AGENTIC_EFFORT || 'high';
      const agTimeout = parseInt(process.env.GG_AUTHOR_AGENTIC_TIMEOUT_MS || '1800000', 10);
      const prompt = agenticRescuePrompt(pgId, keyword, author, draftV8, lastFail || '- phase2 failed');
      try {
        const out = shFlow('claude', ['-p', prompt, '--model', agModel, '--effort', agEffort,
          '--allowedTools', 'Bash Read Edit Write Grep', '--dangerously-skip-permissions'], agTimeout);
        log(`agentic rescue out: ${String(out).trim().split('\n').slice(-2).join(' ').slice(0, 180)}`);
      } catch (e) { log(`agentic rescue errored: ${errTail(e, 80)}`); }
      if (existsSync(enDraft(pgId)) && phase2Passed(pgId)) {
        log(`AUTHORED ${pgId} → ${enDraft(pgId)} (author=${author}, via AGENTIC RESCUE) — ready for next scan to publish`);
        return;
      }
      log('agentic rescue did not yield a passing draft — parking');
    }

    return park(slug, `${(lastFail || 'phase2 failed').replace(/\n/g, ' | ')} after ${attempts} attempt(s) + agentic rescue`);
  } catch (e) {
    park(null, `unexpected: ${errTail(e)}`);
  }
}

// ── main flows ──────────────────────────────────────────────────────────────
function doScan(o) {
  return withClaimsLock(() => doScanLocked(o));
}

function doScanLocked(o) {
  const plan = latestPlan();
  if (!plan) { log('no blog-output-plan found'); return; }
  log(`plan: ${basename(plan)}`);
  syncOracle(); // hard-sync BEFORE claimable() so the "already published" check is accurate
  const claims = loadClaims();
  const tasks = parseTasks(plan);

  const picked = [];
  for (const t of tasks) {
    if (picked.length >= o.limit) break;
    const c = claimable(t, claims);
    if (!c.ok) { log(`skip ${t.pgId}: ${c.reason}`); continue; }
    picked.push({ ...t, slug: c.slug });
  }
  if (!picked.length) { log('nothing claimable this run'); return; }

  for (const t of picked) {
    log(`claim ${t.pgId} → ${t.slug}`);
    claims[t.pgId] = { status: 'active', slug: t.slug, owner: 'autopilot', plan: basename(plan) };
    // Task 8: stamp stage + a renewable lease so a stuck/crashed publish is observable
    // via --stale-report (the last stamp's stage shows where a parked claim failed).
    const stamp = (stage) => { heartbeatClaim(claims, t.pgId, stage); saveClaims(claims); };
    stamp('claim');

    const branch = `seo/auto/${new Date().toISOString().slice(0, 10)}-${t.pgId}`;
    const worktreeBranch = o.dryRun ? `${branch}-dry-run-${process.pid}` : branch;
    let publishRepo;
    stamp('worktree');
    try {
      publishRepo = preparePublishWorktree(worktreeBranch);
      claims[t.pgId].worktree = publishRepo;
      claims[t.pgId].branch = branch;
      saveClaims(claims);
    } catch (e) {
      claims[t.pgId].status = 'needs_human';
      claims[t.pgId].error = `worktree: ${e.message}`;
      saveClaims(claims);
      log(`FAIL worktree ${t.pgId}`);
      continue;
    }

    let res;
    stamp('convert');
    try { res = convert(publishRepo, t.pgId, t.slug); }
    catch (e) { claims[t.pgId].status = 'needs_human'; claims[t.pgId].error = `convert: ${e.message}`; saveClaims(claims); log(`FAIL convert ${t.pgId}`); continue; }

    // author-known gate
    const known = registeredAuthorIds(publishRepo);
    const used = articleAuthorIds(publishRepo, t.slug);
    const missing = used.filter((a) => a && a !== 'undefined' && !known.has(a));
    if (missing.length) { claims[t.pgId].status = 'needs_human'; claims[t.pgId].error = `unregistered author(s): ${[...new Set(missing)].join(',')}`; saveClaims(claims); log(`PARK ${t.pgId}: ${claims[t.pgId].error}`); continue; }

    // illustration (best-effort enrichment, NEVER blocks the text publish).
    // Generates an atmospheric hero + 0-3 inline infographics into the worktree.
    // Any failure degrades to fewer/no images — the try/catch + illustrate()'s own
    // fail-safe guarantees a broken image step can't sink a publishable article.
    let ill = { hero: false, inline: 0, needsHero: false };
    try {
      ill = illustrate({ repo: publishRepo, slug: t.slug, flowDir: FLOW, log });
      log(`illustrate ${t.pgId}: hero=${ill.hero} inline=${ill.inline}${ill.needsHero ? ' needs_hero' : ''}${ill.qaWarn ? ' qa_warn' : ''}${ill.note ? ` (${ill.note})` : ''}`);
    } catch (e) { log(`illustrate ${t.pgId}: caught ${errTail(e, 80)} — publishing without images`); }
    if (ill.needsHero) claims[t.pgId].needs_hero = true;

    // build gate
    stamp('build-gate');
    const b = buildGate(publishRepo);
    if (!b.ok) { claims[t.pgId].status = 'needs_human'; claims[t.pgId].error = `build: ${b.error}`; saveClaims(claims); log(`PARK ${t.pgId}: build failed`); continue; }

    claims[t.pgId].zh = res.zh;
    if (o.dryRun) {
      claims[t.pgId].status = 'dry-run-ok';
      saveClaims(claims);
      cleanupWorktree(publishRepo);
      log(`DRY-RUN OK ${t.pgId} (${t.slug}${res.zh ? '+zh' : ' EN-only'}) build✓ — not pushed`);
    } else {
      stamp('push');
      const addPaths = ['data/articles'];
      if (existsSync(join(publishRepo, 'scripts', 'generate-seo-pages.mjs'))) addPaths.push('scripts/generate-seo-pages.mjs');
      // Commit the generated illustration assets (hero jpg + inline svgs) + the
      // per-article plan so the published article actually carries its images.
      if (ill.hero || ill.inline > 0) {
        if (existsSync(join(publishRepo, 'public', 'images', 'blog'))) addPaths.push('public/images/blog');
        if (existsSync(join(publishRepo, 'scripts', 'plans', `auto-${t.slug}.json`))) addPaths.push(`scripts/plans/auto-${t.slug}.json`);
      }
      gitIn(publishRepo, ['add', ...addPaths]);
      gitIn(publishRepo, ['commit', '-q', '-m', `feat(articles): publish ${t.slug} (${WINNER} ${VERSION}) [autopilot]`]);
      // --force: these seo/auto/<date>-<pgid> branches are disposable & autopilot-
      // owned; a re-publish (or a stale remote branch created off an older main
      // before other merges advanced it) otherwise rejects as non-fast-forward.
      gitIn(publishRepo, ['push', '-u', '--force', 'origin', branch]);
      // Open a PR so Vercel posts a Preview deployment + check; merge happens
      // in --merge AFTER codex + chrome verify pass (the human-equivalent gate).
      let prUrl = '';
      try {
        prUrl = sh('gh', ['pr', 'create', '--repo', 'xdawayer/oracle', '--base', 'main', '--head', branch,
          '--title', `[autopilot] publish ${t.slug}`,
          '--body', `Automated SEO publish of \`${t.pgId}\` → \`${t.slug}\`${res.zh ? ' (EN+ZH)' : ' (EN-only)'}.\n\nAwaiting codex review + chrome MCP verification on the Vercel preview before merge.`],
          { cwd: publishRepo }).trim();
      } catch (e) {
        // A re-publish of the same date+pgId branch hits "a pull request already
        // exists" — that's fine (we force-pushed the fixed content to it); reuse
        // the existing PR URL so the verify/diff/notify steps have a real number.
        if (/already exists/i.test(e.message || '')) {
          try { prUrl = sh('gh', ['pr', 'view', branch, '--repo', 'xdawayer/oracle', '--json', 'url', '--jq', '.url'], { cwd: publishRepo }).trim(); }
          catch { prUrl = ''; }
        }
        if (!prUrl) prUrl = `(pr-create-failed: ${e.message})`;
      }
      claims[t.pgId].status = 'pushed-preview';
      claims[t.pgId].pr = prUrl;
      stamp('pushed-preview');
      log(`PUSHED preview ${branch} PR=${prUrl} — awaiting codex+chrome verify, then --merge`);
    }
  }
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
    // Merge via gh so the PR closes cleanly; Vercel then deploys main → prod.
    sh('gh', ['pr', 'merge', o.branch, '--repo', 'xdawayer/oracle', '--merge', '--delete-branch'], { cwd: ORACLE });
    cleanupWorktree(claim.worktree);
    syncOracle();
    claims[pgId].status = 'done';
    claims[pgId].mergedAt = new Date().toISOString();
    checkPlanBox(pgId);
    saveClaims(claims);
    appendPublishLog(pgId, claims[pgId].slug); // writing record → ops (self-synced)
    log(`MERGED ${o.branch} → main (prod deploy triggered)`);
    submitGoogleIndex(claims[pgId].slug, claims[pgId].zh === true);
  });
}

// Best-effort post-merge Google Indexing API submission for the just-published
// article URL(s). Mirrors the Bing/Yandex IndexNow channel (build-time) but for
// Google, which IndexNow can't reach. No-op without GOOGLE_INDEXING_SA[_JSON];
// runs against the live URL (not the sitemap) so prod-deploy lag doesn't matter —
// Google recrawls after the notification, by which time the page is live.
// NEVER blocks or raises (the merge already succeeded).
function submitGoogleIndex(slug, hasZh) {
  if (!slug) return;
  const base = (process.env.SITE_URL || 'https://www.astrologywiki.com').replace(/\/+$/, '');
  const args = ['scripts/gsc-index-submit.mjs', '--url', `${base}/en/wiki/${slug}`];
  if (hasZh) args.push('--url', `${base}/zh/wiki/${slug}`);
  try {
    const out = sh('node', args, { cwd: ORACLE });
    const last = String(out).trim().split('\n').filter(Boolean).pop();
    if (last) log(`gsc-index: ${last}`);
  } catch (e) {
    log(`gsc-index: skipped (non-fatal: ${errTail(e, 60)})`);
  }
}

function doMarkVerified(o) {
  if (!o.branch) die('--mark-verified requires --branch', 2);
  if (!o.previewUrl) die('--mark-verified requires --preview-url', 2);
  if (!/^https:\/\/[^/]+/.test(o.previewUrl)) die(`invalid --preview-url: ${o.previewUrl}`, 2);
  return withClaimsLock(() => {
    const claims = loadClaims();
    const { pgId, claim } = claimForBranch(claims, o.branch);
    if (!['pushed-preview', 'verified-preview'].includes(claim.status)) {
      throw new Error(`cannot mark ${o.branch} verified from status "${claim.status}"`);
    }
    claims[pgId] = {
      ...claim,
      status: 'verified-preview',
      previewUrl: o.previewUrl,
      verificationEvidence: o.evidence || 'codex+chrome preview verification passed',
      verifiedAt: new Date().toISOString(),
    };
    saveClaims(claims);
    log(`VERIFIED ${o.branch} preview=${o.previewUrl}`);
  });
}

function doMarkFailed(o) {
  if (!o.branch) die('--mark-failed requires --branch', 2);
  if (!o.reason) die('--mark-failed requires --reason', 2);
  return withClaimsLock(() => {
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
  });
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

function larkNotify(msg) {
  if (process.env.GG_AUTOPILOT_NO_NOTIFY === '1') return; // suppressed in tests
  try { sh('bash', [LARK_NOTIFY, msg]); } catch { /* best-effort; never blocks */ }
}

function opsPublishLog() { return join(OPS, 'inbox', '06-tasks', 'seo-autopilot-publish-log.md'); }

// Append one row per published article to the ops publish register (the "写作记录"),
// then sync it + the plan to ops. Title/author come from the en.md frontmatter.
function appendPublishLog(pgId, slug) {
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
    if (!src.includes(`| ${pgId} |`)) {
      src = src.replace(/\nupdated:\s*[\d-]+/, `\nupdated: ${date}`) +
        `| ${date} | ${pgId} | ${slug} | ${title.replace(/\|/g, '/')} | ${author} | ${url} | published |\n`;
      writeFileSync(f, src);
    }
    syncOpsFiles([f, latestPlan()], `chore(seo): publish ${slug}`);
    larkNotify(`✅ SEO autopilot 已发布上线：${title || slug}\nhttps://www.astrologywiki.com/en/wiki/${slug}\n（作者 ${author || '?'}，已登记到 ops）`);
  } catch (e) { log(`publish-log skipped: ${errTail(e, 80)}`); }
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
  else if (o.author) doAuthor(o);
  else if (o.merge) doMerge(o);
  else if (o.markVerified) doMarkVerified(o);
  else if (o.markFailed) doMarkFailed(o);
  else doScan(o);
} catch (e) {
  die(e.message || String(e), 1);
}
