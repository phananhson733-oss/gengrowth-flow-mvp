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
