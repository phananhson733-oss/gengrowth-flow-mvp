#!/usr/bin/env node
// Hermetic smoke tests for gg-batch-summary.mjs（契约：lib/NOTIFY-CONTRACT.md）。
//
// 全部依赖走 env 覆盖，零真网络／真飞书／真 ledger：
//   · mock HTTP 站点跑在【独立子进程】里（spawnSync 会阻塞本进程事件循环，
//     进程内 server 无法应答，必须外置），GG_BATCH_SUMMARY_BASE_ASTRO/GENG 指过去；
//   · claims ledger 用 GG_OPS_DIR 指向沙箱目录；
//   · gg-notify CLI 用 GG_NOTIFY_BIN 指向假 bin（记录 argv 与 @ env，绝不依赖真 gg-notify.mjs 存在）。
// 其余保持 node:test + spawnSync 黑盒风格，同 gg-preview-gate.smoke.test.mjs。
//
// Run: node --test tools/scripts/__tests__/gg-batch-summary.smoke.test.mjs

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { terminalMessageUuid } from '../lib/seo-repair-controller.mjs';

const SCRIPT = fileURLToPath(new URL('../gg-batch-summary.mjs', import.meta.url));
const ROOT = join(tmpdir(), `gg-batch-summary-test-${process.pid}`);
mkdirSync(ROOT, { recursive: true });

// ── mock HTTP 站点（独立子进程；/flaky 首个请求 500、其后 200，验证 HEAD→GET 容错） ──
const serverPath = join(ROOT, 'mock-server.mjs');
const portFile = join(ROOT, 'port');
writeFileSync(serverPath, `import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
const routes = {
  '/en/wiki/slug-a': 200,
  '/en/wiki/slug-b': 200,
  '/en/wiki/slug-missing': 404,
  '/en/wiki/astro-only': 200,
  '/en/wiki/legacy-in-plan': 200,
  '/en/wiki/legacy-terminal': 200,
  '/en/blog/geng-ok': 200,
};
let flakyHits = 0;
const srv = createServer((req, res) => {
  const path = req.url.split('?')[0];
  let code;
  if (path === '/en/wiki/flaky') { flakyHits++; code = flakyHits >= 2 ? 200 : 500; }
  else code = routes[path] ?? 404;
  res.statusCode = code;
  res.end();
});
srv.listen(0, '127.0.0.1', () => writeFileSync(process.argv[2], String(srv.address().port)));
`);
const serverChild = spawn(process.execPath, [serverPath, portFile], { stdio: 'ignore' });
{
  const deadline = Date.now() + 8000;
  while (!existsSync(portFile)) {
    if (Date.now() > deadline) throw new Error('mock server did not start');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const BASE = `http://127.0.0.1:${readFileSync(portFile, 'utf8').trim()}`;

// ── 每用例沙箱：GG_OPS_DIR 账本 + 假 notify bin（记录 argv 与 @ env） ────────────
let caseSeq = 0;
function freshCase(claims = {}) {
  const dir = join(ROOT, `case-${caseSeq++}`);
  const tasksDir = join(dir, 'ops', 'inbox', '06-tasks', 'tasks');
  const stateDir = join(dir, 'flow-state');
  const queueDir = join(stateDir, 'seo-repair-queue');
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(queueDir, { recursive: true });
  writeFileSync(join(tasksDir, '.autopilot-claims.json'), JSON.stringify(claims));
  const plan = join(tasksDir, 'plan.md');
  writeFileSync(plan, [
    '# summary fixture',
    '',
    ...Object.keys(claims).map((pageId) => `- [ ] \`${pageId}\` fixture`),
    '',
  ].join('\n'));
  const sentinel = join(dir, 'notify-calls.jsonl');
  const notifyBin = join(dir, 'fake-notify.mjs');
  writeFileSync(notifyBin, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(sentinel)}, JSON.stringify({
  argv: process.argv.slice(2),
  atOps: process.env.GG_LARK_NOTIFY_AT_OPS || '',
  atPm: process.env.GG_LARK_NOTIFY_AT_PM || '',
  silence: process.env.GG_LARK_NOTIFY_SILENCE || '',
}) + '\\n');
process.exit(0);
`);
  chmodSync(notifyBin, 0o755);
  return {
    dir,
    opsDir: join(dir, 'ops'),
    stateDir,
    queueDir,
    plan,
    sentinel,
    notifyBin,
  };
}

function run(args, c, extraEnv = {}) {
  const boundedArgs = [...args];
  if (boundedArgs.includes('--since')) {
    if (!boundedArgs.includes('--plan')) boundedArgs.push('--plan', c.plan);
    if (!boundedArgs.includes('--run-id')) boundedArgs.push('--run-id', 'test-run-1');
  }
  const env = {
    ...process.env,
    GG_OPS_DIR: c.opsDir,
    GG_FLOW_STATE_DIR: c.stateDir,
    GG_SEO_REPAIR_QUEUE_DIR: c.queueDir,
    GG_BATCH_SUMMARY_BASE_ASTRO: BASE,
    GG_BATCH_SUMMARY_BASE_GENG: BASE,
    GG_BATCH_SUMMARY_TIMEOUT_MS: '3000',
    GG_NOTIFY_BIN: c.notifyBin,
    ...extraEnv,
  };
  // 父环境的 @ 开关绝不能漏进断言（脚本自己也会清，但测试侧同样兜底）。
  delete env.GG_LARK_NOTIFY_AT_OPS;
  delete env.GG_LARK_NOTIFY_AT_PM;
  return spawnSync(process.execPath, [SCRIPT, ...boundedArgs], { encoding: 'utf8', timeout: 60000, env });
}

function notifyCalls(c) {
  if (!existsSync(c.sentinel)) return [];
  return readFileSync(c.sentinel, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

// 取假 bin 收到的 --text 值
function sentText(call) {
  const i = call.argv.indexOf('--text');
  return i >= 0 ? call.argv[i + 1] : '';
}

function writeQueueRecord(c, name, record) {
  writeFileSync(join(c.queueDir, `${name}.json`), JSON.stringify(record));
}

const SINCE = '2026-07-03T00:00:00Z';
const IN_WINDOW = '2026-07-03T08:00:00Z';
const OLD = '2026-07-01T08:00:00Z';
const DATE = '2026-07-03';

// ── (a) 全 200 → 完成模板，不 @，窗口外 done 不计入 ────────────────────────────
test('all 200 → 完成模板 via notify raw, no @, since-filtered', () => {
  const c = freshCase({
    'PG-A-001': { status: 'done', slug: 'slug-a', mergedAt: IN_WINDOW },
    'PG-B-002': { status: 'done', slug: 'slug-b', mergedAt: IN_WINDOW },
    'PG-OLD-003': { status: 'done', slug: 'slug-old', mergedAt: OLD }, // 窗口外，不得出现
  });
  const r = run(['--since', SINCE, '--date', DATE], c);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const calls = notifyCalls(c);
  assert.equal(calls.length, 1, 'exactly one notify call');
  assert.equal(calls[0].argv[0], 'raw', 'sent through the raw channel');
  const text = sentText(calls[0]);
  assert.ok(text.startsWith(`✅ [flow] 批次汇总 ${DATE}：上线 2 篇（已逐篇线上核实）`), `text: ${text}`);
  assert.match(text, /\[astrologywiki\] slug-a、slug-b/);
  assert.ok(!text.includes('slug-old'), 'out-of-window claim must not appear');
  assert.ok(!text.includes('暂停待人工'), 'k=0 → 暂停待人工 line omitted');
  assert.equal(calls[0].atOps, '', '完成模板不 @ OPS');
  assert.equal(calls[0].atPm, '', '完成模板不 @ PM');
});

// ── (b) 1 篇 404 → 部分完成模板 + AT_OPS=1 + exit 0 ───────────────────────────
test('one 404 → 部分完成模板, GG_LARK_NOTIFY_AT_OPS=1, still exit 0', () => {
  const c = freshCase({
    'PG-A-001': { status: 'done', slug: 'slug-a', mergedAt: IN_WINDOW },
    'PG-M-002': { status: 'done', slug: 'slug-missing', mergedAt: IN_WINDOW },
  });
  const r = run(['--since', SINCE, '--date', DATE], c);
  assert.equal(r.status, 0, `partial 完成也 exit 0; stderr: ${r.stderr}`);
  const calls = notifyCalls(c);
  assert.equal(calls.length, 1);
  const text = sentText(calls[0]);
  assert.ok(text.startsWith(`⚠️ [flow] 批次汇总 ${DATE}：1/2 篇已上线核实，以下未核实到线上：`), `text: ${text}`);
  assert.match(text, /astrologywiki\/slug-missing（HTTP 404）/);
  assert.equal(calls[0].atOps, '1', '部分完成必须 @ OPS');
});

// ── (c) 空窗口 → exit 2，不发送 ────────────────────────────────────────────────
test('empty window (only out-of-window claims) → exit 2, nothing sent', () => {
  const c = freshCase({
    'PG-OLD-003': { status: 'done', slug: 'slug-old', mergedAt: OLD },
    'PG-POLD-004': { status: 'needs_human', slug: 's', failedAt: OLD, error: '旧的 park' },
  });
  const r = run(['--since', SINCE], c);
  assert.equal(r.status, 2, `expected exit 2; stderr: ${r.stderr}; stdout: ${r.stdout}`);
  assert.equal(notifyCalls(c).length, 0, 'notify bin must NOT be invoked');
});

// ── (d) --dry-run → 打印渲染文本，不发送 ──────────────────────────────────────
test('--dry-run prints rendered text and never spawns notify', () => {
  const c = freshCase({
    'PG-A-001': { status: 'done', slug: 'slug-a', mergedAt: IN_WINDOW },
  });
  const r = run(['--since', SINCE, '--date', DATE, '--dry-run'], c);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /✅ \[flow\] 批次汇总 2026-07-03：上线 1 篇（已逐篇线上核实）/);
  assert.match(r.stdout, /\[astrologywiki\] slug-a/);
  assert.equal(notifyCalls(c).length, 0, '--dry-run must not send');
});

// ── (e) parked：ledger needs_human（窗口内）与 --parked CLI 合并 ────────────────
test('parked line merges ledger needs_human (failedAt ≥ since) with --parked', () => {
  const c = freshCase({
    'PG-A-001': { status: 'done', slug: 'slug-a', mergedAt: IN_WINDOW },
    'PG-P-002': { status: 'needs_human', slug: 'sp', failedAt: IN_WINDOW, error: 'zh 门未过' },
    'PG-POLD-003': { status: 'needs_human', slug: 'so', failedAt: OLD, error: '旧的 park' },
  });
  const r = run(['--since', SINCE, '--date', DATE, '--parked', 'GG-X-001:凭据缺失'], c);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const calls = notifyCalls(c);
  assert.equal(calls.length, 1);
  const text = sentText(calls[0]);
  assert.ok(text.startsWith('✅ [flow] 批次汇总'), '有 parked 但全 200 仍是完成模板');
  assert.match(text, /暂停待人工 2 篇：/);
  assert.match(text, /GG-X-001（凭据缺失）/);
  assert.match(text, /PG-P-002（zh 门未过）/);
  assert.ok(!text.includes('PG-POLD-003'), 'out-of-window park must not appear');
  assert.equal(calls[0].atOps, '', '完成模板即使有 parked 也不 @（parked 事件本身已单独 @ 过）');
});

test('v2 parked line reports automatic repair queue instead of human intervention', () => {
  const c = freshCase({
    'PG-A-001': { status: 'done', slug: 'slug-a', mergedAt: IN_WINDOW },
    'PG-P-002': { status: 'needs_human', slug: 'sp', failedAt: IN_WINDOW, error: 'zh 门未过' },
  });
  const r = run(
    ['--since', SINCE, '--date', DATE, '--parked', 'GG-X-001:凭据缺失'],
    c,
    { GG_SEO_REPAIR_CONTROLLER_V2_ENABLED: '1' },
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const text = sentText(notifyCalls(c)[0]);
  assert.match(text, /自动修复队列 2 篇：/);
  assert.doesNotMatch(text, /暂停待人工/);
});

// ── (f) gengrowth 侧 --urls 与 oracle 侧合并分组渲染；/flaky 验证 HEAD→GET 容错 ──
test('--urls merges gengrowth URLs; flaky endpoint recovers via GET fallback', () => {
  const c = freshCase({
    'PG-A-001': { status: 'done', slug: 'flaky', mergedAt: IN_WINDOW }, // 首个 HEAD 500，GET 200
  });
  const r = run(['--since', SINCE, '--date', DATE, '--urls', `${BASE}/en/blog/geng-ok`], c);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const calls = notifyCalls(c);
  assert.equal(calls.length, 1);
  const text = sentText(calls[0]);
  assert.ok(text.startsWith(`✅ [flow] 批次汇总 ${DATE}：上线 2 篇（已逐篇线上核实）`), `flaky 应经回退核实通过; text: ${text}`);
  assert.match(text, /\[astrologywiki\] flaky/);
  assert.match(text, /\[gengrowth\] geng-ok/);
});

// ── (g) --site gengrowth → 跳过 ledger，只核实 --urls ──────────────────────────
test('--site gengrowth skips the oracle ledger entirely', () => {
  const c = freshCase({
    'PG-A-001': { status: 'done', slug: 'slug-a', mergedAt: IN_WINDOW },
    'PG-P-002': { status: 'needs_human', slug: 'sp', failedAt: IN_WINDOW, error: 'zh 门未过' },
  });
  const r = run(['--since', SINCE, '--date', DATE, '--site', 'gengrowth', '--urls', `${BASE}/en/blog/geng-ok`], c);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const text = sentText(notifyCalls(c)[0]);
  assert.ok(text.startsWith(`✅ [flow] 批次汇总 ${DATE}：上线 1 篇`), `text: ${text}`);
  assert.ok(!text.includes('slug-a'), 'ledger done must be skipped for --site gengrowth');
  assert.ok(!text.includes('PG-P-002'), 'ledger parked must be skipped for --site gengrowth');
  assert.match(text, /\[gengrowth\] geng-ok/);
});

// ── (h) 用法错误：缺 --since → exit 1，不发送 ──────────────────────────────────
test('missing --since → exit 1 + usage on stderr, nothing sent', () => {
  const c = freshCase({});
  const r = run([], c);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--since/);
  assert.equal(notifyCalls(c).length, 0);
});

test('父环境 GG_LARK_NOTIFY_SILENCE=1 被清洗：批尾汇总绝不能被批次静默吞掉', () => {
  const c = freshCase({
    'PG-X-1': { status: 'done', slug: 'good-a', mergedAt: IN_WINDOW },
  });
  const r = run(['--since', SINCE, '--date', DATE], c, { GG_LARK_NOTIFY_SILENCE: '1' });
  assert.equal(r.status, 0, r.stderr);
  const calls = notifyCalls(c);
  assert.equal(calls.length, 1, '汇总必须照发');
  assert.equal(calls[0].silence, '', '子进程环境里 SILENCE 必须已被清洗');
});

test('only parked items stay silent: parseParked remains tolerant but sends no zero-publish summary', () => {
  const c = freshCase({});
  const r = run(['--since', SINCE, '--date', DATE, '--parked', ':needs_human,PG-Y-2:no row'], c);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(notifyCalls(c).length, 0, '仅 parked 不得发送“上线 0 篇”中间状态');
});

test('notify bin 失效（ENOENT）→ exit 3 + 渲染文本直接入 outbox 兜底', () => {
  const c = freshCase({
    'PG-X-1': { status: 'done', slug: 'good-a', mergedAt: IN_WINDOW },
  });
  const stateDir = join(c.dir, 'flow-state');
  const r = run(['--since', SINCE, '--date', DATE], c, {
    GG_NOTIFY_BIN: join(c.dir, 'no-such-notify.mjs'), // spawn 起得来但 node 立刻退非 0（模块不存在）
    GG_FLOW_STATE_DIR: stateDir,
  });
  assert.equal(r.status, 3, `notify 调用失败必须 exit 3（stderr: ${r.stderr}）`);
  assert.match(r.stderr, /notify 调用异常/);
  const outbox = join(stateDir, 'notify-outbox');
  const files = existsSync(outbox) ? readdirSync(outbox).filter((f) => f.endsWith('.json')) : [];
  assert.equal(files.length, 1, '渲染文本必须直接入 outbox 兜底');
  const payload = JSON.parse(readFileSync(join(outbox, files[0]), 'utf8'));
  assert.match(payload.text, /批次汇总 2026-07-03/);
  assert.match(payload.lastError, /notify-(spawn|exit)/);
  assert.equal(payload.idempotencyKey, 'batch-terminal:test-run-1');
  assert.equal(payload.msgUuid, terminalMessageUuid('batch-terminal:test-run-1'));
});

test('mixed claims ledger is scoped to the selected site and pinned plan', () => {
  const c = freshCase({
    'PG-CELEB-058': {
      site: 'astrologywiki',
      status: 'done',
      slug: 'astro-only',
      mergedAt: IN_WINDOW,
    },
    'PG-SDS-004': {
      site: 'gengrowth',
      status: 'done',
      slug: 'geng-ok',
      mergedAt: IN_WINDOW,
    },
    'PG-ASTRO-OUT': {
      site: 'astrologywiki',
      status: 'done',
      slug: 'slug-b',
      mergedAt: IN_WINDOW,
    },
    'PG-MISMATCH-001': {
      site: 'gengrowth',
      status: 'done',
      slug: 'slug-b',
      mergedAt: IN_WINDOW,
    },
    'PG-LEGACY-001': {
      status: 'done',
      slug: 'legacy-in-plan',
      mergedAt: IN_WINDOW,
    },
    'PG-LEGACY-OUT': {
      status: 'done',
      slug: 'legacy-out-of-plan',
      mergedAt: IN_WINDOW,
    },
  });
  writeFileSync(c.plan, [
    '# W22 fixture',
    '',
    '- [ ] `PG-CELEB-058` astrology target',
    '- [ ] `PG-MISMATCH-001` explicit mismatched site must still stay out',
    '- [ ] `PG-LEGACY-001` legacy target in selected plan',
    '',
  ].join('\n'));

  const r = run([
    '--since', SINCE,
    '--date', DATE,
    '--site', 'astrologywiki',
    '--plan', c.plan,
    '--run-id', 'run-1',
    '--dry-run',
  ], c);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /\[astrologywiki\] astro-only、legacy-in-plan/);
  assert.doesNotMatch(r.stdout, /geng-ok/);
  assert.doesNotMatch(r.stdout, /slug-b/);
  assert.doesNotMatch(r.stdout, /legacy-out-of-plan/);
});

test('PG ids mentioned only in plan prose are not treated as allowed checklist targets', () => {
  const c = freshCase({});
  writeFileSync(c.plan, [
    '# W22 fixture',
    '',
    '- [ ] `PG-A-001` intended checklist target',
    '',
    'Historical note: PG-OUT-999 was retired and must not re-enter this batch.',
    '',
  ].join('\n'));
  writeQueueRecord(c, 'prose-only-terminal', {
    status: 'archived',
    event: {
      site: 'astrologywiki',
      pageId: 'PG-OUT-999',
      slug: 'retired',
      createdAt: IN_WINDOW,
    },
    updatedAt: IN_WINDOW,
  });

  const r = run([
    '--since', SINCE,
    '--site', 'astrologywiki',
    '--plan', c.plan,
    '--run-id', 'run-1',
    '--dry-run',
  ], c);
  assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.stdout, /PG-OUT-999|retired/);
  assert.equal(notifyCalls(c).length, 0);
});

test('existing corrupt claims ledger fails closed instead of claiming an empty or successful fire', () => {
  const c = freshCase({});
  writeFileSync(join(c.opsDir, 'inbox', '06-tasks', 'tasks', '.autopilot-claims.json'), '{"broken":');
  const r = run(['--since', SINCE, '--site', 'astrologywiki'], c);
  assert.equal(r.status, 4, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /claims ledger 解析失败/);
  assert.equal(notifyCalls(c).length, 0);
});

for (const [label, invalidClaims] of [
  ['array', '[]'],
  ['scalar', '"not-a-ledger"'],
  ['invalid claim value', '{"PG-A-001":"not-a-claim"}'],
]) {
  test(`parseable ${label} claims ledger fails closed`, () => {
    const c = freshCase({});
    writeFileSync(join(c.opsDir, 'inbox', '06-tasks', 'tasks', '.autopilot-claims.json'), invalidClaims);
    const r = run(['--since', SINCE, '--site', 'astrologywiki'], c);
    assert.equal(r.status, 4, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /claims ledger .*无效/);
    assert.equal(notifyCalls(c).length, 0);
  });
}

for (const [label, invalidSite] of [
  ['numeric', 7],
  ['array', ['gengrowth']],
  ['unknown string', 'other-site'],
]) {
  test(`claim with ${label} explicit site fails closed instead of becoming legacy no-site`, () => {
    const c = freshCase({
      'PG-A-001': {
        site: invalidSite,
        status: 'done',
        slug: 'slug-a',
        mergedAt: IN_WINDOW,
      },
    });
    const r = run(['--since', SINCE, '--site', 'astrologywiki'], c);
    assert.equal(r.status, 4, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /claims ledger 条目 PG-A-001 site 无效/);
    assert.equal(notifyCalls(c).length, 0);
  });
}

test('corrupt repair queue record fails closed instead of emitting a partial false terminal summary', () => {
  const c = freshCase({
    'PG-A-001': { site: 'astrologywiki', status: 'done', slug: 'slug-a', mergedAt: IN_WINDOW },
  });
  writeFileSync(join(c.queueDir, 'corrupt.json'), '{"broken":');
  const r = run(['--since', SINCE, '--site', 'astrologywiki'], c);
  assert.equal(r.status, 4, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /repair record corrupt\.json 解析失败/);
  assert.equal(notifyCalls(c).length, 0);
});

for (const [label, invalidRecord] of [
  ['array', []],
  ['scalar', 'not-a-record'],
  ['missing status', { event: { site: 'astrologywiki', pageId: 'PG-A-001' } }],
  ['missing event', { status: 'archived' }],
  ['missing pageId', { status: 'archived', event: { site: 'astrologywiki' } }],
]) {
  test(`parseable queue record ${label} fails closed`, () => {
    const c = freshCase({
      'PG-A-001': { site: 'astrologywiki', status: 'done', slug: 'slug-a', mergedAt: IN_WINDOW },
    });
    writeFileSync(join(c.queueDir, 'invalid.json'), JSON.stringify(invalidRecord));
    const r = run(['--since', SINCE, '--site', 'astrologywiki'], c);
    assert.equal(r.status, 4, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /repair record invalid\.json .*无效/);
    assert.equal(notifyCalls(c).length, 0);
  });
}

for (const [label, latestEvent] of [
  ['run-only latestEvent', { runId: 'run-1' }],
  ['conflicting page owner', { site: 'astrologywiki', pageId: 'PG-OTHER-777', runId: 'run-1' }],
  ['conflicting site owner', { site: 'gengrowth', pageId: 'PG-A-001', runId: 'run-1' }],
]) {
  test(`${label} fails closed instead of rebinding an old terminal to the current fire`, () => {
    const c = freshCase({});
    writeFileSync(c.plan, '- [ ] `PG-A-001` intended target\n');
    writeQueueRecord(c, 'invalid-latest.json', {
      status: 'human_only',
      event: {
        site: 'astrologywiki',
        runId: 'old-run',
        pageId: 'PG-A-001',
        createdAt: OLD,
      },
      latestEvent,
      updatedAt: OLD,
    });
    const r = run([
      '--since', SINCE,
      '--site', 'astrologywiki',
      '--plan', c.plan,
      '--run-id', 'run-1',
      '--dry-run',
    ], c);
    assert.equal(r.status, 4, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /repair record invalid-latest\.json latestEvent .*无效/);
    assert.equal(notifyCalls(c).length, 0);
  });
}

test('controller terminal records are filtered by selected site and current run while active records stay silent', () => {
  const c = freshCase({});
  writeFileSync(c.plan, [
    '# W22 fixture',
    '',
    '- [ ] `PG-CELEB-058` published this fire',
    '- [ ] `PG-CELEB-059` active this fire',
    '- [ ] `PG-CELEB-060` terminal stop this fire',
    '- [ ] `PG-CELEB-061` legacy terminal this fire',
    '',
  ].join('\n'));
  writeQueueRecord(c, 'published-current', {
    status: 'published',
    event: {
      site: 'astrologywiki',
      runId: 'older-run',
      pageId: 'PG-CELEB-058',
      slug: 'astro-only',
      createdAt: IN_WINDOW,
    },
    latestEvent: {
      site: 'astrologywiki',
      runId: 'run-1',
      pageId: 'PG-CELEB-058',
      slug: 'astro-only',
      createdAt: IN_WINDOW,
    },
    updatedAt: IN_WINDOW,
  });
  writeQueueRecord(c, 'published-other-run', {
    status: 'published',
    event: {
      site: 'astrologywiki',
      runId: 'run-2',
      pageId: 'PG-CELEB-099',
      slug: 'slug-b',
      createdAt: IN_WINDOW,
    },
    updatedAt: IN_WINDOW,
  });
  writeQueueRecord(c, 'active-current', {
    status: 'repairing',
    event: {
      site: 'astrologywiki',
      runId: 'run-1',
      pageId: 'PG-CELEB-059',
      slug: 'slug-b',
      createdAt: IN_WINDOW,
    },
    updatedAt: IN_WINDOW,
  });
  writeQueueRecord(c, 'other-site-current', {
    status: 'published',
    event: {
      site: 'gengrowth',
      runId: 'run-1',
      pageId: 'PG-SDS-004',
      slug: 'geng-ok',
      createdAt: IN_WINDOW,
    },
    updatedAt: IN_WINDOW,
  });
  writeQueueRecord(c, 'same-site-current-out-of-plan', {
    status: 'human_only',
    event: {
      site: 'astrologywiki',
      runId: 'run-1',
      pageId: 'PG-OTHER-777',
      slug: 'other-plan',
      createdAt: IN_WINDOW,
    },
    updatedAt: IN_WINDOW,
  });
  writeQueueRecord(c, 'terminal-current', {
    status: 'quarantined',
    event: {
      site: 'astrologywiki',
      runId: 'run-1',
      pageId: 'PG-CELEB-060',
      slug: 'terminal-stop',
      createdAt: IN_WINDOW,
    },
    updatedAt: IN_WINDOW,
  });
  writeQueueRecord(c, 'legacy-terminal-current', {
    status: 'archived',
    event: {
      site: 'astrologywiki',
      pageId: 'PG-CELEB-061',
      slug: 'legacy-terminal',
      createdAt: IN_WINDOW,
    },
    updatedAt: IN_WINDOW,
  });
  writeQueueRecord(c, 'legacy-terminal-out-of-plan', {
    status: 'archived',
    event: {
      site: 'astrologywiki',
      pageId: 'PG-CELEB-062',
      slug: 'slug-b',
      createdAt: IN_WINDOW,
    },
    updatedAt: IN_WINDOW,
  });

  const r = run([
    '--since', SINCE,
    '--date', DATE,
    '--site', 'astrologywiki',
    '--plan', c.plan,
    '--run-id', 'run-1',
    '--dry-run',
  ], c);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /\[astrologywiki\] astro-only/);
  assert.match(r.stdout, /PG-CELEB-060/);
  assert.match(r.stdout, /PG-CELEB-061/);
  assert.doesNotMatch(r.stdout, /slug-b/);
  assert.doesNotMatch(r.stdout, /geng-ok/);
  assert.doesNotMatch(r.stdout, /PG-CELEB-059/);
  assert.doesNotMatch(r.stdout, /PG-CELEB-062/);
  assert.doesNotMatch(r.stdout, /PG-OTHER-777|other-plan/);
});

test('legacy terminal uses matching terminal history time before stale updatedAt', () => {
  const c = freshCase({});
  writeFileSync(c.plan, '- [ ] `PG-LEGACY-061` legacy terminal\n');
  writeQueueRecord(c, 'legacy-terminal-history', {
    status: 'archived',
    event: {
      site: 'astrologywiki',
      pageId: 'PG-LEGACY-061',
      slug: 'legacy-terminal',
      createdAt: OLD,
    },
    updatedAt: OLD,
    history: [
      { status: 'queued', at: OLD },
      { status: 'archived', at: IN_WINDOW },
    ],
  });

  const r = run([
    '--since', SINCE,
    '--site', 'astrologywiki',
    '--plan', c.plan,
    '--run-id', 'run-1',
    '--dry-run',
  ], c);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /PG-LEGACY-061（archived）/);
});

test('final notification reuses deterministic batch-terminal run UUID across repeated finalizer ticks', () => {
  const c = freshCase({
    'PG-A-001': { site: 'astrologywiki', status: 'done', slug: 'slug-a', mergedAt: IN_WINDOW },
  });
  const args = [
    '--since', SINCE,
    '--date', DATE,
    '--site', 'astrologywiki',
    '--plan', c.plan,
    '--run-id', 'run-1',
  ];
  const first = run(args, c);
  const second = run(args, c);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const calls = notifyCalls(c);
  assert.equal(calls.length, 2);
  const uuidAt = calls.map((call) => call.argv[call.argv.indexOf('--msgUuid') + 1]);
  assert.deepEqual(uuidAt, [
    terminalMessageUuid('batch-terminal:run-1'),
    terminalMessageUuid('batch-terminal:run-1'),
  ]);
});

test('cleanup', () => {
  try { serverChild.kill('SIGKILL'); } catch { /* already gone */ }
  rmSync(ROOT, { recursive: true, force: true });
});
