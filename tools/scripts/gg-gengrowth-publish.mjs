#!/usr/bin/env node
// gg-gengrowth-publish.mjs — LANE A: publish ticker for gengrowth.ai.
//
// Independent of the oracle SEO autopilot, but FLOW-IDENTICAL to Lane B (oracle): the
// only differences are the target site (gengrowth.ai blog / Supabase blog_posts vs
// astrologywiki.com / Vercel) and the data source (gengrowth workbook vs oracle sheet).
// Everything else is the SAME machinery:
//   1. scan ready gengrowth drafts in _staging/ (manifest overall=pass)
//   2. PRE-PUBLISH FACTUAL GATE — gg-codex-pr-review.mjs --source (same reviewer Lane B
//      runs on a PR diff); a non-PASS PARKS the article (needs_human), never publishes it
//   3. upsert the not-yet-live ones via the bridge gg-md-to-gengrowth-blog.mjs --emit rest
//   4. verify live (Supabase row status=published)
//   5. POST-PUBLISH — vault archive (gg-archive-to-vault.mjs) + per-article
//      notification via the unified event layer (lib/gg-notify.mjs — templates and
//      @ policy live in NOTIFY-CONTRACT.md, NOT here). Ordinary articles are not
//      submitted through the Google article indexing API; monitoring belongs in the
//      index tracker.
// Idempotent; DRY-RUN by default (the factual gate + post-publish steps run only on --apply).
//
// "ready" = _staging/PG-<W25prefix>-NNN-<llm>-v8.md WITH a sibling .manifest.json whose
// phase2_checks.overall === 'pass'. The bridge derives slug/pillar/category/HTML; this
// ticker only decides WHICH drafts to publish (skips ones already live unless --force).
//
// Auth: reads SB_URL + SB_KEY (service_role) from env. The launchd wrapper
// (gg-gengrowth-publish-tick.sh) fetches SB_KEY via the supabase CLI. Fail-safe: if
// SB_KEY is missing during --apply, it alerts + exits 0 (never crashes the cron).
//
// USAGE
//   node tools/scripts/gg-gengrowth-publish.mjs                 # dry-run: list ready/live/action
//   SB_URL=... SB_KEY=... node tools/scripts/gg-gengrowth-publish.mjs --apply
//   ... --apply --force            # re-upsert even already-live slugs
//   ... --pages "PG-WLS-001 PG-ART-002"   # restrict to specific page_ids

import { readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './gg-md-to-oracle-ts.mjs';
// 统一通知事件层（阶段 1 · 通知统一）：调用点只传结构化字段，模板与 @ 策略集中在
// lib/gg-notify.mjs（单一事实源 NOTIFY-CONTRACT.md）。notify 永不 throw、对 caller 永远
// best-effort（fail-closed 传输 + outbox 兜底在 lib/lark-send.mjs 内部完成）。
import { notify } from './lib/gg-notify.mjs';
// Reuse Lane B's authoritative codex-verdict classifier so the factual gate is
// IDENTICAL across both lanes (no fork/drift): FAIL dominates, exactly-one-bare-PASS
// passes, anything else (timeout / nonzero / no-verdict / ambiguous) → SKIPPED.
import { classifyCodex } from './gg-preview-gate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');
const HOME = process.env.HOME || '';
const BRIDGE = join(__dirname, 'gg-md-to-gengrowth-blog.mjs');
// Parity with Lane B (oracle): same factual reviewer and same vault archive.
// Only the inputs differ (a file vs a PR; a gengrowth URL vs an oracle URL).
const CODEX_BIN = process.env.GG_CODEX_BIN || join(__dirname, 'gg-codex-pr-review.mjs');
// Lane A surgical gate-repair (default-on; GG_GATE_REPAIR=0 disables): the SAME worker Lane B runs at its
// park boundary. Returns structured old/new edits for the failing draft; we apply them to the
// DRAFT FILE (no git — Lane A has no branch/PR), re-run phase2 + codex, then park or publish.
const GATE_REPAIR_BIN = process.env.GG_GATE_REPAIR_BIN || join(__dirname, 'gg-gate-repair.mjs');
const PHASE2_BIN = join(__dirname, '_phase2-validate.mjs');
const ARCHIVE_BIN = join(__dirname, 'gg-archive-to-vault.mjs');
const SITE_HOST = 'https://gengrowth.ai';
const URL_PATH = '/en/blog/';

// W25+ gengrowth SEO page-id prefixes (see 2026-06-16-W25-gengrowth-blog-output-plan.md).
const W25_PREFIXES = ['WLS', 'ART', 'SFS', 'EOS', 'AIS', 'TAS', 'SDS', 'B2B', 'CMP', 'SLB', 'SMS'];
const DRAFT_RE = new RegExp(`^(PG-(?:${W25_PREFIXES.join('|')})-\\d+)-[a-z0-9]+-v8\\.md$`, 'i');

function parseArgs(argv) {
  const a = { apply: false, force: false, locale: 'en', stagingDir: join(REPO, '_staging'), pages: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--apply') a.apply = true;
    else if (k === '--force') a.force = true;
    else if (k === '--locale') a.locale = argv[++i];
    else if (k === '--staging-dir') a.stagingDir = argv[++i];
    else if (k === '--pages') a.pages = argv[++i].split(/[\s,]+/).filter(Boolean);
    else if (k === '--limit') a.limit = parseInt(argv[++i], 10) || 0;
  }
  // EN-only (2026-07-03): gengrowth blog publishing never ships zh rows. Reject
  // at the publish entry — before any gate/IO — instead of passing zh through
  // to the bridge.
  a.locale = String(a.locale).toLowerCase();
  if (a.locale !== 'en') {
    process.stderr.write(`--locale ${a.locale} is no longer supported — the pipeline is EN-only (zh removed 2026-07-03)\n`);
    process.exit(2);
  }
  // Serial cadence (parity with Lane B): publish at most `limit` per run so a backlog
  // drip-feeds across the hourly cron instead of dumping all at once. 0 = unlimited.
  // Env GG_GENGROWTH_PUBLISH_LIMIT lets the cron tick set it without editing args.
  if (a.limit == null) a.limit = parseInt(process.env.GG_GENGROWTH_PUBLISH_LIMIT || '0', 10) || 0;
  return a;
}

// ── Pre-publish factual gate (parity with Lane B's gg-preview-gate step 4b) ──────
// Runs the SAME cross-model factual reviewer oracle uses (GG_CODEX_BIN →
// gg-codex-pr-review.mjs) in its --source mode against the standalone draft md, and
// classifies the verdict with Lane B's classifyCodex. This is the gate that catches a
// factually-wrong-but-structurally-valid article (e.g. the fabricated-Ahrefs-data and
// product-overpromise errors found retroactively in the W25 batch).
//
// GG_CODEX_GATE_REQUIRED !== '0' (default): any non-PASS (FAIL *or* SKIPPED/tooling) PARKS
// the article — fail-closed, never publish an unreviewed claim. =0 hot-rolls-back to legacy
// best-effort (block only on a completed FAIL; a SKIPPED tooling failure does not block).
function factualReview(mdPath) {
  const required = process.env.GG_CODEX_GATE_REQUIRED !== '0';
  if (!existsSync(CODEX_BIN)) {
    return { verdict: 'SKIPPED', reason: `codex review bin missing: ${CODEX_BIN}`, required };
  }
  const timeoutMs = Number(process.env.GG_CODEX_REVIEW_TIMEOUT_MS) || 600000;
  const r = spawnSync('node', [CODEX_BIN, '--source', mdPath], {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
  });
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
  const cls = classifyCodex({ code: r.status ?? 1, stdout: r.stdout, timedOut });
  return { ...cls, required };
}

// ── Post-publish vault archive (parity with the FLOW post-deploy archive step) ──────
// COPIES the live article into the gengrowth-wiki Obsidian vault as an OFM/RAG note via
// the SAME gg-archive-to-vault.mjs oracle uses, only with gengrowth's site-host + url-path.
// Best-effort; never throws.
function archiveToVault(pageId, slug) {
  if (!existsSync(ARCHIVE_BIN)) return;
  try {
    execFileSync('node', [
      ARCHIVE_BIN, '--pages', `${pageId}:${slug}`,
      '--site', 'gengrowth', '--site-host', SITE_HOST, '--url-path', URL_PATH,
      '--oracle', join(HOME, 'oracle'),
    ], { encoding: 'utf8', timeout: 60000 });
    console.log(`  vault-archive: ${pageId}:${slug} → 内容资产/gengrowth/`);
  } catch (e) {
    console.log(`  vault-archive: skipped (non-fatal: ${String(e.message || e).slice(0, 80)})`);
  }
}

// ── Lane A surgical repair at the codex park boundary (default-on; GG_GATE_REPAIR=0 disables) ──
// Lane B (oracle) repairs a PR .ts + git-pushes; Lane A has NO branch/PR — it edits the
// standalone _staging/<PID>-<llm>-v8.md DRAFT in place (the publisher upserts THAT file).
// So this: (a) calls gg-gate-repair.mjs --dimension codex to get structured old/new edits,
// (b) applies them to the draft FILE deterministically (each old_string re-validated to be
// UNIQUELY present, mirroring Lane B's guard), (c) RE-RUNS phase2 (GG_SITE=gengrowth) under
// a THROWAWAY tag so a draft edit that broke SC3/keyword structure is caught WITHOUT clobbering
// the real draft/manifest — phase2 FAIL ⇒ revert + park, (d) re-runs the codex gate ONCE —
// PASS ⇒ publish, else revert + park. Loop-cap 1: exactly one codex-repair attempt per article
// (this is the sole call site, so the cap is structural). No git; revert = restore the bytes we
// snapshotted before the first write. Returns true only when BOTH re-gates pass (⇒ publish).
function laneARepairCodex(d, reason) {
  if (process.env.GG_GATE_REPAIR === '0') return false; // default-on; GG_GATE_REPAIR=0 disables
  if (!existsSync(GATE_REPAIR_BIN)) { console.log(`  repair[codex]: no gate-repair bin — skip`); return false; }
  if (!existsSync(PHASE2_BIN)) { console.log(`  repair[codex]: no phase2 bin — skip`); return false; }
  // Manifest carries the phase2 context (entity / target_keyword / template / tier / prompt_version)
  // needed to re-validate; the per-draft fixture is long gone, so pass these explicitly as flags.
  let mf;
  try { mf = JSON.parse(readFileSync(d.manifestPath, 'utf8')); } catch { console.log(`  repair[codex]: manifest unreadable — skip`); return false; }
  const tagM = d.mdPath.match(/-([a-z0-9]+-v8)\.md$/i);
  if (!tagM) { console.log(`  repair[codex]: cannot derive tag — skip`); return false; }
  const tag = tagM[1];

  // Snapshot the original bytes BEFORE any write — this is the revert target.
  let original;
  try { original = readFileSync(d.mdPath, 'utf8'); } catch { console.log(`  repair[codex]: draft unreadable — skip`); return false; }

  console.log(`  repair[codex]: gg-gate-repair on ${d.pageId} (reason: ${String(reason).slice(0, 80)}…)`);
  const rr = spawnSync('node', [GATE_REPAIR_BIN, '--article', d.mdPath, '--dimension', 'codex', '--reason', String(reason)], {
    encoding: 'utf8', timeout: Number(process.env.GG_GATE_REPAIR_TIMEOUT_MS) || 450000, maxBuffer: 64 * 1024 * 1024,
  });
  if ((rr.error && rr.error.code === 'ETIMEDOUT') || rr.status !== 0) {
    console.log(`  repair[codex]: worker ${rr.error ? 'timeout' : `exit ${rr.status}`} — skip`); return false;
  }
  let out;
  try {
    const lines = String(rr.stdout || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
    out = JSON.parse(lines[lines.length - 1]);
  } catch { console.log(`  repair[codex]: unparseable worker output — skip`); return false; }
  const edits = Array.isArray(out && out.edits) ? out.edits : [];
  if (!edits.length) { console.log(`  repair[codex]: ${(out && out.note) || 'no edits'} — skip`); return false; }

  // Apply deterministically; re-validate each old_string is UNIQUELY present (defense-in-depth
  // over the worker's own guard). Any malformed / non-unique edit ⇒ abort (draft untouched on disk).
  let content = original;
  for (const e of edits) {
    if (!e || typeof e.old_string !== 'string' || typeof e.new_string !== 'string') { console.log(`  repair[codex]: malformed edit — abort`); return false; }
    if ((content.split(e.old_string).length - 1) !== 1) { console.log(`  repair[codex]: edit not uniquely present — abort`); return false; }
    content = content.replace(e.old_string, e.new_string);
  }
  try { writeFileSync(d.mdPath, content); } catch { console.log(`  repair[codex]: write failed — abort`); return false; }

  // Revert helper: restore the pre-repair bytes. Used on any downstream failure.
  const revert = () => { try { writeFileSync(d.mdPath, original); } catch { /* best-effort */ } };

  // (c) RE-RUN phase2 under a THROWAWAY tag so editing the draft can't break SC3/keyword structure
  // undetected — and so phase2's normalizing rewrite lands on a scratch file, NOT the real draft we
  // just edited. We key ONLY on the exit code (0 = OVERALL PASS; 11 = OVERALL FAIL).
  const scratchTag = `${tag}-repairchk`;
  const scratchMd = join(dirname(d.mdPath), `${d.pageId}-${scratchTag}.md`);
  const scratchManifest = scratchMd.replace(/\.md$/, '.manifest.json');
  const p2 = spawnSync('node', [
    PHASE2_BIN, '--source', d.mdPath, '--page-id', d.pageId, '--tag', scratchTag,
    '--entity', String(mf.entity || ''), '--target-keyword', String(mf.target_keyword || ''),
    '--template', String(mf.template || 'Definition'), '--tier', String(mf.tier || 'T2'),
    '--prompt-version', String(mf.prompt_version || 'v8'), '--allow-missing-serp',
  ], { encoding: 'utf8', env: { ...process.env, GG_SITE: 'gengrowth' }, timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  try { rmSync(scratchMd, { force: true }); rmSync(scratchManifest, { force: true }); } catch { /* best-effort */ }
  if (p2.status !== 0) {
    console.log(`  repair[codex]: phase2 re-validate FAILED after edit (exit ${p2.status}) — reverting + parking`);
    revert(); return false;
  }

  // (d) re-run the codex factual gate ONCE against the edited draft. PASS ⇒ publish; else revert + park.
  const fr2 = factualReview(d.mdPath);
  if (fr2.verdict !== 'PASS') {
    console.log(`  repair[codex]: codex still ${fr2.verdict} after repair (${fr2.reason}) — reverting + parking`);
    revert(); return false;
  }
  console.log(`  ✓ repair[codex]: applied ${edits.length} edit(s), phase2 + codex re-passed — publishing ${d.pageId}`);
  return true;
}

// Ready drafts: PG-<W25>-NNN-<llm>-v8.md + sibling manifest overall==='pass'.
function scanReady(stagingDir, pagesFilter) {
  if (!existsSync(stagingDir)) return [];
  const out = [];
  for (const f of readdirSync(stagingDir)) {
    const m = f.match(DRAFT_RE);
    if (!m) continue;
    const pageId = m[1].toUpperCase();
    if (pagesFilter && !pagesFilter.includes(pageId)) continue;
    const mdPath = join(stagingDir, f);
    const manifestPath = mdPath.replace(/\.md$/, '.manifest.json');
    let pass = false;
    try { pass = JSON.parse(readFileSync(manifestPath, 'utf8'))?.phase2_checks?.overall === 'pass'; } catch { pass = false; }
    if (!pass) { out.push({ pageId, mdPath, ready: false, reason: 'manifest not overall=pass' }); continue; }
    let slug = null;
    try { slug = (parseFrontmatter(readFileSync(mdPath, 'utf8')).frontmatter.slug || '').trim() || null; } catch { /* */ }
    out.push({ pageId, mdPath, manifestPath, ready: true, slug });
  }
  return out.sort((x, y) => x.pageId.localeCompare(y.pageId));
}

async function liveStatus(SB_URL, SB_KEY, slug, locale) {
  if (!SB_URL || !SB_KEY || !slug) return { known: false };
  try {
    const r = await fetch(`${SB_URL}/rest/v1/blog_posts?slug=eq.${encodeURIComponent(slug)}&locale=eq.${locale}&select=status`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    });
    if (!r.ok) return { known: false, err: `GET ${r.status}` };
    const rows = await r.json();
    return { known: true, exists: rows.length > 0, status: rows[0]?.status || null };
  } catch (e) { return { known: false, err: e.message }; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const SB_URL = process.env.SB_URL || 'https://qeeocwurjslqppjxlsbk.supabase.co';
  const SB_KEY = process.env.SB_KEY || '';
  const mode = args.apply ? 'APPLY' : 'DRY-RUN';

  if (args.apply && !SB_KEY) {
    // FAIL-SAFE: never crash the cron on missing auth; alert + clean exit.
    console.error('gg-gengrowth-publish: --apply but SB_KEY missing — skipping (auth not available).');
    await notify('auth_missing', { site: 'gengrowth', what: 'SB_KEY', hint: 'supabase login' });
    process.exit(0);
  }

  const drafts = scanReady(args.stagingDir, args.pages);
  const ready = drafts.filter((d) => d.ready);
  console.log(`\n=== gg-gengrowth-publish [${mode}] — ${ready.length} ready draft(s) (locale=${args.locale}) ===`);

  const actions = [];
  for (const d of ready) {
    const ls = await liveStatus(SB_URL, SB_KEY, d.slug, args.locale);
    let action;
    if (!d.slug) action = 'SKIP(no-slug)';
    else if (!ls.known) action = args.apply ? 'PUBLISH(live-unknown)' : 'PUBLISH?';
    else if (ls.exists && ls.status === 'published' && !args.force) action = 'SKIP(live)';
    else if (ls.exists) action = 'REPUBLISH';
    else action = 'PUBLISH';
    actions.push({ ...d, action, live: ls });
    console.log(`  ${d.pageId.padEnd(12)} ${(d.slug || '-').padEnd(40)} ${action}`);
  }

  if (!args.apply) {
    console.log(`\n(dry-run. Add --apply to publish PUBLISH/REPUBLISH via the bridge --emit rest.)`);
    return;
  }

  let published = 0, failed = 0, verified = 0, parked = 0;
  const queue = actions.filter((d) => /^PUBLISH|^REPUBLISH/.test(d.action));
  const slice = args.limit > 0 ? queue.slice(0, args.limit) : queue;
  if (args.limit > 0 && queue.length > slice.length) {
    console.log(`  (serial cadence: publishing ${slice.length}/${queue.length} this run; ${queue.length - slice.length} deferred to the next hourly tick)`);
  }
  for (const d of slice) {
    // ── Pre-publish factual gate (parity with Lane B) ── run BEFORE the upsert so a
    // factually-wrong draft never reaches production; a non-PASS parks (needs_human).
    const fr = factualReview(d.mdPath);
    if (fr.verdict !== 'PASS') {
      const block = fr.required || fr.verdict === 'FAIL';
      if (block) {
        // Lane A surgical repair BEFORE parking — only a real factual FAIL is repairable
        // (a SKIPPED tooling/timeout verdict has no fact to fix). Default-on (GG_GATE_REPAIR=0 disables);
        // on success the draft is edited in place + both re-gates passed → fall through to publish.
        if (fr.verdict === 'FAIL' && laneARepairCodex(d, fr.reason)) {
          // repaired: proceed to the upsert below (draft on disk now carries the surgical edits).
        } else {
          parked++;
          console.log(`  ⛔ ${d.pageId.padEnd(12)} ${(d.slug || '-').padEnd(40)} PARKED by factual gate: ${fr.reason}`);
          // @ 策略变更（有意，见契约「迁移映射」）：Lane A 事实门未过原本零 @，统一后 PM+OPS。
          await notify('fact_gate_fail', { site: 'gengrowth', pid: d.pageId, slug: d.slug, reason: fr.reason });
          continue;
        }
      }
      console.log(`  ⚠️ ${d.pageId} factual gate ${fr.verdict} (${fr.reason}) — GG_CODEX_GATE_REQUIRED=0, not blocking`);
    } else {
      console.log(`  ✓ factual gate PASS: ${d.pageId}`);
    }
    try {
      execFileSync('node', [BRIDGE, '--source', d.mdPath, '--locale', args.locale, '--emit', 'rest'], {
        env: { ...process.env, SB_URL, SB_KEY }, stdio: ['ignore', 'inherit', 'inherit'], timeout: 120000,
      });
      published++;
      const after = await liveStatus(SB_URL, SB_KEY, d.slug, args.locale);
      const ok = after.known && after.exists && after.status === 'published';
      if (ok) { verified++; console.log(`  ✓ verified live: ${d.slug}`); }
      else console.log(`  ⚠️ ${d.slug} upserted but verify says: ${JSON.stringify(after)}`);
      // ── Post-publish parity step: archive into the wiki vault only after
      // verify-live succeeds.
      if (ok) {
        archiveToVault(d.pageId, d.slug);
      }
      // Per-article notification (parity with Lane B's per-article "已发布上线" notice),
      // instead of one aggregate ticker — one Hermes-bot message per published article.
      let title = d.slug;
      try { title = (parseFrontmatter(readFileSync(d.mdPath, 'utf8')).frontmatter.title || d.slug).toString().trim(); } catch { /* */ }
      if (ok) await notify('published', { site: 'gengrowth', title, url: `${SITE_HOST}${URL_PATH}${d.slug}`, extra: 'gengrowth.ai 博客' });
    } catch (e) {
      failed++;
      console.error(`  ✖ ${d.pageId} (${d.slug}) failed: ${e.message}`);
      // @ 策略变更（有意，见契约「迁移映射」）：发布失败原本零 @，统一后 OPS。
      await notify('publish_fail', { site: 'gengrowth', pid: d.pageId, slug: d.slug, msg: e.message });
    }
  }
  console.log(`\n=== done: published=${published} verified=${verified} parked=${parked} failed=${failed} ===`);
  if (failed > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // 原 Lane A 异常字形 `✖` 统一为事件层的 `⚠️`（契约：废弃 ✖）；@ 策略变更（有意）：原零 @，统一后 OPS。
  main().catch(async (e) => {
    console.error(`gg-gengrowth-publish ERROR: ${e.message}`);
    await notify('ticker_error', { site: 'gengrowth', msg: e.message });
    process.exit(0);
  });
}
