#!/usr/bin/env node
// _gengrowth-0807-backfill-ledger.mjs — 上线确认后回写选题登记表的 Status / URL。
//
// 为什么要单写一个：gg-gengrowth-publish 的回填事务挂在它的 Supabase 发布路径上，而
// gengrowth.ai 的 canonical 内容源已经是仓库里的 Markdown（见 blog.ts:
// "local content is canonical; Supabase is a removable migration bridge"）。走 Markdown
// 落地就绕过了那条回填，账本会停在空白 —— 跟 2026-07-31 那次「55 行假已发布」是同一类
// 账本漂移，只是方向相反（这次是真上线了但没记）。
//
// **先验证再回写**：默认对每个 slug 发一次 HTTP 请求，只有真的 200 才写。
// 拿不到 200 的行原样留空，宁可漏记也不误记已发布。--skip-verify 可跳过（不建议）。
// 默认 dry-run；--write 才真正写。幂等：已有值就跳过。
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';
loadEnv();

const WB = '1RRxsyFmdWgtd6tojjze_8lxwSUTTZKm4TqU4gZTIRA8';
const TAB = '选题登记表';
const WRITE = process.argv.includes('--write');
const SKIP_VERIFY = process.argv.includes('--skip-verify');
const SA = join(homedir(), '.config', 'gg', 'gg-writer-sa.json');

// page_id -> slug。URL 用 canonical 无前缀形式：/en/blog/<slug> 会 308 跳到 /blog/<slug>，
// 账本记 308 的那个形态等于每次点击都白烧一跳。
const ROWS = {
  'PG-KOD-001': 'how-to-find-low-hanging-fruit-keywords',
  'PG-SPD-001': 'striking-distance-keywords',
  'PG-KOD-002': 'zero-search-volume-keywords',
  'PG-ILA-001': 'pagerank-sculpting',
};
const HOST = 'https://gengrowth.ai';

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
  if (SKIP_VERIFY) return { ok: true, note: 'verify skipped' };
  const url = `${HOST}/blog/${slug}`;
  try {
    const r = await fetch(url);
    return { ok: r.status === 200, status: r.status, url };
  } catch (e) {
    return { ok: false, status: 'ERR', url, note: e.message };
  }
}

const { token } = await getAccessToken(SA, ['https://www.googleapis.com/auth/spreadsheets']);
const rows = (await greq(`https://sheets.googleapis.com/v4/spreadsheets/${WB}/values/${encodeURIComponent(`${TAB}!A1:AZ2000`)}?majorDimension=ROWS`, token)).values || [];
const header = rows[0] || [];
const colOf = {};
header.forEach((h, i) => { colOf[String(h).trim()] = i; });
for (const need of ['page_id', 'Status', 'URL']) {
  if (colOf[need] === undefined) { console.error(`表头缺 "${need}" 列，abort`); process.exit(1); }
}

const updates = [];
for (const [pid, slug] of Object.entries(ROWS)) {
  const idx = rows.findIndex((r, i) => i > 0 && String(r[colOf['page_id']] || '').trim() === pid);
  if (idx < 0) { console.log(`⚠️ ${pid}: 表里找不到该 page_id，跳过`); continue; }
  const rowNum = idx + 1;
  const live = await liveStatus(slug);
  if (!live.ok) {
    console.log(`⏸  ${pid} (行 ${rowNum}): ${live.url} → ${live.status} —— 未确认上线，不回写`);
    continue;
  }
  const curStatus = String(rows[idx][colOf['Status']] ?? '').trim();
  const curUrl = String(rows[idx][colOf['URL']] ?? '').trim();
  const wantUrl = `${HOST}/blog/${slug}`;
  console.log(`✅ ${pid} (行 ${rowNum}): 线上 200`);
  if (curStatus === '已发布') console.log(`     Status 已是「已发布」，跳过`);
  else { updates.push({ range: `${TAB}!${colLetter(colOf['Status'])}${rowNum}`, values: [['已发布']] }); console.log(`     Status: "${curStatus}" → 已发布`); }
  if (curUrl === wantUrl) console.log(`     URL 已正确，跳过`);
  else { updates.push({ range: `${TAB}!${colLetter(colOf['URL'])}${rowNum}`, values: [[wantUrl]] }); console.log(`     URL: "${curUrl}" → ${wantUrl}`); }
}

console.log(`\n──────────────────────\n待更新 ${updates.length} 个单元格`);
if (!updates.length) process.exit(0);
if (!WRITE) { console.log('[DRY-RUN] 加 --write 才真正写入。'); process.exit(0); }
const res = await greq(`https://sheets.googleapis.com/v4/spreadsheets/${WB}/values:batchUpdate`, token, {
  method: 'POST', body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updates }),
});
console.log(`✅ 选题登记表 updated: ${res.totalUpdatedCells} 个单元格`);
