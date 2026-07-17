#!/usr/bin/env node
// Ledger convergence. Legacy mode stays best-effort/text; --strict --json performs
// an apply pass followed by an independent read-only verification pass.

import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BACKFILL_STEPS,
  drainPending,
  listWriteback,
  listPendingWritebackNotifications,
  markWritebackNotificationSent,
  persistWritebackNotification,
  recordWritebackNotificationFailure,
} from './lib/backfill-tx.mjs';
import { getAccessToken, gFetch, loadEnv } from './lib/gg-shared.mjs';
import { notify } from './lib/gg-notify.mjs';
import { PRODUCTS, PAGES_TAB, PUBLISHED, workbookId } from './gg-reconcile-status.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const HOME = homedir();
const FLOW = process.env.GG_FLOW_REPO || resolve(dirname(SCRIPT), '../..');
const OPS = process.env.GG_OPS_DIR || join(HOME, 'gengrowth-ops');
const PLAN_DIR = process.env.GG_PLAN_DIR || join(OPS, 'inbox-maboyang', '06-tasks', 'tasks');
const CLAIMS_PATH = process.env.GG_SEO_CLAIMS || join(PLAN_DIR, '.autopilot-claims.json');
const SCRIPTS = join(FLOW, 'tools', 'scripts');
const AUTOPILOT = join(SCRIPTS, 'gg-seo-autopilot.mjs');
const RECONCILE_STATUS = join(SCRIPTS, 'gg-reconcile-status.mjs');
const COUNTER_FIELDS = [
  'pendingWritebackAfter',
  'droppedWritebackAfter',
  'sheetFlipsAfter',
  'planUncheckedAfter',
  'activeRepairAfter',
  'expiredLeasesAfter',
  'eligibleNeedsHumanAfter',
];
const ACTIVE_REPAIR = new Set(['queued', 'repairing', 'regating', 'repair_pending']);
const ACTIVE_CLAIMS = new Set(['active', 'pushed-preview', 'verified-preview', 'authored']);
const CLAIM_TERMINALS = new Set(['quarantined', 'human_only', 'archived', 'published']);

function runNode(bin, argv, timeoutMs = 300_000) {
  const result = spawnSync('node', [bin, ...argv], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  });
  const ok = !result.error && result.status === 0;
  return {
    ok,
    out: String(result.stdout || ''),
    errOut: String(result.stderr || ''),
    error: ok
      ? null
      : String(result.error?.message || `exit ${result.status}`).slice(0, 300),
  };
}

function strictObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} root must be an object`);
  }
  return value;
}

function loadClaimsStrict(path = CLAIMS_PATH) {
  if (!existsSync(path)) throw new Error(`claims ledger missing: ${path}`);
  const claims = strictObject(JSON.parse(readFileSync(path, 'utf8')), 'claims');
  for (const [pageId, claim] of Object.entries(claims)) {
    strictObject(claim, `claim ${pageId}`);
  }
  return claims;
}

function planPath(name) {
  return String(name || '').includes('/') ? String(name) : join(PLAN_DIR, String(name || ''));
}

function uncheckedDoneClaims(claims) {
  let count = 0;
  for (const [pageId, claim] of Object.entries(claims)) {
    if (!claim || claim.status !== 'done' || !claim.plan) continue;
    const path = planPath(claim.plan);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, 'utf8');
    if (new RegExp(`^\\s*-\\s*\\[ \\]\\s*\`?${pageId}\`?\\b`, 'm').test(source)) count += 1;
  }
  return count;
}

function sweepPlanBoxes(claims, apply) {
  let checked = 0;
  const byPlan = new Map();
  for (const [pageId, claim] of Object.entries(claims)) {
    if (!claim || claim.status !== 'done' || !claim.plan) continue;
    const list = byPlan.get(claim.plan) || [];
    list.push(pageId);
    byPlan.set(claim.plan, list);
  }
  for (const [name, pageIds] of byPlan) {
    const path = planPath(name);
    if (!existsSync(path)) continue;
    let source = readFileSync(path, 'utf8');
    let changed = false;
    for (const pageId of pageIds) {
      const next = source.replace(
        new RegExp(`(^\\s*-\\s*\\[) (\\]\\s*\`?${pageId}\`?)`, 'm'),
        '$1x$2',
      );
      if (next !== source) {
        source = next;
        changed = true;
        checked += 1;
      }
    }
    if (changed && apply) writeFileSync(path, source);
  }
  return checked;
}

function blogPlanFiles() {
  try {
    return readdirSync(PLAN_DIR)
      .filter((name) => /blog-output-plan.*\.md$/.test(name))
      .map((name) => join(PLAN_DIR, name));
  } catch {
    return [];
  }
}

async function sweepPlanBoxesBySheet(token, apply, strict = false) {
  let checked = 0;
  const files = blogPlanFiles();
  if (files.length === 0) return 0;
  for (const key of Object.keys(PRODUCTS)) {
    let pageIds = [];
    try {
      const wb = workbookId(PRODUCTS[key]);
      const sheet = `${PAGES_TAB}!A1:AZ`;
      const got = await gFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${wb}/values/${encodeURIComponent(sheet)}?majorDimension=ROWS`,
        token,
      );
      const rows = got.values || [];
      const header = rows[0] || [];
      const statusIndex = header.findIndex((cell) => /^Status$/i.test(String(cell || '').trim()));
      const pageIndex = header.findIndex((cell) => /page_id/i.test(String(cell || '').trim()));
      if (statusIndex < 0 || pageIndex < 0) continue;
      pageIds = rows.slice(1)
        .filter((row) => String(row[statusIndex] || '').trim() === PUBLISHED)
        .map((row) => String(row[pageIndex] || '').trim())
        .filter(Boolean);
    } catch (error) {
      if (strict) throw new Error(`${key}: ${error.message}`);
      continue;
    }
    for (const pageId of pageIds) {
      for (const path of files) {
        let source;
        try { source = readFileSync(path, 'utf8'); } catch { continue; }
        const next = source.replace(
          new RegExp(`(^\\s*-\\s*\\[) (\\]\\s*\`?${pageId}\`?)`, 'm'),
          '$1x$2',
        );
        if (next !== source) {
          if (apply) writeFileSync(path, next);
          checked += 1;
          break;
        }
      }
    }
  }
  return checked;
}

function flowStateRoot() {
  return process.env.GG_FLOW_STATE_DIR || join(HOME, 'gengrowth-agents', 'flow-state');
}

function inspectWriteback(errors, base) {
  let count = 0;
  for (const [directory, label] of [
    ['pending-writeback', 'writeback'],
    ['pending-writeback-inbox', 'writeback inbox'],
  ]) {
    const dir = join(base, directory);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json') || name.includes('.tmp-')) continue;
      try {
        strictObject(JSON.parse(readFileSync(join(dir, name), 'utf8')), `${label} ${name}`);
        count += 1;
      } catch (error) {
        errors.push(`${label} ${name}: ${error.message}`);
        count += 1;
      }
    }
  }
  return count;
}

function writebackTerminalEvidence(record, state, name) {
  const terminal = record.terminalNotification;
  const evidence = terminal && typeof terminal === 'object' && !Array.isArray(terminal)
    ? terminal
    : {};
  return {
    pageId: String(evidence.pageId || record.pageId || name.replace(/\.json$/i, '')),
    state,
    stuckSteps: Array.isArray(evidence.stuckSteps)
      ? evidence.stuckSteps.map(String)
      : BACKFILL_STEPS.filter((step) => !(record.done || []).includes(step)),
    attempts: Math.max(0, Number(evidence.attempts ?? record.attempts) || 0),
    firstAt: evidence.firstAt || record.firstAt || null,
    lastError: evidence.lastError ?? record.lastError ?? null,
    ...(evidence.terminalAt ? { terminalAt: evidence.terminalAt } : {}),
    ...(evidence.reason ? { reason: evidence.reason } : {}),
    ...(evidence.notificationKey ? { notificationKey: evidence.notificationKey } : {}),
  };
}

function inspectTerminalWriteback(errors, base) {
  const root = join(base, 'pending-writeback');
  const evidence = [];
  for (const state of ['dropped', 'quarantined']) {
    const dir = join(root, state);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((item) => item.endsWith('.json')).sort()) {
      try {
        const record = strictObject(
          JSON.parse(readFileSync(join(dir, name), 'utf8')),
          `${state} writeback ${name}`,
        );
        evidence.push(writebackTerminalEvidence(record, state, name));
      } catch (error) {
        errors.push(`${state} writeback ${name}: ${error.message}`);
        evidence.push({
          pageId: name.replace(/\.json$/i, ''),
          state,
          stuckSteps: [...BACKFILL_STEPS],
          attempts: 0,
          firstAt: null,
          lastError: `unreadable terminal writeback: ${error.message}`,
        });
      }
    }
  }
  return { count: evidence.length, evidence };
}

function inspectRepairState(claims, errors, base, now = new Date()) {
  let activeRepairAfter = 0;
  let expiredLeasesAfter = 0;
  const terminalPageIds = new Set();
  const terminalOwners = new Set();
  const terminalPageTimes = new Map();
  const terminalOwnerTimes = new Map();
  const queue = process.env.GG_SEO_REPAIR_QUEUE_DIR
    || join(base, 'seo-repair-queue');
  if (queue && existsSync(queue)) {
    for (const name of readdirSync(queue)) {
      if (!name.endsWith('.json')) continue;
      try {
        const record = strictObject(
          JSON.parse(readFileSync(join(queue, name), 'utf8')),
          `repair ${name}`,
        );
        if (!record.event || typeof record.event !== 'object' || !record.status) {
          throw new TypeError('event/status required');
        }
        const source = record.latestEvent || record.event;
        if (!source || typeof source !== 'object' || Array.isArray(source)
          || !source.site || !source.pageId) {
          throw new TypeError('repair event owner required');
        }
        if (record.latestEvent) {
          if (!record.latestEvent.runId) {
            throw new TypeError('latestEvent owner and runId required');
          }
          if (record.latestEvent.site !== record.event.site
            || record.latestEvent.pageId !== record.event.pageId) {
            throw new TypeError('latestEvent owner conflicts with event owner');
          }
        }
        if (CLAIM_TERMINALS.has(record.status)) {
          const terminalRaw = record.latestEvent?.createdAt ?? record.updatedAt;
          let terminalAt = null;
          if (terminalRaw !== undefined && terminalRaw !== null) {
            terminalAt = Date.parse(terminalRaw);
            if (!Number.isFinite(terminalAt)) {
              throw new TypeError('terminal timestamp invalid');
            }
          }
          const ownerKey = `${source.site}\u0000${source.pageId}`;
          terminalPageIds.add(source.pageId);
          terminalOwners.add(ownerKey);
          if (terminalAt !== null) {
            terminalPageTimes.set(
              source.pageId,
              Math.max(terminalPageTimes.get(source.pageId) || 0, terminalAt),
            );
            terminalOwnerTimes.set(
              ownerKey,
              Math.max(terminalOwnerTimes.get(ownerKey) || 0, terminalAt),
            );
          }
        }
        if (ACTIVE_REPAIR.has(record.status)) {
          activeRepairAfter += 1;
          if (record.lease !== null && record.lease !== undefined) {
            if (!record.lease || typeof record.lease !== 'object'
              || !record.lease.expiresAt
              || !Number.isFinite(Date.parse(record.lease.expiresAt))) {
              errors.push(`repair ${name}: lease missing or invalid`);
              expiredLeasesAfter += 1;
            } else if (Date.parse(record.lease.expiresAt) <= now.getTime()) {
              expiredLeasesAfter += 1;
            }
          }
        }
      } catch (error) {
        errors.push(`repair ${name}: ${error.message}`);
        activeRepairAfter += 1;
      }
    }
  }
  for (const claim of Object.values(claims)) {
    if (!claim || typeof claim !== 'object') continue;
    if (ACTIVE_CLAIMS.has(claim.status) && claim.leaseUntil) {
      if (!Number.isFinite(Date.parse(claim.leaseUntil))) {
        errors.push('claim lease missing or invalid');
        expiredLeasesAfter += 1;
      } else if (Date.parse(claim.leaseUntil) <= now.getTime()) {
        expiredLeasesAfter += 1;
      }
    }
  }
  return {
    activeRepairAfter,
    expiredLeasesAfter,
    terminalPageIds,
    terminalOwners,
    terminalPageTimes,
    terminalOwnerTimes,
  };
}

function terminalCoversClaim(repair, pageId, claim, errors) {
  const ownerKey = claim.site ? `${claim.site}\u0000${pageId}` : null;
  const present = ownerKey
    ? repair.terminalOwners.has(ownerKey)
    : repair.terminalPageIds.has(pageId);
  if (!present) return false;
  if (!Object.hasOwn(claim, 'failedAt') || claim.failedAt === null) return true;
  const failedAt = Date.parse(claim.failedAt);
  if (!Number.isFinite(failedAt)) {
    errors.push(`claim ${pageId}: failedAt invalid`);
    return false;
  }
  const terminalAt = ownerKey
    ? repair.terminalOwnerTimes.get(ownerKey)
    : repair.terminalPageTimes.get(pageId);
  return Number.isFinite(terminalAt) && terminalAt >= failedAt;
}

async function defaultApply({ apply, log }) {
  const errors = [];
  const summary = [];
  let drain = {
    retried: 0,
    skipped: 0,
    resolved: 0,
    stillPending: listWriteback().length,
    dropped: [],
    dropErrors: [],
  };
  if (apply) {
    try { drain = await drainPending(); }
    catch (error) { errors.push(`drainPending: ${error.message}`); }
  }
  log(`1. drainPending: retried=${drain.retried || 0} skipped=${drain.skipped || 0} resolved=${drain.resolved || 0} stillPending=${drain.stillPending || 0} dropped=${drain.dropped?.length || 0} dropErrors=${drain.dropErrors?.length || 0}`);
  if (drain.resolved) summary.push(`回填补写 ${drain.resolved} 篇`);
  if (drain.dropped?.length) {
    summary.push(`⚠️回填淘汰 ${drain.dropped.length} 篇`);
  }
  if (drain.dropErrors?.length) {
    for (const item of drain.dropErrors) {
      errors.push(`dropWriteback ${item.pageId}: ${item.error}`);
    }
  }

  let reconciled = 0;
  if (apply) {
    const result = runNode(AUTOPILOT, ['--reconcile-published']);
    reconciled = (`${result.out}\n${result.errOut}`.match(/^\[autopilot\] PUBLISHED PG-/gim) || []).length;
    if (!result.ok) errors.push(`reconcile-published: ${result.error}`);
  }
  log(`2. reconcile-published: ${apply ? `reconciled=${reconciled}` : 'skipped (--dry)'}`);
  if (reconciled) summary.push(`ledger 对账修正 ${reconciled} 项`);

  const status = runNode(RECONCILE_STATUS, [
    '--product',
    'astrologywiki,gengrowth',
    apply ? '--apply' : '--dry',
  ]);
  const flips = (status.out.match(/^\s*FLIP\s+/gim) || []).length;
  if (!status.ok) errors.push(`reconcile-status: ${status.error}`);
  log(`3. reconcile-status: ${status.ok ? `ok flips=${flips}` : `ERR ${status.error}`}`);
  if (flips) summary.push(`选题登记表补 flip ${flips} 行`);

  let claims = {};
  try { claims = loadClaimsStrict(); }
  catch (error) { errors.push(`claims: ${error.message}`); }
  let planChecked = 0;
  try { planChecked = sweepPlanBoxes(claims, apply); }
  catch (error) { errors.push(`plan-sweep: ${error.message}`); }
  log(`4. plan-sweep: checked=${planChecked}${apply ? '' : ' (dry)'}`);
  if (planChecked && apply) summary.push(`plan 补勾 ${planChecked} 项`);

  let sheetChecked = 0;
  if (apply && blogPlanFiles().length > 0) {
    try {
      const serviceAccount = process.env.GG_WRITER_SA_JSON
        || join(HOME, '.config', 'gg', 'gg-writer-sa.json');
      const { token } = await getAccessToken(serviceAccount, [
        'https://www.googleapis.com/auth/spreadsheets.readonly',
      ]);
      sheetChecked = await sweepPlanBoxesBySheet(token, true, false);
    } catch (error) {
      errors.push(`sheet-plan: ${error.message}`);
    }
  }
  log(`4b. plan-sweep(sheet-driven): checked=${sheetChecked}`);
  if (sheetChecked) summary.push(`plan 补勾(无claim已上线) ${sheetChecked} 项`);
  for (const error of errors) summary.push(`⚠️${error}`);
  return {
    errors,
    summary,
    claims,
    terminalNotifications: drain.dropped || [],
  };
}

async function defaultVerify({ log }) {
  const errors = [];
  const base = flowStateRoot();
  if (!existsSync(base)) errors.push(`flow-state missing: ${base}`);
  let claims = {};
  try { claims = loadClaimsStrict(); }
  catch (error) { errors.push(`claims: ${error.message}`); }

  const status = runNode(RECONCILE_STATUS, [
    '--product',
    'astrologywiki,gengrowth',
    '--dry',
  ]);
  const sheetFlipsAfter = (status.out.match(/^\s*FLIP\s+/gim) || []).length;
  if (!status.ok) errors.push(`reconcile-status verify: ${status.error}`);
  let sheetPlanUncheckedAfter = 0;
  if (blogPlanFiles().length > 0) {
    try {
      const serviceAccount = process.env.GG_WRITER_SA_JSON
        || join(HOME, '.config', 'gg', 'gg-writer-sa.json');
      const { token } = await getAccessToken(serviceAccount, [
        'https://www.googleapis.com/auth/spreadsheets.readonly',
      ]);
      sheetPlanUncheckedAfter = await sweepPlanBoxesBySheet(token, false, true);
    } catch (error) {
      errors.push(`sheet-plan verify: ${error.message}`);
    }
  }
  const repair = inspectRepairState(claims, errors, base);
  const terminalWriteback = inspectTerminalWriteback(errors, base);
  const result = {
    pendingWritebackAfter: inspectWriteback(errors, base),
    droppedWritebackAfter: terminalWriteback.count,
    droppedWritebackEvidence: terminalWriteback.evidence,
    sheetFlipsAfter,
    planUncheckedAfter: uncheckedDoneClaims(claims) + sheetPlanUncheckedAfter,
    activeRepairAfter: repair.activeRepairAfter,
    expiredLeasesAfter: repair.expiredLeasesAfter,
    eligibleNeedsHumanAfter: Object.entries(claims)
      .filter(([pageId, claim]) => claim
        && claim.status === 'needs_human'
        && !terminalCoversClaim(repair, pageId, claim, errors)).length,
    errors,
  };
  log(`verify: ${COUNTER_FIELDS.map((field) => `${field}=${result[field]}`).join(' ')} errors=${errors.length}`);
  return result;
}

function normalizeResult(value, inheritedErrors = []) {
  const errors = [...inheritedErrors];
  const result = {};
  for (const field of COUNTER_FIELDS) {
    const number = Number(value?.[field]);
    if (!Number.isInteger(number) || number < 0) {
      errors.push(`${field} missing or invalid`);
      result[field] = 1;
    } else {
      result[field] = number;
    }
  }
  let droppedWritebackEvidence = [];
  if (!Array.isArray(value?.droppedWritebackEvidence)) {
    errors.push('droppedWritebackEvidence missing or invalid');
  } else {
    droppedWritebackEvidence = value.droppedWritebackEvidence;
  }
  if (result.droppedWritebackAfter !== droppedWritebackEvidence.length) {
    errors.push('droppedWritebackAfter does not match droppedWritebackEvidence');
    result.droppedWritebackAfter = Math.max(
      result.droppedWritebackAfter,
      droppedWritebackEvidence.length,
    );
  }
  if (!Array.isArray(value?.errors)) errors.push('errors missing or invalid');
  else errors.push(...value.errors.map((error) => String(error)));
  return {
    ok: COUNTER_FIELDS.every((field) => result[field] === 0) && errors.length === 0,
    ...result,
    droppedWritebackEvidence,
    errors,
  };
}

function terminalNotificationText(item) {
  return [
    '⚠️ [flow] 回填进入长期失败终态',
    `pageId=${item.pageId}`,
    `stuck=${(item.stuckSteps || []).join(',') || 'unknown'}`,
    `attempts=${Number(item.attempts || 0)}`,
    `firstAt=${item.firstAt || 'unknown'}`,
    `lastError=${item.lastError || 'unknown'}`,
  ].join('；');
}

function writebackNotificationText(record) {
  const fields = record?.fields || {};
  if (record?.kind === 'writeback_schedule_anomaly') {
    return [
      '⚠️ [flow] 回填调度时间异常已自动规范化',
      `pageId=${fields.pageId || 'unknown'}`,
      `reasons=${(fields.reasons || []).join(',') || 'unknown'}`,
      `observedAt=${fields.observedAt || 'unknown'}`,
    ].join('；');
  }
  if (record?.kind === 'writeback_test_contamination') {
    return [
      '⚠️ [flow] 测试形态回填已隔离',
      `pageId=${fields.pageId || 'unknown'}`,
      `reason=${fields.reason || 'test-contamination'}`,
      `terminalAt=${fields.terminalAt || 'unknown'}`,
    ].join('；');
  }
  return terminalNotificationText(fields);
}

export async function replayWritebackNotifications(deps = {}) {
  const pending = listPendingWritebackNotifications();
  const outcome = {
    pending: pending.length,
    sent: 0,
    failed: 0,
    silenced: process.env.GG_LARK_NOTIFY_SILENCE === '1',
  };
  if (outcome.silenced) return outcome;
  const send = deps.notify || notify;
  for (const item of pending) {
    const { name, record } = item;
    if (record?.sentAt) {
      if (markWritebackNotificationSent(name, record, deps)) outcome.sent += 1;
      else outcome.failed += 1;
      continue;
    }
    try {
      const result = await send('batch_summary', {
        text: writebackNotificationText(record),
        partial: true,
        msgUuid: record.msgUuid,
      });
      if (result?.ok === true && result?.silenced !== true) {
        if (markWritebackNotificationSent(name, record, deps)) outcome.sent += 1;
        else outcome.failed += 1;
      } else {
        outcome.failed += 1;
        recordWritebackNotificationFailure(
          name,
          record,
          result?.error || (result?.silenced ? 'notification silenced' : 'notification send failed'),
          deps,
        );
      }
    } catch (error) {
      outcome.failed += 1;
      recordWritebackNotificationFailure(name, record, error, deps);
    }
  }
  return outcome;
}

export async function runLedgerReconcile({
  apply = true,
  strict = false,
  deps = {},
} = {}) {
  const log = deps.log || (() => {});
  const applyPass = deps.apply || defaultApply;
  const verifyPass = deps.verify || defaultVerify;
  const inheritedErrors = [];
  let applied = { errors: [], summary: [] };
  if (apply || !strict) {
    try { applied = await applyPass({ apply, log }); }
    catch (error) { inheritedErrors.push(`apply: ${error.message}`); }
  }
  if (Array.isArray(applied?.errors)) inheritedErrors.push(...applied.errors.map(String));

  let verified;
  try { verified = await verifyPass({ log }); }
  catch (error) {
    verified = {};
    inheritedErrors.push(`verify: ${error.message}`);
  }
  const result = normalizeResult(verified, inheritedErrors);
  const terminalNotifications = Array.isArray(applied?.terminalNotifications)
    ? applied.terminalNotifications
    : [];
  if (apply && terminalNotifications.length > 0) {
    const unique = new Map();
    for (const item of terminalNotifications) {
      const key = item?.notificationKey
        || `writeback-terminal:${item?.pageId}:${item?.firstAt}:${item?.attempts}`;
      if (!unique.has(key)) unique.set(key, item);
    }
    for (const [key, item] of unique) {
      persistWritebackNotification('writeback_terminal', item, key, deps);
    }
  }
  if (apply) await replayWritebackNotifications(deps);
  if (!strict && apply && Array.isArray(applied?.summary) && applied.summary.length > 0) {
    const send = deps.notify || notify;
    try {
      await send('batch_summary', {
        text: `🧾 每日账本对账：${applied.summary.join('；')}`,
        partial: false,
      });
    } catch {}
  }
  return result;
}

async function main() {
  loadEnv();
  const args = new Set(process.argv.slice(2));
  if (args.has('--notify-only')) {
    const notificationReplay = await replayWritebackNotifications();
    if (args.has('--json')) process.stdout.write(`${JSON.stringify(notificationReplay)}\n`);
    else {
      process.stdout.write(
        `writeback notifications: pending=${notificationReplay.pending} `
        + `sent=${notificationReplay.sent} failed=${notificationReplay.failed}\n`,
      );
    }
    return;
  }
  const strict = args.has('--strict');
  const json = args.has('--json');
  const apply = !args.has('--dry');
  const log = strict && json
    ? (line) => process.stderr.write(`${line}\n`)
    : (line) => process.stdout.write(`${line}\n`);
  if (!strict || !json) {
    log(`=== gg-ledger-reconcile [${apply ? 'APPLY' : 'DRY'}] ===`);
  }
  const result = await runLedgerReconcile({ apply, strict, deps: { log } });
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    process.stdout.write(
      `=== ${result.ok ? 'converged' : 'drift remains'} — `
      + `${COUNTER_FIELDS.map((field) => `${field}=${result[field]}`).join(' ')}`
      + `${result.errors.length ? ` errors=${result.errors.join(' | ')}` : ''} ===\n`,
    );
  }
  if (strict && !result.ok) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  main().catch((error) => {
    process.stderr.write(`gg-ledger-reconcile: ${error.stack || error.message}\n`);
    process.exit(1);
  });
}
