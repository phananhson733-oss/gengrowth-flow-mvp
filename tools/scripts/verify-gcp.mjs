#!/usr/bin/env node
// verify-gcp.mjs — GenGrowth MVP Day-0 GCP/SA/GSC/GA4 一键验证
//
// 用法：
//   1) 准备 SA JSON：将 reader SA 的 JSON 放 ~/.config/gg/gg-reader-sa.json
//                  将 writer SA 的 JSON 放 ~/.config/gg/gg-writer-sa.json
//                  （或通过 GG_READER_SA_JSON / GG_WRITER_SA_JSON 环境变量给路径）
//   2) 准备 _gg.env（与脚本同目录或项目根；可被 GG_ENV_FILE 覆盖），含：
//        GG_SHEETS_WORKBOOK_ID=...        # 主 keyword workbook
//        GG_SHEETS_TEST_RANGE=Test!A1     # 用于读写探针的格子（脚本只读+写回原值）
//        GG_GSC_SITE=sc-domain:astrologywiki.com
//        GG_GA4_PROPERTY_ID=12345678
//   3) 运行：node tools/scripts/verify-gcp.mjs
//
// 设计目标（plan v1.1.2 Day-0 #2 / Tech §7.1 3 SA 拆分）：
//   - 不修改任何业务数据；写探针读出原值再原值写回（valueInputOption=RAW）
//   - 4 个独立测试，任一失败给出可执行修复 hint
//   - 退出码：全绿 0；任一红 1
//
// 无外部 npm 依赖：用 Node 内置 crypto 签 JWT，fetch 调 Google REST。

import { readFileSync, existsSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- env loader ----------
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
  readerSaPath: process.env.GG_READER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-reader-sa.json'),
  writerSaPath: process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json'),
};

// ---------- JWT → access token ----------
async function getAccessToken(saPath, scopes) {
  if (!existsSync(saPath)) {
    throw new Error(`SA JSON not found: ${saPath}`);
  }
  const sa = JSON.parse(readFileSync(saPath, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: sa.private_key_id };
  const claim = {
    iss: sa.client_email,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const b64url = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const signingInput = `${b64url(header)}.${b64url(claim)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(sa.private_key).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  return { token: json.access_token, sa };
}

// ---------- check helpers ----------
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

// ---------- 1. Sheets reader ----------
async function checkSheetsReader() {
  const name = '1/4 Sheets reader SA can read workbook';
  if (!CFG.workbookId) return recordFail(name, 'GG_SHEETS_WORKBOOK_ID missing', 'set GG_SHEETS_WORKBOOK_ID in _gg.env');
  try {
    const { token } = await getAccessToken(CFG.readerSaPath, ['https://www.googleapis.com/auth/spreadsheets.readonly']);
    const body = await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${CFG.workbookId}?includeGridData=false`,
      token,
    );
    recordPass(name, `title="${body.properties?.title || '?'}", sheets=${body.sheets?.length ?? 0}`);
  } catch (e) {
    let hint = 'share the workbook with the reader SA email as Viewer';
    if (String(e).includes('404')) hint = 'check GG_SHEETS_WORKBOOK_ID is correct';
    if (String(e).includes('PERMISSION_DENIED')) hint = `share workbook ${CFG.workbookId} with reader SA email (Viewer)`;
    if (String(e).includes('disabled') || String(e).includes('has not been used')) hint = 'enable Sheets API at console.cloud.google.com → APIs & Services';
    recordFail(name, e, hint);
  }
}

// ---------- 2. Sheets writer (round-trip, RAW) ----------
async function checkSheetsWriter() {
  const name = '2/4 Sheets writer SA can write workbook (RAW round-trip)';
  if (!CFG.workbookId) return recordFail(name, 'GG_SHEETS_WORKBOOK_ID missing', 'set GG_SHEETS_WORKBOOK_ID');
  try {
    const { token } = await getAccessToken(CFG.writerSaPath, ['https://www.googleapis.com/auth/spreadsheets']);
    // read original
    const read = await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${CFG.workbookId}/values/${encodeURIComponent(CFG.testRange)}`,
      token,
    );
    const original = read.values || [['']];
    // write back original (no data change)
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
    let hint = `share workbook ${CFG.workbookId} with writer SA email as Editor`;
    if (String(e).includes('Unable to parse range')) hint = `range "${CFG.testRange}" invalid — create a sheet tab "Test" or change GG_SHEETS_TEST_RANGE`;
    if (String(e).includes('PERMISSION_DENIED')) hint = `share workbook with writer SA as Editor`;
    recordFail(name, e, hint);
  }
}

// ---------- 3. GSC searchAnalytics.query (last 7d) ----------
async function checkGSC() {
  const name = '3/4 GSC searchAnalytics query (last 7d)';
  if (!CFG.gscSite) return recordFail(name, 'GG_GSC_SITE missing', 'set GG_GSC_SITE=sc-domain:astrologywiki.com');
  try {
    const { token } = await getAccessToken(CFG.readerSaPath, ['https://www.googleapis.com/auth/webmasters.readonly']);
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
    const rows = body.rows?.length ?? 0;
    recordPass(name, `${startDate}..${end}, rows=${rows}`);
  } catch (e) {
    let hint = 'in GSC → Settings → Users and permissions, add reader SA email as Full user';
    if (String(e).includes('403')) hint = 'reader SA needs Full user (not Owner) on the GSC property';
    if (String(e).includes('404')) hint = `verify GG_GSC_SITE format: "sc-domain:astrologywiki.com" for domain property or "https://astrologywiki.com/" for URL prefix`;
    if (String(e).includes('disabled') || String(e).includes('has not been used')) hint = 'enable Search Console API at console.cloud.google.com';
    recordFail(name, e, hint);
  }
}

// ---------- 4. GA4 Data API runReport (last 7d) ----------
async function checkGA4() {
  const name = '4/4 GA4 Data API runReport (last 7d page_view)';
  if (!CFG.ga4PropertyId) return recordFail(name, 'GG_GA4_PROPERTY_ID missing', 'set GG_GA4_PROPERTY_ID=12345678 (numeric property id)');
  try {
    const { token } = await getAccessToken(CFG.readerSaPath, ['https://www.googleapis.com/auth/analytics.readonly']);
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
    recordPass(name, `events sampled: ${events.slice(0, 5).join(', ')}${events.length > 5 ? ' …' : ''} (n=${events.length})`);
  } catch (e) {
    let hint = `in GA4 → Admin → Property Access Management, add reader SA email as Viewer`;
    if (String(e).includes('403')) hint = 'reader SA needs Viewer on GA4 property';
    if (String(e).includes('404')) hint = 'check GG_GA4_PROPERTY_ID is the numeric property id (not measurement id G-XXXX)';
    if (String(e).includes('disabled') || String(e).includes('has not been used')) hint = 'enable Google Analytics Data API at console.cloud.google.com';
    recordFail(name, e, hint);
  }
}

// ---------- main ----------
(async () => {
  console.log('GenGrowth MVP Day-0 GCP verify');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`env file:   ${envPath || '(none found — relying on shell env)'}`);
  console.log(`reader SA:  ${CFG.readerSaPath}${existsSync(CFG.readerSaPath) ? '' : ' (MISSING)'}`);
  console.log(`writer SA:  ${CFG.writerSaPath}${existsSync(CFG.writerSaPath) ? '' : ' (MISSING)'}`);
  console.log(`workbook:   ${CFG.workbookId || '(unset)'}`);
  console.log(`GSC site:   ${CFG.gscSite || '(unset)'}`);
  console.log(`GA4 prop:   ${CFG.ga4PropertyId || '(unset)'}`);
  console.log('');

  await checkSheetsReader();
  await checkSheetsWriter();
  await checkGSC();
  await checkGA4();

  const failed = RESULTS.filter((r) => !r.ok);
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (failed.length === 0) {
    console.log(`ALL GREEN (${RESULTS.length}/${RESULTS.length}) — Day-0 #2 GCP/GSC/GA4 verified ✅`);
    process.exit(0);
  } else {
    console.log(`${RESULTS.length - failed.length}/${RESULTS.length} passed; ${failed.length} failed — see hints above`);
    process.exit(1);
  }
})().catch((e) => {
  console.error('fatal:', e);
  process.exit(2);
});
