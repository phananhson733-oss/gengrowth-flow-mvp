#!/usr/bin/env node
// _bootstrap-flow-mvp-workbook.mjs — populate an empty Sheet with the v8 flow-mvp tabs.
//
// Pre-req: user creates an empty Sheet at https://sheets.new (owner = user@gmail).
// Pass the ID via --id or set GG_SHEETS_FLOW_MVP_WORKBOOK_ID in env, then run.
//
// Uses user OAuth (refresh token, spreadsheets scope) — no SA quota issue.
// After this, user should manually share the Sheet with the writer SA
// (gg-writer-sa@aqueous-sandbox-496915-i1.iam.gserviceaccount.com) as Editor
// so downstream automation can write back.

import { loadEnv } from './lib/gg-shared.mjs';
import { getAccessToken } from './lib/_oauth-token.mjs';

const ARG_ID = (() => {
  const i = process.argv.indexOf('--id');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const TABS = [
  {
    name: 'README',
    rows: [
      ['gengrowth-flow-mvp · v8 pipeline workbook'],
      [],
      ['Owner: xdawayer@gmail.com. Writer SA (after sharing): gg-writer-sa@aqueous-sandbox-496915-i1.iam.gserviceaccount.com'],
      [`Bootstrapped: ${new Date().toISOString()}`],
      [],
      ['Tab', 'Purpose', 'Read/Write by', 'When'],
      ['keyword_candidates', 'mine 阶段产出的关键词候选（DataForSEO Labs）', 'gg-keyword-mine 写; wzb 标 K 列 wzb_approve=Y', '每次 mine 跑'],
      ['关键词主表', '24 列打分表（A-I 由 promote 写入，J-X 公式）', 'gg-keyword-promote 写 A-I', 'approve 后 promote'],
      ['选题登记表', '21 列 v8 page brief — bridge 阶段的入口', '人工填 B-U；A 由 promote 写', 'promote 后人工补字段'],
      ['主题集群表', 'cluster 元数据（pillar/spoke 拓扑、JTBD、internal_link_rule）', '人工填', '建立新 cluster 时'],
      ['CTA Map', 'page_role → CTA 文案 + target_url 映射', '人工填', '建立新 CTA 时'],
      ['pipeline-status', '每 page 一行，所有阶段产物路径 + 状态（自动）', 'gg-status.mjs 写', '每次 status 跑'],
      ['publish-log', '每次 publish 一行（自动）', 'gg-status.mjs 写', 'publish 后'],
      ['quality-metrics', 'phase2 RL1-6 通过率历史趋势', 'gg-status.mjs 写', '每次 phase2 跑'],
      ['cost-tracking', 'LLM token + DataForSEO API 调用计数', 'gg-status.mjs 写', '每次 LLM call 后'],
      ['config', '阈值 / 版本号 / env 索引（人工 readable）', '人工填', '改阈值时'],
      [],
      ['→ 详细操作手册：docs/PIPELINE.md（仓库内）'],
      ['→ CEO/PM 看板：docs/OPS_OVERVIEW.md（仓库内）'],
    ],
  },
  {
    name: 'keyword_candidates',
    rows: [['run_id', 'entity', 'query', 'source', 'search_volume', 'keyword_difficulty', 'cpc', 'serp_features', 'geo_score', 'ai_recommend', 'wzb_approve']],
  },
  {
    name: '关键词主表',
    rows: [['关键词', '来源', '月搜索量', 'KD', 'CPC', 'Trends比值', 'Top10最低2站DR均值', 'SERP弱度', '自有站DR', 'DR差值', 'SERP机会分', '(预留)', '综合得分', '(预留)', '(预留)', '分桶', '执行优先级', '(预留)', '(预留)', '(预留)', '(预留)', '负责人', '状态', '备注']],
  },
  {
    name: '选题登记表',
    rows: [['Target Keyword', 'Associated Keywords', '月搜索量', 'KD', 'Intent', 'Tier', 'Template', 'Entity', 'Friction', 'Logic', 'CTA', 'GSC Keywords', 'Status', 'URL', 'Last Audit', 'page_id', 'cluster_id', 'page_role', 'content_angle', 'psych_safety_flag', 'journal_prompts']],
  },
  {
    name: '主题集群表',
    rows: [['cluster_id', 'cluster_name', 'track', 'content_layer', 'business_role', 'primary_entity', 'jtbd', 'content_angle', 'us_share', 'pillar_page', 'series_pattern', 'keywords_included', 'page_assets', 'internal_link_rule', 'cta_primary', 'psych_safety_flag', 'priority', 'week', 'success_metric', 'child_entities']],
  },
  {
    name: 'CTA Map',
    rows: [['cta_id', 'page_role', 'cta_文案', 'target_url', 'ga4_event_name', 'track']],
  },
  {
    name: 'pipeline-status',
    rows: [['page_id', 'target_keyword', 'cluster_id', 'tier', 'template', 'candidate_in_sheet', 'approved', 'promoted', 'brief_filled', 'override_path', 'batch_path', 'rag_entity', 'rag_obsidian', 'rag_friction_real', 'prompt_path', 'rendered_llms', 'phase2_status', 'wiki_published_path', 'commit_hash', 'last_updated']],
  },
  {
    name: 'publish-log',
    rows: [['timestamp', 'page_id', 'llm', 'tier', 'template', 'wiki_path_prod', 'wiki_path_obs', 'commit_hash', 'phase2_overall', 'words', 'wikilinks_total', 'wikilinks_tbd', 'operator']],
  },
  {
    name: 'quality-metrics',
    rows: [['timestamp', 'page_id', 'llm', 'tag', 'structure_pass', 'rl1_pass', 'rl2_pass', 'rl3_pass', 'rl4_pass', 'rl5_pass', 'rl6_pass', 'overall', 'words', 'rl4_drifted_sections', 'rl5_keyword_count']],
  },
  {
    name: 'cost-tracking',
    rows: [['timestamp', 'operation', 'tool', 'page_id', 'tokens_in', 'tokens_out', 'tokens_total', 'cost_usd', 'api_calls', 'notes']],
  },
  {
    name: 'config',
    rows: [
      ['key', 'value', 'unit', 'changed_at', 'changed_by', 'rationale'],
      ['mine.max_kd', '50', 'KD', new Date().toISOString().slice(0, 10), 'bootstrap', 'DataForSEO Labs KD upper bound'],
      ['mine.min_volume', '50', 'searches/mo', new Date().toISOString().slice(0, 10), 'bootstrap', 'minimum monthly search volume'],
      ['mine.max_results', '15', 'rows', new Date().toISOString().slice(0, 10), 'bootstrap', 'top-N candidates per mine run'],
      ['mine.location_code', '2840', 'code', new Date().toISOString().slice(0, 10), 'bootstrap', 'DataForSEO location (2840 = United States)'],
      ['mine.language_code', 'en', 'iso', new Date().toISOString().slice(0, 10), 'bootstrap', 'DataForSEO language'],
      ['phase2.RL3_n_gram', '12', 'tokens', new Date().toISOString().slice(0, 10), 'bootstrap', 'SERP plagiarism n-gram overlap threshold'],
      ['phase2.RL4_jaccard_floor', '0.05', 'ratio', new Date().toISOString().slice(0, 10), 'bootstrap', 'per-H2 first-paragraph jaccard floor'],
      ['phase2.RL4_shingle_floor', '0.10', 'ratio', new Date().toISOString().slice(0, 10), 'bootstrap', 'per-H2 first-paragraph 5-gram shingle floor'],
      ['phase2.RL4_drifted_sections_fail', '2', 'count', new Date().toISOString().slice(0, 10), 'bootstrap', 'fail if >=N H2 sections drift'],
      ['phase2.RL5_keyword_max', '12', 'count', new Date().toISOString().slice(0, 10), 'bootstrap', 'max target_keyword repetitions'],
      ['tier1.word_min', '2800', 'words', new Date().toISOString().slice(0, 10), 'bootstrap', 'Pillar Tier 1 minimum word count'],
      ['tier1.word_max', '3500', 'words', new Date().toISOString().slice(0, 10), 'bootstrap', 'Pillar Tier 1 maximum word count'],
      ['tier2.word_min', '1500', 'words', new Date().toISOString().slice(0, 10), 'bootstrap', 'Definition/Tutorial Tier 2 minimum word count'],
      ['tier2.word_max', '1800', 'words', new Date().toISOString().slice(0, 10), 'bootstrap', 'Definition/Tutorial Tier 2 maximum word count'],
      ['prompt.version', 'v8', 'tag', new Date().toISOString().slice(0, 10), 'bootstrap', 'current prompt template version'],
    ],
  },
];

async function gFetchOAuth(url, token, init = {}) {
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function main() {
  loadEnv();
  const sid = ARG_ID || process.env.GG_SHEETS_FLOW_MVP_WORKBOOK_ID;
  if (!sid) {
    console.error('ERR: pass --id <spreadsheetId> or set GG_SHEETS_FLOW_MVP_WORKBOOK_ID');
    process.exit(2);
  }
  const token = await getAccessToken();

  // 1. read existing sheets
  const meta = await gFetchOAuth(`https://sheets.googleapis.com/v4/spreadsheets/${sid}?includeGridData=false`, token);
  const existing = new Map((meta.sheets || []).map((s) => [s.properties.title, s.properties.sheetId]));
  console.log(`Spreadsheet "${meta.properties.title}" — ${existing.size} existing tab(s)`);

  // 2. add missing tabs in 1 batchUpdate
  const addReqs = TABS.filter((t) => !existing.has(t.name)).map((t) => ({ addSheet: { properties: { title: t.name } } }));
  if (addReqs.length) {
    const r = await gFetchOAuth(`https://sheets.googleapis.com/v4/spreadsheets/${sid}:batchUpdate`, token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requests: addReqs }),
    });
    for (const rep of r.replies) {
      const p = rep.addSheet.properties;
      existing.set(p.title, p.sheetId);
      console.log(`  + added tab: ${p.title}`);
    }
  } else {
    console.log('  (all tabs already exist)');
  }

  // 3. write headers + seed rows
  const batchData = TABS.map((t) => ({ range: `${t.name}!A1`, majorDimension: 'ROWS', values: t.rows }));
  await gFetchOAuth(`https://sheets.googleapis.com/v4/spreadsheets/${sid}/values:batchUpdate`, token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'RAW', data: batchData }),
  });
  console.log(`  ✓ headers + seeds written to ${TABS.length} tabs`);

  // 4. bold + freeze header row on each tab
  const formatReqs = [];
  for (const t of TABS) {
    const sheetId = existing.get(t.name);
    formatReqs.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.92, green: 0.92, blue: 0.92 } } },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    });
    formatReqs.push({
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    });
  }
  await gFetchOAuth(`https://sheets.googleapis.com/v4/spreadsheets/${sid}:batchUpdate`, token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requests: formatReqs }),
  });
  console.log(`  ✓ header rows bolded + frozen on ${TABS.length} tabs`);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('NEXT STEPS:');
  console.log(`  1. Open: https://docs.google.com/spreadsheets/d/${sid}/edit`);
  console.log(`  2. Click Share → add: gg-writer-sa@aqueous-sandbox-496915-i1.iam.gserviceaccount.com → Editor`);
  console.log(`     (so downstream tools using writer SA can write back to this sheet)`);
  console.log(`  3. Add this line to ~/.config/gg/_gg.env:`);
  console.log(`        GG_SHEETS_FLOW_MVP_WORKBOOK_ID=${sid}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch((e) => {
  console.error('ERR:', e.message);
  process.exit(1);
});
