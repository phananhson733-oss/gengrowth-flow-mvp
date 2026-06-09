import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMasterRows,
  buildExactClusterIndex,
  classifyMasterRows,
  findOrphanClusterKeywords,
} from '../gg-cluster-sync.mjs';

// 构造假 clusterMap：Map<cid, {keywords_included, priority, ...}>
function fakeClusterMap() {
  return new Map([
    ['c_journal', { keywords_included: 'journal prompts, moon journal, emotion journal' }],
    ['c_lilith', { keywords_included: 'black moon lilith, black lilith' }],
    // 同一词进两个集群 → 冲突
    ['c_overlap', { keywords_included: 'black lilith, shared kw' }],
  ]);
}

test('buildMasterRows: 跳过空 A 列与 ## section header，保留 sheet 行号', () => {
  const grid = [
    ['关键词'],            // 行1 表头
    ['## 占星基础'],       // 行2 一级小节标题 → 跳过
    ['moon journal'],      // 行3 正常关键词
    [''],                  // 行4 空 A 列 → 跳过
    ['### 进阶玩法'],      // 行5 多级标题 → 跳过
    ['black moon lilith'], // 行6 正常关键词
  ];
  const rows = buildMasterRows(grid);
  assert.deepEqual(rows.map((r) => r.kw), ['moon journal', 'black moon lilith']);
  assert.deepEqual(rows.map((r) => r.row), [3, 6]); // 行号对齐 sheet（表头=行1）
});

test('buildExactClusterIndex: keywords_included → kw→Set(cid)，多归属记冲突', () => {
  const idx = buildExactClusterIndex(fakeClusterMap());
  assert.deepEqual([...idx.get('journal prompts')], ['c_journal']);
  assert.deepEqual([...idx.get('moon journal')], ['c_journal']);
  // black lilith 同时在 c_lilith 和 c_overlap
  assert.equal(idx.get('black lilith').size, 2);
  assert.ok(idx.get('black lilith').has('c_lilith') && idx.get('black lilith').has('c_overlap'));
  // 归一化：大小写/空白
  assert.deepEqual([...idx.get('BLACK MOON LILITH '.trim().toLowerCase())], ['c_lilith']);
});

test('classifyMasterRows: AC 已填 → 跳过(不进任何桶)', () => {
  const exactIndex = buildExactClusterIndex(fakeClusterMap());
  const r = classifyMasterRows({
    masterRows: [{ row: 2, kw: 'journal prompts', ac: 'c_journal' }], // AC 已有值
    exactIndex,
    fuzzy: () => null,
  });
  assert.equal(r.syncs.length, 0);
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.unclustered.length, 0);
});

test('classifyMasterRows: 精确唯一命中 → syncs', () => {
  const exactIndex = buildExactClusterIndex(fakeClusterMap());
  const r = classifyMasterRows({
    masterRows: [{ row: 5, kw: 'moon journal', ac: '' }],
    exactIndex,
    fuzzy: () => null,
  });
  assert.deepEqual(r.syncs, [{ row: 5, kw: 'moon journal', cid: 'c_journal' }]);
});

test('classifyMasterRows: 精确多命中 → conflicts(不自动写)', () => {
  const exactIndex = buildExactClusterIndex(fakeClusterMap());
  const r = classifyMasterRows({
    masterRows: [{ row: 7, kw: 'black lilith', ac: '' }],
    exactIndex,
    fuzzy: () => 'c_lilith',
  });
  assert.equal(r.syncs.length, 0);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].cids.length, 2);
});

test('classifyMasterRows: 仅模糊命中 → fuzzy；无命中 → unclustered', () => {
  const exactIndex = buildExactClusterIndex(fakeClusterMap());
  const fuzzy = (k) => (k === 'lunar journaling' ? 'c_journal' : null);
  const r = classifyMasterRows({
    masterRows: [
      { row: 9, kw: 'lunar journaling', ac: '' }, // 精确没中、模糊中
      { row: 10, kw: 'totally unrelated term', ac: '' }, // 都没中
    ],
    exactIndex,
    fuzzy,
  });
  assert.deepEqual(r.fuzzy, [{ row: 9, kw: 'lunar journaling', cid: 'c_journal' }]);
  assert.deepEqual(r.unclustered, [{ row: 10, kw: 'totally unrelated term' }]);
});

test('findOrphanClusterKeywords: keywords_included 里主表没有的词 → orphan', () => {
  const cm = new Map([
    ['c_house', { keywords_included: '9th house, 9th house astrology' }],
  ]);
  const masterKwSet = new Set(['9th house astrology']); // 主表只有长串，没有 "9th house"
  const orphans = findOrphanClusterKeywords(cm, masterKwSet);
  assert.deepEqual(orphans, [{ cid: 'c_house', kw: '9th house' }]);
});
