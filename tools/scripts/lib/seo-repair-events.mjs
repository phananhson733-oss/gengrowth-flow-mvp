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

const TERMINAL_STATUSES = new Set(['published', 'archived', 'human_only']);
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

export function repairIncidentId() {
  throw new Error('repairIncidentId not implemented');
}

export function isActiveRepairStatus(status) {
  return ACTIVE_STATUSES.has(status);
}

export function repairEventFingerprint(value) {
  const event = validateRepairEvent(value);
  const evidence = normalizeRepairEvidence(`${event.summary}\n${event.stderr}`);
  return createHash('sha256')
    .update(`${event.site}\n${event.pageId}\n${event.stage}\n${evidence}`)
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

export async function compactRepairIncident() {
  throw new Error('compactRepairIncident not implemented');
}

function initialRecord(event, fingerprint, parentFingerprints = []) {
  return {
    event,
    latestEvent: event,
    fingerprint,
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
  const queueRecords = await readQueueRecords(queueDir);
  const existing = queueRecords.find(({ record }) => (
    record.fingerprint === fingerprint && ACTIVE_STATUSES.has(record.status)
  ));

  if (existing) {
    const merged = {
      ...existing.record,
      latestEvent: event,
      observations: Number(existing.record.observations || 1) + 1,
      updatedAt: event.createdAt,
      history: [
        ...(existing.record.history || []),
        { status: existing.record.status, at: event.createdAt, evidence: { observedEventId: event.eventId } },
      ],
    };
    await atomicWriteJson(existing.path, merged, randomUUID);
    return merged;
  }

  const parentFingerprints = queueRecords
    .map(({ record }) => record)
    .filter((record) => (
      ACTIVE_STATUSES.has(record.status)
      && record.fingerprint !== fingerprint
      && record.event.site === event.site
      && record.event.pageId === event.pageId
      && record.event.stage === event.stage
    ))
    .sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')))
    .map((record) => record.fingerprint);
  const record = initialRecord(event, fingerprint, parentFingerprints);
  await atomicWriteJson(join(queueDir, `${event.eventId}.json`), record, randomUUID);
  return record;
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
