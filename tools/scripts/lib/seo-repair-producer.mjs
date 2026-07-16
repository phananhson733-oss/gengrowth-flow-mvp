import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  enqueueRepairEvent,
  validateRepairEvent,
} from './seo-repair-events.mjs';

function claimLane(claim) {
  const stage = String(claim?.stage || claim?.status || '').toLowerCase();
  if (/backfill|writeback|published|done/.test(stage)) return 'backfill';
  if (/verified|merge|live/.test(stage)) return 'merge';
  if (/preview|review|gate|push/.test(stage)) return 'preview';
  return 'author';
}

function claimErrorKind(claim) {
  const text = `${claim?.stage || ''} ${claim?.error || ''}`.toLowerCase();
  if (/stale|duplicate|do not publish|错误前提|过时/.test(text)) return 'stale';
  if (/svg|image|asset|图片|图像/.test(text)) return 'asset_fail';
  if (/links-seo|internal links?|italic text|站内链接/.test(text)) return 'link_fail';
  if (/timeout|timed out|超时/.test(text)) return 'timeout';
  if (/backfill|writeback|回填/.test(text)) return 'backfill_fail';
  if (/publish|merge|deploy/.test(text)) return 'publish_fail';
  if (/\b(?:auth(?:entication|orization)?|credentials?|permissions?|unauthorized|forbidden)\b/.test(text)) return 'auth';
  if (/source|sheet|workbook|row missing/.test(text)) return 'source';
  if (/exited?\s+\d+|tool exit/.test(text)) return 'tool_exit';
  if (/review|gate|fail|fact|phase2|事实/.test(text)) return 'gate_fail';
  return 'state_fail';
}

function claimRetry(pageId, claim) {
  if (claim?.branch) {
    return [
      'node',
      'tools/scripts/gg-seo-autopilot.mjs',
      '--retry-failed',
      '--branch',
      String(claim.branch),
    ];
  }
  return [
    'node',
    'tools/scripts/gg-seo-autopilot.mjs',
    '--retry-author',
    '--task',
    pageId,
  ];
}

function boundedLogWindow(logFile, start, end) {
  if (!logFile || end <= start) return '';
  try {
    const bytes = readFileSync(logFile);
    return bytes.subarray(
      Math.min(bytes.length, start),
      Math.min(bytes.length, end),
    ).toString('utf8').slice(-8_192);
  } catch {
    return '';
  }
}

export function eventFromClaim({
  site,
  runId,
  pageId,
  claim,
  logFile,
  offsets,
  createdAt = new Date().toISOString(),
}) {
  const start = Number(offsets?.start ?? offsets?.logOffsetStart ?? 0);
  const end = Number(offsets?.end ?? offsets?.logOffsetEnd ?? start);
  const stage = String(claim?.stage || claim?.status || 'unknown');
  const summary = String(claim?.error || `${claim?.status || 'unknown'} at ${stage}`);
  return validateRepairEvent({
    schemaVersion: 2,
    eventId: randomUUID(),
    runId,
    site,
    lane: claimLane(claim),
    pageId,
    slug: String(claim?.slug || ''),
    stage,
    errorKind: claimErrorKind(claim),
    summary,
    stderr: boundedLogWindow(logFile, start, end),
    logFile,
    logOffsetStart: start,
    logOffsetEnd: end,
    canonicalRetry: claimRetry(pageId, claim),
    createdAt,
  });
}

export async function persistRepairAndDrain({
  event,
  queueDir,
  enqueue = enqueueRepairEvent,
  drain = async () => ({ ok: true, skipped: true }),
  strict = true,
}) {
  let record;
  try {
    record = await enqueue(event, { queueDir });
  } catch (error) {
    if (strict) throw error;
    return {
      ok: false,
      durable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const drained = await drain({ event, record, queueDir });
    return {
      ok: drained?.ok !== false,
      durable: true,
      record,
      ...(drained && typeof drained === 'object' ? drained : {}),
    };
  } catch (error) {
    if (strict) throw error;
    return {
      ok: false,
      durable: true,
      record,
      drainError: error instanceof Error ? error.message : String(error),
    };
  }
}
