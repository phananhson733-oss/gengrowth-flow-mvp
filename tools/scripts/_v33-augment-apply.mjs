#!/usr/bin/env node
/**
 * _v33-augment-apply.mjs — B3(W=集群必需) + B5a(生产候选正则锚定)【additive/单格公式，绝不删数据】
 *
 * B3：给指定行的 W(手动生产准入) 写「集群必需」——仅当该行 W 当前为空（不覆盖人工值）。
 *     目的：让缺 DR 数据(N=待填→默认暂缓)的 P1 骨架词进生产候选。
 * B5a：把「生产候选!A1」公式里的 REGEXMATCH "可生产|集群必需"(未锚定) 改成 "^(可生产|集群必需)$"。
 *      仅当当前公式确含未锚定串才改（幂等：已锚定则跳过）。
 *
 * 用法：
 *   node tools/scripts/_v33-augment-apply.mjs                # dry-run（默认原表，只读）
 *   node tools/scripts/_v33-augment-apply.mjs --apply
 *   node tools/scripts/_v33-augment-apply.mjs --workbook <id> [--apply] [--skip-b3] [--skip-b5a]
 */
import { getAccessToken, gFetch, loadEnv } from './lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ORIG = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';
const args = process.argv.slice(2);
const wbIdx = args.indexOf('--workbook');
const WB = wbIdx >= 0 ? args[wbIdx + 1] : ORIG;
const APPLY = args.includes('--apply');
const SKIP_B3 = args.includes('--skip-b3');
const SKIP_B5A = args.includes('--skip-b5a');
const MASTER = '关键词主表', VIEW = '生产候选';
const B3_ROWS = [72, 122, 167, 224, 338, 400, 404, 445, 464, 477, 553]; // 11 行 vedic calculator [P1] 缺DR

loadEnv();
const SA = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
const scope = APPLY ? 'https://www.googleapis.com/auth/spreadsheets' : 'https://www.googleapis.com/auth/spreadsheets.readonly';
const { token } = await getAccessToken(SA, [scope]);
const base = `https://sheets.googleapis.com/v4/spreadsheets/${WB}`;
const get = async (r, opt = '') => (await gFetch(`${base}/values/${encodeURIComponent(r)}${opt}`, token)).values || [];

console.log(`MODE: ${APPLY ? 'APPLY ⚠️' : 'DRY-RUN'}  WORKBOOK: ${WB}`);

// ---- B3 ----
const b3writes = [];
if (!SKIP_B3) {
  // 读这些行的 W(手动生产准入=col W=idx22) + A(keyword) + N(竞争建议) 现状
  const wColLetter = 'W'; // 手动生产准入
  for (const row of B3_ROWS) {
    const v = (await get(`${MASTER}!A${row}:AC${row}`))[0] || [];
    const kw = (v[0] || '').toString().trim();
    const curW = (v[22] || '').toString().trim();
    const curN = (v[13] || '').toString().trim();
    if (curW) { console.log(`  B3 跳过 行${row} ${kw}：W 已有值「${curW}」(不覆盖)`); continue; }
    b3writes.push({ range: `${MASTER}!${wColLetter}${row}`, values: [['集群必需']], _kw: kw, _n: curN });
  }
  console.log(`B3：拟写 W=集群必需 ${b3writes.length}/${B3_ROWS.length} 行(其余 W 非空已跳过)`);
  for (const w of b3writes) console.log(`  ${w.range} ← 集群必需 (${w._kw}, N=${w._n})`);
}

// ---- B5a ----
let b5write = null;
if (!SKIP_B5A) {
  const cur = ((await get(`${VIEW}!A1`, '?valueRenderOption=FORMULA'))[0] || [])[0] || '';
  if (cur.includes('"^(可生产|集群必需)$"')) {
    console.log('B5a：已锚定，跳过。');
  } else if (cur.includes('"可生产|集群必需"')) {
    const next = cur.replace('"可生产|集群必需"', '"^(可生产|集群必需)$"');
    b5write = { range: `${VIEW}!A1`, values: [[next]] };
    console.log('B5a：生产候选!A1 正则将锚定：');
    console.log('  旧:', cur);
    console.log('  新:', next);
  } else {
    console.log('B5a：未找到预期未锚定串，跳过(公式可能已改)。当前:', cur);
  }
}

if (!APPLY) { console.log('\nDRY-RUN 完成（未写入）。'); process.exit(0); }

// 写 B3（RAW 文本）
if (b3writes.length) {
  await gFetch(`${base}/values:batchUpdate`, token, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'RAW', data: b3writes.map(({ range, values }) => ({ range, values })) }),
  });
  console.log(`✅ B3 写入 ${b3writes.length} 行 W=集群必需。`);
}
// 写 B5a（USER_ENTERED 当公式）
if (b5write) {
  await gFetch(`${base}/values/${encodeURIComponent(b5write.range)}?valueInputOption=USER_ENTERED`, token, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ range: b5write.range, values: b5write.values }),
  });
  console.log('✅ B5a 生产候选!A1 已锚定。');
}
console.log('APPLY 完成。');
