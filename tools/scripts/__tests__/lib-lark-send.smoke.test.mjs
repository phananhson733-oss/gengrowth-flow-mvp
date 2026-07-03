#!/usr/bin/env node
// Hermetic smoke tests for lib/lark-send.mjs（fail-closed 传输层）。
//
// 全部离线：本地 http mock 顶替飞书 API（GG_LARK_API_BASE 指过去）、假 HERMES_ENV 凭据文件、
// GG_FLOW_STATE_DIR / GG_LARK_AUDIT_LOG 指向 pid 级临时沙箱。绝不碰真网络／真飞书／真 audit log。
// lark-send 的所有 env 都是调用时懒读的，因此可以在测试内逐 case 改 env 后直接调库函数。
//
// Run: node --test tools/scripts/__tests__/lib-lark-send.smoke.test.mjs

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

import { sendLark, replayOutbox, PM_OPEN_ID, OPS_OPEN_ID } from '../lib/lark-send.mjs';
import { outboxWrite, outboxList, heartbeat } from '../lib/flow-state.mjs';

const ROOT = join(tmpdir(), `lib-lark-send-test-${process.pid}`);
mkdirSync(ROOT, { recursive: true });

// —— 本地飞书 mock：token 端点 + 消息端点，行为可按 case 切换，全部请求留痕 ——
const mock = { tokenOk: true, msgCode: 0, requests: [] };
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
      mock.requests.push({ url: req.url, body, auth: req.headers.authorization || '' });
      if (mock.probe) {
        try {
          mock.probe(req.url);
        } catch {}
      }
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        res.end(
          JSON.stringify(
            mock.tokenOk
              ? { code: 0, tenant_access_token: 't-test-token' }
              : { code: 99991661, msg: 'token fail' },
          ),
        );
        return;
      }
      if (req.url.startsWith('/open-apis/im/v1/messages')) {
        res.end(
          JSON.stringify(
            mock.msgCode === 0
              ? { code: 0, msg: 'success', data: { message_id: 'om_test_1' } }
              : { code: mock.msgCode, msg: 'send fail' },
          ),
        );
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(ROOT, { recursive: true, force: true });
});

function msgRequests() {
  return mock.requests.filter((q) => q.url.startsWith('/open-apis/im/v1/messages'));
}

// 每个 case 独立沙箱：假凭据 + 独立 state dir + 独立 audit log；重试参数调小提速。
function caseEnv(name, { creds = true } = {}) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  const hermes = join(dir, 'hermes.env');
  if (creds) writeFileSync(hermes, 'FEISHU_APP_ID=cli_test\nFEISHU_APP_SECRET=sec_test\n');
  process.env.HERMES_ENV = hermes; // creds=false 时指向不存在的文件 → no-creds 路径
  process.env.GG_LARK_API_BASE = baseUrl;
  process.env.GG_FLOW_STATE_DIR = join(dir, 'state');
  process.env.GG_LARK_AUDIT_LOG = join(dir, 'audit.log');
  process.env.GG_LARK_SEND_RETRIES = '2';
  process.env.GG_LARK_RETRY_BASE_MS = '1';
  process.env.GG_LARK_NOTIFY_CHAT_ID = 'oc_test_chat';
  delete process.env.GG_LARK_NOTIFY_SILENCE;
  delete process.env.GG_LARK_STALE_CLAIM_MS;
  mock.requests.length = 0;
  mock.probe = null;
  return dir;
}

function audit() {
  const f = process.env.GG_LARK_AUDIT_LOG;
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
}

function outboxFiles(dir) {
  const d = join(dir, 'state', 'notify-outbox');
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')) : [];
}

// 含 `.sending`（write-ahead／已认领）在内的全部 outbox 文件。
function allOutboxFiles(dir) {
  const d = join(dir, 'state', 'notify-outbox');
  return existsSync(d) ? readdirSync(d) : [];
}

// ── (a) 成功路径：code=0 + message_id → SENT，@ 前缀拼装正确，不入 outbox ──
test('code=0 且有 message_id → ok:true + audit SENT + outbox 为空', async () => {
  const dir = caseEnv('ok');
  mock.tokenOk = true;
  mock.msgCode = 0;
  const r = await sendLark('你好，发送成功样例', { atPm: true });
  assert.equal(r.ok, true);
  assert.equal(r.messageId, 'om_test_1');
  assert.equal(r.error, null);
  const reqs = msgRequests();
  assert.equal(reqs.length, 1, '成功时只应发一次');
  assert.equal(reqs[0].body.receive_id, 'oc_test_chat');
  assert.equal(reqs[0].auth, 'Bearer t-test-token');
  const content = JSON.parse(reqs[0].body.content);
  assert.equal(content.text, `<at user_id="${PM_OPEN_ID}"></at> 你好，发送成功样例`);
  assert.match(audit(), /\tchat=oc_test_chat\tSENT\t/);
  assert.equal(outboxFiles(dir).length, 0, '成功不得入 outbox');
});

// ── (b) code!=0 → 重试（默认 1+2=3 次）后入 outbox + SEND_FAILED ──
test('code!=0 → 指数退避重试 3 次后入 outbox + audit SEND_FAILED code=X', async () => {
  const dir = caseEnv('fail');
  mock.tokenOk = true;
  mock.msgCode = 99991663;
  const r = await sendLark('发送失败样例', { atOps: true });
  assert.equal(r.ok, false);
  assert.equal(r.messageId, null);
  assert.equal(r.error, '99991663');
  assert.equal(msgRequests().length, 3, '总尝试 = 1 + GG_LARK_SEND_RETRIES(2)');
  const files = outboxFiles(dir);
  assert.equal(files.length, 1, '最终失败必须入 outbox');
  const payload = JSON.parse(readFileSync(join(dir, 'state', 'notify-outbox', files[0]), 'utf8'));
  assert.equal(payload.text, '发送失败样例');
  assert.equal(payload.atPm, false);
  assert.equal(payload.atOps, true);
  assert.equal(payload.chatId, 'oc_test_chat');
  assert.equal(payload.attempts, 0);
  assert.equal(payload.lastError, '99991663');
  assert.ok(payload.createdAt, 'payload 应带 createdAt');
  assert.match(audit(), /\tSEND_FAILED code=99991663\t/);
});

// ── (c) 凭据缺失 → no-creds，直接入 outbox，一个请求都不发 ──
test('HERMES_ENV 缺失 → {ok:false,error:no-creds} + 入 outbox + 零请求', async () => {
  const dir = caseEnv('nocreds', { creds: false });
  const r = await sendLark('无凭据样例');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no-creds');
  assert.equal(mock.requests.length, 0, '没有凭据绝不打 API');
  assert.equal(outboxFiles(dir).length, 1);
  assert.match(audit(), /\tSEND_FAILED code=no-creds\t/);
});

// ── (d) replayOutbox：恢复后清箱 + OUTBOX_REPLAYED；@ 前缀按 payload flags 重建 ──
test('replayOutbox：先失败入箱，恢复后重放成功 → 清箱 + audit OUTBOX_REPLAYED', async () => {
  const dir = caseEnv('replay');
  mock.tokenOk = true;
  mock.msgCode = 500; // 先制造一条失败入箱
  await sendLark('重放样例', { atPm: true, atOps: true });
  assert.equal(outboxFiles(dir).length, 1);
  mock.msgCode = 0; // API 恢复
  mock.requests.length = 0;
  const r = await replayOutbox();
  assert.equal(r.replayed, 1);
  assert.equal(r.remaining, 0);
  assert.equal(outboxFiles(dir).length, 0, '重放成功必须清箱');
  const reqs = msgRequests();
  assert.equal(reqs.length, 1);
  const content = JSON.parse(reqs[0].body.content);
  assert.equal(
    content.text,
    `<at user_id="${PM_OPEN_ID}"></at> <at user_id="${OPS_OPEN_ID}"></at> 重放样例`,
    '重放要按 payload 的 atPm/atOps 重建 @ 前缀',
  );
  assert.match(audit(), /\tOUTBOX_REPLAYED\t/);
});

// ── (e) replayOutbox 失败：留箱 + attempts+1（_noOutbox 防递归，不新增记录） ──
test('replayOutbox 仍失败 → 留箱、attempts+1、不递归新增 outbox 记录', async () => {
  const dir = caseEnv('replay-fail');
  const name = outboxWrite({ text: '仍失败样例', atPm: false, atOps: false, chatId: 'oc_test_chat' });
  assert.ok(name, '前置：入箱成功');
  mock.tokenOk = true;
  mock.msgCode = 500;
  const r = await replayOutbox();
  assert.equal(r.replayed, 0);
  assert.equal(r.remaining, 1);
  const files = outboxFiles(dir);
  assert.equal(files.length, 1, '失败必须留箱且不得递归翻倍');
  const payload = JSON.parse(readFileSync(join(dir, 'state', 'notify-outbox', files[0]), 'utf8'));
  assert.equal(payload.attempts, 1, '重放失败 attempts+1');
  assert.equal(payload.lastError, '500');
});

// ── (f) 永不 throw：API base 指向打不通的端口也只返回 ok:false ──
test('API 完全不可达 → 不 throw，ok:false 且入 outbox', async () => {
  const dir = caseEnv('unreachable');
  process.env.GG_LARK_API_BASE = 'http://127.0.0.1:9'; // discard 端口，必然拒连
  process.env.GG_LARK_SEND_RETRIES = '0';
  const r = await sendLark('不可达样例');
  assert.equal(r.ok, false);
  assert.ok(r.error, '要有失败原因');
  assert.equal(outboxFiles(dir).length, 1);
});

// ── (g) flow-state 附带件：heartbeat touch + outboxList 排序可见 ──
test('flow-state：heartbeat 落盘、outboxWrite 后 outboxList 可见', () => {
  caseEnv('state');
  assert.equal(heartbeat('seo-author'), true);
  assert.ok(
    existsSync(join(process.env.GG_FLOW_STATE_DIR, 'heartbeats', 'seo-author')),
    'heartbeats/<lane> 应被 touch',
  );
  const n1 = outboxWrite({ text: 'a' });
  const n2 = outboxWrite({ text: 'b' });
  const list = outboxList();
  assert.deepEqual(list, [n1, n2].sort(), 'outboxList 返回全部记录且有序');
});

// ── (h) write-ahead：第一次网络尝试前 outbox 已有 .sending（SIGTERM 中途被杀不丢消息）──
test('write-ahead：token 请求时 .sending 已落盘；成功后 outbox（含 .sending）彻底清空', async () => {
  const dir = caseEnv('write-ahead');
  mock.tokenOk = true;
  mock.msgCode = 0;
  let sendingSeenAtToken = false;
  mock.probe = (url) => {
    if (url.startsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      sendingSeenAtToken = allOutboxFiles(dir).some((f) => f.endsWith('.json.sending'));
    }
  };
  const r = await sendLark('write-ahead 样例');
  assert.equal(r.ok, true);
  assert.equal(sendingSeenAtToken, true, '第一次网络尝试（取 token）时 write-ahead 记录必须已在盘上');
  assert.deepEqual(allOutboxFiles(dir), [], '成功后 .json 与 .sending 都不得残留');
});

// ── (i) 并发重放：两个 replayOutbox 抢同一条 → 只发一次（rename 认领去重）──
test('并发 replayOutbox：同一条只有一个赢家，恰好发送 1 次且清箱', async () => {
  const dir = caseEnv('concurrent-replay');
  mock.tokenOk = true;
  mock.msgCode = 0;
  const name = outboxWrite({ text: '并发重放样例', atPm: false, atOps: false, chatId: 'oc_test_chat' });
  assert.ok(name);
  const [r1, r2] = await Promise.all([replayOutbox(), replayOutbox()]);
  assert.equal(r1.replayed + r2.replayed, 1, '两个并发重放合计只能成功重放 1 条');
  assert.equal(msgRequests().length, 1, '消息 API 只能被打 1 次——绝不重复发送');
  assert.deepEqual(allOutboxFiles(dir), [], '重放完成后清箱');
});

// ── (k) 空文本：拒发、不入箱、audit SEND_FAILED code=empty-text ──
test('空文本 → 不打 API、不入 outbox（毒条目防线）', async () => {
  const dir = caseEnv('empty-text');
  const r = await sendLark('   ');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'empty-text');
  assert.equal(mock.requests.length, 0);
  assert.deepEqual(allOutboxFiles(dir), []);
  assert.match(audit(), /\tSEND_FAILED code=empty-text\t/);
});

// ── (l) uuid 幂等键：同一逻辑消息的全部重试共用一个 uuid；重放复用入箱时的 uuid ──
test('重试与重放全程共用同一 uuid（飞书侧去重，消灭重复投递窗口）', async () => {
  const dir = caseEnv('uuid');
  mock.tokenOk = true;
  mock.msgCode = 500; // 3 次尝试全失败 → 入箱
  await sendLark('uuid 样例');
  const tries = msgRequests();
  assert.equal(tries.length, 3);
  const uuids = new Set(tries.map((q) => q.body.uuid));
  assert.equal(uuids.size, 1, '同一逻辑消息的全部重试必须共用一个 uuid');
  const firstUuid = [...uuids][0];
  assert.ok(firstUuid, '消息体必须带 uuid 幂等键');
  const files = outboxFiles(dir);
  const payload = JSON.parse(readFileSync(join(dir, 'state', 'notify-outbox', files[0]), 'utf8'));
  assert.equal(payload.msgUuid, firstUuid, '入箱 payload 必须存下 uuid 供重放复用');
  mock.msgCode = 0;
  mock.requests.length = 0;
  await replayOutbox();
  assert.equal(msgRequests()[0].body.uuid, firstUuid, '重放必须复用入箱时的 uuid');
});

// ── (m) outbox 卫生：超龄条目与 attempts 超上限条目被丢弃（留 audit，不再空转） ──
test('超龄（TTL）与 attempts 超上限的 outbox 条目被丢弃 + audit 留痕', async () => {
  const dir = caseEnv('hygiene');
  mock.tokenOk = true;
  mock.msgCode = 0;
  const d = join(dir, 'state', 'notify-outbox');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, '1-1-0.json'), JSON.stringify({
    text: '超龄样例', atPm: false, atOps: false, chatId: 'oc_test_chat',
    createdAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(), attempts: 1,
  }));
  writeFileSync(join(d, '2-1-0.json'), JSON.stringify({
    text: '尝试超限样例', atPm: false, atOps: false, chatId: 'oc_test_chat',
    createdAt: new Date().toISOString(), attempts: 20,
  }));
  writeFileSync(join(d, '3-1-0.json'), JSON.stringify({
    text: '', chatId: 'oc_test_chat', createdAt: new Date().toISOString(), attempts: 0,
  }));
  const r = await replayOutbox();
  assert.equal(r.dropped, 3, '超龄 + 超限 + 空文本 全部丢弃');
  assert.equal(r.replayed, 0);
  assert.equal(msgRequests().length, 0, '被淘汰的条目绝不打 API');
  assert.deepEqual(allOutboxFiles(dir), [], '淘汰后清箱');
  const log = audit();
  assert.match(log, /\tOUTBOX_EXPIRED\t.*超龄样例/);
  assert.match(log, /\tOUTBOX_DROPPED code=attempts\t.*尝试超限样例/);
  assert.match(log, /\tOUTBOX_DROPPED code=invalid\t/);
});

// ── (j) 陈旧 .sending 回收：被杀进程的残留会被重放捡回；新鲜 .sending 不动 ──
test('陈旧 .sending 回收补发；新鲜 .sending（发送中）不被碰', async () => {
  const dir = caseEnv('stale-reclaim');
  mock.tokenOk = true;
  mock.msgCode = 0;
  const d = join(dir, 'state', 'notify-outbox');
  mkdirSync(d, { recursive: true });
  // 陈旧残留：mtime 拨回 1 小时前（> 阈值 1ms 会立刻回收；这里用默认 10min 阈值也超龄）
  const stale = join(d, '1000000000000-1-0.json.sending');
  writeFileSync(stale, JSON.stringify({ text: '被杀进程残留样例', atPm: false, atOps: false, chatId: 'oc_test_chat' }));
  const old = new Date(Date.now() - 3600_000);
  utimesSync(stale, old, old);
  // 新鲜认领：另一个进程正在发送中，绝不能被抢
  writeFileSync(join(d, `${Date.now()}-2-0.json.sending`), JSON.stringify({ text: '发送中样例' }));
  const r = await replayOutbox();
  assert.equal(r.reclaimed, 1, '只回收超龄的 .sending');
  assert.equal(r.replayed, 1, '回收后的记录应被补发');
  const reqs = msgRequests();
  assert.equal(reqs.length, 1);
  assert.match(JSON.parse(reqs[0].body.content).text, /被杀进程残留样例/);
  const left = allOutboxFiles(dir);
  assert.equal(left.length, 1, '新鲜 .sending 必须原样留下');
  assert.ok(left[0].endsWith('.json.sending'));
});
