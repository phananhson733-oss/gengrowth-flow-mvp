#!/usr/bin/env node
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';
loadEnv();
const WB = '1RRxsyFmdWgtd6tojjze_8lxwSUTTZKm4TqU4gZTIRA8';
const SA = join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
const { token } = await getAccessToken(SA, ['https://www.googleapis.com/auth/spreadsheets.readonly']);
const H = { authorization: `Bearer ${token}` };
const meta = await (await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${WB}?fields=sheets.properties.title`, { headers: H })).json();
const tabs = meta.sheets.map(s => s.properties.title);
console.log('=== tabs ===\n ', tabs.join('\n  '));
const ctaTab = tabs.find(t => /cta/i.test(t));
if (!ctaTab) { console.log('\n无 CTA tab'); process.exit(0); }
const r = await (await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${WB}/values/${encodeURIComponent(`${ctaTab}!A1:Z200`)}`, { headers: H })).json();
const rows = r.values || [];
console.log(`\n=== ${ctaTab} 表头 ===\n `, (rows[0]||[]).join(' | '));
console.log('\n=== 含 traffic / drop / diagnos 的行 ===');
rows.forEach((x,i)=>{ if(i>0 && /traffic|drop|diagnos/i.test(x.join(' '))) console.log(` 行${i+1}:`, x.slice(0,6).join(' | ').slice(0,220)); });
