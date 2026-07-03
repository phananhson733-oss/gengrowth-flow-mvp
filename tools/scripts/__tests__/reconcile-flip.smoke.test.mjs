// reconcile-flip.smoke.test.mjs — planPageFlips 纯决策核（阶段 4 定向 Sheet 回填的安全关键逻辑）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPageFlips, PUBLISHED } from '../gg-reconcile-status.mjs';

const HEADER = ['Target Keyword', 'Status', 'page_id', '发布URL'];

test('open 行 flip + 空 URL 补；closed 行永不降级；已有 URL 不覆盖；无行跳过', () => {
  const rows = [
    HEADER,
    ['kw a', '待写', 'PG-A-1', ''],                 // open, 无 url → flip + 补 url
    ['kw b', '已发布', 'PG-B-1', 'https://x/b'],     // closed → skip（不降级）
    ['kw c', '写作中', 'PG-C-1', 'https://existing'], // open 但 url 已有 → 只 flip status
  ];
  const { data, applied, skipped } = planPageFlips(rows, [
    { pageId: 'PG-A-1', url: 'https://a' },
    { pageId: 'PG-B-1', url: 'https://b' },
    { pageId: 'PG-C-1', url: 'https://c' },
    { pageId: 'PG-MISS', url: 'https://m' },
  ]);

  // applied：只有 A-1、C-1
  assert.equal(applied.length, 2);
  assert.ok(applied.find((a) => a.pageId === 'PG-A-1'));
  assert.ok(applied.find((a) => a.pageId === 'PG-C-1'));

  // skipped：B-1（closed，不降级）、MISS（无行）
  assert.ok(skipped.find((x) => x.pageId === 'PG-B-1' && /not-open/.test(x.reason)));
  assert.ok(skipped.find((x) => x.pageId === 'PG-MISS' && x.reason === 'no-row'));

  // data：A-1 status+url（2）+ C-1 status（1）= 3
  assert.equal(data.length, 3);
  assert.equal(data.filter((d) => d.values[0][0] === PUBLISHED).length, 2); // 两个 status 写 已发布
  assert.ok(data.some((d) => d.values[0][0] === 'https://a'));  // A-1 空 URL → 补
  assert.ok(!data.some((d) => d.values[0][0] === 'https://c')); // C-1 已有 URL → 不覆盖
  // B-1 是第 3 行（closed）：所有写入只应触及第 2 行(A-1)与第 4 行(C-1)，第 3 行绝不被碰。
  const rowsTouched = [...new Set(data.map((d) => d.range.match(/(\d+)$/)[1]))].sort();
  assert.deepEqual(rowsTouched, ['2', '4']);
});

test('空 entries → 空结果，不抛', () => {
  const { data, applied, skipped } = planPageFlips([HEADER], []);
  assert.deepEqual(data, []);
  assert.deepEqual(applied, []);
  assert.deepEqual(skipped, []);
});

test('缺 Status/page_id 表头 → 抛（防写错列）', () => {
  assert.throws(() => planPageFlips([['a', 'b', 'c']], [{ pageId: 'PG-A-1' }]), /Status\/page_id/);
});

test('幂等：已是 closed（已发布）再跑 → 全 skip、零 data', () => {
  const rows = [HEADER, ['kw', '已发布', 'PG-A-1', 'https://x']];
  const { data, applied, skipped } = planPageFlips(rows, [{ pageId: 'PG-A-1', url: 'https://x' }]);
  assert.equal(data.length, 0);
  assert.equal(applied.length, 0);
  assert.equal(skipped.length, 1);
});
