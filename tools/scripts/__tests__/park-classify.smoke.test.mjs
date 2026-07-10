// park-classify.smoke.test.mjs — 阶段 6 park 分类器。用**流水线真实 error 字符串**测（评审 BLOCKING：
// 旧测试用了 pipeline 从不产生的 'astrology-reviewer FAIL' 给假信心）。核心：判决(FAIL)=permanent，
// 工具没跑成=transient；且内容 FAIL 里同现的工具子串(502/deadlock/timed out/504 words)绝不能翻成 transient。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPark, isTransientPark } from '../lib/park-classify.mjs';

// 工具没跑成 / 配额 / 网络 → 该自动重试
const TRANSIENT = [
  'codex factual review could not complete (codex exited 3) — required gate',
  'review[astrology] SKIPPED: tooling: worker exited 1',
  'authoring: - orchestrator produced no draft after 3 attempt(s) + deterministic repair',
  "You've hit your session limit · resets 9:30pm (Asia/Shanghai)",
  'codex review hit usage limit',
  'WATCHDOG: no CPU/output progress for 180s (deadlock)',
  'preview-wait: hard timeout after 300s',
  'build gate: npm run build failed — socket hang up',
  'HTTP 503 from upstream',
  // CTA Map 的重复键警告不涉及内容事实；桥接器已定义 first-row-wins，可有界重试。
  'authoring: CTA Map gap — CTA Map has 37 duplicate (page_role, track) pairs — first row wins:',
  // 对抗复审回归：schema 是 3 个常驻评审维度之一，review[schema] SKIPPED 是真 transient 工具崩，
  // 绝不能因维度标签/崩溃栈里的 "schema" 字样被冻成 permanent（旧裸 \bschema\b 的 bug）。
  'review[schema] SKIPPED: tooling: worker exited 1',
  'review[astrology] SKIPPED: tooling: worker exited 1: ZodError schema mismatch',
  'codex factual review could not complete (codex exited 3): schema of prompt invalid',
  "You've hit your session limit while validating schema",
];
// 判决类 FAIL(流水线真实格式) + 结构/登记 + 未知 → 绝不自动重试
const PERMANENT = [
  'review[astrology] FAIL: the retrograde claim is wrong',
  'codex completed with codex FAIL — cites a wrong date',
  'authoring: - phase2 FAIL: draft has no H1; aborting after 3 attempt(s)',
  'no row PG-WC-042 in 选题登记表',
  'phase2 FAIL: missing pillars',
  'protected fact drift detected: calendar_dates',
  // 真 schema 判错(今晚 CELEB-025 实例) + 真 schema 校验判错 → permanent（review[schema] FAIL 覆盖）
  "review[schema] FAIL: associated_keywords contains hallucinated 'emma watson zodiac sign'",
  'schema validation failed: associated_keywords off-topic',
  '',
  'some completely unknown weird failure mode',
];
// 关键：内容 FAIL 的自由文本里含工具子串，绝不能因此翻成 transient（评审 BLOCKING+MAJOR）
const PERMANENT_WITH_TRANSIENT_TOKENS = [
  'review[astrology] FAIL: the eclipse was in 503 BCE not 500 BCE',          // 503 不得翻
  'codex completed with codex FAIL — the deadlock plot point is historically wrong', // deadlock 不得翻
  'review[links-seo] FAIL: the anchor timed out phrasing is off',            // timed out 不得翻
  'authoring: - phase2 FAIL: section 504 words too long after 5 attempt(s)', // 504 不得翻
  'codex completed with codex FAIL — the house was overloaded in the reading', // overloaded 不得翻
];

test('transient park 全判 transient（工具没跑成，该自愈）', () => {
  for (const e of TRANSIENT) assert.equal(classifyPark(e), 'transient', `应 transient: ${e}`);
});

test('判决类 FAIL + 结构 + 未知 全判 permanent', () => {
  for (const e of PERMANENT) assert.equal(classifyPark(e), 'permanent', `应 permanent: ${e}`);
});

test('内容 FAIL 含工具子串(503/deadlock/timed out/504/overloaded) 仍判 permanent（防误发事实错）', () => {
  for (const e of PERMANENT_WITH_TRANSIENT_TOKENS) assert.equal(classifyPark(e), 'permanent', `应 permanent(不得被工具子串翻转): ${e}`);
});

test('SKIPPED:tooling(transient) vs review[..] FAIL(permanent) 正确分开（关键歧义）', () => {
  assert.equal(classifyPark('review[astrology] SKIPPED: tooling: worker exited 1'), 'transient');
  assert.equal(classifyPark('review[astrology] FAIL: wrong ascendant'), 'permanent');
  // codex 退出码(工具) vs codex FAIL(判决)
  assert.equal(classifyPark('codex exited 3'), 'transient');
  assert.equal(classifyPark('codex completed with codex FAIL — bad claim'), 'permanent');
});

test('接受 claim 对象或字符串；isTransientPark 便捷判定', () => {
  assert.equal(classifyPark({ error: 'codex exited 3' }), 'transient');
  assert.equal(classifyPark({ error: 'review[astrology] FAIL: x' }), 'permanent');
  assert.equal(classifyPark({ }), 'permanent');
  assert.equal(isTransientPark('session limit'), true);
  assert.equal(isTransientPark('no row 选题登记表'), false);
});
