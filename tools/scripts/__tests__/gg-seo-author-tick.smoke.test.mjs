#!/usr/bin/env node
// Hermetic smoke tests for gg-seo-author-tick.sh（阶段 1 · 通知统一迁移）。
//
// 验证 4 个通知调用点已从「裸拼字符串 + 散装 AT env + gg-lark-notify.sh」迁移到统一事件层
// （node gg-notify.mjs <event> --k v，见 lib/NOTIFY-CONTRACT.md 迁移映射）：
//   :94  preflight 失败  → preflight_fail(lane=seo-author, log)
//   :123 撰写超时被硬杀  → lane_timeout(lane=seo-author, seconds)
//   :130 写稿暂停        → parked(site=astrologywiki, pid, reason ← 从 PARK(author) 行解析)
//   :133 写好一篇        → authored(site=astrologywiki, detail=…— 待 publish lane 发布)
//
// 黑盒方式（同 gg-preview-gate.smoke.test.mjs 的 fake-bin/sandbox 模式）：把 tick 脚本复制进
// 每用例独立沙箱（仅改写硬编码的机器级锁路径 /tmp/gg-seo-author.lock —— 真路径与生产 lane 共享，
// 测试绝不能碰），SCRIPT_DIR 内放假的 gg-notify.mjs（记录 argv 到 sentinel）、假 preflight、假
// autopilot 驱动。HOME 指沙箱（LOG_DIR、_gg.env 全部隔离）。无网络、无真 claude/codex/飞书。
//
// Run: node --test tools/scripts/__tests__/gg-seo-author-tick.smoke.test.mjs

import { test, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REAL_SCRIPT = fileURLToPath(new URL('../gg-seo-author-tick.sh', import.meta.url));
const REAL_SRC = readFileSync(REAL_SCRIPT, 'utf8');

// A fresh sandbox per test run (pid-scoped); each case gets its own scripts dir + home + sentinels.
const ROOT = join(tmpdir(), `gg-seo-author-tick-test-${process.pid}`);
mkdirSync(ROOT, { recursive: true });
after(() => rmSync(ROOT, { recursive: true, force: true }));

// 备用 gtimeout shim：脚本把 /opt/homebrew/bin 等真实目录前置到 PATH，真 gtimeout 存在则用真的
//（假驱动瞬间退出，60s+ 的 cap 不会命中）；没装 coreutils 的机器则回落到这个 shim（丢弃秒数参数，
// 直接 exec 余下命令——测试不需要真超时，rc=124 由假驱动自己退出模拟）。
const FALLBACK_BIN = join(ROOT, 'fallback-bin');
mkdirSync(FALLBACK_BIN, { recursive: true });
writeFileSync(join(FALLBACK_BIN, 'gtimeout'), '#!/bin/sh\nshift\nexec "$@"\n');
chmodSync(join(FALLBACK_BIN, 'gtimeout'), 0o755);

let caseSeq = 0;
// 搭一个用例沙箱：复制 tick 脚本（锁路径改写进沙箱），放好三个假脚本，返回 run()。
function setupCase({ preflightExit = 0, autoStdout = '', autoExit = 0 } = {}) {
  const dir = join(ROOT, `case-${caseSeq++}`);
  const scripts = join(dir, 'scripts');
  const home = join(dir, 'home');
  const sentinels = join(dir, 'sentinels');
  for (const d of [scripts, home, sentinels]) mkdirSync(d, { recursive: true });

  // 锁路径是机器级全局（生产 authoring lane 同一路径）——测试必须改写，且断言改写确实发生
  //（防上游把锁路径改名后本测试静默跑在真锁上）。
  const lockLine = 'LOCK="/tmp/gg-seo-author.lock"';
  assert.ok(REAL_SRC.includes(lockLine), 'tick 脚本应包含已知的锁路径行（改名请同步本测试）');
  const patched = REAL_SRC.replace(lockLine, `LOCK="${join(dir, 'author.lock')}"`);
  const script = join(scripts, 'gg-seo-author-tick.sh');
  writeFileSync(script, patched);
  chmodSync(script, 0o755);

  // 假 gg-notify.mjs：把 argv 按 JSON 行记进 sentinel，永远 exit 0（同真 CLI 契约）。
  writeFileSync(
    join(scripts, 'gg-notify.mjs'),
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(join(sentinels, 'notify-calls'))}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(0);
`,
  );
  // 假 preflight：exit 码按用例。
  writeFileSync(join(scripts, 'gg-autopilot-preflight.mjs'), `process.exit(${preflightExit});\n`);
  // 假 autopilot 驱动：打印 canned 输出 + 记 sentinel + exit 码按用例（124 模拟 gtimeout cap-hit）。
  writeFileSync(
    join(scripts, 'gg-seo-autopilot.mjs'),
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(join(sentinels, 'auto-called'))}, process.argv.slice(2).join(' ') + '\\n');
process.stdout.write(${JSON.stringify(autoStdout)});
process.exit(${autoExit});
`,
  );

  const run = () =>
    spawnSync('bash', [script], {
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...process.env,
        HOME: home,
        // 77 ≥ 60（脚本下限钳制），且足够独特可断言 --seconds 77。
        GG_AUTHOR_TICK_TIMEOUT: '77',
        GG_AUTHOR_BATCH: '1',
        // DONE 的 grep 用 [^—]*（多字节负字符类），必须 UTF-8 locale（launchd 生产环境同样依赖）。
        LC_ALL: 'en_US.UTF-8',
        PATH: `${process.env.PATH}:${FALLBACK_BIN}`,
      },
    });

  const notifyCalls = () => {
    const f = join(sentinels, 'notify-calls');
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      // tick 开头的 outbox 重放是常规噪声（fail-closed 补发闭环），事件断言只看真事件。
      .filter((argv) => argv[0] !== 'replay-outbox');
  };
  return { dir, sentinels, run, notifyCalls, home };
}

// ── 静态断言：bash -n + 迁移彻底性 grep ─────────────────────────────────────

test('static: bash -n passes on the real script', () => {
  const r = spawnSync('bash', ['-n', REAL_SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, `bash -n 失败：${r.stderr}`);
});

test('static: no legacy gg-lark-notify.sh call sites or scattered AT env remain', () => {
  assert.doesNotMatch(REAL_SRC, /gg-lark-notify\.sh/, '旧壳调用点应全部删除');
  assert.doesNotMatch(REAL_SRC, /GG_LARK_NOTIFY_AT_(PM|OPS|OPERATOR)/, '@ 策略应由事件表决定，不再散装 env');
  // 4 个事件调用点齐备，且都走 $SCRIPT_DIR/gg-notify.mjs。
  for (const ev of ['preflight_fail', 'lane_timeout', 'parked', 'authored']) {
    assert.match(REAL_SRC, new RegExp(`node "\\$SCRIPT_DIR/gg-notify\\.mjs" ${ev} `), `缺事件调用点：${ev}`);
  }
});

// ── 动态断言：黑盒跑沙箱副本，验证 shell 布线（转义、字段解析、门控） ─────────

test('preflight failure → preflight_fail(lane=seo-author, log) and exit 2, driver never invoked', () => {
  const c = setupCase({ preflightExit: 1 });
  const r = c.run();
  assert.equal(r.status, 2, `期望 exit 2，得到 ${r.status}；stderr=${r.stderr}`);
  const calls = c.notifyCalls();
  assert.equal(calls.length, 1, `期望恰好 1 次通知，得到 ${JSON.stringify(calls)}`);
  const [ev, ...args] = calls[0];
  assert.equal(ev, 'preflight_fail');
  const i = args.indexOf('--lane');
  assert.equal(args[i + 1], 'seo-author');
  const j = args.indexOf('--log');
  assert.match(args[j + 1], /\/gengrowth-agents\/cron-sync\/seo_author\/\d{4}-\d{2}-\d{2}\.log$/);
  assert.ok(args[j + 1].startsWith(c.home), 'log 路径应落在沙箱 HOME 内');
  assert.ok(!existsSync(join(c.sentinels, 'auto-called')), 'preflight 失败后不应再花 LLM 预算');
});

test('rc=124 cap-hit → lane_timeout(seconds=cap) only; half-done AUTHORED output is NOT announced', () => {
  const c = setupCase({
    preflightExit: 0,
    // 半成品输出里故意混入 AUTHORED 行——cap-hit 后绝不能上报为 ready。
    autoStdout: 'AUTHORED PG-HALF-001 → _staging/x.md (author=claude, attempt 1/2) — ready for next scan to publish\n',
    autoExit: 124,
  });
  const r = c.run();
  assert.equal(r.status, 0);
  const calls = c.notifyCalls();
  assert.equal(calls.length, 1, `期望仅 lane_timeout 一次，得到 ${JSON.stringify(calls)}`);
  const [ev, ...args] = calls[0];
  assert.equal(ev, 'lane_timeout');
  assert.equal(args[args.indexOf('--lane') + 1], 'seo-author');
  assert.equal(args[args.indexOf('--seconds') + 1], '77');
});

test('non-124 error rc → no notification at all (incomplete fire, silent park in log)', () => {
  const c = setupCase({ preflightExit: 0, autoStdout: 'boom\n', autoExit: 3 });
  const r = c.run();
  assert.equal(r.status, 0);
  assert.deepEqual(c.notifyCalls(), [], '非 124 的失败 rc 不该发通知（沿用原语义）');
});

test('clean exit + PARK line → parked(site=astrologywiki) with pid/reason parsed from the driver line', () => {
  const c = setupCase({
    preflightExit: 0,
    autoStdout: 'noise line\nPARK(author) PG-TEST-001: zh 红线未过，需人工复核\nmore noise\n',
    autoExit: 0,
  });
  const r = c.run();
  assert.equal(r.status, 0);
  const calls = c.notifyCalls();
  assert.equal(calls.length, 1, JSON.stringify(calls));
  const [ev, ...args] = calls[0];
  assert.equal(ev, 'parked');
  assert.equal(args[args.indexOf('--site') + 1], 'astrologywiki');
  assert.equal(args[args.indexOf('--pid') + 1], 'PG-TEST-001');
  assert.equal(args[args.indexOf('--reason') + 1], 'zh 红线未过，需人工复核');
});

test('clean exit + AUTHORED line → authored(site=astrologywiki, detail=…— 待 publish lane 发布)', () => {
  const c = setupCase({
    preflightExit: 0,
    autoStdout: 'AUTHORED PG-TEST-002 → _staging/pg-test-002.md (author=claude, attempt 1/2) — ready for next scan to publish\n',
    autoExit: 0,
  });
  const r = c.run();
  assert.equal(r.status, 0);
  const calls = c.notifyCalls();
  assert.equal(calls.length, 1, JSON.stringify(calls));
  const [ev, ...args] = calls[0];
  assert.equal(ev, 'authored');
  assert.equal(args[args.indexOf('--site') + 1], 'astrologywiki');
  assert.equal(
    args[args.indexOf('--detail') + 1],
    'AUTHORED PG-TEST-002 → _staging/pg-test-002.md (author=claude, attempt 1/2) — 待 publish lane 发布',
  );
});

test('clean exit, nothing authored/parked → zero notifications', () => {
  const c = setupCase({ preflightExit: 0, autoStdout: 'scan ok, queue empty\n', autoExit: 0 });
  const r = c.run();
  assert.equal(r.status, 0);
  assert.deepEqual(c.notifyCalls(), []);
});
