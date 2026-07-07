// flow-driver-apply.smoke.test.mjs — P1.5 接侧效：buildActionCommands 映射 + driveApply 编排(mock deps)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildActionCommands } from '../lib/flow-driver-apply.mjs';

const CFG = { repo: 'xdawayer/oracle', site: 'astrologywiki' };

test('buildActionCommands: archive → sidecar-only(不再 per-park 派通知,终态进每轮一条汇总)', () => {
  const r = buildActionCommands({ pid: 'PG-X', action: 'archive', slug: 'foo', stage: 'pushed-preview', branch: 'seo/auto/x', reason: '死选题' }, CFG);
  assert.equal(r.kind, 'archive');
  assert.equal(r.commands.length, 0); // 不派 gg-notify——archive 只记 sidecar
});

test('buildActionCommands: fix(gate 阶段有 branch) → retry-failed + preview-gate 两条', () => {
  const r = buildActionCommands({ pid: 'PG-Y', action: 'fix', slug: 'bar', stage: 'pushed-preview', branch: 'seo/auto/y' }, CFG);
  assert.equal(r.kind, 'fix');
  assert.equal(r.commands.length, 2);
  assert.match(r.commands[0].args.join(' '), /--retry-failed --branch seo\/auto\/y/);
  assert.match(r.commands[1].args.join(' '), /--branch seo\/auto\/y --repo xdawayer\/oracle/);
  assert.match(r.commands[1].bin, /gg-preview-gate\.mjs$/);
});

test('buildActionCommands: fix 但 authoring 阶段(无 branch) → fix-skip,不派门', () => {
  const r = buildActionCommands({ pid: 'PG-Z', action: 'fix', slug: 'baz', stage: 'authoring', branch: '' }, CFG);
  assert.equal(r.kind, 'fix-skip');
  assert.equal(r.commands.length, 0);
  assert.match(r.skipReason, /authoring|no branch|无门/i);
});

test('buildActionCommands: retry → retry-skip,不派命令(现有 auto-retry lane owns)', () => {
  const r = buildActionCommands({ pid: 'PG-T', action: 'retry', slug: 't', stage: 'pushed-preview', branch: 'seo/auto/t' }, CFG);
  assert.equal(r.kind, 'retry-skip');
  assert.equal(r.commands.length, 0);
});

import { driveApply } from '../lib/flow-driver-apply.mjs';

function mkDeps(overrides = {}) {
  const ran = [];
  const archived = overrides.archived instanceof Set ? overrides.archived : new Set();
  return {
    ran,
    archived,
    run: async (cmd) => { ran.push(cmd); return { ok: overrides.fail ? false : true, code: overrides.fail ? 1 : 0 }; },
    log: () => {},
    cfg: CFG,
    maxFix: overrides.maxFix ?? 1,
    maxArchive: overrides.maxArchive ?? 5,
    isArchived: (pid) => archived.has(pid),
    markArchived: (pid) => archived.add(pid),
  };
}

test('driveApply: archive 只记 sidecar(不 spawn)、retry 跳过、fix 派两条、汇总带 slugs', async () => {
  const deps = mkDeps();
  const plan = [
    { pid: 'PG-A', action: 'archive', slug: 'aa', stage: 'pushed-preview', branch: 'b/a' },
    { pid: 'PG-T', action: 'retry', slug: 't', stage: 'pushed-preview', branch: 'b/t' },
    { pid: 'PG-F', action: 'fix', slug: 'ff', stage: 'pushed-preview', branch: 'b/f' },
  ];
  const s = await driveApply(plan, deps);
  assert.equal(s.archived, 1);
  assert.equal(s.retryDeferred, 1);
  assert.equal(s.fixed, 1);
  assert.deepEqual(s.archivedSlugs, ['aa']);
  assert.deepEqual(s.fixedSlugs, ['ff']);
  assert.equal(deps.ran.length, 2); // 只 fix 的 2 条,archive 不 spawn
  assert.ok(deps.archived.has('PG-A')); // archive 仍记 sidecar
});

test('driveApply: maxFix=1 时第二个 fix 被 cap、不执行', async () => {
  const deps = mkDeps({ maxFix: 1 });
  const plan = [
    { pid: 'PG-F1', action: 'fix', slug: 'f1', stage: 'pushed-preview', branch: 'b/f1' },
    { pid: 'PG-F2', action: 'fix', slug: 'f2', stage: 'pushed-preview', branch: 'b/f2' },
  ];
  const s = await driveApply(plan, deps);
  assert.equal(s.fixed, 1);
  assert.equal(s.capped, 1);
  assert.equal(deps.ran.length, 2); // 只第一个 fix 的 2 条命令
});

test('driveApply: fix 命令失败 → fixFailed 计数、不误报 fixed', async () => {
  const deps = mkDeps({ fail: true });
  const plan = [{ pid: 'PG-F', action: 'fix', slug: 'f', stage: 'pushed-preview', branch: 'b/f' }];
  const s = await driveApply(plan, deps);
  assert.equal(s.fixed, 0);
  assert.equal(s.fixFailed, 1);
});

test('driveApply: archive 幂等——已归档过的 pid 第二轮跳过、不重复 notify(治评审 finding②)', async () => {
  const archived = new Set();
  const plan = [{ pid: 'PG-D', action: 'archive', slug: 'd', stage: 'pushed-preview', branch: 'b/d' }];
  const s1 = await driveApply(plan, mkDeps({ archived }));
  assert.equal(s1.archived, 1);
  assert.ok(archived.has('PG-D')); // markArchived 记住
  const deps2 = mkDeps({ archived });
  const s2 = await driveApply(plan, deps2);
  assert.equal(s2.archived, 0);
  assert.equal(s2.archiveSkipped, 1);
  assert.equal(deps2.ran.length, 0); // 第二轮没再 spawn notify
});

import { buildSummaryMessage } from '../lib/flow-driver-apply.mjs';

test('buildSummaryMessage: 有终态 → 一行中文汇总(含 slugs);无终态 → 空串', () => {
  assert.equal(buildSummaryMessage({ fixed: 0, archived: 0, fixFailed: 0, archivedSlugs: [], fixedSlugs: [], fixFailedSlugs: [] }, 'astrologywiki'), '');
  const msg = buildSummaryMessage({ fixed: 1, archived: 1, fixFailed: 1, fixedSlugs: ['x'], archivedSlugs: ['wc-045'], fixFailedSlugs: ['z'] }, 'astrologywiki');
  assert.match(msg, /astrologywiki/);
  assert.match(msg, /自修上线 1.*x/);
  assert.match(msg, /归档 1.*wc-045/);
  assert.match(msg, /修失败.*1.*z/);
});
