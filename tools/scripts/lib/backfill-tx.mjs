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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
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
// 5 分钟 reconciler 不能把每个 tick 都算成一次失败：失败后持久化 nextEligibleAt，
// 默认 15m 起步指数退避（15m/30m/1h/.../24h cap），重启后继续遵守。
const MAX_ATTEMPTS = 8;
const TTL_MS = 7 * 24 * 3600 * 1000;
const DEFAULT_BACKOFF_BASE_MS = 15 * 60 * 1000;
const DEFAULT_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;
const LOCK_LEASE_MS = 15 * 60 * 1000;
const TEST_PAGE_ID_RE = /\bPG-(?:TEST|FAKE|FIXTURE|SMOKE)[A-Z0-9-]*\b/;

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

function atomicWriteJson(path, record) {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
  renameSync(tmp, path);
}

function mergeWriteback(prev, entry, timestamp = Date.now()) {
  const rec = { ...prev, ...entry };
  rec.firstAt = prev.firstAt || entry.firstAt || new Date(timestamp).toISOString();
  rec.done = Array.from(new Set([...(prev.done || []), ...(entry.done || [])]));
  if (entry.attempts === undefined) rec.attempts = prev.attempts || 0;
  if (!('lastError' in entry)) rec.lastError = prev.lastError ?? null;
  return rec;
}

function directEnqueueWriteback(entry, timestamp = Date.now()) {
  const dir = writebackDir(); if (!dir) return null;
  try {
    const prev = readWriteback(entry.pageId) || {};
    const rec = mergeWriteback(prev, entry, timestamp);
    const p = join(dir, `${safeId(entry.pageId)}.json`);
    atomicWriteJson(p, rec);
    return rec;
  } catch { return null; }
}

function directReplaceWriteback(entry) {
  const dir = writebackDir(); if (!dir || !entry?.pageId) return null;
  try {
    const path = join(dir, `${safeId(entry.pageId)}.json`);
    atomicWriteJson(path, entry);
    return entry;
  } catch {
    return null;
  }
}

function lockDir() {
  try {
    const base = stateDir();
    if (!base) return null;
    return process.env.GG_WRITEBACK_LOCK_DIR || join(base, 'writeback-ledger.lock');
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function acquireWritebackLock(deps = {}) {
  const dir = lockDir();
  if (!dir) return { ok: false, busy: true, error: 'writeback lock directory unavailable' };
  const now = nowMs(deps);
  const token = randomUUID();
  const owner = {
    pid: process.pid,
    token,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + positiveMs(deps.lockLeaseMs, LOCK_LEASE_MS)).toISOString(),
  };
  try {
    mkdirSync(dir);
    atomicWriteJson(join(dir, 'owner.json'), owner);
    return { ok: true, dir, token };
  } catch {
    let current = null;
    try { current = JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')); } catch {}
    const expiresAt = Date.parse(current?.expiresAt || '');
    if (current && pidAlive(current.pid)) {
      return { ok: false, busy: true, owner: current };
    }
    if (Number.isFinite(expiresAt) && expiresAt > now && current?.pid) {
      return { ok: false, busy: true, owner: current };
    }
    const stale = `${dir}.stale-${Date.now()}-${process.pid}-${token}`;
    try {
      renameSync(dir, stale);
      mkdirSync(dir);
      atomicWriteJson(join(dir, 'owner.json'), owner);
      return { ok: true, dir, token, recovered: true, stale };
    } catch (error) {
      return {
        ok: false,
        busy: true,
        error: String(error?.message || error || 'writeback lock busy'),
      };
    }
  }
}

function releaseWritebackLock(lock) {
  if (!lock?.ok || !lock.dir || !lock.token) return false;
  try {
    const ownerPath = join(lock.dir, 'owner.json');
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    if (owner.token !== lock.token) return false;
    unlinkSync(ownerPath);
    rmdirSync(lock.dir);
    return true;
  } catch {
    return false;
  }
}

function inboxDir() {
  try {
    const base = stateDir();
    if (!base) return null;
    const dir = join(base, 'pending-writeback-inbox');
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

function enqueueInbox(entry, timestamp = Date.now()) {
  const dir = inboxDir();
  if (!dir) return null;
  try {
    const record = mergeWriteback({}, entry, timestamp);
    const path = join(
      dir,
      `${Date.now()}-${process.pid}-${safeId(entry.pageId)}-${randomUUID()}.json`,
    );
    atomicWriteJson(path, record);
    return { ...record, queuedInbox: true };
  } catch {
    return null;
  }
}

function mergeInbox() {
  const dir = inboxDir();
  if (!dir) return 0;
  let merged = 0;
  let names = [];
  try { names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort(); } catch {}
  for (const name of names) {
    const path = join(dir, name);
    try {
      const entry = JSON.parse(readFileSync(path, 'utf8'));
      if (!entry?.pageId || !directEnqueueWriteback(entry)) continue;
      unlinkSync(path);
      merged += 1;
    } catch {}
  }
  return merged;
}

// 写/合并一条待回填记录（write-ahead）。done 取并集（已完成步骤不重跑）；firstAt 粘住；
// attempts/lastError 仅在本次显式传入时覆盖。共享锁忙时写 durable inbox，绝不丢更新。
export function enqueueWriteback(entry, deps = {}) {
  if (!entry?.pageId) return null;
  if (deps.lockToken) return directEnqueueWriteback(entry, nowMs(deps));
  const lock = acquireWritebackLock(deps);
  if (!lock.ok) return enqueueInbox(entry, nowMs(deps));
  try {
    mergeInbox();
    return directEnqueueWriteback(entry, nowMs(deps));
  } finally {
    releaseWritebackLock(lock);
  }
}

function directResolveWriteback(pageId) {
  const dir = writebackDir(); if (!dir) return false;
  try { unlinkSync(join(dir, `${safeId(pageId)}.json`)); return true; } catch { return false; }
}

export function resolveWriteback(pageId, deps = {}) {
  if (deps.lockToken) return directResolveWriteback(pageId);
  const lock = acquireWritebackLock(deps);
  if (!lock.ok) return false;
  try { return directResolveWriteback(pageId); }
  finally { releaseWritebackLock(lock); }
}

function notificationDirs() {
  try {
    const base = stateDir();
    if (!base) return null;
    const root = join(base, 'writeback-notifications');
    const pending = join(root, 'pending');
    const sent = join(root, 'sent');
    mkdirSync(pending, { recursive: true });
    mkdirSync(sent, { recursive: true });
    return { root, pending, sent };
  } catch {
    return null;
  }
}

function notificationUuid(key) {
  const hex = createHash('sha256').update(String(key || '')).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function notificationName(key) {
  return `${createHash('sha256').update(String(key || '')).digest('hex')}.json`;
}

export function persistWritebackNotification(kind, fields, notificationKey, deps = {}) {
  const dirs = notificationDirs();
  if (!dirs || !notificationKey) return null;
  const name = notificationName(notificationKey);
  const pendingPath = join(dirs.pending, name);
  const sentPath = join(dirs.sent, name);
  try {
    if (existsSync(sentPath)) return JSON.parse(readFileSync(sentPath, 'utf8'));
    if (existsSync(pendingPath)) return JSON.parse(readFileSync(pendingPath, 'utf8'));
    const record = {
      schemaVersion: 1,
      kind,
      notificationKey,
      msgUuid: notificationUuid(notificationKey),
      createdAt: new Date(nowMs(deps)).toISOString(),
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
      fields,
    };
    atomicWriteJson(pendingPath, record);
    return record;
  } catch {
    return null;
  }
}

export function listPendingWritebackNotifications() {
  const dirs = notificationDirs();
  if (!dirs) return [];
  try {
    return readdirSync(dirs.pending)
      .filter((name) => name.endsWith('.json') && !name.includes('.tmp-'))
      .sort()
      .map((name) => {
        try {
          return {
            name,
            path: join(dirs.pending, name),
            record: JSON.parse(readFileSync(join(dirs.pending, name), 'utf8')),
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function recordWritebackNotificationFailure(name, record, error, deps = {}) {
  const dirs = notificationDirs();
  if (!dirs) return false;
  try {
    const next = {
      ...record,
      attempts: Math.max(0, Number(record?.attempts) || 0) + 1,
      lastAttemptAt: new Date(nowMs(deps)).toISOString(),
      lastError: String(error?.message || error || 'notification send failed'),
    };
    atomicWriteJson(join(dirs.pending, name), next);
    return true;
  } catch {
    return false;
  }
}

export function markWritebackNotificationSent(name, record, deps = {}) {
  const dirs = notificationDirs();
  if (!dirs) return false;
  try {
    const source = join(dirs.pending, name);
    const destination = join(dirs.sent, name);
    const sent = {
      ...record,
      sentAt: record.sentAt || new Date(nowMs(deps)).toISOString(),
      lastAttemptAt: new Date(nowMs(deps)).toISOString(),
      lastError: null,
    };
    atomicWriteJson(source, sent);
    if (existsSync(destination)) {
      unlinkSync(source);
      return true;
    }
    renameSync(source, destination);
    return true;
  } catch {
    return false;
  }
}

// 淘汰（超 attempts/TTL）：**不静默删**，移入 dropped/ 保留供审计/人工补救（评审 CONFIRMED：
// archive 步无对账兜底，若干净删除=该篇静默缺出 RAG）。移动失败必须保留原 WAL。
export function dropWriteback(pageId, deps = {}, state = 'dropped') {
  const dir = writebackDir(); if (!dir) return false;
  try {
    const droppedDir = join(dir, state);
    mkdirSync(droppedDir, { recursive: true });
    const source = join(dir, `${safeId(pageId)}.json`);
    let destination = join(droppedDir, `${safeId(pageId)}.json`);
    if (existsSync(destination)) {
      const record = JSON.parse(readFileSync(source, 'utf8'));
      const key = record?.terminalNotification?.notificationKey
        || `${state}:${pageId}:${record?.firstAt || ''}:${record?.attempts || 0}`;
      destination = join(
        droppedDir,
        `${safeId(pageId)}--${createHash('sha256').update(key).digest('hex').slice(0, 16)}.json`,
      );
      if (existsSync(destination)) {
        return { ok: false, error: `terminal evidence already exists: ${destination}` };
      }
    }
    const rename = deps.renameWriteback || renameSync;
    rename(source, destination);
    return { ok: true, source, destination };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error || 'writeback archive rename failed'),
    };
  }
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
  if (deps.acquireToken) {
    try { return await deps.acquireToken(); } catch { return null; }
  }
  if (deps.token !== undefined) return deps.token;
  try {
    const SA = process.env.GG_WRITER_SA_JSON || SA_DEFAULT;
    const { token } = await getAccessToken(SA, ['https://www.googleapis.com/auth/spreadsheets']);
    return token || null;
  } catch { return null; }
}

function nowMs(deps = {}) {
  const value = deps.now;
  if (value instanceof Date) return value.getTime();
  if (value !== undefined && value !== null) {
    const parsed = typeof value === 'number' ? value : Date.parse(String(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function positiveMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function backoffMs(attempts, deps = {}) {
  const base = positiveMs(
    deps.backoffBaseMs
      ?? (Number(process.env.GG_WRITEBACK_BACKOFF_BASE_SECONDS) * 1000),
    DEFAULT_BACKOFF_BASE_MS,
  );
  const max = Math.max(base, positiveMs(
    deps.backoffMaxMs
      ?? (Number(process.env.GG_WRITEBACK_BACKOFF_MAX_SECONDS) * 1000),
    DEFAULT_BACKOFF_MAX_MS,
  ));
  const exponent = Math.max(0, Math.min(30, Number(attempts || 1) - 1));
  return Math.min(max, base * (2 ** exponent));
}

function recordFailure(entry, {
  done,
  lastError,
  deps = {},
  lockToken = null,
} = {}) {
  const attempts = Math.max(0, Number(entry?.attempts) || 0) + 1;
  const timestamp = nowMs(deps);
  return enqueueWriteback({
    pageId: entry.pageId,
    ...(done ? { done } : {}),
    attempts,
    lastError,
    nextEligibleAt: new Date(timestamp + backoffMs(attempts, deps)).toISOString(),
  }, { ...deps, lockToken });
}

function terminalReason({ attemptsExceeded, ttlExceeded }) {
  if (attemptsExceeded && ttlExceeded) return 'max-attempts-and-ttl';
  if (attemptsExceeded) return 'max-attempts';
  return 'ttl';
}

function terminalNotification(entry, now, reason) {
  const attempts = Math.max(0, Number(entry.attempts) || 0);
  const firstAt = entry.firstAt || new Date(now).toISOString();
  return {
    pageId: entry.pageId,
    stuckSteps: BACKFILL_STEPS.filter((step) => !(entry.done || []).includes(step)),
    attempts,
    firstAt,
    lastError: entry.lastError || null,
    terminalAt: new Date(now).toISOString(),
    reason,
    notificationKey: `writeback-terminal:${entry.pageId}:${firstAt}:${attempts}`,
  };
}

function testContaminationNotification(entry, now) {
  const firstAt = entry.firstAt || new Date(now).toISOString();
  return {
    pageId: entry.pageId,
    stuckSteps: BACKFILL_STEPS.filter((step) => !(entry.done || []).includes(step)),
    attempts: Math.max(0, Number(entry.attempts) || 0),
    firstAt,
    lastError: 'test-shaped pageId blocked before writeback side effects',
    terminalAt: new Date(now).toISOString(),
    reason: 'test-contamination',
    notificationKey: `writeback-test-contamination:${entry.pageId}:${firstAt}`,
  };
}

function isTestPageId(pageId) {
  return TEST_PAGE_ID_RE.test(String(pageId || '').toUpperCase());
}

function quarantineWriteback(entry, deps = {}, lockToken = null) {
  const now = nowMs(deps);
  const notification = testContaminationNotification(entry, now);
  const sidecar = persistWritebackNotification(
    'writeback_test_contamination',
    notification,
    notification.notificationKey,
    deps,
  );
  if (!sidecar) {
    return {
      ok: false,
      error: 'failed to persist test-contamination notification',
      notification,
    };
  }
  const prepared = enqueueWriteback({
    ...entry,
    pageId: entry.pageId,
    firstAt: notification.firstAt,
    lastError: notification.lastError,
    terminalNotification: notification,
  }, { ...deps, lockToken });
  if (!prepared || prepared.queuedInbox) {
    return {
      ok: false,
      error: 'failed to persist test-contamination WAL',
      notification,
    };
  }
  const archived = dropWriteback(entry.pageId, deps, 'quarantined');
  return {
    ok: archived?.ok === true,
    error: archived?.error || null,
    notification,
    archived,
  };
}

function normalizeSchedule(entry, now, deps = {}, lockToken = null) {
  const reasons = [];
  const original = {
    firstAt: Object.hasOwn(entry, 'firstAt') ? entry.firstAt : null,
    nextEligibleAt: Object.hasOwn(entry, 'nextEligibleAt') ? entry.nextEligibleAt : null,
  };
  const normalized = { ...entry };
  const firstAt = Date.parse(entry.firstAt || '');
  if (!entry.firstAt) {
    normalized.firstAt = new Date(now).toISOString();
  } else if (!Number.isFinite(firstAt)) {
    reasons.push('firstAt-invalid');
    normalized.firstAt = new Date(now).toISOString();
  } else if (firstAt > now + CLOCK_SKEW_TOLERANCE_MS) {
    reasons.push('firstAt-future');
    normalized.firstAt = new Date(now).toISOString();
  }

  const nextEligibleAt = Date.parse(entry.nextEligibleAt || '');
  const maxFuture = now + positiveMs(
    deps.backoffMaxMs
      ?? (Number(process.env.GG_WRITEBACK_BACKOFF_MAX_SECONDS) * 1000),
    DEFAULT_BACKOFF_MAX_MS,
  ) + CLOCK_SKEW_TOLERANCE_MS;
  if (!entry.nextEligibleAt) {
    normalized.nextEligibleAt = null;
  } else if (!Number.isFinite(nextEligibleAt)) {
    reasons.push('nextEligibleAt-invalid');
    normalized.nextEligibleAt = null;
  } else if (nextEligibleAt > maxFuture) {
    reasons.push('nextEligibleAt-too-far');
    normalized.nextEligibleAt = null;
  }

  if (reasons.length === 0 && normalized.firstAt === entry.firstAt
    && normalized.nextEligibleAt === entry.nextEligibleAt) {
    return { entry, reasons: [] };
  }

  if (reasons.length > 0) {
    const anomaly = {
      pageId: entry.pageId,
      reasons,
      original,
      normalized: {
        firstAt: normalized.firstAt,
        nextEligibleAt: normalized.nextEligibleAt,
      },
      observedAt: new Date(now).toISOString(),
      notificationKey: `writeback-schedule-anomaly:${entry.pageId}:${createHash('sha256')
        .update(JSON.stringify(original))
        .digest('hex')
        .slice(0, 16)}`,
    };
    const sidecar = persistWritebackNotification(
      'writeback_schedule_anomaly',
      anomaly,
      anomaly.notificationKey,
      deps,
    );
    if (!sidecar) return { entry, reasons, error: 'failed to persist schedule anomaly notification' };
    normalized.scheduleAnomaly = {
      reasons,
      original,
      normalized: anomaly.normalized,
      observedAt: anomaly.observedAt,
    };
  }
  const persisted = lockToken
    ? directReplaceWriteback(normalized)
    : enqueueWriteback(normalized, deps);
  if (!persisted || persisted.queuedInbox) {
    return { entry, reasons, error: 'failed to persist normalized writeback schedule' };
  }
  return { entry: persisted, reasons };
}

// ── 事务主入口（发布腿在 verify-live 语义点调用）──────────────────────────────────
// 入参：{ pageId, slug, site, url?, planPath? }。返回 { ok, done, failed, deferred, reason }。永不抛。
export async function backfillOnLive(input, deps = {}) {
  const { pageId, slug, site } = input || {};
  if (!pageId || !slug || !site || !PRODUCTS[site]) {
    return { ok: false, reason: `invalid backfill input: pageId=${pageId} slug=${slug} site=${site}` };
  }
  const entry = {
    pageId, slug, site,
    url: input.url || (PRODUCTS[site].urlBase + slug),
    planPath: input.planPath || null,
    done: [],
  };
  const lock = acquireWritebackLock(deps);
  if (!lock.ok) {
    const queued = enqueueInbox(entry, nowMs(deps));
    return {
      ok: false,
      deferred: true,
      reason: queued
        ? 'writeback ledger busy — queued in durable inbox'
        : 'writeback ledger busy and inbox unavailable',
    };
  }
  try {
    mergeInbox();
    // 测试形态 ID 在最入口进入隔离区；不得触发 token/network/Sheet/plan/archive。
    if (isTestPageId(pageId)) {
      const quarantined = quarantineWriteback(entry, deps, lock.token);
      return {
        ok: false,
        quarantined: quarantined.ok,
        reason: quarantined.ok
          ? 'test-shaped pageId quarantined before side effects'
          : quarantined.error,
      };
    }
    // write-ahead：先落队，进程崩溃也能被 drain 续上。
    enqueueWriteback(entry, { ...deps, lockToken: lock.token });
    const token = await acquireToken(deps);
    if (token === null) {
      recordFailure(readWriteback(pageId) || { pageId }, {
        lastError: 'no-token',
        deps,
        lockToken: lock.token,
      });
      return { ok: false, deferred: true, reason: 'sheet auth unavailable — left in pending-writeback' };
    }
    if (!(await verifyLive(site, slug, deps))) {
      recordFailure(readWriteback(pageId) || { pageId }, {
        lastError: 'verify-live pending',
        deps,
        lockToken: lock.token,
      });
      return { ok: false, deferred: true, reason: 'not live in sitemap yet — left in pending-writeback' };
    }
    const cur = readWriteback(pageId) || {};
    const { done, failed } = await runSteps(cur, token, deps);
    if (failed.length === 0) {
      resolveWriteback(pageId, { ...deps, lockToken: lock.token });
      return { ok: true, done, failed: [] };
    }
    recordFailure(cur, {
      done,
      lastError: failed.map((f) => `${f.step}:${f.err}`).join('; '),
      deps,
      lockToken: lock.token,
    });
    return { ok: false, done, failed };
  } catch (e) {
    try {
      recordFailure(readWriteback(pageId) || { pageId }, {
        lastError: `unexpected:${e.message}`,
        deps,
        lockToken: lock.token,
      });
    } catch { /* 状态层不搞垮业务 */ }
    return { ok: false, reason: `backfill error (queued): ${e.message}` };
  } finally {
    mergeInbox();
    releaseWritebackLock(lock);
  }
}

// ── drainPending：每日 gg-ledger-reconcile 调用，重试全部待回填。──────────────────
// 返回 { retried, skipped, resolved, stillPending, dropped, dropErrors }。永不抛。
export async function drainPending(deps = {}) {
  const out = {
    busy: false,
    retried: 0,
    skipped: 0,
    resolved: 0,
    stillPending: 0,
    dropped: [],
    quarantined: [],
    dropErrors: [],
  };
  const lock = acquireWritebackLock(deps);
  if (!lock.ok) return { ...out, busy: true, stillPending: listWriteback().length };
  mergeInbox();
  const entries = listWriteback();
  if (!entries.length) {
    releaseWritebackLock(lock);
    return out;
  }
  const now = nowMs(deps);
  let token;
  let tokenLoaded = false;
  try {
    for (const original of entries) {
      if (isTestPageId(original.pageId)) {
        const quarantined = quarantineWriteback(original, deps, lock.token);
        if (quarantined.ok) out.quarantined.push(quarantined.notification);
        else {
          out.stillPending += 1;
          out.dropErrors.push({
            pageId: original.pageId,
            error: quarantined.error || 'writeback quarantine failed',
          });
        }
        continue;
      }

      const normalized = normalizeSchedule(original, now, deps, lock.token);
      if (normalized.error) {
        out.stillPending += 1;
        out.dropErrors.push({
          pageId: original.pageId,
          error: normalized.error,
        });
        continue;
      }
      const e = normalized.entry;
      // 淘汰毒记录（超 attempts 或 TTL）→ 移入 dropped/ 保留（不静默删）+ durable 告警。
      const ageMs = now - Date.parse(e.firstAt);
      const attemptsExceeded = (e.attempts || 0) >= MAX_ATTEMPTS;
      const ttlExceeded = ageMs >= TTL_MS;
      if (attemptsExceeded || ttlExceeded) {
        const notification = terminalNotification(
          e,
          now,
          terminalReason({ attemptsExceeded, ttlExceeded }),
        );
        const sidecar = persistWritebackNotification(
          'writeback_terminal',
          notification,
          notification.notificationKey,
          deps,
        );
        if (!sidecar) {
          out.stillPending += 1;
          out.dropErrors.push({
            pageId: e.pageId,
            error: 'failed to persist terminal notification sidecar',
          });
          continue;
        }
        const prepared = enqueueWriteback({
          pageId: e.pageId,
          terminalNotification: notification,
        }, { ...deps, lockToken: lock.token });
        if (!prepared || prepared.queuedInbox) {
          out.stillPending += 1;
          out.dropErrors.push({
            pageId: e.pageId,
            error: 'failed to persist terminal notification evidence',
          });
          continue;
        }
        const archived = dropWriteback(e.pageId, deps);
        if (!archived?.ok) {
          out.stillPending += 1;
          out.dropErrors.push({
            pageId: e.pageId,
            error: archived?.error || 'writeback archive rename failed',
          });
          continue;
        }
        out.dropped.push(notification);
        continue;
      }
      const nextEligibleAt = Date.parse(e.nextEligibleAt || '');
      if (Number.isFinite(nextEligibleAt) && nextEligibleAt > now) {
        out.skipped += 1;
        out.stillPending += 1;
        continue;
      }
      out.retried++;
      if (!tokenLoaded) {
        token = await acquireToken(deps);
        tokenLoaded = true;
      }
      if (token === null) {
        out.stillPending++;
        recordFailure(e, { lastError: 'no-token', deps, lockToken: lock.token });
        continue;
      }
      if (!(await verifyLive(e.site, e.slug, deps))) {
        out.stillPending++;
        recordFailure(e, {
          lastError: 'verify-live pending',
          deps,
          lockToken: lock.token,
        });
        continue;
      }
      const { done, failed } = await runSteps(e, token, deps);
      if (failed.length === 0) {
        resolveWriteback(e.pageId, { ...deps, lockToken: lock.token });
        out.resolved++;
      } else {
        out.stillPending++;
        recordFailure(e, {
          done,
          lastError: failed.map((f) => `${f.step}:${f.err}`).join('; '),
          deps,
          lockToken: lock.token,
        });
      }
    }
  } finally {
    mergeInbox();
    releaseWritebackLock(lock);
  }
  return out;
}
