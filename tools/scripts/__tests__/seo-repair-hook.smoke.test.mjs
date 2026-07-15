import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  beginRepairAttempts,
  normalizeRepairError,
  parsePlanIds,
  parseUncheckedPlanIds,
  repairFingerprint,
  selectRepairTargets,
} from '../lib/seo-repair-hook.mjs';

test('parseUncheckedPlanIds returns only unchecked page IDs in plan order', () => {
  const plan = [
    '- [ ] `PG-A-001` alpha',
    '- [x] `PG-B-001` beta',
    '- [ ] PG-C-001 gamma',
  ].join('\n');
  const ids = parseUncheckedPlanIds(plan);
  assert.deepEqual([...ids], ['PG-A-001', 'PG-C-001']);
  assert.deepEqual([...parsePlanIds(plan)], ['PG-A-001', 'PG-B-001', 'PG-C-001']);
});

test('clean plan has no target and a pre-existing eligible park is selected', () => {
  const planIds = new Set(['PG-A-001']);
  assert.deepEqual(selectRepairTargets({
    claims: {}, planIds, state: {}, archivedIds: new Set(),
  }).targets, []);

  const out = selectRepairTargets({
    claims: {
      'PG-A-001': {
        status: 'needs_human',
        stage: 'authoring',
        slug: 'alpha',
        error: 'phase2 FAIL: drifted sections',
      },
    },
    planIds,
    state: {},
    archivedIds: new Set(),
  });
  assert.equal(out.targets.length, 1);
  assert.equal(out.targets[0].pageId, 'PG-A-001');
  assert.equal(out.targets[0].triage, 'fixable');
});

test('stranded preview/merge states and pending writeback are repair targets', () => {
  const planIds = new Set(['PG-P-001', 'PG-M-001', 'PG-B-001']);
  const out = selectRepairTargets({
    claims: {
      'PG-P-001': { status: 'pushed-preview', stage: 'pushed-preview', slug: 'preview', branch: 'seo/preview' },
      'PG-M-001': { status: 'verified-preview', stage: 'verified-preview', slug: 'merge', branch: 'seo/merge' },
      'PG-B-001': { status: 'done', stage: 'published', slug: 'backfill', branch: 'seo/backfill', mergedAt: '2026-07-15T10:00:00Z' },
    },
    planIds,
    uncheckedPlanIds: new Set(['PG-P-001', 'PG-M-001']),
    state: {},
    archivedIds: new Set(),
    pendingWritebackIds: new Set(['PG-B-001']),
    maxTargets: 3,
  });
  assert.deepEqual(out.targets.map(({ pageId, stage, triage }) => ({ pageId, stage, triage })), [
    { pageId: 'PG-P-001', stage: 'pushed-preview', triage: 'fixable' },
    { pageId: 'PG-M-001', stage: 'verified-preview', triage: 'fixable' },
    { pageId: 'PG-B-001', stage: 'backfill', triage: 'fixable' },
  ]);
});

test('fingerprint removes runtime noise but changes for a real error change', () => {
  const noisyA = '2026-07-15 18:31 pid 123 /tmp/x https://preview-a.vercel.app timed out';
  const noisyB = '2026-07-15 18:32 pid 999 /tmp/y preview-b.vercel.app timed out';
  assert.equal(normalizeRepairError(noisyA), normalizeRepairError(noisyB));

  const a = repairFingerprint({ pageId: 'PG-A-001', stage: 'authoring', error: noisyA });
  const b = repairFingerprint({ pageId: 'PG-A-001', stage: 'authoring', error: noisyB });
  const c = repairFingerprint({ pageId: 'PG-A-001', stage: 'authoring', error: 'phase2 FAIL: missing H1' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('unfixable park becomes archived terminal and never becomes an Agent target', () => {
  const out = selectRepairTargets({
    claims: {
      'PG-S-001': {
        status: 'needs_human',
        stage: 'pushed-preview',
        slug: 'stale',
        error: 'stale topic — prediction expired — do not publish',
      },
    },
    planIds: new Set(['PG-S-001']),
    state: {},
    archivedIds: new Set(),
  });
  assert.deepEqual(out.targets, []);
  assert.equal(out.terminalUpdates.length, 1);
  assert.equal(out.terminalUpdates[0].terminal, 'archived');
});

test('needs_human without error is diagnosed by the bounded Agent, never silently archived', () => {
  const out = selectRepairTargets({
    claims: {
      'PG-U-001': { status: 'needs_human', stage: 'authoring', slug: 'unknown' },
    },
    planIds: new Set(['PG-U-001']),
    state: {},
    archivedIds: new Set(),
  });
  assert.deepEqual(out.terminalUpdates, []);
  assert.equal(out.targets.length, 1);
  assert.equal(out.targets[0].triage, 'fixable');
});

test('cap, archived sidecar, and inflight state suppress duplicate Agent targets', () => {
  const claim = {
    status: 'needs_human', stage: 'authoring', slug: 'alpha', error: 'phase2 FAIL: drifted sections',
  };
  const fingerprint = repairFingerprint({ pageId: 'PG-A-001', stage: claim.stage, error: claim.error });
  const base = {
    claims: { 'PG-A-001': claim },
    planIds: new Set(['PG-A-001']),
    maxAttempts: 2,
  };

  assert.deepEqual(selectRepairTargets({
    ...base, state: { [fingerprint]: { attempts: 2, status: 'pending' } }, archivedIds: new Set(),
  }).targets, []);
  assert.deepEqual(selectRepairTargets({
    ...base, state: {}, archivedIds: new Set(['PG-A-001']),
  }).targets, []);
  assert.deepEqual(selectRepairTargets({
    ...base, state: { [fingerprint]: { attempts: 1, status: 'inflight' } }, archivedIds: new Set(),
  }).targets, []);
});

test('stale inflight can use the remaining attempt while a fresh inflight stays single-flight', () => {
  const claim = {
    status: 'needs_human', stage: 'authoring', slug: 'alpha', error: 'phase2 FAIL: drifted sections',
  };
  const fingerprint = repairFingerprint({ pageId: 'PG-A-001', stage: claim.stage, error: claim.error });
  const base = {
    claims: { 'PG-A-001': claim },
    planIds: new Set(['PG-A-001']),
    archivedIds: new Set(),
    maxAttempts: 2,
    nowMs: Date.parse('2026-07-15T12:00:00Z'),
    inflightTtlMs: 60 * 60 * 1000,
  };
  const fresh = selectRepairTargets({
    ...base,
    state: { [fingerprint]: { attempts: 1, status: 'inflight', startedAt: '2026-07-15T11:30:00Z' } },
  });
  assert.deepEqual(fresh.targets, []);

  const stale = selectRepairTargets({
    ...base,
    state: { [fingerprint]: { attempts: 1, status: 'inflight', startedAt: '2026-07-15T10:00:00Z' } },
  });
  assert.deepEqual(stale.targets.map((target) => target.pageId), ['PG-A-001']);
});

test('run error creates one synthetic target and maxTargets preserves plan order', () => {
  const claims = {
    'PG-A-001': { status: 'needs_human', stage: 'authoring', error: 'phase2 FAIL: A' },
    'PG-B-001': { status: 'needs_human', stage: 'authoring', error: 'phase2 FAIL: B' },
  };
  const out = selectRepairTargets({
    claims,
    planIds: new Set(['PG-B-001', 'PG-A-001']),
    state: {},
    archivedIds: new Set(),
    runError: 'nightly exited 7 without a claim',
    maxTargets: 2,
  });
  assert.deepEqual(out.targets.map((t) => t.pageId), ['PG-B-001', 'PG-A-001']);

  const synthetic = selectRepairTargets({
    claims: {}, planIds: new Set(), state: {}, archivedIds: new Set(),
    runError: 'nightly exited 7 without a claim', maxTargets: 2,
  });
  assert.deepEqual(synthetic.targets.map((t) => t.pageId), ['RUN']);
  assert.equal(synthetic.targets[0].stage, 'run');
});

test('run error does not duplicate a concrete parked article as a synthetic RUN target', () => {
  const out = selectRepairTargets({
    claims: {
      'PG-A-001': { status: 'needs_human', stage: 'authoring', error: 'phase2 FAIL: A' },
    },
    planIds: new Set(['PG-A-001']),
    state: {},
    archivedIds: new Set(),
    runError: 'PARK(author) PG-A-001: phase2 FAIL: A',
    maxTargets: 2,
  });
  assert.deepEqual(out.targets.map((target) => target.pageId), ['PG-A-001']);
});

test('beginRepairAttempts increments and persists inflight before spawn without mutating input', () => {
  const target = {
    pageId: 'PG-A-001', stage: 'authoring', error: 'phase2 FAIL', fingerprint: 'fp-a',
  };
  const original = { 'fp-a': { attempts: 1, status: 'pending' } };
  const begun = beginRepairAttempts(original, [target], '2026-07-15T10:30:00.000Z');
  assert.equal(original['fp-a'].attempts, 1);
  assert.deepEqual(begun['fp-a'], {
    pageId: 'PG-A-001',
    stage: 'authoring',
    error: 'phase2 FAIL',
    attempts: 2,
    status: 'inflight',
    startedAt: '2026-07-15T10:30:00.000Z',
  });
});
