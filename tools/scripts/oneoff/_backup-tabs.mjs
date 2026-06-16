#!/usr/bin/env node
/**
 * _backup-tabs.mjs — 写表前快照备份。结果复盘表 + 选题登记表(含错位 AF-AM 列)。
 * 同时存 values 和 FORMULA 两版,供回滚(含公式/静态值区分)。
 * 输出 .gg-cache/backup-<tab>-<ISO>.{values,formula}.json
 */
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
loadEnv();
const __dirname = dirname(fileURLToPath(import.meta.url));
const FLOW = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';
const { token } = await getAccessToken(join(homedir(), '.config', 'gg', 'gg-writer-sa.json'), ['https://www.googleapis.com/auth/spreadsheets.readonly']);

async function get(range, render) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${FLOW}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=${render}`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const b = await r.json();
  if (!r.ok) throw new Error(`READ FAIL ${range}: ${r.status} ${b.error?.message || ''}`);
  return b.values || [];
}

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(__dirname, '..', '..', '..', '.gg-cache', 'backups');
mkdirSync(outDir, { recursive: true });

const TARGETS = [
  { tab: '结果复盘表', range: '结果复盘表!A1:P200' },
  { tab: '选题登记表', range: '选题登记表!A1:AM1576' },
];

for (const t of TARGETS) {
  for (const render of ['UNFORMATTED_VALUE', 'FORMULA']) {
    const data = await get(t.range, render);
    if (!data.length) throw new Error(`备份为空,中止: ${t.tab} ${render}`);
    const f = join(outDir, `backup-${t.tab}-${ts}.${render === 'FORMULA' ? 'formula' : 'values'}.json`);
    writeFileSync(f, JSON.stringify({ tab: t.tab, range: t.range, render, ts, rows: data.length, data }, null, 0));
    console.log(`✓ ${t.tab} ${render}: ${data.length} 行 → ${f.replace(join(__dirname, '..', '..', '..'), '.')}`);
  }
}
console.log(`\n备份时间戳: ${ts}`);
