import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildRepairAgentPrompt,
  classifyRepairEvent,
  drainRepairQueue,
  invokeTargetRepairAgent,
  isNondelegableEvidence,
  nextRepairStrategy,
  terminalNotificationKey,
} from '../lib/seo-repair-controller.mjs';
import {
  enqueueRepairEvent,
  listEligibleRepairEvents,
  readRepairRecord,
  transitionRepairEvent,
} from '../lib/seo-repair-events.mjs';

const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function event(overrides = {}) {
  return {
    schemaVersion: 2,
    eventId: UUID_A,
    runId: 'run-20260715',
    site: 'gengrowth',
    lane: 'publish',
    pageId: 'PG-WLS-007',
    slug: 'chatgpt-seo',
    stage: 'fact_gate',
    errorKind: 'tool_exit',
    summary: 'codex exited 3',
    stderr: 'process exited without a verdict',
    logFile: '/tmp/controller.log',
    logOffsetStart: 0,
    logOffsetEnd: 100,
    canonicalRetry: ['node', 'tools/scripts/gg-codex-pr-review.mjs', '--source', '/tmp/article.md'],
    createdAt: '2026-07-15T14:00:00.000Z',
    ...overrides,
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'seo-repair-controller-'));
  const queueDir = join(root, 'queue');
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { queueDir };
}

async function budgetFixture(t, recordOverrides = {}, adapterResult = {
  ok: false,
  evidence: { type: 'still_broken', artifactSha: 'sha-same' },
}) {
  const { queueDir } = await fixture(t);
  const queued = await enqueueRepairEvent(event(), { queueDir });
  const seeded = await transitionRepairEvent(queued, {
    status: 'queued',
    ...recordOverrides,
    evidence: { type: 'seed_budget' },
  }, {
    queueDir,
    now: new Date('2026-07-15T14:01:00.000Z'),
  });
  let calls = 0;
  return {
    queueDir,
    recordPath: join(queueDir, `${seeded.event.eventId}.json`),
    adapterCalls: () => calls,
    args: {
      queueDir,
      adapters: {
        gengrowth: {
          execute: async () => {
            calls += 1;
            return adapterResult;
          },
        },
      },
      owner: 'budget-controller-test',
      now: () => new Date('2026-07-15T14:02:00.000Z'),
      maxTargets: 1,
    },
  };
}

test('classifies exit 3 as transient and factual asset or link failures as agent_fixable', () => {
  assert.equal(classifyRepairEvent(event()), 'transient');
  assert.equal(classifyRepairEvent(event({
    site: 'astrologywiki',
    errorKind: 'asset_fail',
    summary: 'SVG says Saturn Square occurs around age 14',
  })), 'agent_fixable');
  assert.equal(classifyRepairEvent(event({
    site: 'astrologywiki',
    errorKind: 'link_fail',
    summary: 'intended links render as italic text',
  })), 'agent_fixable');
  assert.equal(classifyRepairEvent(event({
    errorKind: 'state_fail',
    summary: 'pending writeback sidecar is recoverable',
  })), 'deterministic_fixable');
  assert.equal(classifyRepairEvent(event({
    errorKind: 'stale',
    summary: 'duplicate topic with published canonical',
  })), 'unpublishable');
});

test('attempt exhaustion escalates or backs off but never manufactures human_only', () => {
  const first = nextRepairStrategy({
    classification: 'transient',
    strategy: 'deterministic_retry',
    strategyAttempts: { deterministic_retry: 2 },
  }, { ok: false, evidence: 'same tool exit' });
  assert.deepEqual(first, {
    status: 'queued',
    strategy: 'agent_diagnosis',
    nextEligibleAt: null,
  });

  const exhausted = nextRepairStrategy({
    classification: 'agent_fixable',
    strategy: 'agent_code_environment',
    strategyAttempts: { agent_content_asset_link: 2, agent_code_environment: 2 },
  }, { ok: false, evidence: 'same gate failure' }, {
    now: new Date('2026-07-15T14:00:00.000Z'),
    backoffMs: 60_000,
  });
  assert.equal(exhausted.status, 'repair_pending');
  assert.equal(exhausted.strategy, 'agent_code_environment');
  assert.equal(exhausted.nextEligibleAt, '2026-07-15T14:01:00.000Z');
  assert.notEqual(exhausted.status, 'human_only');
});

test('human_only requires an attempted nondelegable external action', () => {
  assert.equal(isNondelegableEvidence({
    type: 'oauth_login',
    safeAuthorizationAttempted: true,
    stillBlocked: true,
  }), true);
  assert.equal(isNondelegableEvidence({
    type: 'missing_authoritative_source',
    safeAuthorizationAttempted: true,
    stillBlocked: true,
  }), true);
  assert.equal(isNondelegableEvidence({ type: 'tool_exit', attempts: 9 }), false);
  assert.equal(isNondelegableEvidence({
    type: 'oauth_login',
    safeAuthorizationAttempted: false,
    stillBlocked: true,
  }), false);
});

test('terminal notification key is stable and includes the terminal owner tuple', () => {
  const record = {
    event: event(),
    fingerprint: 'abc123',
  };
  assert.equal(terminalNotificationKey(record, 'published'), 'published:gengrowth:PG-WLS-007:abc123');
});

test('repair records initialize and count the natural-window progress fields', async (t) => {
  const { queueDir } = await fixture(t);
  const first = await enqueueRepairEvent(event(), { queueDir });
  assert.equal(first.totalAttempts, 0);
  assert.equal(first.agentMutationAttempts, 0);
  assert.equal(first.firstDetectedAt, '2026-07-15T14:00:00.000Z');
  assert.equal(first.windowCount, 1);
  assert.equal(first.lastArtifactSha, null);
  assert.equal(first.noProgressCount, 0);

  const sameWindow = await enqueueRepairEvent(event({
    eventId: UUID_B,
    logOffsetStart: 100,
    logOffsetEnd: 150,
    createdAt: '2026-07-15T14:05:00.000Z',
  }), { queueDir });
  assert.equal(sameWindow.windowCount, 1);

  const observed = await enqueueRepairEvent(event({
    eventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    runId: 'run-20260715-window-2',
    logOffsetStart: 150,
    logOffsetEnd: 200,
    createdAt: '2026-07-15T14:30:00.000Z',
  }), { queueDir });
  assert.equal(observed.firstDetectedAt, first.firstDetectedAt);
  assert.equal(observed.windowCount, 2);
  assert.equal(observed.totalAttempts, 0);
});

test('third total attempt quarantines and a rerun cannot call the adapter again', async (t) => {
  const built = await budgetFixture(t, { totalAttempts: 2 });
  const out = await drainRepairQueue({
    ...built.args,
    maxTotalAttempts: 3,
  });
  assert.equal(built.adapterCalls(), 1);
  assert.equal(out.terminals[0].terminal, 'quarantined');
  const terminal = await readRepairRecord(built.recordPath);
  assert.equal(terminal.status, 'quarantined');
  assert.equal(terminal.totalAttempts, 3);
  assert.equal(
    terminal.terminalNotificationKey,
    `quarantined:${terminal.incidentId}:${terminal.budgetEpoch}`,
  );

  const rerun = await drainRepairQueue({
    ...built.args,
    maxTotalAttempts: 3,
  });
  assert.equal(rerun.processed, 0);
  assert.equal(built.adapterCalls(), 1);
});

test('pre-exhausted or no-progress incidents quarantine before adapter execution', async (t) => {
  await t.test('total budget already exhausted', async (tt) => {
    const built = await budgetFixture(tt, { totalAttempts: 3 });
    const out = await drainRepairQueue({ ...built.args, maxTotalAttempts: 3 });
    assert.equal(built.adapterCalls(), 0);
    assert.equal(out.terminals[0].terminal, 'quarantined');
    assert.equal((await readRepairRecord(built.recordPath)).history.at(-1).evidence.type, 'repair_budget_exhausted');
  });
  await t.test('same artifact made no progress twice', async (tt) => {
    const built = await budgetFixture(tt, {
      totalAttempts: 1,
      lastArtifactSha: 'sha-same',
      noProgressCount: 2,
    });
    const out = await drainRepairQueue({ ...built.args, maxTotalAttempts: 3 });
    assert.equal(built.adapterCalls(), 0);
    assert.equal(out.terminals[0].terminal, 'quarantined');
    assert.equal((await readRepairRecord(built.recordPath)).history.at(-1).evidence.type, 'no_progress');
  });
  await t.test('Agent mutation budget already exhausted', async (tt) => {
    const built = await budgetFixture(tt, {
      classification: 'agent_fixable',
      strategy: 'agent_content_asset_link',
      agentMutationAttempts: 2,
    });
    const out = await drainRepairQueue({
      ...built.args,
      maxAgentMutationAttempts: 2,
    });
    assert.equal(built.adapterCalls(), 0);
    assert.equal(out.terminals[0].terminal, 'quarantined');
    assert.equal((await readRepairRecord(built.recordPath)).history.at(-1).evidence.type, 'repair_budget_exhausted');
  });
});

test('Agent mutation budget increments only when the adapter actually invokes an Agent', async (t) => {
  await t.test('skipped invocation does not consume mutation budget', async (tt) => {
    const built = await budgetFixture(tt, {
      classification: 'agent_fixable',
      strategy: 'agent_content_asset_link',
    }, {
      ok: false,
      agentMutationInvoked: false,
      evidence: { type: 'target_not_ready' },
    });
    await drainRepairQueue({ ...built.args, maxTargets: 1 });
    assert.equal((await readRepairRecord(built.recordPath)).agentMutationAttempts, 0);
  });
  await t.test('real invocation consumes one mutation attempt', async (tt) => {
    const built = await budgetFixture(tt, {
      classification: 'agent_fixable',
      strategy: 'agent_content_asset_link',
    }, {
      ok: false,
      agentMutationInvoked: true,
      evidence: { type: 'agent_exit' },
    });
    await drainRepairQueue({ ...built.args, maxTargets: 1 });
    assert.equal((await readRepairRecord(built.recordPath)).agentMutationAttempts, 1);
  });
});

test('artifact evidence counts consecutive no-progress attempts and quarantines the second repeat', async (t) => {
  const built = await budgetFixture(t, {}, {
    ok: false,
    evidence: { type: 'regate_failed', artifactSha: 'sha-repeat' },
  });
  const first = await drainRepairQueue({
    ...built.args,
    maxTargets: 1,
    maxStrategyAttempts: 3,
  });
  assert.equal(first.terminals.length, 0);
  const afterFirst = await readRepairRecord(built.recordPath);
  assert.equal(afterFirst.lastArtifactSha, 'sha-repeat');
  assert.equal(afterFirst.noProgressCount, 1);

  const second = await drainRepairQueue({
    ...built.args,
    maxTargets: 1,
    maxStrategyAttempts: 3,
  });
  assert.equal(built.adapterCalls(), 2);
  assert.equal(second.terminals[0].terminal, 'quarantined');
  const terminal = await readRepairRecord(built.recordPath);
  assert.equal(terminal.lastArtifactSha, 'sha-repeat');
  assert.equal(terminal.noProgressCount, 2);
  assert.equal(terminal.history.at(-1).evidence.type, 'no_progress');
});

test('a changed artifact SHA resets the consecutive no-progress count to one', async (t) => {
  let calls = 0;
  const { queueDir } = await fixture(t);
  const queued = await enqueueRepairEvent(event(), { queueDir });
  const path = join(queueDir, `${queued.event.eventId}.json`);
  const args = {
    queueDir,
    adapters: {
      gengrowth: {
        execute: async () => ({
          ok: false,
          evidence: {
            type: 'regate_failed',
            artifactSha: calls++ === 0 ? 'sha-before' : 'sha-after',
          },
        }),
      },
    },
    owner: 'artifact-change-test',
    now: () => new Date('2026-07-15T14:02:00.000Z'),
    maxTargets: 1,
    maxStrategyAttempts: 3,
  };
  await drainRepairQueue(args);
  await drainRepairQueue(args);
  const current = await readRepairRecord(path);
  assert.equal(current.status, 'queued');
  assert.equal(current.lastArtifactSha, 'sha-after');
  assert.equal(current.noProgressCount, 1);
});

test('incidents over the natural-window or 90-minute limit quarantine before execution', async (t) => {
  await t.test('four distinct run windows exceed maxWindowCount=3', async (tt) => {
    const { queueDir } = await fixture(tt);
    const runIds = ['run-window-1', 'run-window-2', 'run-window-3', 'run-window-4'];
    let head;
    for (let index = 0; index < runIds.length; index += 1) {
      head = await enqueueRepairEvent(event({
        eventId: `${String(index + 1).repeat(8)}-${String(index + 1).repeat(4)}-4${String(index + 1).repeat(3)}-8${String(index + 1).repeat(3)}-${String(index + 1).repeat(12)}`,
        runId: runIds[index],
        logOffsetStart: index * 100,
        logOffsetEnd: (index + 1) * 100,
        createdAt: `2026-07-15T14:${String(index).padStart(2, '0')}:00.000Z`,
      }), { queueDir });
    }
    assert.equal(head.windowCount, 4);
    let calls = 0;
    const out = await drainRepairQueue({
      queueDir,
      adapters: { gengrowth: { execute: async () => { calls += 1; return { ok: false }; } } },
      now: () => new Date('2026-07-15T14:10:00.000Z'),
      maxTargets: 1,
      maxWindowCount: 3,
    });
    assert.equal(calls, 0);
    assert.equal(out.terminals[0].terminal, 'quarantined');
    assert.equal((await readRepairRecord(join(queueDir, `${head.event.eventId}.json`))).history.at(-1).evidence.type, 'repair_window_exhausted');
  });

  await t.test('incident age over 90 minutes exceeds maxIncidentAgeMs', async (tt) => {
    const built = await budgetFixture(tt);
    const out = await drainRepairQueue({
      ...built.args,
      now: () => new Date('2026-07-15T15:30:00.001Z'),
      maxIncidentAgeMs: 90 * 60 * 1000,
    });
    assert.equal(built.adapterCalls(), 0);
    assert.equal(out.terminals[0].terminal, 'quarantined');
    assert.equal((await readRepairRecord(built.recordPath)).history.at(-1).evidence.type, 'repair_window_exhausted');
  });
});

test('maxTargets limits execution only and leaves later work queued', async (t) => {
  const { queueDir } = await fixture(t);
  await enqueueRepairEvent(event(), { queueDir });
  await enqueueRepairEvent(event({
    eventId: UUID_B,
    pageId: 'PG-WLS-008',
    slug: 'seo-agents',
    createdAt: '2026-07-15T14:01:00.000Z',
  }), { queueDir });

  const handled = [];
  const notified = [];
  const summary = await drainRepairQueue({
    queueDir,
    adapters: {
      gengrowth: {
        execute: async ({ record }) => {
          handled.push(record.event.pageId);
          return { terminal: 'published', evidence: { checks: { live: true, backfilled: true } } };
        },
      },
    },
    notifyTerminal: async (payload) => notified.push(payload),
    owner: 'controller-test',
    now: () => new Date('2026-07-15T14:02:00.000Z'),
    maxTargets: 1,
    budgetMs: 60_000,
  });

  assert.deepEqual(handled, ['PG-WLS-007']);
  assert.equal(summary.processed, 1);
  assert.equal(summary.remaining, 1);
  assert.equal(notified.length, 1);
  const remaining = await listEligibleRepairEvents({
    queueDir,
    now: new Date('2026-07-15T14:02:00.000Z'),
  });
  assert.deepEqual(remaining.map((record) => record.event.pageId), ['PG-WLS-008']);
  assert.equal(remaining[0].status, 'queued');
});

test('controller notifies a terminal once and a second drain does not repeat it', async (t) => {
  const { queueDir } = await fixture(t);
  const queued = await enqueueRepairEvent(event(), { queueDir });
  const notified = [];
  const options = {
    queueDir,
    adapters: {
      gengrowth: {
        execute: async () => ({
          terminal: 'published',
          evidence: { checks: { production_200: true, backfilled: true } },
        }),
      },
    },
    notifyTerminal: async (payload) => notified.push(payload),
    owner: 'controller-test',
    now: () => new Date('2026-07-15T14:02:00.000Z'),
  };
  await drainRepairQueue(options);
  await drainRepairQueue(options);
  assert.equal(notified.length, 1);
  assert.equal(notified[0].idempotencyKey, `published:gengrowth:PG-WLS-007:${queued.fingerprint}`);
  assert.match(notified[0].messageUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const terminal = await readRepairRecord(join(queueDir, `${UUID_A}.json`));
  assert.equal(terminal.status, 'published');
  assert.equal(terminal.terminalNotificationKey, notified[0].idempotencyKey);
});

test('failed repair enters a new strategy without a human notification', async (t) => {
  const { queueDir } = await fixture(t);
  await enqueueRepairEvent(event({
    site: 'astrologywiki',
    errorKind: 'asset_fail',
    pageId: 'PG-TRANS-016',
    slug: 'saturn-return-age-29',
    summary: 'SVG says age 14',
  }), { queueDir });
  const notified = [];
  await drainRepairQueue({
    queueDir,
    adapters: {
      astrologywiki: {
        execute: async () => ({ ok: false, evidence: { gate: 'same factual failure' } }),
      },
    },
    notifyTerminal: async (payload) => notified.push(payload),
    owner: 'controller-test',
    now: () => new Date('2026-07-15T14:02:00.000Z'),
    maxTargets: 1,
    maxStrategyAttempts: 1,
  });
  assert.deepEqual(notified, []);
  const [pending] = await listEligibleRepairEvents({
    queueDir,
    now: new Date('2026-07-15T14:02:00.000Z'),
  });
  assert.equal(pending.strategy, 'agent_code_environment');
  assert.equal(pending.status, 'queued');
});

test('controller rejects adapter human_only without nondelegable evidence', async (t) => {
  const { queueDir } = await fixture(t);
  await enqueueRepairEvent(event(), { queueDir });
  const notified = [];
  await drainRepairQueue({
    queueDir,
    adapters: {
      gengrowth: {
        execute: async () => ({
          terminal: 'human_only',
          evidence: { type: 'tool_exit', attempts: 9 },
        }),
      },
    },
    notifyTerminal: async (payload) => notified.push(payload),
    owner: 'controller-test',
    now: () => new Date('2026-07-15T14:02:00.000Z'),
    maxTargets: 1,
  });
  assert.deepEqual(notified, []);
  const [record] = await listEligibleRepairEvents({
    queueDir,
    now: new Date('2026-07-15T14:02:00.000Z'),
  });
  assert.notEqual(record.status, 'human_only');
});

test('target Agent prompt contains exact evidence and safety boundaries without secrets or batch wrappers', () => {
  const prompt = buildRepairAgentPrompt({
    template: 'Repair exactly one target. Return JSON.',
    record: {
      fingerprint: 'abc123',
      event: event({
        site: 'astrologywiki',
        pageId: 'PG-TRANS-016',
        slug: 'saturn-return-age-29',
        errorKind: 'asset_fail',
        summary: 'SVG says age 14',
        stderr: 'codex factual FAIL',
        canonicalRetry: ['node', 'tools/scripts/gg-preview-gate.mjs', '--branch', 'seo/auto/PG-TRANS-016'],
      }),
      history: [{
        status: 'queued',
        at: '2026-07-15T15:28:57.453Z',
        evidence: {
          type: 'regate_failed',
          result: {
            stdout: 'infographic says Saturn return happens only near ages 29 and 58 despite a third near 88',
            stderr: 'token=secret-value',
          },
        },
      }],
    },
    strategy: 'agent_content_asset_link',
    target: {
      site: 'astrologywiki',
      pageId: 'PG-TRANS-016',
      articleFile: '/worktree/data/articles/saturn-return-age-29.ts',
      assetFiles: ['/worktree/public/images/blog/saturn-return-age-29-i0-en.svg'],
      verifiedLinkCandidates: [{ slug: 'saturn-return-guide' }],
      allowedActions: [['node', 'tools/scripts/gg-preview-gate.mjs', '--branch', 'seo/auto/PG-TRANS-016']],
      terminalVerifier: ['node', 'tools/scripts/gg-seo-repair-verify.mjs', '--site', 'astrologywiki', '--page-id', 'PG-TRANS-016'],
    },
  });
  assert.match(prompt, /PG-TRANS-016/);
  assert.match(prompt, /saturn-return-age-29-i0-en\.svg/);
  assert.match(prompt, /saturn-return-guide/);
  assert.match(prompt, /authoritativeLogWindow/);
  assert.match(prompt, /recentRepairEvidence/);
  assert.match(prompt, /third near 88/);
  assert.match(prompt, /isolated.*worktree/i);
  assert.doesNotMatch(prompt, /gg-nightly-seo\.sh/);
  assert.doesNotMatch(prompt, /lynne-soul|api[_-]?key|secret-value/i);
});

test('target Agent timeout becomes repair evidence and never a terminal self-report', async () => {
  const result = await invokeTargetRepairAgent({
    record: { fingerprint: 'abc123', event: event() },
    strategy: 'agent_diagnosis',
    target: { site: 'gengrowth', pageId: 'PG-WLS-007', allowedActions: [] },
  }, {
    template: 'Repair exactly one target.',
    runAgent: async () => ({ code: 124, stdout: '', stderr: 'timed out', timedOut: true }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.evidence.type, 'agent_timeout');
  assert.equal(result.terminal, undefined);
});

test('target Agent exit zero only authorizes deterministic regating, not publish success', async () => {
  const result = await invokeTargetRepairAgent({
    record: { fingerprint: 'abc123', event: event() },
    strategy: 'agent_content_asset_link',
    target: { site: 'gengrowth', pageId: 'PG-WLS-007', allowedActions: [] },
  }, {
    template: 'Repair exactly one target.',
    runAgent: async ({ prompt }) => ({
      code: 0,
      stdout: JSON.stringify({ claimedTerminal: 'published', changedFiles: ['draft.md'] }),
      stderr: '',
      prompt,
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.terminal, undefined);
  assert.match(result.evidence.stdout, /claimedTerminal/);
});
