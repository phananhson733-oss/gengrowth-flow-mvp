#!/usr/bin/env node
// gg-monitor.mjs — PIPELINE.md Stage 17: weekly GSC + GA4 → 内容追踪
//
// Pulls per-URL GSC (clicks/impressions/ctr/position) + per-pagePath GA4
// engagement (sessions/avg_dwell_s/engagement_rate) + CTA event counts,
// outer-joins them, and either prints a markdown table (--dry-run) or
// appends rows to the workbook monitor tab (--write-sheet).
//
// CLI:
//   node tools/scripts/gg-monitor.mjs --site sc-domain:DOMAIN \
//     [--ga4-property properties/<id>] [--since 7d|30d] \
//     [--dry-run] [--write-sheet] [--cta-event NAME]
//
// Schema: report_date|url|clicks|impressions|ctr|position|sessions|
//         avg_dwell_s|engagement_rate|cta_signups
//
// Tab routing: canonical "内容追踪" is a manual planning view (14-col
// 预期 vs 实际, see lib/_workbook-spec.mjs). We write to ASCII-named
// "monitor-auto" tab instead (auto-created, easier to grep/index than
// emoji-prefixed tab names per user feedback 2026-05-23).
//
// CTA events: --cta-event NAME, else pull all ga4_event_name from CTA Map tab.
// Cost: GSC + GA4 free for normal quotas.
// Exit: 0=ok or no-data; 1=fatal; 2=partial (one of GSC/GA4 failed).

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessToken } from './lib/_oauth-token.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');

// ────────── constants ──────────
export const MONITOR_TAB_CANONICAL = '内容追踪';
export const MONITOR_TAB_AUTO = 'monitor-auto';
export const CTA_MAP_TAB = 'CTA Map';
export const MONITOR_HEADER = [
  'report_date',
  'url',
  'clicks',
  'impressions',
  'ctr',
  'position',
  'sessions',
  'avg_dwell_s',
  'engagement_rate',
  'cta_signups',
];

export const GSC_SITE_RE = /^(sc-domain:[^\s/]+|https?:\/\/[^\s]+\/)$/;
export const GA4_PROPERTY_RE = /^properties\/[0-9]+$/;

// ────────── env loader (mirrors gg-sheet-pull.mjs) ──────────
export function loadEnv(envPath) {
  const candidates = envPath
    ? [envPath]
    : [
        process.env.GG_ENV_FILE,
        join(homedir(), '.config', 'gg', '_gg.env'),
        join(REPO, '_gg.env'),
      ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) {
      const text = readFileSync(p, 'utf8');
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
      }
      return p;
    }
  }
  return null;
}

// ────────── CLI parser ──────────
export function parseArgs(argv) {
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

// ────────── date math ──────────
export function parseSince(spec) {
  // "7d" / "30d" → integer days. Default 7.
  if (!spec || spec === true) return 7;
  const m = /^(\d+)\s*d$/i.exec(String(spec).trim());
  if (!m) throw new Error(`invalid --since "${spec}" — expected e.g. 7d, 30d`);
  const n = Number(m[1]);
  if (n < 1 || n > 90) throw new Error(`--since must be 1d..90d, got ${n}d`);
  return n;
}

export function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

export function computeDateRange(days, now = new Date()) {
  // Avoid today's partial day. Window = [today-days .. today-1].
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { startDate: isoDay(start), endDate: isoDay(end) };
}

// ────────── validation ──────────
export function validateSite(site) {
  if (!site || site === true) throw new Error('--site required (e.g. sc-domain:astrologywiki.com)');
  if (!GSC_SITE_RE.test(site)) {
    throw new Error(`--site "${site}" invalid; expected "sc-domain:DOMAIN" or "https://DOMAIN/"`);
  }
  return site;
}

export function validateGa4Property(prop) {
  if (!prop || prop === true) return null;
  if (!GA4_PROPERTY_RE.test(prop)) {
    throw new Error(`--ga4-property "${prop}" invalid; expected "properties/<numeric-id>"`);
  }
  return prop;
}

// ────────── HTTP helpers ──────────
async function gFetch(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const msg = typeof body === 'string'
      ? body.slice(0, 240)
      : (body.error?.message || JSON.stringify(body).slice(0, 240));
    const e = new Error(`${res.status} ${res.statusText}: ${msg}`);
    e.status = res.status;
    e.body = body;
    throw e;
  }
  return body;
}

function scopeMissingError(detail) {
  return new Error(
    `OAuth scope missing — refresh_token does not grant the required GSC/GA4 scope.\n` +
      `Detail: ${detail}\n` +
      `Fix: oauth-init.mjs already requests sheets + webmasters.readonly + analytics.readonly\n` +
      `     on every consent. Re-run it to mint a token with all three:\n` +
      `       node tools/scripts/oauth-init.mjs\n` +
      `     (If you need a hypothetical --add-scopes flag, oauth-init.mjs would need\n` +
      `      extension — the existing static scope list already covers gsc + ga4.)`,
  );
}

// ────────── GSC ──────────
export async function fetchGscRows(token, site, startDate, endDate) {
  // Spec said /v1/ but Google's GSC API uses /webmasters/v3/ (both
  // searchconsole.googleapis.com and www.googleapis.com accept this path).
  const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`;
  const body = await gFetch(url, token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      startDate,
      endDate,
      dimensions: ['page'],
      rowLimit: 1000,
    }),
  });
  return (body.rows || []).map((r) => ({
    url: r.keys?.[0] || '',
    clicks: Number(r.clicks || 0),
    impressions: Number(r.impressions || 0),
    ctr: Number(r.ctr || 0),
    position: Number(r.position || 0),
  }));
}

// ────────── GA4 ──────────
export async function fetchGa4Engagement(token, property, startDate, endDate) {
  const url = `https://analyticsdata.googleapis.com/v1beta/${property}:runReport`;
  const body = await gFetch(url, token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [
        { name: 'sessions' },
        { name: 'averageSessionDuration' },
        { name: 'engagementRate' },
      ],
      limit: 10000,
    }),
  });
  return (body.rows || []).map((r) => ({
    pagePath: r.dimensionValues?.[0]?.value || '',
    sessions: Number(r.metricValues?.[0]?.value || 0),
    avg_dwell_s: Number(r.metricValues?.[1]?.value || 0),
    engagement_rate: Number(r.metricValues?.[2]?.value || 0),
  }));
}

export async function fetchGa4CtaCounts(token, property, startDate, endDate, eventNames) {
  if (!eventNames || !eventNames.length) return [];
  const url = `https://analyticsdata.googleapis.com/v1beta/${property}:runReport`;
  // GA4 string-list filter: matches any eventName in the list.
  const filter = eventNames.length === 1
    ? {
        filter: {
          fieldName: 'eventName',
          stringFilter: { matchType: 'EXACT', value: eventNames[0] },
        },
      }
    : {
        filter: {
          fieldName: 'eventName',
          inListFilter: { values: eventNames },
        },
      };
  const body = await gFetch(url, token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: filter,
      limit: 10000,
    }),
  });
  return (body.rows || []).map((r) => ({
    pagePath: r.dimensionValues?.[0]?.value || '',
    cta_signups: Number(r.metricValues?.[0]?.value || 0),
  }));
}

// ────────── CTA Map → event-name list ──────────
export async function fetchCtaEventNames(token, workbookId) {
  if (!workbookId) return [];
  const range = encodeURIComponent(`${CTA_MAP_TAB}!A1:Z200`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${range}`;
  try {
    const body = await gFetch(url, token);
    const rows = body.values || [];
    if (rows.length < 2) return [];
    const header = rows[0].map((h) => String(h || '').trim());
    const evIdx = header.indexOf('ga4_event_name');
    if (evIdx < 0) return [];
    const set = new Set();
    for (let i = 1; i < rows.length; i++) {
      const v = String(rows[i][evIdx] || '').trim();
      if (v && !/^[（(]/.test(v)) set.add(v);
    }
    return [...set];
  } catch {
    return [];
  }
}

// Join key: pathname only (drops scheme/host so www/non-www unify).
export function urlToPagePath(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.pathname + (u.search || '');
  } catch {
    return url.startsWith('/') ? url : '';
  }
}

// ────────── outer join ──────────
export function joinRows({ reportDate, gscRows, ga4Rows, ctaRows, siteOrigin }) {
  // Key by pagePath. GSC gives full URLs; GA4 gives pagePath. Normalize both.
  const byPath = new Map();

  function ensure(path) {
    if (!byPath.has(path)) {
      byPath.set(path, {
        report_date: reportDate,
        url: '',
        clicks: '',
        impressions: '',
        ctr: '',
        position: '',
        sessions: '',
        avg_dwell_s: '',
        engagement_rate: '',
        cta_signups: '',
      });
    }
    return byPath.get(path);
  }

  for (const r of gscRows) {
    const path = urlToPagePath(r.url) || r.url;
    const row = ensure(path);
    row.url = r.url;
    row.clicks = r.clicks;
    row.impressions = r.impressions;
    row.ctr = Number(r.ctr.toFixed(4));
    row.position = Number(r.position.toFixed(2));
  }
  for (const r of ga4Rows) {
    const path = r.pagePath;
    const row = ensure(path);
    if (!row.url) row.url = siteOrigin ? `${siteOrigin.replace(/\/$/, '')}${path}` : path;
    row.sessions = r.sessions;
    row.avg_dwell_s = Number(r.avg_dwell_s.toFixed(1));
    row.engagement_rate = Number(r.engagement_rate.toFixed(4));
  }
  for (const r of ctaRows) {
    const path = r.pagePath;
    const row = ensure(path);
    if (!row.url) row.url = siteOrigin ? `${siteOrigin.replace(/\/$/, '')}${path}` : path;
    row.cta_signups = r.cta_signups;
  }

  return [...byPath.values()].sort((a, b) => {
    const ac = Number(a.clicks || 0);
    const bc = Number(b.clicks || 0);
    if (bc !== ac) return bc - ac;
    return String(a.url).localeCompare(String(b.url));
  });
}

// ────────── site → origin (for joining GA4-only paths back to URLs) ──────────
export function siteToOrigin(site) {
  if (site.startsWith('sc-domain:')) return `https://${site.slice('sc-domain:'.length)}`;
  if (site.startsWith('https://') || site.startsWith('http://')) return site.replace(/\/$/, '');
  return '';
}

// ────────── markdown table renderer ──────────
export function renderMarkdownTable(rows, header = MONITOR_HEADER) {
  const lines = [];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);
  if (!rows.length) {
    lines.push(`| ${header.map(() => '_(no rows)_').join(' | ')} |`);
  } else {
    for (const r of rows) {
      const cells = header.map((h) => {
        const v = r[h];
        if (v === '' || v == null) return '—';
        return String(v);
      });
      lines.push(`| ${cells.join(' | ')} |`);
    }
  }
  return lines.join('\n');
}

// ────────── sheet write ──────────
async function readHeader(token, workbookId, tab) {
  try {
    const head = await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(tab + '!A1:Z1')}`,
      token,
    );
    return (head.values?.[0] || []).map((h) => String(h || '').trim());
  } catch {
    return [];
  }
}

async function writeHeader(token, workbookId, tab) {
  return gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(tab + '!A1')}?valueInputOption=RAW`,
    token,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: [MONITOR_HEADER] }),
    },
  );
}

async function ensureMonitorTab(token, workbookId) {
  const meta = await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}?includeGridData=false`,
    token,
  );
  const sheets = meta.sheets || [];
  const has = (name) => sheets.some((s) => s.properties?.title === name);
  const headerMatches = (row0) => MONITOR_HEADER.every((h, i) => row0[i] === h);

  // 1. Canonical tab with matching schema → use it.
  if (has(MONITOR_TAB_CANONICAL)) {
    const row0 = await readHeader(token, workbookId, MONITOR_TAB_CANONICAL);
    if (row0.length && headerMatches(row0)) return MONITOR_TAB_CANONICAL;
  }

  // 2. Sibling auto tab. Create + header if absent; restore header if wiped.
  if (!has(MONITOR_TAB_AUTO)) {
    await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}:batchUpdate`,
      token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: MONITOR_TAB_AUTO } } }] }),
      },
    );
    await writeHeader(token, workbookId, MONITOR_TAB_AUTO);
  } else {
    const row0 = await readHeader(token, workbookId, MONITOR_TAB_AUTO);
    if (!headerMatches(row0)) await writeHeader(token, workbookId, MONITOR_TAB_AUTO);
  }
  return MONITOR_TAB_AUTO;
}

async function appendMonitorRows(token, workbookId, tabName, rows) {
  if (!rows.length) return { updates: { updatedRows: 0 } };
  const values = rows.map((r) => MONITOR_HEADER.map((h) => (r[h] === '' || r[h] == null ? '' : r[h])));
  return gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(tabName + '!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values }),
    },
  );
}

// Token-scope problem (vs per-resource ACL denial). 403 on a specific
// site means user lacks access to THAT property — not a missing scope.
function isScopeError(e) {
  const s = String(e?.message || e || '');
  return /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient_scope|Request had insufficient/i.test(s);
}

// ────────── main ──────────
export async function runMonitor(argv, deps = {}) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    process.stdout.write(
      'gg-monitor.mjs — weekly GSC + GA4 → 内容追踪\n' +
      'Usage: node tools/scripts/gg-monitor.mjs --site sc-domain:DOMAIN [--ga4-property properties/ID] [--since 7d] [--dry-run] [--write-sheet] [--cta-event NAME]\n',
    );
    return 0;
  }

  loadEnv();

  // Validate args.
  let site;
  let ga4Property;
  let days;
  try {
    site = validateSite(args.site);
    ga4Property = validateGa4Property(args.ga4_property || process.env.GG_GA4_PROPERTY ||
      (process.env.GG_GA4_PROPERTY_ID ? `properties/${process.env.GG_GA4_PROPERTY_ID}` : null));
    days = parseSince(args.since);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  const writeSheet = !!args.write_sheet;
  const dryRun = !!args.dry_run || !writeSheet;

  const { startDate, endDate } = computeDateRange(days);
  const reportDate = endDate; // window end
  const siteOrigin = siteToOrigin(site);

  process.stderr.write(`gg-monitor: site=${site} ga4=${ga4Property || '(none)'} window=${startDate}..${endDate} mode=${writeSheet ? 'write-sheet' : 'dry-run'}\n`);

  // Mint token.
  const getToken = deps.getAccessToken || getAccessToken;
  let token;
  try {
    // GSC + GA4 live on the user's properties; the SA can't reach them — keep USER OAuth here.
    token = await getToken({ user: true });
  } catch (e) {
    process.stderr.write(`error: cannot mint access_token — ${e.message}\n`);
    return 1;
  }

  // Pull CTA event names + monitor write target (workbook routing).
  // PRD v0.7 SSOT = GG_SHEETS_FLOW_MVP_WORKBOOK_ID (v8 pipeline workbook).
  // Falls back to legacy GG_SHEETS_WORKBOOK_ID for old runs that haven't
  // migrated yet. `--workbook flow-mvp|legacy|<id>` overrides explicitly.
  let workbookId;
  const wbArg = args.workbook;
  if (wbArg && wbArg !== true && wbArg !== 'flow-mvp' && wbArg !== 'legacy') {
    workbookId = String(wbArg);
  } else if (wbArg === 'legacy') {
    workbookId = process.env.GG_SHEETS_WORKBOOK_ID;
  } else {
    workbookId = process.env.GG_SHEETS_FLOW_MVP_WORKBOOK_ID || process.env.GG_SHEETS_WORKBOOK_ID;
  }
  let ctaEvents = [];
  if (args.cta_event && args.cta_event !== true) {
    ctaEvents = [String(args.cta_event)];
  } else if (workbookId) {
    ctaEvents = await fetchCtaEventNames(token, workbookId);
  }
  if (ctaEvents.length) {
    process.stderr.write(`gg-monitor: CTA events tracked: ${ctaEvents.join(', ')}\n`);
  } else {
    process.stderr.write(`gg-monitor: no CTA events configured (cta_signups will be 0)\n`);
  }

  // GSC.
  let gscRows = [];
  let gscErr = null;
  try {
    gscRows = await fetchGscRows(token, site, startDate, endDate);
    process.stderr.write(`gg-monitor: GSC rows=${gscRows.length}\n`);
  } catch (e) {
    gscErr = isScopeError(e) ? scopeMissingError(`GSC: ${e.message}`) : e;
    process.stderr.write(`warn: GSC fetch failed — ${gscErr.message.split('\n')[0]}\n`);
  }

  // GA4.
  let ga4Rows = [];
  let ctaRows = [];
  let ga4Err = null;
  if (!ga4Property) {
    process.stderr.write(`warn: --ga4-property not set (and GG_GA4_PROPERTY_ID env not set); skipping GA4\n`);
    ga4Err = new Error('ga4_property_not_set');
  } else {
    try {
      ga4Rows = await fetchGa4Engagement(token, ga4Property, startDate, endDate);
      process.stderr.write(`gg-monitor: GA4 engagement rows=${ga4Rows.length}\n`);
      if (ctaEvents.length) {
        ctaRows = await fetchGa4CtaCounts(token, ga4Property, startDate, endDate, ctaEvents);
        process.stderr.write(`gg-monitor: GA4 CTA rows=${ctaRows.length}\n`);
      }
    } catch (e) {
      ga4Err = isScopeError(e) ? scopeMissingError(`GA4: ${e.message}`) : e;
      process.stderr.write(`warn: GA4 fetch failed — ${ga4Err.message.split('\n')[0]}\n`);
    }
  }

  // Join.
  const rows = joinRows({ reportDate, gscRows, ga4Rows, ctaRows, siteOrigin });

  // Empty-result handling.
  if (rows.length === 0) {
    process.stdout.write('no data yet — site may be too new (both GSC and GA4 returned 0 rows)\n');
    if (gscErr && ga4Err && !(ga4Err.message === 'ga4_property_not_set')) {
      // Both real errors → still exit 0 per spec but flag partial.
      process.stderr.write(`note: both data sources errored: gsc=${gscErr.message.split('\n')[0]} ga4=${ga4Err.message.split('\n')[0]}\n`);
    }
    return 0;
  }

  // Render markdown.
  const md = renderMarkdownTable(rows);
  const headerNote = [
    `# 📊 Content monitor — ${startDate} .. ${endDate}`,
    `site: ${site}` + (ga4Property ? ` | ga4: ${ga4Property}` : ' | ga4: (skipped)'),
    gscErr ? `**GSC: FAILED** — ${gscErr.message.split('\n')[0]}` : `GSC: ok (${gscRows.length} rows)`,
    ga4Err ? `**GA4: FAILED** — ${ga4Err.message.split('\n')[0]}` : `GA4: ok (${ga4Rows.length} engagement rows, ${ctaRows.length} CTA rows)`,
    '',
  ].join('\n');

  if (dryRun) {
    process.stdout.write(headerNote + md + '\n');
    if (gscErr || ga4Err) {
      const partial = (gscErr && !ga4Err) || (ga4Err && !gscErr && ga4Err.message !== 'ga4_property_not_set');
      return partial ? 2 : 0;
    }
    return 0;
  }

  // Write to sheet.
  if (!workbookId) {
    process.stderr.write(`error: --write-sheet requires GG_SHEETS_FLOW_MVP_WORKBOOK_ID (or GG_SHEETS_WORKBOOK_ID) in env, or --workbook <id> flag\n`);
    return 1;
  }
  let targetTab;
  try {
    targetTab = await ensureMonitorTab(token, workbookId);
    const result = await appendMonitorRows(token, workbookId, targetTab, rows);
    process.stderr.write(`gg-monitor: wrote ${rows.length} rows to "${targetTab}" (updates=${result.updates?.updatedRows ?? 0})\n`);
    process.stdout.write(headerNote);
    process.stdout.write(`wrote ${rows.length} rows → tab "${targetTab}"\n`);
  } catch (e) {
    process.stderr.write(`error: sheet write failed — ${e.message}\n`);
    return 1;
  }

  if (gscErr || ga4Err) {
    const partial = (gscErr && !ga4Err) || (ga4Err && !gscErr && ga4Err.message !== 'ga4_property_not_set');
    return partial ? 2 : 0;
  }
  return 0;
}

// ────────── entrypoint ──────────
if (import.meta.url === `file://${process.argv[1]}`) {
  runMonitor(process.argv.slice(2)).then((c) => process.exit(c || 0)).catch((e) => {
    process.stderr.write(`fatal: ${e.message}\n`); process.exit(1);
  });
}
