import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  beginRepairAttempts,
  normalizeRepairError,
  parseUncheckedPlanIds,
  repairFingerprint,
  selectRepairTargets,
} from '../lib/seo-repair-hook.mjs';

test('parseUncheckedPlanIds returns only unchecked page IDs in plan order', () => {
  const ids = parseUncheckedPlanIds([
    '- [ ] `PG-A-001` alpha',
    '- [x] `PG-B-001` beta',
    '- [ ] PG-C-001 gamma',
  ].join('\n'));
  assert.deepEqual([...ids], ['PG-A-001', 'PG-C-001']);
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
