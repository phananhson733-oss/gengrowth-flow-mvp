#!/usr/bin/env node
// gg-batch-summary.mjs — 批次汇总通知（阶段 1 · 通知统一）
//
// 契约（单一事实源）：tools/scripts/lib/NOTIFY-CONTRACT.md 之 `gg-batch-summary` 一节。
//
// 用法：
//   node tools/scripts/gg-batch-summary.mjs --since <ISO> [--site both|astrologywiki|gengrowth]
//        [--urls url1,url2] [--parked "PID:原因,PID2:原因2"] [--date YYYY-MM-DD] [--dry-run]
//
// 数据源：
//   · oracle 侧：claims ledger（路径解析复用 gg-seo-autopilot.mjs 的 OPS 逻辑：
//     GG_OPS_DIR || ~/gengrowth-ops，再 inbox/06-tasks/tasks/.autopilot-claims.json）。
//     取 status=done 且 mergedAt ≥ since 的条目 → slug → {BASE_ASTRO}/en/wiki/<slug>；
//     status=needs_human 且 failedAt ≥ since 计入 parked（原因取 claim.error）。
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
//         3＝notify 调用本身失败（ENOENT／超时／崩溃）——渲染文本已由本层直接入箱兜底。
//         其余异常尽量吞掉并走 exit 0（通知层永不搞垮调用方）。
//
// env 覆盖（测试用）：
//   GG_OPS_DIR                      ledger 沙箱
//   GG_BATCH_SUMMARY_BASE_ASTRO     astrologywiki URL base（默认生产域名）
//   GG_BATCH_SUMMARY_BASE_GENG      gengrowth URL base（默认生产域名）
//   GG_BATCH_SUMMARY_TIMEOUT_MS     单次 HTTP 超时（默认 10000）
//   GG_NOTIFY_BIN                   gg-notify CLI 路径（测试放假 bin 记 argv）
// 已知限制：--parked 用半角逗号分隔条目，reason 含逗号请改用全角逗号或经 ledger 侧传入。

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { outboxWrite } from './lib/flow-state.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 常量（canonical 切 /en/blog/ 后只改这一处） ────────────────────────────────
const ASTRO_ARTICLE_PATH = '/en/wiki/';

const OPS = process.env.GG_OPS_DIR || join(homedir(), 'gengrowth-ops');
const CLAIMS_PATH = join(OPS, 'inbox', '06-tasks', 'tasks', '.autopilot-claims.json');
const BASE_ASTRO = (process.env.GG_BATCH_SUMMARY_BASE_ASTRO || 'https://www.astrologywiki.com').replace(/\/+$/, '');
const BASE_GENG = (process.env.GG_BATCH_SUMMARY_BASE_GENG || 'https://gengrowth.ai').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.GG_BATCH_SUMMARY_TIMEOUT_MS || 10000);
const SITES = ['both', 'astrologywiki', 'gengrowth'];

const USAGE = `用法：gg-batch-summary.mjs --since <ISO> [--site both|astrologywiki|gengrowth] [--urls u1,u2] [--parked "PID:原因,…"] [--date YYYY-MM-DD] [--dry-run]`;

function usageExit(msg) {
  process.stderr.write(`${msg}\n${USAGE}\n`);
  process.exit(1);
}

// ── CLI 解析 ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { since: null, site: 'both', urls: [], parked: [], date: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since') o.since = argv[++i];
    else if (a === '--site') o.site = argv[++i];
    else if (a === '--urls') o.urls = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--parked') o.parked = parseParked(argv[++i]);
    else if (a === '--date') o.date = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else usageExit(`未知参数：${a}`);
  }
  if (!o.since || Number.isNaN(Date.parse(o.since))) usageExit('--since <ISO> 必填且需为合法时间戳');
  if (!SITES.includes(o.site)) usageExit(`--site 只接受 ${SITES.join('|')}`);
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

// ── ledger 读取（缺文件＝空账本；损坏只警告不炸） ──────────────────────────────
function readClaims() {
  if (!existsSync(CLAIMS_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(CLAIMS_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    process.stderr.write(`gg-batch-summary：claims ledger 解析失败（${e.message}），按空账本处理\n`);
    return {};
  }
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
  const k = parked.length;
  const repairControllerOwnsTerminal = process.env.GG_SEO_REPAIR_CONTROLLER_V2_ENABLED === '1';
  const parkedLine = k > 0
    ? `${repairControllerOwnsTerminal ? '自动修复队列' : '暂停待人工'} ${k} 篇：${parked.map((p) => `${p.pid}（${p.reason}）`).join('、')}`
    : null; // k=0 时省略此行
  if (badList.length === 0) {
    const lines = [`✅ [flow] 批次汇总 ${date}：上线 ${n} 篇（已逐篇线上核实）`];
    for (const site of ['astrologywiki', 'gengrowth']) {
      const slugs = okList.filter((r) => r.site === site).map((r) => r.slug);
      if (slugs.length) lines.push(`[${site}] ${slugs.join('、')}`);
    }
    if (parkedLine) lines.push(parkedLine);
    return { text: lines.join('\n'), partial: false };
  }
  const lines = [`⚠️ [flow] 批次汇总 ${date}：${okList.length}/${n} 篇已上线核实，以下未核实到线上：`];
  for (const r of badList) lines.push(`${r.site}/${r.slug}（HTTP ${r.code}）`);
  if (parkedLine) lines.push(parkedLine);
  return { text: lines.join('\n'), partial: true };
}

// ── 发送：spawn gg-notify raw（不 import，CLI 由并行分支构建；@ 策略本层裁决） ──
// gg-notify 自身 fail-closed（发送失败会入 outbox），所以 spawn 成功 + exit 0 即视为
// 「已送达或已入箱」。只有 spawn 本身失败（bin 配错 ENOENT／超时被杀／进程崩溃）时消息
// 才会真正丢——此时本层直接把渲染文本写进 outbox 兜底，main 以 exit 3 报告。
function send(text, partial) {
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
  const r = spawnSync(process.execPath, [bin, 'raw', '--text', text], { encoding: 'utf8', env, timeout: 120000 });
  if (r.error || r.status !== 0) {
    process.stderr.write(`gg-batch-summary：notify 调用异常（${r.error ? r.error.message : `exit ${r.status}`}），渲染文本已直接写入 outbox 待重放\n`);
    if (r.stderr) process.stderr.write(r.stderr);
    outboxWrite({
      text,
      atPm: false,
      atOps: !!partial,
      chatId: null,
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

  const targets = []; // {site, slug, url}
  const parked = [...o.parked]; // {pid, reason}

  // oracle 侧：读 claims ledger
  if (o.site !== 'gengrowth') {
    const claims = readClaims();
    for (const [pid, c] of Object.entries(claims)) {
      if (!c || typeof c !== 'object') continue;
      if (c.status === 'done' && c.slug && c.mergedAt && Date.parse(c.mergedAt) >= sinceMs) {
        targets.push({ site: 'astrologywiki', slug: c.slug, url: `${BASE_ASTRO}${ASTRO_ARTICLE_PATH}${c.slug}` });
      } else if (c.status === 'needs_human' && c.failedAt && Date.parse(c.failedAt) >= sinceMs) {
        parked.push({ pid, reason: c.error || 'needs_human' });
      }
    }
  }

  // gengrowth 侧：--urls 显式传入
  if (o.site !== 'astrologywiki') {
    for (const u of o.urls) targets.push(resolveUrlArg(u));
  }

  // 仅 parked 是恢复中的作者/门状态，不渲染“上线 0 篇”中间消息；真正永久 park
  // 由 auto-retry 入口去重发送终态告警。没有上线 URL 一律静默。
  if (targets.length === 0) {
    process.stderr.write(`gg-batch-summary：窗口内（since=${o.since}）无上线条目，不发送\n`);
    process.exit(2);
  }

  const results = [];
  for (const t of targets) {
    const { ok, code } = await checkUrl(t.url);
    results.push({ ...t, ok, code });
  }

  const { text, partial } = render({ date: o.date, results, parked });
  process.stdout.write(text + '\n');

  if (o.dryRun) {
    process.stderr.write('gg-batch-summary：--dry-run，只渲染不发送\n');
    process.exit(0);
  }

  const sent = send(text, partial);
  // 0＝已送达或已入 gg-notify 的 outbox；3＝notify 调用本身失败（文本已由本层入箱兜底）。
  // 调用方（nightly 等）对本命令 `|| true`，exit 3 不会搞垮 cron，只是让失败可观测。
  process.exit(sent ? 0 : 3);
}

main().catch((e) => {
  process.stderr.write(`gg-batch-summary：异常（${e?.message || e}）\n`);
  process.exit(0);
});
