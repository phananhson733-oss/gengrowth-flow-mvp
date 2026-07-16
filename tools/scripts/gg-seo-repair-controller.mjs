#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

import { outboxWrite, stateDir } from './lib/flow-state.mjs';
import { loadEnv } from './lib/gg-shared.mjs';
import { drainRepairQueue } from './lib/seo-repair-controller.mjs';
import {
  compactRepairIncident,
  enqueueRepairEvent,
  isActiveRepairStatus,
  listRepairRecords,
  repairEventFingerprint,
  repairIncidentId,
} from './lib/seo-repair-events.mjs';
import { eventFromClaim } from './lib/seo-repair-producer.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const SCRIPTS = dirname(SCRIPT);
const FLOW = resolve(SCRIPTS, '../..');
const NOTIFY_BIN = join(SCRIPTS, 'gg-notify.mjs');

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) out[item.slice(2)] = '1';
    else {
      out[item.slice(2)] = next;
      index += 1;
    }
  }
  return out;
}

function numberArg(value, fallback, minimum = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function queueDir() {
  if (process.env.GG_SEO_REPAIR_QUEUE_DIR) return resolve(process.env.GG_SEO_REPAIR_QUEUE_DIR);
  const base = stateDir();
  if (!base) throw new Error('flow-state directory unavailable');
  return join(base, 'seo-repair-queue');
}

function moduleUrl(path) {
  return pathToFileURL(isAbsolute(path) ? path : resolve(FLOW, path)).href;
}

async function loadAdapters() {
  if (process.env.GG_SEO_REPAIR_ADAPTER_MODULE) {
    const loaded = await import(moduleUrl(process.env.GG_SEO_REPAIR_ADAPTER_MODULE));
    const adapters = loaded.default || loaded.adapters;
    if (!adapters || typeof adapters !== 'object') throw new Error('adapter module must export an adapter map');
    return adapters;
  }
  const [astrology, gengrowth] = await Promise.all([
    import('./lib/seo-repair-adapter-astrologywiki.mjs'),
    import('./lib/seo-repair-adapter-gengrowth.mjs'),
  ]);
  return {
    astrologywiki: astrology.createAstrologyWikiRepairAdapter(),
    gengrowth: gengrowth.createGengrowthRepairAdapter(),
  };
}

async function loadTerminalNotifier() {
  if (process.env.GG_SEO_REPAIR_NOTIFY_MODULE) {
    const loaded = await import(moduleUrl(process.env.GG_SEO_REPAIR_NOTIFY_MODULE));
    if (typeof loaded.default !== 'function') throw new Error('notify module must export a default function');
    return loaded.default;
  }
  return async (payload) => {
    if (process.env.GG_SEO_REPAIR_NO_NOTIFY === '1') return;
    const text = `SEO repair controller: ${payload.terminal} — ${payload.site}/${payload.pageId}${payload.slug ? ` (${payload.slug})` : ''}`;
    const result = spawnSync('node', [
      NOTIFY_BIN, 'raw', '--text', text, '--msgUuid', payload.messageUuid,
    ], {
      cwd: FLOW,
      env: process.env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (result.status !== 0 || result.error) {
      outboxWrite({
        text,
        atPm: payload.terminal === 'human_only',
        atOps: payload.terminal === 'human_only',
        idempotencyKey: payload.idempotencyKey,
        lastError: result.error?.message || String(result.status),
      });
    }
  };
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function lockPath() {
  return process.env.GG_SEO_REPAIR_CONTROLLER_LOCK || '/tmp/gg-seo-repair-controller.lock';
}

function readLockOwner(path) {
  try { return JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')); }
  catch { return null; }
}

function acquireControllerLock({ owner, leaseMs }) {
  const path = lockPath();
  const token = randomUUID();
  const now = new Date();
  const metadata = {
    pid: process.pid,
    owner,
    token,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
  };
  const tryCreate = () => {
    mkdirSync(path);
    writeFileSync(join(path, 'owner.json'), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  };

  try {
    tryCreate();
    return { acquired: true, path, metadata };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const current = readLockOwner(path);
    if (!current) {
      try {
        if (Date.now() - statSync(path).mtimeMs < 5_000) {
          return { acquired: false, path, owner: null };
        }
      } catch {}
    }
    const live = current && pidIsAlive(Number(current.pid));
    const unexpired = current && Date.parse(current.expiresAt || 0) > Date.now();
    if (live || unexpired) return { acquired: false, path, owner: current };
    const stalePath = `${path}.stale-${Date.now()}-${process.pid}`;
    try {
      renameSync(path, stalePath);
      rmSync(stalePath, { recursive: true, force: true });
      tryCreate();
      return { acquired: true, path, metadata, reclaimed: current };
    } catch (retryError) {
      if (retryError?.code === 'EEXIST' || retryError?.code === 'ENOENT') {
        return { acquired: false, path, owner: readLockOwner(path) };
      }
      throw retryError;
    }
  }
}

function releaseControllerLock(lock) {
  if (!lock?.acquired) return;
  const current = readLockOwner(lock.path);
  if (current?.token !== lock.metadata.token || Number(current.pid) !== process.pid) return;
  rmSync(lock.path, { recursive: true, force: true });
}

function readLogWindow(path, offset) {
  if (!path) return '';
  try {
    const bytes = readFileSync(path);
    return bytes.subarray(Math.min(bytes.length, Math.max(0, Number(offset) || 0))).toString('utf8');
  } catch { return ''; }
}

function parsePlanIds(text) {
  return new Set([...String(text || '').matchAll(/^\s*-\s*\[[ xX]\]\s*`?(PG-[A-Z0-9]+-\d+)`?/gm)].map((match) => match[1]));
}

function explicitRunId(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const runId = String(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(runId)) {
    throw new TypeError('run-id must be 3-128 safe identifier characters');
  }
  return runId;
}

function activeRunAlreadyRepresented(records, event) {
  const incidentId = repairIncidentId(event);
  const fingerprint = repairEventFingerprint(event);
  return records.some((record) => {
    if (!isActiveRepairStatus(record.status)) return false;
    const recordIncidentId = record.incidentId || repairIncidentId(record.event);
    return recordIncidentId === incidentId && record.fingerprint === fingerprint;
  });
}

function eligibleLegacyClaim(claim, pageId, baseState) {
  if (!claim || typeof claim !== 'object') return false;
  if (['needs_human', 'pushed-preview', 'verified-preview', 'active', 'authored'].includes(claim.status)) return true;
  if (claim.error) return true;
  if (claim.status === 'done') {
    const safe = pageId.replace(/[^A-Za-z0-9._-]/g, '_');
    return existsSync(join(baseState, 'pending-writeback', `${safe}.json`));
  }
  return false;
}

async function importLegacy(args, targetQueueDir) {
  if (args['targets-json']) {
    const values = JSON.parse(readFileSync(resolve(args['targets-json']), 'utf8'));
    if (!Array.isArray(values)) throw new TypeError('targets-json must contain an array');
    const records = [];
    for (const value of values) records.push(await enqueueRepairEvent(value, { queueDir: targetQueueDir }));
    return records;
  }
  if (!args.claims || !args.plan) throw new TypeError('import-v1 requires --claims and --plan');
  const claims = JSON.parse(readFileSync(resolve(args.claims), 'utf8'));
  const planText = readFileSync(resolve(args.plan), 'utf8');
  const planIds = parsePlanIds(planText);
  const baseState = stateDir();
  if (!baseState) throw new Error('flow-state directory unavailable');
  const logFile = args['log-file'] ? resolve(args['log-file']) : resolve('/tmp/seo-repair-v1.log');
  const logOffsetStart = Math.max(0, Number(args['log-offset']) || 0);
  let logOffsetEnd = logOffsetStart;
  try { logOffsetEnd = statSync(logFile).size; } catch {}
  const logWindow = readLogWindow(logFile, logOffsetStart);
  const createdAt = new Date().toISOString();
  const site = args.site || 'astrologywiki';
  if (!['astrologywiki', 'gengrowth'].includes(site)) throw new TypeError(`unsupported legacy site: ${site}`);
  const runId = explicitRunId(
    args['run-id'],
    `${site}-v1-${createdAt.replace(/[^0-9]/g, '').slice(0, 14)}`,
  );
  const records = [];
  const activeRecords = await listRepairRecords({ queueDir: targetQueueDir });
  let represented = 0;

  for (const pageId of planIds) {
    const claim = claims?.[pageId];
    if (!eligibleLegacyClaim(claim, pageId, baseState)) continue;
    const event = eventFromClaim({
      site,
      runId,
      pageId,
      claim,
      logFile,
      offsets: { start: logOffsetStart, end: logOffsetEnd },
      createdAt: claim.failedAt || claim.updatedAt || claim.mergedAt || createdAt,
    });
    if (activeRunAlreadyRepresented(activeRecords, event)) {
      represented += 1;
      continue;
    }
    const record = await enqueueRepairEvent(event, { queueDir: targetQueueDir });
    records.push(record);
    activeRecords.push(record);
  }

  const runExit = Number(args['run-exit'] || 0);
  if (runExit !== 0 && records.length === 0 && represented === 0) {
    const runEvent = {
      schemaVersion: 2,
      eventId: randomUUID(),
      runId,
      site,
      lane: 'run',
      pageId: 'RUN',
      slug: '',
      stage: 'run',
      errorKind: 'tool_exit',
      summary: `${site === 'gengrowth' ? 'gengrowth author' : 'nightly'} exited ${runExit}`,
      stderr: logWindow.slice(-8_192),
      logFile,
      logOffsetStart,
      logOffsetEnd,
      canonicalRetry: site === 'gengrowth'
        ? ['bash', 'tools/scripts/gg-gengrowth-author-tick.sh']
        : ['bash', 'tools/scripts/gg-nightly-seo.sh'],
      createdAt,
    };
    if (!activeRunAlreadyRepresented(activeRecords, runEvent)) {
      records.push(await enqueueRepairEvent(runEvent, { queueDir: targetQueueDir }));
    }
  }
  return records;
}

async function drainWithLock(args, targetQueueDir) {
  const maxTargets = numberArg(args['max-targets'], numberArg(process.env.GG_SEO_REPAIR_MAX_TARGETS, 2, 1), 1);
  const budgetSeconds = numberArg(args['budget-seconds'], 1500, 1);
  const lock = acquireControllerLock({
    owner: `seo-repair-controller:${process.pid}`,
    leaseMs: (budgetSeconds + 300) * 1000,
  });
  if (!lock.acquired) return { ok: true, busy: true, lockOwner: lock.owner || null };
  const release = () => releaseControllerLock(lock);
  process.once('exit', release);
  process.once('SIGINT', () => { release(); process.exit(130); });
  process.once('SIGTERM', () => { release(); process.exit(143); });
  try {
    const adapters = await loadAdapters();
    const notifyTerminal = await loadTerminalNotifier();
    return await drainRepairQueue({
      queueDir: targetQueueDir,
      adapters,
      notifyTerminal,
      owner: lock.metadata.owner,
      maxTargets,
      budgetMs: budgetSeconds * 1000,
      leaseMs: (budgetSeconds + 300) * 1000,
      attemptBudgetMs: budgetSeconds * 1000,
    });
  } finally {
    process.removeListener('exit', release);
    release();
  }
}

async function main() {
  loadEnv({ strict: true });
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const targetQueueDir = queueDir();

  if (command === 'enqueue') {
    if (!args['event-json']) throw new TypeError('enqueue requires --event-json');
    const value = JSON.parse(readFileSync(resolve(args['event-json']), 'utf8'));
    const record = await enqueueRepairEvent(value, { queueDir: targetQueueDir });
    output({ ok: true, command, record });
    return;
  }
  if (command === 'inspect') {
    const records = (await listRepairRecords({ queueDir: targetQueueDir }))
      .filter((record) => !args['page-id'] || record.event.pageId === args['page-id'])
      .sort((a, b) => a.event.createdAt.localeCompare(b.event.createdAt));
    output({ ok: true, command, records });
    return;
  }
  if (command === 'compact') {
    if (!args.site || !args['page-id']) throw new TypeError('compact requires --site and --page-id');
    const record = await compactRepairIncident({
      queueDir: targetQueueDir,
      site: args.site,
      pageId: args['page-id'],
      verificationCredit: numberArg(args['verification-credit'], 0, 0),
    });
    output({ ok: true, command, record });
    return;
  }
  if (command === 'drain') {
    output({ command, ...(await drainWithLock(args, targetQueueDir)) });
    return;
  }
  if (command === 'import-v1') {
    const records = await importLegacy(args, targetQueueDir);
    if (args['no-drain'] === '1') {
      output({ ok: true, command, imported: records.length, records });
      return;
    }
    output({
      command,
      imported: records.length,
      ...(await drainWithLock(args, targetQueueDir)),
    });
    return;
  }
  throw new TypeError('usage: gg-seo-repair-controller.mjs enqueue|drain|import-v1|inspect|compact');
}

try {
  await main();
} catch (error) {
  output({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 2;
}
