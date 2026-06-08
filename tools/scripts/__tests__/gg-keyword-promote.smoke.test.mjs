#!/usr/bin/env node
// Smoke test for gg-keyword-promote.mjs — pure helpers (no network).
// Run: node --test tools/scripts/__tests__/gg-keyword-promote.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  CANDIDATES_TAB,
  MASTER_TAB,
  PAGES_TAB,
  SOURCE_REMAP,
  REQUIRED_CANDIDATE_HEADERS,
  remapSource,
  isApproved,
  buildMasterRow,
  buildPageDraftRow,
  rowToCandidate,
  filterApprovedNotYetPromoted,
  validateCandidateHeader,
  parseArgs,
  colIndexToLetter,
  clusterColFromHeader,
  MASTER_CLUSTER_ID_COL,
} from '../gg-keyword-promote.mjs';

// ---------- constants ----------
test('tab names match Sheet schema', () => {
  assert.equal(CANDIDATES_TAB, 'keyword_candidates');
  assert.equal(MASTER_TAB, '关键词主表');
  assert.equal(PAGES_TAB, '选题登记表');
});

test('SOURCE_REMAP covers the 6 legal source-column dropdown values', () => {
  // 6 legal values from keyword-sheet-setup.gs v3.1 line 187
  const legal = ['竞品映射', '内容缺口', '种子词拓展', '社区挖掘', '趋势词', 'Social信号'];
  const mapped = Object.values(SOURCE_REMAP);
  for (const v of legal) {
    assert.ok(mapped.includes(v), `${v} not in SOURCE_REMAP`);
  }
});

// ---------- remapSource ----------
test('remapSource maps known sources', () => {
  assert.equal(remapSource('reddit'), '社区挖掘');
  assert.equal(remapSource('serp'), '内容缺口');
  assert.equal(remapSource('competitor'), '竞品映射');
  assert.equal(remapSource('seed'), '种子词拓展');
  assert.equal(remapSource('trend'), '趋势词');
  assert.equal(remapSource('social'), 'Social信号');
});

test('remapSource is case-insensitive', () => {
  assert.equal(remapSource('Reddit'), '社区挖掘');
  assert.equal(remapSource('SERP'), '内容缺口');
  assert.equal(remapSource(' reddit '), '社区挖掘');
});

test('remapSource passes through already-correct Chinese label', () => {
  // Pre-mapped values pass through unchanged (no double-mapping).
  assert.equal(remapSource('社区挖掘'), '社区挖掘');
  assert.equal(remapSource('内容缺口'), '内容缺口');
});

test('remapSource falls back to default on empty', () => {
  assert.equal(remapSource(''), '社区挖掘');
  assert.equal(remapSource(null), '社区挖掘');
  assert.equal(remapSource(undefined), '社区挖掘');
});

// ---------- isApproved (strict) ----------
test('isApproved requires exactly "Y"', () => {
  assert.equal(isApproved('Y'), true);
  assert.equal(isApproved(' Y '), true);
});

test('isApproved rejects lowercase / variants / Chinese', () => {
  assert.equal(isApproved('y'), false, 'lowercase y must not count');
  assert.equal(isApproved('yes'), false);
  assert.equal(isApproved('YES'), false);
  assert.equal(isApproved('是'), false);
  assert.equal(isApproved('N'), false);
  assert.equal(isApproved(''), false);
  assert.equal(isApproved(null), false);
  assert.equal(isApproved(undefined), false);
});

// ---------- buildMasterRow ----------
test('buildMasterRow produces exactly 9 columns (A-I)', () => {
  const c = {
    query: 'orange aura meaning',
    source: 'reddit',
    search_volume: '5400',
    keyword_difficulty: '12',
    cpc: '1.8',
  };
  const row = buildMasterRow(c);
  assert.equal(row.length, 9, 'must be exactly 9 cols (A-I); formula cols start at J');
});

test('buildMasterRow does NOT include formula columns', () => {
  const c = {
    query: 'x',
    source: 'reddit',
    search_volume: '100',
    keyword_difficulty: '5',
    cpc: '1.0',
  };
  const row = buildMasterRow(c);
  // 9 cells; A=keyword, B=source, C=volume, D=KD, E=CPC, F=Trends(blank),
  // G=Top10 DR(blank), H=SERP弱度(blank), I=own DR(blank). J=DR差值(formula) MUST NOT appear.
  assert.equal(row[0], 'x');
  assert.equal(row[1], '社区挖掘');
  assert.equal(row[2], '100');
  assert.equal(row[3], '5');
  assert.equal(row[4], '1.0');
  assert.equal(row[5], '', 'F (Trends) must be empty for promote — manual fill');
  assert.equal(row[6], '', 'G (Top10 DR) must be empty');
  assert.equal(row[7], '', 'H (SERP weakness) must be empty');
  assert.equal(row[8], '', 'I (own site DR) must be empty');
  assert.equal(row[9], undefined, 'no 10th cell — J onward are formula cols');
});

test('buildMasterRow tolerates missing numeric fields', () => {
  const c = { query: 'x', source: 'reddit' };
  const row = buildMasterRow(c);
  assert.equal(row[2], ''); // C empty
  assert.equal(row[3], ''); // D empty
  assert.equal(row[4], ''); // E empty
});

// ---------- buildPageDraftRow ----------
test('buildPageDraftRow emits exactly 1 column (target_keyword)', () => {
  const c = { query: 'orange aura' };
  const row = buildPageDraftRow(c);
  assert.deepEqual(row, ['orange aura']);
});

// ---------- rowToCandidate ----------
const SAMPLE_HEADER = [
  'run_id', 'entity', 'query', 'source', 'search_volume',
  'keyword_difficulty', 'cpc', 'serp_features', 'geo_score', 'ai_recommend', 'wzb_approve',
];

test('rowToCandidate maps all 11 columns by header name', () => {
  const row = ['r1', 'aura', 'blue aura', 'reddit', '12100', '8', '1.2', 'PAA', '7', 'high', 'Y'];
  const c = rowToCandidate(SAMPLE_HEADER, row);
  assert.equal(c.query, 'blue aura');
  assert.equal(c.entity, 'aura');
  assert.equal(c.source, 'reddit');
  assert.equal(c.search_volume, '12100');
  assert.equal(c.wzb_approve, 'Y');
});

test('rowToCandidate fills missing trailing cells with empty string', () => {
  const row = ['r1', 'aura', 'blue aura', 'reddit'];
  const c = rowToCandidate(SAMPLE_HEADER, row);
  assert.equal(c.query, 'blue aura');
  assert.equal(c.wzb_approve, '');
  assert.equal(c.geo_score, '');
});

// ---------- filterApprovedNotYetPromoted ----------
test('filterApprovedNotYetPromoted keeps only Y-approved candidates', () => {
  const cands = [
    { query: 'a', wzb_approve: 'Y' },
    { query: 'b', wzb_approve: 'y' }, // lowercase → reject
    { query: 'c', wzb_approve: 'N' },
    { query: 'd', wzb_approve: '' },
    { query: 'e', wzb_approve: 'Y' },
  ];
  const out = filterApprovedNotYetPromoted(cands, new Set());
  assert.deepEqual(out.map((c) => c.query), ['a', 'e']);
});

test('filterApprovedNotYetPromoted dedupes against existing master rows (case-insensitive)', () => {
  const cands = [
    { query: 'Blue Aura', wzb_approve: 'Y' },
    { query: 'Orange Aura', wzb_approve: 'Y' },
    { query: 'green aura', wzb_approve: 'Y' },
  ];
  const inMaster = new Set(['blue aura', 'green aura']);
  const out = filterApprovedNotYetPromoted(cands, inMaster);
  assert.deepEqual(out.map((c) => c.query), ['Orange Aura']);
});

test('filterApprovedNotYetPromoted drops blank queries', () => {
  const out = filterApprovedNotYetPromoted(
    [{ query: '', wzb_approve: 'Y' }, { query: 'x', wzb_approve: 'Y' }],
    new Set(),
  );
  assert.deepEqual(out.map((c) => c.query), ['x']);
});

// ---------- parseArgs ----------
test('parseArgs --dry-run + --also-draft-pages', () => {
  const args = parseArgs(['--dry-run', '--also-draft-pages']);
  assert.equal(args.dry_run, true);
  assert.equal(args.also_draft_pages, true);
});

test('parseArgs --entity captures value', () => {
  const args = parseArgs(['--entity', 'blue aura']);
  assert.equal(args.entity, 'blue aura');
});

// ---------- validateCandidateHeader (schema drift detector) ----------
test('REQUIRED_CANDIDATE_HEADERS includes query + wzb_approve', () => {
  assert.ok(REQUIRED_CANDIDATE_HEADERS.includes('query'));
  assert.ok(REQUIRED_CANDIDATE_HEADERS.includes('wzb_approve'));
});

test('validateCandidateHeader: well-formed header → empty missing list', () => {
  const header = ['run_id', 'entity', 'query', 'source', 'search_volume',
    'keyword_difficulty', 'cpc', 'serp_features', 'geo_score', 'ai_recommend', 'wzb_approve'];
  assert.deepEqual(validateCandidateHeader(header), []);
});

test('validateCandidateHeader: missing wzb_approve → flagged (covers schema drift bug)', () => {
  // codex review: if someone renames wzb_approve, current behavior is "no approved found, exit 0"
  // which looks identical to "no candidates yet". Must fail loud.
  const header = ['run_id', 'entity', 'query', 'source', 'search_volume',
    'keyword_difficulty', 'cpc', 'serp_features', 'geo_score', 'ai_recommend']; // dropped wzb_approve
  const missing = validateCandidateHeader(header);
  assert.deepEqual(missing, ['wzb_approve']);
});

test('validateCandidateHeader: empty header → all required missing', () => {
  const missing = validateCandidateHeader([]);
  assert.deepEqual(missing.sort(), [...REQUIRED_CANDIDATE_HEADERS].sort());
});

test('validateCandidateHeader: missing query → flagged', () => {
  const header = ['run_id', 'entity', 'kw', 'source', 'wzb_approve']; // typo: kw instead of query
  assert.deepEqual(validateCandidateHeader(header), ['query']);
});

// ---------- cluster_id 列解析（v3.3 防误写进生产状态列）----------
test('colIndexToLetter: 0→A, 24→Y, 25→Z, 26→AA, 27→AB, 28→AC；非法→null', () => {
  assert.equal(colIndexToLetter(0), 'A');
  assert.equal(colIndexToLetter(24), 'Y');
  assert.equal(colIndexToLetter(25), 'Z');
  assert.equal(colIndexToLetter(26), 'AA');
  assert.equal(colIndexToLetter(27), 'AB');
  assert.equal(colIndexToLetter(28), 'AC'); // flow-mvp v3.3 cluster_id 列
  assert.equal(colIndexToLetter(-1), null);
  assert.equal(colIndexToLetter(1.5), null);
});

test('clusterColFromHeader: v3.1 主表 cluster_id 在 Y 列（与 MASTER_CLUSTER_ID_COL 默认一致）', () => {
  const v31 = ['关键词', '来源', '月搜索量', 'KD', 'CPC($)', 'Trends比值', 'Top10最低2站DR均值', 'SERP弱度', '自有站DR', 'DR差值', 'G1话题相关', 'G2可承接', '意图', 'DR过滤', '分桶_自动', '手动分桶', '调整原因', '分桶', 'AIO预判', 'AIO风险', '弱度意图分', '内容状态', '发布URL', '备注', 'cluster_id'];
  assert.equal(clusterColFromHeader(v31), 'Y'); // 第 25 列 idx 24
  assert.equal(clusterColFromHeader(v31), MASTER_CLUSTER_ID_COL);
});

test('clusterColFromHeader: 纯 canonical v3.3 主表无 cluster_id → null（Y 列＝生产状态，绝不可写）', () => {
  const v33 = ['关键词', '来源', '月搜索量', 'KD', 'CPC($)', 'Trends比值', 'Top10最低2站DR均值', 'SERP弱度', '自有站DR', 'DR差值', 'G1话题相关', 'G2可承接', '意图', '竞争建议', '分桶_自动', '手动分桶', '调整原因', '分桶', 'AIO预判', 'AIO风险', '弱度意图分', '生产准入_自动', '手动生产准入', '生产准入', '生产状态', 'page_id', '发布URL', '备注'];
  assert.equal(clusterColFromHeader(v33), null);
  assert.equal(v33[24], '生产状态'); // 证明若硬写 Y 会污染生产状态列
});

test('clusterColFromHeader: flow-mvp v3.3 主表 cluster_id 在 AC（第29列）→ AC（前提：表头读到 A1:AC1）', () => {
  const v33mvp = ['关键词', '来源', '月搜索量', 'KD', 'CPC($)', 'Trends比值', 'Top10最低2站DR均值', 'SERP弱度', '自有站DR', 'DR差值', 'G1话题相关', 'G2可承接', '意图', '竞争建议', '分桶_自动', '手动分桶', '调整原因', '分桶', 'AIO预判', 'AIO风险', '弱度意图分', '生产准入_自动', '手动生产准入', '生产准入', '生产状态', 'page_id', '发布URL', '备注', 'cluster_id'];
  assert.equal(clusterColFromHeader(v33mvp), 'AC'); // 第 29 列 idx 28
  assert.equal(v33mvp[28], 'cluster_id'); // 表头若只读到 AB(28列) 则解析不到 → 跳过回填（即旧 bug）
});

test('clusterColFromHeader: 非数组/空 → null', () => {
  assert.equal(clusterColFromHeader(null), null);
  assert.equal(clusterColFromHeader(undefined), null);
  assert.equal(clusterColFromHeader([]), null);
});
