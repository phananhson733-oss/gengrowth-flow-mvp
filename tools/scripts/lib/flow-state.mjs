// tools/scripts/lib/flow-state.mjs — flow 运行时状态层（阶段 1 · 通知统一）。
//
// 职责：notify-outbox（发送失败的通知待重放队列）与 heartbeats（lane 心跳，阶段 5 使用，
// 本阶段先提供）。状态目录放在 vault 之外（默认 ~/gengrowth-agents/flow-state），避免
// Obsidian git 自动同步把运行时文件卷进 vault 提交；测试用 GG_FLOW_STATE_DIR 指向临时目录。
//
// 契约（NOTIFY-CONTRACT.md §lib/flow-state.mjs）：
//   · 全部同步 API（脚本场景）；
//   · 任何失败不抛（返回 null／false／[]）——状态层永不搞垮业务。

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  openSync,
  closeSync,
  utimesSync,
  renameSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** 状态根目录（确保存在）。失败返回 null。 */
export function stateDir() {
  try {
    const dir = process.env.GG_FLOW_STATE_DIR || join(homedir(), 'gengrowth-agents', 'flow-state');
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

/** outbox 目录 `<state>/notify-outbox/`（确保存在）。失败返回 null。 */
export function outboxDir() {
  try {
    const base = stateDir();
    if (!base) return null;
    const dir = join(base, 'notify-outbox');
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

// 同一进程内多次写入时避免文件名撞车（ts+pid 相同）的自增序号。
let outboxSeq = 0;

/**
 * 写一条 outbox 待重放记录，文件名 `<ts>-<pid>-<seq>.json`。
 * payload 契约字段：{text, atPm, atOps, chatId, createdAt, attempts, lastError}。
 * 返回文件名；失败返回 null。
 */
export function outboxWrite(payload) {
  try {
    const dir = outboxDir();
    if (!dir) return null;
    const name = `${Date.now()}-${process.pid}-${outboxSeq++}.json`;
    const record = {
      createdAt: new Date().toISOString(),
      attempts: 0,
      lastError: null,
      ...payload,
    };
    writeFileSync(join(dir, name), JSON.stringify(record, null, 2) + '\n');
    return name;
  } catch {
    return null;
  }
}

/** 列出 outbox 内全部记录文件名（按名字＝时间顺序排序）。失败返回 []。 */
export function outboxList() {
  try {
    const dir = outboxDir();
    if (!dir) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

/** 读取并解析一条 outbox 记录。失败／损坏返回 null。 */
export function outboxRead(name) {
  try {
    const dir = outboxDir();
    if (!dir) return null;
    return JSON.parse(readFileSync(join(dir, name), 'utf8'));
  } catch {
    return null;
  }
}

/** 原地覆写一条 outbox 记录（重放失败时 attempts+1 用）。失败返回 false。 */
export function outboxRewrite(name, payload) {
  try {
    const dir = outboxDir();
    if (!dir) return false;
    writeFileSync(join(dir, name), JSON.stringify(payload, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}

/** 删除一条 outbox 记录。失败返回 false。 */
export function outboxRemove(name) {
  try {
    const dir = outboxDir();
    if (!dir) return false;
    unlinkSync(join(dir, name));
    return true;
  } catch {
    return false;
  }
}

// ── 认领机制（write-ahead + 防重复发送）───────────────────────────────────────
// `.json` = 待重放（replayOutbox 可见）；`.json.sending` = 已被某进程认领、发送中
// （对 outboxList 不可见）。认领用原子 rename：两个进程抢同一条时只有一个成功。
// 进程发送中被 SIGTERM 杀死会残留 `.sending`，由 outboxReclaimStale 按 mtime 回收。

/**
 * 写一条「已认领」记录（write-ahead：发送方在第一次网络尝试前先落盘，
 * 中途被杀消息也不会丢——回收后由 replay 补发）。返回 `.sending` 文件名；失败 null。
 */
export function outboxWriteClaimed(payload) {
  try {
    const dir = outboxDir();
    if (!dir) return null;
    const name = `${Date.now()}-${process.pid}-${outboxSeq++}.json.sending`;
    const record = { createdAt: new Date().toISOString(), attempts: 0, lastError: null, ...payload };
    writeFileSync(join(dir, name), JSON.stringify(record, null, 2) + '\n');
    return name;
  } catch {
    return null;
  }
}

/** 认领一条待重放记录：`<name>` → `<name>.sending`（原子）。返回认领名；抢输/失败返回 null。 */
export function outboxClaim(name) {
  try {
    const dir = outboxDir();
    if (!dir) return null;
    const claimed = `${name}.sending`;
    renameSync(join(dir, name), join(dir, claimed));
    return claimed;
  } catch {
    return null;
  }
}

/** 提交（发送成功）：删除认领文件。失败返回 false。 */
export function outboxCommit(claimedName) {
  try {
    const dir = outboxDir();
    if (!dir) return false;
    unlinkSync(join(dir, claimedName));
    return true;
  } catch {
    return false;
  }
}

/** 释放为待重放（发送失败）：更新 payload 写回认领文件，再原子 rename 回 `.json`。 */
export function outboxReleaseFail(claimedName, payload) {
  try {
    const dir = outboxDir();
    if (!dir) return false;
    writeFileSync(join(dir, claimedName), JSON.stringify(payload, null, 2) + '\n');
    renameSync(join(dir, claimedName), join(dir, claimedName.replace(/\.sending$/, '')));
    return true;
  } catch {
    return false;
  }
}

/**
 * 回收陈旧认领：mtime 早于 maxAgeMs 的 `.sending`（发送方进程被杀的残留）
 * rename 回 `.json` 供重放。返回回收条数。
 */
export function outboxReclaimStale(maxAgeMs) {
  let n = 0;
  try {
    const dir = outboxDir();
    if (!dir) return 0;
    const cutoff = Date.now() - Math.max(0, maxAgeMs);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json.sending')) continue;
      try {
        if (statSync(join(dir, f)).mtimeMs < cutoff) {
          renameSync(join(dir, f), join(dir, f.replace(/\.sending$/, '')));
          n++;
        }
      } catch {}
    }
  } catch {}
  return n;
}

/**
 * touch `<state>/heartbeats/<lane>`（lane 名清洗为 [A-Za-z0-9._-]）。
 * 阶段 5 的 lane_stale 检测读这个 mtime；本阶段先提供写入端。失败返回 false。
 */
export function heartbeat(lane) {
  try {
    const base = stateDir();
    if (!base) return false;
    const safe = String(lane || '').replace(/[^A-Za-z0-9._-]/g, '-');
    if (!safe) return false;
    const dir = join(base, 'heartbeats');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, safe);
    const now = new Date();
    try {
      utimesSync(file, now, now);
    } catch {
      closeSync(openSync(file, 'w'));
    }
    return true;
  } catch {
    return false;
  }
}
