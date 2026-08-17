#!/usr/bin/env node
// gg-gengrowth-backfill-ledger.mjs — 上线确认后把 Status / URL 写回选题登记表。
//
// 为什么需要独立一步：gg-gengrowth-publish 的回填事务挂在它的 Supabase 发布路径上，
// 而 gengrowth.ai 的 canonical 内容源已经是仓库里的 Markdown（blog.ts: "local content
// is canonical; Supabase is a removable migration bridge"）。走 Markdown 落地就绕过了
// 那条回填，账本会停在空白 —— 与 2026-07-31 那次「55 行假已发布」同类，方向相反：
// 这次是真上线了但没记。
//
// 2026-08-17：由 oneoff/_gengrowth-0807-backfill-ledger.mjs 提升为常规脚本。日历排到
// 每天 1 篇，一次性脚本每天复制一份不合算，且每复制一次就多一处会漂移的 slug 硬编码。
//
// **先验证再回写**：对每个 slug 发一次 HTTP 请求，只有真 200 才写。拿不到 200 的行
// 原样留空 —— 宁可漏记也不误记已发布。--skip-verify 可跳过（不建议）。
// 默认 dry-run；--write 才真正写。幂等：值已正确就跳过。
//
// USAGE
//   node tools/scripts/gg-gengrowth-backfill-ledger.mjs --page PG-SPD-002 [--write]
//   node tools/scripts/gg-gengrowth-backfill-ledger.mjs --page PG-KOD-001,PG-SPD-001 --write
//   node tools/scripts/gg-gengrowth-backfill-ledger.mjs --all-pending --write
//
// slug 不是参数：它从选题登记表同一行的 URL 列反推，或由 --slug 显式给出。默认
// 从 page_id 找不到 slug 时会报错退出，而不是猜一个。
import { getAccessToken, loadEnv } from './lib/gg-shared.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';
loadEnv();

// 表 ID 走 gengrowth 专属变量，**不是** GG_SHEETS_FLOW_MVP_WORKBOOK_ID —— 那个变量在
// .env 里指向 astrologywiki 主表（1CkjOC…）。第一版从通用变量取，结果这个脚本会安静地
// 去 astrologywiki 的账本里找 gengrowth 的 page_id：这次只因为没有同名 id 才没写错表，
// 换一批 id 就是往另一个站的生产账本写数据，而且不会报错。
const GENGROWTH_WB = '1RRxsyFmdWgtd6tojjze_8lxwSUTTZKm4TqU4gZTIRA8';
const ASTROLOGYWIKI_WB = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';
const WB = process.env.GG_GENGROWTH_WORKBOOK_ID || GENGROWTH_WB;
if (WB === ASTROLOGYWIKI_WB) {
  console.error(`拒绝执行：解析出的表是 astrologywiki 主表，这个脚本只写 gengrowth 账本。\n检查 GG_GENGROWTH_WORKBOOK_ID。`);
  process.exit(2);
}
const TAB = '选题登记表';
const HOST = 'https://gengrowth.ai';
const SA = join(homedir(), '.config', 'gg', 'gg-writer-sa.json');

function parseArgs(argv) {
  const a = { pages: [], slugs: {}, write: false, skipVerify: false, allPending: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--write') a.write = true;
    else if (k === '--skip-verify') a.skipVerify = true;
    else if (k === '--all-pending') a.allPending = true;
    else if (k === '--page') a.pages = argv[++i].split(/[\s,]+/).filter(Boolean);
    // --slug PG-SPD-002=google-algorithm-update-august-2026
    else if (k === '--slug') { const [p, s] = argv[++i].split('='); a.slugs[p] = s; }
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
if (!args.pages.length && !args.allPending) {
  console.error('用法: --page PG-XXX-NNN[,PG-YYY-NNN] | --all-pending  [--write] [--slug PG-X=slug]');
  process.exit(2);
}

async function greq(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status}: ${b.error?.message || res.statusText}`);
  return b;
}
function colLetter(i) {
  let s = '', n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}
async function liveStatus(slug) {
  if (args.skipVerify) return { ok: true, status: 'skipped' };
  const url = `${HOST}/blog/${slug}`;
  try {
    const r = await fetch(url);
    return { ok: r.status === 200, status: r.status, url };
  } catch (e) {
    return { ok: false, status: 'ERR', url, note: e.message };
  }
}

const { token } = await getAccessToken(SA, ['https://www.googleapis.com/auth/spreadsheets']);
const rows = (await greq(
  `https://sheets.googleapis.com/v4/spreadsheets/${WB}/values/${encodeURIComponent(`${TAB}!A1:AZ2000`)}?majorDimension=ROWS`,
  token,
)).values || [];
const hdr = rows[0] || [];
const col = {};
hdr.forEach((h, i) => { col[String(h).trim()] = i; });
for (const need of ['page_id', 'Status', 'URL', 'Target Keyword']) {
  if (col[need] === undefined) { console.error(`表头缺 "${need}" 列，abort`); process.exit(1); }
}

// --all-pending: 表里所有 Status 不是「已发布」的行，交给 HTTP 校验去筛。
let targets = args.pages;
if (args.allPending) {
  targets = rows
    .filter((r, i) => i > 0 && String(r[col['page_id']] || '').trim() && String(r[col['Status']] || '').trim() !== '已发布')
    .map((r) => String(r[col['page_id']]).trim());
  console.log(`--all-pending: ${targets.length} 个未标记已发布的 page_id\n`);
}

const updates = [];
for (const pid of targets) {
  const idx = rows.findIndex((r, i) => i > 0 && String(r[col['page_id']] || '').trim() === pid);
  if (idx < 0) { console.log(`⚠️  ${pid}: 表里找不到该 page_id，跳过`); continue; }
  const rowNum = idx + 1;
  const curUrl = String(rows[idx][col['URL']] ?? '').trim();
  // slug 来源优先级：--slug 显式 > URL 列已有值反推。都没有则报错，绝不从关键词猜。
  const slug = args.slugs[pid] || (curUrl.match(/\/blog\/([a-z0-9-]+)/)?.[1] ?? null);
  if (!slug) {
    console.log(`⚠️  ${pid} (行 ${rowNum}): 无 slug —— URL 列为空且未给 --slug ${pid}=<slug>，跳过（不猜）`);
    continue;
  }
  const live = await liveStatus(slug);
  if (!live.ok) {
    console.log(`⏸  ${pid} (行 ${rowNum}): ${HOST}/blog/${slug} → ${live.status} —— 未确认上线，不回写`);
    continue;
  }
  const wantUrl = `${HOST}/blog/${slug}`;
  const curStatus = String(rows[idx][col['Status']] ?? '').trim();
  console.log(`✅ ${pid} (行 ${rowNum}): 线上 200 — ${slug}`);
  if (curStatus === '已发布') console.log('     Status 已是「已发布」，跳过');
  else { updates.push({ range: `${TAB}!${colLetter(col['Status'])}${rowNum}`, values: [['已发布']] }); console.log(`     Status: "${curStatus}" → 已发布`); }
  if (curUrl === wantUrl) console.log('     URL 已正确，跳过');
  else { updates.push({ range: `${TAB}!${colLetter(col['URL'])}${rowNum}`, values: [[wantUrl]] }); console.log(`     URL: "${curUrl}" → ${wantUrl}`); }
}

console.log(`\n──────────────────────\n待更新 ${updates.length} 个单元格`);
if (!updates.length) process.exit(0);
if (!args.write) { console.log('[DRY-RUN] 加 --write 才真正写入。'); process.exit(0); }
const res = await greq(`https://sheets.googleapis.com/v4/spreadsheets/${WB}/values:batchUpdate`, token, {
  method: 'POST', body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updates }),
});
console.log(`✅ 选题登记表 updated: ${res.totalUpdatedCells} 个单元格`);
