// tools/scripts/lib/lark-send.mjs — 飞书传输层（fail-closed，阶段 1 · 通知统一）。
//
// 历史背景（沿用旧 gg-lark-notify.sh 的决定，2026-06-23）：通知必须以 HERMES BOT 的身份
// 发出，不能用王志彪个人账号（旧版走 lark-cli 用户 token，看起来像王志彪自己发的还 @
// 自己）。认证方式：~/.hermes/.env 的 FEISHU_APP_ID/FEISHU_APP_SECRET → tenant_access_token
// → im/v1/messages（Hermes 应用 cli_a909cb3dacf89cb3，即群里已有的那个 bot）。
//
// 默认目标 = 「SEO技术」群（王志彪 PM + 马博洋 Ops + 王玲 CEO）。chat_id 是租户全局的，
// 跨应用可用；open_id 是按应用隔离的（per-app）——下面的 @ 用 open_id 是 HERMES 应用
// 视角从群里查到的，不是 lark-cli 的。王玲（CEO）永不 @。
//
// 契约（NOTIFY-CONTRACT.md §lib/lark-send.mjs）：
//   · fail-closed：响应 `code===0` 且有 `data.message_id` 才算 SENT；
//   · 失败重试（总尝试 1 + GG_LARK_SEND_RETRIES，指数退避）；
//   · 最终失败 outboxWrite + audit `SEND_FAILED`；replayOutbox 重放清箱；
//   · 对 caller 永不 throw。

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import {
  outboxWrite,
  outboxWriteClaimed,
  outboxClaim,
  outboxCommit,
  outboxReleaseFail,
  outboxReclaimStale,
  outboxList,
  outboxRead,
} from './flow-state.mjs';

/** 「SEO技术」群 chat_id（租户全局）。 */
export const DEFAULT_CHAT_ID = 'oc_5489e578113e804b80b3e556ce09fdb0';
/** 王志彪（PM）——HERMES 应用视角的 open_id（per-app）。 */
export const PM_OPEN_ID = 'ou_3ce0dce02872c344a4e244a1837ebced';
/** 马博洋（Ops，SEO 运营）——HERMES 应用视角的 open_id（per-app）。 */
export const OPS_OPEN_ID = 'ou_96d93c73b1bf79deae92ef94e58b37f6';

function apiBase() {
  return (process.env.GG_LARK_API_BASE || 'https://open.feishu.cn').replace(/\/+$/, '');
}

function auditPath() {
  return process.env.GG_LARK_AUDIT_LOG || join(homedir(), 'Library', 'Logs', 'gg-lark-notify.log');
}

/** 目标解析：参数 chatId > env GG_LARK_NOTIFY_CHAT_ID > 默认「SEO技术」群。 */
export function resolveChatId(chatId) {
  return chatId || process.env.GG_LARK_NOTIFY_CHAT_ID || DEFAULT_CHAT_ID;
}

/** @ 前缀（前置于正文；@ 策略由事件层决定，这里只负责拼装）。 */
export function atPrefix(atPm, atOps) {
  let at = '';
  if (atPm) at += `<at user_id="${PM_OPEN_ID}"></at> `;
  if (atOps) at += `<at user_id="${OPS_OPEN_ID}"></at> `;
  return at;
}

function localStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * audit 行：`{date}\tchat={id}\t{SENT|SEND_FAILED code=X|SILENCED|OUTBOX_REPLAYED}\t{text 单行}`。
 * best-effort：写不进去就算了，绝不影响发送路径。
 */
export function auditLog(status, chatId, text) {
  try {
    const file = auditPath();
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch {}
    const oneLine = String(text ?? '').replace(/\s*\n\s*/g, ' ');
    appendFileSync(file, `${localStamp()}\tchat=${chatId}\t${status}\t${oneLine}\n`);
  } catch {}
}

/** 从 HERMES_ENV（默认 ~/.hermes/.env）读 Hermes 应用凭据。缺失返回 null。 */
function readCreds() {
  try {
    const p = process.env.HERMES_ENV || join(homedir(), '.hermes', '.env');
    const env = readFileSync(p, 'utf8');
    const g = (k) =>
      ((env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1] || '')
        .trim()
        .replace(/^["']|["']$/g, '');
    const appId = g('FEISHU_APP_ID');
    const appSecret = g('FEISHU_APP_SECRET');
    if (!appId || !appSecret) return null;
    return { appId, appSecret };
  } catch {
    return null;
  }
}

/** POST JSON（带超时）。任何网络／解析失败返回 null，绝不 throw。 */
async function postJson(path, body, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.GG_LARK_HTTP_TIMEOUT_MS || 10000));
  try {
    const res = await fetch(apiBase() + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...(headers || {}) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const txt = await res.text();
    try {
      return JSON.parse(txt || '{}');
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 发送一条文本消息（fail-closed）。
 *
 * @param {string} text 正文（不含 @ 前缀；@ 由 atPm/atOps 决定并在此拼装）
 * @param {object} [opts] {atPm, atOps, chatId, _noOutbox}
 *   _noOutbox：replayOutbox 内部用，防止失败递归入箱。
 * @returns {Promise<{ok:boolean, messageId:string|null, error:string|null}>} 永不 throw。
 */
export async function sendLark(text, opts = {}) {
  try {
    const { atPm = false, atOps = false, chatId = null, _noOutbox = false, msgUuid = null } = opts;
    const rid = resolveChatId(chatId);
    const full = atPrefix(atPm, atOps) + String(text ?? '');

    // 空文本绝不发送也绝不入箱：飞书必拒（code!=0），入箱只会制造永远重放失败的毒条目。
    if (!String(text ?? '').trim()) {
      auditLog('SEND_FAILED code=empty-text', rid, '(empty)');
      return { ok: false, messageId: null, error: 'empty-text' };
    }

    // 幂等键：同一逻辑消息的全部重试／重放共用一个 uuid，飞书按 uuid 去重——
    // 消灭「已受理但响应超时→重发」与「commit 前被杀→回收重放」两个重复投递窗口。
    const uuid = msgUuid || crypto.randomUUID();

    const payload = () => ({
      text: String(text ?? ''),
      atPm: !!atPm,
      atOps: !!atOps,
      chatId: rid,
      msgUuid: uuid,
      createdAt: new Date().toISOString(),
      attempts: 0,
    });

    // write-ahead：第一次网络尝试前先落一条「已认领」记录（.sending，对 replay 不可见）。
    // 进程在取 token／发送／退避 sleep 期间被 SIGTERM（tick gtimeout 硬杀是真实场景）时，
    // 残留的 .sending 会被 replayOutbox 的陈旧回收捡回补发——消息不再有静默丢失窗口。
    const pending = _noOutbox ? null : outboxWriteClaimed({ ...payload(), lastError: 'in-flight' });

    const finalFail = (error) => {
      if (pending) {
        outboxReleaseFail(pending, { ...payload(), lastError: error });
      } else if (!_noOutbox) {
        // write-ahead 落盘失败的兜底：再试一次普通入箱（大概率同样失败，但不放弃）。
        outboxWrite({ ...payload(), lastError: error });
      }
      auditLog(`SEND_FAILED code=${error}`, rid, full);
      return { ok: false, messageId: null, error };
    };

    const creds = readCreds();
    if (!creds) return finalFail('no-creds');

    const retries = Math.max(0, Number.parseInt(process.env.GG_LARK_SEND_RETRIES ?? '2', 10) || 0);
    const baseMs = Math.max(1, Number.parseInt(process.env.GG_LARK_RETRY_BASE_MS ?? '500', 10) || 500);

    let lastError = 'unknown';
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(baseMs * 2 ** (attempt - 1)); // 指数退避：base × 2^n
      const tok = await postJson('/open-apis/auth/v3/tenant_access_token/internal', {
        app_id: creds.appId,
        app_secret: creds.appSecret,
      });
      const t = tok && tok.tenant_access_token;
      if (!t) {
        lastError = tok && tok.code != null ? `token:${tok.code}` : 'token-unreachable';
        continue;
      }
      const resp = await postJson(
        '/open-apis/im/v1/messages?receive_id_type=chat_id',
        { receive_id: rid, msg_type: 'text', content: JSON.stringify({ text: full }), uuid },
        { Authorization: 'Bearer ' + t },
      );
      // fail-closed 判定：code===0 且有 message_id 才算送达。
      if (resp && resp.code === 0 && resp.data && resp.data.message_id) {
        if (pending) outboxCommit(pending);
        auditLog('SENT', rid, full);
        return { ok: true, messageId: resp.data.message_id, error: null };
      }
      lastError = resp && resp.code != null ? String(resp.code) : 'unreachable';
    }
    return finalFail(lastError);
  } catch (e) {
    // 防御性兜底：本函数契约是永不 throw。
    return { ok: false, messageId: null, error: String((e && e.message) || e) };
  }
}

/**
 * 重放 outbox：逐条「认领→重发」（_noOutbox 防递归入箱）。
 * 认领 = 原子 rename `.json`→`.json.sending`：多个重放进程并发时同一条只有一个赢家，
 * 消灭重复发送。开头先回收陈旧 `.sending`（发送方被 SIGTERM 杀死的残留，
 * 阈值 GG_LARK_STALE_CLAIM_MS，默认 10 分钟）。
 * 成功 → commit（删除）+ audit `OUTBOX_REPLAYED`（commit 失败则 audit
 * `OUTBOX_COMMIT_FAILED` 且不计 replayed，防「删除失败却宣布成功」）；
 * 失败 → 释放回 `.json`、attempts+1、记 lastError。
 * 损坏（JSON 解析失败／缺 text）的记录直接丢弃（永远发不出去，留着只会堵箱）。
 * @returns {Promise<{replayed:number, remaining:number, dropped:number, reclaimed:number}>} 永不 throw。
 */
export async function replayOutbox() {
  const result = { replayed: 0, remaining: 0, dropped: 0, reclaimed: 0 };
  try {
    const staleMs = Number.parseInt(process.env.GG_LARK_STALE_CLAIM_MS ?? '', 10) || 10 * 60 * 1000;
    const ttlMs = Number.parseInt(process.env.GG_LARK_OUTBOX_TTL_MS ?? '', 10) || 48 * 3600 * 1000;
    const maxAttempts = Number.parseInt(process.env.GG_LARK_OUTBOX_MAX_ATTEMPTS ?? '', 10) || 20;
    result.reclaimed = outboxReclaimStale(staleMs);
    for (const name of outboxList()) {
      const claimed = outboxClaim(name);
      if (!claimed) continue; // 另一个重放进程抢到了这条，跳过
      const payload = outboxRead(claimed);
      // 卫生淘汰（防箱体无界增长 + 毒条目永续空转）：
      //   · 损坏／空文本 → 永远发不出去，丢弃；
      //   · 超龄（默认 48h）→ 过期告警重放出去只会误导（含过期 @），丢弃留 audit；
      //   · attempts 超上限（默认 20）→ 永久性失败，丢弃留 audit。
      if (!payload || typeof payload.text !== 'string' || !payload.text.trim()) {
        outboxCommit(claimed);
        auditLog('OUTBOX_DROPPED code=invalid', resolveChatId(payload && payload.chatId), (payload && payload.text) || '(unparseable)');
        result.dropped++;
        continue;
      }
      if (payload.createdAt && Date.now() - Date.parse(payload.createdAt) > ttlMs) {
        outboxCommit(claimed);
        auditLog('OUTBOX_EXPIRED', resolveChatId(payload.chatId), payload.text);
        result.dropped++;
        continue;
      }
      if ((payload.attempts || 0) >= maxAttempts) {
        outboxCommit(claimed);
        auditLog('OUTBOX_DROPPED code=attempts', resolveChatId(payload.chatId), payload.text);
        result.dropped++;
        continue;
      }
      const r = await sendLark(payload.text, {
        atPm: !!payload.atPm,
        atOps: !!payload.atOps,
        chatId: payload.chatId || null,
        msgUuid: payload.msgUuid || null,
        _noOutbox: true,
      });
      if (r.ok) {
        if (outboxCommit(claimed)) {
          auditLog('OUTBOX_REPLAYED', resolveChatId(payload.chatId), payload.text);
          result.replayed++;
        } else {
          auditLog('OUTBOX_COMMIT_FAILED', resolveChatId(payload.chatId), payload.text);
          result.remaining++;
        }
      } else {
        outboxReleaseFail(claimed, {
          ...payload,
          attempts: (payload.attempts || 0) + 1,
          lastError: r.error,
        });
        result.remaining++;
      }
    }
  } catch {}
  return result;
}
