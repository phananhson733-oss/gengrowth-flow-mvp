// tools/scripts/lib/gg-notify.mjs — 通知事件层（阶段 1 · 通知统一）。
//
// 设计原则（NOTIFY-CONTRACT.md）：
//   1. 调用点只传结构化字段，禁止裸字符串拼消息——模板全部集中在本文件的事件表；
//   2. @ 策略由事件决定（PM=王志彪，OPS=马博洋，CEO 永不 @），不再由调用点散装 env 决定；
//   3. 站点是字段（[astrologywiki]/[gengrowth]/[flow] 标签），不是品牌前缀分叉；
//   4. 统一头：`{emoji} [{siteTag}] {正文}`；废弃 `✖`（原 Lane A 异常字形，统一为 `⚠️`）。
//
// SILENCE 语义（沿用现语义）：GG_LARK_NOTIFY_SILENCE=1 → 只写 audit（SILENCED）不发送——
// 批次静默逐篇、由汇总统一发。

import { sendLark, auditLog, resolveChatId, atPrefix } from './lark-send.mjs';

// 字段插值兜底：缺字段渲染为空串，不渲染 "undefined"。
const s = (x) => (x === undefined || x === null ? '' : String(x));

const AT_NONE = { atPm: false, atOps: false };
const AT_PM_OPS = { atPm: true, atOps: true };
const AT_OPS = { atPm: false, atOps: true };

// raw 通道（back-compat，供 gg-lark-notify.sh 壳与外部仓库调用）：@ 按 env flags 决定。
// GG_LARK_NOTIFY_AT_OPERATOR 是 AT_PM 的历史别名（旧壳约定），一并兼容。
const atFromEnv = () => ({
  atPm: process.env.GG_LARK_NOTIFY_AT_PM === '1' || process.env.GG_LARK_NOTIFY_AT_OPERATOR === '1',
  atOps: process.env.GG_LARK_NOTIFY_AT_OPS === '1',
});

const truthy = (v) => v === true || v === '1' || v === 'true';

/**
 * 事件表（enum → 模板 → @ 策略）。模板文案以 NOTIFY-CONTRACT.md 为单一事实源，
 * 全角标点逐字对齐；`at` 为对象或 `(fields) => 对象`。
 */
export const EVENTS = {
  published: {
    at: AT_NONE,
    render: (f) => {
      const lines = [`✅ [${s(f.site)}] 已发布上线：${s(f.title)}`, s(f.url)];
      if (f.extra) lines.push(`（${s(f.extra)}）`); // extra 缺省省略括号行
      return lines.join('\n');
    },
  },
  authored: {
    at: AT_NONE,
    render: (f) => `✍️ [${s(f.site)}] 写好一篇：${s(f.detail)}`,
  },
  parked: {
    at: AT_PM_OPS,
    render: (f) => `⚠️ [${s(f.site)}] 暂停待人工（needs_human）：${s(f.pid)}（${s(f.slug)}）— ${s(f.reason)}`,
  },
  park_rollup: {
    at: AT_PM_OPS,
    render: (f) =>
      `⚠️ [${s(f.site)}] 本轮共暂停 ${s(f.count)} 篇（needs_human）。首篇已单独通报，其余合并：\n${s(f.rest)}`,
  },
  gate_fail: {
    at: AT_PM_OPS,
    render: (f) => `⚠️ [${s(f.site)}] 发布 gate 未过：${s(f.slug)}（${s(f.branch)}）：${s(f.reason)} — PR 待人工`,
  },
  fact_gate_fail: {
    at: AT_PM_OPS,
    render: (f) =>
      `⚠️ [${s(f.site)}] 事实门未过（needs_human）：${s(f.pid)}（${s(f.slug)}）— ${s(f.reason)}。已跳过发布，待人工核对。`,
  },
  publish_fail: {
    at: AT_OPS,
    render: (f) => `⚠️ [${s(f.site)}] 发布失败：${s(f.pid)}（${s(f.slug)}）— ${s(f.msg)}`,
  },
  ticker_error: {
    at: AT_OPS,
    render: (f) => `⚠️ [${s(f.site)}] 发布 ticker 异常：${s(f.msg)}`,
  },
  preflight_fail: {
    at: AT_OPS,
    render: (f) => `⚠️ [flow] ${s(f.lane)} preflight 失败（env 异常，见 ${s(f.log)}），本轮跳过。`,
  },
  lane_timeout: {
    at: AT_OPS,
    render: (f) => `⚠️ [flow] ${s(f.lane)} 撰写超 ${s(f.seconds)}s 被硬杀，本轮放弃（草稿可能半成品，未上报）。`,
  },
  lane_stale: {
    at: AT_OPS,
    render: (f) => `⚠️ [flow] ${s(f.lane)} 已 ${s(f.hours)} 小时未运行（launchd 可能未加载或被禁用）。`,
  },
  auth_missing: {
    at: AT_OPS,
    render: (f) => `⚠️ [${s(f.site)}] 凭据缺失：${s(f.what)}，本轮跳过。恢复：${s(f.hint)}`,
  },
  day_complete: {
    at: AT_OPS,
    render: (f) =>
      `✅ [${s(f.site)}] ${s(f.date)}：本批计划内容已全部写完并上线（发布登记表累计 ${s(f.publishedTotal)} 篇），队列已清空。`,
  },
  // batch_summary 的正文由 gg-batch-summary.mjs 渲染（LLM 不参与），这里做透传；
  // @ 策略按契约：完成:- ／ 部分:OPS（字段 partial 标记部分完成）。
  batch_summary: {
    at: (f) => (truthy(f.partial) ? AT_OPS : AT_NONE),
    render: (f) => s(f.text),
  },
  topic_registered: {
    at: AT_NONE,
    render: (f) =>
      `📋 [${s(f.site)}] 选题登记自动补齐：${s(f.label)}\n补齐 ${s(f.filled)} 行；新增 cluster ${s(f.clusters)} 个。\npage_id: ${s(f.pageIds)}`,
  },
  index_diagnosis: {
    at: AT_PM_OPS,
    render: (f) => `🔍 [${s(f.site)}] 索引诊断报告\n${s(f.body)}`,
  },
  index_queue: {
    at: AT_PM_OPS,
    render: (f) => `⚠️ [${s(f.site)}] Request Indexing 候选队列已更新：${s(f.body)}`,
  },
  index_resubmit_ok: {
    at: AT_PM_OPS,
    render: (f) => `✅ [${s(f.site)}] 已重新提交修复 URL：${s(f.count)} 条\n${s(f.body)}`,
  },
  index_sitemap_ok: {
    at: AT_PM_OPS,
    render: (f) => `✅ [${s(f.site)}] sitemap 已刷新：${s(f.url)}`,
  },
  index_sitemap_fail: {
    at: AT_PM_OPS,
    render: (f) => `⚠️ [${s(f.site)}] sitemap 刷新失败：${s(f.url)}（${s(f.err)}）`,
  },
  index_tick_fail: {
    at: AT_OPS,
    // hint 可选：缺省时以「请查看 {log}。」收尾，不留尾巴。
    render: (f) => `⚠️ [${s(f.site)}] 索引监控运行失败（rc=${s(f.rc)}）。请查看 ${s(f.log)}。${f.hint ? s(f.hint) : ''}`,
  },
  raw: {
    at: atFromEnv,
    render: (f) => s(f.text),
  },
};

/**
 * 渲染事件模板（不发送）。导出供测试断言纯文本与 @ 策略。
 * 未知 event → 自描述兜底：把 event 名 + 全部结构化字段序列化进正文（@OPS 让拼写错误
 * 被人看见），绝不落到 raw 的 fields.text（通常为空 → 空文本毒条目）。
 * @returns {{text:string, atPm:boolean, atOps:boolean}}
 */
export function renderTemplate(event, fields = {}) {
  if (!Object.prototype.hasOwnProperty.call(EVENTS, event)) {
    let dump = '';
    try {
      dump = JSON.stringify(fields);
    } catch {
      dump = String(fields);
    }
    return { text: `⚠️ [flow] 未知通知事件（${s(event)}），原始字段：${dump}`, atPm: false, atOps: true };
  }
  const spec = EVENTS[event];
  const at = typeof spec.at === 'function' ? spec.at(fields) : spec.at;
  return { text: spec.render(fields), atPm: !!at.atPm, atOps: !!at.atOps };
}

/**
 * 发送一个事件通知：查表渲染模板 → 事件表决定 @ → sendLark。
 *   · GG_LARK_NOTIFY_SILENCE=1 → 只写 audit（SILENCED）不发送；
 *   · 未知 event → 按 raw 处理并 audit 一条 `WARN unknown-event`；
 *   · fields.chatId 可覆盖目标群（参数 > env GG_LARK_NOTIFY_CHAT_ID > 默认）。
 * 永不 throw；返回 {ok, silenced, messageId, error, text}。
 */
export async function notify(event, fields = {}) {
  try {
    const known = Object.prototype.hasOwnProperty.call(EVENTS, event);
    const rt = renderTemplate(event, fields);
    const chatId = fields.chatId || null;
    const rid = resolveChatId(chatId);
    if (!known) {
      auditLog('WARN unknown-event', rid, `event=${s(event)} ${rt.text}`);
    }
    // 空文本绝不发送也绝不入箱（飞书必拒 → 会变成永远重放失败的毒条目）。
    if (!rt.text.trim()) {
      auditLog('WARN empty-text', rid, `event=${s(event)}`);
      return { ok: false, silenced: false, messageId: null, error: 'empty-text', text: '' };
    }
    if (process.env.GG_LARK_NOTIFY_SILENCE === '1') {
      auditLog('SILENCED', rid, atPrefix(rt.atPm, rt.atOps) + rt.text);
      return { ok: true, silenced: true, messageId: null, error: null, text: rt.text };
    }
    const r = await sendLark(rt.text, { atPm: rt.atPm, atOps: rt.atOps, chatId });
    return { ...r, silenced: false, text: rt.text };
  } catch (e) {
    return { ok: false, silenced: false, messageId: null, error: String((e && e.message) || e), text: '' };
  }
}
