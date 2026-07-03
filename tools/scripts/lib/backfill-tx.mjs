// tools/scripts/lib/backfill-tx.mjs — 回填事务（阶段 4 · 杀"账本漂移"）。
//
// 问题：文章上线后，"回填"（选题登记表 status→已发布+URL、plan 勾选、vault 归档）此前
// 散落在各发布腿、且部分靠"某个会话记得手动跑"（reconcile-status / archive）→ 静默漏写 →
// "已上线未勾选"常驻。本模块把回填下沉成一个确定性事务：
//   1. write-ahead：先把待回填记录写进 vault 外 pending-writeback 队列（崩溃可续）。
//   2. verify-live：sitemap 确认 slug 真上线，才写"已发布"（守 done=live 不变量）。
//   3. 三步幂等回填，各自 try/catch 隔离：Sheet 单行 flip / plan 勾选 / vault 归档。
//   4. 全成清队；任一步失败留队 → 每日 gg-ledger-reconcile drainPending 重试。
// 永不抛：回填失败绝不搞垮发布腿（发布已成功，回填是收尾）。
//
// 契约：状态目录在 vault 外（flow-state），测试用 GG_FLOW_STATE_DIR 指向临时目录。

import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { stateDir } from './flow-state.mjs';
import { getAccessToken } from './gg-shared.mjs';
import { PRODUCTS, flipRowsByPageId } from '../gg-reconcile-status.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCHIVE_BIN = join(__dirname, '..', 'gg-archive-to-vault.mjs');
const SA_DEFAULT = join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
// plan 目录（与 gg-seo-autopilot 的 PLAN_GLOB_DIR 一致）：planPath 传 basename 时在此解析。
const PLAN_DIR = process.env.GG_PLAN_DIR || join(homedir(), 'gengrowth-ops', 'inbox', '06-tasks', 'tasks');

// 每步失败上限：超过则从队列淘汰并告警（防无限重试毒记录）。TTL 7 天兜底。
const MAX_ATTEMPTS = 8;
const TTL_MS = 7 * 24 * 3600 * 1000;

// 各站点 archive 调用参数（gengrowth 需覆盖 host + /en/blog/；两站都需 --oracle，否则 archive
// 默认 /Users/wzb/Code/oracle 本机不存在 → 找不到 hero/inline 图。与 gg-gengrowth-publish 一致）。
const ORACLE_DIR = process.env.GG_ORACLE_DIR || join(homedir(), 'oracle');
const SITE_CFG = {
  astrologywiki: { archive: ['--site', 'astrologywiki', '--oracle', ORACLE_DIR] },
  gengrowth: { archive: ['--site', 'gengrowth', '--site-host', 'https://gengrowth.ai', '--url-path', '/en/blog/', '--oracle', ORACLE_DIR] },
};

export const BACKFILL_STEPS = ['sheet', 'plan', 'archive'];

// ── pending-writeback 队列（vault 外，每 PID 一个 JSON，原子 tmp+rename）────────────
export function writebackDir() {
  try {
    const base = stateDir();
    if (!base) return null;
    const dir = join(base, 'pending-writeback');
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch { return null; }
}

function safeId(pageId) { return String(pageId).replace(/[^A-Za-z0-9._-]/g, '_'); }

export function readWriteback(pageId) {
  const dir = writebackDir(); if (!dir) return null;
  try { return JSON.parse(readFileSync(join(dir, `${safeId(pageId)}.json`), 'utf8')); } catch { return null; }
}

// 写/合并一条待回填记录（write-ahead）。done 取并集（已完成步骤不重跑）；firstAt 粘住；
// attempts/lastError 仅在本次显式传入时覆盖。原子写。失败返回 null（状态层不搞垮业务）。
export function enqueueWriteback(entry) {
  const dir = writebackDir(); if (!dir) return null;
  try {
    const prev = readWriteback(entry.pageId) || {};
    const rec = { ...prev, ...entry };
    rec.firstAt = prev.firstAt || entry.firstAt || new Date().toISOString();
    rec.done = Array.from(new Set([...(prev.done || []), ...(entry.done || [])]));
    if (entry.attempts === undefined) rec.attempts = prev.attempts || 0;
    if (!('lastError' in entry)) rec.lastError = prev.lastError ?? null;
    const p = join(dir, `${safeId(entry.pageId)}.json`);
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n');
    renameSync(tmp, p);
    return rec;
  } catch { return null; }
}

export function resolveWriteback(pageId) {
  const dir = writebackDir(); if (!dir) return false;
  try { unlinkSync(join(dir, `${safeId(pageId)}.json`)); return true; } catch { return false; }
}

// 淘汰（超 attempts/TTL）：**不静默删**，移入 dropped/ 保留供审计/人工补救（评审 CONFIRMED：
// archive 步无对账兜底，若干净删除=该篇静默缺出 RAG）。移动失败退化为删除以免卡队列。
export function dropWriteback(pageId) {
  const dir = writebackDir(); if (!dir) return false;
  try {
    const droppedDir = join(dir, 'dropped');
    mkdirSync(droppedDir, { recursive: true });
    renameSync(join(dir, `${safeId(pageId)}.json`), join(droppedDir, `${safeId(pageId)}.json`));
    return true;
  } catch { return resolveWriteback(pageId); }
}

export function listWriteback() {
  const dir = writebackDir(); if (!dir) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.includes('.tmp-'))
      .map((f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ── verify-live：sitemap 含该 slug 即视为上线（两站 sitemap 均列 slug）。best-effort。──
// deps.verifyLive / deps.fetch 供测试注入。任何异常 → false（宁可留队重试，不误写已发布）。
export async function verifyLive(site, slug, deps = {}) {
  if (deps.verifyLive) { try { return await deps.verifyLive(site, slug); } catch { return false; } }
  const product = PRODUCTS[site];
  if (!product || !slug) return false;
  try {
    const res = await (deps.fetch || fetch)(product.sitemap, { headers: { 'user-agent': 'gg-backfill/1' } });
    if (!res.ok) return false;
    const xml = await res.text();
    for (const m of xml.matchAll(product.slugRe)) { if (m[1] === slug) return true; }
    return false;
  } catch { return false; }
}

// ── plan 勾选（幂等 regex）：- [ ] `PG-XXX` → - [x]。已勾/无文件=no-op 成功。────────
// planPath 支持全路径或 basename（basename 在 PLAN_DIR 下解析）。
function checkPlanBoxFile(planPath, pageId) {
  if (!planPath) return; // 无 plan 视为无需勾（不算失败）
  const p = planPath.includes('/') ? planPath : join(PLAN_DIR, planPath);
  if (!existsSync(p)) return;
  const src = readFileSync(p, 'utf8');
  const out = src.replace(new RegExp(`(^\\s*-\\s*\\[) (\\]\\s*\`?${pageId}\`?)`, 'm'), '$1x$2');
  if (out !== src) writeFileSync(p, out);
}

// ── 单步执行器（幂等；仅跑未 done 的步骤，各步失败隔离）──────────────────────────
async function runSteps(entry, token, deps = {}) {
  const done = new Set(entry.done || []);
  const failed = [];
  // 1. Sheet 单行 flip（选题登记表 status→已发布 + URL）
  if (!done.has('sheet')) {
    try {
      const product = PRODUCTS[entry.site];
      if (!product) throw new Error(`unknown site ${entry.site}`);
      const url = entry.url || (product.urlBase + entry.slug);
      const runFlip = deps.flipRowsByPageId || flipRowsByPageId;
      await runFlip({ product, entries: [{ pageId: entry.pageId, url }], token, apply: true });
      done.add('sheet');
    } catch (e) { failed.push({ step: 'sheet', err: e.message }); }
  }
  // 2. plan 勾选回写
  if (!done.has('plan')) {
    try { (deps.checkPlanBoxFile || checkPlanBoxFile)(entry.planPath, entry.pageId); done.add('plan'); }
    catch (e) { failed.push({ step: 'plan', err: e.message }); }
  }
  // 3. vault 归档
  if (!done.has('archive')) {
    try {
      const cfg = SITE_CFG[entry.site] || SITE_CFG.astrologywiki;
      const runArchive = deps.archive
        || ((args) => execFileSync('node', [ARCHIVE_BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }));
      runArchive(['--pages', `${entry.pageId}:${entry.slug}`, ...cfg.archive]);
      done.add('archive');
    } catch (e) { failed.push({ step: 'archive', err: (e.message || '').slice(0, 300) }); }
  }
  return { done: Array.from(done), failed };
}

// token 获取（写 scope）。deps.token 优先（测试注入，可为 null 模拟无 auth）。失败返回 null。
async function acquireToken(deps = {}) {
  if (deps.token !== undefined) return deps.token;
  try {
    const SA = process.env.GG_WRITER_SA_JSON || SA_DEFAULT;
    const { token } = await getAccessToken(SA, ['https://www.googleapis.com/auth/spreadsheets']);
    return token || null;
  } catch { return null; }
}

// ── 事务主入口（发布腿在 verify-live 语义点调用）──────────────────────────────────
// 入参：{ pageId, slug, site, url?, planPath? }。返回 { ok, done, failed, deferred, reason }。永不抛。
export async function backfillOnLive(input, deps = {}) {
  const { pageId, slug, site } = input || {};
  if (!pageId || !slug || !site || !PRODUCTS[site]) {
    return { ok: false, reason: `invalid backfill input: pageId=${pageId} slug=${slug} site=${site}` };
  }
  // write-ahead：先落队，进程崩溃也能被每日 drain 续上。
  enqueueWriteback({
    pageId, slug, site,
    url: input.url || (PRODUCTS[site].urlBase + slug),
    planPath: input.planPath || null,
    done: [],
  });
  try {
    const token = await acquireToken(deps);
    if (token === null) {
      enqueueWriteback({ pageId, lastError: 'no-token', attempts: (readWriteback(pageId)?.attempts || 0) + 1 });
      return { ok: false, deferred: true, reason: 'sheet auth unavailable — left in pending-writeback' };
    }
    if (!(await verifyLive(site, slug, deps))) {
      enqueueWriteback({ pageId, lastError: 'verify-live pending', attempts: (readWriteback(pageId)?.attempts || 0) + 1 });
      return { ok: false, deferred: true, reason: 'not live in sitemap yet — left in pending-writeback' };
    }
    const cur = readWriteback(pageId) || {};
    const { done, failed } = await runSteps(cur, token, deps);
    if (failed.length === 0) {
      resolveWriteback(pageId);
      return { ok: true, done, failed: [] };
    }
    enqueueWriteback({ pageId, done, attempts: (cur.attempts || 0) + 1, lastError: failed.map((f) => `${f.step}:${f.err}`).join('; ') });
    return { ok: false, done, failed };
  } catch (e) {
    try { enqueueWriteback({ pageId, lastError: `unexpected:${e.message}`, attempts: (readWriteback(pageId)?.attempts || 0) + 1 }); } catch { /* 状态层不搞垮业务 */ }
    return { ok: false, reason: `backfill error (queued): ${e.message}` };
  }
}

// ── drainPending：每日 gg-ledger-reconcile 调用，重试全部待回填。──────────────────
// 返回 { retried, resolved, stillPending, dropped:[{pageId,attempts,lastError}] }。永不抛。
export async function drainPending(deps = {}) {
  const entries = listWriteback();
  const out = { retried: 0, resolved: 0, stillPending: 0, dropped: [] };
  if (!entries.length) return out;
  const token = await acquireToken(deps);
  const now = deps.now || Date.now();
  for (const e of entries) {
    // 淘汰毒记录（超 attempts 或 TTL）→ 移入 dropped/ 保留（不静默删）+ 计入告警。
    // sheet/plan 步有每日对账兜底；archive 步无 → 保留记录让人工可查/补归档。
    const ageMs = now - new Date(e.firstAt || now).getTime();
    if ((e.attempts || 0) >= MAX_ATTEMPTS || ageMs > TTL_MS) {
      const stuck = BACKFILL_STEPS.filter((s) => !(e.done || []).includes(s));
      dropWriteback(e.pageId);
      out.dropped.push({ pageId: e.pageId, attempts: e.attempts || 0, stuck, lastError: e.lastError || null });
      continue;
    }
    out.retried++;
    if (token === null) { out.stillPending++; enqueueWriteback({ pageId: e.pageId, lastError: 'no-token', attempts: (e.attempts || 0) + 1 }); continue; }
    if (!(await verifyLive(e.site, e.slug, deps))) {
      out.stillPending++; enqueueWriteback({ pageId: e.pageId, lastError: 'verify-live pending', attempts: (e.attempts || 0) + 1 }); continue;
    }
    const { done, failed } = await runSteps(e, token, deps);
    if (failed.length === 0) { resolveWriteback(e.pageId); out.resolved++; }
    else { out.stillPending++; enqueueWriteback({ pageId: e.pageId, done, attempts: (e.attempts || 0) + 1, lastError: failed.map((f) => `${f.step}:${f.err}`).join('; ') }); }
  }
  return out;
}
