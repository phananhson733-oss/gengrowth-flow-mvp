#!/usr/bin/env node
// gg-reconcile-status.mjs — self-heal 选题登记表 status drift.
//
// Problem this solves (reported by wzb 2026-06-30):
//   选题登记表 rows can sit at Status『待写』or『写作中』even though the article is
//   already LIVE on the site. The publish lane normally stamps『已发布』, but when that
//   write is skipped/missed the row drifts. This script reconciles the sheet against
//   the live sitemap and flips drifted rows to『已发布』(idempotent).
//
// What it does (per product):
//   1. Fetch the live sitemap, build the set of live article slugs
//      (astrologywiki: /{en,zh}/wiki/<slug> ; gengrowth: /{en,zh}/blog/<slug>).
//   2. Read 选题登记表. For every row whose Status ∈ OPEN_STATUSES, derive the page slug
//      from .gg-cache/<page_id>/entity-passport.rag.json (.entity → slugify), with
//      diacritic-stripped + token-subset fallbacks.
//   3. EXACT or diacritic match + live  → auto-flip Status→『已发布』(and fill 发布URL if empty).
//      token-only (fuzzy) match + live   → emit to review list, do NOT auto-write.
//   4. Write changes via Sheets values:batchUpdate (USER_ENTERED).
//
// Safety:
//   - Never downgrades a CLOSED status. Only OPEN_STATUSES are eligible.
//   - --dry (default) prints the plan and writes nothing. Pass --apply to write.
//   - Keyed on page_id (stable), never on row position.
//
// env:
//   GG_WRITER_SA_JSON              default ~/.config/gg/gg-writer-sa.json
//   GG_SHEETS_ASTROLOGY_WORKBOOK_ID  (fallback GG_SHEETS_FLOW_MVP_WORKBOOK_ID)
//   GG_SHEETS_GENGROWTH_WORKBOOK_ID
//
// usage:
//   node tools/scripts/gg-reconcile-status.mjs                       # dry-run, all products
//   node tools/scripts/gg-reconcile-status.mjs --product astrologywiki --apply
//   node tools/scripts/gg-reconcile-status.mjs --apply --json out.json

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getAccessToken, gFetch } from './lib/gg-shared.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = join(REPO, '.gg-cache');
const PAGES_TAB = '选题登记表';
const PUBLISHED = '已发布';
const OPEN_STATUSES = new Set(['待写', '写作中', '已建卡', '可生产']); // eligible to be flipped if live
const CLOSED_STATUSES = new Set(['已发布', '已刷新', '已合并', '暂停', '不写', '暂时不写']);

const PRODUCTS = {
  astrologywiki: {
    label: 'astrologywiki.com',
    sitemap: 'https://www.astrologywiki.com/sitemap.xml',
    slugRe: /\/(?:en|zh)\/wiki\/([^<\s]+)/g,
    workbookEnv: ['GG_SHEETS_ASTROLOGY_WORKBOOK_ID', 'GG_SHEETS_FLOW_MVP_WORKBOOK_ID'],
    urlBase: 'https://www.astrologywiki.com/en/wiki/',
  },
  gengrowth: {
    label: 'gengrowth.ai',
    sitemap: 'https://www.gengrowth.ai/sitemap.xml',
    slugRe: /\/(?:en|zh)\/blog\/([^<\s]+)/g,
    workbookEnv: ['GG_SHEETS_GENGROWTH_WORKBOOK_ID'],
    urlBase: 'https://gengrowth.ai/en/blog/',
  },
};

function parseArgs(argv) {
  const o = { product: 'all', apply: false, json: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') o.apply = true;
    else if (a === '--dry') o.apply = false;
    else if (a === '--product') o.product = argv[++i];
    else if (a === '--json') o.json = argv[++i];
  }
  return o;
}

const stripDiacritics = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const slugify = (e) => e.trim().toLowerCase().replace(/\s+/g, '-');
const slugifyStrict = (e) => stripDiacritics(e).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const tokens = (s) => stripDiacritics(s).toLowerCase().match(/[a-z0-9]+/g)?.filter((t) => t.length > 2 && !['the', 'and', 'for', 'vs'].includes(t)) || [];

async function liveSlugs(product) {
  const res = await fetch(product.sitemap, { headers: { 'user-agent': 'gg-reconcile/1' } });
  const xml = await res.text();
  const set = new Set();
  for (const m of xml.matchAll(product.slugRe)) {
    const slug = m[1];
    if (!slug.startsWith('author/') && !slug.startsWith('category/') && !slug.startsWith('classics')) set.add(slug);
  }
  return set;
}

function entityForPage(pageId) {
  for (const f of ['entity-passport.rag.json', 'friction-mine.rag.json', 'obsidian-rag.json']) {
    const p = join(CACHE, pageId, f);
    if (existsSync(p)) {
      try { const d = JSON.parse(readFileSync(p, 'utf8')); if (d.entity) return d.entity; } catch { /* skip */ }
    }
  }
  return null;
}

function matchLive(entity, live) {
  if (!entity) return null;
  for (const cand of [slugify(entity), slugifyStrict(entity)]) {
    if (live.has(cand)) return { slug: cand, kind: 'exact' };
  }
  // token-subset fuzzy: all significant entity tokens present in a live slug
  const et = tokens(entity);
  if (et.length) {
    for (const slug of live) {
      const st = new Set(slug.split('-'));
      if (et.every((t) => st.has(t))) return { slug, kind: 'fuzzy' };
    }
  }
  return null;
}

function colA1(idx0) { // 0-based col -> A1 letters
  let s = '', x = idx0 + 1;
  while (x > 0) { s = String.fromCharCode(65 + ((x - 1) % 26)) + s; x = Math.floor((x - 1) / 26); }
  return s;
}

function workbookId(product) {
  for (const k of product.workbookEnv) { const v = (process.env[k] || '').trim(); if (v) return v; }
  throw new Error(`workbook id missing: set one of ${product.workbookEnv.join(' / ')}`);
}

async function reconcileProduct(key, opts, token) {
  const product = PRODUCTS[key];
  const wb = workbookId(product);
  const live = await liveSlugs(product);
  const got = await gFetch(`https://sheets.googleapis.com/v4/spreadsheets/${wb}/values/${encodeURIComponent(PAGES_TAB + '!A1:AZ')}?majorDimension=ROWS`, token);
  const rows = got.values || [];
  const header = rows[0] || [];
  const iStatus = header.findIndex((h) => /^Status$/i.test((h || '').trim()));
  const iPage = header.findIndex((h) => /page_id/i.test((h || '').trim()));
  const iUrl = header.findIndex((h) => /^(URL|发布URL)$/i.test((h || '').trim()));
  if (iStatus < 0 || iPage < 0) throw new Error(`${product.label}: 选题登记表 header missing Status/page_id`);

  const flips = [], review = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const status = (row[iStatus] || '').trim();
    const pageId = (row[iPage] || '').trim();
    if (!pageId || CLOSED_STATUSES.has(status) || !OPEN_STATUSES.has(status)) continue;
    const m = matchLive(entityForPage(pageId), live);
    if (!m) continue;
    const rec = { pageId, sheetRow: r + 1, fromStatus: status, slug: m.slug, url: product.urlBase + m.slug };
    if (m.kind === 'exact') flips.push(rec); else review.push({ ...rec, reason: 'fuzzy-token-match (manual confirm)' });
  }

  const data = [];
  for (const f of flips) {
    data.push({ range: `${PAGES_TAB}!${colA1(iStatus)}${f.sheetRow}`, values: [[PUBLISHED]] });
    if (iUrl >= 0) {
      const cur = (rows[f.sheetRow - 1][iUrl] || '').trim();
      if (!cur) data.push({ range: `${PAGES_TAB}!${colA1(iUrl)}${f.sheetRow}`, values: [[f.url]] });
    }
  }

  if (opts.apply && data.length) {
    await gFetch(`https://sheets.googleapis.com/v4/spreadsheets/${wb}/values:batchUpdate`, token, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
    });
  }
  return { product: product.label, liveCount: live.size, flips, review, applied: opts.apply ? flips.length : 0 };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const SA = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
  const scope = opts.apply ? 'https://www.googleapis.com/auth/spreadsheets' : 'https://www.googleapis.com/auth/spreadsheets.readonly';
  const { token } = await getAccessToken(SA, [scope]);
  const keys = opts.product === 'all' ? Object.keys(PRODUCTS) : opts.product.split(',').map((s) => s.trim());
  const out = [];
  for (const k of keys) out.push(await reconcileProduct(k, opts, token));

  for (const r of out) {
    process.stdout.write(`\n== ${r.product} == live=${r.liveCount} flip=${r.flips.length} review=${r.review.length} ${opts.apply ? '(APPLIED)' : '(dry-run)'}\n`);
    for (const f of r.flips) process.stdout.write(`  FLIP  ${f.pageId.padEnd(16)} ${f.fromStatus} → 已发布  ${f.slug}\n`);
    for (const f of r.review) process.stdout.write(`  REVIEW ${f.pageId.padEnd(16)} ${f.fromStatus}  ?→ ${f.slug}  (${f.reason})\n`);
  }
  if (opts.json) writeFileSync(opts.json, JSON.stringify({ generatedAt: new Date().toISOString(), apply: opts.apply, products: out }, null, 2));
}

main().catch((e) => { process.stderr.write(`gg-reconcile-status: ${e.stack || e.message}\n`); process.exit(1); });
