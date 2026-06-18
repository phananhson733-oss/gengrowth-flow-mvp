// Hermetic smoke test for lib/llm-worker.mjs — pure argv contract, no spawn/fs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerCommand } from '../lib/llm-worker.mjs';

// These mirror the orchestrator's env-default semantics. The test process runs
// without GG_* set (hermetic), so the literal defaults apply.
const DEF_CLAUDE_MODEL = process.env.GG_CLAUDE_MODEL || 'claude-sonnet-4-6';
const DEF_CLAUDE_EFFORT = process.env.GG_CLAUDE_EFFORT || 'high';
const DEF_CODEX_EFFORT = process.env.GG_CODEX_EFFORT || 'xhigh';

test('claude: exact bin + args, no permission/tool flags', () => {
  const cmd = buildWorkerCommand('claude');
  assert.equal(cmd.bin, 'claude');
  assert.deepEqual(cmd.args, ['-p', '--model', DEF_CLAUDE_MODEL, '--effort', DEF_CLAUDE_EFFORT]);
  // Guard: no autonomy/permission flags leaked in.
  assert.ok(!cmd.args.includes('--allowedTools'));
  assert.ok(!cmd.args.includes('--dangerously-skip-permissions'));
  for (const a of cmd.args) {
    assert.ok(!/allowedTools|dangerously-skip-permissions/i.test(a), `unexpected flag: ${a}`);
  }
});

test('claude: opts override model + effort (rate-limit fallback path)', () => {
  const cmd = buildWorkerCommand('claude', { claudeModel: 'claude-opus-4-8', claudeEffort: 'high' });
  assert.deepEqual(cmd.args, ['-p', '--model', 'claude-opus-4-8', '--effort', 'high']);
});

test('codex: exact bin + args, no read-only/sandbox flags', () => {
  const cmd = buildWorkerCommand('codex');
  assert.equal(cmd.bin, 'codex');
  assert.deepEqual(cmd.args, ['exec', '-c', 'model=gpt-5.5', '-c', `reasoning_effort=${DEF_CODEX_EFFORT}`, '-']);
  // Guard: no -s / read-only sandbox flags.
  assert.ok(!cmd.args.includes('-s'));
  for (const a of cmd.args) {
    assert.ok(!/read-only/i.test(a), `unexpected read-only token: ${a}`);
  }
  // Guard: no opts.codexModelConfig style extra -c injected.
  assert.equal(cmd.args.filter((a) => a === '-c').length, 2);
});

test('codex: opts.codexEffort overrides effort only', () => {
  const cmd = buildWorkerCommand('codex', { codexEffort: 'high' });
  assert.deepEqual(cmd.args, ['exec', '-c', 'model=gpt-5.5', '-c', 'reasoning_effort=high', '-']);
});

test('gemini: exact bin + args', () => {
  const cmd = buildWorkerCommand('gemini');
  assert.equal(cmd.bin, 'gemini');
  assert.deepEqual(cmd.args, ['--model', 'gemini-2.5-pro']);
});

test('unknown model throws', () => {
  assert.throws(() => buildWorkerCommand('hermes'), /unknown model: hermes/);
});
