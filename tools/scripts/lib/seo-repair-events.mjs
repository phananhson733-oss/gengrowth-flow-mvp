import { createHash, randomUUID as defaultRandomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
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

export function repairIncidentId(value) {
  const event = validateRepairEvent(value);
  const owner = event.pageId === 'RUN' ? `${event.site}:${event.lane}:RUN` : `${event.site}:${event.pageId}`;
  return createHash('sha256').update(owner).digest('hex');
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

async function withIncidentLock(queueDir, incidentId, fn) {
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
      try {
        await atomicWriteJson(ownerPath, metadata);
      } catch (error) {
        await rm(path, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const current = await readJson(ownerPath);
      const live = current && pidIsAlive(Number(current.pid));
      const unexpired = current && Date.parse(current.expiresAt || 0) > Date.now();
      if (current && (!live || !unexpired)) {
        const confirmed = await readJson(ownerPath);
        if (confirmed?.token === current.token && Number(confirmed?.pid) === Number(current.pid)) {
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

  try {
    return await fn();
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

export async function listRepairRecords({ queueDir } = {}) {
  if (!queueDir) throw new TypeError('queueDir is required');
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
