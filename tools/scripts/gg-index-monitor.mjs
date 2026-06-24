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
import { fileURLToPath } from 'node:url';
import { loadEnv, gFetch, resolveWorkbookId, redactNote } from './lib/gg-shared.mjs';
import { getAccessToken } from './lib/_oauth-token.mjs';

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

const DUE_MILESTONES = Object.freeze([3, 7, 14, 21, 30]);
const DEFAULT_SITE = 'sc-domain:astrologywiki.com';
const DEFAULT_SITE_ORIGIN = 'https://www.astrologywiki.com';

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

export function buildTrackingSeedRow({
  pageId,
  slug,
  url,
  title = '',
  author = '',
  publishedAt,
  now = new Date(),
  source = 'seo-autopilot',
  site = DEFAULT_SITE,
} = {}) {
  if (!pageId) throw new Error('buildTrackingSeedRow: pageId required');
  if (!slug && !url) throw new Error('buildTrackingSeedRow: slug or url required');
  const day = isoDay(now);
  const finalUrl = url || `${siteOrigin(site)}/en/wiki/${slug}`;
  return {
    url: finalUrl,
    page_id: pageId,
    slug: slug || '',
    title: cleanCell(title),
    published_at: publishedAt || day,
    first_tracked_at: day,
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

async function runCheckDue(args, { sheetToken, gscToken, workbookId, now }) {
  if (!workbookId) {
    process.stderr.write('error: --check-due requires workbook id from env or --workbook\n');
    return 1;
  }
  const writeSheet = !!args.write_sheet;
  const tabName = writeSheet
    ? await ensureIndexTrackingTab(sheetToken, workbookId)
    : INDEX_TRACKING_TAB;
  let rows;
  try {
    rows = await readTrackingRows(sheetToken, workbookId, tabName);
  } catch (e) {
    process.stderr.write(`error: cannot read ${tabName} — ${e.message}\n`);
    return 1;
  }
  const limit = Number(args.limit || 50) || 50;
  const due = rows.filter((row) => isDueForInspection(row, now)).slice(0, limit);
  process.stderr.write(`gg-index-monitor: rows=${rows.length} due=${due.length} mode=${writeSheet ? 'write-sheet' : 'dry-run'}\n`);
  if (!due.length) {
    process.stdout.write('no due URLs\n');
    return 0;
  }

  const siteUrl = args.site || process.env.GG_GSC_SITE || DEFAULT_SITE;
  let failures = 0;
  let alerts = 0;
  for (const row of due) {
    try {
      const indexStatus = await fetchUrlInspection(gscToken, siteUrl, row.url);
      const merged = mergeInspectionIntoRow(row, indexStatus, now);
      if (merged.classification.should_alert) {
        alerts++;
        if (writeSheet && !merged.row.alert_sent_at) {
          merged.row.alert_sent_at = isoDay(now);
          larkBestEffort(formatAlertMessage(merged.row, merged.classification));
        }
      }
      if (writeSheet) await updateTrackingRow(sheetToken, workbookId, tabName, row._rowNumber, merged.row);
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
        try { await updateTrackingRow(sheetToken, workbookId, tabName, row._rowNumber, failed); } catch { /* keep going */ }
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
  if (args.help || args.h) {
    process.stdout.write([
      'gg-index-monitor.mjs — URL Inspection → index-tracking',
      'Usage:',
      '  node tools/scripts/gg-index-monitor.mjs --ensure-tab [--workbook SHEET_ID]',
      '  node tools/scripts/gg-index-monitor.mjs --enqueue-published --page-id PG-... --slug slug --title "Title" --published-at YYYY-MM-DD --write-sheet',
      '  node tools/scripts/gg-index-monitor.mjs --check-due --write-sheet [--limit 50]',
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
  if (!sheetToken && (args.write_sheet || args.check_due || args.ensure_tab)) {
    try {
      sheetToken = await (deps.getSheetToken || getAccessToken)();
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

  if (args.enqueue_published) {
    return runEnqueue(args, { sheetToken, workbookId, now });
  }

  if (args.check_due || Object.keys(args).length === 0) {
    let gscToken = deps.gscToken;
    if (!gscToken) {
      try {
        gscToken = await (deps.getGscToken || getAccessToken)({ user: true });
      } catch (e) {
        process.stderr.write(`error: cannot mint GSC user token — ${e.message}\n`);
        return 1;
      }
    }
    return runCheckDue(args, { sheetToken, gscToken, workbookId, now });
  }

  process.stderr.write('error: expected --ensure-tab, --enqueue-published, or --check-due (see --help)\n');
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runIndexMonitor(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch((e) => {
    process.stderr.write(`fatal: ${e.message}\n`);
    process.exit(1);
  });
}
