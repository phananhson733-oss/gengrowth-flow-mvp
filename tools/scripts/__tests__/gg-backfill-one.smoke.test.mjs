import assert from 'node:assert/strict';
import test from 'node:test';
import { runBackfillOne } from '../gg-backfill-one.mjs';

test('missing target is a clean no-op and never drains another page', async () => {
  let calls = 0;
  const result = await runBackfillOne('PG-MISSING-001', {
    readWriteback: () => null,
    backfillOnLive: async () => { calls++; return { ok: true }; },
  });
  assert.deepEqual(result, { ok: true, pageId: 'PG-MISSING-001', terminal: 'clean', reason: 'no pending writeback' });
  assert.equal(calls, 0);
});

test('runs backfill for the exact requested sidecar only', async () => {
  const pending = {
    pageId: 'PG-A-001',
    slug: 'alpha',
    site: 'astrologywiki',
    url: 'https://www.astrologywiki.com/en/wiki/alpha',
    planPath: '/ops/plan.md',
    done: ['sheet'],
  };
  const calls = [];
  const result = await runBackfillOne('PG-A-001', {
    readWriteback: (pageId) => pageId === 'PG-A-001' ? pending : { pageId: 'PG-OTHER-001' },
    backfillOnLive: async (entry) => {
      calls.push(entry);
      return { ok: true, done: ['sheet', 'plan', 'archive'], failed: [] };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.terminal, 'resolved');
  assert.deepEqual(calls, [pending]);
});

test('failed target remains pending with exact result evidence', async () => {
  const pending = { pageId: 'PG-A-001', slug: 'alpha', site: 'astrologywiki' };
  const result = await runBackfillOne('PG-A-001', {
    readWriteback: () => pending,
    backfillOnLive: async () => ({ ok: false, deferred: true, reason: 'sheet auth unavailable' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.terminal, 'pending');
  assert.match(result.reason, /sheet auth/);
});
