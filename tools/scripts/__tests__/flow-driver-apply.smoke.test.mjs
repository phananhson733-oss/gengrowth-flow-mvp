// flow-driver-apply.smoke.test.mjs — P1.5 接侧效：buildActionCommands 映射 + driveApply 编排(mock deps)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildActionCommands } from '../lib/flow-driver-apply.mjs';

const CFG = { repo: 'xdawayer/oracle', site: 'astrologywiki' };

test('buildActionCommands: archive → 一条 gg-notify parked', () => {
  const r = buildActionCommands({ pid: 'PG-X', action: 'archive', slug: 'foo', stage: 'pushed-preview', branch: 'seo/auto/x', reason: '死选题' }, CFG);
  assert.equal(r.kind, 'archive');
  assert.equal(r.commands.length, 1);
  assert.match(r.commands[0].bin, /gg-notify\.mjs$/);
  assert.deepEqual(r.commands[0].args.slice(0, 2), ['parked', '--site']);
  assert.ok(r.commands[0].args.includes('astrologywiki') && r.commands[0].args.includes('PG-X'));
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
  return {
    ran,
    run: async (cmd) => { ran.push(cmd); return { ok: overrides.fail ? false : true, code: overrides.fail ? 1 : 0 }; },
    log: () => {},
    cfg: CFG,
    maxFix: overrides.maxFix ?? 1,
    maxArchive: overrides.maxArchive ?? 5,
  };
}

test('driveApply: archive 派 notify、retry 跳过、fix 派两条门命令、汇总正确', async () => {
  const deps = mkDeps();
  const plan = [
    { pid: 'PG-A', action: 'archive', slug: 'a', stage: 'pushed-preview', branch: 'b/a' },
    { pid: 'PG-T', action: 'retry', slug: 't', stage: 'pushed-preview', branch: 'b/t' },
    { pid: 'PG-F', action: 'fix', slug: 'f', stage: 'pushed-preview', branch: 'b/f' },
  ];
  const s = await driveApply(plan, deps);
  assert.equal(s.archived, 1);
  assert.equal(s.retryDeferred, 1);
  assert.equal(s.fixed, 1);
  // fix 派了 2 条(retry-failed + preview-gate)、archive 1 条 notify = 3 条真跑
  assert.equal(deps.ran.length, 3);
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
