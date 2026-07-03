#!/usr/bin/env node
// tools/scripts/gg-notify.mjs — 通知 CLI（shell 调用点用，阶段 1 · 通知统一）。
//
// 用法（NOTIFY-CONTRACT.md §CLI）：
//   node tools/scripts/gg-notify.mjs <event> --site astrologywiki --pid PG-X --slug foo --reason "…"
//   node tools/scripts/gg-notify.mjs raw --text "任意文本"        # back-compat 通道
//   node tools/scripts/gg-notify.mjs replay-outbox                 # 重放 outbox
//   node tools/scripts/gg-notify.mjs heartbeat <lane-label>        # 写 lane 心跳（阶段 5 watchdog 读）
//
// `--k v` 全部收进 fields（值可以以 -- 开头，如 --text "--weird"）。
// exit 永远 0（best-effort，绝不搞垮调用方）；失败原因打 stderr，结果 JSON 打 stdout。

import { notify } from './lib/gg-notify.mjs';
import { replayOutbox } from './lib/lark-send.mjs';
import { heartbeat } from './lib/flow-state.mjs';

function parseFields(argv) {
  const fields = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.length > 2) {
      const key = a.slice(2);
      // 下一个参数无条件作为值（允许值本身以 -- 开头）；缺失按空串。
      fields[key] = i + 1 < argv.length ? argv[++i] : '';
    }
  }
  return fields;
}

async function main() {
  const argv = process.argv.slice(2);
  const event = argv[0];
  if (!event) {
    process.stderr.write(
      'gg-notify: 用法：gg-notify.mjs <event> --k v … ｜ gg-notify.mjs raw --text "…" ｜ gg-notify.mjs replay-outbox\n',
    );
    return;
  }
  if (event === 'replay-outbox') {
    const r = await replayOutbox();
    process.stdout.write(JSON.stringify(r) + '\n');
    if (r.remaining > 0) process.stderr.write(`gg-notify: outbox 仍有 ${r.remaining} 条未重放成功\n`);
    return;
  }
  if (event === 'heartbeat') {
    // node gg-notify.mjs heartbeat <lane-label>：touch <state>/heartbeats/<lane> mtime（阶段 5）。
    const lane = argv[1];
    const ok = lane ? heartbeat(lane) : false;
    process.stdout.write(JSON.stringify({ ok, lane: lane || null }) + '\n');
    if (!ok) process.stderr.write('gg-notify: heartbeat 需要 lane 名参数\n');
    return;
  }
  const fields = parseFields(argv.slice(1));
  const r = await notify(event, fields);
  process.stdout.write(JSON.stringify(r) + '\n');
  if (!r.ok) process.stderr.write(`gg-notify: 发送失败（${r.error}），已入 outbox 待重放\n`);
}

main()
  .catch((e) => {
    process.stderr.write(`gg-notify: ${String((e && e.message) || e)}\n`);
  })
  .finally(() => {
    process.exit(0); // 契约：exit 永远 0
  });
