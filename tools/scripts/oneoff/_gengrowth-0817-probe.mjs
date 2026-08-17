#!/usr/bin/env node
// 只读探测：选题登记表的表头 + PG-SPD-001 现有填法 + 末行位置。
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';
loadEnv();
const WB = '1RRxsyFmdWgtd6tojjze_8lxwSUTTZKm4TqU4gZTIRA8';
const TAB = '选题登记表';
const SA = join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
const { token } = await getAccessToken(SA, ['https://www.googleapis.com/auth/spreadsheets.readonly']);
const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${WB}/values/${encodeURIComponent(`${TAB}!A1:AZ2000`)}?majorDimension=ROWS`, { headers: { authorization: `Bearer ${token}` } });
const rows = (await r.json()).values || [];
const hdr = rows[0];
const colL = (i) => { let s='',n=i; do { s=String.fromCharCode(65+(n%26))+s; n=Math.floor(n/26)-1; } while(n>=0); return s; };
console.log('总行数:', rows.length);
console.log('\n=== 表头 ===');
hdr.forEach((h,i)=>console.log(`  ${colL(i).padEnd(3)} ${h}`));
const pidCol = hdr.indexOf('page_id');
const idx = rows.findIndex((x,i)=>i>0 && String(x[pidCol]||'').trim()==='PG-SPD-001');
console.log(`\n=== PG-SPD-001 (行 ${idx+1}) 现有填法 ===`);
hdr.forEach((h,i)=>{ const v=String(rows[idx][i]??'').trim(); if(v) console.log(`  ${colL(i).padEnd(3)} ${String(h).padEnd(20)} ${v.slice(0,110)}`); });
console.log(`\n=== 是否已有 PG-SPD-002 ===`, rows.some((x,i)=>i>0 && String(x[pidCol]||'').trim()==='PG-SPD-002') ? '已存在' : '不存在');
console.log('=== 末尾 3 行的 page_id ===');
rows.slice(-3).forEach((x,i)=>console.log(`  行 ${rows.length-3+i+1}: ${x[pidCol]||'(空)'} | ${x[hdr.indexOf('Target Keyword')]||''}`));
