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
import { drainPending, listWriteback, writebackDir } from './lib/backfill-tx.mjs';
import { stateDir } from './lib/flow-state.mjs';
import { getAccessToken, gFetch, loadEnv } from './lib/gg-shared.mjs';
import { notify } from './lib/gg-notify.mjs';
import { PRODUCTS, PAGES_TAB, PUBLISHED, workbookId } from './gg-reconcile-status.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const HOME = homedir();
const FLOW = process.env.GG_FLOW_REPO || resolve(dirname(SCRIPT), '../..');
const OPS = process.env.GG_OPS_DIR || join(HOME, 'gengrowth-ops');
const PLAN_DIR = process.env.GG_PLAN_DIR || join(OPS, 'inbox', '06-tasks', 'tasks');
const CLAIMS_PATH = process.env.GG_SEO_CLAIMS || join(PLAN_DIR, '.autopilot-claims.json');
const SCRIPTS = join(FLOW, 'tools', 'scripts');
const AUTOPILOT = join(SCRIPTS, 'gg-seo-autopilot.mjs');
const RECONCILE_STATUS = join(SCRIPTS, 'gg-reconcile-status.mjs');
const COUNTER_FIELDS = [
  'pendingWritebackAfter',
  'sheetFlipsAfter',
  'planUncheckedAfter',
  'activeRepairAfter',
  'expiredLeasesAfter',
  'eligibleNeedsHumanAfter',
];
const ACTIVE_REPAIR = new Set(['queued', 'repairing', 'regating', 'repair_pending']);
const ACTIVE_CLAIMS = new Set(['active', 'pushed-preview', 'verified-preview', 'authored']);

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
  if (!existsSync(path)) return {};
  return strictObject(JSON.parse(readFileSync(path, 'utf8')), 'claims');
}

function planPath(name) {
  return String(name || '').includes('/') ? String(name) : join(PLAN_DIR, String(name || ''));
}

function uncheckedDoneClaims(claims) {
  let count = 0;
  for (const [pageId, claim] of Object.entries(claims)) {
    if (!claim || claim.status !== 'done' || !claim.plan) continue;
    const path = planPath(claim.plan);
    if (!existsSync(path)) {
      count += 1;
      continue;
    }
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

async function sweepPlanBoxesBySheet(token, apply) {
  let checked = 0;
  let files = [];
  try {
    files = readdirSync(PLAN_DIR)
      .filter((name) => /blog-output-plan.*\.md$/.test(name))
      .map((name) => join(PLAN_DIR, name));
  } catch {
    return 0;
  }
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
    } catch {
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

function inspectWriteback(errors) {
  const dir = writebackDir();
  if (!dir || !existsSync(dir)) return 0;
  let count = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name.includes('.tmp-')) continue;
    try {
      strictObject(JSON.parse(readFileSync(join(dir, name), 'utf8')), `writeback ${name}`);
      count += 1;
    } catch (error) {
      errors.push(`writeback ${name}: ${error.message}`);
      count += 1;
    }
  }
  return count;
}

function inspectRepairState(claims, errors, now = new Date()) {
  let activeRepairAfter = 0;
  let expiredLeasesAfter = 0;
  const base = stateDir();
  const queue = process.env.GG_SEO_REPAIR_QUEUE_DIR
    || (base ? join(base, 'seo-repair-queue') : null);
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
        if (ACTIVE_REPAIR.has(record.status)) {
          activeRepairAfter += 1;
          if (record.lease?.expiresAt
            && Date.parse(record.lease.expiresAt) <= now.getTime()) {
            expiredLeasesAfter += 1;
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
    if (ACTIVE_CLAIMS.has(claim.status)
      && claim.leaseUntil
      && Date.parse(claim.leaseUntil) <= now.getTime()) {
      expiredLeasesAfter += 1;
    }
  }
  return { activeRepairAfter, expiredLeasesAfter };
}

async function defaultApply({ apply, log }) {
  const errors = [];
  const summary = [];
  let drain = { retried: 0, resolved: 0, stillPending: listWriteback().length, dropped: [] };
  if (apply) {
    try { drain = await drainPending(); }
    catch (error) { errors.push(`drainPending: ${error.message}`); }
  }
  log(`1. drainPending: retried=${drain.retried || 0} resolved=${drain.resolved || 0} stillPending=${drain.stillPending || 0} dropped=${drain.dropped?.length || 0}`);
  if (drain.resolved) summary.push(`回填补写 ${drain.resolved} 篇`);
  if (drain.dropped?.length) {
    summary.push(`⚠️回填淘汰 ${drain.dropped.length} 篇`);
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
  if (apply) {
    try {
      const serviceAccount = process.env.GG_WRITER_SA_JSON
        || join(HOME, '.config', 'gg', 'gg-writer-sa.json');
      const { token } = await getAccessToken(serviceAccount, [
        'https://www.googleapis.com/auth/spreadsheets.readonly',
      ]);
      sheetChecked = await sweepPlanBoxesBySheet(token, true);
    } catch (error) {
      errors.push(`sheet-plan: ${error.message}`);
    }
  }
  log(`4b. plan-sweep(sheet-driven): checked=${sheetChecked}`);
  if (sheetChecked) summary.push(`plan 补勾(无claim已上线) ${sheetChecked} 项`);
  return { errors, summary, claims };
}

async function defaultVerify({ log }) {
  const errors = [];
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
  const repair = inspectRepairState(claims, errors);
  const result = {
    pendingWritebackAfter: inspectWriteback(errors),
    sheetFlipsAfter,
    planUncheckedAfter: uncheckedDoneClaims(claims),
    activeRepairAfter: repair.activeRepairAfter,
    expiredLeasesAfter: repair.expiredLeasesAfter,
    eligibleNeedsHumanAfter: Object.values(claims)
      .filter((claim) => claim && claim.status === 'needs_human').length,
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
  if (!Array.isArray(value?.errors)) errors.push('errors missing or invalid');
  else errors.push(...value.errors.map((error) => String(error)));
  return {
    ok: COUNTER_FIELDS.every((field) => result[field] === 0) && errors.length === 0,
    ...result,
    errors,
  };
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
  if (apply) {
    try { applied = await applyPass({ apply: true, log }); }
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
