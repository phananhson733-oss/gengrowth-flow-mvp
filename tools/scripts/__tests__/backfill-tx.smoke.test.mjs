// backfill-tx.smoke.test.mjs — 阶段 4 回填事务的确定性单测（全部依赖注入，无网络/无 SA）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  enqueueWriteback, readWriteback, resolveWriteback,
  backfillOnLive, drainPending,
} from '../lib/backfill-tx.mjs';

// 每测独立 state dir（stateDir() 每次调用读 env，故运行时切换即隔离）。
function freshState() {
  const d = mkdtempSync(join(tmpdir(), 'bftx-'));
  process.env.GG_FLOW_STATE_DIR = d;
  return d;
}
// 全成功的注入依赖；覆盖 archive 可注入失败。
function okDeps(over = {}) {
  return {
    token: 'tok',
    verifyLive: async () => true,
    flipRowsByPageId: async () => {},
    checkPlanBoxFile: () => {},
    archive: () => {},
    ...over,
  };
}

test('WAL: enqueue 合并 done 并集、保留字段、resolve 删除', () => {
  freshState();
  assert.equal(readWriteback('PG-X-1'), null);
  enqueueWriteback({ pageId: 'PG-X-1', slug: 's', site: 'astrologywiki', done: ['sheet'] });
  let e = readWriteback('PG-X-1');
  assert.deepEqual(e.done, ['sheet']);
  assert.equal(e.slug, 's');
  enqueueWriteback({ pageId: 'PG-X-1', done: ['plan'] }); // 并集合并，不丢 slug
  e = readWriteback('PG-X-1');
  assert.deepEqual([...e.done].sort(), ['plan', 'sheet']);
  assert.equal(e.slug, 's');
  assert.equal(e.site, 'astrologywiki');
  resolveWriteback('PG-X-1');
  assert.equal(readWriteback('PG-X-1'), null);
});

test('happy path：三步全成 → ok，WAL 清空', async () => {
  freshState();
  const calls = { flip: 0, plan: 0, archive: 0 };
  const r = await backfillOnLive(
    { pageId: 'PG-Y-1', slug: 'yy', site: 'astrologywiki', planPath: null },
    okDeps({
      flipRowsByPageId: async () => { calls.flip++; },
      checkPlanBoxFile: () => { calls.plan++; },
      archive: () => { calls.archive++; },
    }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual([...r.done].sort(), ['archive', 'plan', 'sheet']);
  assert.deepEqual(calls, { flip: 1, plan: 1, archive: 1 });
  assert.equal(readWriteback('PG-Y-1'), null); // 全成清队
});

test('verify-live 未过 → deferred，留队 attempts=1，绝不写 Sheet', async () => {
  freshState();
  let flipped = 0;
  const now = new Date('2026-07-16T10:00:00.000Z');
  const r = await backfillOnLive(
    { pageId: 'PG-Z-1', slug: 'z', site: 'gengrowth' },
    okDeps({
      now,
      backoffBaseMs: 15 * 60 * 1000,
      verifyLive: async () => false,
      flipRowsByPageId: async () => { flipped++; },
    }),
  );
  assert.equal(r.deferred, true);
  assert.equal(flipped, 0); // 没上线不碰 Sheet
  const e = readWriteback('PG-Z-1');
  assert.ok(e);
  assert.equal(e.attempts, 1);
  assert.match(e.lastError, /verify-live/);
  assert.equal(e.nextEligibleAt, '2026-07-16T10:15:00.000Z');
});

test('单步失败隔离 + 断点续跑：archive 失败留 [sheet,plan]，重试只补 archive', async () => {
  freshState();
  const calls = { flip: 0, plan: 0, archive: 0 };
  const mk = (failArchive) => okDeps({
    flipRowsByPageId: async () => { calls.flip++; },
    checkPlanBoxFile: () => { calls.plan++; },
    archive: () => { calls.archive++; if (failArchive) throw new Error('boom'); },
  });
  let r = await backfillOnLive({ pageId: 'PG-W-1', slug: 'w', site: 'astrologywiki' }, mk(true));
  assert.equal(r.ok, false);
  assert.deepEqual([...r.done].sort(), ['plan', 'sheet']);
  assert.deepEqual(r.failed.map((f) => f.step), ['archive']);
  let e = readWriteback('PG-W-1');
  assert.deepEqual([...e.done].sort(), ['plan', 'sheet']);
  assert.equal(e.attempts, 1);
  // 续跑：archive 现在成功 → 仅 archive 再跑（flip/plan 不重复）→ ok，清队
  r = await backfillOnLive({ pageId: 'PG-W-1', slug: 'w', site: 'astrologywiki' }, mk(false));
  assert.equal(r.ok, true);
  assert.deepEqual([...r.done].sort(), ['archive', 'plan', 'sheet']);
  assert.equal(calls.flip, 1);   // sheet 只跑一次
  assert.equal(calls.plan, 1);   // plan 只跑一次
  assert.equal(calls.archive, 2); // archive 失败一次 + 成功一次
  assert.equal(readWriteback('PG-W-1'), null);
});

test('no-token → deferred，留队 no-token，不 verify/不写', async () => {
  freshState();
  let verified = 0;
  const r = await backfillOnLive(
    { pageId: 'PG-N-1', slug: 'n', site: 'gengrowth' },
    okDeps({ token: null, verifyLive: async () => { verified++; return true; } }),
  );
  assert.equal(r.deferred, true);
  assert.equal(verified, 0); // token 缺失时不该走到 verify
  const e = readWriteback('PG-N-1');
  assert.match(e.lastError, /no-token/);
});

test('非法入参（缺 slug）→ ok:false，不入队', async () => {
  freshState();
  const r = await backfillOnLive({ pageId: 'PG-I-1', site: 'astrologywiki' }, okDeps());
  assert.equal(r.ok, false);
  assert.match(r.reason, /invalid/);
  assert.equal(readWriteback('PG-I-1'), null);
});

test('真实 plan 勾选（非 stub）：- [ ] → - [x] 幂等', async () => {
  freshState();
  const planFile = join(mkdtempSync(join(tmpdir(), 'plan-')), 'plan.md');
  writeFileSync(planFile, '# plan\n\n- [ ] `PG-P-1` some keyword\n- [ ] `PG-OTHER` x\n');
  const r = await backfillOnLive(
    { pageId: 'PG-P-1', slug: 'p', site: 'astrologywiki', planPath: planFile },
    okDeps({ checkPlanBoxFile: undefined }), // 用真实 checkPlanBoxFile
  );
  assert.equal(r.ok, true);
  const out = readFileSync(planFile, 'utf8');
  assert.match(out, /- \[x\] `PG-P-1`/);   // 目标已勾
  assert.match(out, /- \[ \] `PG-OTHER`/); // 其它不动
});

test('drainPending：live 的 resolved、未 live 的 stillPending', async () => {
  freshState();
  enqueueWriteback({ pageId: 'PG-D-1', slug: 'd1', site: 'astrologywiki', done: [] });
  enqueueWriteback({ pageId: 'PG-D-2', slug: 'd2', site: 'astrologywiki', done: [] });
  const live = new Set(['d1']);
  const out = await drainPending(okDeps({ verifyLive: async (s, slug) => live.has(slug) }));
  assert.equal(out.resolved, 1);
  assert.equal(out.stillPending, 1);
  assert.equal(readWriteback('PG-D-1'), null);
  assert.ok(readWriteback('PG-D-2'));
});

test('5 分钟 reconciler 仅在 nextEligibleAt 到期时重试，40 分钟内不会耗尽 8 次', async () => {
  freshState();
  const start = Date.parse('2026-07-16T10:00:00.000Z');
  enqueueWriteback({
    pageId: 'PG-CELEB-055',
    slug: 'celeb-055',
    site: 'astrologywiki',
    firstAt: new Date(start).toISOString(),
    done: [],
  });
  let verifyCalls = 0;
  const deps = okDeps({
    backoffBaseMs: 15 * 60 * 1000,
    backoffMaxMs: 24 * 60 * 60 * 1000,
    verifyLive: async () => {
      verifyCalls += 1;
      return false;
    },
  });
  const observations = [];
  for (let minute = 0; minute <= 40; minute += 5) {
    const out = await drainPending({
      ...deps,
      now: new Date(start + minute * 60 * 1000),
    });
    observations.push({
      minute,
      retried: out.retried,
      skipped: out.skipped,
      attempts: readWriteback('PG-CELEB-055')?.attempts,
    });
  }
  assert.equal(verifyCalls, 2);
  assert.equal(readWriteback('PG-CELEB-055').attempts, 2);
  assert.equal(readWriteback('PG-CELEB-055').nextEligibleAt, '2026-07-16T10:45:00.000Z');
  assert.deepEqual(
    observations.filter((row) => row.retried === 1).map((row) => row.minute),
    [0, 15],
  );
  assert.equal(observations.filter((row) => row.skipped === 1).length, 7);
});

test('nextEligibleAt 跨进程持久化：未到期只 skip，不增 attempts', async () => {
  freshState();
  enqueueWriteback({
    pageId: 'PG-TRANS-014',
    slug: 'trans-014',
    site: 'astrologywiki',
    attempts: 3,
    nextEligibleAt: '2026-07-16T12:00:00.000Z',
    done: [],
  });
  let verifyCalls = 0;
  const early = await drainPending(okDeps({
    now: new Date('2026-07-16T11:59:59.000Z'),
    verifyLive: async () => {
      verifyCalls += 1;
      return false;
    },
  }));
  assert.equal(early.retried, 0);
  assert.equal(early.skipped, 1);
  assert.equal(verifyCalls, 0);
  assert.equal(readWriteback('PG-TRANS-014').attempts, 3);

  const due = await drainPending(okDeps({
    now: new Date('2026-07-16T12:00:00.000Z'),
    backoffBaseMs: 15 * 60 * 1000,
    verifyLive: async () => {
      verifyCalls += 1;
      return false;
    },
  }));
  assert.equal(due.retried, 1);
  assert.equal(due.skipped, 0);
  assert.equal(verifyCalls, 1);
  assert.equal(readWriteback('PG-TRANS-014').attempts, 4);
});

test('drop rename 失败时保留原 pending WAL，并返回结构化错误', async () => {
  const state = freshState();
  enqueueWriteback({
    pageId: 'PG-NODE-013',
    slug: 'node-013',
    site: 'astrologywiki',
    attempts: 8,
    firstAt: '2026-07-16T10:00:00.000Z',
    done: ['sheet', 'plan'],
    lastError: 'archive:disk unavailable',
  });
  const out = await drainPending(okDeps({
    now: new Date('2026-07-16T11:00:00.000Z'),
    renameWriteback: () => {
      throw new Error('simulated rename failure');
    },
  }));
  assert.equal(out.dropped.length, 0);
  assert.equal(out.dropErrors.length, 1);
  assert.equal(out.dropErrors[0].pageId, 'PG-NODE-013');
  assert.match(out.dropErrors[0].error, /rename failure/);
  assert.equal(out.stillPending, 1);
  assert.ok(readWriteback('PG-NODE-013'));
  assert.equal(
    existsSync(join(state, 'pending-writeback', 'dropped', 'PG-NODE-013.json')),
    false,
  );
});

test('drainPending：超 MAX_ATTEMPTS 的毒记录原子移入 dropped/，终态证据完整且不重复', async () => {
  const state = freshState();
  enqueueWriteback({
    pageId: 'PG-WDIF-001',
    slug: 'what-does-it-feel',
    site: 'astrologywiki',
    attempts: 8,
    firstAt: '2026-07-09T10:00:00.000Z',
    done: ['sheet', 'plan'],
    lastError: 'archive:vault unavailable',
  });
  const out = await drainPending(okDeps({
    now: new Date('2026-07-16T10:00:00.000Z'),
  }));
  assert.equal(out.dropped.length, 1);
  assert.deepEqual(out.dropped[0], {
    pageId: 'PG-WDIF-001',
    stuckSteps: ['archive'],
    attempts: 8,
    firstAt: '2026-07-09T10:00:00.000Z',
    lastError: 'archive:vault unavailable',
    terminalAt: '2026-07-16T10:00:00.000Z',
    reason: 'max-attempts-and-ttl',
    notificationKey: 'writeback-terminal:PG-WDIF-001:2026-07-09T10:00:00.000Z:8',
  });
  assert.equal(readWriteback('PG-WDIF-001'), null); // 队列顶层已移除
  // 但记录被保留在 dropped/（可审计/人工补救），不是静默删除
  const droppedPath = join(state, 'pending-writeback', 'dropped', 'PG-WDIF-001.json');
  assert.ok(existsSync(droppedPath));
  const archived = JSON.parse(readFileSync(droppedPath, 'utf8'));
  assert.deepEqual(archived.terminalNotification, out.dropped[0]);
  // 再 drain 一次：dropped/ 里的记录不被重扫
  const out2 = await drainPending(okDeps());
  assert.equal(out2.retried, 0);
  assert.equal(out2.dropped.length, 0);
});

test('成功回填后 WAL 幂等清零，重复 drain 不重复执行任何步骤', async () => {
  freshState();
  enqueueWriteback({
    pageId: 'PG-TRANS-017',
    slug: 'trans-017',
    site: 'astrologywiki',
    done: [],
  });
  const calls = { verify: 0, flip: 0, plan: 0, archive: 0 };
  const deps = okDeps({
    verifyLive: async () => {
      calls.verify += 1;
      return true;
    },
    flipRowsByPageId: async () => { calls.flip += 1; },
    checkPlanBoxFile: () => { calls.plan += 1; },
    archive: () => { calls.archive += 1; },
  });
  const first = await drainPending(deps);
  const second = await drainPending(deps);
  assert.equal(first.resolved, 1);
  assert.deepEqual(second, {
    retried: 0,
    skipped: 0,
    resolved: 0,
    stillPending: 0,
    dropped: [],
    dropErrors: [],
  });
  assert.deepEqual(calls, { verify: 1, flip: 1, plan: 1, archive: 1 });
  assert.equal(readWriteback('PG-TRANS-017'), null);
});
