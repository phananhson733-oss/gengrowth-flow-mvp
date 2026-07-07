#!/usr/bin/env node
// gg-recap-performance.mjs — GSC/GA4 milestone metrics → 结果复盘表 + Markdown action list.
//
// It reads page identity/publish dates from index-tracking, updates only the
// performance columns in 结果复盘表, and writes a human action list. It does not
// author, edit, publish, deploy, or request indexing for any page.

import { mkdir, writeFile as fsWriteFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getAccessToken as getUserAccessToken } from './lib/_oauth-token.mjs';
import { gFetch, loadEnv, resolveWorkbookId } from './lib/gg-shared.mjs';
import {
  INDEX_TRACKING_TAB,
  RECAP_HEADER,
  RECAP_TAB,
  batchUpdateRecapRows,
  getSheetAccessToken,
  readRecapRows,
  readTrackingRows,
} from './gg-index-monitor.mjs';

const DEFAULT_SITE = 'sc-domain:astrologywiki.com';
const DEFAULT_SITE_NAME = 'AstrologyWiki';
const DEFAULT_TARGET_COUNTRY = 'US';
const HIGH_IMPRESSIONS = 100;
const LOW_CTR = 0.01;
const TOP10_LOW_CTR = 0.02;
const TARGET_COUNTRY_SHARE_MIN = 0.5;

export const RECAP_PERFORMANCE_REPORT_DIR = join(homedir(), 'gengrowth-agents', 'reports', 'recap-performance');

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
  const d = value instanceof Date ? value : new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function dayNumber(dateText) {
  const d = new Date(`${String(dateText || '').slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 86400000);
}

function addDays(dateText, days) {
  const d = new Date(`${String(dateText || '').slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + days);
  return isoDay(d);
}

function trailingWindow(days, now = new Date()) {
  const endDate = addDays(isoDay(now), -1);
  return {
    startDate: addDays(endDate, -(days - 1)),
    endDate,
  };
}

function daysSince(dateText, now = new Date()) {
  const start = dayNumber(dateText);
  const end = dayNumber(isoDay(now));
  if (start == null || end == null) return 0;
  return Math.max(0, end - start);
}

function normalizeUrl(url) {
  const s = String(url || '').trim();
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function isEnglishArticleUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, '');
    return /^\/en\/wiki\/[^/]+$/.test(path) || /^\/en\/blog\/[^/]+$/.test(path);
  } catch {
    return false;
  }
}

function slugFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.replace(/\/$/, '').split('/').filter(Boolean);
    return decodeURIComponent(parts[parts.length - 1] || '');
  } catch {
    return '';
  }
}

function pagePathFromUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname + (u.search || '');
  } catch {
    return '';
  }
}

export function extractPageSignalsFromHtml(html = '') {
  const raw = String(html || '');
  return {
    has_faq_schema: /"@type"\s*:\s*(\[[\s\S]*?["']FAQPage["']|["']FAQPage["'])/i.test(raw) ||
      /https?:\/\/schema\.org\/FAQPage/i.test(raw),
  };
}

export async function fetchPageSignals(url, { fetcher = fetch } = {}) {
  try {
    const res = await fetcher(url);
    if (!res?.ok) return { has_faq_schema: '' };
    return extractPageSignalsFromHtml(await res.text());
  } catch {
    return { has_faq_schema: '' };
  }
}

export function detectTrendContext(row = {}, now = new Date()) {
  const text = `${row.slug || slugFromUrl(row.url)} ${row.title || ''}`.toLowerCase();
  const isTrendPage = /\b(world-cup|cup|vs|eclipse|championship|zodiac-sign|birth-chart|girlfriend)\b/.test(text);
  if (!isTrendPage) return { is_trend_page: false, event_status: '' };
  const years = [...text.matchAll(/\b(20[0-9]{2})\b/g)].map((m) => Number(m[1]));
  const currentYear = Number(isoDay(now).slice(0, 4));
  const ended = years.length > 0 && Math.max(...years) < currentYear;
  return {
    is_trend_page: true,
    event_status: ended ? 'ended' : 'active',
  };
}

function siteOrigin(site) {
  if (String(site || '').startsWith('sc-domain:')) return `https://${String(site).slice('sc-domain:'.length)}`;
  if (/^https?:\/\//.test(String(site || ''))) return String(site).replace(/\/$/, '');
  return '';
}

function siteTag(site) {
  const host = String(site || DEFAULT_SITE)
    .replace(/^sc-domain:/, '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '');
  return host.split('.')[0] || 'site';
}

function siteNameFor(site) {
  const tag = siteTag(site);
  if (tag === 'astrologywiki') return 'AstrologyWiki';
  if (tag === 'gengrowth') return 'GenGrowth';
  return tag.charAt(0).toUpperCase() + tag.slice(1);
}

function toNumber(value, fallback = 0) {
  if (value === '' || value == null) return fallback;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

function fmtInt(value) {
  return Math.round(toNumber(value, 0)).toLocaleString('en-US');
}

function fmtPct(value) {
  const n = toNumber(value, 0);
  return `${(n * 100).toFixed(n * 100 < 1 ? 1 : 0)}%`;
}

function fmtPosition(value) {
  const n = toNumber(value, 0);
  if (!n) return '';
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

function parsePosition(value) {
  const m = String(value || '').match(/P\s*([0-9]+(?:\.[0-9]+)?)/i);
  return m ? Number(m[1]) : null;
}

function isPendingMetric(value) {
  const text = String(value ?? '').trim();
  return text === '' || text === '待回填';
}

function needsMetricWindow(recap = {}, milestone) {
  if (milestone === 'day14') return isPendingMetric(recap.day14_impressions);
  if (milestone === 'day30') {
    return isPendingMetric(recap.day30_进Top50词数) ||
      isPendingMetric(recap['当前最高排名词（排名）']) ||
      isPendingMetric(recap.day30_clicks);
  }
  if (milestone === 'day60') {
    return isPendingMetric(recap.day60_pv) ||
      isPendingMetric(recap.day60_目标国pv);
  }
  return false;
}

function recapComparable(row) {
  return JSON.stringify(RECAP_HEADER.map((h) => row?.[h] ?? ''));
}

function replaceGeneratedNote(existing, generated) {
  const parts = String(existing || '')
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !/^Performance recap\b/.test(p));
  parts.push(generated);
  return parts.join(' | ');
}

function countryExpression(country) {
  const code = String(country || '').trim().toUpperCase();
  const map = {
    US: 'USA',
    GB: 'GBR',
    UK: 'GBR',
    CA: 'CAN',
    AU: 'AUS',
    IN: 'IND',
  };
  return map[code] || code;
}

function countryName(country) {
  const code = String(country || '').trim().toUpperCase();
  const map = {
    US: 'United States',
    GB: 'United Kingdom',
    UK: 'United Kingdom',
    CA: 'Canada',
    AU: 'Australia',
    IN: 'India',
  };
  return map[code] || code;
}

export function buildPerformancePlan({ trackingRows = [], recapRows = [], now = new Date(), fillPending = false } = {}) {
  const recapByUrl = new Map(recapRows.filter((row) => row.url).map((row) => [normalizeUrl(row.url), row]));
  const recapByPage = new Map(recapRows.filter((row) => row.page_id).map((row) => [String(row.page_id).trim(), row]));
  const plan = [];
  for (const tracking of trackingRows) {
    const url = normalizeUrl(tracking.url);
    if (!url || !isEnglishArticleUrl(url)) continue;
    const recap = recapByUrl.get(url) || recapByPage.get(String(tracking.page_id || '').trim());
    if (!recap) continue;
    const published = isoDay(tracking.published_at || tracking.first_tracked_at);
    if (!published) continue;
    const age = daysSince(published, now);
    const windows = [];
    for (const [milestone, days] of [['day14', 14], ['day30', 30], ['day60', 60]]) {
      if (fillPending) {
        if (!needsMetricWindow(recap, milestone)) continue;
        windows.push({
          milestone,
          days,
          ...trailingWindow(days, now),
          source: 'pending-metric',
        });
        continue;
      }
      if (age < days) continue;
      windows.push({
        milestone,
        days,
        startDate: published,
        endDate: addDays(published, days - 1),
        source: 'scheduled-milestone',
      });
    }
    if (!windows.length) continue;
    plan.push({
      page_id: tracking.page_id || recap.page_id || '',
      url,
      slug: tracking.slug || slugFromUrl(url),
      title: tracking.title || '',
      tracking,
      recap,
      windows,
    });
  }
  return plan;
}

export function mergePerformanceIntoRecapRow({
  old = {},
  tracking = {},
  performance = {},
  now = new Date(),
  fillPendingOnly = false,
} = {}) {
  const merged = { ...old };
  merged.outcome_id = merged.outcome_id || (tracking.page_id ? `out_${tracking.page_id}_latest` : '');
  merged.page_id = merged.page_id || tracking.page_id || '';
  merged.url = merged.url || tracking.url || '';
  merged.记录日期 = isoDay(now);

  if (performance.day14) {
    if (!fillPendingOnly || isPendingMetric(merged.day14_impressions)) {
      merged.day14_impressions = performance.day14.impressions ?? 0;
    }
  }
  if (performance.day30) {
    if (!fillPendingOnly || isPendingMetric(merged.day30_进Top50词数)) {
      merged.day30_进Top50词数 = performance.day30.top50Count ?? 0;
    }
    if (!fillPendingOnly || isPendingMetric(merged.day30_clicks)) {
      merged.day30_clicks = performance.day30.clicks ?? 0;
    }
    if (!fillPendingOnly || isPendingMetric(merged['当前最高排名词（排名）'])) {
      merged['当前最高排名词（排名）'] = performance.day30.bestQuery && performance.day30.bestPosition
        ? `${performance.day30.bestQuery} (P${fmtPosition(performance.day30.bestPosition)})`
        : '无';
    }
  }
  if (performance.day60) {
    if (!fillPendingOnly || isPendingMetric(merged.day60_pv)) {
      merged.day60_pv = performance.day60.pageViews ?? 0;
    }
    if (!fillPendingOnly || isPendingMetric(merged.day60_目标国pv)) {
      merged.day60_目标国pv = performance.day60.targetCountryPageViews ?? 0;
    }
  }

  const noteBits = [
    'Performance recap',
    tracking.published_at ? `published=${tracking.published_at}` : '',
    performance.day14 ? `d14_impr=${performance.day14.impressions ?? 0}` : '',
    performance.day30 ? `d30_clicks=${performance.day30.clicks ?? 0}` : '',
    performance.day60 ? `d60_pv=${performance.day60.pageViews ?? 0}` : '',
    `recorded=${isoDay(now)}`,
  ].filter(Boolean);
  merged.备注 = replaceGeneratedNote(merged.备注, noteBits.join(' '));
  return merged;
}

export function classifyOptimizationTasks(row = {}) {
  const slug = row.slug || slugFromUrl(row.url) || row.page_id || 'unknown-page';
  const title = row.title || slug;
  const impressions = toNumber(row.day14_impressions, 0);
  const clicks = toNumber(row.day30_clicks, 0);
  const top50 = row.day30_进Top50词数 === '' || row.day30_进Top50词数 == null
    ? null
    : toNumber(row.day30_进Top50词数, 0);
  const bestPosition = parsePosition(row['当前最高排名词（排名）']);
  const ctr = impressions > 0 ? clicks / impressions : 0;
  const pageViews = toNumber(row.day60_pv, 0);
  const targetPv = toNumber(row.day60_目标国pv, 0);
  const indexed = String(row.day14_收录 || '').trim().toUpperCase() === 'Y';
  const tasks = [];
  const push = (bucket, reason, action) => tasks.push({ bucket, slug, title, url: row.url || '', reason, action });

  if (indexed && impressions === 0) {
    push('技术排查', '已收录但零曝光', '排查技术问题，检查 URL、canonical、noindex、sitemap 与页面渲染');
    return tasks;
  }
  if (indexed && impressions > 0 && impressions < 10) {
    push('P2', `曝光仅 ${fmtInt(impressions)} 次`, '标记观察，60天后再看');
    return tasks;
  }
  if (impressions >= HIGH_IMPRESSIONS && ctr < LOW_CTR) {
    push('P0', `曝光 ${fmtInt(impressions)} 次，CTR 仅 ${fmtPct(ctr)}`, '改 title + meta description');
  }
  if (bestPosition != null && bestPosition <= 10 && ctr < TOP10_LOW_CTR) {
    push('P0', `最高排名 P${fmtPosition(bestPosition)}，CTR 仅 ${fmtPct(ctr)}`, '重点优化 title 和描述，争取提升 CTR');
  }
  if (bestPosition != null && bestPosition > 10 && bestPosition <= 30) {
    push('P1', `最高排名 P${fmtPosition(bestPosition)}`, '加内链 + 确认 FAQ schema');
  }
  if (impressions >= HIGH_IMPRESSIONS && row.has_faq_schema === false) {
    push('P1', `曝光 ${fmtInt(impressions)} 次但未检测到 FAQ schema`, '补充 FAQ schema');
  }
  if (top50 === 0 && impressions >= 10) {
    push('P1', '上线一个月仍无关键词进 Top50', '检查内容结构，重新对齐搜索意图');
  }
  if (pageViews >= 20 && targetPv / pageViews < TARGET_COUNTRY_SHARE_MIN) {
    push('P2', `目标英语区 PV ${fmtInt(targetPv)} / 总 PV ${fmtInt(pageViews)}`, '检查关键词设置和语言定向');
  }
  if (row.is_trend_page && row.event_status !== 'ended' && toNumber(row.impressions_delta_pct, 0) <= -0.4) {
    push('P1', `趋势词曝光快速下滑 ${fmtPct(Math.abs(toNumber(row.impressions_delta_pct, 0)))}`, '事件未结束，追加内容更新');
  }
  if (row.is_trend_page && row.event_status === 'ended' && toNumber(row.impressions_delta_pct, 0) < 0) {
    push('P2', '事件已结束且曝光衰退', '不再投入，保留观察');
  }
  return tasks;
}

export function renderOptimizationMarkdown(tasks = [], {
  generatedAt = new Date(),
  siteName = DEFAULT_SITE_NAME,
} = {}) {
  const titles = [
    ['技术排查', '【技术排查】'],
    ['P0', '【P0 立即处理】'],
    ['P1', '【P1 本周处理】'],
    ['P2', '【P2 下周处理】'],
  ];
  const lines = [
    `# ${siteName} 博客优化任务清单`,
    '',
    `生成时间：${isoDay(generatedAt)}`,
    '',
  ];
  for (const [bucket, heading] of titles) {
    const rows = tasks.filter((task) => task.bucket === bucket);
    if (!rows.length) continue;
    lines.push(heading);
    for (const task of rows) {
      lines.push(`- ${task.slug}：${task.reason}，${task.action}`);
    }
    lines.push('');
  }
  if (!tasks.length) {
    lines.push('今日无需要处理的优化任务。', '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export async function fetchGscUrlMetrics(token, site, url, window, {
  targetCountry = DEFAULT_TARGET_COUNTRY,
  fetcher = gFetch,
} = {}) {
  const filters = [
    { dimension: 'page', operator: 'equals', expression: url },
  ];
  if (targetCountry) {
    filters.push({ dimension: 'country', operator: 'equals', expression: countryExpression(targetCountry) });
  }
  const body = await fetcher(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`,
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        startDate: window.startDate,
        endDate: window.endDate,
        dimensions: ['query'],
        dimensionFilterGroups: [{ filters }],
        rowLimit: 25000,
      }),
    },
  );
  const rows = body.rows || [];
  let clicks = 0;
  let impressions = 0;
  let bestQuery = '';
  let bestPosition = null;
  let top50Count = 0;
  for (const row of rows) {
    const pos = Number(row.position || 0);
    clicks += Number(row.clicks || 0);
    impressions += Number(row.impressions || 0);
    if (pos && pos <= 50) top50Count++;
    if (pos && (bestPosition == null || pos < bestPosition)) {
      bestPosition = pos;
      bestQuery = row.keys?.[0] || '';
    }
  }
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    bestQuery,
    bestPosition,
    top50Count,
  };
}

async function fetchGa4PageViewCount(token, property, { startDate, endDate, pagePath, targetCountry = null, fetcher = gFetch }) {
  if (!property || !pagePath) return 0;
  const filters = [{
    filter: {
      fieldName: 'pagePath',
      stringFilter: { matchType: 'EXACT', value: pagePath },
    },
  }];
  if (targetCountry) {
    filters.push({
      filter: {
        fieldName: 'country',
        stringFilter: { matchType: 'EXACT', value: countryName(targetCountry) },
      },
    });
  }
  const body = await fetcher(
    `https://analyticsdata.googleapis.com/v1beta/${property}:runReport`,
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'pagePath' }],
        metrics: [{ name: 'screenPageViews' }],
        dimensionFilter: filters.length === 1 ? filters[0] : { andGroup: { expressions: filters } },
        limit: 1,
      }),
    },
  );
  return Number(body.rows?.[0]?.metricValues?.[0]?.value || 0);
}

export async function fetchGa4PageViews(token, property, url, window, {
  targetCountry = DEFAULT_TARGET_COUNTRY,
  fetcher = gFetch,
} = {}) {
  if (!property) return { pageViews: '', targetCountryPageViews: '' };
  const pagePath = pagePathFromUrl(url);
  const pageViews = await fetchGa4PageViewCount(token, property, {
    startDate: window.startDate,
    endDate: window.endDate,
    pagePath,
    fetcher,
  });
  const targetCountryPageViews = await fetchGa4PageViewCount(token, property, {
    startDate: window.startDate,
    endDate: window.endDate,
    pagePath,
    targetCountry,
    fetcher,
  });
  return { pageViews, targetCountryPageViews };
}

export async function fetchGscTrendMomentum(token, site, url, {
  now = new Date(),
  targetCountry = DEFAULT_TARGET_COUNTRY,
  fetchGscUrlMetricsFn = fetchGscUrlMetrics,
} = {}) {
  const today = dayNumber(isoDay(now));
  if (today == null) return { impressions_delta_pct: '' };
  const recentEnd = addDays(isoDay(now), -1);
  const recentStart = addDays(recentEnd, -6);
  const previousEnd = addDays(recentStart, -1);
  const previousStart = addDays(previousEnd, -6);
  const previous = await fetchGscUrlMetricsFn(token, site, url, {
    milestone: 'trend_previous_7d',
    startDate: previousStart,
    endDate: previousEnd,
  }, { targetCountry });
  const recent = await fetchGscUrlMetricsFn(token, site, url, {
    milestone: 'trend_recent_7d',
    startDate: recentStart,
    endDate: recentEnd,
  }, { targetCountry });
  const prev = toNumber(previous.impressions, 0);
  const cur = toNumber(recent.impressions, 0);
  return {
    impressions_delta_pct: prev > 0 ? (cur - prev) / prev : '',
    trend_previous_impressions: prev,
    trend_recent_impressions: cur,
  };
}

function reportPathFor({ now, site, reportDir = RECAP_PERFORMANCE_REPORT_DIR }) {
  return join(reportDir, `${isoDay(now)}-${siteTag(site)}-optimization-tasks.md`);
}

export async function runRecapPerformance(argv, deps = {}) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    process.stdout.write([
      'gg-recap-performance.mjs — GSC/GA4 milestone metrics → 结果复盘表 + Markdown action list',
      'Usage:',
      '  node tools/scripts/gg-recap-performance.mjs --write-sheet --write-report [--workbook SHEET_ID] [--site sc-domain:DOMAIN] [--ga4-property properties/ID]',
      '  node tools/scripts/gg-recap-performance.mjs --dry-run [--workbook SHEET_ID]',
      '',
    ].join('\n'));
    return 0;
  }

  loadEnv();
  const now = deps.now || new Date();
  const site = args.site && args.site !== true ? String(args.site) : (process.env.GG_GSC_SITE || DEFAULT_SITE);
  const workbookId = args.workbook && args.workbook !== true ? String(args.workbook) : resolveWorkbookId();
  const ga4Property = args.ga4_property && args.ga4_property !== true
    ? String(args.ga4_property)
    : (process.env.GG_GA4_PROPERTY || (process.env.GG_GA4_PROPERTY_ID ? `properties/${process.env.GG_GA4_PROPERTY_ID}` : ''));
  const targetCountry = args.target_country && args.target_country !== true
    ? String(args.target_country)
    : (process.env.GG_TARGET_COUNTRY || DEFAULT_TARGET_COUNTRY);
  const writeSheet = !!args.write_sheet;
  const writeReport = !!args.write_report;
  const fillPending = !!args.fill_pending;
  const reportDir = args.report_dir && args.report_dir !== true ? String(args.report_dir) : RECAP_PERFORMANCE_REPORT_DIR;

  if (!workbookId) {
    process.stderr.write('error: workbook id required from --workbook or GG_SHEETS_FLOW_MVP_WORKBOOK_ID/GG_SHEETS_WORKBOOK_ID\n');
    return 1;
  }

  let sheetToken = deps.sheetToken;
  if (!sheetToken) {
    try {
      sheetToken = await (deps.getSheetToken || getSheetAccessToken)();
    } catch (e) {
      process.stderr.write(`error: cannot mint Sheets token — ${e.message}\n`);
      return 1;
    }
  }
  let analyticsToken = deps.analyticsToken;
  if (!analyticsToken) {
    try {
      analyticsToken = await (deps.getAnalyticsToken || getUserAccessToken)({ user: true });
    } catch (e) {
      process.stderr.write(`error: cannot mint GSC/GA4 user token — ${e.message}\n`);
      return 1;
    }
  }

  const readTrackingRowsFn = deps.readTrackingRows || readTrackingRows;
  const readRecapRowsFn = deps.readRecapRows || readRecapRows;
  const trackingRows = await readTrackingRowsFn(sheetToken, workbookId, INDEX_TRACKING_TAB);
  const recapRows = await readRecapRowsFn(sheetToken, workbookId, RECAP_TAB);
  const plan = buildPerformancePlan({ trackingRows, recapRows, now, fillPending });

  const updates = [];
  const tasks = [];
  let failures = 0;
  for (const item of plan) {
    const performance = {};
    for (const window of item.windows) {
      try {
        if (window.milestone === 'day14' || window.milestone === 'day30') {
          performance[window.milestone] = await (deps.fetchGscUrlMetrics || fetchGscUrlMetrics)(
            analyticsToken,
            site,
            item.url,
            window,
            { targetCountry },
          );
        }
        if (window.milestone === 'day60') {
          performance.day60 = await (deps.fetchGa4PageViews || fetchGa4PageViews)(
            analyticsToken,
            ga4Property,
            item.url,
            window,
            { targetCountry },
          );
        }
      } catch (e) {
        failures++;
        process.stderr.write(`warn: metrics fetch failed ${item.page_id || item.url} ${window.milestone}: ${e.message}\n`);
      }
    }
    const merged = mergePerformanceIntoRecapRow({
      old: item.recap,
      tracking: item.tracking,
      performance,
      now,
      fillPendingOnly: fillPending,
    });
    if (recapComparable(item.recap) !== recapComparable(merged)) {
      updates.push({ old: item.recap, merged });
    }
    let pageSignals = {};
    try {
      pageSignals = await (deps.fetchPageSignals || fetchPageSignals)(item.url);
    } catch {
      pageSignals = {};
    }
    const trendContext = detectTrendContext(item, now);
    let trendMomentum = {};
    if (trendContext.is_trend_page) {
      try {
        trendMomentum = await (deps.fetchGscTrendMomentum || fetchGscTrendMomentum)(
          analyticsToken,
          site,
          item.url,
          { now, targetCountry },
        );
      } catch {
        trendMomentum = {};
      }
    }
    tasks.push(...classifyOptimizationTasks({
      ...merged,
      slug: item.slug,
      title: item.title,
      ...pageSignals,
      ...trendContext,
      ...trendMomentum,
    }));
  }

  if (writeSheet && updates.length) {
    await (deps.batchUpdateRecapRows || batchUpdateRecapRows)(sheetToken, workbookId, RECAP_TAB, updates, []);
  }

  const markdown = renderOptimizationMarkdown(tasks, {
    generatedAt: now,
    siteName: args.site_name && args.site_name !== true ? String(args.site_name) : siteNameFor(site),
  });
  if (writeReport) {
    const out = reportPathFor({ now, site, reportDir });
    if (!deps.writeFile) await (deps.mkdir || mkdir)(reportDir, { recursive: true });
    await (deps.writeFile || fsWriteFile)(out, markdown, 'utf8');
    process.stdout.write(`wrote report: ${out}\n`);
  } else {
    process.stdout.write(markdown);
  }

  process.stdout.write(
    `recap-performance: rows=${plan.length} updated=${updates.length} tasks=${tasks.length} mode=${writeSheet ? 'write-sheet' : 'dry-run'}${fillPending ? ' fill_pending=1' : ''}\n`,
  );
  return failures ? 2 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRecapPerformance(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch((e) => {
    process.stderr.write(`fatal: ${e.stack || e.message}\n`);
    process.exit(1);
  });
}
