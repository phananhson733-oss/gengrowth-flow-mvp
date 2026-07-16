#!/usr/bin/env node
// gg-batch-summary.mjs — 批次汇总通知（阶段 1 · 通知统一）
//
// 契约（单一事实源）：tools/scripts/lib/NOTIFY-CONTRACT.md 之 `gg-batch-summary` 一节。
//
// 用法：
//   node tools/scripts/gg-batch-summary.mjs --since <ISO> --plan <absolute-plan>
//        --run-id <safe-run-id> [--site both|astrologywiki|gengrowth]
//        [--urls url1,url2] [--parked "PID:原因,PID2:原因2"] [--date YYYY-MM-DD] [--dry-run]
//
// 数据源：
//   · oracle 侧：claims ledger（路径解析复用 gg-seo-autopilot.mjs 的 OPS 逻辑：
//     GG_OPS_DIR || ~/gengrowth-ops，再 inbox/06-tasks/tasks/.autopilot-claims.json）。
//     仅取 pinned plan 内、site 匹配且 mergedAt ≥ since 的 done 条目；
//     controller queue 存在时，只有匹配 site + runId 的 terminal record 可贡献终态。
//   · gengrowth 侧：无 ledger，靠 --urls 显式传入（调用方＝发布器／会话收尾）。
//
// 逐 URL HTTP 核实：HEAD 非 200 回退 GET，10 秒超时，整轮失败重试 1 次，判 200。
// 模板自渲染（LLM 不参与），经 `node gg-notify.mjs raw --text <rendered>` 发送
// （bin 路径 env GG_NOTIFY_BIN 可覆盖；本脚本不 import gg-notify，只 spawn）：
//   · 全 200 → 完成模板（不 @）；
//   · 有缺 → 部分完成模板（发送时对子进程设 GG_LARK_NOTIFY_AT_OPS=1）。
// --dry-run 只打印渲染文本，不发送。
//
// 退出码：0＝已发送或已入 gg-notify 的 outbox（无论完成／部分；--dry-run 同为 0）；
//         2＝窗口内无上线 URL（仅 parked 也不发送）；1＝用法错误；
//         3＝notify 调用本身失败（ENOENT／超时／崩溃）——渲染文本已由本层直接入箱兜底；
//         4＝存在但损坏的 claims/queue 状态或其他未预期异常（fail closed）。
//
// env 覆盖（测试用）：
//   GG_OPS_DIR                      ledger 沙箱
//   GG_BATCH_SUMMARY_BASE_ASTRO     astrologywiki URL base（默认生产域名）
//   GG_BATCH_SUMMARY_BASE_GENG      gengrowth URL base（默认生产域名）
//   GG_BATCH_SUMMARY_TIMEOUT_MS     单次 HTTP 超时（默认 10000）
//   GG_NOTIFY_BIN                   gg-notify CLI 路径（测试放假 bin 记 argv）
// 已知限制：--parked 用半角逗号分隔条目，reason 含逗号请改用全角逗号或经 ledger 侧传入。

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { outboxWrite, stateDir } from './lib/flow-state.mjs';
import { terminalMessageUuid } from './lib/seo-repair-controller.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 常量（canonical 切 /en/blog/ 后只改这一处） ────────────────────────────────
const ASTRO_ARTICLE_PATH = '/en/wiki/';

const OPS = process.env.GG_OPS_DIR || join(homedir(), 'gengrowth-ops');
const CLAIMS_PATH = join(OPS, 'inbox', '06-tasks', 'tasks', '.autopilot-claims.json');
const BASE_ASTRO = (process.env.GG_BATCH_SUMMARY_BASE_ASTRO || 'https://www.astrologywiki.com').replace(/\/+$/, '');
const BASE_GENG = (process.env.GG_BATCH_SUMMARY_BASE_GENG || 'https://gengrowth.ai').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.GG_BATCH_SUMMARY_TIMEOUT_MS || 10000);
const SITES = ['both', 'astrologywiki', 'gengrowth'];

const TERMINAL_STATUSES = new Set(['published', 'archived', 'quarantined', 'human_only']);
const REPAIR_STATUSES = new Set([
  ...TERMINAL_STATUSES,
  'queued',
  'repairing',
  'regating',
  'repair_pending',
  'superseded',
  'migration_hold',
  'recovery_hold',
]);
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const USAGE = `用法：gg-batch-summary.mjs --since <ISO> --plan <absolute-plan> --run-id <safe-run-id> [--site both|astrologywiki|gengrowth] [--urls u1,u2] [--parked "PID:原因,…"] [--date YYYY-MM-DD] [--dry-run]`;

function usageExit(msg) {
  process.stderr.write(`${msg}\n${USAGE}\n`);
  process.exit(1);
}

// ── CLI 解析 ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = {
    since: null,
    site: 'both',
    plan: null,
    runId: null,
    urls: [],
    parked: [],
    date: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since') o.since = argv[++i];
    else if (a === '--site') o.site = argv[++i];
    else if (a === '--plan') o.plan = argv[++i];
    else if (a === '--run-id') o.runId = argv[++i];
    else if (a === '--urls') o.urls = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--parked') o.parked = parseParked(argv[++i]);
    else if (a === '--date') o.date = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else usageExit(`未知参数：${a}`);
  }
  if (!o.since || Number.isNaN(Date.parse(o.since))) usageExit('--since <ISO> 必填且需为合法时间戳');
  if (!SITES.includes(o.site)) usageExit(`--site 只接受 ${SITES.join('|')}`);
  if (!o.plan || !isAbsolute(o.plan) || !existsSync(o.plan)) usageExit('--plan 必填且必须是存在的绝对路径');
  if (!o.runId || !SAFE_RUN_ID.test(o.runId)) usageExit('--run-id 必填且必须是安全 run id');
  if (!o.date) o.date = localDate();
  return o;
}

// `--parked "PID:原因,PID2:原因2"` → [{pid, reason}]。冒号兼容半角／全角。
function parseParked(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const m = item.match(/^([^:：]+)[:：]?(.*)$/);
      // 冒号开头等取不出 pid 的条目：整段当 reason，pid 记 '?'——绝不抛 TypeError
      // （main().catch 会把异常吞成 exit 0，汇总就静默丢了）。
      if (!m) return { pid: '?', reason: item.replace(/^[:：]\s*/, '') || 'needs_human' };
      return { pid: m[1].trim(), reason: (m[2] || '').trim() || 'needs_human' };
    });
}

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── ledger 读取（缺文件＝空账本；存在但损坏＝fail closed） ─────────────────────
function readClaims() {
  if (!existsSync(CLAIMS_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(CLAIMS_PATH, 'utf8'));
    if (!isPlainObject(parsed)) throw new TypeError('claims ledger 根结构无效');
    for (const [pageId, claim] of Object.entries(parsed)) {
      if (!isPlainObject(claim)) throw new TypeError(`claims ledger 条目 ${pageId} 结构无效`);
      if (Object.hasOwn(claim, 'site')
        && (typeof claim.site !== 'string' || !['astrologywiki', 'gengrowth'].includes(claim.site))) {
        throw new TypeError(`claims ledger 条目 ${pageId} site 无效`);
      }
    }
    return parsed;
  } catch (e) {
    if (/claims ledger .*无效/.test(String(e?.message || ''))) throw e;
    throw new Error(`claims ledger 解析失败（${e.message}）`);
  }
}

function readPlanIds(plan) {
  const source = readFileSync(plan, 'utf8');
  return new Set(
    [...source.matchAll(/^\s*-\s*\[[ xX]\]\s*`?(PG-[A-Z0-9]+(?:-[A-Z0-9]+)+)`?/gm)]
      .map((match) => match[1]),
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateRepairRecord(value, name) {
  if (!isPlainObject(value)) throw new TypeError(`repair record ${name} 根结构无效`);
  if (!REPAIR_STATUSES.has(value.status)) throw new TypeError(`repair record ${name} status 无效`);
  if (!isPlainObject(value.event)) throw new TypeError(`repair record ${name} event 无效`);
  if (typeof value.event.pageId !== 'string' || !value.event.pageId.trim()) {
    throw new TypeError(`repair record ${name} pageId 无效`);
  }
  if (value.event.site !== undefined && !['astrologywiki', 'gengrowth'].includes(value.event.site)) {
    throw new TypeError(`repair record ${name} site 无效`);
  }
  if (value.event.runId !== undefined && (typeof value.event.runId !== 'string' || !SAFE_RUN_ID.test(value.event.runId))) {
    throw new TypeError(`repair record ${name} runId 无效`);
  }
  if (value.latestEvent !== undefined) {
    if (!isPlainObject(value.latestEvent)) {
      throw new TypeError(`repair record ${name} latestEvent 结构无效`);
    }
    if (typeof value.latestEvent.pageId !== 'string' || !value.latestEvent.pageId.trim()) {
      throw new TypeError(`repair record ${name} latestEvent pageId 无效`);
    }
    if (!['astrologywiki', 'gengrowth'].includes(value.latestEvent.site)) {
      throw new TypeError(`repair record ${name} latestEvent site 无效`);
    }
    if (typeof value.latestEvent.runId !== 'string' || !SAFE_RUN_ID.test(value.latestEvent.runId)) {
      throw new TypeError(`repair record ${name} latestEvent runId 无效`);
    }
    if (value.latestEvent.pageId !== value.event.pageId || value.latestEvent.site !== value.event.site) {
      throw new TypeError(`repair record ${name} latestEvent owner 无效`);
    }
  }
  if (value.history !== undefined && !Array.isArray(value.history)) {
    throw new TypeError(`repair record ${name} history 无效`);
  }
  return value;
}

function repairQueueDir() {
  if (process.env.GG_SEO_REPAIR_QUEUE_DIR) return process.env.GG_SEO_REPAIR_QUEUE_DIR;
  const base = stateDir();
  return base ? join(base, 'seo-repair-queue') : null;
}

function readRepairRecords() {
  const dir = repairQueueDir();
  if (!dir || !existsSync(dir)) return [];
  const records = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    try {
      const value = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      records.push(validateRepairRecord(value, name));
    } catch (e) {
      if (/repair record .*无效/.test(String(e?.message || ''))) throw e;
      throw new Error(`repair record ${name} 解析失败（${e.message}）`);
    }
  }
  return records;
}

function selectedSite(site, selected) {
  return selected === 'both' || site === selected;
}

function claimSiteAllowed(pid, claim, selected, planIds) {
  if (!planIds.has(pid)) return false;
  const explicit = typeof claim.site === 'string' && claim.site.trim() ? claim.site.trim() : null;
  if (explicit && !selectedSite(explicit, selected)) return false;
  return true;
}

function recordSource(record) {
  if (record?.latestEvent?.runId) return record.latestEvent;
  return record?.event || record?.latestEvent || {};
}

function recordTimestamp(record, source) {
  const matchingTerminalHistory = Array.isArray(record?.history)
    ? [...record.history].reverse().find((entry) => (
      isPlainObject(entry)
      && entry.status === record.status
      && Number.isFinite(Date.parse(entry.at || ''))
    ))
    : null;
  return matchingTerminalHistory?.at
    || record?.updatedAt
    || source?.createdAt
    || null;
}

function scopedTerminalRecords(records, { site, runId, planIds, sinceMs }) {
  return records.filter((record) => {
    if (!TERMINAL_STATUSES.has(record?.status)) return false;
    const source = recordSource(record);
    const ownerSite = record?.event?.site || source?.site || null;
    const pageId = source?.pageId || record?.event?.pageId || '';
    if (!planIds.has(pageId)) return false;
    if (ownerSite && !selectedSite(ownerSite, site)) return false;
    if (source?.runId) return source.runId === runId;
    const timestamp = Date.parse(recordTimestamp(record, source) || '');
    return planIds.has(pageId) && Number.isFinite(timestamp) && timestamp >= sinceMs;
  });
}

// ── 目标 URL 归一：--urls 支持完整 URL 或裸 slug（裸值按 gengrowth 博客拼） ──────
function resolveUrlArg(u) {
  if (/^https?:\/\//i.test(u)) {
    const slug = u.replace(/\/+$/, '').split('/').pop() || u;
    const site = /astrologywiki/i.test(u) ? 'astrologywiki' : 'gengrowth';
    return { site, slug, url: u };
  }
  const path = u.startsWith('/') ? u : `/en/blog/${u}`;
  const slug = path.replace(/\/+$/, '').split('/').pop() || u;
  return { site: 'gengrowth', slug, url: `${BASE_GENG}${path}` };
}

// ── HTTP 核实：HEAD 非 200 回退 GET；整轮（HEAD＋GET）失败重试 1 次 ─────────────
async function checkUrl(url) {
  let last = 'ERR';
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const method of ['HEAD', 'GET']) {
      try {
        const res = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
        try { await res.body?.cancel(); } catch { /* body 不重要 */ }
        if (res.status === 200) return { ok: true, code: 200 };
        last = res.status;
      } catch {
        last = 'ERR'; // 网络错误／超时：无状态码
      }
    }
  }
  return { ok: false, code: last };
}

// ── 模板渲染（契约 batch_summary 固定模板，LLM 不参与） ────────────────────────
function render({ date, results, parked }) {
  const okList = results.filter((r) => r.ok);
  const badList = results.filter((r) => !r.ok);
  const n = results.length;
  const terminalStops = parked.filter((item) => item.terminal);
  const recoveryParks = parked.filter((item) => !item.terminal);
  const k = recoveryParks.length;
  const repairControllerOwnsTerminal = process.env.GG_SEO_REPAIR_CONTROLLER_V2_ENABLED === '1';
  const parkedLine = k > 0
    ? `${repairControllerOwnsTerminal ? '自动修复队列' : '暂停待人工'} ${k} 篇：${recoveryParks.map((p) => `${p.pid}（${p.reason}）`).join('、')}`
    : null; // k=0 时省略此行
  const terminalLine = terminalStops.length > 0
    ? `终态停止 ${terminalStops.length} 篇：${terminalStops.map((p) => `${p.pid}（${p.reason}）`).join('、')}`
    : null;
  if (badList.length === 0 && terminalStops.length === 0) {
    const lines = [`✅ [flow] 批次汇总 ${date}：上线 ${n} 篇（已逐篇线上核实）`];
    for (const site of ['astrologywiki', 'gengrowth']) {
      const slugs = okList.filter((r) => r.site === site).map((r) => r.slug);
      if (slugs.length) lines.push(`[${site}] ${slugs.join('、')}`);
    }
    if (parkedLine) lines.push(parkedLine);
    return { text: lines.join('\n'), partial: false };
  }
  const lines = badList.length > 0
    ? [`⚠️ [flow] 批次汇总 ${date}：${okList.length}/${n} 篇已上线核实，以下未核实到线上：`]
    : [`⚠️ [flow] 批次汇总 ${date}：上线 ${okList.length} 篇，另有终态停止`];
  for (const site of ['astrologywiki', 'gengrowth']) {
    const slugs = okList.filter((r) => r.site === site).map((r) => r.slug);
    if (slugs.length) lines.push(`[${site}] ${slugs.join('、')}`);
  }
  for (const r of badList) lines.push(`${r.site}/${r.slug}（HTTP ${r.code}）`);
  if (parkedLine) lines.push(parkedLine);
  if (terminalLine) lines.push(terminalLine);
  return { text: lines.join('\n'), partial: true };
}

// ── 发送：spawn gg-notify raw（不 import，CLI 由并行分支构建；@ 策略本层裁决） ──
// gg-notify 自身 fail-closed（发送失败会入 outbox），所以 spawn 成功 + exit 0 即视为
// 「已送达或已入箱」。只有 spawn 本身失败（bin 配错 ENOENT／超时被杀／进程崩溃）时消息
// 才会真正丢——此时本层直接把渲染文本写进 outbox 兜底，main 以 exit 3 报告。
function send(text, partial, msgUuid, idempotencyKey) {
  const bin = process.env.GG_NOTIFY_BIN || join(__dirname, 'gg-notify.mjs');
  const env = { ...process.env };
  // 完成模板不 @；先清掉父环境可能泄漏的 @ 开关，部分完成再显式设 OPS。
  delete env.GG_LARK_NOTIFY_AT_OPS;
  delete env.GG_LARK_NOTIFY_AT_PM;
  delete env.GG_LARK_NOTIFY_AT_OPERATOR;
  // SILENCE 也必须清洗：批次会话 export GG_LARK_NOTIFY_SILENCE=1 静默逐篇通知时，
  // 汇总是唯一不该被静默的消息——不清会把整批的最后一条也吞掉（评审实测复现）。
  delete env.GG_LARK_NOTIFY_SILENCE;
  if (partial) env.GG_LARK_NOTIFY_AT_OPS = '1';
  const r = spawnSync(process.execPath, [bin, 'raw', '--text', text, '--msgUuid', msgUuid], {
    encoding: 'utf8',
    env,
    timeout: 120000,
  });
  if (r.error || r.status !== 0) {
    process.stderr.write(`gg-batch-summary：notify 调用异常（${r.error ? r.error.message : `exit ${r.status}`}），渲染文本已直接写入 outbox 待重放\n`);
    if (r.stderr) process.stderr.write(r.stderr);
    outboxWrite({
      text,
      atPm: false,
      atOps: !!partial,
      chatId: null,
      msgUuid,
      idempotencyKey,
      createdAt: new Date().toISOString(),
      attempts: 0,
      lastError: r.error ? `notify-spawn:${r.error.message}` : `notify-exit:${r.status}`,
    });
    return false;
  }
  return true;
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
async function main() {
  const o = parseArgs(process.argv.slice(2));
  const sinceMs = Date.parse(o.since);
  const planIds = readPlanIds(o.plan);
  const repairRecords = readRepairRecords();
  const terminalRecords = scopedTerminalRecords(repairRecords, {
    site: o.site,
    runId: o.runId,
    planIds,
    sinceMs,
  });

  const targets = []; // {site, slug, url}
  const parked = [...o.parked]; // {pid, reason}

  // oracle 侧：读 claims ledger
  if (o.site !== 'gengrowth') {
    const claims = readClaims();
    for (const [pid, c] of Object.entries(claims)) {
      if (!c || typeof c !== 'object') continue;
      if (!claimSiteAllowed(pid, c, o.site, planIds)) continue;
      if (c.status === 'done' && c.slug && c.mergedAt && Date.parse(c.mergedAt) >= sinceMs) {
        const targetSite = c.site === 'gengrowth' ? 'gengrowth' : 'astrologywiki';
        targets.push({
          site: targetSite,
          slug: c.slug,
          url: targetSite === 'gengrowth'
            ? `${BASE_GENG}/en/blog/${c.slug}`
            : `${BASE_ASTRO}${ASTRO_ARTICLE_PATH}${c.slug}`,
        });
      } else if (repairRecords.length === 0
        && c.status === 'needs_human'
        && c.failedAt
        && Date.parse(c.failedAt) >= sinceMs) {
        parked.push({ pid, reason: c.error || 'needs_human' });
      }
    }
  }

  // gengrowth 侧：--urls 显式传入
  if (o.site !== 'astrologywiki') {
    for (const u of o.urls) targets.push(resolveUrlArg(u));
  }

  for (const record of terminalRecords) {
    const source = recordSource(record);
    const pageId = source.pageId || record.event?.pageId || '?';
    const terminalSite = record.event?.site || source.site || o.site;
    const slug = source.slug || record.event?.slug || '';
    if (record.status === 'published' && slug) {
      targets.push({
        site: terminalSite,
        slug,
        url: terminalSite === 'gengrowth'
          ? `${BASE_GENG}/en/blog/${slug}`
          : `${BASE_ASTRO}${ASTRO_ARTICLE_PATH}${slug}`,
      });
    } else {
      parked.push({ pid: pageId, reason: record.status, terminal: true });
    }
  }

  const uniqueTargets = [...new Map(targets.map((target) => [`${target.site}:${target.slug}`, target])).values()];
  const uniqueParked = [...new Map(parked.map((item) => [`${item.pid}:${item.reason}:${item.terminal ? 'terminal' : 'recovery'}`, item])).values()];
  const hasTerminalStop = uniqueParked.some((item) => item.terminal);

  // 仅 parked 是恢复中的作者/门状态，不渲染“上线 0 篇”中间消息；真正永久 park
  // 由 auto-retry 入口去重发送终态告警。没有上线 URL 一律静默。
  if (uniqueTargets.length === 0 && !hasTerminalStop) {
    process.stderr.write(`gg-batch-summary：窗口内（since=${o.since}）无上线条目，不发送\n`);
    process.exit(2);
  }

  const results = [];
  for (const t of uniqueTargets) {
    const { ok, code } = await checkUrl(t.url);
    results.push({ ...t, ok, code });
  }

  const { text, partial } = render({ date: o.date, results, parked: uniqueParked });
  process.stdout.write(text + '\n');

  if (o.dryRun) {
    process.stderr.write('gg-batch-summary：--dry-run，只渲染不发送\n');
    process.exit(0);
  }

  const idempotencyKey = `batch-terminal:${o.runId}`;
  const sent = send(text, partial, terminalMessageUuid(idempotencyKey), idempotencyKey);
  // 0＝已送达或已入 gg-notify 的 outbox；3＝notify 调用本身失败（文本已由本层入箱兜底）。
  process.exit(sent ? 0 : 3);
}

main().catch((e) => {
  process.stderr.write(`gg-batch-summary：异常（${e?.message || e}）\n`);
  process.exit(4);
});
