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
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { buildAuthorMap, resolveAuthor } from './lib/author-routing.mjs';

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
    else if (a === '--branch') o.branch = argv[++i];
    else if (a === '--preview-url') o.previewUrl = argv[++i];
    else if (a === '--evidence') o.evidence = argv[++i];
    else if (a === '--reason') o.reason = argv[++i];
    else if (a === '--limit') o.limit = parseInt(argv[++i], 10) || 1;
    else if (a === '--task') o.task = argv[++i];
  }
  if (!o.scan && !o.author && !o.nextUnauthored && !o.merge && !o.markVerified && !o.markFailed && !o.status) o.scan = true;
  return o;
}

// ── plan discovery + parsing ────────────────────────────────────────────────
function latestPlan() {
  const files = readdirSync(PLAN_GLOB_DIR)
    .filter((f) => /blog-output-plan.*\.md$/.test(f))
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
  if (['active', 'pushed-preview', 'verified-preview', 'needs_human', 'done'].includes(st)) {
    return { ok: false, reason: `claim=${st}` };
  }
  if (!existsSync(enDraft(task.pgId))) return { ok: false, reason: 'no EN enriched draft (upstream not done)' };
  if (!phase2Passed(task.pgId)) return { ok: false, reason: 'phase2 not pass' };
  const slug = frontmatterSlug(enDraft(task.pgId));
  if (!slug) return { ok: false, reason: 'EN draft missing frontmatter slug' };
  if (!SLUG_RE.test(slug)) return { ok: false, reason: `invalid slug "${slug}" (needs source fix)` };
  if (existsSync(join(articlesDir(ORACLE), `${slug}.ts`)) && st !== 'needs_human')
    return { ok: false, reason: `oracle already has ${slug}.ts` };
  return { ok: true, slug };
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

// cluster_domain → author_id via the config snapshot's author.map (the documented
// auto-routing rule). overrideRaw='' on purpose so a malformed Sheet author column
// (display names like "Aditi Sharma") can't block routing. '' if unresolved.
function resolveAuthorForDomain(clusterDomain) {
  if (!existsSync(CONFIG_SNAPSHOT)) return '';
  let values;
  try { values = JSON.parse(readFileSync(CONFIG_SNAPSHOT, 'utf8')).values || {}; }
  catch { return ''; }
  const { map } = buildAuthorMap(values);
  return resolveAuthor({ clusterDomain, overrideRaw: '', authorMap: map }).author || '';
}

// Locate this task's row in 选题登记表 (page_id column). {row, brief} or null.
// Write to a file and read it back — the full sheet is ~0.5MB and capturing that
// through execFileSync stdout truncates (pipe limit); a file read is reliable.
function findSheetRow(pgId) {
  mkdirSync(join(FLOW, '.gg-cache', 'batches'), { recursive: true });
  const outRel = join('.gg-cache', 'batches', '_allrows.json');
  // --out writes the JSON file (no --dry-run: --dry-run prints to stdout and skips
  // the file write); same read-only pull the per-row batch step below uses.
  shFlow('node', [SHEET_PULL, '--rows', '2-300', '--limit', '400', '--out', outRel]);
  let rows;
  try { const j = JSON.parse(readFileSync(join(FLOW, outRel), 'utf8')); rows = j.rows || j; }
  catch { throw new Error('sheet-pull output not parseable'); }
  const r = (rows || []).find((x) => String(x.page_id) === pgId);
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

function doAuthor(o = {}) {
  let sel;
  if (o.task) {
    const plan = latestPlan();
    if (!plan) { log('no blog-output-plan found'); return; }
    const t = parseTasks(plan).find((x) => x.pgId === o.task);
    if (!t) { log(`--task ${o.task} not found in plan`); return; }
    if (claimStatus(loadClaims(), t.pgId)) { log(`--task ${o.task} already has a claim (clear it first)`); return; }
    sel = { plan, task: t };
  } else {
    sel = nextUnauthoredTask();
  }
  if (!sel || !sel.task) { log('nothing to author this run'); return; }
  const { task: t } = sel;
  const pgId = t.pgId;
  const planName = basename(sel.plan);
  log(`author candidate ${pgId} (${t.keyword || ''})`);
  const park = (slug, reason) => parkAuthor(pgId, slug, planName, reason);

  try {
    // 1. locate the Sheet row
    let loc;
    try { loc = findSheetRow(pgId); }
    catch (e) { return park(null, `sheet-pull failed: ${errTail(e)}`); }
    if (!loc) return park(null, `no row for ${pgId} in 选题登记表`);
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
    const cleanEntity = keyword
      .replace(/^\s*(what\s+(is|are|to\s+do\s+(on|with|during|after))|how\s+(to|do(es)?)|why\s+(is|are|do(es)?)|when\s+(is|are|to|do(es)?))\s+(a|an|the)?\s*/i, '')
      .replace(/[?？]+\s*$/, '').trim() || keyword;
    const ragEntity = cleanEntity;

    const author = resolveAuthorForDomain(domain);
    if (!author) return park(slug, `no author for cluster_domain "${domain}" (author.map miss)`);
    entry.author = author;
    entry.author_source = 'auto';

    // The Sheet `entity` column is sometimes a phrase-salad of angles
    // ("intentional energy work · lunar phase timing · …") instead of the entity
    // name; rendered verbatim it produces garbage H2s like "## What is intentional
    // energy work · …?". When it looks like a list (·-separated / 3+ comma items),
    // swap in the clean topic noun so headings read naturally.
    const messyEntity = /·/.test(entry.entity || '') || ((entry.entity || '').split(',').length >= 3);
    if (messyEntity && cleanEntity) entry.entity = cleanEntity;

    // English-template CTA when the Sheet CTA text is non-English (CJK) or blank.
    // Keep the Sheet's absolute cta_target_url. (User-approved 2026-06-03.)
    if (/[㐀-鿿]/.test(entry.cta_text || '') || !(entry.cta_text || '').trim()) {
      if (!/^https?:\/\//.test(entry.cta_target_url || ''))
        return park(slug, 'CTA text non-English but no absolute cta_target_url to keep');
      entry.cta_text = `Generate your free birth chart to explore ${cleanEntity}.`;
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
    try { shFlow('node', [GBRAIN_RAG, '--page-id', pgId, '--entity', ragEntity, '--target-keyword', keyword], 240000); }
    catch (e) { log(`gbrain-rag exit non-zero: ${errTail(e, 80)}`); }
    if (!existsSync(join(ragDir, 'obsidian-rag.json'))) return park(slug, 'gbrain-rag produced no cache');
    try { shFlow('node', [ENTITY_PASSPORT, '--entity', ragEntity, '--page-id', pgId, '--emit-rag'], 300000); }
    catch (e) { log(`entity-passport exit non-zero (partial sources?): ${errTail(e, 80)}`); }
    const epRag = join(ragDir, 'entity-passport.rag.json');
    if (!existsSync(epRag) || statSync(epRag).size < 512) return park(slug, 'entity-passport produced no RAG');

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
    const attempts = Math.max(1, parseInt(process.env.GG_AUTHOR_GEN_ATTEMPTS || '3', 10));
    let lastFail = '';
    for (let i = 1; i <= attempts; i++) {
      try { shFlow('node', [ORCHESTRATOR, '--prompt', promptPath, '--page-id', pgId, '--models', WINNER, '--out-dir', '_staging', '--retry', '2'], 900000); }
      catch (e) { log(`orchestrator exit non-zero (attempt ${i}): ${errTail(e, 80)}`); }
      if (!existsSync(join(FLOW, draftV8))) { lastFail = 'orchestrator produced no draft'; continue; }
      try { shFlow('node', [PHASE2, '--source', draftV8, '--page-id', pgId, '--tag', 'en', '--author', author]); }
      catch (e) {
        const m = `${e.stdout || ''}${e.stderr || ''}`.match(/(SC\d+|RL\d+)[^\n]*/);
        lastFail = `phase2 ${m ? m[0].trim() : 'FAIL'}`;
        log(`phase2 attempt ${i}/${attempts} failed — ${lastFail}${i < attempts ? ' — regenerating' : ''}`);
        continue;
      }
      if (existsSync(enDraft(pgId)) && phase2Passed(pgId)) {
        // multi-party review (user-approved 2026-06-03): Codex critiques the
        // phase2-passing draft → Opus revises → re-validate. Adopt the revision
        // ONLY if it still passes phase2 (best-effort improvement, never regress —
        // on any failure _staging/<pid>-en.md stays the original passing draft).
        const revisedV8 = join('_staging', `${pgId}-revised-v8.md`);
        try {
          const out = shFlow('node', [REVIEW, '--source', draftV8, '--out', revisedV8,
            '--page-id', pgId, '--entity', cleanEntity, '--target-keyword', keyword], 1500000).trim();
          log(out || 'review: (no output)');
          if (/revised/.test(out) && existsSync(join(FLOW, revisedV8))) {
            try {
              shFlow('node', [PHASE2, '--source', revisedV8, '--page-id', pgId, '--tag', 'en', '--author', author]);
              log(phase2Passed(pgId) ? 'review: revised draft adopted (passed phase2)' : 'review: revision kept original');
            } catch { log('review: revised draft failed phase2 — kept original'); }
          }
        } catch (e) { log(`review skipped: ${errTail(e, 80)}`); }
        log(`AUTHORED ${pgId} → ${enDraft(pgId)} (author=${author}, attempt ${i}/${attempts}) — ready for next scan to publish`);
        return;
      }
      lastFail = 'phase2 wrote no passing manifest';
    }
    return park(slug, `${lastFail || 'phase2 failed'} after ${attempts} generation attempt(s)`);
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
    saveClaims(claims);

    const branch = `seo/auto/${new Date().toISOString().slice(0, 10)}-${t.pgId}`;
    const worktreeBranch = o.dryRun ? `${branch}-dry-run-${process.pid}` : branch;
    let publishRepo;
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
    try { res = convert(publishRepo, t.pgId, t.slug); }
    catch (e) { claims[t.pgId].status = 'needs_human'; claims[t.pgId].error = `convert: ${e.message}`; saveClaims(claims); log(`FAIL convert ${t.pgId}`); continue; }

    // author-known gate
    const known = registeredAuthorIds(publishRepo);
    const used = articleAuthorIds(publishRepo, t.slug);
    const missing = used.filter((a) => a && a !== 'undefined' && !known.has(a));
    if (missing.length) { claims[t.pgId].status = 'needs_human'; claims[t.pgId].error = `unregistered author(s): ${[...new Set(missing)].join(',')}`; saveClaims(claims); log(`PARK ${t.pgId}: ${claims[t.pgId].error}`); continue; }

    // build gate
    const b = buildGate(publishRepo);
    if (!b.ok) { claims[t.pgId].status = 'needs_human'; claims[t.pgId].error = `build: ${b.error}`; saveClaims(claims); log(`PARK ${t.pgId}: build failed`); continue; }

    claims[t.pgId].zh = res.zh;
    if (o.dryRun) {
      claims[t.pgId].status = 'dry-run-ok';
      saveClaims(claims);
      cleanupWorktree(publishRepo);
      log(`DRY-RUN OK ${t.pgId} (${t.slug}${res.zh ? '+zh' : ' EN-only'}) build✓ — not pushed`);
    } else {
      gitIn(publishRepo, ['add', 'data/articles']);
      gitIn(publishRepo, ['commit', '-q', '-m', `feat(articles): publish ${t.slug} (${WINNER} ${VERSION}) [autopilot]`]);
      gitIn(publishRepo, ['push', '-u', 'origin', branch]);
      // Open a PR so Vercel posts a Preview deployment + check; merge happens
      // in --merge AFTER codex + chrome verify pass (the human-equivalent gate).
      let prUrl = '';
      try {
        prUrl = sh('gh', ['pr', 'create', '--repo', 'xdawayer/oracle', '--base', 'main', '--head', branch,
          '--title', `[autopilot] publish ${t.slug}`,
          '--body', `Automated SEO publish of \`${t.pgId}\` → \`${t.slug}\`${res.zh ? ' (EN+ZH)' : ' (EN-only)'}.\n\nAwaiting codex review + chrome MCP verification on the Vercel preview before merge.`],
          { cwd: publishRepo }).trim();
      } catch (e) { prUrl = `(pr-create-failed: ${e.message})`; }
      claims[t.pgId].status = 'pushed-preview';
      claims[t.pgId].pr = prUrl;
      saveClaims(claims);
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
    log(`MERGED ${o.branch} → main (prod deploy triggered)`);
  });
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

function doStatus() {
  const claims = loadClaims();
  process.stdout.write(JSON.stringify(claims, null, 2) + '\n');
}

const o = parseArgs(process.argv.slice(2));
try {
  if (o.status) doStatus();
  else if (o.nextUnauthored) doNextUnauthored();
  else if (o.author) doAuthor(o);
  else if (o.merge) doMerge(o);
  else if (o.markVerified) doMarkVerified(o);
  else if (o.markFailed) doMarkFailed(o);
  else doScan(o);
} catch (e) {
  die(e.message || String(e), 1);
}
