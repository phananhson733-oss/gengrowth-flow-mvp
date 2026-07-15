#!/usr/bin/env node
// Hermetic smoke tests: gg-gengrowth-publish.mjs / gg-gengrowth-publish-tick.sh 的
// 通知调用点迁移到统一事件层（阶段 1 · 通知统一，NOTIFY-CONTRACT.md「迁移映射」）。
//
// 黑盒风格（同 gg-preview-gate.smoke.test.mjs 的 fake-bin/sandbox 模式）：spawnSync 真跑
// gg-gengrowth-publish.mjs，全部外设走 env 覆盖——
//   · GG_LARK_API_BASE → 本地 mock 飞书（token + 消息端点，全请求留痕）；
//   · SB_URL → 同一 mock 的 /rest/v1/blog_posts 路由（liveStatus GET + bridge REST upsert）；
//   · GG_CODEX_BIN → 假 codex（打印 VERDICT: PASS / FAIL）；
//   · HERMES_ENV / GG_FLOW_STATE_DIR / GG_LARK_AUDIT_LOG / HOME → pid 级临时沙箱。
// 绝不碰真网络／真 claude／真 codex／真飞书。
//
// 断言的是契约模板的**逐字**文案 + @ 前缀（@ 由事件表决定，调用点不再散装 AT env）。
//
// Run: node --test tools/scripts/__tests__/gg-gengrowth-publish-notify.smoke.test.mjs

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { PM_OPEN_ID, OPS_OPEN_ID } from '../lib/lark-send.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(__dirname, '..');
const PUBLISHER = join(SCRIPTS, 'gg-gengrowth-publish.mjs');
const TICK_SH = join(SCRIPTS, 'gg-gengrowth-publish-tick.sh');

const ROOT = join(tmpdir(), `gg-gengrowth-publish-notify-test-${process.pid}`);
mkdirSync(ROOT, { recursive: true });

const AT_PM = `<at user_id="${PM_OPEN_ID}"></at> `;
const AT_OPS = `<at user_id="${OPS_OPEN_ID}"></at> `;

// —— 本地 mock：飞书（token + 消息）+ Supabase REST（blog_posts）。行为可按 case 切换 ——
const mock = {
  larkMsgs: [], // 每条 = 解析后的 content.text
  restPosts: [], // bridge 的 upsert 请求 url
  live: false, // GET blog_posts → live ? [{status:'published'}] : []
  upsert500: false, // POST blog_posts → 500（制造 bridge 失败 → publish_fail）
};
let server;
let baseUrl;

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        res.end(JSON.stringify({ code: 0, tenant_access_token: 't-test-token' }));
        return;
      }
      if (req.url.startsWith('/open-apis/im/v1/messages')) {
        try {
          mock.larkMsgs.push(JSON.parse(JSON.parse(raw).content).text);
        } catch {
          mock.larkMsgs.push(`<unparseable:${raw.slice(0, 80)}>`);
        }
        res.end(JSON.stringify({ code: 0, msg: 'success', data: { message_id: 'om_test_1' } }));
        return;
      }
      if (req.url.startsWith('/rest/v1/blog_posts')) {
        if (req.method === 'POST') {
          mock.restPosts.push(req.url);
          if (mock.upsert500) {
            res.statusCode = 500;
            res.end(JSON.stringify({ message: 'mock upsert failure' }));
            return;
          }
          mock.live = true; // upsert 成功 → 之后的 liveStatus GET 返回已发布
          res.end(JSON.stringify([{ slug: 'x', status: 'published' }]));
          return;
        }
        res.end(JSON.stringify(mock.live ? [{ status: 'published' }] : []));
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

// —— 沙箱 + fake bins ————————————————————————————————————————————————
function writeFakeCodex(dir, verdict) {
  const p = join(dir, `fake-codex-${verdict.toLowerCase()}.mjs`);
  writeFileSync(p, `process.stdout.write('VERDICT: ${verdict}\\n');\n`);
  return p;
}

function writeFakeCodexExit3(dir) {
  const p = join(dir, 'fake-codex-exit-3.mjs');
  writeFileSync(p, "process.stderr.write('provider stream reset: retryable reviewer failure\\n'); process.exit(3);\n");
  return p;
}

// 每个 case 独立沙箱：假凭据 + 独立 state/audit/HOME + 独立 staging 目录。
function caseEnv(name, { sbKey = 'sb-test-key' } = {}) {
  const dir = join(ROOT, name);
  const home = join(dir, 'home');
  const staging = join(dir, 'staging');
  mkdirSync(home, { recursive: true });
  mkdirSync(staging, { recursive: true });
  const hermes = join(dir, 'hermes.env');
  writeFileSync(hermes, 'FEISHU_APP_ID=cli_test\nFEISHU_APP_SECRET=sec_test\n');
  mock.larkMsgs.length = 0;
  mock.restPosts.length = 0;
  mock.live = false;
  mock.upsert500 = false;
  const env = {
    PATH: process.env.PATH,
    HOME: home, // archiveToVault 的 --oracle/$VAULT 全部落在沙箱 home 下，绝不写真 vault
    HERMES_ENV: hermes,
    GG_LARK_API_BASE: baseUrl,
    GG_FLOW_STATE_DIR: join(dir, 'state'),
    GG_LARK_AUDIT_LOG: join(dir, 'audit.log'),
    GG_LARK_SEND_RETRIES: '0',
    GG_LARK_RETRY_BASE_MS: '1',
    GG_LARK_NOTIFY_CHAT_ID: 'oc_test_chat',
    SB_URL: baseUrl,
    SB_KEY: sbKey,
    GG_GATE_REPAIR: '0', // 修复 worker 不在本测试范围（会喊 claude），关掉
    GG_CODEX_REVIEW_TIMEOUT_MS: '15000',
  };
  return { dir, home, staging, env };
}

// 一份能通过 bridge 解析的最小 ready 草稿（frontmatter slug/title + manifest overall=pass）。
function writeReadyDraft(staging, pageId, slug, title) {
  const md = join(staging, `${pageId}-claude-v8.md`);
  writeFileSync(
    md,
    `---\ntitle: ${title}\nslug: ${slug}\ndate: 2026-07-03\n---\n\n# ${title}\n\n这是用于黑盒测试的正文段落，覆盖发布桥的 markdown → HTML 转换。\n\n## 小节\n\n第二段正文，无外链无 TBD。\n`,
  );
  writeFileSync(md.replace(/\.md$/, '.manifest.json'), JSON.stringify({ phase2_checks: { overall: 'pass' } }));
  return md;
}

// 异步 runner（不是 spawnSync）：spawnSync 会阻塞本进程事件循环，进程内的 mock 飞书/REST
// server 将无法应答，子进程每次 fetch 都空等到超时——同 gg-seo-autopilot.smoke.test.mjs
// 的 runAutoAsync 教训。凡「进程内 mock server + 黑盒子进程」组合必须用异步 spawn。
function runAsync(bin, args, env, timeoutMs = 120000) {
  return new Promise((resolveP) => {
    const child = spawn(bin, args, { env });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => {
      clearTimeout(timer);
      resolveP({ status, stdout, stderr });
    });
  });
}

function runPublisher(args, env) {
  return runAsync('node', [PUBLISHER, ...args], env);
}

// ── (1) auth_missing（.mjs :252）：--apply 无 SB_KEY → 事件层 auth_missing，OPS 单独 @ ──
test('auth_missing: --apply 无 SB_KEY → 逐字模板 + OPS @ + exit 0', async () => {
  const { staging, env } = caseEnv('auth-missing', { sbKey: '' });
  const r = await runPublisher(['--apply', '--staging-dir', staging], env);
  assert.equal(r.status, 0, `fail-safe 必须 exit 0（stderr: ${r.stderr}）`);
  assert.match(r.stderr, /SB_KEY missing/);
  assert.deepEqual(mock.larkMsgs, [
    `${AT_OPS}⚠️ [gengrowth] 凭据缺失：SB_KEY，本轮跳过。恢复：supabase login`,
  ]);
});

// ── (2) fact_gate_fail（.mjs :299）：codex FAIL → 停发 + PM+OPS @（有意的 @ 策略变更）──
test('fact_gate_fail: codex FAIL → 逐字模板 + PM+OPS @，bridge 未被调用', async () => {
  const { dir, staging, env } = caseEnv('fact-gate-fail');
  writeReadyDraft(staging, 'PG-WLS-902', 'test-fact-gate-fail', '事实门测试文章');
  env.GG_CODEX_BIN = writeFakeCodex(dir, 'FAIL');
  const r = await runPublisher(['--apply', '--staging-dir', staging], env);
  assert.equal(r.status, 0, `park 不是失败，exit 0（stdout: ${r.stdout}\nstderr: ${r.stderr}）`);
  assert.match(r.stdout, /PARKED by factual gate/);
  assert.equal(mock.restPosts.length, 0, '事实门未过绝不能触发 REST upsert');
  assert.deepEqual(mock.larkMsgs, [
    `${AT_PM}${AT_OPS}⚠️ [gengrowth] 事实门未过（needs_human）：PG-WLS-902（test-fact-gate-fail）— codex FAIL。已跳过发布，待人工核对。`,
  ]);
});

test('v2: codex exit 3 preserves raw stderr in the repair queue and sends no direct needs_human alert', async () => {
  const { dir, staging, env } = caseEnv('fact-gate-exit3-v2');
  writeReadyDraft(staging, 'PG-WLS-907', 'test-fact-gate-exit3', '事实门工具故障测试');
  env.GG_CODEX_BIN = writeFakeCodexExit3(dir);
  env.GG_SEO_REPAIR_CONTROLLER_V2_ENABLED = '1';
  env.GG_GENGROWTH_PUBLISH_LOG_FILE = join(dir, 'publisher.log');
  const r = await runPublisher(['--apply', '--staging-dir', staging], env);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /PARKED by factual gate/);
  assert.equal(mock.restPosts.length, 0, '事实门未过绝不能触发 REST upsert');
  assert.deepEqual(mock.larkMsgs, [], 'v2 repairable failure 由 controller 独占终态通知');
  const queueDir = join(env.GG_FLOW_STATE_DIR, 'seo-repair-queue');
  const files = readdirSync(queueDir).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 1);
  const record = JSON.parse(readFileSync(join(queueDir, files[0]), 'utf8'));
  assert.equal(record.event.pageId, 'PG-WLS-907');
  assert.equal(record.event.errorKind, 'tool_exit');
  assert.match(record.event.stderr, /provider stream reset/);
  assert.deepEqual(record.event.canonicalRetry.slice(-2), ['--source', join(staging, 'PG-WLS-907-claude-v8.md')]);
});

// ── (3) published（.mjs :325）：gate PASS + upsert + verify-live → published，不 @ ──
test('published: 全链路成功 → 逐字模板（extra=gengrowth.ai 博客）+ 零 @', async () => {
  const { dir, staging, env } = caseEnv('published');
  writeReadyDraft(staging, 'PG-WLS-903', 'test-published-guide', '发布成功测试文章');
  env.GG_CODEX_BIN = writeFakeCodex(dir, 'PASS');
  const r = await runPublisher(['--apply', '--staging-dir', staging], env);
  assert.equal(r.status, 0, `发布成功应 exit 0（stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /verified live: test-published-guide/);
  assert.equal(mock.restPosts.length, 1, 'bridge 应恰好 upsert 一次');
  assert.match(mock.restPosts[0], /on_conflict=slug,locale/);
  assert.deepEqual(mock.larkMsgs, [
    '✅ [gengrowth] 已发布上线：发布成功测试文章\nhttps://gengrowth.ai/en/blog/test-published-guide\n（gengrowth.ai 博客）',
  ]);
});

test('v2 published: publisher suppresses direct success notification for controller ownership', async () => {
  const { dir, staging, env } = caseEnv('published-v2');
  writeReadyDraft(staging, 'PG-WLS-908', 'test-published-v2', 'v2 发布成功测试');
  env.GG_CODEX_BIN = writeFakeCodex(dir, 'PASS');
  env.GG_SEO_REPAIR_CONTROLLER_V2_ENABLED = '1';
  const r = await runPublisher(['--apply', '--staging-dir', staging], env);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /verified live: test-published-v2/);
  assert.deepEqual(mock.larkMsgs, [], '只有 controller 在完成终态验证后发送 published');
});

// ── (4) publish_fail（.mjs :329）：bridge REST 500 → publish_fail，OPS @（有意变更）──
test('publish_fail: bridge 失败 → 模板前缀 + OPS @ + exitCode 1', async () => {
  const { dir, staging, env } = caseEnv('publish-fail');
  writeReadyDraft(staging, 'PG-WLS-904', 'test-publish-fail', '发布失败测试文章');
  env.GG_CODEX_BIN = writeFakeCodex(dir, 'PASS');
  mock.upsert500 = true; // caseEnv 已重置标志位，case 内再打开
  const r = await runPublisher(['--apply', '--staging-dir', staging], env);
  assert.equal(r.status, 1, 'failed>0 沿用原语义 exitCode=1');
  assert.equal(mock.larkMsgs.length, 1);
  assert.ok(
    mock.larkMsgs[0].startsWith(`${AT_OPS}⚠️ [gengrowth] 发布失败：PG-WLS-904（test-publish-fail）— `),
    `publish_fail 模板/@ 前缀不符：${mock.larkMsgs[0]}`,
  );
});

test('v2 publish_fail: enqueue exact target and suppress direct failure notification', async () => {
  const { dir, staging, env } = caseEnv('publish-fail-v2');
  writeReadyDraft(staging, 'PG-WLS-909', 'test-publish-fail-v2', 'v2 发布失败测试');
  env.GG_CODEX_BIN = writeFakeCodex(dir, 'PASS');
  env.GG_SEO_REPAIR_CONTROLLER_V2_ENABLED = '1';
  env.GG_GENGROWTH_PUBLISH_LOG_FILE = join(dir, 'publisher.log');
  mock.upsert500 = true;
  const r = await runPublisher(['--apply', '--staging-dir', staging], env);
  assert.equal(r.status, 1);
  assert.deepEqual(mock.larkMsgs, [], 'v2 发布异常由 controller 修复后再报告终态');
  const queueDir = join(env.GG_FLOW_STATE_DIR, 'seo-repair-queue');
  const files = readdirSync(queueDir).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 1);
  const record = JSON.parse(readFileSync(join(queueDir, files[0]), 'utf8'));
  assert.equal(record.event.pageId, 'PG-WLS-909');
  assert.equal(record.event.errorKind, 'publish_fail');
  assert.deepEqual(record.event.canonicalRetry.slice(-4), ['--pages', 'PG-WLS-909', '--limit', '1']);
});

// ── (5) ticker_error（.mjs :337）：main() 抛异常 → ticker_error，OPS @，⚠️ 替代 ✖ ──
test('ticker_error: 参数解析抛错 → 模板前缀（⚠️ 非 ✖）+ OPS @ + exit 0', async () => {
  const { env } = caseEnv('ticker-error');
  const r = await runPublisher(['--pages'], env); // --pages 缺值 → parseArgs 内 TypeError
  assert.equal(r.status, 0, 'ticker 异常兜底必须 exit 0');
  assert.match(r.stderr, /gg-gengrowth-publish ERROR:/);
  assert.equal(mock.larkMsgs.length, 1);
  assert.ok(
    mock.larkMsgs[0].startsWith(`${AT_OPS}⚠️ [gengrowth] 发布 ticker 异常：`),
    `ticker_error 模板/@ 前缀不符：${mock.larkMsgs[0]}`,
  );
  assert.ok(!mock.larkMsgs[0].includes('✖'), '废弃字形 ✖ 不得再出现在通知里');
});

test('v2 ticker_error: 入 durable repair queue 且不再直接发人工告警', async () => {
  const { env } = caseEnv('ticker-error-v2');
  env.GG_SEO_REPAIR_CONTROLLER_V2_ENABLED = '1';
  const r = await runPublisher(['--pages'], env);
  assert.equal(r.status, 0, 'ticker 异常仍保持 wrapper-safe exit 0');
  assert.match(r.stderr, /gg-gengrowth-publish ERROR:/);
  assert.deepEqual(mock.larkMsgs, [], 'v2 repairable run error 必须由 controller 独占终态通知');
  const queueDir = join(env.GG_FLOW_STATE_DIR, 'seo-repair-queue');
  const files = readdirSync(queueDir).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 1);
  const record = JSON.parse(readFileSync(join(queueDir, files[0]), 'utf8'));
  assert.equal(record.event.site, 'gengrowth');
  assert.equal(record.event.pageId, 'RUN');
  assert.equal(record.event.stage, 'run');
  assert.equal(record.event.errorKind, 'tool_exit');
  assert.match(record.event.summary, /Cannot read properties|undefined|split/);
});

// ── (6) SILENCE 门控原位原语义：GG_LARK_NOTIFY_SILENCE=1 → 只 audit 不发送 ──
test('GG_LARK_NOTIFY_SILENCE=1: 事件只写 audit（SILENCED），mock 收不到消息', async () => {
  const { dir, staging, env } = caseEnv('silence', { sbKey: '' });
  env.GG_LARK_NOTIFY_SILENCE = '1';
  const r = await runPublisher(['--apply', '--staging-dir', staging], env);
  assert.equal(r.status, 0);
  assert.equal(mock.larkMsgs.length, 0, 'SILENCE 时绝不打消息 API');
  const audit = readFileSync(join(dir, 'audit.log'), 'utf8');
  assert.match(audit, /\tSILENCED\t.*凭据缺失：SB_KEY/);
});

// ── (7) 源码断言：裸拼字符串 + 散装 AT env 的旧机制已从两个文件中拆除 ──
test('迁移完备性：.mjs/.sh 不再引用 gg-lark-notify.sh / larkBestEffort / 散装 AT env', () => {
  const mjs = readFileSync(PUBLISHER, 'utf8');
  assert.doesNotMatch(mjs, /gg-lark-notify\.sh/, '.mjs 不得再走 shell 通知壳');
  assert.doesNotMatch(mjs, /larkBestEffort/, '裸拼消息的 larkBestEffort 应已删除');
  assert.doesNotMatch(mjs, /GG_LARK_NOTIFY_AT_/, '@ 策略由事件表决定，不得散装 AT env');
  for (const ev of ["notify('auth_missing'", "notify('fact_gate_fail'", "notify('published'", "notify('publish_fail'", "notify('ticker_error'"]) {
    assert.ok(mjs.includes(ev), `.mjs 缺少事件调用 ${ev}`);
  }

  const sh = readFileSync(TICK_SH, 'utf8');
  assert.doesNotMatch(sh, /gg-lark-notify\.sh/, '.sh 不得再走 shell 通知壳');
  assert.doesNotMatch(sh, /GG_LARK_NOTIFY_AT_/, '.sh 的 @ 由 auth_missing 事件表决定');
  assert.match(sh, /gg-notify\.mjs" auth_missing --site gengrowth --what service_role --hint "supabase login"/);
  assert.match(sh, /gg-seo-repair-controller\.mjs" drain/, '自然 publish wrapper 必须在 v2 下拉起统一修复 controller');
});

// ── (8) tick.sh 语法完好（bash -n）──
test('gg-gengrowth-publish-tick.sh: bash -n 通过', () => {
  const r = spawnSync('bash', ['-n', TICK_SH], { encoding: 'utf8' });
  assert.equal(r.status, 0, `bash -n 失败：${r.stderr}`);
});

// ── (9) .sh 的 auth_missing 事件端到端渲染（黑盒跑 CLI，同 .sh 里的调用形态）──
test('CLI auth_missing --what service_role: 渲染与 .sh 调用点一致 + OPS @', async () => {
  const { env } = caseEnv('sh-auth-missing');
  const r = await runAsync(
    'node',
    [join(SCRIPTS, 'gg-notify.mjs'), 'auth_missing', '--site', 'gengrowth', '--what', 'service_role', '--hint', 'supabase login'],
    env, 30000,
  );
  assert.equal(r.status, 0, 'gg-notify CLI 契约 exit 永远 0');
  assert.deepEqual(mock.larkMsgs, [
    `${AT_OPS}⚠️ [gengrowth] 凭据缺失：service_role，本轮跳过。恢复：supabase login`,
  ]);
});
