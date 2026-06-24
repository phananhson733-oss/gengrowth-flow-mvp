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
  'fix_date',
  'requeued_at',
  'retry_round',
  'recommendation',
  'notes',
  'source',
  'author',
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

const DUE_MILESTONES = Object.freeze([3, 7, 14, 21, 30]);
const DEFAULT_SITE = 'sc-domain:astrologywiki.com';
const DEFAULT_SITE_ORIGIN = 'https://www.astrologywiki.com';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const GSC_READONLY_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const DEFAULT_SITEMAP_URL = 'https://www.astrologywiki.com/sitemap.xml';

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

function isEnWikiArticleUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'www.astrologywiki.com' && u.hostname !== 'astrologywiki.com') return false;
    const path = u.pathname.replace(/\/$/, '');
    return /^\/en\/wiki\/[^/]+$/.test(path);
  } catch {
    return false;
  }
}

function slugFromEnWikiUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, '');
    return decodeURIComponent(path.slice('/en/wiki/'.length));
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
  author = '',
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
    fix_status: '未处理',
    fix_date: '',
    requeued_at: '',
    retry_round: 0,
    recommendation: '',
    notes: '',
    source,
    author: cleanCell(author),
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

function recapRowToValues(row) {
  return RECAP_HEADER.map((h) => {
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
    fix_status: existing.fix_status || fresh.fix_status || '未处理',
    source: fresh.source || existing.source || '',
    author: fresh.author || existing.author || '',
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
  return monitor === 'indexed' || ((verdict === 'PASS' || /\bindexed\b/i.test(status)) && !/not indexed/i.test(status));
}

function hasInspectionEvidence(row = {}) {
  const status = String(row.current_gsc_status || '').trim();
  return !!status && status !== 'pending_first_check';
}

export function recapRowFromTrackingRow(row = {}, { now = new Date() } = {}) {
  const checked = hasInspectionEvidence(row);
  const indexed = isIndexedTrackingRow(row);
  const status = String(row.current_gsc_status || '').trim();
  const monitor = String(row.monitor_status || '').trim();
  const diagnosis = String(row.diagnosis_category || '').trim();
  const fixStatus = !checked
    ? '待GSC检查'
    : indexed
      ? '已收录'
      : `${monitor || '待处理'}${diagnosis ? `：${diagnosis}` : ''}`;
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
    cluster_id: '',
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

function mergeRecapRow(existing = {}, fresh = {}) {
  return {
    ...existing,
    outcome_id: existing.outcome_id || fresh.outcome_id || '',
    page_id: existing.page_id || fresh.page_id || '',
    cluster_id: existing.cluster_id || fresh.cluster_id || '',
    url: fresh.url || existing.url || '',
    'day14_收录': Object.hasOwn(fresh, 'day14_收录') ? fresh['day14_收录'] : existing['day14_收录'] || '',
    '索引修复状态': Object.hasOwn(fresh, '索引修复状态') ? fresh['索引修复状态'] : existing['索引修复状态'] || '',
    '记录日期': Object.hasOwn(fresh, '记录日期') ? fresh['记录日期'] : existing['记录日期'] || '',
    '备注': existing['备注'] || fresh['备注'] || '',
  };
}

export function classifyInspection(indexStatus = {}, { daysSinceFirstTracked = 0, now = new Date() } = {}) {
  const coverageState = String(indexStatus.coverageState || '').trim();
  const verdict = String(indexStatus.verdict || '').trim();
  const indexingState = String(indexStatus.indexingState || '').trim();
  const pageFetchState = String(indexStatus.pageFetchState || '').trim();
  const lc = coverageState.toLowerCase();
  const checkedDay = isoDay(now);
  const base = {
    monitor_status: 'monitoring',
    diagnosis_category: 'monitoring',
    alert_level: '',
    should_alert: false,
    first_indexed_at: '',
    recommendation: 'Continue monitoring.',
  };

  if (/alternate page with proper canonical tag/i.test(coverageState)) {
    return {
      ...base,
      monitor_status: 'canonical_ok',
      diagnosis_category: 'normal_canonical',
      recommendation: 'Canonical consolidation is expected. No action needed for this alternate URL.',
    };
  }

  const looksIndexed = (verdict === 'PASS' || /\bindexed\b/i.test(coverageState)) && !/not indexed/i.test(coverageState);
  if (looksIndexed) {
    return {
      ...base,
      monitor_status: 'indexed',
      diagnosis_category: 'indexed',
      first_indexed_at: checkedDay,
      recommendation: 'Indexed. Stop monitoring unless the URL regresses.',
    };
  }

  if (/not found \(404\)|server error \(5xx\)|blocked due to access forbidden \(403\)/i.test(coverageState)) {
    return {
      ...base,
      monitor_status: 'urgent',
      diagnosis_category: 'technical_failure',
      alert_level: 'P0',
      should_alert: true,
      recommendation: 'Fix crawl access immediately: restore the URL, correct 4xx/5xx, or remove access blocks.',
    };
  }

  if (/blocked by robots\.txt/i.test(coverageState)) {
    return {
      ...base,
      monitor_status: 'urgent',
      diagnosis_category: 'robots_blocked',
      alert_level: 'P0',
      should_alert: true,
      recommendation: 'Check robots.txt and unblock Googlebot if this URL should be indexable.',
    };
  }

  if (/excluded by ['’]?noindex['’]? tag/i.test(coverageState)) {
    return {
      ...base,
      monitor_status: 'needs_attention',
      diagnosis_category: 'noindex',
      alert_level: 'P1',
      should_alert: true,
      recommendation: 'Confirm whether noindex is intentional. Remove it only after human approval.',
    };
  }

  if (lc.includes('crawled - currently not indexed')) {
    if (daysSinceFirstTracked >= 30) {
      return {
        ...base,
        monitor_status: 'needs_focus',
        diagnosis_category: 'content_quality',
        alert_level: 'P1',
        should_alert: true,
        recommendation: 'D+30 unresolved. Escalate as a focus URL: review content depth, internal links, duplicate overlap, metadata, and crawlable HTML.',
      };
    }
    const overdue = daysSinceFirstTracked >= 14;
    return {
      ...base,
      monitor_status: overdue ? 'needs_attention' : 'monitoring',
      diagnosis_category: 'content_quality',
      alert_level: overdue ? 'P1' : '',
      should_alert: overdue,
      recommendation: overdue
        ? 'Review content quality, internal links, duplicate overlap, metadata, and crawlable HTML.'
        : 'Wait until D+14 before escalating content quality.',
    };
  }

  if (lc.includes('discovered - currently not indexed')) {
    if (daysSinceFirstTracked >= 30) {
      return {
        ...base,
        monitor_status: 'needs_focus',
        diagnosis_category: 'normal_queue',
        alert_level: 'P1',
        should_alert: true,
        recommendation: 'D+30 unresolved. Escalate as a focus URL: improve internal links, sitemap discovery signals, and crawl priority.',
      };
    }
    const overdue = daysSinceFirstTracked >= 21;
    return {
      ...base,
      monitor_status: overdue ? 'needs_attention' : 'monitoring',
      diagnosis_category: 'normal_queue',
      alert_level: overdue ? 'P2' : '',
      should_alert: overdue,
      recommendation: overdue
        ? 'Still discovered at D+21. Improve internal links and check sitemap discovery signals.'
        : 'Normal queue state for a new site. Continue monitoring without alert noise.',
    };
  }

  if (/duplicate|canonical/i.test(coverageState)) {
    if (daysSinceFirstTracked >= 30) {
      return {
        ...base,
        monitor_status: 'needs_focus',
        diagnosis_category: 'canonical_duplicate',
        alert_level: 'P2',
        should_alert: true,
        recommendation: 'D+30 unresolved. Escalate canonical/duplicate review and decide whether this URL should remain monitored.',
      };
    }
    return {
      ...base,
      monitor_status: daysSinceFirstTracked >= 14 ? 'needs_attention' : 'monitoring',
      diagnosis_category: 'canonical_duplicate',
      alert_level: daysSinceFirstTracked >= 14 ? 'P2' : '',
      should_alert: daysSinceFirstTracked >= 14,
      recommendation: 'Review canonical tags, duplicate content, and sitemap URL selection.',
    };
  }

  if (/soft 404|page with redirect|blocked due to other 4xx/i.test(coverageState)) {
    return {
      ...base,
      monitor_status: 'needs_attention',
      diagnosis_category: 'indexing_configuration',
      alert_level: 'P2',
      should_alert: true,
      recommendation: 'Review page body, redirects, and HTTP status semantics.',
    };
  }

  const overdue = daysSinceFirstTracked >= 14 || verdict === 'FAIL' || pageFetchState === 'FAILED';
  return {
    ...base,
    monitor_status: overdue ? 'needs_attention' : 'monitoring',
    diagnosis_category: overdue ? 'unknown_attention' : 'unknown_waiting',
    alert_level: overdue ? 'P3' : '',
    should_alert: overdue,
    recommendation: overdue
      ? 'Review raw URL Inspection status and decide manually.'
      : 'Continue monitoring.',
    indexing_state: indexingState,
  };
}

export function isDueForInspection(row = {}, now = new Date()) {
  if (!['monitoring', 'needs_attention'].includes(String(row.monitor_status || 'monitoring'))) return false;
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

export function mergeInspectionIntoRow(row, indexStatus, now = new Date()) {
  const checkedDay = isoDay(now);
  const days = daysBetween(row.first_tracked_at, now);
  const cls = classifyInspection(indexStatus, { daysSinceFirstTracked: days, now });
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
    recommendation: cls.recommendation,
  };
  if (cls.first_indexed_at && !next.first_indexed_at) {
    next.first_indexed_at = cls.first_indexed_at;
    next.days_to_index = daysBetween(row.first_tracked_at, `${cls.first_indexed_at}T00:00:00Z`);
  }
  return { row: next, classification: cls };
}

export function formatAlertMessage(row, classification) {
  const level = classification.alert_level || row.alert_level || 'P3';
  const title = row.title || row.slug || row.page_id || row.url;
  const age = row.days_since_first_tracked || 0;
  return [
    `⚠️ 索引监控告警（${level}）`,
    `页面：${title}`,
    `URL：${row.url}`,
    `page_id：${row.page_id || '-'}`,
    `已监控天数：D+${age}`,
    `当前 GSC 状态：${row.current_gsc_status || '-'}`,
    `诊断类别：${row.diagnosis_category || classification.diagnosis_category || '-'}`,
    `建议操作：${row.recommendation || classification.recommendation || '请人工查看 URL Inspection 原始状态。'}`,
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

async function runSyncRecap(args, {
  sheetToken,
  workbookId,
  now,
  readRowsFn = readTrackingRows,
  readRecapRowsFn = readRecapRows,
  updateRecapRowFn = updateRecapRow,
  appendRecapRowsFn = appendRecapRows,
  batchUpdateRecapRowsFn = null,
}) {
  if (!workbookId) {
    process.stderr.write('error: --sync-recap requires workbook id from env or --workbook\n');
    return 1;
  }
  const tracking = await readRowsFn(sheetToken, workbookId, INDEX_TRACKING_TAB);
  const recap = await readRecapRowsFn(sheetToken, workbookId, RECAP_TAB);
  const byUrl = new Map(recap.map((row) => [normalizeUrl(row.url), row]));
  const toAppend = [];
  const toUpdate = [];
  let skipped = 0;

  for (const row of tracking) {
    if (!isEnWikiArticleUrl(row.url)) {
      skipped++;
      continue;
    }
    const fresh = recapRowFromTrackingRow(row, { now });
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
  }

  process.stdout.write(
    `sync-recap: source=${INDEX_TRACKING_TAB} en_rows=${tracking.length} appended=${toAppend.length} updated=${toUpdate.length} skipped=${skipped} mode=${args.write_sheet ? 'write-sheet' : 'dry-run'}\n`,
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
      !['indexed', 'canonical_ok'].includes(String(row.monitor_status || 'monitoring')) &&
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
      const merged = mergeInspectionIntoRow(row, indexStatus, now);
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
      '  node tools/scripts/gg-index-monitor.mjs --enqueue-published --page-id PG-... --slug slug --title "Title" --published-at YYYY-MM-DD --write-sheet',
      '  node tools/scripts/gg-index-monitor.mjs --check-due --write-sheet [--limit 50]',
      '  node tools/scripts/gg-index-monitor.mjs --check-all --write-sheet [--limit 200]',
      '  node tools/scripts/gg-index-monitor.mjs --sync-recap --write-sheet',
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
  if (!sheetToken && (args.write_sheet || args.check_due || args.check_all || defaultCheckDue || args.ensure_tab || args.sync_published || args.sync_recap)) {
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
    });
  }

  process.stderr.write('error: expected --ensure-tab, --sync-published, --enqueue-published, --check-due, --check-all, or --sync-recap (see --help)\n');
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runIndexMonitor(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch((e) => {
    process.stderr.write(`fatal: ${e.message}\n`);
    process.exit(1);
  });
}
