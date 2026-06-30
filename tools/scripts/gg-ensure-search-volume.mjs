#!/usr/bin/env node
// gg-ensure-search-volume.mjs — fill an empty 月搜索量 (search_volume, col C) cell with "0"
// for the 选题登记表 row whose target_keyword matches the given keyword. The render step
// (gg-render-batch) HARD-SKIPS a row with an empty search_volume ("missing cfg fields:
// search_volume"), which parks authoring at "render produced no v8 prompt". Brand-new
// trend/event briefs (added by hand) routinely leave that cell blank, so the nightly
// driver calls this first to keep the author lane from fail-closing on a cosmetic gap.
//
//   node gg-ensure-search-volume.mjs --keyword "Jordan vs Argentina"
//   node gg-ensure-search-volume.mjs --keyword "..." --value 0   (default 0)
//
// Exit 0 always (best-effort, never blocks the pipeline); prints what it did.
import { getAccessToken } from './lib/_oauth-token.mjs';

function arg(name, def = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const keyword = arg('--keyword').trim();
const value = arg('--value', '0').trim() || '0';
const TAB = '选题登记表';
const SV_HEADER = '月搜索量';

if (!keyword) { console.error('ensure-search-volume: --keyword required'); process.exit(0); }

const wb = (process.env.GG_SHEETS_FLOW_MVP_WORKBOOK_ID || process.env.GG_SHEETS_WORKBOOK_ID || '').trim();
if (!wb) { console.error('ensure-search-volume: no workbook id'); process.exit(0); }

const colLetter = (n) => { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; };

try {
  const token = await getAccessToken();
  const auth = { authorization: `Bearer ${token}` };
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${wb}/values`;
  const tab = encodeURIComponent(TAB);

  // header → find Target Keyword (A) + 月搜索量 column
  const hdr = (await (await fetch(`${base}/${tab}!A1:Z1`, { headers: auth })).json()).values?.[0] || [];
  const svIdx = hdr.findIndex((h) => String(h).trim() === SV_HEADER);
  if (svIdx < 0) { console.error('ensure-search-volume: 月搜索量 column not found'); process.exit(0); }
  const svCol = colLetter(svIdx);

  // pull Target Keyword (col A), find the matching row
  const kwCol = (await (await fetch(`${base}/${tab}!A2:A2000`, { headers: auth })).json()).values || [];
  const want = keyword.toLowerCase();
  let rowNum = -1;
  for (let i = 0; i < kwCol.length; i++) {
    if (String(kwCol[i]?.[0] || '').trim().toLowerCase() === want) { rowNum = i + 2; break; }
  }
  if (rowNum < 0) { console.log(`ensure-search-volume: no row for "${keyword}" (skip)`); process.exit(0); }

  const cur = (await (await fetch(`${base}/${tab}!${svCol}${rowNum}`, { headers: auth })).json()).values?.[0]?.[0];
  if (cur != null && String(cur).trim() !== '') { console.log(`ensure-search-volume: row ${rowNum} already has search_volume="${cur}" (no-op)`); process.exit(0); }

  const range = `${TAB}!${svCol}${rowNum}`;
  const res = await fetch(`${base}/${encodeURIComponent(range)}?valueInputOption=RAW`, {
    method: 'PUT', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ range, values: [[value]] }),
  });
  const j = await res.json();
  console.log(`ensure-search-volume: set ${range} = "${value}" (updatedCells=${j.updatedCells ?? '?'})`);
} catch (e) {
  console.error(`ensure-search-volume: error (non-blocking): ${String(e.message || e).slice(0, 120)}`);
}
process.exit(0);
