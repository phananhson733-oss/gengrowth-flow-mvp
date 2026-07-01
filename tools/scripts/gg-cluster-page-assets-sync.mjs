#!/usr/bin/env node
// gg-cluster-page-assets-sync.mjs — keep 主题集群表.page_assets in step with what
// has actually shipped, so a cluster whose article was just published doesn't sit
// with an empty / stale page_assets cell (the "cluster" gap wzb flagged 2026-07-01).
//
// What it does (canonical workbook 1CkjOC…):
//   1. Read 选题登记表; for every 已发布 row with a cluster_id + URL, extract the slug
//      and group published slugs by cluster_id.
//   2. Read 主题集群表; for each cluster row, find published slugs NOT already mentioned
//      in its page_assets text.
//   3. APPEND-ONLY: append the missing slugs as `；<date> +slug1, slug2` — never rewrites
//      or deletes the existing human-curated prose (counts, merge notes). Idempotent:
//      a slug already present anywhere in the cell is skipped.
//
// Safe to run on a schedule. --dry (default) prints the plan; --apply writes.
//
//   node tools/scripts/gg-cluster-page-assets-sync.mjs            # dry-run
//   node tools/scripts/gg-cluster-page-assets-sync.mjs --apply
//   node tools/scripts/gg-cluster-page-assets-sync.mjs --apply --date 2026-07-01
import { getAccessToken } from './lib/_oauth-token.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const dateArg = (() => { const i = args.indexOf('--date'); return i >= 0 ? args[i + 1] : ''; })();
const WB = (process.env.GG_SHEETS_FLOW_MVP_WORKBOOK_ID || process.env.GG_SHEETS_WORKBOOK_ID || '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc').trim();
const TOPIC_TAB = '选题登记表';
const CLUSTER_TAB = '主题集群表';
const PUBLISHED = '已发布';

const colA1 = (n) => { let s = '', x = n + 1; while (x > 0) { s = String.fromCharCode(65 + ((x - 1) % 26)) + s; x = Math.floor((x - 1) / 26); } return s; };
const slugFromUrl = (u) => { const m = String(u || '').match(/\/(?:en|zh)\/(?:wiki|blog)\/([a-z0-9-]+)/); return m ? m[1] : ''; };

async function readTab(token, tab) {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${WB}/values/${encodeURIComponent(`${tab}!A1:BZ3000`)}`, { headers: { authorization: `Bearer ${token}` } });
  return (await r.json()).values || [];
}

async function main() {
  const token = await getAccessToken();
  const today = dateArg || new Date().toISOString().slice(0, 10);

  // 1) 选题登记表 → cluster_id -> Set(published slugs)
  const topic = await readTab(token, TOPIC_TAB);
  const th = topic[0] || [];
  const tStatus = th.findIndex((h) => /^Status$/i.test(String(h).trim()));
  const tCluster = th.findIndex((h) => /cluster_id/i.test(String(h).trim()));
  const tUrl = th.findIndex((h) => /^(URL|发布URL)$/i.test(String(h).trim()));
  if (tStatus < 0 || tCluster < 0 || tUrl < 0) { console.error('选题登记表 header missing Status/cluster_id/URL'); process.exit(1); }
  const byCluster = new Map();
  for (let r = 1; r < topic.length; r++) {
    const row = topic[r];
    if (String(row[tStatus] || '').trim() !== PUBLISHED) continue;
    const cid = String(row[tCluster] || '').trim();
    const slug = slugFromUrl(row[tUrl]);
    if (!cid || !slug) continue;
    if (!byCluster.has(cid)) byCluster.set(cid, new Set());
    byCluster.get(cid).add(slug);
  }

  // 2) 主题集群表 → find missing slugs per cluster row
  const cluster = await readTab(token, CLUSTER_TAB);
  const ch = cluster[0] || [];
  const cId = ch.findIndex((h) => /cluster_id/i.test(String(h).trim()));
  const cPA = ch.findIndex((h) => /page_assets/i.test(String(h).trim()));
  if (cId < 0 || cPA < 0) { console.error('主题集群表 header missing cluster_id/page_assets'); process.exit(1); }

  const data = [];
  let clustersTouched = 0, slugsAdded = 0;
  for (let r = 1; r < cluster.length; r++) {
    const row = cluster[r];
    const cid = String(row[cId] || '').trim();
    if (!cid || !byCluster.has(cid)) continue;
    const cur = String(row[cPA] || '').trim();
    const missing = [...byCluster.get(cid)].filter((slug) => !cur.includes(slug));
    if (!missing.length) continue;
    const next = (cur ? `${cur}；` : '') + `${today} +${missing.join(', ')}`;
    console.log(`  ${cid}: +${missing.length} → ${missing.join(', ')}`);
    data.push({ range: `${CLUSTER_TAB}!${colA1(cPA)}${r + 1}`, values: [[next]] });
    clustersTouched++; slugsAdded += missing.length;
  }

  console.log(`\ncluster-page-assets: clusters=${clustersTouched} slugs_added=${slugsAdded} mode=${APPLY ? 'apply' : 'dry-run'}`);
  if (APPLY && data.length) {
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${WB}/values:batchUpdate`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
    });
    const j = await res.json();
    console.log(`  wrote updatedCells=${j.totalUpdatedCells ?? JSON.stringify(j).slice(0, 120)}`);
  } else if (!APPLY && data.length) {
    console.log('  (dry-run — pass --apply to write)');
  }
}

main().catch((e) => { console.error(`cluster-page-assets error: ${String(e.message || e)}`); process.exit(1); });
