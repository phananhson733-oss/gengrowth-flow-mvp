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
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const TERMINAL_STATUSES = new Set([
  'published',
  'archived',
  'human_only',
  'quarantined',
  'superseded',
  'migration_hold',
]);
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
  'missing_authoritative_source',
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
const TRANSACTION_SCHEMA_VERSION = 2;
const INCIDENT_ID_PATTERN = /^[a-f0-9]{64}$/;
const TRANSACTION_OPERATIONS = new Set(['replace_generation', 'finish_compaction', 'compact_incident']);
const TRANSACTION_FAULT_POINTS = new Set([
  'after-supersede-before-head-write',
  'after-canonical-before-source-supersede',
]);
const BLOCKING_PAGE_TERMINALS = new Set(['quarantined', 'human_only']);
const CODE_SHA_PATTERN = /^[a-f0-9]{40}$/;

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
  return (await readRepairRecordSnapshot(path)).record;
}

async function readRepairRecordSnapshot(path) {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || !parsed.event || !parsed.fingerprint) {
    throw new TypeError(`invalid repair record: ${path}`);
  }
  return {
    record: parsed,
    raw,
    recordHash: createHash('sha256').update(raw).digest('hex'),
  };
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
      records.push({ path, ...(await readRepairRecordSnapshot(path)) });
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

function pendingTransactionDirectory(queueDir) {
  return join(transactionDirectory(queueDir), 'pending');
}

function committedTransactionDirectory(queueDir) {
  return join(transactionDirectory(queueDir), 'committed');
}

function abortedTransactionDirectory(queueDir) {
  return join(transactionDirectory(queueDir), 'aborted');
}

function quarantinedTransactionDirectory(queueDir) {
  return join(transactionDirectory(queueDir), 'quarantine');
}

function transactionHoldDirectory(queueDir) {
  return join(transactionDirectory(queueDir), 'holds');
}

function transactionHeadDirectory(queueDir) {
  return join(transactionDirectory(queueDir), 'heads');
}

function transactionPath(queueDir, transactionId) {
  return join(pendingTransactionDirectory(queueDir), `${transactionId}.json`);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function assertExactKeys(value, allowed, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object`);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) throw new TypeError(`${label} has unsupported fields: ${unexpected.join(', ')}`);
}

function transactionHead(record) {
  return {
    eventId: record.event.eventId,
    generation: Number(record.generation || 1),
    revision: Number(record.revision || 0),
    fingerprint: record.fingerprint,
  };
}

function validateTransactionHead(value, label) {
  assertExactKeys(value, new Set(['eventId', 'generation', 'revision', 'fingerprint']), label);
  const eventId = requireString(value.eventId, `${label}.eventId`);
  const fingerprint = requireString(value.fingerprint, `${label}.fingerprint`);
  const generation = Number(value.generation);
  const revision = Number(value.revision);
  if (!Number.isInteger(generation) || generation < 1) {
    throw new TypeError(`${label}.generation must be a positive integer`);
  }
  if (!Number.isInteger(revision) || revision < 1) {
    throw new TypeError(`${label}.revision must be a positive integer`);
  }
  return { eventId, generation, revision, fingerprint };
}

function sameTransactionHead(left, right) {
  return Boolean(left && right
    && left.eventId === right.eventId
    && Number(left.generation) === Number(right.generation)
    && Number(left.revision) === Number(right.revision)
    && left.fingerprint === right.fingerprint);
}

function resolveTransactionWritePath(queueDir, filename) {
  if (typeof filename !== 'string' || filename.length === 0 || !filename.endsWith('.json')) {
    throw new TypeError(`invalid transaction record path: ${filename}`);
  }
  const root = resolve(queueDir);
  const destination = resolve(root, filename);
  if (dirname(destination) !== root) {
    throw new TypeError(`transaction write escapes queue: ${filename}`);
  }
  return destination;
}

function validateTransactionWrite(write, incidentId, queueDir) {
  assertExactKeys(
    write,
    new Set([
      'filename',
      'record',
      'expectedRevision',
      'expectedExists',
      'expectedRecordHash',
      'faultPointAfter',
    ]),
    'transaction write',
  );
  const destination = resolveTransactionWritePath(queueDir, write.filename);
  const expectedRevision = Number(write.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new TypeError('transaction write expectedRevision must be a non-negative integer');
  }
  const hasExpectedExists = Object.hasOwn(write, 'expectedExists');
  if (hasExpectedExists && typeof write.expectedExists !== 'boolean') {
    throw new TypeError('transaction write expectedExists must be boolean');
  }
  const expectedExists = hasExpectedExists ? write.expectedExists : expectedRevision > 0;
  const expectedRecordHash = write.expectedRecordHash === undefined
    ? null
    : requireString(write.expectedRecordHash, 'transaction write expectedRecordHash');
  if (expectedRecordHash !== null && !/^[a-f0-9]{64}$/.test(expectedRecordHash)) {
    throw new TypeError('transaction write expectedRecordHash must be a SHA-256');
  }
  if (!expectedExists && (expectedRevision !== 0 || expectedRecordHash !== null)) {
    throw new TypeError('new transaction write cannot carry an existing record snapshot');
  }
  if (!isPlainObject(write.record)) throw new TypeError('transaction write record must be an object');
  const event = validateRepairEvent(write.record.event);
  if (`${event.eventId}.json` !== write.filename) {
    throw new TypeError('transaction write filename must match record eventId');
  }
  if (recordIncidentId(write.record) !== incidentId || write.record.incidentId !== incidentId) {
    throw new TypeError('transaction write crosses incident ownership');
  }
  if (typeof write.record.fingerprint !== 'string' || write.record.fingerprint.length === 0) {
    throw new TypeError('transaction write record fingerprint is required');
  }
  const revision = Number(write.record.revision);
  if (!Number.isInteger(revision) || revision !== expectedRevision + 1) {
    throw new TypeError('transaction write revision must immediately follow expectedRevision');
  }
  if (write.faultPointAfter !== undefined && !TRANSACTION_FAULT_POINTS.has(write.faultPointAfter)) {
    throw new TypeError(`unsupported transaction fault point: ${write.faultPointAfter}`);
  }
  return {
    filename: write.filename,
    destination,
    record: write.record,
    expectedRevision,
    expectedExists,
    ...(expectedRecordHash ? { expectedRecordHash } : {}),
    ...(write.faultPointAfter ? { faultPointAfter: write.faultPointAfter } : {}),
  };
}

function validateTransactionIntent(intent, path, queueDir) {
  const filename = basename(path);
  if (!filename.endsWith('.json')) throw new TypeError('transaction intent filename must end in .json');
  const transactionIdFromFilename = filename.slice(0, -'.json'.length);
  if (intent?.schemaVersion === 1 && intent?.phase === 'committed') {
    assertExactKeys(intent, new Set([
      'schemaVersion', 'transactionId', 'incidentId', 'operation', 'phase',
      'createdAt', 'committedAt', 'writes',
    ]), 'legacy committed transaction');
    if (requireString(intent.transactionId, 'transactionId') !== transactionIdFromFilename) {
      throw new TypeError('transactionId must match intent filename');
    }
    if (!INCIDENT_ID_PATTERN.test(requireString(intent.incidentId, 'incidentId'))) {
      throw new TypeError('incidentId must be a repair incident hash');
    }
    if (!TRANSACTION_OPERATIONS.has(intent.operation)) throw new TypeError('unsupported transaction operation');
    if (!Array.isArray(intent.writes)) throw new TypeError('transaction writes must be an array');
    iso(intent.createdAt, 'transaction createdAt');
    iso(intent.committedAt, 'transaction committedAt');
    return { ...intent, legacyCommitted: true };
  }

  assertExactKeys(intent, new Set([
    'schemaVersion', 'transactionId', 'incidentId', 'causalRevision', 'operation',
    'phase', 'createdAt', 'committedAt', 'expectedHead', 'resultHead', 'writes',
  ]), 'repair transaction');
  if (intent.schemaVersion !== TRANSACTION_SCHEMA_VERSION) {
    throw new TypeError(`unsupported repair transaction schema: ${intent.schemaVersion}`);
  }
  const transactionId = requireString(intent.transactionId, 'transactionId');
  if (transactionId !== transactionIdFromFilename) {
    throw new TypeError('transactionId must match intent filename');
  }
  const incidentId = requireString(intent.incidentId, 'incidentId');
  if (!INCIDENT_ID_PATTERN.test(incidentId)) throw new TypeError('incidentId must be a repair incident hash');
  if (!TRANSACTION_OPERATIONS.has(intent.operation)) throw new TypeError('unsupported transaction operation');
  if (!['prepared', 'committed'].includes(intent.phase)) throw new TypeError('unsupported transaction phase');
  if (intent.phase === 'prepared' && intent.committedAt !== undefined) {
    throw new TypeError('prepared transaction cannot have committedAt');
  }
  if (intent.phase === 'committed') iso(intent.committedAt, 'transaction committedAt');
  const causalRevision = Number(intent.causalRevision);
  if (!Number.isInteger(causalRevision) || causalRevision < 1) {
    throw new TypeError('causalRevision must be a positive integer');
  }
  const expectedHead = validateTransactionHead(intent.expectedHead, 'expectedHead');
  const resultHead = validateTransactionHead(intent.resultHead, 'resultHead');
  iso(intent.createdAt, 'transaction createdAt');
  if (!Array.isArray(intent.writes) || intent.writes.length === 0) {
    throw new TypeError('transaction writes must be a non-empty array');
  }
  const writes = intent.writes.map((write) => validateTransactionWrite(write, incidentId, queueDir));
  if (new Set(writes.map((write) => write.filename)).size !== writes.length) {
    throw new TypeError('transaction writes must target unique record filenames');
  }
  const resultWrite = writes.find((write) => sameTransactionHead(transactionHead(write.record), resultHead));
  if (intent.operation === 'finish_compaction') {
    if (!sameTransactionHead(expectedHead, resultHead)) {
      throw new TypeError('finish_compaction must preserve its authoritative head');
    }
    if (writes.some((write) => write.record.status !== 'superseded'
      || write.record.supersededBy !== resultHead.eventId)) {
      throw new TypeError('finish_compaction may only supersede sources into its authoritative head');
    }
  } else if (!resultWrite) {
    throw new TypeError('transaction resultHead must match one of its writes');
  } else {
    const expectedWrite = writes.find((write) => write.record.event.eventId === expectedHead.eventId
      && write.expectedRevision === expectedHead.revision
      && Number(write.record.generation || 1) === expectedHead.generation
      && write.record.fingerprint === expectedHead.fingerprint);
    if (!expectedWrite) throw new TypeError('transaction expectedHead must be revision-fenced by a write');
    if (intent.operation === 'replace_generation') {
      if (!ACTIVE_STATUSES.has(resultWrite.record.status)
        || writes.some((write) => write !== resultWrite
          && (write.record.status !== 'superseded'
            || write.record.supersededBy !== resultHead.eventId))) {
        throw new TypeError('replace_generation must install one active head and supersede its sources');
      }
    } else if (intent.operation === 'compact_incident') {
      if (resultWrite.record.status !== 'migration_hold'
        || resultWrite.record.compaction?.canonical !== true
        || writes.some((write) => write !== resultWrite
          && (write.record.status !== 'superseded'
            || write.record.supersededBy !== resultHead.eventId))) {
        throw new TypeError('compact_incident must install one canonical hold and supersede its sources');
      }
    }
  }
  return {
    ...intent,
    transactionId,
    incidentId,
    causalRevision,
    expectedHead,
    resultHead,
    writes,
  };
}

function inferIncidentId(path, parsed = null) {
  if (INCIDENT_ID_PATTERN.test(String(parsed?.incidentId || ''))) return parsed.incidentId;
  const match = basename(path).match(/^([a-f0-9]{64})(?:-|\.)/);
  return match?.[1] || null;
}

async function transactionPendingPaths(queueDir) {
  const directory = transactionDirectory(queueDir);
  const paths = [];
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    paths.push(...entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => join(directory, entry.name)));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  try {
    const names = await readdir(pendingTransactionDirectory(queueDir));
    paths.push(...names
      .filter((name) => name.endsWith('.json'))
      .map((name) => join(pendingTransactionDirectory(queueDir), name)));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return paths.sort();
}

async function appendTransactionHold(queueDir, path, reason, incidentId, randomUUID = defaultRandomUUID) {
  const directory = transactionHoldDirectory(queueDir);
  await mkdir(directory, { recursive: true });
  const artifact = {
    schemaVersion: 1,
    status: 'recovery_hold',
    incidentId,
    transactionFile: basename(path),
    summary: `corrupt transaction intent: ${reason}`,
    createdAt: new Date().toISOString(),
  };
  const destination = join(directory, `${Date.now()}-${randomUUID()}.json`);
  await writeNewJson(destination, artifact);
  return artifact;
}

async function quarantineTransactionIntent(queueDir, path, error, parsed = null, randomUUID = defaultRandomUUID) {
  const incidentId = inferIncidentId(path, parsed);
  const directory = quarantinedTransactionDirectory(queueDir);
  await mkdir(directory, { recursive: true });
  const destination = join(directory, `${basename(path)}.${Date.now()}.${randomUUID()}.corrupt`);
  try {
    await rename(path, destination);
  } catch (renameError) {
    if (renameError?.code !== 'ENOENT') throw renameError;
  }
  await appendTransactionHold(queueDir, path, error?.message || String(error), incidentId, randomUUID);
  return incidentId;
}

async function archiveCommittedIntent(queueDir, path, randomUUID = defaultRandomUUID) {
  const directory = committedTransactionDirectory(queueDir);
  await mkdir(directory, { recursive: true });
  const destination = join(
    directory,
    `${basename(path)}.${Date.now()}.${randomUUID()}.committed`,
  );
  try {
    await rename(path, destination);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return destination;
}

async function archiveAbortedIntent(queueDir, path, error, randomUUID = defaultRandomUUID) {
  const directory = abortedTransactionDirectory(queueDir);
  await mkdir(directory, { recursive: true });
  const destination = join(
    directory,
    `${basename(path)}.${Date.now()}.${randomUUID()}.aborted`,
  );
  try {
    await rename(path, destination);
  } catch (renameError) {
    if (renameError?.code !== 'ENOENT') throw renameError;
  }
  await atomicWriteJson(`${destination}.metadata.json`, {
    abortedAt: new Date().toISOString(),
    abortReason: error instanceof Error ? error.message : String(error),
  }, randomUUID);
  return destination;
}

async function readTransactionCausalHead(queueDir, incidentId) {
  let names;
  try {
    names = await readdir(transactionHeadDirectory(queueDir));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const heads = [];
  for (const name of names.filter((entry) => entry.startsWith(`${incidentId}-`) && entry.endsWith('.json'))) {
    const head = await readJson(join(transactionHeadDirectory(queueDir), name));
    if (head?.incidentId === incidentId && Number.isInteger(head.causalRevision)) heads.push(head);
  }
  return heads.sort((left, right) => right.causalRevision - left.causalRevision
    || String(right.committedAt || '').localeCompare(String(left.committedAt || '')))[0] || null;
}

async function advanceTransactionCausalHead(queueDir, intent, randomUUID = defaultRandomUUID) {
  if (!Number.isInteger(intent.causalRevision)) return;
  const transactionKey = createHash('sha256').update(intent.transactionId).digest('hex').slice(0, 16);
  const path = join(
    transactionHeadDirectory(queueDir),
    `${intent.incidentId}-${String(intent.causalRevision).padStart(12, '0')}-${transactionKey}.json`,
  );
  try {
    await writeNewJson(path, {
      schemaVersion: 1,
      incidentId: intent.incidentId,
      causalRevision: intent.causalRevision,
      resultHead: intent.resultHead,
      transactionId: intent.transactionId,
      committedAt: intent.committedAt || new Date().toISOString(),
    });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
}

async function listHeldIncidentIds(queueDir) {
  let names;
  try {
    names = await readdir(transactionHoldDirectory(queueDir));
  } catch (error) {
    if (error?.code === 'ENOENT') return new Set();
    throw error;
  }
  const held = new Set();
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const artifact = await readJson(join(transactionHoldDirectory(queueDir), name));
    if (INCIDENT_ID_PATTERN.test(String(artifact?.incidentId || ''))) held.add(artifact.incidentId);
  }
  return held;
}

async function listTransactionIntents(queueDir, {
  randomUUID = defaultRandomUUID,
  transactionInstrumentation,
} = {}) {
  const intents = [];
  for (const path of await transactionPendingPaths(queueDir)) {
    if (transactionInstrumentation) {
      transactionInstrumentation.pendingReads = Number(transactionInstrumentation.pendingReads || 0) + 1;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
      const intent = validateTransactionIntent(parsed, path, queueDir);
      if (intent.phase === 'committed') {
        await advanceTransactionCausalHead(queueDir, intent, randomUUID);
        await archiveCommittedIntent(queueDir, path, randomUUID);
        continue;
      }
      intents.push({ path, intent });
    } catch (error) {
      await quarantineTransactionIntent(queueDir, path, error, parsed, randomUUID);
    }
  }
  return intents.sort((left, right) => left.intent.causalRevision - right.intent.causalRevision
    || left.intent.createdAt.localeCompare(right.intent.createdAt)
    || left.intent.transactionId.localeCompare(right.intent.transactionId));
}

function transactionWrite(filename, record, {
  faultPointAfter = null,
  expectedRevision = Math.max(0, Number(record?.revision || 1) - 1),
  expectedExists = expectedRevision > 0,
  expectedRecordHash = null,
} = {}) {
  if (basename(filename) !== filename || !filename.endsWith('.json')) {
    throw new TypeError(`invalid transaction record path: ${filename}`);
  }
  return {
    filename,
    record,
    expectedRevision,
    expectedExists,
    ...(expectedRecordHash ? { expectedRecordHash } : {}),
    ...(faultPointAfter ? { faultPointAfter } : {}),
  };
}

async function prepareTransaction(queueDir, {
  incidentId,
  operation,
  writes,
  createdAt,
  expectedHead,
  resultHead,
}, {
  randomUUID = defaultRandomUUID,
  assertOwner,
} = {}) {
  const currentCausalHead = await readTransactionCausalHead(queueDir, incidentId);
  const causalRevision = Number(currentCausalHead?.causalRevision || 0) + 1;
  const transactionId = `${incidentId}-${randomUUID()}`;
  const path = transactionPath(queueDir, transactionId);
  const intent = {
    schemaVersion: TRANSACTION_SCHEMA_VERSION,
    transactionId,
    incidentId,
    causalRevision,
    operation,
    phase: 'prepared',
    createdAt,
    expectedHead: validateTransactionHead(expectedHead, 'expectedHead'),
    resultHead: validateTransactionHead(resultHead, 'resultHead'),
    writes,
  };
  const validated = validateTransactionIntent(intent, path, queueDir);
  const serializable = {
    ...validated,
    writes: validated.writes.map(({ destination, ...write }) => write),
  };
  if (assertOwner) await assertOwner();
  await atomicWriteJson(path, serializable, randomUUID);
  return { path, intent: serializable };
}

async function applyPreparedTransaction(queueDir, path, intent, {
  randomUUID = defaultRandomUUID,
  faultInjector,
  assertOwner,
} = {}) {
  const latest = validateTransactionIntent(JSON.parse(await readFile(path, 'utf8')), path, queueDir);
  if (latest.phase === 'committed') {
    await advanceTransactionCausalHead(queueDir, latest, randomUUID);
    await archiveCommittedIntent(queueDir, path, randomUUID);
    return latest;
  }
  if (latest.transactionId !== intent.transactionId
    || latest.incidentId !== intent.incidentId
    || latest.causalRevision !== intent.causalRevision
    || latest.phase !== 'prepared') {
    throw new Error(`repair transaction changed unexpectedly: ${intent.transactionId}`);
  }
  const preflightError = (message, cause = undefined) => {
    const error = new Error(message, cause ? { cause } : undefined);
    error.repairTransactionPreflight = true;
    return error;
  };
  const causalHead = await readTransactionCausalHead(queueDir, latest.incidentId);
  if (Number(causalHead?.causalRevision || 0) > latest.causalRevision
    || (Number(causalHead?.causalRevision || 0) === latest.causalRevision
      && (causalHead?.transactionId !== latest.transactionId
        || !sameTransactionHead(causalHead?.resultHead, latest.resultHead)))) {
    throw preflightError(`stale causal repair transaction: ${latest.transactionId}`);
  }
  const queueRecords = await readQueueRecords(queueDir);
  const currentHead = authoritativeHead(queueRecords, latest.incidentId);
  if (currentHead
    && !sameTransactionHead(transactionHead(currentHead), latest.expectedHead)
    && !sameTransactionHead(transactionHead(currentHead), latest.resultHead)) {
    throw preflightError(`stale authoritative head for repair transaction: ${latest.transactionId}`);
  }
  const snapshots = [];
  for (const write of latest.writes) {
    if (assertOwner) await assertOwner();
    let current = null;
    try {
      current = await readRepairRecordSnapshot(write.destination);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw preflightError(`invalid transaction snapshot: ${write.filename}`, error);
      }
    }
    const alreadyApplied = current
      && JSON.stringify(current.record) === JSON.stringify(write.record);
    if (!alreadyApplied) {
      if (!write.expectedExists) {
        if (current !== null) {
          throw preflightError(`stale new-record transaction snapshot: ${write.filename}`);
        }
      } else if (!current
        || recordIncidentId(current.record) !== latest.incidentId
        || current.record.event?.eventId !== write.record.event?.eventId) {
        throw preflightError(`stale existing-record transaction snapshot: ${write.filename}`);
      } else if (write.expectedRecordHash
        ? current.recordHash !== write.expectedRecordHash
        : Number(current.record.revision || 0) !== write.expectedRevision) {
        throw preflightError(`stale transaction snapshot: ${write.filename}`);
      }
    }
    snapshots.push({ write, alreadyApplied });
  }
  for (const { write, alreadyApplied } of snapshots) {
    if (assertOwner) await assertOwner();
    if (!alreadyApplied) await atomicWriteJson(write.destination, write.record, randomUUID);
    if (write.faultPointAfter) {
      await injectFault(faultInjector, write.faultPointAfter, {
        incidentId: latest.incidentId,
        transactionId: latest.transactionId,
      });
    }
  }
  const committed = {
    ...latest,
    writes: latest.writes.map(({ destination, ...write }) => write),
    phase: 'committed',
    committedAt: new Date().toISOString(),
  };
  if (assertOwner) await assertOwner();
  await atomicWriteJson(path, committed, randomUUID);
  await advanceTransactionCausalHead(queueDir, committed, randomUUID);
  await archiveCommittedIntent(queueDir, path, randomUUID);
  return committed;
}

async function applyPreparedTransactionOrAbort(queueDir, prepared, {
  randomUUID = defaultRandomUUID,
  faultInjector,
  assertOwner,
} = {}) {
  await injectFault(faultInjector, 'after-transaction-prepare', {
    incidentId: prepared.intent.incidentId,
    transactionId: prepared.intent.transactionId,
  });
  try {
    return await applyPreparedTransaction(queueDir, prepared.path, prepared.intent, {
      randomUUID,
      faultInjector,
      assertOwner,
    });
  } catch (error) {
    if (error?.repairTransactionPreflight === true) {
      await archiveAbortedIntent(queueDir, prepared.path, error, randomUUID);
    }
    throw error;
  }
}

async function recoverIncidentTransactionsLocked(queueDir, incidentId, {
  randomUUID = defaultRandomUUID,
  assertOwner,
} = {}) {
  let recovered = 0;
  const held = await listHeldIncidentIds(queueDir);
  if (held.has(incidentId)) throw new Error(`repair transaction recovery hold: ${incidentId}`);
  for (const { path, intent } of await listTransactionIntents(queueDir, { randomUUID })) {
    if (intent.incidentId !== incidentId) continue;
    try {
      await applyPreparedTransaction(queueDir, path, intent, { randomUUID, assertOwner });
      recovered += 1;
    } catch (error) {
      await quarantineTransactionIntent(queueDir, path, error, intent, randomUUID);
      break;
    }
  }
  return recovered;
}

async function recoverPreparedTransactions(queueDir, {
  randomUUID = defaultRandomUUID,
  transactionInstrumentation,
} = {}) {
  const intents = await listTransactionIntents(queueDir, { randomUUID, transactionInstrumentation });
  const held = await listHeldIncidentIds(queueDir);
  const incidentIds = [...new Set(
    intents
      .filter(({ intent }) => !held.has(intent.incidentId))
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

export async function listRepairRecords({ queueDir, transactionInstrumentation } = {}) {
  if (!queueDir) throw new TypeError('queueDir is required');
  await recoverPreparedTransactions(queueDir, { transactionInstrumentation });
  return (await readQueueRecords(queueDir)).map(({ record }) => record);
}

function initialRecord(event, fingerprint, {
  incidentId,
  generation = 1,
  budgetEpoch = 1,
  totalAttempts = 0,
  agentMutationAttempts = 0,
  firstDetectedAt = event.createdAt,
  windowCount = 1,
  lastArtifactSha = null,
  noProgressCount = 0,
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
    firstDetectedAt,
    windowCount,
    lastArtifactSha,
    noProgressCount,
    sourceEventIds: [event.eventId],
    sourceEvents: [event],
    parentGenerationId,
    status: 'queued',
    revision: 1,
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

function eventIdentity(value) {
  return createHash('sha256')
    .update(JSON.stringify(validateRepairEvent(value)))
    .digest('hex');
}

function matchingSourceEvents(record, eventId) {
  return [
    record.event,
    record.latestEvent,
    ...(record.sourceEvents || []),
  ].filter((candidate) => candidate?.eventId === eventId);
}

function recordIncidentId(record) {
  return record.incidentId || repairIncidentId(record.event);
}

function supersededRecord(record, {
  supersededBy,
  at,
  incidentId = recordIncidentId(record),
  generation = Number(record.generation || 1),
} = {}) {
  return {
    ...record,
    incidentId,
    generation,
    status: 'superseded',
    revision: Number(record.revision || 0) + 1,
    lease: null,
    supersededBy,
    updatedAt: at,
    history: [
      ...(record.history || []),
      { status: 'superseded', at, evidence: { supersededBy } },
    ],
  };
}

function authoritativeHead(records, incidentId) {
  const owned = records
    .map(({ record }) => record)
    .filter((record) => recordIncidentId(record) === incidentId);
  const hold = owned
    .filter((record) => record.status === 'migration_hold' && record.compaction?.canonical === true)
    .sort((a, b) => Number(b.generation || 1) - Number(a.generation || 1)
      || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
  if (hold) return hold;
  const active = owned
    .filter((record) => ACTIVE_STATUSES.has(record.status))
    .sort((a, b) => Number(b.generation || 1) - Number(a.generation || 1)
      || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
      || String(b.event?.eventId || '').localeCompare(String(a.event?.eventId || '')))[0];
  if (active) return active;
  return owned
    .filter((record) => record.event?.pageId !== 'RUN'
      && BLOCKING_PAGE_TERMINALS.has(record.status))
    .sort((a, b) => Number(b.generation || 1) - Number(a.generation || 1)
      || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
      || String(b.event?.eventId || '').localeCompare(String(a.event?.eventId || '')))[0] || null;
}

function blockingPageTerminal(records, incidentId) {
  return records
    .filter(({ record }) => recordIncidentId(record) === incidentId
      && record.event?.pageId !== 'RUN'
      && (BLOCKING_PAGE_TERMINALS.has(record.status)
        || (record.compaction?.canonical === true
          && (record.status === 'migration_hold' || ACTIVE_STATUSES.has(record.status)))))
    .sort((left, right) => {
      const leftCanonical = left.record.status === 'migration_hold'
        && left.record.compaction?.canonical === true ? 1 : 0;
      const rightCanonical = right.record.status === 'migration_hold'
        && right.record.compaction?.canonical === true ? 1 : 0;
      return rightCanonical - leftCanonical
        || Number(right.record.generation || 1) - Number(left.record.generation || 1)
        || String(right.record.updatedAt || '').localeCompare(String(left.record.updatedAt || ''))
        || String(right.record.event?.eventId || '').localeCompare(String(left.record.event?.eventId || ''));
    })[0] || null;
}

function mergeObservedEvent(record, event, fingerprint, incidentId, {
  preserveUpdatedAt = false,
  preserveLatestEvent = false,
} = {}) {
  const existingSourceEvents = record.sourceEvents || [record.event];
  const hasSourceEvent = existingSourceEvents.some((source) => source?.eventId === event.eventId);
  const currentLatestEvent = record.latestEvent || record.event;
  const existingSourceEventIds = new Set(
    record.sourceEventIds || existingSourceEvents.map((source) => source.eventId),
  );
  const currentGenerationRunIds = new Set(existingSourceEvents.map((source) => source.runId));
  const sourceEventIds = [...new Set([...existingSourceEventIds, event.eventId])];
  const sourceEvents = hasSourceEvent
    ? existingSourceEvents
    : [...existingSourceEvents, event];
  return {
    ...record,
    incidentId,
    latestEvent: preserveLatestEvent
      && String(currentLatestEvent?.createdAt || '') > event.createdAt
      ? currentLatestEvent
      : event,
    revision: Number(record.revision || 0) + 1,
    observations: Number(record.observations || 1) + 1,
    firstDetectedAt: record.firstDetectedAt || record.event.createdAt,
    windowCount: Number(record.windowCount || currentGenerationRunIds.size || 1)
      + (currentGenerationRunIds.has(event.runId) ? 0 : 1),
    lastArtifactSha: record.lastArtifactSha || null,
    noProgressCount: Number(record.noProgressCount || 0),
    sourceEventIds,
    sourceEvents,
    sourceFingerprints: [...new Set([
      ...(record.sourceFingerprints || [record.fingerprint]),
      fingerprint,
    ])],
    updatedAt: preserveUpdatedAt && String(record.updatedAt || '') > event.createdAt
      ? record.updatedAt
      : event.createdAt,
    history: [
      ...(record.history || []),
      {
        status: record.status,
        at: event.createdAt,
        evidence: {
          observedEventId: event.eventId,
          observedFingerprint: fingerprint,
        },
      },
    ],
  };
}

export function hasAvailableVerificationCredit(record) {
  const release = record?.verificationCreditRelease;
  return Boolean(
    record?.compaction?.canonical === true
    && record.verificationCredit === 1
    && record.verificationCreditRemaining === 1
    && record.verificationCreditConsumedAt == null
    && record.verificationCreditConsumedBy == null
    && release
    && CODE_SHA_PATTERN.test(String(release.codeSha || ''))
    && typeof release.reason === 'string'
    && release.reason.trim() !== ''
    && Number.isFinite(Date.parse(release.releasedAt || ''))
    && release.budgetEpoch === record.budgetEpoch,
  );
}

function sameRecordSnapshot(snapshot, current) {
  if (!snapshot || !current) return false;
  if (snapshot.event?.eventId !== current.event?.eventId
    || snapshot.fingerprint !== current.fingerprint
    || Number(snapshot.generation || 1) !== Number(current.generation || 1)) {
    return false;
  }
  if (snapshot.revision !== undefined || current.revision !== undefined) {
    return Number(snapshot.revision || 0) === Number(current.revision || 0);
  }
  return snapshot.status === current.status && snapshot.updatedAt === current.updatedAt;
}

function sameTransitionAuthority(snapshot, current) {
  if (!snapshot || !current
    || snapshot.event?.eventId !== current.event?.eventId
    || snapshot.fingerprint !== current.fingerprint
    || Number(snapshot.generation || 1) !== Number(current.generation || 1)) {
    return false;
  }
  const snapshotFence = snapshot.lease?.fencingToken;
  if (snapshotFence) {
    return snapshotFence === current.lease?.fencingToken;
  }
  return sameRecordSnapshot(snapshot, current);
}

export async function enqueueRepairEvent(value, {
  queueDir,
  randomUUID = defaultRandomUUID,
  faultInjector,
} = {}) {
  if (!queueDir) throw new TypeError('queueDir is required');
  const event = validateRepairEvent(value);
  const fingerprint = repairEventFingerprint(event);
  const incidentId = repairIncidentId(event);
  return withIncidentLock(queueDir, incidentId, async ({ assertOwner }) => {
    await recoverIncidentTransactionsLocked(queueDir, incidentId, { randomUUID, assertOwner });
    const queueRecords = await readQueueRecords(queueDir);
    const matches = queueRecords.flatMap(({ record }) => (
      matchingSourceEvents(record, event.eventId).map((sourceEvent) => ({ record, sourceEvent }))
    ));
    if (matches.some(({ sourceEvent }) => eventIdentity(sourceEvent) !== eventIdentity(event))) {
      throw new Error(`eventId identity collision: ${event.eventId}`);
    }
    if (matches.length > 0) {
      return matches
        .map(({ record }) => record)
        .sort((a, b) => Number(b.generation || 1) - Number(a.generation || 1)
          || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
    }
    const blocking = blockingPageTerminal(queueRecords, incidentId);
    if (blocking) {
      const merged = mergeObservedEvent(blocking.record, event, fingerprint, incidentId, {
        preserveUpdatedAt: true,
        preserveLatestEvent: true,
      });
      await assertOwner();
      await atomicWriteJson(blocking.path, merged, randomUUID);
      return merged;
    }
    const active = queueRecords
      .filter(({ record }) => ACTIVE_STATUSES.has(record.status)
        && recordIncidentId(record) === incidentId)
      .sort((a, b) => Number(b.record.generation || 1) - Number(a.record.generation || 1)
        || String(b.record.updatedAt || '').localeCompare(String(a.record.updatedAt || '')));
    const existing = active.find(({ record }) => record.fingerprint === fingerprint);

    if (existing) {
      const merged = mergeObservedEvent(existing.record, event, fingerprint, incidentId);
      await assertOwner();
      await atomicWriteJson(existing.path, merged, randomUUID);
      return merged;
    }

    const previous = active[0]?.record || null;
    const parentFingerprints = active.map(({ record }) => record.fingerprint);
    const inheritedRunIds = new Set(active.flatMap(({ record: source }) => (
      source.sourceEvents || [source.latestEvent || source.event]
    )).map((source) => source.runId));
    const inheritedWindowCount = active.length > 0
      ? Math.max(...active.map(({ record: source }) => (
        Number(source.windowCount || new Set(
          (source.sourceEvents || [source.event]).map((item) => item.runId),
        ).size || 1)
      )))
      : 0;
    const firstDetectedAt = active
      .map(({ record: source }) => source.firstDetectedAt || source.event.createdAt)
      .concat(event.createdAt)
      .sort()[0];
    const record = initialRecord(event, fingerprint, {
      incidentId,
      generation: Number(previous?.generation || 0) + 1,
      budgetEpoch: Number(previous?.budgetEpoch || 1),
      totalAttempts: Number(previous?.totalAttempts || 0),
      agentMutationAttempts: Number(previous?.agentMutationAttempts || 0),
      firstDetectedAt,
      windowCount: Math.max(1, inheritedWindowCount + (inheritedRunIds.has(event.runId) ? 0 : 1)),
      lastArtifactSha: null,
      noProgressCount: 0,
      parentGenerationId: previous?.event?.eventId || null,
      parentFingerprints,
    });
    if (active.length === 0) {
      await assertOwner();
      await atomicWriteJson(join(queueDir, `${event.eventId}.json`), record, randomUUID);
      return record;
    }
    const writes = active.map(({ path, record: source, recordHash }, index) => transactionWrite(
      basename(path),
      supersededRecord(source, {
        supersededBy: event.eventId,
        at: event.createdAt,
        incidentId,
        generation: Number(source.generation || 1),
      }),
      {
        expectedRevision: Number(source.revision || 0),
        expectedExists: true,
        expectedRecordHash: recordHash,
        ...(index === active.length - 1
          ? { faultPointAfter: 'after-supersede-before-head-write' }
          : {}),
      },
    ));
    writes.push(transactionWrite(`${event.eventId}.json`, record, {
      expectedRevision: 0,
      expectedExists: false,
    }));
    const prepared = await prepareTransaction(queueDir, {
      incidentId,
      operation: 'replace_generation',
      writes,
      createdAt: event.createdAt,
      expectedHead: transactionHead(previous),
      resultHead: transactionHead(record),
    }, { randomUUID, assertOwner });
    await applyPreparedTransactionOrAbort(queueDir, prepared, {
      randomUUID,
      faultInjector,
      assertOwner,
    });
    return record;
  }, { faultInjector });
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

function historyAttemptAccounting(records) {
  const strategyAttempts = {};
  let totalAttempts = 0;
  let mutationMarkers = 0;
  let agentMutationAttempts = 0;
  for (const record of records) {
    for (const entry of record.history || []) {
      const attempt = Number(entry?.evidence?.attempt);
      if (Number.isInteger(attempt) && attempt > 0) {
        totalAttempts += 1;
        const strategy = String(entry?.evidence?.strategy || '').trim();
        if (strategy) {
          strategyAttempts[strategy] = Number(strategyAttempts[strategy] || 0) + 1;
        }
      }
      if (typeof entry?.evidence?.agentMutationInvoked === 'boolean') {
        mutationMarkers += 1;
        if (entry.evidence.agentMutationInvoked) agentMutationAttempts += 1;
      }
    }
  }
  return {
    totalAttempts,
    strategyAttempts,
    mutationMarkers,
    agentMutationAttempts,
  };
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

export async function compactRepairIncident({
  queueDir,
  site,
  pageId,
  hold = true,
  verificationCredit = 0,
  adoptBlockingTerminal = false,
  faultInjector,
  randomUUID = defaultRandomUUID,
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

  return withIncidentLock(queueDir, incidentId, async ({ assertOwner }) => {
    await recoverIncidentTransactionsLocked(queueDir, incidentId, { randomUUID, assertOwner });
    const queueRecords = await readQueueRecords(queueDir);
    const belongsToIncident = (record) => record.event.site === ownerSite
      && record.event.pageId === ownerPageId
      && (record.incidentId || repairIncidentId(record.event)) === incidentId;
    const owned = queueRecords.filter(({ record }) => belongsToIncident(record));
    const existing = owned
      .filter(({ record }) => record.compaction?.canonical === true)
      .sort((left, right) => Number(right.record.generation || 1) - Number(left.record.generation || 1)
        || String(right.record.updatedAt || '').localeCompare(String(left.record.updatedAt || '')))[0];
    const active = queueRecords.filter(({ record }) => belongsToIncident(record)
      && ACTIVE_STATUSES.has(record.status));

    if (existing) {
      if (existing.record.status !== 'migration_hold') return existing.record;
      const incompleteSources = owned.filter(({ path, record }) => path !== existing.path
        && (ACTIVE_STATUSES.has(record.status) || BLOCKING_PAGE_TERMINALS.has(record.status)));
      if (incompleteSources.length > 0) {
        const prepared = await prepareTransaction(queueDir, {
          incidentId,
          operation: 'finish_compaction',
          createdAt: existing.record.updatedAt,
          expectedHead: transactionHead(existing.record),
          resultHead: transactionHead(existing.record),
          writes: incompleteSources.map(({ path, record, recordHash }) => transactionWrite(
            basename(path),
            supersededRecord(record, {
              supersededBy: existing.record.event.eventId,
              at: existing.record.updatedAt,
              incidentId,
              generation: Number(record.generation || 1),
            }),
            {
              expectedRevision: Number(record.revision || 0),
              expectedExists: true,
              expectedRecordHash: recordHash,
            },
          )),
        }, { randomUUID, assertOwner });
        await applyPreparedTransactionOrAbort(queueDir, prepared, {
          randomUUID,
          faultInjector,
          assertOwner,
        });
      }
      return existing.record;
    }
    let sourceEntries = active;
    let adoptingTerminal = false;
    if (sourceEntries.length === 0) {
      if (adoptBlockingTerminal !== true) {
        throw new Error(`no active repair incident for ${ownerSite}/${ownerPageId}`);
      }
      if (ownerPageId === 'RUN') {
        throw new Error('blocking terminal adoption requires a page-level incident');
      }
      if (credit !== 1) {
        throw new Error('blocking terminal adoption requires verificationCredit exactly 1');
      }
      const blocking = owned.filter(({ record }) => BLOCKING_PAGE_TERMINALS.has(record.status));
      if (blocking.length === 0) {
        throw new Error(`no blocking terminal repair incident for ${ownerSite}/${ownerPageId}`);
      }
      const unsupported = owned.filter(({ record }) => (
        !BLOCKING_PAGE_TERMINALS.has(record.status) && record.status !== 'superseded'
      ));
      if (unsupported.length > 0) {
        throw new Error(`blocking terminal adoption found unsupported incident state for ${ownerSite}/${ownerPageId}`);
      }
      sourceEntries = owned;
      adoptingTerminal = true;
    }

    const records = sourceEntries.map(({ record }) => record);
    const sourceEvents = uniqueEvents(records);
    const sourceEventIds = [...new Set(records.flatMap((record) => (
      record.sourceEventIds || [record.event.eventId]
    )).concat(sourceEvents.map((event) => event.eventId)))];
    const sourceFingerprints = [...new Set(records.flatMap((record) => (
      record.sourceFingerprints || [record.fingerprint]
    )).concat(records.map((record) => record.fingerprint)))];
    const sourceHistories = records.map((record) => ({
      eventId: record.event.eventId,
      history: record.history || [],
      ...(record.sourceHistories ? { sourceHistories: record.sourceHistories } : {}),
    }));
    const sourceRecordHashes = sourceEntries
      .map(({ path, record, recordHash }) => ({
        eventId: record.event.eventId,
        filename: basename(path),
        sha256: recordHash,
      }));
    sourceRecordHashes.sort((left, right) => left.filename.localeCompare(right.filename));
    const historyAccounting = historyAttemptAccounting(records);
    const recordedStrategyAttempts = sumStrategyAttempts(records);
    const strategyAttempts = { ...recordedStrategyAttempts };
    for (const [strategy, attempts] of Object.entries(historyAccounting.strategyAttempts)) {
      strategyAttempts[strategy] = Math.max(
        Number(strategyAttempts[strategy] || 0),
        Number(attempts || 0),
      );
    }
    const recordedTotalAttempts = records
      .reduce((sum, record) => sum + Number(record.totalAttempts || 0), 0);
    const recordedAgentMutationAttempts = records
      .reduce((sum, record) => sum + Number(record.agentMutationAttempts || 0), 0);
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
      generation: Math.max(...records.map((record) => Number(record.generation || 1)))
        + (adoptingTerminal ? 1 : 0),
      budgetEpoch: Math.max(...records.map((record) => Number(record.budgetEpoch || 1))),
      totalAttempts: Math.max(recordedTotalAttempts, historyAccounting.totalAttempts),
      agentMutationAttempts: Math.max(
        recordedAgentMutationAttempts,
        historyAccounting.agentMutationAttempts,
      ),
      firstDetectedAt: records
        .map((record) => record.firstDetectedAt || record.event.createdAt)
        .sort()[0],
      windowCount: Math.max(
        new Set(sourceEvents.map((event) => event.runId)).size,
        ...records.map((record) => Number(record.windowCount || 1)),
      ),
      lastArtifactSha: latest.lastArtifactSha || null,
      noProgressCount: Number(latest.noProgressCount || 0),
      sourceEventIds,
      sourceEvents,
      sourceFingerprints,
      sourceHistories,
      sourceRecordHashes,
      parentGenerationId: latest.event.eventId,
      status: 'migration_hold',
      revision: 1,
      observations: records.reduce((sum, record) => sum + Number(record.observations || 1), 0),
      strategy: 'migration_hold',
      strategyAttempts,
      nextEligibleAt: null,
      lease: null,
      parentFingerprints: sourceFingerprints,
      terminalNotificationKey: null,
      hold,
      verificationCredit: credit,
      compaction: {
        canonical: true,
        ...(adoptingTerminal ? { adoptedBlockingTerminal: true } : {}),
      },
      history,
      updatedAt: createdAt,
    };
    const writes = [
      transactionWrite(`${canonicalEventId}.json`, canonical, {
        expectedRevision: 0,
        expectedExists: false,
        faultPointAfter: 'after-canonical-before-source-supersede',
      }),
      ...sourceEntries.map(({ path, record, recordHash }) => transactionWrite(
        basename(path),
        supersededRecord(record, {
          supersededBy: canonicalEventId,
          at: createdAt,
          incidentId,
          generation: Number(record.generation || 1),
        }),
        {
          expectedRevision: Number(record.revision || 0),
          expectedExists: true,
          expectedRecordHash: recordHash,
        },
      )),
    ];
    const prepared = await prepareTransaction(queueDir, {
      incidentId,
      operation: 'compact_incident',
      writes,
      createdAt,
      expectedHead: transactionHead(authoritativeHead(queueRecords, incidentId)),
      resultHead: transactionHead(canonical),
    }, { randomUUID, assertOwner });
    await applyPreparedTransactionOrAbort(queueDir, prepared, {
      randomUUID,
      faultInjector,
      assertOwner,
    });
    return canonical;
  }, { faultInjector });
}

export async function releaseMigrationHold({
  queueDir,
  site,
  pageId,
  codeSha,
  reason,
  now = new Date(),
  randomUUID = defaultRandomUUID,
} = {}) {
  if (!queueDir) throw new TypeError('queueDir is required');
  const ownerSite = requireString(site, 'site');
  if (!ALLOWED_SITES.has(ownerSite)) throw new TypeError('site must be astrologywiki or gengrowth');
  const ownerPageId = requireString(pageId, 'pageId');
  if (ownerPageId === 'RUN') throw new TypeError('release-hold requires a page-level incident');
  const normalizedSha = requireString(codeSha, 'codeSha').toLowerCase();
  if (!CODE_SHA_PATTERN.test(normalizedSha)) {
    throw new TypeError('codeSha must be a 40-hex commit SHA');
  }
  const releaseReason = requireString(reason, 'reason');
  const releasedAt = iso(now, 'release time');
  const incidentId = incidentIdForOwner(ownerSite, ownerPageId);

  return withIncidentLock(queueDir, incidentId, async ({ assertOwner }) => {
    await recoverIncidentTransactionsLocked(queueDir, incidentId, { randomUUID, assertOwner });
    const queueRecords = await readQueueRecords(queueDir);
    const canonicalEntries = queueRecords
      .filter(({ record }) => recordIncidentId(record) === incidentId
        && record.event.site === ownerSite
        && record.event.pageId === ownerPageId
        && record.compaction?.canonical === true)
      .sort((left, right) => Number(right.record.generation || 1) - Number(left.record.generation || 1)
        || String(right.record.updatedAt || '').localeCompare(String(left.record.updatedAt || '')));
    const canonical = canonicalEntries[0];
    if (!canonical) {
      throw new Error(`canonical migration hold not found for owner ${ownerSite}/${ownerPageId}`);
    }
    const existingRelease = canonical.record.verificationCreditRelease;
    if (existingRelease) {
      if (existingRelease.codeSha === normalizedSha && existingRelease.reason === releaseReason) {
        return canonical.record;
      }
      throw new Error(`migration verification credit already released for ${ownerSite}/${ownerPageId}`);
    }
    if (canonical.record.status !== 'migration_hold') {
      throw new Error(`canonical record is not a migration_hold for ${ownerSite}/${ownerPageId}`);
    }
    if (canonical.record.verificationCredit !== 1) {
      throw new Error('migration_hold requires verificationCredit exactly 1');
    }
    const budgetEpoch = Number(canonical.record.budgetEpoch || 1) + 1;
    const verificationCreditRelease = {
      codeSha: normalizedSha,
      reason: releaseReason,
      releasedAt,
      budgetEpoch,
    };
    const released = {
      ...canonical.record,
      status: 'queued',
      revision: Number(canonical.record.revision || 0) + 1,
      budgetEpoch,
      strategy: 'deterministic_retry',
      nextEligibleAt: null,
      lease: null,
      hold: false,
      verificationCreditRemaining: 1,
      verificationCreditRelease,
      verificationCreditConsumedAt: null,
      verificationCreditConsumedBy: null,
      updatedAt: releasedAt,
      history: [
        ...(canonical.record.history || []),
        {
          status: 'queued',
          at: releasedAt,
          evidence: {
            type: 'migration_verification_credit_released',
            ...verificationCreditRelease,
          },
        },
      ],
    };
    await assertOwner();
    await atomicWriteJson(canonical.path, released, randomUUID);
    return released;
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
  await recoverPreparedTransactions(queueDir);
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const divisor = Math.max(1, Number(agingMs) || DEFAULT_AGING_MS);
  const queueRecords = await readQueueRecords(queueDir);
  const heldIncidents = await listHeldIncidentIds(queueDir);
  const heads = new Map();
  for (const entry of queueRecords) {
    const incidentId = recordIncidentId(entry.record);
    if (!heads.has(incidentId)) {
      heads.set(incidentId, authoritativeHead(queueRecords, incidentId));
    }
  }
  const eligible = queueRecords
    .map(({ record }) => record)
    .filter((record) => {
      if (heldIncidents.has(recordIncidentId(record))) return false;
      const head = heads.get(recordIncidentId(record));
      if (head?.event?.eventId !== record.event?.eventId) return false;
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
  faultInjector,
} = {}) {
  if (!queueDir) throw new TypeError('queueDir is required');
  await injectFault(faultInjector, 'before-incident-lock', {
    incidentId: recordIncidentId(record),
  });
  const incidentId = recordIncidentId(record);
  return withIncidentLock(queueDir, incidentId, async ({ assertOwner }) => {
    await recoverIncidentTransactionsLocked(queueDir, incidentId, { randomUUID, assertOwner });
    const path = recordPath(queueDir, record);
    let current;
    try { current = await readRepairRecord(path); } catch { return null; }
    const queueRecords = await readQueueRecords(queueDir);
    const head = authoritativeHead(queueRecords, incidentId);
    if (head?.event?.eventId !== current.event?.eventId
      || !sameRecordSnapshot(record, current)) {
      return null;
    }
    const nowDate = now instanceof Date ? now : new Date(now);
    const currentExpiry = Date.parse(current.lease?.expiresAt || 0);
    if (['repairing', 'regating'].includes(current.status) && currentExpiry > nowDate.getTime()) return null;
    if (!['queued', 'repair_pending', 'repairing', 'regating'].includes(current.status)) return null;

    const verificationCreditConsumed = hasAvailableVerificationCredit(current);
    const leased = {
      ...current,
      status: 'repairing',
      revision: Number(current.revision || 0) + 1,
      ...(verificationCreditConsumed ? {
        verificationCreditRemaining: 0,
        verificationCreditConsumedAt: nowDate.toISOString(),
        verificationCreditConsumedBy: requireString(owner, 'lease owner'),
      } : {}),
      lease: {
        owner: requireString(owner, 'lease owner'),
        fencingToken: defaultRandomUUID(),
        startedAt: nowDate.toISOString(),
        expiresAt: new Date(nowDate.getTime() + Math.max(1, Number(leaseMs))).toISOString(),
        ...(verificationCreditConsumed ? { verificationCreditConsumed: true } : {}),
      },
      updatedAt: nowDate.toISOString(),
      history: [
        ...(current.history || []),
        {
          status: 'repairing',
          at: nowDate.toISOString(),
          evidence: {
            owner,
            ...(verificationCreditConsumed ? {
              type: 'migration_verification_credit_consumed',
              verificationCreditConsumed: true,
              budgetEpoch: Number(current.budgetEpoch || 1),
            } : {}),
          },
        },
      ],
    };
    await assertOwner();
    await atomicWriteJson(path, leased, randomUUID);
    return leased;
  }, { faultInjector });
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
  const incidentId = recordIncidentId(record);
  return withIncidentLock(queueDir, incidentId, async ({ assertOwner }) => {
    await recoverIncidentTransactionsLocked(queueDir, incidentId, { randomUUID, assertOwner });
    const path = recordPath(queueDir, record);
    let current;
    try {
      current = await readRepairRecord(path);
    } catch {
      throw new Error(`stale repair transition: missing record ${record.event?.eventId || ''}`);
    }
    const queueRecords = await readQueueRecords(queueDir);
    const head = authoritativeHead(queueRecords, incidentId);
    if (head?.event?.eventId !== current.event?.eventId
      || !sameTransitionAuthority(record, current)
      || !ACTIVE_STATUSES.has(current.status)) {
      throw new Error(`stale repair transition: ${record.event?.eventId || ''} is not authoritative`);
    }
    const nowIso = iso(now, 'transition time');
    const next = {
      ...current,
      ...transition,
      status,
      revision: Number(current.revision || 0) + 1,
      lease: ['repairing', 'regating'].includes(status) ? (transition.lease || current.lease) : null,
      updatedAt: nowIso,
      history: [
        ...(current.history || []),
        { status, at: nowIso, evidence: transition.evidence || null },
      ],
    };
    await assertOwner();
    await atomicWriteJson(path, next, randomUUID);
    return next;
  });
}

export async function recoverExpiredLeases({
  queueDir,
  now = new Date(),
  randomUUID = defaultRandomUUID,
} = {}) {
  if (!queueDir) throw new TypeError('queueDir is required');
  const nowDate = now instanceof Date ? now : new Date(now);
  await recoverPreparedTransactions(queueDir, { randomUUID });
  const heldIncidentIds = await listHeldIncidentIds(queueDir);
  let count = 0;
  const candidates = await readQueueRecords(queueDir);
  for (const { path, record } of candidates) {
    if (!['repairing', 'regating'].includes(record.status)) continue;
    if (Date.parse(record.lease?.expiresAt || 0) > nowDate.getTime()) continue;
    const incidentId = recordIncidentId(record);
    if (heldIncidentIds.has(incidentId)) continue;
    count += await withIncidentLock(queueDir, incidentId, async ({ assertOwner }) => {
      if ((await listHeldIncidentIds(queueDir)).has(incidentId)) return 0;
      await recoverIncidentTransactionsLocked(queueDir, incidentId, { randomUUID, assertOwner });
      if ((await listHeldIncidentIds(queueDir)).has(incidentId)) return 0;
      let current;
      try { current = await readRepairRecord(path); } catch { return 0; }
      const queueRecords = await readQueueRecords(queueDir);
      const head = authoritativeHead(queueRecords, incidentId);
      if (head?.event?.eventId !== current.event?.eventId
        || !['repairing', 'regating'].includes(current.status)
        || Date.parse(current.lease?.expiresAt || 0) > nowDate.getTime()) {
        return 0;
      }
      const recovered = {
        ...current,
        status: 'queued',
        revision: Number(current.revision || 0) + 1,
        lease: null,
        updatedAt: nowDate.toISOString(),
        history: [
          ...(current.history || []),
          { status: 'queued', at: nowDate.toISOString(), evidence: { recoveredExpiredLease: true } },
        ],
      };
      await assertOwner();
      await atomicWriteJson(path, recovered, randomUUID);
      return 1;
    });
  }
  return count;
}
