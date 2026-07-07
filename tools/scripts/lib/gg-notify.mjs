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

import { readFileSync } from 'node:fs';
import { sendLark, sendLarkCard, auditLog, resolveChatId, atPrefix } from './lark-send.mjs';

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

function splitLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function reportPaths(reports) {
  return splitLines(reports).filter((line) => line.startsWith('/'));
}

function cleanTaskLine(line) {
  return String(line || '').replace(/^-\s+/, '').trim();
}

function parseReportSection(text, section) {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`【${escaped}】\\n([\\s\\S]*?)(?=\\n【|$)`);
  const m = String(text || '').match(re);
  if (!m) return [];
  return m[1].split(/\r?\n/).filter((line) => /^-\s+/.test(line)).map(cleanTaskLine);
}

function parseOptimizationReport(text, fallbackSite = '站点') {
  const site = (String(text || '').match(/^#\s+(.+?)\s+博客优化任务清单/m) || [])[1] || fallbackSite;
  return {
    site,
    tech: parseReportSection(text, '技术排查'),
    p0: parseReportSection(text, 'P0 立即处理'),
    p1: parseReportSection(text, 'P1 本周处理'),
    p2: parseReportSection(text, 'P2 下周处理'),
  };
}

function readOptimizationReports(reports) {
  return reportPaths(reports).map((path) => {
    try {
      return parseOptimizationReport(readFileSync(path, 'utf8'), path.split('/').pop() || '报告');
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function attentionSummary(fields) {
  const reports = readOptimizationReports(fields.reports);
  const totals = reports.reduce((acc, report) => {
    acc.tech += report.tech.length;
    acc.p0 += report.p0.length;
    acc.p1 += report.p1.length;
    acc.p2 += report.p2.length;
    return acc;
  }, { tech: 0, p0: 0, p1: 0, p2: 0 });
  return { reports, totals };
}

function attentionMetricColumns(summary) {
  const metrics = [
    { label: 'P0 立即处理', value: summary.totals.p0, color: summary.totals.p0 ? 'red' : 'grey' },
    { label: '技术排查', value: summary.totals.tech, color: summary.totals.tech ? 'orange' : 'grey' },
    { label: 'P1 本周处理', value: summary.totals.p1, color: summary.totals.p1 ? 'orange' : 'grey' },
  ];
  return metrics.map((metric) => ({
    tag: 'column',
    width: 'weighted',
    weight: 1,
    background_style: metric.color === 'red' ? 'red-50' : metric.color === 'orange' ? 'orange-50' : 'grey-50',
    padding: '12px',
    vertical_spacing: '2px',
    elements: [
      {
        tag: 'markdown',
        content: `## <font color='${metric.color}'>${metric.value}</font>`,
        text_align: 'center',
      },
      {
        tag: 'markdown',
        content: `<font color='grey'>${metric.label}</font>`,
        text_align: 'center',
        text_size: 'notation',
      },
    ],
  }));
}

function listTasksBySite(reports, key, limit = 6) {
  const lines = [];
  for (const report of reports) {
    const items = report[key] || [];
    for (const item of items.slice(0, Math.max(0, limit - lines.length))) {
      lines.push(`- **${report.site}**：${item}`);
      if (lines.length >= limit) break;
    }
    if (lines.length >= limit) break;
  }
  return lines.length ? lines.join('\n') : '- 暂无';
}

function siteCountLines(reports, key) {
  const lines = reports.map((report) => `- ${report.site}：${(report[key] || []).length} 个`);
  return lines.length ? lines.join('\n') : '- 暂无报告明细';
}

function formatReportLines(reports) {
  const lines = splitLines(reports);
  if (!lines.length) return '无报告路径';
  return lines.map((line) => `- \`${line}\``).join('\n');
}

function buildRecapPerformanceCard(fields) {
  const date = s(fields.date);
  const summary = attentionSummary(fields);
  const windowNote = s(fields.window_note || fields.windowNote || 'D30/D60 到期后自动补齐；当前未到期列保留 `待回填`。');
  const hasActions = summary.totals.p0 + summary.totals.tech + summary.totals.p1 > 0;
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: `SEO 结果复盘：${hasActions ? '有需要处理的页面' : '暂无优先处理项'}` },
      style: {
        text_size: {
          body: { default: 'normal', pc: 'normal', mobile: 'normal' },
          caption: { default: 'notation', pc: 'notation', mobile: 'notation' },
        },
      },
    },
    header: {
      title: { tag: 'plain_text', content: 'SEO 结果复盘：需要处理' },
      subtitle: { tag: 'plain_text', content: date ? `${date} · 按优先级看结果` : '按优先级看结果' },
      template: hasActions ? 'red' : 'green',
      icon: { tag: 'standard_icon', token: hasActions ? 'warning_colorful' : 'chart_colorful' },
      text_tag_list: [
        { tag: 'text_tag', text: { tag: 'plain_text', content: `P0 ${summary.totals.p0}` }, color: summary.totals.p0 ? 'red' : 'neutral' },
        { tag: 'text_tag', text: { tag: 'plain_text', content: `技术排查 ${summary.totals.tech}` }, color: summary.totals.tech ? 'orange' : 'neutral' },
      ],
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: hasActions
            ? '**先看这些需要人工判断/处理的页面。**\n底层数据已写回表格，但群里只展示要处理的结果。'
            : `**本轮没有 P0/P1/技术排查项。**\n${windowNote}`,
        },
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_spacing: '12px',
          columns: attentionMetricColumns(summary),
        },
        {
          tag: 'markdown',
          content: `**P0 立即处理**\n${listTasksBySite(summary.reports, 'p0', 4)}`,
        },
        {
          tag: 'markdown',
          content: `**技术排查（已收录但零曝光）**\n${siteCountLines(summary.reports, 'tech')}\n\n**抽样**\n${listTasksBySite(summary.reports, 'tech', 4)}`,
        },
        {
          tag: 'markdown',
          content: `**P1 本周处理**\n${listTasksBySite(summary.reports, 'p1', 5)}`,
        },
        {
          tag: 'markdown',
          text_size: 'notation',
          content: `说明：${windowNote}\n报告：${formatReportLines(fields.reports)}\n审计：未发布、未部署、未请求索引；日志 \`${s(fields.log)}\``,
        },
      ],
    },
  };
}

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
  recap_performance_ok: {
    at: AT_NONE,
    render: (f) =>
      `✅ [flow] 结果复盘已同步（${s(f.date)}）\n${s(f.body)}\n报告：\n${s(f.reports)}\n日志：${s(f.log)}`,
    card: buildRecapPerformanceCard,
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
    const spec = known ? EVENTS[event] : null;
    if (spec && typeof spec.card === 'function') {
      const cardResult = await sendLarkCard(spec.card(fields), { chatId, auditText: rt.text });
      if (cardResult.ok) return { ...cardResult, silenced: false, text: rt.text, card: true };
      const fallback = await sendLark(rt.text, { atPm: rt.atPm, atOps: rt.atOps, chatId });
      return { ...fallback, silenced: false, text: rt.text, card: false, cardError: cardResult.error };
    }
    const r = await sendLark(rt.text, { atPm: rt.atPm, atOps: rt.atOps, chatId });
    return { ...r, silenced: false, text: rt.text };
  } catch (e) {
    return { ok: false, silenced: false, messageId: null, error: String((e && e.message) || e), text: '' };
  }
}
