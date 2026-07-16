import { createHash, randomUUID as defaultRandomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const TERMINAL_STATUSES = new Set(['published', 'archived', 'human_only', 'superseded', 'migration_hold']);
const ACTIVE_STATUSES = new Set(['queued', 'repairing', 'regating', 'repair_pending']);
const ALLOWED_SITES = new Set(['astrologywiki', 'gengrowth']);
const ALLOWED_ERROR_KINDS = new Set([
  'tool_exit',
  'timeout',
  'gate_fail',
  'asset_fail',
  'link_fail',
  'state_fail',
  'auth',
  'source',
  'stale',
  'publish_fail',
  'backfill_fail',
]);
const LANE_WEIGHTS = {
  backfill: 500,
  live: 400,
  merge: 400,
  publish: 300,
  preview: 300,
  author: 200,
  authoring: 200,
  run: 100,
};
const DEFAULT_AGING_MS = 60 * 60 * 1000;
const MAX_STDERR_LENGTH = 8_192;
const MAX_SUMMARY_LENGTH = 2_048;
const INCIDENT_LOCK_LEASE_MS = 30_000;
const INCIDENT_LOCK_TIMEOUT_MS = 10_000;
const INCIDENT_LOCK_RETRY_MS = 10;
const INCIDENT_LOCK_METADATA_GRACE_MS = 1_000;
const TRANSACTION_SCHEMA_VERSION = 1;

function requireString(value, field, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function boundedRedactedText(value, maxLength) {
  const redacted = String(value || '')
    .replace(/\b(bearer)\s+[a-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b(token|password|secret|api[_-]?key)\s*[:=]\s*[^\s]+/gi, '$1=[REDACTED]');
  return redacted.length <= maxLength ? redacted : redacted.slice(-maxLength);
}

function iso(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${field} must be an ISO timestamp`);
  return date.toISOString();
}

export function validateRepairEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('repair event must be an object');
  }
  if (value.schemaVersion !== 2) throw new TypeError('schemaVersion must be 2');
  const site = requireString(value.site, 'site');
  if (!ALLOWED_SITES.has(site)) throw new TypeError('site must be astrologywiki or gengrowth');
  if (!Array.isArray(value.canonicalRetry) || value.canonicalRetry.length === 0
    || value.canonicalRetry.some((part) => typeof part !== 'string' || part === '')) {
    throw new TypeError('canonicalRetry must be an argv array');
  }
  const errorKind = requireString(value.errorKind, 'errorKind');
  if (!ALLOWED_ERROR_KINDS.has(errorKind)) {
    throw new TypeError(`unsupported errorKind: ${errorKind}`);
  }
  const logOffsetStart = Number(value.logOffsetStart);
  const logOffsetEnd = Number(value.logOffsetEnd);
  if (!Number.isInteger(logOffsetStart) || logOffsetStart < 0
    || !Number.isInteger(logOffsetEnd) || logOffsetEnd < logOffsetStart) {
    throw new TypeError('log offsets must be ordered non-negative integers');
  }

  return {
    schemaVersion: 2,
    eventId: requireString(value.eventId, 'eventId'),
    runId: requireString(value.runId, 'runId'),
    site,
    lane: requireString(value.lane, 'lane'),
    pageId: requireString(value.pageId, 'pageId'),
    slug: requireString(value.slug, 'slug', { optional: true }),
    stage: requireString(value.stage, 'stage'),
    errorKind,
    summary: boundedRedactedText(requireString(value.summary, 'summary'), MAX_SUMMARY_LENGTH),
    stderr: boundedRedactedText(value.stderr, MAX_STDERR_LENGTH),
    logFile: requireString(value.logFile, 'logFile'),
    logOffsetStart,
    logOffsetEnd,
    canonicalRetry: [...value.canonicalRetry],
    createdAt: iso(value.createdAt, 'createdAt'),
  };
}

export function normalizeRepairEvidence(value) {
  return String(value || '')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?\b/g, '<time>')
    .replace(/\bpid\s+\d+\b/gi, 'pid <n>')
    .replace(/\/tmp\/[^\s]+/g, '/tmp/<path>')
    .replace(/(?:https:\/\/)?[a-z0-9.-]*preview[a-z0-9.-]*\.vercel\.app/gi, '<preview>.vercel.app')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function incidentIdForOwner(site, pageId, lane = '') {
  const owner = pageId === 'RUN' ? `${site}:${lane}:RUN` : `${site}:${pageId}`;
  return createHash('sha256').update(owner).digest('hex');
}

export function repairIncidentId(value) {
  const event = validateRepairEvent(value);
  return incidentIdForOwner(event.site, event.pageId, event.lane);
}

export function isActiveRepairStatus(status) {
  return ACTIVE_STATUSES.has(status);
}

export function repairEventFingerprint(value) {
  const event = validateRepairEvent(value);
  const stable = normalizeRepairEvidence(event.summary);
  return createHash('sha256')
    .update(`${event.site}\n${event.pageId}\n${event.stage}\n${event.errorKind}\n${stable}`)
    .digest('hex');
}

async function atomicWriteJson(path, value, randomUUID = defaultRandomUUID) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
  const handle = await open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tempPath, path);
    try {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch {}
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function writeNewJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch {}
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

async function injectFault(faultInjector, point, context = {}) {
  if (typeof faultInjector === 'function') {
    await faultInjector(point, context);
  }
}

async function sameDirectory(path, expected) {
  try {
    const current = await stat(path);
    return current.dev === expected.dev && current.ino === expected.ino;
  } catch {
    return false;
  }
}

async function withIncidentLock(queueDir, incidentId, fn, { faultInjector } = {}) {
  const locksDir = join(queueDir, '.incident-locks');
  const path = join(locksDir, incidentId);
  const ownerPath = join(path, 'owner.json');
  const token = defaultRandomUUID();
  const deadline = Date.now() + INCIDENT_LOCK_TIMEOUT_MS;
  await mkdir(locksDir, { recursive: true });

  while (true) {
    const acquiredAt = new Date();
    const metadata = {
      pid: process.pid,
      token,
      incidentId,
      acquiredAt: acquiredAt.toISOString(),
      expiresAt: new Date(acquiredAt.getTime() + INCIDENT_LOCK_LEASE_MS).toISOString(),
    };
    try {
      await mkdir(path);
      const ownedDirectory = await stat(path);
      try {
        await writeNewJson(ownerPath, metadata);
      } catch (error) {
        if (await sameDirectory(path, ownedDirectory)) {
          await rm(path, { recursive: true, force: true });
        }
        throw error;
      }
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const current = await readJson(ownerPath);
      const live = current && pidIsAlive(Number(current.pid));
      let reclaimable = Boolean(current && !live);
      if (!current) {
        try {
          reclaimable = Date.now() - (await stat(path)).mtimeMs > INCIDENT_LOCK_METADATA_GRACE_MS;
        } catch {}
      }
      if (live) {
        await injectFault(faultInjector, 'live-lock-observed', {
          incidentId,
          owner: current,
        });
      }
      if (reclaimable) {
        const confirmed = await readJson(ownerPath);
        const unchanged = current
          ? confirmed?.token === current.token && Number(confirmed?.pid) === Number(current.pid)
          : confirmed === null;
        if (unchanged) {
          const stalePath = `${path}.stale-${process.pid}-${defaultRandomUUID()}`;
          try {
            await rename(path, stalePath);
            await rm(stalePath, { recursive: true, force: true });
            continue;
          } catch (reclaimError) {
            if (!['EEXIST', 'ENOENT'].includes(reclaimError?.code)) throw reclaimError;
          }
        }
      }
      if (Date.now() >= deadline) throw new Error(`incident lock timeout: ${incidentId}`);
      await delay(INCIDENT_LOCK_RETRY_MS);
    }
  }

  const assertOwner = async () => {
    const current = await readJson(ownerPath);
    if (current?.token !== token || Number(current.pid) !== process.pid) {
      throw new Error(`incident lock fencing violation: ${incidentId}`);
    }
  };

  try {
    await assertOwner();
    const result = await fn({ assertOwner });
    await assertOwner();
    return result;
  } finally {
    const current = await readJson(ownerPath);
    if (current?.token === token && Number(current.pid) === process.pid) {
      await rm(path, { recursive: true, force: true });
    }
  }
}

export async function readRepairRecord(path) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !parsed.event || !parsed.fingerprint) {
    throw new TypeError(`invalid repair record: ${path}`);
  }
  return parsed;
}

async function quarantineRecord(path, queueDir) {
  const quarantineDir = join(queueDir, 'quarantine');
  await mkdir(quarantineDir, { recursive: true });
  const destination = join(quarantineDir, `${basename(path)}.${Date.now()}.corrupt`);
  await rename(path, destination);
  return destination;
}

async function listRecordPaths(queueDir) {
  await mkdir(queueDir, { recursive: true });
  return (await readdir(queueDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(queueDir, entry.name))
    .sort();
}

async function readQueueRecords(queueDir, { quarantineCorrupt = true } = {}) {
  const records = [];
  for (const path of await listRecordPaths(queueDir)) {
    try {
      records.push({ path, record: await readRepairRecord(path) });
    } catch (error) {
      if (!quarantineCorrupt) throw error;
      await quarantineRecord(path, queueDir);
    }
  }
  return records;
}

function transactionDirectory(queueDir) {
  return join(queueDir, '.incident-transactions');
}

function transactionPath(queueDir, transactionId) {
  return join(transactionDirectory(queueDir), `${transactionId}.json`);
}

async function listTransactionIntents(queueDir) {
  const directory = transactionDirectory(queueDir);
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const intents = [];
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const path = join(directory, name);
    const intent = JSON.parse(await readFile(path, 'utf8'));
    if (intent?.schemaVersion !== TRANSACTION_SCHEMA_VERSION
      || typeof intent.transactionId !== 'string'
      || typeof intent.incidentId !== 'string'
      || !Array.isArray(intent.writes)) {
      throw new TypeError(`invalid repair transaction: ${path}`);
    }
    intents.push({ path, intent });
  }
  return intents;
}

function transactionWrite(filename, record, {
  faultPointAfter = null,
} = {}) {
  if (basename(filename) !== filename || !filename.endsWith('.json')) {
    throw new TypeError(`invalid transaction record path: ${filename}`);
  }
  return {
    filename,
    record,
    ...(faultPointAfter ? { faultPointAfter } : {}),
  };
}

async function prepareTransaction(queueDir, {
  incidentId,
  operation,
  writes,
  createdAt,
}, {
  randomUUID = defaultRandomUUID,
  assertOwner,
} = {}) {
  const transactionId = `${incidentId}-${defaultRandomUUID()}`;
  const intent = {
    schemaVersion: TRANSACTION_SCHEMA_VERSION,
    transactionId,
    incidentId,
    operation,
    phase: 'prepared',
    createdAt,
    writes,
  };
  if (assertOwner) await assertOwner();
  const path = transactionPath(queueDir, transactionId);
  await atomicWriteJson(path, intent, randomUUID);
  return { path, intent };
}

async function applyPreparedTransaction(queueDir, path, intent, {
  randomUUID = defaultRandomUUID,
  faultInjector,
  assertOwner,
} = {}) {
  const latest = JSON.parse(await readFile(path, 'utf8'));
  if (latest.phase === 'committed') return latest;
  if (latest.transactionId !== intent.transactionId
    || latest.incidentId !== intent.incidentId
    || latest.phase !== 'prepared') {
    throw new Error(`repair transaction changed unexpectedly: ${intent.transactionId}`);
  }
  for (const write of latest.writes) {
    if (assertOwner) await assertOwner();
    await atomicWriteJson(join(queueDir, write.filename), write.record, randomUUID);
    if (write.faultPointAfter) {
      await injectFault(faultInjector, write.faultPointAfter, {
        incidentId: latest.incidentId,
        transactionId: latest.transactionId,
      });
    }
  }
  const committed = {
    ...latest,
    phase: 'committed',
    committedAt: new Date().toISOString(),
  };
  if (assertOwner) await assertOwner();
  await atomicWriteJson(path, committed, randomUUID);
  return committed;
}

async function recoverIncidentTransactionsLocked(queueDir, incidentId, {
  randomUUID = defaultRandomUUID,
  assertOwner,
} = {}) {
  let recovered = 0;
  for (const { path, intent } of await listTransactionIntents(queueDir)) {
    if (intent.incidentId !== incidentId || intent.phase === 'committed') continue;
    await applyPreparedTransaction(queueDir, path, intent, { randomUUID, assertOwner });
    recovered += 1;
  }
  return recovered;
}

async function recoverPreparedTransactions(queueDir, {
  randomUUID = defaultRandomUUID,
} = {}) {
  const incidentIds = [...new Set(
    (await listTransactionIntents(queueDir))
      .filter(({ intent }) => intent.phase !== 'committed')
      .map(({ intent }) => intent.incidentId),
  )].sort();
  let recovered = 0;
  for (const incidentId of incidentIds) {
    recovered += await withIncidentLock(queueDir, incidentId, async ({ assertOwner }) => (
      recoverIncidentTransactionsLocked(queueDir, incidentId, { randomUUID, assertOwner })
    ));
  }
  return recovered;
}

export async function listRepairRecords({ queueDir } = {}) {
  if (!queueDir) throw new TypeError('queueDir is required');
  await recoverPreparedTransactions(queueDir);
  return (await readQueueRecords(queueDir)).map(({ record }) => record);
}

function initialRecord(event, fingerprint, {
  incidentId,
  generation = 1,
  budgetEpoch = 1,
  totalAttempts = 0,
  agentMutationAttempts = 0,
  parentGenerationId = null,
  parentFingerprints = [],
} = {}) {
  return {
    event,
    latestEvent: event,
    fingerprint,
    incidentId,
    generation,
    budgetEpoch,
    totalAttempts,
    agentMutationAttempts,
    sourceEventIds: [event.eventId],
    sourceEvents: [event],
    parentGenerationId,
    status: 'queued',
    observations: 1,
    strategy: 'deterministic_retry',
    strategyAttempts: {},
    nextEligibleAt: null,
    lease: null,
    parentFingerprints,
    terminalNotificationKey: null,
    history: [{
      status: 'queued',
      at: event.createdAt,
      evidence: {
        eventId: event.eventId,
        ...(parentFingerprints[0] ? { parentFingerprint: parentFingerprints[0] } : {}),
      },
    }],
    updatedAt: event.createdAt,
  };
}

export async function enqueueRepairEvent(value, {
  queueDir,
  randomUUID = defaultRandomUUID,
} = {}) {
  if (!queueDir) throw new TypeError('queueDir is required');
  const event = validateRepairEvent(value);
  const fingerprint = repairEventFingerprint(event);
  const incidentId = repairIncidentId(event);
  return withIncidentLock(queueDir, incidentId, async () => {
    const queueRecords = await readQueueRecords(queueDir);
    const active = queueRecords
      .filter(({ record }) => ACTIVE_STATUSES.has(record.status)
        && (record.incidentId || repairIncidentId(record.event)) === incidentId)
      .sort((a, b) => Number(b.record.generation || 1) - Number(a.record.generation || 1)
        || String(b.record.updatedAt || '').localeCompare(String(a.record.updatedAt || '')));
    const existing = active.find(({ record }) => record.fingerprint === fingerprint);

    if (existing) {
      const sourceEventIds = [...new Set([
        ...(existing.record.sourceEventIds || [existing.record.event.eventId]),
        event.eventId,
      ])];
      const sourceEvents = [
        ...(existing.record.sourceEvents || [existing.record.event]),
        ...(!sourceEventIds.slice(0, -1).includes(event.eventId) ? [event] : []),
      ];
      const merged = {
        ...existing.record,
        incidentId,
        latestEvent: event,
        observations: Number(existing.record.observations || 1) + 1,
        sourceEventIds,
        sourceEvents,
        updatedAt: event.createdAt,
        history: [
          ...(existing.record.history || []),
          { status: existing.record.status, at: event.createdAt, evidence: { observedEventId: event.eventId } },
        ],
      };
      await atomicWriteJson(existing.path, merged, randomUUID);
      return merged;
    }

    const previous = active[0]?.record || null;
    for (const source of active) {
      const superseded = {
        ...source.record,
        status: 'superseded',
        lease: null,
        supersededBy: event.eventId,
        updatedAt: event.createdAt,
        history: [
          ...(source.record.history || []),
          { status: 'superseded', at: event.createdAt, evidence: { supersededBy: event.eventId } },
        ],
      };
      await atomicWriteJson(source.path, superseded, randomUUID);
    }

    const parentFingerprints = active.map(({ record }) => record.fingerprint);
    const record = initialRecord(event, fingerprint, {
      incidentId,
      generation: Number(previous?.generation || 0) + 1,
      budgetEpoch: Number(previous?.budgetEpoch || 1),
      totalAttempts: Number(previous?.totalAttempts || 0),
      agentMutationAttempts: Number(previous?.agentMutationAttempts || 0),
      parentGenerationId: previous?.event?.eventId || null,
      parentFingerprints,
    });
    await atomicWriteJson(join(queueDir, `${event.eventId}.json`), record, randomUUID);
    return record;
  });
}

function sumStrategyAttempts(records) {
  const result = {};
  for (const record of records) {
    for (const [strategy, attempts] of Object.entries(record.strategyAttempts || {})) {
      result[strategy] = Number(result[strategy] || 0) + Number(attempts || 0);
    }
  }
  return result;
}

function uniqueEvents(records) {
  const events = new Map();
  for (const record of records) {
    for (const event of [
      ...(record.sourceEvents || []),
      record.event,
      record.latestEvent,
    ]) {
      if (event?.eventId && !events.has(event.eventId)) events.set(event.eventId, event);
    }
  }
  return [...events.values()];
}

async function supersedeRecords(records, canonicalEventId, at, randomUUID = defaultRandomUUID) {
  for (const { path, record } of records) {
    if (!ACTIVE_STATUSES.has(record.status)) continue;
    await atomicWriteJson(path, {
      ...record,
      status: 'superseded',
      lease: null,
      supersededBy: canonicalEventId,
      updatedAt: at,
      history: [
        ...(record.history || []),
        { status: 'superseded', at, evidence: { supersededBy: canonicalEventId } },
      ],
    }, randomUUID);
  }
}

export async function compactRepairIncident({
  queueDir,
  site,
  pageId,
  hold = true,
  verificationCredit = 0,
} = {}) {
  if (!queueDir) throw new TypeError('queueDir is required');
  const ownerSite = requireString(site, 'site');
  if (!ALLOWED_SITES.has(ownerSite)) throw new TypeError('site must be astrologywiki or gengrowth');
  const ownerPageId = requireString(pageId, 'pageId');
  const credit = Number(verificationCredit);
  if (!Number.isFinite(credit) || credit < 0) throw new TypeError('verificationCredit must be non-negative');

  let incidentId;
  if (ownerPageId === 'RUN') {
    const candidates = (await readQueueRecords(queueDir))
      .map(({ record }) => record)
      .filter((record) => record.event.site === ownerSite
        && record.event.pageId === ownerPageId
        && ACTIVE_STATUSES.has(record.status));
    const incidentIds = [...new Set(candidates.map((record) => record.incidentId || repairIncidentId(record.event)))];
    if (incidentIds.length !== 1) throw new Error('RUN compaction requires exactly one active lane incident');
    [incidentId] = incidentIds;
  } else {
    incidentId = incidentIdForOwner(ownerSite, ownerPageId);
  }

  return withIncidentLock(queueDir, incidentId, async () => {
    const queueRecords = await readQueueRecords(queueDir);
    const belongsToIncident = (record) => record.event.site === ownerSite
      && record.event.pageId === ownerPageId
      && (record.incidentId || repairIncidentId(record.event)) === incidentId;
    const existing = queueRecords.find(({ record }) => (
      belongsToIncident(record)
      && record.status === 'migration_hold'
      && record.compaction?.canonical === true
    ));
    const active = queueRecords.filter(({ record }) => belongsToIncident(record)
      && ACTIVE_STATUSES.has(record.status));

    if (existing) {
      await supersedeRecords(active, existing.record.event.eventId, existing.record.updatedAt);
      return existing.record;
    }
    if (active.length === 0) throw new Error(`no active repair incident for ${ownerSite}/${ownerPageId}`);

    const records = active.map(({ record }) => record);
    const sourceEvents = uniqueEvents(records);
    const sourceEventIds = [...new Set(records.flatMap((record) => (
      record.sourceEventIds || [record.event.eventId]
    )).concat(sourceEvents.map((event) => event.eventId)))];
    const sourceFingerprints = [...new Set(records.map((record) => record.fingerprint))];
    const sourceHistories = records.map((record) => ({
      eventId: record.event.eventId,
      history: record.history || [],
    }));
    const latest = [...records].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
    const createdAt = new Date().toISOString();
    const canonicalEventId = `migration-${incidentId}`;
    const canonicalEvent = {
      ...latest.event,
      eventId: canonicalEventId,
      runId: `migration-${latest.event.runId}`,
      summary: `migration hold for ${ownerSite}/${ownerPageId}`,
      stderr: '',
      createdAt,
    };
    const history = records.flatMap((record) => (record.history || []).map((entry) => ({
      ...entry,
      evidence: {
        ...(entry.evidence || {}),
        sourceEventId: record.event.eventId,
      },
    })));
    history.push({
      status: 'migration_hold',
      at: createdAt,
      evidence: { sourceEventIds, verificationCredit: credit },
    });
    const canonical = {
      event: canonicalEvent,
      latestEvent: latest.latestEvent || latest.event,
      fingerprint: createHash('sha256').update(`migration\n${incidentId}`).digest('hex'),
      incidentId,
      generation: Math.max(...records.map((record) => Number(record.generation || 1))),
      budgetEpoch: Math.max(...records.map((record) => Number(record.budgetEpoch || 1))),
      totalAttempts: records.reduce((sum, record) => sum + Number(record.totalAttempts || 0), 0),
      agentMutationAttempts: records.reduce((sum, record) => sum + Number(record.agentMutationAttempts || 0), 0),
      sourceEventIds,
      sourceEvents,
      sourceFingerprints,
      sourceHistories,
      parentGenerationId: latest.event.eventId,
      status: 'migration_hold',
      observations: records.reduce((sum, record) => sum + Number(record.observations || 1), 0),
      strategy: 'migration_hold',
      strategyAttempts: sumStrategyAttempts(records),
      nextEligibleAt: null,
      lease: null,
      parentFingerprints: sourceFingerprints,
      terminalNotificationKey: null,
      hold,
      verificationCredit: credit,
      compaction: { canonical: true },
      history,
      updatedAt: createdAt,
    };
    await atomicWriteJson(join(queueDir, `${canonicalEventId}.json`), canonical);
    await supersedeRecords(active, canonicalEventId, createdAt);
    return canonical;
  });
}

function laneWeight(record) {
  const lane = String(record.event?.lane || '').toLowerCase();
  const stage = String(record.event?.stage || '').toLowerCase();
  if (LANE_WEIGHTS[lane] !== undefined) return LANE_WEIGHTS[lane];
  if (stage.includes('backfill') || stage.includes('writeback')) return LANE_WEIGHTS.backfill;
  if (stage.includes('merge') || stage.includes('live')) return LANE_WEIGHTS.live;
  if (stage.includes('publish') || stage.includes('preview') || stage.includes('gate')) return LANE_WEIGHTS.publish;
  if (stage.includes('author')) return LANE_WEIGHTS.author;
  return LANE_WEIGHTS.run;
}

function recordCreatedMs(record) {
  return Date.parse(record.event?.createdAt || record.updatedAt || 0);
}

export async function listEligibleRepairEvents({
  queueDir,
  now = new Date(),
  agingMs = DEFAULT_AGING_MS,
} = {}) {
  if (!queueDir) throw new TypeError('queueDir is required');
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const divisor = Math.max(1, Number(agingMs) || DEFAULT_AGING_MS);
  const eligible = (await readQueueRecords(queueDir))
    .map(({ record }) => record)
    .filter((record) => {
      if (!['queued', 'repair_pending'].includes(record.status)) return false;
      if (!record.nextEligibleAt) return true;
      return Date.parse(record.nextEligibleAt) <= nowMs;
    })
    .map((record) => ({
      record,
      score: laneWeight(record) + Math.max(0, Math.floor((nowMs - recordCreatedMs(record)) / divisor)),
    }))
    .sort((a, b) => b.score - a.score
      || recordCreatedMs(a.record) - recordCreatedMs(b.record)
      || a.record.event.eventId.localeCompare(b.record.event.eventId));
  return eligible.map(({ record }) => record);
}

function recordPath(queueDir, record) {
  return join(queueDir, `${record.event.eventId}.json`);
}

export async function acquireRepairLease(record, {
  queueDir,
  owner,
  now = new Date(),
  leaseMs = 15 * 60 * 1000,
  randomUUID = defaultRandomUUID,
} = {}) {
  if (!queueDir) throw new TypeError('queueDir is required');
  const path = recordPath(queueDir, record);
  let current;
  try { current = await readRepairRecord(path); } catch { return null; }
  const nowDate = now instanceof Date ? now : new Date(now);
  const currentExpiry = Date.parse(current.lease?.expiresAt || 0);
  if (['repairing', 'regating'].includes(current.status) && currentExpiry > nowDate.getTime()) return null;
  if (!['queued', 'repair_pending', 'repairing', 'regating'].includes(current.status)) return null;

  const leased = {
    ...current,
    status: 'repairing',
    lease: {
      owner: requireString(owner, 'lease owner'),
      startedAt: nowDate.toISOString(),
      expiresAt: new Date(nowDate.getTime() + Math.max(1, Number(leaseMs))).toISOString(),
    },
    updatedAt: nowDate.toISOString(),
    history: [
      ...(current.history || []),
      { status: 'repairing', at: nowDate.toISOString(), evidence: { owner } },
    ],
  };
  await atomicWriteJson(path, leased, randomUUID);
  return leased;
}

export async function transitionRepairEvent(record, transition, {
  queueDir,
  now = new Date(),
  randomUUID = defaultRandomUUID,
} = {}) {
  if (!queueDir) throw new TypeError('queueDir is required');
  const status = requireString(transition?.status, 'transition status');
  if (!ACTIVE_STATUSES.has(status) && !TERMINAL_STATUSES.has(status)) {
    throw new TypeError(`unsupported transition status: ${status}`);
  }
  const nowIso = iso(now, 'transition time');
  const next = {
    ...record,
    ...transition,
    status,
    lease: ['repairing', 'regating'].includes(status) ? (transition.lease || record.lease) : null,
    updatedAt: nowIso,
    history: [
      ...(record.history || []),
      { status, at: nowIso, evidence: transition.evidence || null },
    ],
  };
  await atomicWriteJson(recordPath(queueDir, record), next, randomUUID);
  return next;
}

export async function recoverExpiredLeases({
  queueDir,
  now = new Date(),
  randomUUID = defaultRandomUUID,
} = {}) {
  if (!queueDir) throw new TypeError('queueDir is required');
  const nowDate = now instanceof Date ? now : new Date(now);
  let count = 0;
  for (const { path, record } of await readQueueRecords(queueDir)) {
    if (!['repairing', 'regating'].includes(record.status)) continue;
    if (Date.parse(record.lease?.expiresAt || 0) > nowDate.getTime()) continue;
    const recovered = {
      ...record,
      status: 'queued',
      lease: null,
      updatedAt: nowDate.toISOString(),
      history: [
        ...(record.history || []),
        { status: 'queued', at: nowDate.toISOString(), evidence: { recoveredExpiredLease: true } },
      ],
    };
    await atomicWriteJson(path, recovered, randomUUID);
    count += 1;
  }
  return count;
}
