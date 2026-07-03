#!/usr/bin/env node
// gg-index-monitor.mjs — Phase 1 URL Inspection index tracker.
//
// What it does:
//   1. enqueue a newly-published URL into the ASCII `index-tracking` tab
//   2. inspect due URLs through the read-only Search Console URL Inspection API
//   3. update tracking status and send Feishu alerts for overdue/problem states
//
// What it explicitly does NOT do:
//   - request Google indexing for article URLs via API (no public API exists)
//   - use Google's Indexing API for ordinary articles

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadEnv, gFetch, resolveWorkbookId, redactNote, getAccessToken as getSaAccessToken } from './lib/gg-shared.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LARK_NOTIFY = join(__dirname, 'gg-lark-notify.sh');

export const INDEX_TRACKING_TAB = 'index-tracking';
export const INDEX_TRACKING_HEADER = Object.freeze([
  'url',
  'page_id',
  'slug',
  'title',
  'published_at',
  'first_tracked_at',
  'last_checked_at',
  'check_count',
  'days_since_first_tracked',
  'current_gsc_status',
  'gsc_verdict',
  'indexing_state',
  'page_fetch_state',
  'last_crawl_time',
  'google_canonical',
  'user_canonical',
  'monitor_status',
  'first_indexed_at',
  'days_to_index',
  'diagnosis_category',
  'alert_level',
  'alert_sent_at',
  'fix_status',
  'retry_round',
  'fixed_detected_at',
  'resubmitted_at',
  'next_check_after',
  'recommendation',
  'notes',
  'source',
]);

export const RECAP_TAB = '结果复盘表';
export const RECAP_HEADER = Object.freeze([
  'outcome_id',
  'page_id',
  'cluster_id',
  'url',
  'day14_收录',
  '申请时间',
  '索引修复状态',
  'day14_impressions',
  '记录日期',
  'day30_进Top50词数',
  '当前最高排名词（排名）',
  'day30_clicks',
  'day60_pv',
  'day60_目标国pv',
  '决策',
  '备注',
]);

export const RECAP_STATUS_CONDITIONAL_FORMATS = Object.freeze([
  {
    textContains: '🔴 紧急问题',
    fg: { red: 0.72, green: 0.10, blue: 0.10 },
    bg: { red: 1.0, green: 0.82, blue: 0.82 },
    bold: true,
  },
  {
    textContains: '需重点关注',
    fg: { red: 0.36, green: 0.22, blue: 0.66 },
    bg: { red: 0.89, green: 0.85, blue: 0.98 },
    bold: true,
  },
  {
    textContains: '⚠️ 超期未收录',
    fg: { red: 0.66, green: 0.31, blue: 0.00 },
    bg: { red: 1.0, green: 0.90, blue: 0.72 },
    bold: true,
  },
  {
    textContains: '已收录',
    fg: { red: 0.12, green: 0.45, blue: 0.20 },
    bg: { red: 0.86, green: 0.95, blue: 0.86 },
    bold: true,
  },
  {
    textContains: '监控中',
    fg: { red: 0.12, green: 0.32, blue: 0.60 },
    bg: { red: 0.86, green: 0.92, blue: 1.0 },
    bold: false,
  },
  {
    textContains: '已重新提交',
    fg: { red: 0.12, green: 0.38, blue: 0.52 },
    bg: { red: 0.85, green: 0.96, blue: 1.0 },
    bold: true,
  },
  {
    textContains: '待GSC检查',
    fg: { red: 0.28, green: 0.33, blue: 0.40 },
    bg: { red: 0.92, green: 0.94, blue: 0.96 },
    bold: false,
  },
  {
    textContains: '已提交',
    fg: { red: 0.12, green: 0.38, blue: 0.52 },
    bg: { red: 0.85, green: 0.96, blue: 1.0 },
    bold: false,
  },
]);

export const REQUEST_INDEXING_QUEUE_TAB = 'request-indexing-queue';
export const REQUEST_INDEXING_QUEUE_HEADER = Object.freeze([
  'candidate_id',
  'priority',
  'page_id',
  'url',
  'title',
  'day14_收录',
  'gsc_status',
  'diagnosis_category',
  'monitor_status',
  'first_tracked_at',
  'last_checked_at',
  'days_since_first_tracked',
  'discovery_status',
  'discovery_actions',
  'request_reason',
  'gsc_inspection_url',
  'computer_use_status',
  'computer_use_instruction',
  'created_at',
  'updated_at',
  'notes',
]);

export const URL_INVENTORY_TAB = 'url-inventory';
export const URL_INVENTORY_HEADER = Object.freeze([
  'url',
  'path_family',
  'title',
  'source',
  'sitemap_lastmod',
  'page_id',
  'inventory_status',
  'request_queue_allowed',
  'tracking_status',
  'request_queue_status',
  'recap_status',
  'current_gsc_status',
  'first_tracked_at',
  'last_checked_at',
  'gsc_inspection_url',
  'updated_at',
  'notes',
]);

const DUE_MILESTONES = Object.freeze([3, 7, 14, 21, 30]);
const DEFAULT_SITE = 'sc-domain:astrologywiki.com';
const DEFAULT_SITE_ORIGIN = 'https://www.astrologywiki.com';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const GSC_READONLY_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const GSC_WRITE_SCOPE = 'https://www.googleapis.com/auth/webmasters';
const DEFAULT_SITEMAP_URL = 'https://www.astrologywiki.com/sitemap.xml';
// Hosts whose /en/wiki/ + /en/blog/ single-segment URLs are trackable articles. Keyed off the
// URL's own host so the classifiers stay pure (no GG_SITE plumbing). astrologywiki output is
// unchanged today (its sitemap has no /en/blog/), and the planned /wiki→/blog migration is
// covered because blog articles are recognized for every article host, not just gengrowth.
const ARTICLE_HOSTS = Object.freeze(new Set([
  'www.astrologywiki.com', 'astrologywiki.com', 'gengrowth.ai', 'www.gengrowth.ai',
]));
const DIAGNOSIS_FRAMEWORK_URL = 'obsidian://open?vault=gengrowth-ops&file=inbox%2F08-reports-and-feedback%2F01-product-feedback%2F2026-06-22-indexing-automation-requirements-v1.0';
const KNOWN_TOOL_SLUGS = Object.freeze(new Set([
  'astrocartography',
  'astrocartography-map-generator',
  'big-three-calculator',
  'birth-chart-calculator',
  'celebrity-twins',
  'composite-calculator',
  'current-planets',
  'electional-astrology',
  'energy-timeline',
  'ephemeris-calculator',
  'moon-phase-calculator',
  'moon-sign-calculator',
  'rising-sign-calculator',
  'rodden-rating',
  'saturn-return-calculator',
  'solar-return-calculator',
  'synastry-calculator',
]));

function readerSaPath() {
  return process.env.GG_READER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-reader-sa.json');
}

function writerSaPath() {
  return process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
}

export async function getSheetAccessToken() {
  const { token } = await getSaAccessToken(writerSaPath(), [SHEETS_SCOPE]);
  return token;
}

export async function getGscAccessToken() {
  const { token } = await getSaAccessToken(readerSaPath(), [GSC_READONLY_SCOPE]);
  return token;
}

export async function getGscWriteAccessToken() {
  const { token } = await getSaAccessToken(readerSaPath(), [GSC_WRITE_SCOPE]);
  return token;
}

export async function preflightGscAccess(token, siteUrl, fetcher = gFetch) {
  const today = new Date();
  const endDate = today.toISOString().slice(0, 10);
  const startDate = new Date(today.getTime() - 86400000).toISOString().slice(0, 10);
  return fetcher(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startDate, endDate, dimensions: ['date'], rowLimit: 1 }),
    },
  );
}

export async function submitSitemap(token, siteUrl, sitemapUrl = DEFAULT_SITEMAP_URL, fetcher = gFetch) {
  return fetcher(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`,
    token,
    { method: 'PUT' },
  );
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function isoDay(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function isoTimestamp(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

function dayNumber(dateText) {
  if (!dateText) return null;
  const d = new Date(`${String(dateText).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 86400000);
}

function daysBetween(startDate, endDate) {
  const a = dayNumber(startDate);
  const b = dayNumber(isoDay(endDate));
  if (a == null || b == null) return 0;
  return Math.max(0, b - a);
}

function cleanCell(value) {
  return String(value ?? '').trim().replace(/\|/g, '/');
}

function siteOrigin(site) {
  if (!site || site.startsWith('sc-domain:')) return DEFAULT_SITE_ORIGIN;
  return String(site).replace(/\/$/, '');
}

function normalizeUrl(url) {
  const s = String(url || '').trim();
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function trackingIdentity(row = {}) {
  const pageId = String(row.page_id || '').trim();
  return pageId || normalizeUrl(row.url);
}

function isFixedMarker(value) {
  return String(value || '').trim() === '已修复';
}

function appendAutoNote(existing, note) {
  const old = String(existing || '').trim();
  if (!old) return note;
  if (old.includes(note)) return old;
  return `${old} | ${note}`;
}

function htmlAttr(tag, name) {
  const m = String(tag || '').match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[2] ?? m[3] ?? m[4] ?? '').trim() : '';
}

function decodeLightHtml(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

export function extractPageDiagnosticsFromHtml(html = '') {
  const raw = String(html || '');
  const withoutHidden = raw
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');
  const visibleText = decodeLightHtml(withoutHidden.replace(/<[^>]+>/g, ' '));
  const words = visibleText.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) || [];
  const metas = raw.match(/<meta\b[^>]*>/gi) || [];
  let metaRobots = '';
  let hasAuthor = false;
  let hasPublishedTime = false;
  for (const tag of metas) {
    const name = htmlAttr(tag, 'name').toLowerCase();
    const property = htmlAttr(tag, 'property').toLowerCase();
    const content = htmlAttr(tag, 'content');
    if ((name === 'robots' || name === 'googlebot') && !metaRobots) metaRobots = content;
    if (name === 'author' || property === 'article:author') hasAuthor = !!content || hasAuthor;
    if (
      property === 'article:published_time' ||
      name === 'date' ||
      name === 'publishdate' ||
      name === 'published_time'
    ) hasPublishedTime = !!content || hasPublishedTime;
  }
  return {
    word_count: words.length,
    meta_robots: metaRobots,
    has_author: hasAuthor,
    has_published_time: hasPublishedTime,
  };
}

function truncateText(text, max = 1200) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}...`;
}

export async function fetchPageDiagnostics(url, { fetcher = fetch } = {}) {
  const out = {
    word_count: '',
    meta_robots: '',
    has_author: '',
    has_published_time: '',
    robots_txt: '',
  };
  try {
    const res = await fetcher(url);
    if (res?.ok) Object.assign(out, extractPageDiagnosticsFromHtml(await res.text()));
    else out.page_fetch_error = `HTTP ${res?.status || 'unknown'}`;
  } catch (e) {
    out.page_fetch_error = redactNote(e);
  }

  try {
    const u = new URL(url);
    const robotsRes = await fetcher(`${u.origin}/robots.txt`);
    if (robotsRes?.ok) out.robots_txt = truncateText(await robotsRes.text(), 1200);
    else out.robots_txt = `(robots.txt fetch failed: HTTP ${robotsRes?.status || 'unknown'})`;
  } catch (e) {
    out.robots_txt = `(robots.txt fetch failed: ${redactNote(e)})`;
  }
  return out;
}

function isEnWikiArticleUrl(url) {
  try {
    const u = new URL(url);
    if (!ARTICLE_HOSTS.has(u.hostname)) return false;
    const path = u.pathname.replace(/\/$/, '');
    // Single-segment only → excludes the /en/blog hub and /en/blog/category/<x> listings.
    return /^\/en\/wiki\/[^/]+$/.test(path) || /^\/en\/blog\/[^/]+$/.test(path);
  } catch {
    return false;
  }
}

function slugFromEnWikiUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, '');
    const m = path.match(/^\/en\/(?:wiki|blog)\/(.+)$/);
    return m ? decodeURIComponent(m[1]) : '';
  } catch {
    return '';
  }
}

function titleFromSlug(slug) {
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map((part) => {
      if (/^\d+$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

function slugFromPath(pathname) {
  const parts = String(pathname || '').replace(/\/$/, '').split('/').filter(Boolean);
  return decodeURIComponent(parts[parts.length - 1] || '');
}

function inventoryPathFamily(url) {
  try {
    const u = new URL(url);
    if (!ARTICLE_HOSTS.has(u.hostname)) return '';
    const path = u.pathname.replace(/\/$/, '') || '/';
    if (path === '/en/tools') return 'en_tools_hub';
    if (/^\/en\/wiki\/[^/]+$/.test(path)) return 'en_wiki_article';
    if (/^\/en\/wiki\/.+\/[^/]+$/.test(path)) return 'en_wiki_nested';
    if (path === '/en/wiki') return 'en_wiki_hub';
    if (path === '/en/blog') return '';                          // blog listing hub → not an article
    if (/^\/en\/blog\/category(\/|$)/.test(path)) return '';     // blog category listings → excluded
    if (/^\/en\/blog\/[^/]+$/.test(path)) return 'en_blog_article';
    if (/^\/en\/[^/]+$/.test(path) && KNOWN_TOOL_SLUGS.has(slugFromPath(path))) return 'en_tool';
    if (/^\/en\/[^/]+$/.test(path)) return 'en_static';
    return '';
  } catch {
    return '';
  }
}

function titleFromInventoryUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, '');
    if (path === '/en/tools') return 'Tools';
    if (path === '/en/wiki') return 'Wiki';
    if (path === '/en/blog') return 'Blog';
    return titleFromSlug(slugFromPath(path));
  } catch {
    return '';
  }
}

function requestQueueAllowedForPathFamily(pathFamily) {
  return ['en_wiki_article', 'en_wiki_nested', 'en_tools_hub', 'en_tool', 'en_blog_article'].includes(pathFamily) ? 'Y' : 'N';
}

function sitemapEntries(xml) {
  const entries = [];
  const blocks = String(xml || '').match(/<url\b[\s\S]*?<\/url>/gi) || [];
  for (const block of blocks) {
    const loc = block.match(/<loc>\s*([^<]+?)\s*<\/loc>/i)?.[1]?.trim();
    if (!loc) continue;
    const lastmod = block.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i)?.[1]?.trim() || '';
    entries.push({ loc, lastmod: lastmod.slice(0, 10) });
  }
  return entries;
}

export function extractIndexableSitemapInventoryRows(xml, { now = new Date() } = {}) {
  const seen = new Set();
  const rows = [];
  for (const entry of sitemapEntries(xml)) {
    const url = normalizeUrl(entry.loc);
    if (seen.has(url)) continue;
    const pathFamily = inventoryPathFamily(url);
    if (!pathFamily) continue;
    seen.add(url);
    rows.push({
      url,
      path_family: pathFamily,
      title: titleFromInventoryUrl(url),
      source: 'live-sitemap',
      sitemap_lastmod: entry.lastmod || isoDay(now),
      page_id: '',
      inventory_status: '',
      request_queue_allowed: requestQueueAllowedForPathFamily(pathFamily),
      tracking_status: '',
      request_queue_status: '',
      recap_status: '',
      current_gsc_status: '',
      first_tracked_at: '',
      last_checked_at: '',
      gsc_inspection_url: '',
      updated_at: '',
      notes: '',
    });
  }
  return rows;
}

export async function fetchSitemapInventoryRows(sitemapUrl = DEFAULT_SITEMAP_URL, { fetcher = fetch, now = new Date() } = {}) {
  const res = await fetcher(sitemapUrl);
  if (!res.ok) throw new Error(`sitemap fetch failed (${res.status}): ${await res.text()}`);
  const xml = await res.text();
  return extractIndexableSitemapInventoryRows(xml, { now });
}

export function extractEnWikiSitemapRows(xml, { now = new Date() } = {}) {
  return sitemapEntries(xml)
    .filter((entry) => isEnWikiArticleUrl(entry.loc))
    .map((entry) => {
      const url = normalizeUrl(entry.loc);
      const publishedAt = entry.lastmod || isoDay(now);
      return buildTrackingSeedRow({
        slug: slugFromEnWikiUrl(url),
        url,
        title: titleFromSlug(slugFromEnWikiUrl(url)),
        publishedAt,
        firstTrackedAt: publishedAt,
        now,
        source: 'live-sitemap',
      });
    });
}

export async function fetchEnWikiSitemapRows(sitemapUrl = DEFAULT_SITEMAP_URL, { fetcher = fetch, now = new Date() } = {}) {
  const res = await fetcher(sitemapUrl);
  if (!res.ok) throw new Error(`sitemap fetch failed (${res.status}): ${await res.text()}`);
  const xml = await res.text();
  return extractEnWikiSitemapRows(xml, { now });
}

export function buildTrackingSeedRow({
  pageId,
  slug,
  url,
  title = '',
  publishedAt,
  firstTrackedAt,
  now = new Date(),
  source = 'seo-autopilot',
  site = DEFAULT_SITE,
} = {}) {
  if (!pageId && !slug && !url) throw new Error('buildTrackingSeedRow: pageId, slug, or url required');
  const day = isoDay(now);
  const finalUrl = url || `${siteOrigin(site)}/en/wiki/${slug}`;
  return {
    url: finalUrl,
    page_id: pageId || '',
    slug: slug || '',
    title: cleanCell(title),
    published_at: publishedAt || day,
    first_tracked_at: firstTrackedAt || day,
    last_checked_at: '',
    check_count: 0,
    days_since_first_tracked: 0,
    current_gsc_status: 'pending_first_check',
    gsc_verdict: '',
    indexing_state: '',
    page_fetch_state: '',
    last_crawl_time: '',
    google_canonical: '',
    user_canonical: '',
    monitor_status: 'monitoring',
    first_indexed_at: '',
    days_to_index: '',
    diagnosis_category: '',
    alert_level: '',
    alert_sent_at: '',
    fix_status: '已提交',
    retry_round: 0,
    fixed_detected_at: '',
    resubmitted_at: '',
    next_check_after: '',
    recommendation: '',
    notes: '',
    source,
  };
}

export function rowToSheetValues(row) {
  return INDEX_TRACKING_HEADER.map((h) => {
    const v = row?.[h];
    return v == null ? '' : v;
  });
}

export function sheetValuesToRow(values = [], rowNumber = null) {
  const row = {};
  INDEX_TRACKING_HEADER.forEach((h, i) => { row[h] = values[i] ?? ''; });
  if (rowNumber != null) row._rowNumber = rowNumber;
  return row;
}

function recapValuesToRow(values = [], rowNumber = null) {
  const row = {};
  RECAP_HEADER.forEach((h, i) => { row[h] = values[i] ?? ''; });
  if (rowNumber != null) row._rowNumber = rowNumber;
  return row;
}

function requestQueueValuesToRow(values = [], rowNumber = null) {
  const row = {};
  REQUEST_INDEXING_QUEUE_HEADER.forEach((h, i) => { row[h] = values[i] ?? ''; });
  if (rowNumber != null) row._rowNumber = rowNumber;
  return row;
}

function urlInventoryValuesToRow(values = [], rowNumber = null) {
  const row = {};
  URL_INVENTORY_HEADER.forEach((h, i) => { row[h] = values[i] ?? ''; });
  if (rowNumber != null) row._rowNumber = rowNumber;
  return row;
}

function recapRowToValues(row) {
  return RECAP_HEADER.map((h) => {
    const v = row?.[h];
    return v == null ? '' : v;
  });
}

function requestQueueRowToValues(row) {
  return REQUEST_INDEXING_QUEUE_HEADER.map((h) => {
    const v = row?.[h];
    return v == null ? '' : v;
  });
}

function urlInventoryRowToValues(row) {
  return URL_INVENTORY_HEADER.map((h) => {
    const v = row?.[h];
    return v == null ? '' : v;
  });
}

function trackingComparable(row) {
  const copy = { ...row };
  delete copy._rowNumber;
  return JSON.stringify(rowToSheetValues(copy));
}

function recapComparable(row) {
  const copy = { ...row };
  delete copy._rowNumber;
  return JSON.stringify(recapRowToValues(copy));
}

export function mergePublishedTrackingRow(existing = {}, fresh = {}) {
  return {
    ...existing,
    url: fresh.url || existing.url || '',
    page_id: fresh.page_id || existing.page_id || '',
    slug: fresh.slug || existing.slug || '',
    title: fresh.title || existing.title || '',
    published_at: fresh.published_at || existing.published_at || '',
    first_tracked_at: existing.first_tracked_at || fresh.first_tracked_at || fresh.published_at || '',
    current_gsc_status: existing.current_gsc_status || fresh.current_gsc_status || 'pending_first_check',
    monitor_status: existing.monitor_status || fresh.monitor_status || 'monitoring',
    fix_status: existing.fix_status || fresh.fix_status || '已提交',
    source: fresh.source || existing.source || '',
  };
}

function recapOutcomeId(row = {}) {
  const pageId = String(row.page_id || '').trim();
  if (pageId) return `out_${pageId}_latest`;
  const slug = slugFromEnWikiUrl(row.url);
  return `out_${slug || 'unknown'}_latest`;
}

function isIndexedTrackingRow(row = {}) {
  const status = String(row.current_gsc_status || '');
  const verdict = String(row.gsc_verdict || '');
  const monitor = String(row.monitor_status || '');
  const canonicalDuplicate = /alternate page with proper canonical tag|duplicate|canonical/i.test(status);
  return monitor === 'indexed' || (
    !canonicalDuplicate &&
    (verdict === 'PASS' || /\bindexed\b/i.test(status)) &&
    !/not indexed/i.test(status)
  );
}

function lifecycleFixStatus(row = {}, classification = {}) {
  const monitor = String(classification.monitor_status || row.monitor_status || '').trim();
  const alert = String(classification.alert_level || row.alert_level || '').trim();
  if (monitor === 'indexed') return '✅ 已收录';
  if (monitor === 'urgent') return '🔴 紧急问题（404/5xx）';
  if (monitor === 'needs_focus') return '需重点关注';
  if (monitor === 'needs_attention' && alert === 'P3') return 'P3 观察';
  if (monitor === 'needs_attention') return '⚠️ 超期未收录（触发诊断）';
  if (monitor === 'monitoring') return '监控中';
  return row.fix_status || '已提交';
}

function hasInspectionEvidence(row = {}) {
  const status = String(row.current_gsc_status || '').trim();
  return !!status && status !== 'pending_first_check';
}

export function recapRowFromTrackingRow(row = {}, { now = new Date(), clusterByPage = null } = {}) {
  const checked = hasInspectionEvidence(row);
  const indexed = isIndexedTrackingRow(row);
  const status = String(row.current_gsc_status || '').trim();
  const monitor = String(row.monitor_status || '').trim();
  const diagnosis = String(row.diagnosis_category || '').trim();
  const alert = String(row.alert_level || '').trim();
  const repairStatus = String(row.fix_status || '').trim();
  const repairDisplayStatus = ['已修复', '已重新提交'].includes(repairStatus) ? repairStatus : '';
  const attention = ['urgent', 'needs_focus', 'needs_attention'].includes(monitor);
  const fixStatus = attention
    ? lifecycleFixStatus(row, { monitor_status: monitor, diagnosis_category: diagnosis, alert_level: alert })
    : indexed
      ? '已收录'
      : repairDisplayStatus
      ? repairDisplayStatus
      : !checked
        ? '待GSC检查'
        : lifecycleFixStatus(row, { monitor_status: monitor, diagnosis_category: diagnosis, alert_level: alert });
  const noteParts = [
    'GSC URL Inspection',
    status ? `status=${status}` : 'status=pending',
    row.gsc_verdict ? `verdict=${row.gsc_verdict}` : '',
    row.last_checked_at ? `checked=${row.last_checked_at}` : '',
    row.source ? `source=${row.source}` : '',
  ].filter(Boolean);
  return {
    outcome_id: recapOutcomeId(row),
    page_id: row.page_id || '',
    cluster_id:
      (clusterByPage && row.page_id && clusterByPage.get(row.page_id)) ||
      row.cluster_id ||
      '',
    url: row.url || '',
    'day14_收录': checked ? (indexed ? 'Y' : 'N') : '',
    '申请时间': '',
    '索引修复状态': fixStatus,
    day14_impressions: '',
    '记录日期': isoDay(now),
    'day30_进Top50词数': '',
    '当前最高排名词（排名）': '',
    day30_clicks: '',
    day60_pv: '',
    'day60_目标国pv': '',
    '决策': '',
    '备注': noteParts.join(' | '),
  };
}

function searchConsoleInspectionUrl(_url, site = DEFAULT_SITE) {
  return `https://search.google.com/search-console?resource_id=${encodeURIComponent(site)}`;
}

function requestPriority({ recap = {}, tracking = {} } = {}) {
  const fix = String(recap['索引修复状态'] || '').toLowerCase();
  const diagnosis = String(tracking.diagnosis_category || '').toLowerCase();
  const monitor = String(tracking.monitor_status || '').toLowerCase();
  const status = String(tracking.current_gsc_status || '').toLowerCase();
  const alert = String(tracking.alert_level || '').toUpperCase();
  const age = Number(tracking.days_since_first_tracked || 0);

  if (/^P[0-3]$/.test(alert)) return alert;
  if (monitor === 'urgent' || /technical|robots|noindex|blocked|404|5xx|技术故障|配置错误|标签问题/.test(`${fix} ${diagnosis} ${status}`)) return 'P0';
  if (monitor === 'needs_focus' || /content_quality|unknown_attention|内容质量|未知状态/.test(`${fix} ${diagnosis}`) || age >= 21) return 'P1';
  if (/canonical_duplicate|normal_queue|discovered|crawled - currently not indexed|canonical|重复内容|正常排队/.test(`${fix} ${diagnosis} ${status}`)) return 'P2';
  return 'P3';
}

function requestReason({ recap = {}, tracking = {} } = {}) {
  const status = String(tracking.current_gsc_status || '').trim();
  const diagnosis = String(tracking.diagnosis_category || '').trim();
  if (/URL is unknown to Google/i.test(status) || /unknown_attention|未知状态/.test(diagnosis)) {
    return 'Google 尚未知该 URL；已通过 sitemap/discovery 提醒，建议人工 Request Indexing。';
  }
  if (/Crawled - currently not indexed/i.test(status) || /content_quality|内容质量/.test(diagnosis)) {
    return 'Google 已抓取但暂未收录；检查内容/内链后可人工 Request Indexing。';
  }
  if (/canonical|duplicate/i.test(status) || /canonical_duplicate|重复内容/.test(diagnosis)) {
    return 'Google 选择了不同 canonical；先确认 canonical/重复内容，再决定是否 Request Indexing。';
  }
  if (String(recap['day14_收录'] || '') === 'N') {
    return 'Day14 仍未收录；进入人工 Request Indexing 候选队列。';
  }
  return '未收录候选；请复核 GSC 状态后处理。';
}

function discoveryActions({ priority, tracking = {} } = {}) {
  const status = String(tracking.current_gsc_status || '');
  const diagnosis = String(tracking.diagnosis_category || '');
  const actions = ['官方 Sitemaps API 刷新 sitemap'];
  if (/unknown/i.test(status)) actions.push('补强站内发现入口/内链');
  if (/other 4xx/i.test(status) || /4xx/.test(diagnosis)) actions.push('先修访问权限或 4xx 状态，再提交');
  if (/Crawled - currently not indexed/i.test(status) || /内容质量/.test(diagnosis)) actions.push('复查内容质量、重复覆盖和 HTML 可抓取性');
  if (/canonical|duplicate/i.test(status) || /重复内容/.test(diagnosis)) actions.push('复查 canonical 与重复 URL 选择');
  if (priority === 'P0') actions.push('先修技术阻断，再提交');
  actions.push('Computer Use 打开 GSC，最终 Request Indexing 点击需人工确认');
  return actions.join('；');
}

export function buildRequestIndexingCandidateRows({
  recapRows = [],
  trackingRows = [],
  existingRows = [],
  now = new Date(),
  siteUrl = DEFAULT_SITE,
} = {}) {
  const day = isoDay(now);
  const trackingByUrl = new Map(trackingRows.map((row) => [normalizeUrl(row.url), row]));
  const existingByPage = new Map(existingRows.map((row) => [String(row.page_id || '').trim(), row]));
  const rows = [];

  for (const recap of recapRows) {
    const pageId = String(recap.page_id || '').trim();
    const url = normalizeUrl(recap.url);
    if (!pageId || !isEnWikiArticleUrl(url)) continue;
    const indexed = String(recap['day14_收录'] || '').trim() === 'Y' || String(recap['索引修复状态'] || '').trim() === '已收录';
    if (indexed) continue;

    const tracking = trackingByUrl.get(url) || {};
    const priority = requestPriority({ recap, tracking });
    const existing = existingByPage.get(pageId) || {};
    const title = tracking.title || titleFromSlug(slugFromEnWikiUrl(url));
    rows.push({
      candidate_id: `req_${pageId}`,
      priority,
      page_id: pageId,
      url,
      title,
      'day14_收录': recap['day14_收录'] || '',
      gsc_status: tracking.current_gsc_status || recap['索引修复状态'] || '',
      diagnosis_category: tracking.diagnosis_category || '',
      monitor_status: tracking.monitor_status || '',
      first_tracked_at: tracking.first_tracked_at || '',
      last_checked_at: tracking.last_checked_at || '',
      days_since_first_tracked: tracking.days_since_first_tracked || '',
      discovery_status: 'sitemap已刷新',
      discovery_actions: discoveryActions({ priority, tracking }),
      request_reason: requestReason({ recap, tracking }),
      gsc_inspection_url: searchConsoleInspectionUrl(url, siteUrl),
      computer_use_status: existing.computer_use_status || '待人工确认',
      computer_use_instruction: 'Computer Use 可打开 gsc_inspection_url，复制本行 url 列到顶部 URL Inspection 搜索框；看到 Request Indexing 前必须停下等待人工确认。',
      created_at: existing.created_at || day,
      updated_at: day,
      notes: existing.notes || '',
    });
  }

  const rank = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return rows.sort((a, b) => (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9) ||
    Number(b.days_since_first_tracked || 0) - Number(a.days_since_first_tracked || 0) ||
    String(a.page_id).localeCompare(String(b.page_id)));
}

function hasRequestSubmissionEvidence({ recap = {}, tracking = {}, queue = {} } = {}) {
  const applicationTime = String(recap['申请时间'] || '').trim();
  const queueStatus = String(queue.computer_use_status || '').trim();
  return (
    (!!applicationTime && !['未申请', '待申请', '待提交', ''].includes(applicationTime)) ||
    ['已提交', '已重新提交'].includes(queueStatus) ||
    !!String(tracking.resubmitted_at || '').trim()
  );
}

function hasAnyInventoryCoverage({ recap = {}, tracking = {}, queue = {} } = {}) {
  return !!(recap.url || recap.page_id || tracking.url || tracking.page_id || queue.url || queue.page_id || queue.candidate_id);
}

export function buildUrlInventoryRows({
  sitemapRows = [],
  trackingRows = [],
  recapRows = [],
  requestQueueRows = [],
  now = new Date(),
  siteUrl = DEFAULT_SITE,
} = {}) {
  const day = isoDay(now);
  const trackingByUrl = new Map(trackingRows.map((row) => [normalizeUrl(row.url), row]));
  const recapByUrl = new Map(recapRows.map((row) => [normalizeUrl(row.url), row]));
  const queueByUrl = new Map(requestQueueRows.map((row) => [normalizeUrl(row.url), row]));
  const seen = new Set();
  const rows = [];

  for (const base of sitemapRows) {
    const url = normalizeUrl(base.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const tracking = trackingByUrl.get(url) || {};
    const recap = recapByUrl.get(url) || {};
    const queue = queueByUrl.get(url) || {};
    const pageId = tracking.page_id || recap.page_id || queue.page_id || base.page_id || '';
    const indexed = isIndexedTrackingRow(tracking) ||
      String(recap['day14_收录'] || '').trim() === 'Y' ||
      String(recap['索引修复状态'] || '').trim() === '已收录';
    const submitted = hasRequestSubmissionEvidence({ recap, tracking, queue });
    const covered = hasAnyInventoryCoverage({ recap, tracking, queue });
    const inventoryStatus = indexed
      ? '已收录'
      : submitted
        ? '已提交但未收录'
        : covered
          ? '已纳入但未提交'
          : '未纳入监控';

    rows.push({
      url,
      path_family: base.path_family || inventoryPathFamily(url),
      title: tracking.title || base.title || titleFromInventoryUrl(url),
      source: base.source || 'live-sitemap',
      sitemap_lastmod: base.sitemap_lastmod || base.lastmod || '',
      page_id: pageId,
      inventory_status: inventoryStatus,
      request_queue_allowed: base.request_queue_allowed || requestQueueAllowedForPathFamily(base.path_family || inventoryPathFamily(url)),
      tracking_status: tracking.monitor_status || '',
      request_queue_status: queue.computer_use_status || '',
      recap_status: recap['索引修复状态'] || '',
      current_gsc_status: tracking.current_gsc_status || '',
      first_tracked_at: tracking.first_tracked_at || '',
      last_checked_at: tracking.last_checked_at || '',
      gsc_inspection_url: searchConsoleInspectionUrl(url, siteUrl),
      updated_at: day,
      notes: covered ? '' : 'sitemap存在但当前自动化未追踪；第一阶段仅对账，不自动提交',
    });
  }

  return rows;
}

function mergeRecapRow(existing = {}, fresh = {}) {
  const existingNote = String(existing['备注'] || '').trim();
  const freshNote = String(fresh['备注'] || '').trim();
  const noteIsAutoGenerated = !existingNote || existingNote.startsWith('GSC URL Inspection');
  return {
    ...existing,
    outcome_id: existing.outcome_id || fresh.outcome_id || '',
    page_id: existing.page_id || fresh.page_id || '',
    cluster_id: existing.cluster_id || fresh.cluster_id || '',
    url: fresh.url || existing.url || '',
    'day14_收录': Object.hasOwn(fresh, 'day14_收录') ? fresh['day14_收录'] : existing['day14_收录'] || '',
    '索引修复状态': Object.hasOwn(fresh, '索引修复状态') ? fresh['索引修复状态'] : existing['索引修复状态'] || '',
    '记录日期': Object.hasOwn(fresh, '记录日期') ? fresh['记录日期'] : existing['记录日期'] || '',
    '备注': noteIsAutoGenerated ? freshNote : existingNote,
  };
}

function checklist(items = []) {
  return items
    .filter(Boolean)
    .map((item) => {
      const s = String(item).trim();
      return s.startsWith('□') ? `  ${s}` : `  □ ${s}`;
    })
    .join('\n');
}

function contentQualityChecklist(pageDiagnostics = {}) {
  const wordCount = pageDiagnostics.word_count === '' || pageDiagnostics.word_count == null
    ? '未知'
    : String(pageDiagnostics.word_count);
  const meta = pageDiagnostics.meta_robots
    ? `检查 meta robots（当前：${pageDiagnostics.meta_robots}）`
    : '检查 meta robots 标签（当前未检测到 robots meta）';
  const author = pageDiagnostics.has_author === true
    ? '确认 author 字段存在'
    : '确认 author 字段和发布日期存在';
  const published = pageDiagnostics.has_published_time === true
    ? '确认发布日期存在'
    : '';
  return checklist([
    `检查字数（当前 ${wordCount}，目标 ≥ 1,200 词）`,
    meta,
    '确认至少 2 条来自已收录页面的内链',
    '检查是否与站内其他页面内容高度重复',
    author,
    published,
  ]);
}

function frameworkRecommendation(status) {
  return checklist([
    `查看原始 GSC 状态：${status || '-'}`,
    `按分类框架人工判断：${DIAGNOSIS_FRAMEWORK_URL}`,
  ]);
}

function robotsRecommendation(pageDiagnostics = {}) {
  const robots = pageDiagnostics.robots_txt
    ? pageDiagnostics.robots_txt
    : '(robots.txt 内容未抓取到，请人工打开 /robots.txt 确认)';
  return checklist([
    '立即检查 robots.txt 是否误封 Googlebot',
    `robots.txt 当前内容：\n${robots}`,
  ]);
}

export function classifyInspection(indexStatus = {}, { daysSinceFirstTracked = 0, now = new Date(), pageDiagnostics = {} } = {}) {
  const coverageState = String(indexStatus.coverageState || '').trim();
  const verdict = String(indexStatus.verdict || '').trim();
  const indexingState = String(indexStatus.indexingState || '').trim();
  const pageFetchState = String(indexStatus.pageFetchState || '').trim();
  const lc = coverageState.toLowerCase();
  const checkedDay = isoDay(now);
  const base = {
    monitor_status: 'monitoring',
    diagnosis_category: 'monitoring',
    diagnosis_conclusion: '监控中',
    alert_level: '',
    should_alert: false,
    first_indexed_at: '',
    recommendation: checklist(['继续监控。']),
  };

  const canonicalDuplicate = /alternate page with proper canonical tag|duplicate|canonical/i.test(coverageState);
  if (/indexed,?\s+though blocked by robots\.txt/i.test(coverageState)) {
    return {
      ...base,
      monitor_status: 'needs_attention',
      diagnosis_category: '已收录但 robots.txt 屏蔽',
      diagnosis_conclusion: '已收录但 robots.txt 屏蔽',
      alert_level: 'P3',
      should_alert: true,
      first_indexed_at: checkedDay,
      recommendation: checklist([
        '已收录但 robots.txt 存在屏蔽规则，核查是否有意保留',
        '确认 robots.txt 是否需要更新，避免后续状态不一致或回退',
        pageDiagnostics.robots_txt ? `robots.txt 当前内容：\n${pageDiagnostics.robots_txt}` : '',
      ]),
    };
  }

  const looksIndexed = (verdict === 'PASS' || /\bindexed\b/i.test(coverageState)) &&
    !/not indexed/i.test(coverageState) &&
    !canonicalDuplicate;
  if (looksIndexed) {
    return {
      ...base,
      monitor_status: 'indexed',
      diagnosis_category: 'indexed',
      diagnosis_conclusion: '已收录',
      first_indexed_at: checkedDay,
      recommendation: checklist(['已收录，停止监控；仅在状态回退时重新进入监控。']),
    };
  }

  if (/not found \(404\)|server error \(5xx\)|blocked due to access forbidden \(403\)/i.test(coverageState)) {
    return {
      ...base,
      monitor_status: 'urgent',
      diagnosis_category: '技术故障',
      diagnosis_conclusion: '技术故障',
      alert_level: 'P0',
      should_alert: true,
      recommendation: checklist([
        '立即处理：恢复 URL、修复 404/5xx/403，或确认是否应从追踪中移除',
        '修复后重新检查 URL Inspection，并确认页面可被 Googlebot 抓取',
      ]),
    };
  }

  if (/blocked by robots\.txt/i.test(coverageState)) {
    return {
      ...base,
      monitor_status: 'urgent',
      diagnosis_category: '配置错误（大概率无意）',
      diagnosis_conclusion: 'robots.txt 阻挡',
      alert_level: 'P0',
      should_alert: true,
      recommendation: robotsRecommendation(pageDiagnostics),
    };
  }

  if (/excluded by ['’]?noindex['’]? tag/i.test(coverageState)) {
    return {
      ...base,
      monitor_status: 'needs_attention',
      diagnosis_category: '标签问题（需人工确认是否有意）',
      diagnosis_conclusion: 'noindex 标签阻挡',
      alert_level: 'P1',
      should_alert: true,
      recommendation: checklist([
        '确认是否有意设置 noindex',
        `当前 meta robots：${pageDiagnostics.meta_robots || '未抓取到，需人工确认'}`,
        '如非有意，修复模板或页面 head 后再进入 request-indexing-queue',
      ]),
    };
  }

  if (/blocked due to other 4xx/i.test(coverageState)) {
    return {
      ...base,
      monitor_status: 'needs_attention',
      diagnosis_category: '访问权限或 4xx 问题',
      diagnosis_conclusion: '访问权限或 4xx 问题',
      alert_level: 'P1',
      should_alert: true,
      recommendation: checklist([
        '根据实际 HTTP 状态排查：401 检查权限配置；410 确认是否误删或应移出追踪',
        '确认未登录访问和 Googlebot 抓取路径可访问',
        '修复后重新检查 URL Inspection，并进入 request-indexing-queue',
      ]),
    };
  }

  if (lc.includes('crawled - currently not indexed')) {
    if (daysSinceFirstTracked >= 30) {
      return {
        ...base,
        monitor_status: 'needs_focus',
        diagnosis_category: '内容质量问题',
        diagnosis_conclusion: '内容质量不足',
        alert_level: 'P1',
        should_alert: true,
        recommendation: `${checklist(['D+30 仍未收录，升级为重点 URL'])}\n${contentQualityChecklist(pageDiagnostics)}`,
      };
    }
    const overdue = daysSinceFirstTracked >= 14;
    return {
      ...base,
      monitor_status: overdue ? 'needs_attention' : 'monitoring',
      diagnosis_category: '内容质量问题',
      diagnosis_conclusion: overdue ? '内容质量不足' : '观察中',
      alert_level: overdue ? 'P1' : '',
      should_alert: overdue,
      recommendation: overdue
        ? contentQualityChecklist(pageDiagnostics)
        : checklist(['D+14 前继续观察；到期后检查内容质量、内链、重复度和可抓取 HTML。']),
    };
  }

  if (lc.includes('discovered - currently not indexed')) {
    if (daysSinceFirstTracked >= 30) {
      return {
        ...base,
        monitor_status: 'needs_focus',
        diagnosis_category: '正常排队（新站常见）',
        diagnosis_conclusion: '排队超时',
        alert_level: 'P1',
        should_alert: true,
        recommendation: checklist([
          'D+30 仍未收录，升级为重点 URL',
          '加强来自已收录页面的内链，确认 sitemap 和页面 HTML 可抓取',
        ]),
      };
    }
    const overdue = daysSinceFirstTracked >= 21;
    return {
      ...base,
      monitor_status: overdue ? 'needs_attention' : 'monitoring',
      diagnosis_category: '正常排队（新站常见）',
      diagnosis_conclusion: overdue ? '排队超时' : '正常排队，继续监控至 D+21',
      alert_level: overdue ? 'P2' : '',
      should_alert: overdue,
      recommendation: overdue
        ? checklist(['D+21 仍未收录，补充内链并确认 sitemap discovery 信号。'])
        : checklist(['正常排队（新站常见），继续监控至 D+21；D+14 不推送噪音告警。']),
    };
  }

  if (canonicalDuplicate) {
    if (daysSinceFirstTracked >= 30) {
      return {
        ...base,
        monitor_status: 'needs_focus',
        diagnosis_category: '重复内容 / canonical 问题',
        diagnosis_conclusion: '重复内容或 canonical 异常',
        alert_level: 'P2',
        should_alert: true,
        recommendation: checklist([
          '检查 canonical 标签是否指向预期 URL',
          '检查页面与站内其他页面的主题和正文重复度',
          '确认 sitemap 中保留的是希望被收录的 canonical URL',
        ]),
      };
    }
    return {
      ...base,
      monitor_status: daysSinceFirstTracked >= 14 ? 'needs_attention' : 'monitoring',
      diagnosis_category: '重复内容 / canonical 问题',
      diagnosis_conclusion: '重复内容或 canonical 异常',
      alert_level: daysSinceFirstTracked >= 14 ? 'P2' : '',
      should_alert: daysSinceFirstTracked >= 14,
      recommendation: checklist([
        '检查 canonical 标签和页面重复度',
        '对比 Google canonical 与 user canonical',
        '必要时合并/改写重复内容，保留唯一目标 URL',
      ]),
    };
  }

  if (/soft 404|page with redirect/i.test(coverageState)) {
    return {
      ...base,
      monitor_status: 'needs_attention',
      diagnosis_category: '索引配置问题',
      diagnosis_conclusion: '索引配置异常',
      alert_level: 'P2',
      should_alert: true,
      recommendation: checklist([
        '检查页面正文是否过薄或像错误页',
        '检查 HTTP 状态、跳转链和 canonical 是否一致',
      ]),
    };
  }

  const overdue = daysSinceFirstTracked >= 14 || verdict === 'FAIL' || pageFetchState === 'FAILED';
  return {
    ...base,
    monitor_status: overdue ? 'needs_attention' : 'monitoring',
    diagnosis_category: overdue ? '未知状态' : '等待观察',
    diagnosis_conclusion: overdue ? '未知状态，需人工判断' : '等待观察',
    alert_level: overdue ? 'P3' : '',
    should_alert: overdue,
    recommendation: overdue
      ? frameworkRecommendation(coverageState)
      : checklist(['继续监控。']),
    indexing_state: indexingState,
  };
}

export function isDueForInspection(row = {}, now = new Date()) {
  if (String(row.monitor_status || 'monitoring') === 'indexed') return false;
  if (!row.first_tracked_at) return false;
  const today = isoDay(now);
  if (row.last_checked_at === today) return false;
  if (row.next_check_after && row.next_check_after <= today) return true;

  const age = daysBetween(row.first_tracked_at, now);
  const lastAge = row.last_checked_at ? daysBetween(row.first_tracked_at, `${row.last_checked_at}T00:00:00Z`) : -1;
  return DUE_MILESTONES.some((m) => age >= m && lastAge < m);
}

function colLetter(idxZero) {
  let n = idxZero + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

async function readHeader(token, workbookId, tabName) {
  try {
    const last = colLetter(INDEX_TRACKING_HEADER.length - 1);
    const body = await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(`${tabName}!A1:${last}1`)}`,
      token,
    );
    return (body.values?.[0] || []).map((h) => String(h || '').trim());
  } catch {
    return [];
  }
}

async function writeHeader(token, workbookId, tabName) {
  return gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(`${tabName}!A1`)}?valueInputOption=RAW`,
    token,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: [INDEX_TRACKING_HEADER] }),
    },
  );
}

async function readRequestQueueHeader(token, workbookId, tabName = REQUEST_INDEXING_QUEUE_TAB) {
  try {
    const last = colLetter(REQUEST_INDEXING_QUEUE_HEADER.length - 1);
    const body = await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(`${tabName}!A1:${last}1`)}`,
      token,
    );
    return (body.values?.[0] || []).map((h) => String(h || '').trim());
  } catch {
    return [];
  }
}

async function writeRequestQueueHeader(token, workbookId, tabName = REQUEST_INDEXING_QUEUE_TAB) {
  return gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(`${tabName}!A1`)}?valueInputOption=RAW`,
    token,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: [REQUEST_INDEXING_QUEUE_HEADER] }),
    },
  );
}

async function readUrlInventoryHeader(token, workbookId, tabName = URL_INVENTORY_TAB) {
  try {
    const last = colLetter(URL_INVENTORY_HEADER.length - 1);
    const body = await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(`${tabName}!A1:${last}1`)}`,
      token,
    );
    return (body.values?.[0] || []).map((h) => String(h || '').trim());
  } catch {
    return [];
  }
}

async function writeUrlInventoryHeader(token, workbookId, tabName = URL_INVENTORY_TAB) {
  return gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(`${tabName}!A1`)}?valueInputOption=RAW`,
    token,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: [URL_INVENTORY_HEADER] }),
    },
  );
}

export async function ensureIndexTrackingTab(token, workbookId, deps = {}) {
  const fetcher = deps.gFetch || gFetch;
  const meta = await fetcher(`https://sheets.googleapis.com/v4/spreadsheets/${workbookId}?includeGridData=false`, token);
  const sheets = meta.sheets || [];
  const has = sheets.some((s) => s.properties?.title === INDEX_TRACKING_TAB);
  if (!has) {
    await fetcher(
      `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}:batchUpdate`,
      token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: INDEX_TRACKING_TAB } } }] }),
      },
    );
  }
  const header = deps.readHeader
    ? await deps.readHeader(token, workbookId, INDEX_TRACKING_TAB)
    : await readHeader(token, workbookId, INDEX_TRACKING_TAB);
  const matches = INDEX_TRACKING_HEADER.every((h, i) => header[i] === h);
  if (!matches) {
    if (deps.writeHeader) await deps.writeHeader(token, workbookId, INDEX_TRACKING_TAB);
    else await writeHeader(token, workbookId, INDEX_TRACKING_TAB);
  }
  return INDEX_TRACKING_TAB;
}

export async function ensureRequestQueueTab(token, workbookId, deps = {}) {
  const fetcher = deps.gFetch || gFetch;
  const meta = await fetcher(`https://sheets.googleapis.com/v4/spreadsheets/${workbookId}?includeGridData=false`, token);
  const sheets = meta.sheets || [];
  const has = sheets.some((s) => s.properties?.title === REQUEST_INDEXING_QUEUE_TAB);
  if (!has) {
    await fetcher(
      `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}:batchUpdate`,
      token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: REQUEST_INDEXING_QUEUE_TAB } } }] }),
      },
    );
  }
  const header = deps.readHeader
    ? await deps.readHeader(token, workbookId, REQUEST_INDEXING_QUEUE_TAB)
    : await readRequestQueueHeader(token, workbookId, REQUEST_INDEXING_QUEUE_TAB);
  const matches = REQUEST_INDEXING_QUEUE_HEADER.every((h, i) => header[i] === h);
  if (!matches) {
    if (deps.writeHeader) await deps.writeHeader(token, workbookId, REQUEST_INDEXING_QUEUE_TAB);
    else await writeRequestQueueHeader(token, workbookId, REQUEST_INDEXING_QUEUE_TAB);
  }
  return REQUEST_INDEXING_QUEUE_TAB;
}

export async function ensureUrlInventoryTab(token, workbookId, deps = {}) {
  const fetcher = deps.gFetch || gFetch;
  const meta = await fetcher(`https://sheets.googleapis.com/v4/spreadsheets/${workbookId}?includeGridData=false`, token);
  const sheets = meta.sheets || [];
  const has = sheets.some((s) => s.properties?.title === URL_INVENTORY_TAB);
  if (!has) {
    await fetcher(
      `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}:batchUpdate`,
      token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: URL_INVENTORY_TAB } } }] }),
      },
    );
  }
  const header = deps.readHeader
    ? await deps.readHeader(token, workbookId, URL_INVENTORY_TAB)
    : await readUrlInventoryHeader(token, workbookId, URL_INVENTORY_TAB);
  const matches = URL_INVENTORY_HEADER.every((h, i) => header[i] === h);
  if (!matches) {
    if (deps.writeHeader) await deps.writeHeader(token, workbookId, URL_INVENTORY_TAB);
    else await writeUrlInventoryHeader(token, workbookId, URL_INVENTORY_TAB);
  }
  return URL_INVENTORY_TAB;
}

export async function readTrackingRows(token, workbookId, tabName = INDEX_TRACKING_TAB) {
  const last = colLetter(INDEX_TRACKING_HEADER.length - 1);
  const body = await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(`${tabName}!A2:${last}2000`)}`,
    token,
  );
  return (body.values || [])
    .map((values, i) => sheetValuesToRow(values, i + 2))
    .filter((row) => row.url || row.page_id);
}

// page_id → cluster_id from 选题登记表, so recap seeds carry the cluster (the
// index-tracking tab has no cluster_id column, so recap rows would otherwise
// ship with an empty cluster_id and cluster-level rollups break). Best-effort:
// returns an empty Map on any error / missing columns.
export async function readTopicClusterMap(token, workbookId, tabName = '选题登记表') {
  try {
    const body = await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(`${tabName}!A1:AZ2000`)}`,
      token,
    );
    const rows = body.values || [];
    const header = rows[0] || [];
    const iPage = header.findIndex((h) => /page_id/i.test(String(h).trim()));
    const iCluster = header.findIndex((h) => /cluster_id/i.test(String(h).trim()));
    if (iPage < 0 || iCluster < 0) return new Map();
    const map = new Map();
    for (let r = 1; r < rows.length; r++) {
      const pid = String((rows[r] || [])[iPage] || '').trim();
      const cid = String((rows[r] || [])[iCluster] || '').trim();
      if (pid && cid) map.set(pid, cid);
    }
    return map;
  } catch {
    return new Map();
  }
}

export async function readRequestQueueRows(token, workbookId, tabName = REQUEST_INDEXING_QUEUE_TAB) {
  const last = colLetter(REQUEST_INDEXING_QUEUE_HEADER.length - 1);
  const body = await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(`${tabName}!A2:${last}2000`)}`,
    token,
  );
  return (body.values || [])
    .map((values, i) => requestQueueValuesToRow(values, i + 2))
    .filter((row) => row.url || row.page_id || row.candidate_id);
}

export async function readUrlInventoryRows(token, workbookId, tabName = URL_INVENTORY_TAB) {
  const last = colLetter(URL_INVENTORY_HEADER.length - 1);
  const body = await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(`${tabName}!A2:${last}3000`)}`,
    token,
  );
  return (body.values || [])
    .map((values, i) => urlInventoryValuesToRow(values, i + 2))
    .filter((row) => row.url);
}

export async function appendTrackingRows(token, workbookId, tabName, rows) {
  if (!rows.length) return { updates: { updatedRows: 0 } };
  return gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(`${tabName}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: rows.map(rowToSheetValues) }),
    },
  );
}

export async function replaceUrlInventoryRows(token, workbookId, tabName, rows) {
  const last = colLetter(URL_INVENTORY_HEADER.length - 1);
  await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(`${tabName}!A2:${last}3000`)}:clear`,
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    },
  );
  if (!rows.length) return { updatedRows: 0 };
  return gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(`${tabName}!A2:${last}${rows.length + 1}`)}?valueInputOption=RAW`,
    token,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: rows.map(urlInventoryRowToValues) }),
    },
  );
}

export async function replaceRequestQueueRows(token, workbookId, tabName, rows) {
  const last = colLetter(REQUEST_INDEXING_QUEUE_HEADER.length - 1);
  await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(`${tabName}!A2:${last}2000`)}:clear`,
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    },
  );
  if (!rows.length) return { updatedRows: 0 };
  return gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(`${tabName}!A2:${last}${rows.length + 1}`)}?valueInputOption=RAW`,
    token,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: rows.map(requestQueueRowToValues) }),
    },
  );
}

export async function formatRequestQueueTab(token, workbookId, tabName = REQUEST_INDEXING_QUEUE_TAB) {
  const meta = await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}?includeGridData=false&fields=sheets(properties(sheetId,title),conditionalFormats)`,
    token,
  );
  const sheet = (meta.sheets || []).find((s) => s.properties?.title === tabName);
  if (!sheet) throw new Error(`tab not found: ${tabName}`);
  const sheetId = sheet.properties.sheetId;
  const priorityCol = REQUEST_INDEXING_QUEUE_HEADER.indexOf('priority');
  const computerUseCol = REQUEST_INDEXING_QUEUE_HEADER.indexOf('computer_use_status');
  const existing = sheet.conditionalFormats || [];
  const isPriorityRule = (rule) =>
    (rule.ranges || []).some((range) =>
      range.sheetId === sheetId &&
      range.startRowIndex === 1 &&
      range.startColumnIndex === priorityCol &&
      range.endColumnIndex === priorityCol + 1) &&
    rule.booleanRule?.condition?.type === 'TEXT_EQ';
  const requests = [];
  existing.forEach((rule, index) => {
    if (isPriorityRule(rule)) requests.push({ deleteConditionalFormatRule: { sheetId, index } });
  });
  requests.sort((a, b) => b.deleteConditionalFormatRule.index - a.deleteConditionalFormatRule.index);

  const formats = [
    ['P0', { red: 0.85, green: 0.18, blue: 0.18 }, { red: 1.0, green: 0.88, blue: 0.88 }],
    ['P1', { red: 0.70, green: 0.28, blue: 0.00 }, { red: 1.0, green: 0.90, blue: 0.72 }],
    ['P2', { red: 0.45, green: 0.35, blue: 0.00 }, { red: 1.0, green: 0.96, blue: 0.70 }],
    ['P3', { red: 0.20, green: 0.32, blue: 0.55 }, { red: 0.86, green: 0.91, blue: 1.0 }],
  ];
  for (const [value, fg, bg] of formats) {
    requests.push({
      addConditionalFormatRule: {
        index: 0,
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: priorityCol, endColumnIndex: priorityCol + 1 }],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: value }] },
            format: {
              backgroundColorStyle: { rgbColor: bg },
              textFormat: { foregroundColorStyle: { rgbColor: fg }, bold: true },
            },
          },
        },
      },
    });
  }
  requests.push({
    setDataValidation: {
      range: { sheetId, startRowIndex: 1, startColumnIndex: computerUseCol, endColumnIndex: computerUseCol + 1 },
      rule: {
        condition: {
          type: 'ONE_OF_LIST',
          values: ['待人工确认', '已打开GSC', '已提交', '跳过'].map((userEnteredValue) => ({ userEnteredValue })),
        },
        strict: true,
        showCustomUi: true,
      },
    },
  });
  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount',
    },
  });
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
      cell: {
        userEnteredFormat: {
          textFormat: { bold: true, foregroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } } },
          backgroundColorStyle: { rgbColor: { red: 0.216, green: 0.278, blue: 0.310 } },
        },
      },
      fields: 'userEnteredFormat(textFormat,backgroundColorStyle)',
    },
  });
  if (requests.length) {
    await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}:batchUpdate`,
      token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requests }),
      },
    );
  }
  return { formatted: true };
}

export async function formatUrlInventoryTab(token, workbookId, tabName = URL_INVENTORY_TAB) {
  const meta = await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}?includeGridData=false&fields=sheets(properties(sheetId,title),conditionalFormats)`,
    token,
  );
  const sheet = (meta.sheets || []).find((s) => s.properties?.title === tabName);
  if (!sheet) throw new Error(`tab not found: ${tabName}`);
  const sheetId = sheet.properties.sheetId;
  const statusCol = URL_INVENTORY_HEADER.indexOf('inventory_status');
  const requests = [];
  const existing = sheet.conditionalFormats || [];
  const isStatusRule = (rule) =>
    (rule.ranges || []).some((range) =>
      range.sheetId === sheetId &&
      range.startRowIndex === 1 &&
      range.startColumnIndex === statusCol &&
      range.endColumnIndex === statusCol + 1) &&
    rule.booleanRule?.condition?.type === 'TEXT_EQ';
  existing.forEach((rule, index) => {
    if (isStatusRule(rule)) requests.push({ deleteConditionalFormatRule: { sheetId, index } });
  });
  requests.sort((a, b) => b.deleteConditionalFormatRule.index - a.deleteConditionalFormatRule.index);

  const formats = [
    ['未纳入监控', { red: 0.70, green: 0.28, blue: 0.00 }, { red: 1.0, green: 0.90, blue: 0.72 }],
    ['已纳入但未提交', { red: 0.20, green: 0.32, blue: 0.55 }, { red: 0.86, green: 0.91, blue: 1.0 }],
    ['已提交但未收录', { red: 0.45, green: 0.35, blue: 0.00 }, { red: 1.0, green: 0.96, blue: 0.70 }],
    ['已收录', { red: 0.12, green: 0.45, blue: 0.20 }, { red: 0.86, green: 0.95, blue: 0.86 }],
  ];
  for (const [value, fg, bg] of formats) {
    requests.push({
      addConditionalFormatRule: {
        index: 0,
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: statusCol, endColumnIndex: statusCol + 1 }],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: value }] },
            format: {
              backgroundColorStyle: { rgbColor: bg },
              textFormat: { foregroundColorStyle: { rgbColor: fg }, bold: true },
            },
          },
        },
      },
    });
  }
  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount',
    },
  });
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
      cell: {
        userEnteredFormat: {
          textFormat: { bold: true, foregroundColorStyle: { rgbColor: { red: 1, green: 1, blue: 1 } } },
          backgroundColorStyle: { rgbColor: { red: 0.216, green: 0.278, blue: 0.310 } },
        },
      },
      fields: 'userEnteredFormat(textFormat,backgroundColorStyle)',
    },
  });

  if (requests.length) {
    await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}:batchUpdate`,
      token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requests }),
      },
    );
  }
  return { formatted: true };
}

export async function formatRecapStatusTab(token, workbookId, tabName = RECAP_TAB, fetcher = gFetch) {
  const meta = await fetcher(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}?includeGridData=false&fields=sheets(properties(sheetId,title),conditionalFormats)`,
    token,
  );
  const sheet = (meta.sheets || []).find((s) => s.properties?.title === tabName);
  if (!sheet) throw new Error(`tab not found: ${tabName}`);
  const sheetId = sheet.properties.sheetId;
  const statusCol = RECAP_HEADER.indexOf('索引修复状态');
  if (statusCol < 0) throw new Error('索引修复状态 column not found');

  const existing = sheet.conditionalFormats || [];
  const isStatusRule = (rule) =>
    (rule.ranges || []).some((range) =>
      range.sheetId === sheetId &&
      range.startRowIndex === 1 &&
      range.startColumnIndex === statusCol &&
      range.endColumnIndex === statusCol + 1) &&
    ['TEXT_CONTAINS', 'TEXT_EQ'].includes(rule.booleanRule?.condition?.type);

  const requests = [];
  existing.forEach((rule, index) => {
    if (isStatusRule(rule)) requests.push({ deleteConditionalFormatRule: { sheetId, index } });
  });
  requests.sort((a, b) => b.deleteConditionalFormatRule.index - a.deleteConditionalFormatRule.index);

  for (const fmt of RECAP_STATUS_CONDITIONAL_FORMATS) {
    requests.push({
      addConditionalFormatRule: {
        index: 0,
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: statusCol, endColumnIndex: statusCol + 1 }],
          booleanRule: {
            condition: { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: fmt.textContains }] },
            format: {
              backgroundColorStyle: { rgbColor: fmt.bg },
              textFormat: { foregroundColorStyle: { rgbColor: fmt.fg }, bold: !!fmt.bold },
            },
          },
        },
      },
    });
  }

  if (requests.length) {
    await fetcher(
      `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}:batchUpdate`,
      token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requests }),
      },
    );
  }
  return { formatted: true, rules: RECAP_STATUS_CONDITIONAL_FORMATS.length };
}

export async function batchUpdateTrackingRows(token, workbookId, tabName, updates, appends) {
  const last = colLetter(INDEX_TRACKING_HEADER.length - 1);
  const data = updates.map((item) => ({
    range: `${tabName}!A${item.old._rowNumber}:${last}${item.old._rowNumber}`,
    values: [rowToSheetValues(item.merged)],
  }));
  if (data.length) {
    await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values:batchUpdate`,
      token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'RAW', data }),
      },
    );
  }
  if (appends.length) await appendTrackingRows(token, workbookId, tabName, appends);
  return { updatedRows: updates.length, appendedRows: appends.length };
}

export async function readRecapRows(token, workbookId, tabName = RECAP_TAB) {
  const last = colLetter(RECAP_HEADER.length - 1);
  const body = await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(`${tabName}!A2:${last}2000`)}`,
    token,
  );
  return (body.values || [])
    .map((values, i) => recapValuesToRow(values, i + 2))
    .filter((row) => row.url || row.page_id || row.outcome_id);
}

export async function appendRecapRows(token, workbookId, tabName, rows) {
  if (!rows.length) return { updates: { updatedRows: 0 } };
  return gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(`${tabName}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: rows.map(recapRowToValues) }),
    },
  );
}

export async function updateRecapRow(token, workbookId, tabName, rowNumber, row) {
  if (!rowNumber) throw new Error('updateRecapRow: rowNumber required');
  const last = colLetter(RECAP_HEADER.length - 1);
  return gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(`${tabName}!A${rowNumber}:${last}${rowNumber}`)}?valueInputOption=RAW`,
    token,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: [recapRowToValues(row)] }),
    },
  );
}

export async function batchUpdateRecapRows(token, workbookId, tabName, updates, appends) {
  const last = colLetter(RECAP_HEADER.length - 1);
  const data = updates.map((item) => ({
    range: `${tabName}!A${item.old._rowNumber}:${last}${item.old._rowNumber}`,
    values: [recapRowToValues(item.merged)],
  }));
  if (data.length) {
    await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values:batchUpdate`,
      token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'RAW', data }),
      },
    );
  }
  if (appends.length) await appendRecapRows(token, workbookId, tabName, appends);
  return { updatedRows: updates.length, appendedRows: appends.length };
}

export async function updateTrackingRow(token, workbookId, tabName, rowNumber, row) {
  if (!rowNumber) throw new Error('updateTrackingRow: rowNumber required');
  const last = colLetter(INDEX_TRACKING_HEADER.length - 1);
  return gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(`${tabName}!A${rowNumber}:${last}${rowNumber}`)}?valueInputOption=RAW`,
    token,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: [rowToSheetValues(row)] }),
    },
  );
}

export async function appendTrackingSeed(token, workbookId, seedRow) {
  const tabName = await ensureIndexTrackingTab(token, workbookId);
  const existing = await readTrackingRows(token, workbookId, tabName);
  const dup = existing.find((row) =>
    (seedRow.url && row.url === seedRow.url) ||
    (seedRow.page_id && row.page_id === seedRow.page_id)
  );
  if (dup) return { appended: false, tabName, row: dup };
  const res = await appendTrackingRows(token, workbookId, tabName, [seedRow]);
  return { appended: true, tabName, result: res };
}

export async function fetchUrlInspection(token, siteUrl, inspectionUrl, languageCode = 'en-US') {
  const body = await gFetch(
    'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inspectionUrl, siteUrl, languageCode }),
    },
  );
  return body.inspectionResult?.indexStatusResult || {};
}

function shouldFetchPageDiagnostics(indexStatus = {}) {
  const coverageState = String(indexStatus.coverageState || '');
  const verdict = String(indexStatus.verdict || '');
  return !((verdict === 'PASS' || /\bindexed\b/i.test(coverageState)) && !/not indexed|canonical|duplicate/i.test(coverageState));
}

export function mergeInspectionIntoRow(row, indexStatus, now = new Date(), pageDiagnostics = {}) {
  const checkedDay = isoDay(now);
  const days = daysBetween(row.first_tracked_at, now);
  const cls = classifyInspection(indexStatus, { daysSinceFirstTracked: days, now, pageDiagnostics });
  const next = {
    ...row,
    last_checked_at: checkedDay,
    check_count: Number(row.check_count || 0) + 1,
    days_since_first_tracked: days,
    current_gsc_status: indexStatus.coverageState || '',
    gsc_verdict: indexStatus.verdict || '',
    indexing_state: indexStatus.indexingState || '',
    page_fetch_state: indexStatus.pageFetchState || '',
    last_crawl_time: indexStatus.lastCrawlTime || '',
    google_canonical: indexStatus.googleCanonical || '',
    user_canonical: indexStatus.userCanonical || '',
    monitor_status: cls.monitor_status,
    diagnosis_category: cls.diagnosis_category,
    alert_level: cls.alert_level,
    fix_status: lifecycleFixStatus(row, cls),
    recommendation: cls.recommendation,
  };
  if (cls.first_indexed_at && !next.first_indexed_at) {
    next.first_indexed_at = cls.first_indexed_at;
    next.days_to_index = daysBetween(row.first_tracked_at, `${cls.first_indexed_at}T00:00:00Z`);
  }
  return { row: next, classification: cls };
}

export function formatAlertMessage(row, classification) {
  const title = row.title || row.slug || row.page_id || row.url;
  const recommendation = row.recommendation || classification.recommendation || checklist(['请人工查看 URL Inspection 原始状态。']);
  const recommendationBlock = String(recommendation)
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const s = line.trim();
      return s.startsWith('□') ? `  ${s}` : s.startsWith('  □') ? s : `  □ ${s}`;
    })
    .join('\n');
  return [
    '🔍 索引诊断报告',
    `页面：${title}`,
    `URL：${row.url}`,
    `GSC 状态：${row.current_gsc_status || '-'}`,
    `诊断结论：${classification.diagnosis_conclusion || row.diagnosis_category || classification.diagnosis_category || '-'}`,
    `建议操作：\n${recommendationBlock}`,
    '处理完成后：系统将自动刷新 sitemap 并进入 request-indexing-queue；GSC Request Indexing 最终点击需人工确认。',
  ].join('\n');
}

function larkBestEffort(message, env = process.env) {
  if (env.GG_INDEX_MONITOR_NO_NOTIFY === '1') return;
  try {
    execFileSync('bash', [LARK_NOTIFY, message], {
      stdio: 'ignore',
      timeout: 30000,
      env: { ...env, GG_LARK_NOTIFY_AT_PM: '1', GG_LARK_NOTIFY_AT_OPS: '1' },
    });
  } catch {
    // best-effort only
  }
}

async function runEnqueue(args, { sheetToken, workbookId, now }) {
  const seed = buildTrackingSeedRow({
    pageId: args.page_id,
    slug: args.slug,
    url: args.url,
    title: args.title || '',
    author: args.author || '',
    publishedAt: args.published_at,
    now,
    source: args.source || 'seo-autopilot',
    site: args.site || process.env.GG_GSC_SITE || DEFAULT_SITE,
  });
  if (!args.write_sheet) {
    process.stdout.write(JSON.stringify(seed, null, 2) + '\n');
    return 0;
  }
  if (!workbookId) {
    process.stderr.write('error: --write-sheet requires workbook id from env or --workbook\n');
    return 1;
  }
  const result = await appendTrackingSeed(sheetToken, workbookId, seed);
  process.stdout.write(`${result.appended ? 'enqueued' : 'already-present'} ${seed.page_id} → ${INDEX_TRACKING_TAB}\n`);
  return 0;
}

async function runSyncPublished(args, {
  sheetToken,
  workbookId,
  now,
  sitemapRows,
  fetchSitemapRowsFn = fetchEnWikiSitemapRows,
  ensureFn = ensureIndexTrackingTab,
  readRowsFn = readTrackingRows,
  readRecapRowsFn = readRecapRows,
  updateRowFn = updateTrackingRow,
  appendRowsFn = appendTrackingRows,
  batchUpdateRowsFn = null,
}) {
  if (!workbookId) {
    process.stderr.write('error: --sync-published requires workbook id from env or --workbook\n');
    return 1;
  }
  const tabName = args.write_sheet ? await ensureFn(sheetToken, workbookId) : INDEX_TRACKING_TAB;
  const rows = sitemapRows || await fetchSitemapRowsFn(args.sitemap_url || DEFAULT_SITEMAP_URL, { now });
  const existing = args.write_sheet ? await readRowsFn(sheetToken, workbookId, tabName) : [];
  const recap = args.write_sheet && readRecapRowsFn ? await readRecapRowsFn(sheetToken, workbookId, RECAP_TAB) : [];
  const recapByUrl = new Map(
    recap
      .filter((row) => row.url && row.page_id)
      .map((row) => [normalizeUrl(row.url), row]),
  );
  const byUrl = new Map(existing.map((row) => [normalizeUrl(row.url), row]));
  const toAppend = [];
  const toUpdate = [];
  let skipped = 0;

  for (const fresh of rows) {
    const key = normalizeUrl(fresh.url);
    if (!key || !isEnWikiArticleUrl(key)) {
      skipped++;
      continue;
    }
    const recapRow = recapByUrl.get(key);
    if (recapRow?.page_id && !fresh.page_id) fresh.page_id = recapRow.page_id;
    const old = byUrl.get(key);
    if (!fresh.page_id && !old?.page_id) {
      skipped++;
      continue;
    }
    if (!old) {
      toAppend.push(fresh);
      continue;
    }
    const merged = mergePublishedTrackingRow(old, fresh);
    if (trackingComparable(old) !== trackingComparable(merged)) toUpdate.push({ old, merged });
    else skipped++;
  }

  if (args.write_sheet) {
    if (batchUpdateRowsFn) {
      await batchUpdateRowsFn(sheetToken, workbookId, tabName, toUpdate, toAppend);
    } else {
      for (const item of toUpdate) {
        await updateRowFn(sheetToken, workbookId, tabName, item.old._rowNumber, item.merged);
      }
      await appendRowsFn(sheetToken, workbookId, tabName, toAppend);
    }
  }

  process.stdout.write(
    `sync-published: source=live-sitemap en_urls=${rows.length} appended=${toAppend.length} updated=${toUpdate.length} skipped=${skipped} mode=${args.write_sheet ? 'write-sheet' : 'dry-run'}\n`,
  );
  return 0;
}

async function runSyncUrlInventory(args, {
  sheetToken,
  workbookId,
  now,
  sitemapRows,
  fetchSitemapRowsFn = fetchSitemapInventoryRows,
  ensureFn = ensureUrlInventoryTab,
  readTrackingRowsFn = readTrackingRows,
  readRecapRowsFn = readRecapRows,
  readRequestQueueRowsFn = readRequestQueueRows,
  replaceRowsFn = replaceUrlInventoryRows,
  formatFn = formatUrlInventoryTab,
}) {
  if (!workbookId) {
    process.stderr.write('error: --sync-url-inventory requires workbook id from env or --workbook\n');
    return 1;
  }
  const tabName = args.write_sheet ? await ensureFn(sheetToken, workbookId) : URL_INVENTORY_TAB;
  const sitemapInventoryRows = sitemapRows || await fetchSitemapRowsFn(args.sitemap_url || DEFAULT_SITEMAP_URL, { now });
  const trackingRows = args.write_sheet ? await readTrackingRowsFn(sheetToken, workbookId, INDEX_TRACKING_TAB) : [];
  const recapRows = args.write_sheet ? await readRecapRowsFn(sheetToken, workbookId, RECAP_TAB) : [];
  const requestQueueRows = args.write_sheet ? await readRequestQueueRowsFn(sheetToken, workbookId, REQUEST_INDEXING_QUEUE_TAB) : [];
  const rows = buildUrlInventoryRows({
    sitemapRows: sitemapInventoryRows,
    trackingRows,
    recapRows,
    requestQueueRows,
    now,
    siteUrl: args.site || process.env.GG_GSC_SITE || DEFAULT_SITE,
  });

  if (args.write_sheet) {
    await replaceRowsFn(sheetToken, workbookId, tabName, rows);
    if (formatFn) await formatFn(sheetToken, workbookId, tabName);
  }

  const counts = rows.reduce((acc, row) => {
    acc[row.inventory_status] = (acc[row.inventory_status] || 0) + 1;
    return acc;
  }, {});
  process.stdout.write(
    `sync-url-inventory: rows=${rows.length} untracked=${counts['未纳入监控'] || 0} included_unsubmitted=${counts['已纳入但未提交'] || 0} submitted_unindexed=${counts['已提交但未收录'] || 0} indexed=${counts['已收录'] || 0} mode=${args.write_sheet ? 'write-sheet' : 'dry-run'}\n`,
  );
  return 0;
}

async function runSyncRecap(args, {
  sheetToken,
  workbookId,
  now,
  readRowsFn = readTrackingRows,
  readRecapRowsFn = readRecapRows,
  readTopicClusterFn = readTopicClusterMap,
  updateRecapRowFn = updateRecapRow,
  appendRecapRowsFn = appendRecapRows,
  batchUpdateRecapRowsFn = null,
  formatRecapStatusFn = formatRecapStatusTab,
}) {
  if (!workbookId) {
    process.stderr.write('error: --sync-recap requires workbook id from env or --workbook\n');
    return 1;
  }
  const tracking = await readRowsFn(sheetToken, workbookId, INDEX_TRACKING_TAB);
  const recap = await readRecapRowsFn(sheetToken, workbookId, RECAP_TAB);
  const clusterByPage = await readTopicClusterFn(sheetToken, workbookId);
  const byUrl = new Map(recap.map((row) => [normalizeUrl(row.url), row]));
  const toAppend = [];
  const toUpdate = [];
  let skipped = 0;

  for (const row of tracking) {
    if (!isEnWikiArticleUrl(row.url) || !String(row.page_id || '').trim()) {
      skipped++;
      continue;
    }
    const fresh = recapRowFromTrackingRow(row, { now, clusterByPage });
    const old = byUrl.get(normalizeUrl(row.url));
    if (!old) {
      toAppend.push(fresh);
      continue;
    }
    const merged = mergeRecapRow(old, fresh);
    if (recapComparable(old) !== recapComparable(merged)) toUpdate.push({ old, merged });
    else skipped++;
  }

  if (args.write_sheet) {
    if (batchUpdateRecapRowsFn) {
      await batchUpdateRecapRowsFn(sheetToken, workbookId, RECAP_TAB, toUpdate, toAppend);
    } else {
      for (const item of toUpdate) {
        await updateRecapRowFn(sheetToken, workbookId, RECAP_TAB, item.old._rowNumber, item.merged);
      }
      await appendRecapRowsFn(sheetToken, workbookId, RECAP_TAB, toAppend);
    }
    if (formatRecapStatusFn) await formatRecapStatusFn(sheetToken, workbookId, RECAP_TAB);
  }

  process.stdout.write(
    `sync-recap: source=${INDEX_TRACKING_TAB} en_rows=${tracking.length} appended=${toAppend.length} updated=${toUpdate.length} skipped=${skipped} mode=${args.write_sheet ? 'write-sheet' : 'dry-run'}\n`,
  );
  return 0;
}

function formatRequestQueueMessage(rows, { sitemapUrl = DEFAULT_SITEMAP_URL } = {}) {
  const counts = rows.reduce((acc, row) => {
    acc[row.priority] = (acc[row.priority] || 0) + 1;
    return acc;
  }, {});
  const top = rows.slice(0, 5).map((row) => `${row.priority} ${row.page_id} ${row.request_reason}`).join('\n');
  return [
    `⚠️ Request Indexing 候选队列已更新：共 ${rows.length} 条`,
    `优先级：P0=${counts.P0 || 0} / P1=${counts.P1 || 0} / P2=${counts.P2 || 0} / P3=${counts.P3 || 0}`,
    `Sitemap：${sitemapUrl} 已通过官方 Sitemaps API 刷新或等待刷新结果`,
    top ? `Top 候选：\n${top}` : '',
    '处理方式：打开 request-indexing-queue，按优先级用 Computer Use 辅助打开 GSC；最终 Request Indexing 点击需人工确认。',
  ].filter(Boolean).join('\n');
}

async function runSubmitSitemap(args, {
  gscWriteToken,
  getGscWriteToken = getGscWriteAccessToken,
  submitSitemapFn = submitSitemap,
  notifyFn = larkBestEffort,
}) {
  const siteUrl = args.site || process.env.GG_GSC_SITE || DEFAULT_SITE;
  const sitemapUrl = args.sitemap_url || DEFAULT_SITEMAP_URL;
  let token = gscWriteToken;
  if (!token) {
    try {
      token = await getGscWriteToken();
    } catch (e) {
      process.stderr.write(`error: cannot mint GSC write token — ${e.message}\n`);
      return 1;
    }
  }
  try {
    await submitSitemapFn(token, siteUrl, sitemapUrl);
  } catch (e) {
    const msg = `⚠️ sitemap 刷新失败：${sitemapUrl} (${redactNote(e)})`;
    process.stderr.write(`${msg}\n`);
    if (args.notify) notifyFn(msg);
    return 1;
  }
  const msg = `sitemap-submit: site=${siteUrl} sitemap=${sitemapUrl} ok`;
  process.stdout.write(`${msg}\n`);
  if (args.notify) notifyFn(`✅ sitemap 已刷新：${sitemapUrl}`);
  return 0;
}

async function runSyncRequestQueue(args, {
  sheetToken,
  workbookId,
  now,
  ensureFn = ensureRequestQueueTab,
  readRecapRowsFn = readRecapRows,
  readTrackingRowsFn = readTrackingRows,
  readRequestQueueRowsFn = readRequestQueueRows,
  replaceRowsFn = replaceRequestQueueRows,
  formatFn = formatRequestQueueTab,
  notifyFn = larkBestEffort,
}) {
  if (!workbookId) {
    process.stderr.write('error: --sync-request-queue requires workbook id from env or --workbook\n');
    return 1;
  }
  const tabName = args.write_sheet ? await ensureFn(sheetToken, workbookId) : REQUEST_INDEXING_QUEUE_TAB;
  const recapRows = await readRecapRowsFn(sheetToken, workbookId, RECAP_TAB);
  const trackingRows = await readTrackingRowsFn(sheetToken, workbookId, INDEX_TRACKING_TAB);
  const existingRows = args.write_sheet ? await readRequestQueueRowsFn(sheetToken, workbookId, tabName) : [];
  const rows = buildRequestIndexingCandidateRows({
    recapRows,
    trackingRows,
    existingRows,
    now,
    siteUrl: args.site || process.env.GG_GSC_SITE || DEFAULT_SITE,
  });
  if (args.write_sheet) {
    await replaceRowsFn(sheetToken, workbookId, tabName, rows);
    if (formatFn) await formatFn(sheetToken, workbookId, tabName);
  }
  if (args.notify && rows.length) {
    notifyFn(formatRequestQueueMessage(rows, { sitemapUrl: args.sitemap_url || DEFAULT_SITEMAP_URL }));
  }
  const counts = rows.reduce((acc, row) => {
    acc[row.priority] = (acc[row.priority] || 0) + 1;
    return acc;
  }, {});
  process.stdout.write(
    `sync-request-queue: rows=${rows.length} P0=${counts.P0 || 0} P1=${counts.P1 || 0} P2=${counts.P2 || 0} P3=${counts.P3 || 0} mode=${args.write_sheet ? 'write-sheet' : 'dry-run'}\n`,
  );
  return 0;
}

function fixedResubmitTrackingRow(row = {}, now = new Date()) {
  const ts = isoTimestamp(now);
  const day = isoDay(now);
  return {
    ...row,
    monitor_status: 'monitoring',
    alert_level: '',
    alert_sent_at: '',
    fix_status: '已重新提交',
    retry_round: Number(row.retry_round || 0) + 1,
    fixed_detected_at: row.fixed_detected_at || ts,
    resubmitted_at: ts,
    next_check_after: day,
    recommendation: '已重新提交 sitemap；已进入 request-indexing-queue 候选刷新流程；GSC Request Indexing 最终点击需人工确认。',
    notes: appendAutoNote(row.notes, `resubmitted_after_fix=${ts}`),
  };
}

function fixedResubmitRecapRow(row = {}, now = new Date()) {
  const ts = isoTimestamp(now);
  const day = isoDay(now);
  return {
    ...row,
    '申请时间': day,
    '索引修复状态': '已重新提交',
    '记录日期': day,
    '备注': appendAutoNote(row['备注'], `自动重新提交=${ts}`),
  };
}

function formatFixedResubmitMessage(count, { sitemapUrl = DEFAULT_SITEMAP_URL } = {}) {
  return [
    `✅ 已重新提交修复 URL：${count} 条`,
    `Sitemap：${sitemapUrl}`,
    '下一步：追踪表已刷新，并进入 request-indexing-queue；GSC Request Indexing 最终点击需人工确认。',
  ].join('\n');
}

async function runProcessFixed(args, {
  sheetToken,
  gscWriteToken,
  workbookId,
  now,
  ensureFn = ensureIndexTrackingTab,
  readRowsFn = readTrackingRows,
  readRecapRowsFn = readRecapRows,
  updateRowFn = updateTrackingRow,
  updateRecapRowFn = updateRecapRow,
  formatRecapStatusFn = formatRecapStatusTab,
  getGscWriteToken = getGscWriteAccessToken,
  submitSitemapFn = submitSitemap,
  notifyFn = larkBestEffort,
}) {
  if (!workbookId) {
    process.stderr.write('error: --process-fixed requires workbook id from env or --workbook\n');
    return 1;
  }

  const tabName = args.write_sheet ? await ensureFn(sheetToken, workbookId) : INDEX_TRACKING_TAB;
  const trackingRows = await readRowsFn(sheetToken, workbookId, tabName);
  const recapRows = await readRecapRowsFn(sheetToken, workbookId, RECAP_TAB);
  const fixedKeys = new Set();

  for (const row of trackingRows) {
    if (isFixedMarker(row.fix_status)) fixedKeys.add(trackingIdentity(row));
  }
  for (const row of recapRows) {
    if (isFixedMarker(row['索引修复状态'])) fixedKeys.add(trackingIdentity(row));
  }
  fixedKeys.delete('');

  const fixedTracking = trackingRows.filter((row) => {
    const key = trackingIdentity(row);
    if (!key || !fixedKeys.has(key)) return false;
    if (!String(row.page_id || '').trim()) return false;
    if (!isEnWikiArticleUrl(row.url)) return false;
    if (String(row.fix_status || '').trim() === '已重新提交' && row.resubmitted_at) return false;
    return true;
  });

  const fixedTrackingKeys = new Set(fixedTracking.map((row) => trackingIdentity(row)).filter(Boolean));
  const fixedRecapRows = recapRows.filter((row) =>
    fixedTrackingKeys.has(trackingIdentity(row)) &&
    isFixedMarker(row['索引修复状态'])
  );

  const sitemapUrl = args.sitemap_url || DEFAULT_SITEMAP_URL;
  const siteUrl = args.site || process.env.GG_GSC_SITE || DEFAULT_SITE;

  if (args.write_sheet && fixedTracking.length) {
    let token = gscWriteToken;
    if (!token) {
      try {
        token = await getGscWriteToken();
      } catch (e) {
        process.stderr.write(`error: cannot mint GSC write token — ${e.message}\n`);
        return 1;
      }
    }
    try {
      await submitSitemapFn(token, siteUrl, sitemapUrl);
    } catch (e) {
      const msg = `⚠️ 修复后 sitemap 重新提交失败：${sitemapUrl} (${redactNote(e)})`;
      process.stderr.write(`${msg}\n`);
      if (args.notify) notifyFn(msg);
      return 1;
    }

    for (const row of fixedTracking) {
      await updateRowFn(sheetToken, workbookId, tabName, row._rowNumber, fixedResubmitTrackingRow(row, now));
    }
    for (const row of fixedRecapRows) {
      await updateRecapRowFn(sheetToken, workbookId, RECAP_TAB, row._rowNumber, fixedResubmitRecapRow(row, now));
    }
    if (formatRecapStatusFn) await formatRecapStatusFn(sheetToken, workbookId, RECAP_TAB);
  }

  if (args.notify && fixedTracking.length) {
    notifyFn(formatFixedResubmitMessage(fixedTracking.length, { sitemapUrl }));
  }

  process.stdout.write(
    `process-fixed: fixed=${fixedKeys.size} resubmitted=${fixedTracking.length} mode=${args.write_sheet ? 'write-sheet' : 'dry-run'}\n`,
  );
  return 0;
}

async function runCheckDue(args, {
  sheetToken,
  gscToken,
  workbookId,
  now,
  ensureFn = ensureIndexTrackingTab,
  readRowsFn = readTrackingRows,
  updateRowFn = updateTrackingRow,
  fetchInspectionFn = fetchUrlInspection,
  fetchPageDiagnosticsFn = fetchPageDiagnostics,
  getGscToken = getGscAccessToken,
  preflightGscAccessFn = preflightGscAccess,
  notifyFn = larkBestEffort,
}) {
  if (!workbookId) {
    process.stderr.write('error: --check-due requires workbook id from env or --workbook\n');
    return 1;
  }
  const writeSheet = !!args.write_sheet;
  const tabName = writeSheet
    ? await ensureFn(sheetToken, workbookId)
    : INDEX_TRACKING_TAB;
  let rows;
  try {
    rows = await readRowsFn(sheetToken, workbookId, tabName);
  } catch (e) {
    process.stderr.write(`error: cannot read ${tabName} — ${e.message}\n`);
    return 1;
  }
  const limit = Number(args.limit || 50) || 50;
  const dueSource = args.check_all
    ? rows.filter((row) =>
      isEnWikiArticleUrl(row.url) &&
      String(row.monitor_status || 'monitoring') !== 'indexed' &&
      (String(row.last_checked_at || '') !== isoDay(now) ||
        String(row.current_gsc_status || '') === 'pending_first_check')
    )
    : rows.filter((row) => isDueForInspection(row, now));
  const due = dueSource.slice(0, limit);
  process.stderr.write(`gg-index-monitor: rows=${rows.length} due=${due.length} mode=${writeSheet ? 'write-sheet' : 'dry-run'}\n`);
  let inspectionToken = gscToken;
  const siteUrl = args.site || process.env.GG_GSC_SITE || DEFAULT_SITE;
  if ((due.length || (args.require_gsc_auth && rows.length)) && !inspectionToken) {
    try {
      inspectionToken = await getGscToken();
    } catch (e) {
      process.stderr.write(`error: cannot mint GSC reader SA token — ${e.message}\n`);
      return 1;
    }
  }
  if (args.require_gsc_auth && rows.length) {
    try {
      await preflightGscAccessFn(inspectionToken, siteUrl);
    } catch (e) {
      process.stderr.write(`error: GSC reader SA cannot access ${siteUrl} — ${redactNote(e)}\n`);
      return 1;
    }
  }
  if (!due.length) {
    process.stdout.write('no due URLs\n');
    return 0;
  }

  let failures = 0;
  let alerts = 0;
  for (const row of due) {
    try {
      const indexStatus = await fetchInspectionFn(inspectionToken, siteUrl, row.url);
      let pageDiagnostics = {};
      if (shouldFetchPageDiagnostics(indexStatus)) {
        try {
          pageDiagnostics = await fetchPageDiagnosticsFn(row.url);
        } catch (e) {
          pageDiagnostics = { page_fetch_error: redactNote(e) };
        }
      }
      const merged = mergeInspectionIntoRow(row, indexStatus, now, pageDiagnostics);
      if (merged.classification.should_alert) {
        alerts++;
        const alertChanged = String(row.alert_level || '') !== String(merged.classification.alert_level || '') ||
          String(row.monitor_status || '') !== String(merged.classification.monitor_status || '');
        if (writeSheet && (!merged.row.alert_sent_at || alertChanged)) {
          merged.row.alert_sent_at = isoDay(now);
          notifyFn(formatAlertMessage(merged.row, merged.classification));
        }
      }
      if (writeSheet) await updateRowFn(sheetToken, workbookId, tabName, row._rowNumber, merged.row);
      process.stdout.write(`${merged.row.page_id || merged.row.url}: ${merged.row.current_gsc_status || '(no status)'} → ${merged.row.monitor_status}\n`);
    } catch (e) {
      failures++;
      const msg = redactNote(e);
      process.stderr.write(`warn: inspect failed for ${row.url}: ${msg}\n`);
      if (writeSheet) {
        const failed = {
          ...row,
          last_checked_at: isoDay(now),
          check_count: Number(row.check_count || 0) + 1,
          notes: msg,
        };
        try { await updateRowFn(sheetToken, workbookId, tabName, row._rowNumber, failed); } catch { /* keep going */ }
      }
    }
  }
  process.stderr.write(`gg-index-monitor: checked=${due.length} alerts=${alerts} failures=${failures}\n`);
  return failures ? 2 : 0;
}

async function runEnsureTab({ sheetToken, workbookId, ensureFn = ensureIndexTrackingTab }) {
  if (!workbookId) {
    process.stderr.write('error: --ensure-tab requires workbook id from env or --workbook\n');
    return 1;
  }
  await ensureFn(sheetToken, workbookId);
  process.stdout.write(`ensured ${INDEX_TRACKING_TAB}\n`);
  return 0;
}

export async function runIndexMonitor(argv, deps = {}) {
  const args = parseArgs(argv);
  const defaultCheckDue = Object.keys(args).length === 0;
  if (args.help || args.h) {
    process.stdout.write([
      'gg-index-monitor.mjs — URL Inspection → index-tracking',
      'Usage:',
      '  node tools/scripts/gg-index-monitor.mjs --ensure-tab [--workbook SHEET_ID]',
      '  node tools/scripts/gg-index-monitor.mjs --sync-published --write-sheet [--sitemap-url URL]',
      '  node tools/scripts/gg-index-monitor.mjs --sync-url-inventory --write-sheet [--sitemap-url URL]',
      '  node tools/scripts/gg-index-monitor.mjs --enqueue-published --page-id PG-... --slug slug --title "Title" --published-at YYYY-MM-DD --write-sheet',
      '  node tools/scripts/gg-index-monitor.mjs --check-due --write-sheet [--limit 50]',
      '  node tools/scripts/gg-index-monitor.mjs --check-all --write-sheet [--limit 200]',
      '  node tools/scripts/gg-index-monitor.mjs --sync-recap --write-sheet',
      '  node tools/scripts/gg-index-monitor.mjs --submit-sitemap [--notify]',
      '  node tools/scripts/gg-index-monitor.mjs --process-fixed --write-sheet [--notify]',
      '  node tools/scripts/gg-index-monitor.mjs --sync-request-queue --write-sheet [--notify]',
      '',
    ].join('\n'));
    return 0;
  }

  loadEnv();
  const now = deps.now || new Date();
  const workbookId = args.workbook && args.workbook !== true
    ? String(args.workbook)
    : resolveWorkbookId();

  let sheetToken = deps.sheetToken;
  if (!sheetToken && (args.write_sheet || args.check_due || args.check_all || defaultCheckDue || args.ensure_tab || args.sync_published || args.sync_url_inventory || args.sync_recap || args.sync_request_queue || args.process_fixed)) {
    try {
      sheetToken = await (deps.getSheetToken || getSheetAccessToken)();
    } catch (e) {
      process.stderr.write(`error: cannot mint Sheets token — ${e.message}\n`);
      return 1;
    }
  }

  if (args.ensure_tab) {
    return runEnsureTab({
      sheetToken,
      workbookId,
      ensureFn: deps.ensureIndexTrackingTab || ensureIndexTrackingTab,
    });
  }

  if (args.submit_sitemap) {
    return runSubmitSitemap(args, {
      gscWriteToken: deps.gscWriteToken,
      getGscWriteToken: deps.getGscWriteToken || getGscWriteAccessToken,
      submitSitemapFn: deps.submitSitemap || submitSitemap,
      notifyFn: deps.notify || larkBestEffort,
    });
  }

  if (args.sync_published) {
    return runSyncPublished(args, {
      sheetToken,
      workbookId,
      now,
      sitemapRows: deps.sitemapRows,
      fetchSitemapRowsFn: deps.fetchSitemapRows || fetchEnWikiSitemapRows,
      ensureFn: deps.ensureIndexTrackingTab || ensureIndexTrackingTab,
      readRowsFn: deps.readTrackingRows || readTrackingRows,
      readRecapRowsFn: deps.readRecapRows || readRecapRows,
      updateRowFn: deps.updateTrackingRow || updateTrackingRow,
      appendRowsFn: deps.appendTrackingRows || appendTrackingRows,
      batchUpdateRowsFn: deps.updateTrackingRow || deps.appendTrackingRows
        ? deps.batchUpdateTrackingRows || null
        : deps.batchUpdateTrackingRows || batchUpdateTrackingRows,
    });
  }

  if (args.sync_url_inventory) {
    return runSyncUrlInventory(args, {
      sheetToken,
      workbookId,
      now,
      sitemapRows: deps.sitemapInventoryRows,
      fetchSitemapRowsFn: deps.fetchSitemapInventoryRows || fetchSitemapInventoryRows,
      ensureFn: deps.ensureUrlInventoryTab || ensureUrlInventoryTab,
      readTrackingRowsFn: deps.readTrackingRows || readTrackingRows,
      readRecapRowsFn: deps.readRecapRows || readRecapRows,
      readRequestQueueRowsFn: deps.readRequestQueueRows || readRequestQueueRows,
      replaceRowsFn: deps.replaceUrlInventoryRows || replaceUrlInventoryRows,
      formatFn: deps.formatUrlInventory || formatUrlInventoryTab,
    });
  }

  if (args.enqueue_published) {
    return runEnqueue(args, { sheetToken, workbookId, now });
  }

  if (args.check_due || args.check_all || defaultCheckDue) {
    return runCheckDue(args, {
      sheetToken,
      gscToken: deps.gscToken,
      workbookId,
      now,
      ensureFn: deps.ensureIndexTrackingTab || ensureIndexTrackingTab,
      readRowsFn: deps.readTrackingRows || readTrackingRows,
      updateRowFn: deps.updateTrackingRow || updateTrackingRow,
      fetchInspectionFn: deps.fetchUrlInspection || fetchUrlInspection,
      fetchPageDiagnosticsFn: deps.fetchPageDiagnostics || fetchPageDiagnostics,
      getGscToken: deps.getGscToken || getGscAccessToken,
      preflightGscAccessFn: deps.preflightGscAccess || preflightGscAccess,
      notifyFn: deps.notify || larkBestEffort,
    });
  }

  if (args.sync_recap) {
    return runSyncRecap(args, {
      sheetToken,
      workbookId,
      now,
      readRowsFn: deps.readTrackingRows || readTrackingRows,
      readRecapRowsFn: deps.readRecapRows || readRecapRows,
      updateRecapRowFn: deps.updateRecapRow || updateRecapRow,
      appendRecapRowsFn: deps.appendRecapRows || appendRecapRows,
      batchUpdateRecapRowsFn: deps.updateRecapRow || deps.appendRecapRows
        ? deps.batchUpdateRecapRows || null
        : deps.batchUpdateRecapRows || batchUpdateRecapRows,
      formatRecapStatusFn: deps.formatRecapStatus || (deps.updateRecapRow || deps.appendRecapRows
        ? null
        : formatRecapStatusTab),
    });
  }

  if (args.process_fixed) {
    return runProcessFixed(args, {
      sheetToken,
      gscWriteToken: deps.gscWriteToken,
      workbookId,
      now,
      ensureFn: deps.ensureIndexTrackingTab || ensureIndexTrackingTab,
      readRowsFn: deps.readTrackingRows || readTrackingRows,
      readRecapRowsFn: deps.readRecapRows || readRecapRows,
      updateRowFn: deps.updateTrackingRow || updateTrackingRow,
      updateRecapRowFn: deps.updateRecapRow || updateRecapRow,
      formatRecapStatusFn: deps.formatRecapStatus || (deps.updateRecapRow ? null : formatRecapStatusTab),
      getGscWriteToken: deps.getGscWriteToken || getGscWriteAccessToken,
      submitSitemapFn: deps.submitSitemap || submitSitemap,
      notifyFn: deps.notify || larkBestEffort,
    });
  }

  if (args.sync_request_queue) {
    return runSyncRequestQueue(args, {
      sheetToken,
      workbookId,
      now,
      ensureFn: deps.ensureRequestQueueTab || ensureRequestQueueTab,
      readRecapRowsFn: deps.readRecapRows || readRecapRows,
      readTrackingRowsFn: deps.readTrackingRows || readTrackingRows,
      readRequestQueueRowsFn: deps.readRequestQueueRows || readRequestQueueRows,
      replaceRowsFn: deps.replaceRequestQueueRows || replaceRequestQueueRows,
      formatFn: deps.formatRequestQueue || formatRequestQueueTab,
      notifyFn: deps.notify || larkBestEffort,
    });
  }

  process.stderr.write('error: expected --ensure-tab, --sync-published, --sync-url-inventory, --enqueue-published, --check-due, --check-all, --sync-recap, --submit-sitemap, --process-fixed, or --sync-request-queue (see --help)\n');
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runIndexMonitor(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch((e) => {
    process.stderr.write(`fatal: ${e.message}\n`);
    process.exit(1);
  });
}
