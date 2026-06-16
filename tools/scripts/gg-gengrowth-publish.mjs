#!/usr/bin/env node
// gg-gengrowth-publish.mjs — LANE A: publish-only ticker for gengrowth.ai.
//
// Independent of the oracle SEO autopilot. Scans ready gengrowth drafts in _staging/
// and upserts the not-yet-live ones to the gengrowth.ai blog (Supabase blog_posts) via
// the bridge gg-md-to-gengrowth-blog.mjs --emit rest. Idempotent; DRY-RUN by default.
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
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './gg-md-to-oracle-ts.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');
const BRIDGE = join(__dirname, 'gg-md-to-gengrowth-blog.mjs');
const LARK = join(__dirname, 'gg-lark-notify.sh');

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
  }
  return a;
}

function larkBestEffort(msg) {
  try { execFileSync('bash', [LARK, msg], { stdio: 'ignore', timeout: 20000 }); } catch { /* never throw */ }
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

  let published = 0, failed = 0, verified = 0;
  for (const d of actions) {
    if (!/^PUBLISH|^REPUBLISH/.test(d.action)) continue;
    try {
      execFileSync('node', [BRIDGE, '--source', d.mdPath, '--locale', args.locale, '--emit', 'rest'], {
        env: { ...process.env, SB_URL, SB_KEY }, stdio: ['ignore', 'inherit', 'inherit'], timeout: 120000,
      });
      published++;
      const after = await liveStatus(SB_URL, SB_KEY, d.slug, args.locale);
      if (after.known && after.exists && after.status === 'published') { verified++; console.log(`  ✓ verified live: ${d.slug}`); }
      else console.log(`  ⚠️ ${d.slug} upserted but verify says: ${JSON.stringify(after)}`);
    } catch (e) {
      failed++;
      console.error(`  ✖ ${d.pageId} (${d.slug}) failed: ${e.message}`);
    }
  }
  console.log(`\n=== done: published=${published} verified=${verified} failed=${failed} ===`);
  if (published > 0) larkBestEffort(`✅ gengrowth 发布 ticker：上线 ${published} 篇（验收 ${verified}），失败 ${failed}。`);
  if (failed > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`gg-gengrowth-publish ERROR: ${e.message}`); larkBestEffort(`✖ gengrowth 发布 ticker 异常：${e.message}`); process.exit(0); });
}
