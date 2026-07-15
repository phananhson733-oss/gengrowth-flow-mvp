import { createHash } from 'node:crypto';
import { triagePark } from './park-classify.mjs';

export function parseUncheckedPlanIds(text) {
  return new Set(
    [...String(text || '').matchAll(/^\s*-\s*\[ \]\s*`?(PG-[A-Z0-9]+-\d+)`?/gm)]
      .map((match) => match[1]),
  );
}

export function normalizeRepairError(value) {
  return String(value || '')
    .replace(/\b\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z?)?\b/g, '<time>')
    .replace(/\bpid\s+\d+\b/gi, 'pid <n>')
    .replace(/\/tmp\/[^\s]+/g, '/tmp/<path>')
    .replace(/(?:https:\/\/)?[a-z0-9.-]+\.vercel\.app/gi, '<preview>.vercel.app')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function repairFingerprint({ pageId = 'RUN', stage = 'run', error = '' } = {}) {
  return createHash('sha256')
    .update(`${pageId}\n${stage}\n${normalizeRepairError(error)}`)
    .digest('hex');
}

function terminalUpdate(target, terminal, reason = '') {
  return {
    ...target,
    terminal,
    terminalReason: reason || target.error || terminal,
  };
}

export function selectRepairTargets({
  claims = {},
  planIds = new Set(),
  state = {},
  archivedIds = new Set(),
  pendingWritebackIds = new Set(),
  runError = '',
  maxTargets = 2,
  maxAttempts = 2,
  nowMs = Date.now(),
  inflightTtlMs = 60 * 60 * 1000,
} = {}) {
  const targets = [];
  const terminalUpdates = [];

  for (const pageId of planIds || []) {
    const claim = claims?.[pageId];
    if (!claim || archivedIds?.has(pageId)) continue;

    let stage;
    let error;
    let triage;
    if (claim.status === 'needs_human') {
      stage = claim.stage || 'unknown';
      error = String(claim.error || 'needs_human without an error');
      triage = triagePark(claim);
    } else if (claim.status === 'pushed-preview' || claim.status === 'verified-preview') {
      stage = claim.status;
      error = claim.status === 'pushed-preview'
        ? 'nightly ended with pushed-preview pending preview gate'
        : 'nightly ended with verified-preview pending merge/live/backfill';
      triage = 'fixable';
    } else if (claim.status === 'done' && pendingWritebackIds?.has(pageId)) {
      stage = 'backfill';
      error = 'pending writeback remains after nightly completion';
      triage = 'fixable';
    } else {
      continue;
    }
    const fingerprint = repairFingerprint({ pageId, stage, error });
    const target = {
      pageId,
      stage,
      slug: claim.slug || '',
      branch: claim.branch || '',
      error,
      triage,
      fingerprint,
    };

    if (triage === 'unfixable') {
      terminalUpdates.push(terminalUpdate(target, 'archived'));
      continue;
    }

    const attempt = state?.[fingerprint] || {};
    if (attempt.status === 'inflight') {
      const startedAt = Date.parse(attempt.startedAt || '');
      const staleInflight = Number.isFinite(startedAt) && nowMs - startedAt >= inflightTtlMs;
      if (!staleInflight) continue;
    }
    if (['published', 'archived', 'human_only'].includes(attempt.status)) continue;
    if (Number(attempt.attempts || 0) >= maxAttempts) {
      terminalUpdates.push(terminalUpdate(target, 'human_only', 'repair attempt cap reached'));
      continue;
    }
    targets.push(target);
  }

  if (runError && targets.length === 0 && maxTargets > 0) {
    const pageId = 'RUN';
    const stage = 'run';
    const error = String(runError);
    const fingerprint = repairFingerprint({ pageId, stage, error });
    const attempt = state?.[fingerprint] || {};
    if (attempt.status !== 'inflight' && !['published', 'archived', 'human_only'].includes(attempt.status)) {
      if (Number(attempt.attempts || 0) >= maxAttempts) {
        terminalUpdates.push(terminalUpdate({ pageId, stage, error, triage: 'transient', fingerprint }, 'human_only', 'repair attempt cap reached'));
      } else {
        targets.push({ pageId, stage, slug: '', branch: '', error, triage: 'transient', fingerprint });
      }
    }
  }

  return { targets: targets.slice(0, Math.max(0, maxTargets)), terminalUpdates };
}

export function beginRepairAttempts(state = {}, targets = [], nowIso = new Date().toISOString()) {
  const next = { ...(state || {}) };
  for (const target of targets || []) {
    const previous = next[target.fingerprint] || {};
    next[target.fingerprint] = {
      pageId: target.pageId,
      stage: target.stage,
      error: target.error,
      attempts: Number(previous.attempts || 0) + 1,
      status: 'inflight',
      startedAt: nowIso,
    };
  }
  return next;
}
