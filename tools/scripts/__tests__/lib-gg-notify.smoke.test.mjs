#!/usr/bin/env node
// Hermetic smoke tests for lib/gg-notify.mjs（事件层：模板 + @ 策略 + SILENCE）。
//
// renderTemplate 部分是纯函数断言（逐事件对齐 NOTIFY-CONTRACT.md 的模板文案与 @ 策略）；
// notify 部分打本地 http mock（GG_LARK_API_BASE），绝不碰真网络／真飞书。
//
// Run: node --test tools/scripts/__tests__/lib-gg-notify.smoke.test.mjs

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

import { renderTemplate, notify, EVENTS } from '../lib/gg-notify.mjs';
import { PM_OPEN_ID, OPS_OPEN_ID } from '../lib/lark-send.mjs';

const ROOT = join(tmpdir(), `lib-gg-notify-test-${process.pid}`);
mkdirSync(ROOT, { recursive: true });

const mock = { requests: [] };
let server;
let baseUrl;

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {}
      mock.requests.push({ url: req.url, body });
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        res.end(JSON.stringify({ code: 0, tenant_access_token: 't-test' }));
        return;
      }
      res.end(JSON.stringify({ code: 0, data: { message_id: 'om_test' } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(ROOT, { recursive: true, force: true });
});

function caseEnv(name) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  const hermes = join(dir, 'hermes.env');
  writeFileSync(hermes, 'FEISHU_APP_ID=cli_test\nFEISHU_APP_SECRET=sec_test\n');
  process.env.HERMES_ENV = hermes;
  process.env.GG_LARK_API_BASE = baseUrl;
  process.env.GG_FLOW_STATE_DIR = join(dir, 'state');
  process.env.GG_LARK_AUDIT_LOG = join(dir, 'audit.log');
  process.env.GG_LARK_SEND_RETRIES = '0';
  process.env.GG_LARK_RETRY_BASE_MS = '1';
  process.env.GG_LARK_NOTIFY_CHAT_ID = 'oc_test_chat';
  // 事件层 env 语义要从干净状态出发（宿主 shell 可能残留）。
  delete process.env.GG_LARK_NOTIFY_SILENCE;
  delete process.env.GG_LARK_NOTIFY_AT_PM;
  delete process.env.GG_LARK_NOTIFY_AT_OPERATOR;
  delete process.env.GG_LARK_NOTIFY_AT_OPS;
  mock.requests.length = 0;
  return dir;
}

function sentTexts() {
  return mock.requests
    .filter((q) => q.url.startsWith('/open-apis/im/v1/messages'))
    .map((q) => JSON.parse(q.body.content).text);
}

function sentMessageRequests() {
  return mock.requests.filter((q) => q.url.startsWith('/open-apis/im/v1/messages'));
}

// ── (a) 事件表全量：模板文案（全角标点逐字对齐契约）+ @ 策略 ──
// 每行：[event, fields, 期望文本, 期望 atPm, 期望 atOps]
const CASES = [
  [
    'published',
    { site: 'astrologywiki', title: '土星回归指南', url: 'https://w.example/x', extra: '作者 Nova，已登记到 ops' },
    '✅ [astrologywiki] 已发布上线：土星回归指南\nhttps://w.example/x\n（作者 Nova，已登记到 ops）',
    false,
    false,
  ],
  [
    'published',
    { site: 'gengrowth', title: 'T', url: 'https://w.example/y' },
    '✅ [gengrowth] 已发布上线：T\nhttps://w.example/y',
    false,
    false,
  ],
  [
    'authored',
    { site: 'astrologywiki', detail: 'PG-001（saturn-return）— 立即发布中' },
    '✍️ [astrologywiki] 写好一篇：PG-001（saturn-return）— 立即发布中',
    false,
    false,
  ],
  [
    'parked',
    { site: 'astrologywiki', pid: 'PG-001', slug: 'saturn-return', reason: 'zh 门未过' },
    '⚠️ [astrologywiki] 暂停待人工（needs_human）：PG-001（saturn-return）— zh 门未过',
    true,
    true,
  ],
  [
    'park_rollup',
    { site: 'astrologywiki', count: 3, rest: 'PG-2（原因A）、PG-3（原因B）' },
    '⚠️ [astrologywiki] 本轮共暂停 3 篇（needs_human）。首篇已单独通报，其余合并：\nPG-2（原因A）、PG-3（原因B）',
    true,
    true,
  ],
  [
    'gate_fail',
    { site: 'astrologywiki', slug: 'saturn-return', branch: 'seo/auto/x', reason: 'links-seo FAIL' },
    '⚠️ [astrologywiki] 发布 gate 未过：saturn-return（seo/auto/x）：links-seo FAIL — PR 待人工',
    true,
    true,
  ],
  [
    'fact_gate_fail',
    { site: 'gengrowth', pid: 'EOS-004', slug: 'foo', reason: 'codex FAIL' },
    '⚠️ [gengrowth] 事实门未过（needs_human）：EOS-004（foo）— codex FAIL。已跳过发布，待人工核对。',
    true,
    true,
  ],
  [
    'publish_fail',
    { site: 'gengrowth', pid: 'EOS-004', slug: 'foo', msg: 'HTTP 500' },
    '⚠️ [gengrowth] 发布失败：EOS-004（foo）— HTTP 500',
    false,
    true,
  ],
  [
    'ticker_error',
    { site: 'gengrowth', msg: 'boom' },
    '⚠️ [gengrowth] 发布 ticker 异常：boom',
    false,
    true,
  ],
  [
    'preflight_fail',
    { lane: 'seo-autopilot', log: '/tmp/x.log' },
    '⚠️ [flow] seo-autopilot preflight 失败（env 异常，见 /tmp/x.log），本轮跳过。',
    false,
    true,
  ],
  [
    'lane_timeout',
    { lane: 'seo-author', seconds: 3600 },
    '⚠️ [flow] seo-author 撰写超 3600s 被硬杀，本轮放弃（草稿可能半成品，未上报）。',
    false,
    true,
  ],
  [
    'lane_stale',
    { lane: 'seo-author', hours: 6 },
    '⚠️ [flow] seo-author 已 6 小时未运行（launchd 可能未加载或被禁用）。',
    false,
    true,
  ],
  [
    'auth_missing',
    { site: 'gengrowth', what: 'SB_KEY', hint: 'supabase login' },
    '⚠️ [gengrowth] 凭据缺失：SB_KEY，本轮跳过。恢复：supabase login',
    false,
    true,
  ],
  [
    'day_complete',
    { site: 'astrologywiki', date: '2026-07-03', publishedTotal: 145 },
    '✅ [astrologywiki] 2026-07-03：本批计划内容已全部写完并上线（发布登记表累计 145 篇），队列已清空。',
    false,
    true,
  ],
  [
    'topic_registered',
    { site: 'gengrowth', label: 'W25 批次', filled: 5, clusters: 2, pageIds: 'EOS-008、ART-004' },
    '📋 [gengrowth] 选题登记自动补齐：W25 批次\n补齐 5 行；新增 cluster 2 个。\npage_id: EOS-008、ART-004',
    false,
    false,
  ],
  [
    'index_diagnosis',
    { site: 'astrologywiki', body: '诊断正文' },
    '🔍 [astrologywiki] 索引诊断报告\n诊断正文',
    true,
    true,
  ],
  [
    'index_queue',
    { site: 'astrologywiki', body: '队列正文' },
    '⚠️ [astrologywiki] Request Indexing 候选队列已更新：队列正文',
    true,
    true,
  ],
  [
    'index_resubmit_ok',
    { site: 'astrologywiki', count: 3, body: '重提正文' },
    '✅ [astrologywiki] 已重新提交修复 URL：3 条\n重提正文',
    true,
    true,
  ],
  [
    'index_sitemap_ok',
    { site: 'astrologywiki', url: 'https://w.example/sitemap.xml' },
    '✅ [astrologywiki] sitemap 已刷新：https://w.example/sitemap.xml',
    true,
    true,
  ],
  [
    'index_sitemap_fail',
    { site: 'astrologywiki', url: 'https://w.example/sitemap.xml', err: 'HTTP 500' },
    '⚠️ [astrologywiki] sitemap 刷新失败：https://w.example/sitemap.xml（HTTP 500）',
    true,
    true,
  ],
  [
    'index_tick_fail',
    { site: 'astrologywiki', rc: 2, log: '/tmp/im.log', hint: '修复重提' },
    '⚠️ [astrologywiki] 索引监控运行失败（rc=2）。请查看 /tmp/im.log。修复重提',
    false,
    true,
  ],
  [
    'index_tick_fail',
    { site: 'astrologywiki', rc: 2, log: '/tmp/im.log' },
    '⚠️ [astrologywiki] 索引监控运行失败（rc=2）。请查看 /tmp/im.log。',
    false,
    true,
  ],
  [
    'recap_performance_ok',
    {
      date: '2026-07-07',
      body: 'AstrologyWiki：rows=156 updated=156 tasks=155\nGenGrowth：rows=41 updated=41 tasks=41',
      log: '/tmp/recap.log',
      reports: '/tmp/astrology.md\n/tmp/gengrowth.md',
    },
    '✅ [flow] 结果复盘已同步（2026-07-07）\nAstrologyWiki：rows=156 updated=156 tasks=155\nGenGrowth：rows=41 updated=41 tasks=41\n报告：\n/tmp/astrology.md\n/tmp/gengrowth.md\n日志：/tmp/recap.log',
    false,
    false,
  ],
  ['raw', { text: '原样文本' }, '原样文本', false, false],
  ['batch_summary', { text: '✅ [flow] 批次汇总 2026-07-03：上线 2 篇（已逐篇线上核实）' }, '✅ [flow] 批次汇总 2026-07-03：上线 2 篇（已逐篇线上核实）', false, false],
  ['batch_summary', { text: '⚠️ [flow] 批次汇总 2026-07-03：1/2 篇已上线核实', partial: '1' }, '⚠️ [flow] 批次汇总 2026-07-03：1/2 篇已上线核实', false, true],
];

test('renderTemplate：全部事件的文案与 @ 策略逐条对齐契约', () => {
  caseEnv('render');
  for (const [event, fields, wantText, wantPm, wantOps] of CASES) {
    const r = renderTemplate(event, fields);
    assert.equal(r.text, wantText, `event=${event} 文案不符`);
    assert.equal(r.atPm, wantPm, `event=${event} atPm 不符`);
    assert.equal(r.atOps, wantOps, `event=${event} atOps 不符`);
  }
  // 事件表覆盖度自检：CASES 至少覆盖事件表里除 raw/batch_summary 变体外的全部 enum。
  const covered = new Set(CASES.map(([e]) => e));
  for (const e of Object.keys(EVENTS)) {
    assert.ok(covered.has(e), `事件 ${e} 缺少模板测试`);
  }
});

test('renderTemplate raw：@ 按 env flags（含 AT_OPERATOR 历史别名）', () => {
  caseEnv('raw-at');
  assert.deepEqual(renderTemplate('raw', { text: 'x' }), { text: 'x', atPm: false, atOps: false });
  process.env.GG_LARK_NOTIFY_AT_PM = '1';
  process.env.GG_LARK_NOTIFY_AT_OPS = '1';
  let r = renderTemplate('raw', { text: 'x' });
  assert.equal(r.atPm, true);
  assert.equal(r.atOps, true);
  delete process.env.GG_LARK_NOTIFY_AT_PM;
  process.env.GG_LARK_NOTIFY_AT_OPERATOR = '1'; // 历史别名 → 等价 AT_PM
  delete process.env.GG_LARK_NOTIFY_AT_OPS;
  r = renderTemplate('raw', { text: 'x' });
  assert.equal(r.atPm, true);
  assert.equal(r.atOps, false);
});

// ── (b) SILENCE：只写 audit（SILENCED）不发送（mock 一个请求都收不到） ──
test('GG_LARK_NOTIFY_SILENCE=1 → 只 audit SILENCED，不打 API', async () => {
  caseEnv('silence');
  process.env.GG_LARK_NOTIFY_SILENCE = '1';
  const r = await notify('parked', { site: 'astrologywiki', pid: 'PG-9', slug: 's', reason: 'r' });
  assert.equal(r.ok, true);
  assert.equal(r.silenced, true);
  assert.equal(r.messageId, null);
  assert.equal(mock.requests.length, 0, 'SILENCE 下 mock 不得收到任何请求');
  const log = readFileSync(process.env.GG_LARK_AUDIT_LOG, 'utf8');
  assert.match(log, /\tSILENCED\t/);
  // audit 文本要带上本应加的 @ 前缀，便于事后对账。
  assert.ok(log.includes(`<at user_id="${PM_OPEN_ID}"></at>`), 'SILENCED audit 要含 @PM 前缀');
  assert.ok(log.includes(`<at user_id="${OPS_OPEN_ID}"></at>`), 'SILENCED audit 要含 @OPS 前缀');
});

// ── (c) @ 前缀端到端：parked（PM+OPS）实际发出的文本要以两个 <at> 开头 ──
test('notify(parked) → 发出的文本前缀为 @PM @OPS，然后是模板正文', async () => {
  caseEnv('at-prefix');
  const r = await notify('parked', { site: 'astrologywiki', pid: 'PG-1', slug: 'foo', reason: '原因' });
  assert.equal(r.ok, true);
  const texts = sentTexts();
  assert.equal(texts.length, 1);
  assert.equal(
    texts[0],
    `<at user_id="${PM_OPEN_ID}"></at> <at user_id="${OPS_OPEN_ID}"></at> ⚠️ [astrologywiki] 暂停待人工（needs_human）：PG-1（foo）— 原因`,
  );
});

test('notify(recap_performance_ok) → 发送 Card 2.0 interactive 卡片', async () => {
  caseEnv('recap-card');
  const r = await notify('recap_performance_ok', {
    date: '2026-07-07',
    body: 'AstrologyWiki：rows=156 updated=156 tasks=155\nGenGrowth：rows=41 updated=41 tasks=41',
    reports: '/Users/awayer_mini/gengrowth-agents/reports/recap-performance/2026-07-07-astrologywiki-optimization-tasks.md\n/Users/awayer_mini/gengrowth-agents/reports/recap-performance/2026-07-07-gengrowth-optimization-tasks.md',
    log: '/Users/awayer_mini/gengrowth-agents/cron-sync/recap_performance/2026-07-07.log',
  });
  assert.equal(r.ok, true);
  const reqs = sentMessageRequests();
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].body.msg_type, 'interactive');
  const card = JSON.parse(reqs[0].body.content);
  assert.equal(card.schema, '2.0');
  assert.equal(card.header.template, 'green');
  assert.match(card.header.title.content, /结果复盘已同步/);
  assert.match(JSON.stringify(card), /AstrologyWiki/);
  assert.match(JSON.stringify(card), /updated=156/);
  assert.match(JSON.stringify(card), /未发布、未部署、未请求索引/);
});

// ── (d) 未知 event → 自描述兜底：event 名 + 全部字段序列化进正文，@OPS，绝不发空文本 ──
test('未知 event → 兜底文本携带 event 名与全部字段 + @OPS + audit WARN', async () => {
  caseEnv('unknown');
  const r = await notify('parkd', { pid: 'PG-X-9', reason: '拼错事件名样例' });
  assert.equal(r.ok, true);
  const texts = sentTexts();
  assert.equal(texts.length, 1);
  assert.match(texts[0], /未知通知事件（parkd）/, '正文必须点名打错的事件');
  assert.match(texts[0], /PG-X-9/, '结构化字段绝不能丢');
  assert.match(texts[0], /拼错事件名样例/);
  assert.match(texts[0], /<at user_id=/, '未知事件要 @OPS 让人看见拼写错误');
  const log = readFileSync(process.env.GG_LARK_AUDIT_LOG, 'utf8');
  assert.match(log, /\tWARN unknown-event\tevent=parkd/);
});

// ── (d2) 空文本（raw 无 text）→ 拒发 + 不入 outbox（毒条目防线） ──
test('raw 空文本 → 不发送、不入 outbox、audit WARN empty-text', async () => {
  const dir = caseEnv('empty-raw');
  const r = await notify('raw', {});
  assert.equal(r.ok, false);
  assert.equal(r.error, 'empty-text');
  assert.equal(sentTexts().length, 0, '空文本绝不打 API');
  const outbox = join(dir, 'state', 'notify-outbox');
  const files = existsSync(outbox) ? readdirSync(outbox) : [];
  assert.equal(files.length, 0, '空文本绝不入箱（会变成永远重放失败的毒条目）');
  const log = readFileSync(process.env.GG_LARK_AUDIT_LOG, 'utf8');
  assert.match(log, /\tWARN empty-text\t/);
});

// ── (d3) 静态接线断言：全部通知 lane 的 tick 开头都接了 replay-outbox（补发闭环） ──
test('replay-outbox 已接进全部通知 lane（fail-closed 补发闭环不悬空）', () => {
  const scripts = [
    'gg-seo-autopilot-tick.sh',
    'gg-seo-author-tick.sh',
    'gg-gengrowth-publish-tick.sh',
    'gg-index-monitor-tick.sh',
    'gg-nightly-seo.sh',
  ];
  for (const f of scripts) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(src, /replay-outbox/, `${f} 必须在 tick 开头重放 outbox，否则入箱消息永远没人补发`);
  }
});

// ── (e) notify 永不 throw（发送层失败也只返回 ok:false） ──
test('传输失败时 notify 不 throw，返回 ok:false', async () => {
  caseEnv('notify-fail');
  process.env.GG_LARK_API_BASE = 'http://127.0.0.1:9';
  const r = await notify('ticker_error', { site: 'gengrowth', msg: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.silenced, false);
  assert.ok(r.error);
});
