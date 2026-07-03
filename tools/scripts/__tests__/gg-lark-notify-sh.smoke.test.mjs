#!/usr/bin/env node
// Hermetic smoke tests for gg-lark-notify.sh（back-compat 壳）。
//
// 黑盒方式跑真实的 shell 脚本，但一切外设都是假的：
//   · 飞书 API = 本地 http mock（GG_LARK_API_BASE）；
//   · 凭据 = 临时 HERMES_ENV 文件；state/audit = 临时目录；
//   · claude = PATH 最前面的假二进制（sentinel 记录是否被调过）——绝不碰真 claude。
// 子进程 env 从零构造（不继承宿主 env），保证宿主残留 flags 不会污染断言。
// 注意用异步 spawn 而非 spawnSync：mock http server 跑在本测试进程的事件循环里，
// spawnSync 会阻塞事件循环导致子进程的请求永远得不到响应。
//
// Run: node --test tools/scripts/__tests__/gg-lark-notify-sh.smoke.test.mjs

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../gg-lark-notify.sh', import.meta.url));
const ROOT = join(tmpdir(), `gg-lark-notify-sh-test-${process.pid}`);
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

let caseSeq = 0;
// 每个 case：独立 HOME 沙箱 + 假 claude bin（sentinel 记录调用）+ 从零构造的 env。
function freshCase({ claudeStdout } = {}) {
  const dir = join(ROOT, `case-${caseSeq++}`);
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const sentinel = join(dir, 'claude-invoked');
  // 假 claude：吃掉 stdin，touch sentinel，输出固定文本。放 PATH 最前面（脚本对
  // /opt/homebrew/bin 等只做 append），保证即使宿主机有真 claude 也轮不到它。
  const fakeClaude = join(bin, 'claude');
  writeFileSync(
    fakeClaude,
    `#!/bin/sh\ncat > /dev/null 2>&1 || true\nprintf '%s\\n' "$*" >> ${JSON.stringify(sentinel)}\nprintf '%s' ${JSON.stringify(claudeStdout || 'Error: quota exceeded, please login to continue')}\nexit 0\n`,
  );
  chmodSync(fakeClaude, 0o755);
  const hermes = join(dir, 'hermes.env');
  writeFileSync(hermes, 'FEISHU_APP_ID=cli_test\nFEISHU_APP_SECRET=sec_test\n');
  const audit = join(dir, 'audit.log');
  const env = {
    // 从零构造：假 bin 最前，node 的目录其次，最后系统工具（grep/dirname/printf）。
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: dir, // 沙箱 HOME：脚本 append 的 ~/.local/bin 等落在空目录里
    HERMES_ENV: hermes,
    GG_LARK_API_BASE: baseUrl,
    GG_FLOW_STATE_DIR: join(dir, 'state'),
    GG_LARK_AUDIT_LOG: audit,
    GG_LARK_SEND_RETRIES: '0',
    GG_LARK_RETRY_BASE_MS: '1',
    GG_LARK_NOTIFY_CHAT_ID: 'oc_test_chat',
  };
  mock.requests.length = 0;
  return { dir, env, sentinel, audit };
}

function runSh(msg, env) {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', [SCRIPT, msg], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function sentTexts() {
  return mock.requests
    .filter((q) => q.url.startsWith('/open-apis/im/v1/messages'))
    .map((q) => JSON.parse(q.body.content).text);
}

// ── (a) 默认（无 TRANSLATE）：英文消息也绝不调 claude，原文直发，exit 0 ──
test('默认不调 claude：含英文句子的消息原样发出，假 claude 未被触发', async () => {
  const { env, sentinel } = freshCase();
  const msg = 'gate failed because preview verify timed out on branch seo/auto/x';
  const r = await runSh(msg, env);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.ok(!existsSync(sentinel), '翻译默认关闭，claude 绝不该被调用');
  assert.deepEqual(sentTexts(), [msg], '消息应原样发出（无 @ 前缀、未翻译）');
});

// ── (b) AT_PM env → @王志彪 出现在正文前（AT_OPS 同理；SILENCE 未设 → 真发） ──
test('GG_LARK_NOTIFY_AT_PM=1 → 发出的文本带 @PM 前缀', async () => {
  const { env } = freshCase();
  env.GG_LARK_NOTIFY_AT_PM = '1';
  const r = await runSh('需要人工处理的告警', env);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const texts = sentTexts();
  assert.equal(texts.length, 1);
  assert.equal(texts[0], '<at user_id="ou_3ce0dce02872c344a4e244a1837ebced"></at> 需要人工处理的告警');
});

test('GG_LARK_NOTIFY_AT_OPERATOR=1（历史别名）+ AT_OPS=1 → @PM 与 @OPS 都出现', async () => {
  const { env } = freshCase();
  env.GG_LARK_NOTIFY_AT_OPERATOR = '1';
  env.GG_LARK_NOTIFY_AT_OPS = '1';
  const r = await runSh('双 @ 告警', env);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const texts = sentTexts();
  assert.equal(texts.length, 1);
  assert.equal(
    texts[0],
    '<at user_id="ou_3ce0dce02872c344a4e244a1837ebced"></at> <at user_id="ou_96d93c73b1bf79deae92ef94e58b37f6"></at> 双 @ 告警',
  );
});

// ── (c) TRANSLATE=1 + 坏输出（含 quota）→ 确定性校验拒绝 → 回退原文 ──
test('TRANSLATE=1 且 claude 输出含 quota → 回退原文（claude 确实被调过）', async () => {
  const { env, sentinel } = freshCase({
    claudeStdout: 'Error: quota exceeded, please login to continue',
  });
  env.GG_LARK_NOTIFY_TRANSLATE = '1';
  const msg = 'gate failed because preview verify timed out on branch seo/auto/x';
  const r = await runSh(msg, env);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.ok(existsSync(sentinel), 'TRANSLATE=1 时 claude 应被调用');
  assert.deepEqual(sentTexts(), [msg], '坏输出必须回退原文');
});

test('TRANSLATE=1 且 claude 输出通过校验（中文、长度合理）→ 采用译文', async () => {
  const { env, sentinel } = freshCase({
    claudeStdout: '发布 gate 未过：preview verify 在分支 seo/auto/x 上超时',
  });
  env.GG_LARK_NOTIFY_TRANSLATE = '1';
  const msg = 'gate failed because preview verify timed out on branch seo/auto/x';
  const r = await runSh(msg, env);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.ok(existsSync(sentinel), 'claude 应被调用');
  assert.deepEqual(sentTexts(), ['发布 gate 未过：preview verify 在分支 seo/auto/x 上超时']);
});

test('TRANSLATE=1 但 NO_TRANSLATE=1（否决旗）→ 不调 claude', async () => {
  const { env, sentinel } = freshCase();
  env.GG_LARK_NOTIFY_TRANSLATE = '1';
  env.GG_LARK_NOTIFY_NO_TRANSLATE = '1';
  const msg = 'gate failed because preview verify timed out here';
  const r = await runSh(msg, env);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.ok(!existsSync(sentinel), 'NO_TRANSLATE 否决 TRANSLATE');
  assert.deepEqual(sentTexts(), [msg]);
});

// ── (d) SILENCE 语义透传：只 audit 不发送 ──
test('GG_LARK_NOTIFY_SILENCE=1 → 不打 API，audit 记 SILENCED，exit 0', async () => {
  const { env, audit } = freshCase();
  env.GG_LARK_NOTIFY_SILENCE = '1';
  const r = await runSh('静默批次的逐篇通知', env);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(mock.requests.length, 0, 'SILENCE 下 mock 不得收到任何请求');
  assert.match(readFileSync(audit, 'utf8'), /\tSILENCED\t.*静默批次的逐篇通知/);
});

// ── (e) 空消息 → 直接 no-op，exit 0 ──
test('空消息 → exit 0 且零请求', async () => {
  const { env } = freshCase();
  const r = await runSh('', env);
  assert.equal(r.status, 0);
  assert.equal(mock.requests.length, 0);
});

// ── (f) 凭据缺失 → 仍 exit 0（fail-closed 入 outbox，不搞垮调用方） ──
test('HERMES_ENV 指向不存在的文件 → exit 0 + 入 outbox', async () => {
  const { env, dir } = freshCase();
  env.HERMES_ENV = join(env.HOME, 'no-such.env');
  const r = await runSh('无凭据也不能炸调用方', env);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(mock.requests.length, 0);
  const outbox = join(env.GG_FLOW_STATE_DIR, 'notify-outbox');
  assert.ok(existsSync(outbox) && readdirSync(outbox).length === 1, '失败必须入 outbox 待重放');
});
