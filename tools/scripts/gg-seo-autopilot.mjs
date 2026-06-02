#!/usr/bin/env node
// gg-seo-autopilot.mjs — downstream-only SEO publish autopilot.
//
// Scans the latest ops weekly blog-output plan, claims ONE unwritten task whose
// bilingual drafts already exist + passed phase2 in flow-mvp _staging, converts
// it into the oracle repo, validates it, and (unless --dry-run) pushes a preview
// branch. Verification (codex + chrome MCP) and the final merge-to-main are done
// by the orchestrating agent via --merge, NOT by this deterministic script.
//
// This script encodes the gates discovered during Phase 0 dry-run:
//   1. draft-exists   : EN enriched md (_staging/<PID>-en.md) must exist
//   2. phase2-pass    : <PID>-en.manifest.json overall == "pass"
//   3. slug-valid     : frontmatter slug must match /^[a-z0-9][a-z0-9-]*$/
//                       (apostrophes etc. produce invalid JS identifiers)
//   4. author-known   : every authorId on the converted article must be a
//                       registered AuthorPersona in oracle/data/authors/index.ts
//   5. build-gate     : `npm run build` in oracle must succeed
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
//   node gg-seo-autopilot.mjs --merge --branch seo/auto/<date>-<PID>
//   node gg-seo-autopilot.mjs --status
//
// Env (paths localised — defaults are this machine):
//   GG_FLOW_REPO   default ~/gengrowth-flow-mvp
//   GG_ORACLE_DIR  default ~/oracle
//   GG_OPS_DIR     default ~/gengrowth-ops
//   GG_WINNER_LLM  default claude
//   GG_VERSION     default v8

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
const FLOW = process.env.GG_FLOW_REPO || join(HOME, 'gengrowth-flow-mvp');
const ORACLE = process.env.GG_ORACLE_DIR || join(HOME, 'oracle');
const OPS = process.env.GG_OPS_DIR || join(HOME, 'gengrowth-ops');
const WINNER = process.env.GG_WINNER_LLM || 'claude';
const VERSION = process.env.GG_VERSION || 'v8';

const STAGING = join(FLOW, '_staging');
const ART = join(ORACLE, 'data', 'articles');
const AUTHORS_INDEX = join(ORACLE, 'data', 'authors', 'index.ts');
const CONV = join(FLOW, 'tools', 'scripts', 'gg-md-to-oracle-ts.mjs');
const REG = join(FLOW, 'tools', 'scripts', 'gg-oracle-register-index.mjs');
const PLAN_GLOB_DIR = join(OPS, 'inbox', '06-tasks', 'tasks');
const CLAIMS_PATH = join(PLAN_GLOB_DIR, '.autopilot-claims.json');
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}
function git(args, opts = {}) { return sh('git', ['-C', ORACLE, ...args], opts); }
function log(...a) { process.stderr.write(`[autopilot] ${a.join(' ')}\n`); }

function parseArgs(argv) {
  const o = { limit: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scan') o.scan = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--merge') o.merge = true;
    else if (a === '--status') o.status = true;
    else if (a === '--branch') o.branch = argv[++i];
    else if (a === '--limit') o.limit = parseInt(argv[++i], 10) || 1;
    else if (a === '--task') o.task = argv[++i];
  }
  if (!o.scan && !o.merge && !o.status) o.scan = true;
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
function saveClaims(c) { writeFileSync(CLAIMS_PATH, JSON.stringify(c, null, 2) + '\n'); }
function claimStatus(claims, pgId) { return claims[pgId]?.status || null; }

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
function registeredAuthorIds() {
  if (!existsSync(AUTHORS_INDEX)) return new Set();
  const src = readFileSync(AUTHORS_INDEX, 'utf8');
  return new Set([...src.matchAll(/\bid:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]));
}
function articleAuthorIds(slug) {
  const f = join(ART, `${slug}.ts`);
  if (!existsSync(f)) return [];
  const src = readFileSync(f, 'utf8');
  return [...src.matchAll(/authorId:\s*"?([^",\n]*)"?/g)].map((m) => m[1].trim());
}

// A task is claimable for downstream publish iff drafts exist + pass + not done.
function claimable(task, claims) {
  if (task.checked) return { ok: false, reason: 'already checked in plan' };
  const st = claimStatus(claims, task.pgId);
  if (st === 'active' || st === 'done') return { ok: false, reason: `claim=${st}` };
  if (!existsSync(enDraft(task.pgId))) return { ok: false, reason: 'no EN enriched draft (upstream not done)' };
  if (!phase2Passed(task.pgId)) return { ok: false, reason: 'phase2 not pass' };
  const slug = frontmatterSlug(enDraft(task.pgId));
  if (!slug) return { ok: false, reason: 'EN draft missing frontmatter slug' };
  if (!SLUG_RE.test(slug)) return { ok: false, reason: `invalid slug "${slug}" (needs source fix)` };
  if (existsSync(join(ART, `${slug}.ts`)) && st !== 'needs_human')
    return { ok: false, reason: `oracle already has ${slug}.ts` };
  return { ok: true, slug };
}

function convert(pgId, slug) {
  sh('node', [CONV, '--source', enDraft(pgId), '--slug', slug, '--out', join(ART, `${slug}.ts`)]);
  sh('node', [REG, '--oracle-articles-dir', ART, '--slug', slug, '--lang', 'en']);
  let zh = false;
  if (existsSync(zhDraft(pgId))) {
    sh('node', [CONV, '--source', zhDraft(pgId), '--slug', slug, '--out', join(ART, `${slug}.zh.ts`), '--language', 'zh']);
    sh('node', [REG, '--oracle-articles-dir', ART, '--slug', slug, '--lang', 'zh']);
    zh = true;
  }
  return { zh };
}

function buildGate() {
  try { sh('npm', ['run', 'build'], { cwd: ORACLE, stdio: ['ignore', 'pipe', 'pipe'] }); return { ok: true }; }
  catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    const m = out.match(/SEO (?:generation|build)[^\n]*|error[^\n]*/i);
    return { ok: false, error: (m && m[0]) || out.slice(-400) };
  }
}

// ── main flows ──────────────────────────────────────────────────────────────
function doScan(o) {
  const plan = latestPlan();
  if (!plan) { log('no blog-output-plan found'); return; }
  log(`plan: ${basename(plan)}`);
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

    // ensure clean oracle main before branching
    if (!o.dryRun) { git(['fetch', '--quiet', 'origin']); git(['checkout', 'main']); git(['pull', '--quiet', '--ff-only']); }

    const branch = `seo/auto/${new Date().toISOString().slice(0, 10)}-${t.pgId}`;
    if (!o.dryRun) { try { git(['checkout', '-b', branch]); } catch { git(['checkout', branch]); } }

    let res;
    try { res = convert(t.pgId, t.slug); }
    catch (e) { claims[t.pgId].status = 'needs_human'; claims[t.pgId].error = `convert: ${e.message}`; saveClaims(claims); log(`FAIL convert ${t.pgId}`); continue; }

    // author-known gate
    const known = registeredAuthorIds();
    const used = articleAuthorIds(t.slug);
    const missing = used.filter((a) => a && a !== 'undefined' && !known.has(a));
    if (missing.length) { claims[t.pgId].status = 'needs_human'; claims[t.pgId].error = `unregistered author(s): ${[...new Set(missing)].join(',')}`; saveClaims(claims); log(`PARK ${t.pgId}: ${claims[t.pgId].error}`); continue; }

    // build gate
    const b = buildGate();
    if (!b.ok) { claims[t.pgId].status = 'needs_human'; claims[t.pgId].error = `build: ${b.error}`; saveClaims(claims); log(`PARK ${t.pgId}: build failed`); continue; }

    claims[t.pgId].zh = res.zh;
    claims[t.pgId].branch = branch;
    if (o.dryRun) {
      claims[t.pgId].status = 'dry-run-ok';
      saveClaims(claims);
      log(`DRY-RUN OK ${t.pgId} (${t.slug}${res.zh ? '+zh' : ' EN-only'}) build✓ — not pushed`);
    } else {
      git(['add', 'data/articles']);
      git(['commit', '-q', '-m', `feat(articles): publish ${t.slug} (${WINNER} ${VERSION}) [autopilot]`]);
      git(['push', '-u', 'origin', branch]);
      claims[t.pgId].status = 'pushed-preview';
      saveClaims(claims);
      log(`PUSHED preview ${branch} — awaiting codex+chrome verify, then --merge`);
    }
  }
}

function doMerge(o) {
  if (!o.branch) { log('--merge requires --branch'); process.exit(2); }
  git(['checkout', 'main']); git(['pull', '--quiet', '--ff-only']);
  git(['merge', '--no-ff', '-m', `merge ${o.branch} [autopilot verified]`, o.branch]);
  git(['push', 'origin', 'main']); // Vercel auto-deploys prod
  // flip claim → done + check the plan box
  const claims = loadClaims();
  for (const [pid, c] of Object.entries(claims)) {
    if (c.branch === o.branch) { c.status = 'done'; checkPlanBox(pid); }
  }
  saveClaims(claims);
  log(`MERGED ${o.branch} → main (prod deploy triggered)`);
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
if (o.status) doStatus();
else if (o.merge) doMerge(o);
else doScan(o);
