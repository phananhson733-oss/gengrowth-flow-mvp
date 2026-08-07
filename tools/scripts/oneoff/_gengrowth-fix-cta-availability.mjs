#!/usr/bin/env node
// _gengrowth-fix-cta-availability.mjs — 修正 CTA Map 里工具页的可用性表述。
//
// 2026-08-07 事实审抓到：`cta_tool_keyword_map` 指向 /tools/hidden-keywords，而该页面
// 逐字写着 "This tool is not available yet. The Keyword Opportunity Map has not shipped
// as a public tool."（waitlist + 邮箱收集）。原 CTA 文案 "Open the Free Keyword
// Opportunity Map" 承诺了一个点进去就穿帮的产品，属"错误的产品事实"——正是 W25 追溯
// 扫描的失败类型之一。HTTP 200 ≠ 工具可用，这是当初只验状态码留下的洞。
//
// 逐页核实（2026-08-07，WebFetch 读正文）：
//   /tools/hidden-keywords        → 未上线，只有 waitlist  ❌
//   /tools/seo-quick-wins         → 可用，免费，需连 GSC（只读）✅
//   /tools/traffic-drop-diagnosis → 可用，免费，需连 GSC（只读）✅
//   /tools/internal-link-audit    → 可用，免费，无需登录，输入任意公开 URL ✅
//   /tools/seo-audit              → 可用，免费，无需登录/GSC ✅
//
// 本脚本只改 cta_文案 / desc 两列，不动 cta_id / target_url（文章正文里的锚文本由
// 写作层从 cta_text 取，所以改文案即可让 CTA 说实话）。
// 默认 dry-run；--write 才写。幂等：值已是目标值则跳过。
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';
loadEnv();

const WB = '1RRxsyFmdWgtd6tojjze_8lxwSUTTZKm4TqU4gZTIRA8';
const TAB = 'CTA Map';
const WRITE = process.argv.includes('--write');
const SCOPE = ['https://www.googleapis.com/auth/spreadsheets'];
const SA = join(homedir(), '.config', 'gg', 'gg-writer-sa.json');

// cta_id -> { cta_文案, desc }
const FIXES = {
  cta_tool_keyword_map: {
    'cta_文案': 'Join the Keyword Opportunity Map Waitlist',
    desc: 'NOT YET SHIPPED (verified 2026-08-07): the page states "This tool is not available yet" and only collects a work email for launch notification. Copy must never promise a runnable report. Point readers who need something today at /tools/seo-audit or /tools/internal-link-audit.',
  },
  cta_tool_quick_wins: {
    'cta_文案': 'Connect Search Console and See Your Quick Wins',
    desc: 'Live and free (verified 2026-08-07). Requires a read-only Google Search Console connection; analyses 28 days, returns queries whose CTR sits below the site baseline, exportable as CSV. Copy must mention the GSC connection.',
  },
  cta_tool_traffic_drop: {
    'cta_文案': 'Connect Search Console and Diagnose the Drop',
    desc: 'Live and free (verified 2026-08-07). Requires a read-only Google Search Console connection. Copy must mention the GSC connection.',
  },
  cta_tool_link_audit: {
    'cta_文案': 'Run a Free Internal Link Audit',
    desc: 'Live and free (verified 2026-08-07). No login, no GSC — takes any public URL, crawls same-origin HTML (~950 pages / 4 min cap) and reports orphan pages, weakly-linked pages, unresolved targets and click depth.',
  },
};

async function greq(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status}: ${b.error?.message || res.statusText}`);
  return b;
}
function colLetter(idx) {
  let s = '', n = idx;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

const { token } = await getAccessToken(SA, SCOPE);
const range = encodeURIComponent(`${TAB}!A1:AZ2000`);
const rows = (await greq(`https://sheets.googleapis.com/v4/spreadsheets/${WB}/values/${range}?majorDimension=ROWS`, token)).values || [];
const header = rows[0] || [];
const colOf = {};
header.forEach((h, i) => { colOf[String(h).trim()] = i; });
const idCol = colOf['cta_id'];
if (idCol === undefined) { console.error('CTA Map 无 cta_id 列，abort'); process.exit(1); }

const updates = [];
for (let i = 1; i < rows.length; i++) {
  const id = String(rows[i][idCol] || '').trim();
  const fix = FIXES[id];
  if (!fix) continue;
  console.log(`\n${id} (行 ${i + 1}):`);
  for (const [field, value] of Object.entries(fix)) {
    const c = colOf[field];
    if (c === undefined) { console.log(`  ⚠️ 表头无 "${field}" 列`); continue; }
    const cur = String(rows[i][c] ?? '').trim();
    if (cur === value) { console.log(`  ${field}: 已是目标值，跳过`); continue; }
    console.log(`  ${field}:`);
    console.log(`    旧: ${cur.slice(0, 90)}`);
    console.log(`    新: ${value.slice(0, 90)}`);
    updates.push({ range: `${TAB}!${colLetter(c)}${i + 1}`, values: [[value]] });
  }
}

console.log(`\n──────────────────────────────────────\n待更新 ${updates.length} 个单元格`);
if (!updates.length) process.exit(0);
if (!WRITE) { console.log('[DRY-RUN] 加 --write 才真正写入。'); process.exit(0); }

const res = await greq(
  `https://sheets.googleapis.com/v4/spreadsheets/${WB}/values:batchUpdate`,
  token,
  { method: 'POST', body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updates }) },
);
console.log(`✅ CTA Map updated: ${res.totalUpdatedCells} 个单元格`);
