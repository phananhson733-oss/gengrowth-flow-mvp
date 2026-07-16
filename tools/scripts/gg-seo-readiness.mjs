#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const FLOW = resolve(dirname(SCRIPT), '../..');
const ACTIVE_REPAIR = new Set(['queued', 'repairing', 'regating', 'repair_pending']);
const ACTIVE_CLAIMS = new Set(['active', 'pushed-preview', 'verified-preview', 'authored']);
const CLAIM_TERMINALS = new Set(['quarantined', 'human_only', 'archived', 'published']);
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const TEST_ID = /\bPG-(?:TEST|FAKE|FIXTURE|SMOKE)[A-Z0-9-]*\b/g;
const STRICT_FIELDS = [
  'pendingWritebackAfter',
  'sheetFlipsAfter',
  'planUncheckedAfter',
  'activeRepairAfter',
  'expiredLeasesAfter',
  'eligibleNeedsHumanAfter',
];

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) out[item.slice(2)] = true;
    else {
      out[item.slice(2)] = next;
      index += 1;
    }
  }
  return out;
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} root must be an object`);
  }
  return value;
}

function readJson(path, label) {
  return plainObject(JSON.parse(readFileSync(path, 'utf8')), label);
}

function parsePlan(path) {
  const source = readFileSync(path, 'utf8');
  const ids = new Set();
  const unchecked = new Set();
  for (const match of source.matchAll(/^\s*-\s*\[([ xX])\]\s*`?(PG-[A-Z0-9]+-\d+)`?/gm)) {
    ids.add(match[2]);
    if (match[1] === ' ') unchecked.add(match[2]);
  }
  if (ids.size === 0) throw new TypeError('plan has no checklist page IDs');
  return { ids, unchecked };
}

function claimMatchesSite(claim, site) {
  if (claim.site === undefined || claim.site === null || claim.site === '') return true;
  if (!['astrologywiki', 'gengrowth'].includes(claim.site)) {
    throw new TypeError(`invalid claim site: ${String(claim.site)}`);
  }
  return claim.site === site;
}

function recordSource(record) {
  const event = record.event;
  const latest = record.latestEvent;
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('repair event owner required');
  }
  if (!latest) return event;
  if (typeof latest !== 'object' || Array.isArray(latest)
    || !latest.site || !latest.pageId || !latest.runId) {
    throw new TypeError('latestEvent owner and runId required');
  }
  if (latest.site !== event.site || latest.pageId !== event.pageId) {
    throw new TypeError('latestEvent owner conflicts with event owner');
  }
  return latest;
}

function inspectQueue({ queueDir, site, planIds, now, errors }) {
  let activeRepairAfter = 0;
  let expiredLeasesAfter = 0;
  const terminalPageIds = new Set();
  const terminalPageTimes = new Map();
  if (!queueDir || !existsSync(queueDir)) {
    return {
      activeRepairAfter,
      expiredLeasesAfter,
      terminalPageIds,
      terminalPageTimes,
    };
  }
  for (const name of readdirSync(queueDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const record = readJson(join(queueDir, name), `repair ${name}`);
      const source = recordSource(record);
      if (!source || typeof source !== 'object' || !source.pageId || !source.site) {
        throw new TypeError('repair event owner required');
      }
      if (source.site !== site) continue;
      if (source.pageId !== 'RUN' && !planIds.has(source.pageId)) continue;
      if (CLAIM_TERMINALS.has(record.status) && source.pageId !== 'RUN') {
        const terminalRaw = record.latestEvent?.createdAt ?? record.updatedAt;
        let terminalAt = null;
        if (terminalRaw !== undefined && terminalRaw !== null) {
          terminalAt = Date.parse(terminalRaw);
          if (!Number.isFinite(terminalAt)) {
            throw new TypeError('terminal timestamp invalid');
          }
        }
        terminalPageIds.add(source.pageId);
        if (terminalAt !== null) {
          terminalPageTimes.set(
            source.pageId,
            Math.max(terminalPageTimes.get(source.pageId) || 0, terminalAt),
          );
        }
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
  return {
    activeRepairAfter,
    expiredLeasesAfter,
    terminalPageIds,
    terminalPageTimes,
  };
}

function terminalCoversClaim(queue, pageId, claim, errors) {
  if (!queue.terminalPageIds.has(pageId)) return false;
  if (!Object.hasOwn(claim, 'failedAt') || claim.failedAt === null) return true;
  const failedAt = Date.parse(claim.failedAt);
  if (!Number.isFinite(failedAt)) {
    errors.push(`claim ${pageId}: failedAt invalid`);
    return false;
  }
  const terminalAt = queue.terminalPageTimes.get(pageId);
  return Number.isFinite(terminalAt) && terminalAt >= failedAt;
}

function collectContamination(paths) {
  const found = new Set();
  const visit = (path) => {
    if (!path || !existsSync(path)) return;
    let stat;
    try { stat = statSync(path); } catch { return; }
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
      return;
    }
    for (const match of basename(path).matchAll(TEST_ID)) found.add(match[0]);
    if (stat.size > 4 * 1024 * 1024) return;
    try {
      for (const match of readFileSync(path, 'utf8').matchAll(TEST_ID)) found.add(match[0]);
    } catch {}
  };
  paths.forEach(visit);
  return [...found].sort();
}

function normalizeStrict(value, errors) {
  const result = {};
  for (const field of STRICT_FIELDS) {
    const count = Number(value?.[field]);
    if (!Number.isInteger(count) || count < 0) {
      errors.push(`strict ${field} missing or invalid`);
      result[field] = 1;
    } else {
      result[field] = count;
    }
  }
  if (!Array.isArray(value?.errors)) errors.push('strict errors missing or invalid');
  else errors.push(...value.errors.map((error) => `strict: ${String(error)}`));
  if (value?.ok !== true) errors.push('strict reconcile not converged');
  return result;
}

function strictFromEnvironment() {
  if (process.env.GG_SEO_STRICT_RESULT_JSON) {
    return JSON.parse(process.env.GG_SEO_STRICT_RESULT_JSON);
  }
  const bin = process.env.GG_SEO_RECONCILE_BIN || join(FLOW, 'tools/scripts/gg-ledger-reconcile.mjs');
  const result = spawnSync('node', [bin, '--strict', '--json'], {
    cwd: FLOW,
    env: { ...process.env, GG_LARK_NOTIFY_SILENCE: '1' },
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const lines = String(result.stdout || '').trim().split('\n').filter(Boolean);
  let parsed = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      parsed = JSON.parse(lines[index]);
      break;
    } catch {}
  }
  if (!parsed) {
    return {
      ok: false,
      errors: [`strict reconcile unavailable: ${result.error?.message || result.stderr || result.status}`],
    };
  }
  return parsed;
}

export async function evaluateSeoReadiness({
  site,
  planPath,
  runId,
  deps = {},
} = {}) {
  if (!['astrologywiki', 'gengrowth'].includes(site)) throw new TypeError('site must be astrologywiki or gengrowth');
  if (!isAbsolute(planPath || '')) throw new TypeError('plan must be an absolute path');
  if (!SAFE_RUN_ID.test(String(runId || ''))) throw new TypeError('run-id must be a safe identifier');
  const errors = [];
  const now = deps.now instanceof Date ? deps.now : new Date();
  const plan = parsePlan(planPath);
  const base = deps.stateDir
    || process.env.GG_FLOW_STATE_DIR
    || join(homedir(), 'gengrowth-agents', 'flow-state');
  if (!existsSync(base)) throw new Error(`flow-state directory unavailable: ${base}`);
  const claimsPath = deps.claimsPath
    || process.env.GG_SEO_CLAIMS
    || join(
      process.env.GG_PLAN_DIR
        || join(process.env.GG_OPS_DIR || join(homedir(), 'gengrowth-ops'), 'inbox/06-tasks/tasks'),
      '.autopilot-claims.json',
    );
  const queueDir = deps.queueDir
    || process.env.GG_SEO_REPAIR_QUEUE_DIR
    || join(base, 'seo-repair-queue');

  let claims = {};
  try {
    if (!existsSync(claimsPath)) throw new Error(`claims ledger missing: ${claimsPath}`);
    claims = readJson(claimsPath, 'claims');
  }
  catch (error) { errors.push(`claims: ${error.message}`); }
  const queue = inspectQueue({ queueDir, site, planIds: plan.ids, now, errors });
  let eligibleNeedsHumanAfter = 0;
  let activeClaimAfter = 0;
  let expiredClaimLeases = 0;
  for (const [pageId, claim] of Object.entries(claims)) {
    try {
      plainObject(claim, `claim ${pageId}`);
      if (!plan.ids.has(pageId) || !claimMatchesSite(claim, site)) continue;
      if (claim.status === 'needs_human'
        && !terminalCoversClaim(queue, pageId, claim, errors)) {
        eligibleNeedsHumanAfter += 1;
      }
      if (ACTIVE_CLAIMS.has(claim.status)) {
        activeClaimAfter += 1;
        if (claim.leaseUntil) {
          if (!Number.isFinite(Date.parse(claim.leaseUntil))) {
            errors.push(`claim ${pageId}: lease timestamp invalid`);
            expiredClaimLeases += 1;
          } else if (Date.parse(claim.leaseUntil) <= now.getTime()) {
            expiredClaimLeases += 1;
          }
        }
      }
    } catch (error) {
      errors.push(`claim ${pageId}: ${error.message}`);
      eligibleNeedsHumanAfter += 1;
    }
  }
  const staleReport = Array.isArray(deps.staleReport)
    ? deps.staleReport
    : Object.entries(claims)
      .filter(([pageId, claim]) => plan.ids.has(pageId) && ACTIVE_CLAIMS.has(claim?.status))
      .map(([pageId, claim]) => ({
        pageId,
        stale: Boolean(claim.leaseUntil && Date.parse(claim.leaseUntil) <= now.getTime()),
      }));
  const staleReportAfter = staleReport.filter((row) => row?.stale).length;
  const strictResult = deps.strictResult || strictFromEnvironment();
  const strict = normalizeStrict(strictResult, errors);
  const testContamination = collectContamination([base, claimsPath, queueDir]);
  const result = {
    ok: false,
    site,
    plan: planPath,
    runId,
    ...strict,
    planUncheckedAfter: Math.max(strict.planUncheckedAfter, plan.unchecked.size),
    activeRepairAfter: Math.max(
      strict.activeRepairAfter,
      queue.activeRepairAfter + activeClaimAfter,
    ),
    expiredLeasesAfter: Math.max(
      strict.expiredLeasesAfter,
      queue.expiredLeasesAfter + expiredClaimLeases,
    ),
    eligibleNeedsHumanAfter: Math.max(
      strict.eligibleNeedsHumanAfter,
      eligibleNeedsHumanAfter,
    ),
    staleReportAfter,
    testContamination,
    errors,
  };
  result.ok = STRICT_FIELDS.every((field) => result[field] === 0)
    && result.staleReportAfter === 0
    && result.testContamination.length === 0
    && result.errors.length === 0;
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.site || !args.plan || !args['run-id']) {
    throw new TypeError('--site, --plan and --run-id are required');
  }
  const result = await evaluateSeoReadiness({
    site: args.site,
    planPath: resolve(args.plan),
    runId: args['run-id'],
  });
  if (args.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`SEO readiness: ${result.ok ? 'ready' : 'blocked'}\n`);
  if (!result.ok) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  main().catch((error) => {
    process.stderr.write(`gg-seo-readiness: ${error.stack || error.message}\n`);
    process.exit(2);
  });
}
