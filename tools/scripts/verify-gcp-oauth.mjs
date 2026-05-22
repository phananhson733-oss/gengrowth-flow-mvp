#!/usr/bin/env node
// verify-gcp-oauth.mjs — Day-0 #2 GCP/GSC/GA4 验证（wzb personal Gmail OAuth 版）
//
// 前置：跑过 `node tools/scripts/oauth-init.mjs`，~/.config/gg/_gg.env 含
//   GG_OAUTH_CLIENT_ID / GG_OAUTH_CLIENT_SECRET / GG_OAUTH_REFRESH_TOKEN
//   GG_SHEETS_WORKBOOK_ID / GG_SHEETS_TEST_RANGE (默认 Test!A1)
//   GG_GSC_SITE (sc-domain:astrologywiki.com)
//   GG_GA4_PROPERTY_ID (numeric)
//
// 用法：node tools/scripts/verify-gcp-oauth.mjs
//
// 设计：复用 verify-gcp.mjs 的 4 check 结构 + hint，但用 OAuth user token 而不是 SA JWT。
// 写探针 RAW round-trip 不改数据。

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessToken } from './lib/_oauth-token.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- env loader (same shape as verify-gcp.mjs) ----------
function loadEnv() {
  const candidates = [
    process.env.GG_ENV_FILE,
    join(homedir(), '.config', 'gg', '_gg.env'),
    join(process.cwd(), '_gg.env'),
    join(__dirname, '_gg.env'),
    join(__dirname, '..', '..', '_gg.env'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) {
      const text = readFileSync(p, 'utf8');
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
      return p;
    }
  }
  return null;
}

const envPath = loadEnv();

const CFG = {
  workbookId: process.env.GG_SHEETS_WORKBOOK_ID,
  testRange: process.env.GG_SHEETS_TEST_RANGE || 'Test!A1',
  gscSite: process.env.GG_GSC_SITE,
  ga4PropertyId: process.env.GG_GA4_PROPERTY_ID,
};

const RESULTS = [];
function recordPass(name, detail) {
  RESULTS.push({ ok: true, name, detail });
  console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`);
}
function recordFail(name, err, hint) {
  RESULTS.push({ ok: false, name, err: String(err), hint });
  console.log(`❌ ${name}`);
  console.log(`   error: ${err && err.message ? err.message : err}`);
  if (hint) console.log(`   hint:  ${hint}`);
}

async function gFetch(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const e = new Error(`${res.status} ${res.statusText}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    e.status = res.status;
    e.body = body;
    throw e;
  }
  return body;
}

// ---------- 1. Sheets read (workbook metadata) ----------
async function checkSheetsRead(token) {
  const name = '1/4 Sheets read (workbook metadata)';
  if (!CFG.workbookId) return recordFail(name, 'GG_SHEETS_WORKBOOK_ID missing', 'set GG_SHEETS_WORKBOOK_ID in _gg.env');
  try {
    const body = await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${CFG.workbookId}?includeGridData=false`,
      token,
    );
    recordPass(name, `title="${body.properties?.title || '?'}", sheets=${body.sheets?.length ?? 0}`);
  } catch (e) {
    let hint = `confirm xdawayer@gmail.com owns or has access to workbook ${CFG.workbookId}`;
    if (String(e).includes('404')) hint = 'check GG_SHEETS_WORKBOOK_ID is correct';
    if (String(e).includes('PERMISSION_DENIED')) hint = 'open this sheet in browser while logged in as xdawayer@gmail.com';
    if (String(e).includes('has not been used') || String(e).includes('disabled')) hint = 'enable Sheets API in GCP Console';
    if (String(e).includes('insufficient')) hint = 'scope spreadsheets missing — re-run oauth-init.mjs';
    recordFail(name, e, hint);
  }
}

// ---------- 2. Sheets write (RAW round-trip) ----------
async function checkSheetsWrite(token) {
  const name = '2/4 Sheets write (RAW round-trip, no data change)';
  if (!CFG.workbookId) return recordFail(name, 'GG_SHEETS_WORKBOOK_ID missing', 'set GG_SHEETS_WORKBOOK_ID');
  try {
    const read = await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${CFG.workbookId}/values/${encodeURIComponent(CFG.testRange)}`,
      token,
    );
    const original = read.values || [['']];
    const written = await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${CFG.workbookId}/values/${encodeURIComponent(CFG.testRange)}?valueInputOption=RAW`,
      token,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ range: CFG.testRange, values: original }),
      },
    );
    recordPass(name, `range=${CFG.testRange}, updatedCells=${written.updatedCells ?? 0}`);
  } catch (e) {
    let hint = `confirm range "${CFG.testRange}" exists in workbook`;
    if (String(e).includes('Unable to parse range')) hint = `create tab "Test" or change GG_SHEETS_TEST_RANGE`;
    if (String(e).includes('insufficient')) hint = 'scope spreadsheets missing — re-run oauth-init.mjs';
    recordFail(name, e, hint);
  }
}

// ---------- 3. GSC searchAnalytics ----------
async function checkGSC(token) {
  const name = '3/4 GSC searchAnalytics query (last 7d)';
  if (!CFG.gscSite) return recordFail(name, 'GG_GSC_SITE missing', 'set GG_GSC_SITE=sc-domain:astrologywiki.com');
  try {
    const today = new Date();
    const end = today.toISOString().slice(0, 10);
    const startDate = new Date(today.getTime() - 7 * 86400 * 1000).toISOString().slice(0, 10);
    const body = await gFetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(CFG.gscSite)}/searchAnalytics/query`,
      token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ startDate, endDate: end, dimensions: ['date'], rowLimit: 7 }),
      },
    );
    recordPass(name, `${startDate}..${end}, rows=${body.rows?.length ?? 0}`);
  } catch (e) {
    let hint = `confirm xdawayer@gmail.com has access (Full or Restricted) to GSC property ${CFG.gscSite}`;
    if (String(e).includes('404')) hint = `verify GG_GSC_SITE format: "sc-domain:astrologywiki.com" or "https://astrologywiki.com/"`;
    if (String(e).includes('disabled') || String(e).includes('has not been used')) hint = 'enable Search Console API in GCP Console';
    if (String(e).includes('insufficient')) hint = 'scope webmasters.readonly missing — re-run oauth-init.mjs';
    recordFail(name, e, hint);
  }
}

// ---------- 4. GA4 runReport ----------
async function checkGA4(token) {
  const name = '4/4 GA4 Data API runReport (last 7d eventName)';
  if (!CFG.ga4PropertyId) return recordFail(name, 'GG_GA4_PROPERTY_ID missing', 'set GG_GA4_PROPERTY_ID=numeric id (not G-XXXX)');
  try {
    const body = await gFetch(
      `https://analyticsdata.googleapis.com/v1beta/properties/${CFG.ga4PropertyId}:runReport`,
      token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
          dimensions: [{ name: 'eventName' }],
          metrics: [{ name: 'eventCount' }],
          limit: 10,
        }),
      },
    );
    const events = (body.rows || []).map((r) => r.dimensionValues?.[0]?.value).filter(Boolean);
    recordPass(name, `events: ${events.slice(0, 5).join(', ')}${events.length > 5 ? ' …' : ''} (n=${events.length})`);
  } catch (e) {
    let hint = `confirm xdawayer@gmail.com is Viewer on GA4 property ${CFG.ga4PropertyId}`;
    if (String(e).includes('404')) hint = 'GG_GA4_PROPERTY_ID must be the numeric property id (Admin → Property Settings)';
    if (String(e).includes('disabled') || String(e).includes('has not been used')) hint = 'enable Analytics Data API in GCP Console';
    if (String(e).includes('insufficient')) hint = 'scope analytics.readonly missing — re-run oauth-init.mjs';
    recordFail(name, e, hint);
  }
}

// ---------- main ----------
(async () => {
  console.log('GenGrowth MVP — Day-0 GCP/GSC/GA4 verify (OAuth user token)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`env file:   ${envPath || '(none found)'}`);
  console.log(`workbook:   ${CFG.workbookId || '(unset)'}`);
  console.log(`test range: ${CFG.testRange}`);
  console.log(`GSC site:   ${CFG.gscSite || '(unset)'}`);
  console.log(`GA4 prop:   ${CFG.ga4PropertyId || '(unset)'}`);
  console.log('');

  let token;
  try {
    token = await getAccessToken();
    console.log(`🔑 access_token minted (${token.length} chars)`);
    console.log('');
  } catch (e) {
    console.error('❌ cannot mint access_token:', e.message);
    process.exit(2);
  }

  await checkSheetsRead(token);
  await checkSheetsWrite(token);
  await checkGSC(token);
  await checkGA4(token);

  const failed = RESULTS.filter((r) => !r.ok);
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (failed.length === 0) {
    console.log(`ALL GREEN (${RESULTS.length}/${RESULTS.length}) — Day-0 #2 OAuth verified ✅`);
    process.exit(0);
  } else {
    console.log(`${RESULTS.length - failed.length}/${RESULTS.length} passed; ${failed.length} failed — see hints above`);
    process.exit(1);
  }
})().catch((e) => {
  console.error('fatal:', e);
  process.exit(2);
});
