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
//   5. POST-PUBLISH — Google Indexing API submit (gsc-index-submit.mjs) + vault archive
//      (gg-archive-to-vault.mjs) + per-article Hermes-bot notification
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

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './gg-md-to-oracle-ts.mjs';
// Reuse Lane B's authoritative codex-verdict classifier so the factual gate is
// IDENTICAL across both lanes (no fork/drift): FAIL dominates, exactly-one-bare-PASS
// passes, anything else (timeout / nonzero / no-verdict / ambiguous) → SKIPPED.
import { classifyCodex } from './gg-preview-gate.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');
const HOME = process.env.HOME || '';
const BRIDGE = join(__dirname, 'gg-md-to-gengrowth-blog.mjs');
const LARK = join(__dirname, 'gg-lark-notify.sh');
// Parity with Lane B (oracle): same factual reviewer, same GSC indexing submit, same
// vault archive. Only the inputs differ (a file vs a PR; a gengrowth URL vs an oracle URL).
const CODEX_BIN = process.env.GG_CODEX_BIN || join(__dirname, 'gg-codex-pr-review.mjs');
const GSC_SUBMIT = join(HOME, 'oracle', 'scripts', 'gsc-index-submit.mjs');
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
  // Serial cadence (parity with Lane B): publish at most `limit` per run so a backlog
  // drip-feeds across the hourly cron instead of dumping all at once. 0 = unlimited.
  // Env GG_GENGROWTH_PUBLISH_LIMIT lets the cron tick set it without editing args.
  if (a.limit == null) a.limit = parseInt(process.env.GG_GENGROWTH_PUBLISH_LIMIT || '0', 10) || 0;
  return a;
}

function larkBestEffort(msg) {
  try { execFileSync('bash', [LARK, msg], { stdio: 'ignore', timeout: 20000 }); } catch { /* never throw */ }
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

// ── Post-publish Google Indexing API submit (parity with autopilot submitGoogleIndex) ──
// Best-effort; never throws. Runs AFTER verify-live so Google recrawls a live URL (not a 404).
// gengrowth has no zh locale → single EN URL. SA at ~/.config/gg/google-indexing-sa.json
// (now a verified owner of the gengrowth.ai property — confirmed 1/1 accepted 2026-06-23).
function submitGoogleIndex(slug) {
  if (!slug || !existsSync(GSC_SUBMIT)) return;
  try {
    const out = execFileSync('node', [GSC_SUBMIT, '--url', `${SITE_HOST}${URL_PATH}${slug}`], {
      cwd: join(HOME, 'oracle'), encoding: 'utf8', timeout: 60000,
    });
    const last = String(out).trim().split('\n').filter(Boolean).pop();
    if (last) console.log(`  gsc-index: ${last}`);
  } catch (e) {
    console.log(`  gsc-index: skipped (non-fatal: ${String(e.message || e).slice(0, 80)})`);
  }
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
    larkBestEffort('⚠️ gengrowth 发布 ticker：SB_KEY 缺失（supabase 会话过期？），本轮跳过。重登：supabase login');
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
        parked++;
        console.log(`  ⛔ ${d.pageId.padEnd(12)} ${(d.slug || '-').padEnd(40)} PARKED by factual gate: ${fr.reason}`);
        larkBestEffort(`⚠️ gengrowth 事实门未过（needs_human）：${d.pageId}（${d.slug}）— ${fr.reason}。已跳过发布，待人工核对后再发。`);
        continue;
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
      // ── Post-publish parity steps (mirror Lane B post-merge): submit to Google's
      // Indexing API + archive into the wiki vault — only after verify-live succeeds.
      if (ok) {
        submitGoogleIndex(d.slug);
        archiveToVault(d.pageId, d.slug);
      }
      // Per-article notification (parity with Lane B's per-article "已发布上线" notice),
      // instead of one aggregate ticker — one Hermes-bot message per published article.
      let title = d.slug;
      try { title = (parseFrontmatter(readFileSync(d.mdPath, 'utf8')).frontmatter.title || d.slug).toString().trim(); } catch { /* */ }
      if (ok) larkBestEffort(`✅ SEO autopilot 已发布上线：${title}\n${SITE_HOST}${URL_PATH}${d.slug}\n（gengrowth.ai 博客）`);
    } catch (e) {
      failed++;
      console.error(`  ✖ ${d.pageId} (${d.slug}) failed: ${e.message}`);
      larkBestEffort(`⚠️ gengrowth 发布失败：${d.pageId} (${d.slug}) — ${e.message}`);
    }
  }
  console.log(`\n=== done: published=${published} verified=${verified} parked=${parked} failed=${failed} ===`);
  if (failed > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`gg-gengrowth-publish ERROR: ${e.message}`); larkBestEffort(`✖ gengrowth 发布 ticker 异常：${e.message}`); process.exit(0); });
}
