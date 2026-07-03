// lane-watchdog.smoke.test.mjs — 阶段 5 watchdog 纯判定核（evaluateLanes）+ manifest 完整性。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLanes, isViolation, isLoadedResolver } from '../gg-lane-watchdog.mjs';
import { LANES } from '../lib/lanes-manifest.mjs';

const NOW = 1_000_000; // 固定 nowSec（纯核不依赖真实时钟）
const LN = [
  { label: 'com.gengrowth.a', heartbeat: 'a', maxGapSec: 3600 },
  { label: 'com.gengrowth.b', heartbeat: 'b', maxGapSec: 3600 },
];

test('loaded + 新鲜 → ok；loaded + 超 maxGap → stale', () => {
  const res = evaluateLanes(LN, NOW, () => true,
    (l) => (l.label === 'com.gengrowth.a' ? NOW - 100 : NOW - 7200)); // a 新鲜、b 超期
  const a = res.find((r) => r.label === 'com.gengrowth.a');
  const b = res.find((r) => r.label === 'com.gengrowth.b');
  assert.equal(a.status, 'ok');
  assert.equal(b.status, 'stale');
  assert.equal(isViolation(a), false);
  assert.equal(isViolation(b), true);
});

test('未加载 → not-loaded（最严重，无视新鲜度）', () => {
  const res = evaluateLanes(LN, NOW,
    (label) => label === 'com.gengrowth.a', // 只有 a 加载
    () => NOW - 10);                        // 都很新鲜
  assert.equal(res.find((r) => r.label === 'com.gengrowth.a').status, 'ok');
  assert.equal(res.find((r) => r.label === 'com.gengrowth.b').status, 'not-loaded'); // 未加载即违规
});

test('无任何活动信号(0) → age=Infinity → stale', () => {
  const res = evaluateLanes(LN, NOW, () => true, () => 0);
  for (const r of res) { assert.equal(r.status, 'stale'); assert.equal(r.ageSec, Infinity); }
});

test('maxGap 边界：age===maxGap → ok；age===maxGap+1 → stale', () => {
  const one = [{ label: 'com.gengrowth.x', heartbeat: 'x', maxGapSec: 3600 }];
  assert.equal(evaluateLanes(one, NOW, () => true, () => NOW - 3600)[0].status, 'ok');     // 恰好=不算超
  assert.equal(evaluateLanes(one, NOW, () => true, () => NOW - 3601)[0].status, 'stale');  // 超 1s
});

test('未来时钟偏移(last>now) → ageSec 夹到 0，不误判 stale', () => {
  const one = [{ label: 'com.gengrowth.x', heartbeat: 'x', maxGapSec: 3600 }];
  const r = evaluateLanes(one, NOW, () => true, () => NOW + 500)[0];
  assert.equal(r.ageSec, 0);
  assert.equal(r.status, 'ok');
});

test('isLoadedResolver：null(查询失败)→全 loaded(不误判 not-loaded)；Set→按成员', () => {
  const rNull = isLoadedResolver(null);
  assert.equal(rNull('com.gengrowth.anything'), true); // 查询失败 → 不判 not-loaded
  const rSet = isLoadedResolver(new Set(['com.gengrowth.a']));
  assert.equal(rSet('com.gengrowth.a'), true);
  assert.equal(rSet('com.gengrowth.b'), false);
});

test('launchctl 查询失败(null)时 evaluateLanes 不产 not-loaded，只按 age', () => {
  // isLoadedResolver(null) 全 true → 新鲜的判 ok、超期的判 stale，绝无 not-loaded 假风暴
  const res = evaluateLanes(LN, NOW, isLoadedResolver(null),
    (l) => (l.label === 'com.gengrowth.a' ? NOW - 100 : NOW - 99999));
  assert.equal(res.find((r) => r.label === 'com.gengrowth.a').status, 'ok');
  assert.equal(res.find((r) => r.label === 'com.gengrowth.b').status, 'stale');
  assert.ok(!res.some((r) => r.status === 'not-loaded')); // 关键：查询失败绝不误判未加载
});

test('manifest 完整性：7 lane、字段齐全、label 唯一、有回退信号、nightly 用真实日志文件', () => {
  assert.equal(LANES.length, 7);
  const labels = new Set();
  for (const l of LANES) {
    assert.match(l.label, /^com\.gengrowth\./);
    assert.ok(l.heartbeat, `${l.label} 缺 heartbeat`);
    assert.ok(l.maxGapSec > 0, `${l.label} maxGapSec 非正`);
    assert.ok(l.logDir || l.logFile, `${l.label} 缺 logDir/logFile 回退`);
    assert.ok(!labels.has(l.label), `重复 label ${l.label}`);
    labels.add(l.label);
  }
  // HB-2 回归：nightly 的回退日志必须是脚本真写的文件，不是永不更新的 launchd.out.log
  const nightly = LANES.find((l) => l.label === 'com.gengrowth.seo-nightly');
  assert.ok(!/launchd\.out\.log$/.test(nightly.logFile), 'nightly logFile 不能指向 launchd.out.log(永不更新)');
});
