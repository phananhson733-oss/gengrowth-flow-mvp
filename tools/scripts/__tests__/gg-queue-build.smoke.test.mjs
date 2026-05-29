// gg-queue-build 纯逻辑冒烟测试。不碰网络，只测选择/排序/截断/去重。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBucket,
  isProducible,
  buildKeywordClusterIndex,
  parseMasterRows,
  collectExistingKeywords,
  selectQueue,
  colLetter,
  parseStartRow,
  indexMasterHeader,
  buildClusterMatcher,
  isToolIntent,
  TOOL_INTENT_PATTERNS,
} from '../gg-queue-build.mjs';

test('normalizeBucket 去掉 ★/emoji/❌，归一桶名', () => {
  assert.equal(normalizeBucket('快速胜利★'), '快速胜利');
  assert.equal(normalizeBucket('⚡快速胜利'), '快速胜利');
  assert.equal(normalizeBucket('❌跳过'), '跳过');
  assert.equal(normalizeBucket('战略词'), '战略词');
  assert.equal(normalizeBucket(''), '');
  assert.equal(normalizeBucket('暂无快速胜利词'), '快速胜利'); // 子串命中也认（视图占位行不会进 master）
});

test('isProducible：跳过/空永不入队，长尾词需显式开关', () => {
  assert.equal(isProducible('快速胜利'), true);
  assert.equal(isProducible('战略词'), true);
  assert.equal(isProducible('趋势词'), true);
  assert.equal(isProducible('跳过'), false);
  assert.equal(isProducible(''), false);
  assert.equal(isProducible('长尾词'), false);
  assert.equal(isProducible('长尾词', { includeLongTail: true }), true);
});

test('buildKeywordClusterIndex：从 keywords_included 建 kw→cluster（小写、首个胜出）', () => {
  const clusterMap = new Map([
    ['clu_aura', { cluster_id: 'clu_aura', keywords_included: 'Blue Aura Meaning, white aura meaning', priority: 'P0', week: 'Week 1' }],
    ['clu_house', { cluster_id: 'clu_house', keywords_included: '8th house astrology' }],
  ]);
  const idx = buildKeywordClusterIndex(clusterMap);
  assert.equal(idx.get('blue aura meaning'), 'clu_aura');
  assert.equal(idx.get('white aura meaning'), 'clu_aura');
  assert.equal(idx.get('8th house astrology'), 'clu_house');
  assert.equal(idx.get('unknown'), undefined);
});

test('indexMasterHeader / parseMasterRows：按名取列，跳过空行与 section header', () => {
  const header = ['关键词', '来源', '月搜索量', 'KD', 'CPC($)', 'Trends比值', 'Top10最低2站DR均值', 'SERP弱度', '自有站DR', 'DR差值', 'G1话题相关', 'G2可承接', '意图', 'DR过滤', '分桶_自动', '手动分桶', '调整原因', '分桶', 'AIO预判', 'AIO风险', '弱度意图分', '内容状态', '发布URL', '备注'];
  const idx = indexMasterHeader(header);
  assert.equal(idx.keyword, 0);
  assert.equal(idx.volume, 2);
  assert.equal(idx.bucket, 17); // R 列 = 分桶
  const rows = [
    header,
    ['## 集群分组', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ['blue aura meaning', '竞品映射', '8000', '0', '', '', '', '', '', '', '', '', '', '', '', '', '', '快速胜利', '', '', '3', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''], // 空 A
  ];
  const parsed = parseMasterRows(rows);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].keyword, 'blue aura meaning');
  assert.equal(parsed[0].volume, 8000);
  assert.equal(parsed[0].bucket, '快速胜利');
  assert.equal(parsed[0].u_score, 3);
});

test('collectExistingKeywords：去重源，跳过 header/section/空', () => {
  const rows = [
    ['Target Keyword', 'Associated Keywords'],
    ['## 集群 1A：Aura', 'note'],
    ['Blue Aura Meaning', ''],
    ['', ''],
  ];
  const set = collectExistingKeywords(rows);
  assert.equal(set.has('blue aura meaning'), true);
  assert.equal(set.size, 1);
});

test('buildClusterMatcher：子串匹配种子词，priority 优先、最长种子胜', () => {
  const clusterMap = new Map([
    ['houses', { cluster_id: 'houses', keywords_included: '8th house, 12th house, house meanings', primary_entity: 'Astrology Houses', priority: 'P0' }],
    ['vedic', { cluster_id: 'vedic', keywords_included: 'vedic astrology, vedic birth chart', primary_entity: 'Vedic Astrology', priority: 'P1' }],
    ['short', { cluster_id: 'short', keywords_included: 'ic', primary_entity: 'ai', priority: 'P0' }], // 短种子应被忽略
  ]);
  const match = buildClusterMatcher(clusterMap);
  assert.equal(match('8th house astrology'), 'houses', '主表实际词串含集群种子 → 归该集群');
  assert.equal(match('vedic birth chart calculator'), 'vedic');
  assert.equal(match('vedic astrology reading'), 'vedic');
  assert.equal(match('astrocartography'), null, '无种子命中 → 未归集群');
  assert.equal(match('ai astrology'), null, '短种子(ai/ic <4字)不参与，避免误伤');
});

function fixtureMaster() {
  return [
    { keyword: 'k_p0_qw', volume: 500, kd: '5', bucket: '快速胜利', u_score: 3 },
    { keyword: 'k_p0_trend', volume: 100, kd: '10', bucket: '趋势词', u_score: 2 },
    { keyword: 'k_p1_strat', volume: 9000, kd: '30', bucket: '战略词', u_score: 1 },
    { keyword: 'k_p0_skip', volume: 9999, kd: '0', bucket: '跳过', u_score: 0 },
    { keyword: 'k_p0_long', volume: 50, kd: '0', bucket: '长尾词', u_score: 3 },
    { keyword: 'k_orphan', volume: 800, kd: '0', bucket: '快速胜利', u_score: 3 },
    { keyword: 'k_p2_qw', volume: 700, kd: '0', bucket: '快速胜利', u_score: 3 },
  ];
}
function fixtureClusters() {
  return new Map([
    ['c0', { cluster_id: 'c0', keywords_included: 'k_p0_qw, k_p0_trend, k_p0_skip, k_p0_long', priority: 'P0', week: 'Week 1' }],
    ['c1', { cluster_id: 'c1', keywords_included: 'k_p1_strat', priority: 'P1', week: 'Week 1' }],
    ['c2', { cluster_id: 'c2', keywords_included: 'k_p2_qw', priority: 'P2', week: 'Week 1' }],
  ]);
}

test('selectQueue：桶不可生产/未归集群被排除', () => {
  const master = fixtureMaster();
  const clusterMap = fixtureClusters();
  const kwToCluster = buildKeywordClusterIndex(clusterMap);
  const { selected, unclustered } = selectQueue({ master, clusterMap, kwToCluster, priorities: ['P0', 'P1', 'P2'] });
  const keys = selected.map((s) => s.keyword);
  assert.ok(!keys.includes('k_p0_skip'), '跳过桶不入队');
  assert.ok(!keys.includes('k_p0_long'), '长尾默认不入队');
  // k_orphan: 快速胜利但不在任何集群 keywords_included → unclustered
  assert.ok(unclustered.some((m) => m.keyword === 'k_orphan'));
  assert.ok(!keys.includes('k_orphan'));
});

test('selectQueue：priority 过滤 + 排序（P0 先，桶序，再 volume）', () => {
  const master = fixtureMaster();
  const clusterMap = fixtureClusters();
  const kwToCluster = buildKeywordClusterIndex(clusterMap);
  // 仅 P0
  const onlyP0 = selectQueue({ master, clusterMap, kwToCluster, priorities: ['P0'] });
  assert.deepEqual(onlyP0.selected.map((s) => s.keyword), ['k_p0_trend', 'k_p0_qw']); // 趋势词先于快速胜利
  // P0+P1：P0 的两个先，P1 战略词后
  const p0p1 = selectQueue({ master, clusterMap, kwToCluster, priorities: ['P0', 'P1'] });
  assert.deepEqual(p0p1.selected.map((s) => s.keyword), ['k_p0_trend', 'k_p0_qw', 'k_p1_strat']);
});

test('selectQueue：capacity 截断 + capped 计数', () => {
  const master = fixtureMaster();
  const clusterMap = fixtureClusters();
  const kwToCluster = buildKeywordClusterIndex(clusterMap);
  const { selected, capped } = selectQueue({ master, clusterMap, kwToCluster, priorities: ['P0', 'P1', 'P2'], capacity: 2 });
  assert.equal(selected.length, 2);
  assert.equal(capped, 2); // 共 4 个候选(qw/trend/strat/p2_qw)，取 2 余 2
});

test('selectQueue：week 过滤 + 去重已存在', () => {
  const master = fixtureMaster();
  const clusterMap = fixtureClusters();
  const kwToCluster = buildKeywordClusterIndex(clusterMap);
  const wrongWeek = selectQueue({ master, clusterMap, kwToCluster, priorities: ['P0'], week: 'Week 2' });
  assert.equal(wrongWeek.selected.length, 0, 'week 不匹配则空');
  const deduped = selectQueue({
    master, clusterMap, kwToCluster, priorities: ['P0'], week: 'Week 1',
    existingKeywords: new Set(['k_p0_qw']),
  });
  assert.deepEqual(deduped.selected.map((s) => s.keyword), ['k_p0_trend'], '已存在的被去重');
});

test('selectQueue：--include-long-tail 纳入长尾', () => {
  const master = fixtureMaster();
  const clusterMap = fixtureClusters();
  const kwToCluster = buildKeywordClusterIndex(clusterMap);
  const withLong = selectQueue({ master, clusterMap, kwToCluster, priorities: ['P0'], includeLongTail: true });
  assert.ok(withLong.selected.some((s) => s.keyword === 'k_p0_long'));
});

test('isToolIntent：calculator/工具意图词命中，文章词不误伤（D1 park）', () => {
  assert.ok(TOOL_INTENT_PATTERNS.length > 0);
  // tool 意图 → true
  assert.equal(isToolIntent('north node calculator'), true);
  assert.equal(isToolIntent('vedic chart calculator'), true);
  assert.equal(isToolIntent('best free synastry report'), true);
  assert.equal(isToolIntent('free transit chart with interpretation'), true);
  assert.equal(isToolIntent('ai astrology'), true);
  assert.equal(isToolIntent('astrology ai'), true);
  assert.equal(isToolIntent('aura color test free'), true);
  // 文章词 → false（防误伤）
  assert.equal(isToolIntent('12 th house in astrology'), false);
  assert.equal(isToolIntent('north node in taurus meaning'), false);
  assert.equal(isToolIntent('what is green aura'), false);
  assert.equal(isToolIntent('north node astrology symbol'), false);
  assert.equal(isToolIntent('rahu and ketu in astrology'), false);
  assert.equal(isToolIntent(''), false);
});

test('selectQueue：parkToolIntent 默认 park 工具词，文章词正常入队', () => {
  const master = [
    { keyword: 'north node calculator', volume: 4500, bucket: '战略词', u_score: 1 },
    { keyword: 'north node in taurus meaning', volume: 100, bucket: '快速胜利', u_score: 1 },
  ];
  const clusterMap = new Map([
    ['c', { cluster_id: 'c', keywords_included: 'north node', primary_entity: 'North Node', priority: 'P0', week: 'Week 1' }],
  ]);
  const matcher = buildClusterMatcher(clusterMap);
  const r = selectQueue({ master, clusterMap, kwToCluster: matcher, priorities: ['P0'], week: 'Week 1' });
  const keys = r.selected.map((s) => s.keyword);
  assert.ok(!keys.includes('north node calculator'), 'calculator 工具词被 park');
  assert.ok(r.parked.some((p) => p.keyword === 'north node calculator'), 'park 列表留档');
  assert.ok(keys.includes('north node in taurus meaning'), '文章词正常入队');
});

test('selectQueue：parkToolIntent=false 时工具词可入队', () => {
  const master = [{ keyword: 'north node calculator', volume: 4500, bucket: '战略词', u_score: 1 }];
  const clusterMap = new Map([
    ['c', { cluster_id: 'c', keywords_included: 'north node', primary_entity: 'North Node', priority: 'P0', week: 'Week 1' }],
  ]);
  const matcher = buildClusterMatcher(clusterMap);
  const r = selectQueue({ master, clusterMap, kwToCluster: matcher, priorities: ['P0'], week: 'Week 1', parkToolIntent: false });
  assert.ok(r.selected.some((s) => s.keyword === 'north node calculator'));
  assert.equal(r.parked.length, 0);
});

test('colLetter / parseStartRow', () => {
  assert.equal(colLetter(0), 'A');
  assert.equal(colLetter(12), 'M'); // Status
  assert.equal(colLetter(16), 'Q'); // cluster_id
  assert.equal(colLetter(26), 'AA');
  assert.equal(parseStartRow('选题登记表!A47:A56'), 47);
  assert.equal(parseStartRow('Sheet1!A2'), 2);
  assert.equal(parseStartRow('garbage'), null);
});
