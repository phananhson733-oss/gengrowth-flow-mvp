// Integration test for gate-side surgical repair: gg-gate-repair.mjs (worker) + tryGateRepair
// (gg-preview-gate.mjs park-boundary hook). Uses a real temp git repo + bare remote + a fake
// claude bin so the worker + apply/commit/push path is exercised end-to-end without the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryGateRepair } from '../../tools/scripts/gg-preview-gate.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'scripts');
const REPAIR_BIN = join(SCRIPTS, 'gg-gate-repair.mjs');
const log = () => {};
const B = { gateRepair: REPAIR_BIN };

const mkNode = (fakeClaudeBin) => (binPath, args) => {
  const r = spawnSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, GG_GATE_REPAIR_BIN: fakeClaudeBin },
  });
  return Promise.resolve({ timedOut: r.error?.code === 'ETIMEDOUT', code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' });
};

function setupRepo(body) {
  const root = mkdtempSync(join(tmpdir(), 'gaterepair-'));
  const remote = join(root, 'remote.git');
  const wt = join(root, 'wt');
  execSync(`git init --bare "${remote}"`, { stdio: 'ignore' });
  execSync(`git init "${wt}"`, { stdio: 'ignore' });
  execSync(`git -C "${wt}" config user.email t@t.co && git -C "${wt}" config user.name t`, { stdio: 'ignore' });
  mkdirSync(join(wt, 'data', 'articles'), { recursive: true });
  const ts = join(wt, 'data', 'articles', 'x.ts');
  writeFileSync(ts, body);
  execSync(`git -C "${wt}" add -A && git -C "${wt}" commit -q -m init`, { stdio: 'ignore' });
  execSync(`git -C "${wt}" branch -M testbranch`, { stdio: 'ignore' });
  execSync(`git -C "${wt}" remote add origin "${remote}" && git -C "${wt}" push -q -u origin testbranch`, { stdio: 'ignore' });
  return { remote, wt, ts };
}
function fakeClaude(editsJson) {
  const p = join(mkdtempSync(join(tmpdir(), 'fakecl-')), 'claude.sh');
  writeFileSync(p, `#!/bin/zsh\ncat >/dev/null\ncat <<'JSON'\n${editsJson}\nJSON\n`);
  chmodSync(p, 0o755);
  return p;
}

test('happy path: valid edit is applied, committed, and pushed', async () => {
  const { wt, ts, remote } = setupRepo('export const x = `body UNIQUE_BROKEN here`;\n');
  const fc = fakeClaude('{"edits":[{"old_string":"UNIQUE_BROKEN","new_string":"FIXED_ANCHOR"}],"note":"fixed anchor"}');
  process.env.GG_GATE_REPAIR = '1';
  const r = await tryGateRepair({ dim: 'links-seo', reason: 'anchor mismatch', articleTs: ts, worktree: wt, branch: 'testbranch', node: mkNode(fc), B, log });
  assert.equal(r, true);
  const after = readFileSync(ts, 'utf8');
  assert.ok(after.includes('FIXED_ANCHOR') && !after.includes('UNIQUE_BROKEN'));
  const head = execSync(`git -C "${remote}" log -1 --format=%s testbranch`, { encoding: 'utf8' }).trim();
  assert.match(head, /gate-repair.*links-seo/);
});

test('opt-out: GG_GATE_REPAIR unset → no-op, returns false', async () => {
  const { wt, ts } = setupRepo('export const x = `body UNIQUE_BROKEN here`;\n');
  const fc = fakeClaude('{"edits":[{"old_string":"UNIQUE_BROKEN","new_string":"FIXED"}],"note":"x"}');
  delete process.env.GG_GATE_REPAIR;
  const r = await tryGateRepair({ dim: 'links-seo', reason: 'x', articleTs: ts, worktree: wt, branch: 'testbranch', node: mkNode(fc), B, log });
  assert.equal(r, false);
  assert.ok(readFileSync(ts, 'utf8').includes('UNIQUE_BROKEN'));
});

test('cannot-repair (empty edits) → false, nothing pushed', async () => {
  const { wt, ts, remote } = setupRepo('export const x = `body UNIQUE_BROKEN here`;\n');
  const fc = fakeClaude('{"edits":[],"note":"cannot-repair: needs rewrite"}');
  process.env.GG_GATE_REPAIR = '1';
  const before = execSync(`git -C "${remote}" rev-parse testbranch`, { encoding: 'utf8' }).trim();
  const r = await tryGateRepair({ dim: 'codex', reason: 'x', articleTs: ts, worktree: wt, branch: 'testbranch', node: mkNode(fc), B, log });
  assert.equal(r, false);
  assert.equal(execSync(`git -C "${remote}" rev-parse testbranch`, { encoding: 'utf8' }).trim(), before);
});

test('non-unique old_string is dropped by the worker → false, no change', async () => {
  const { wt, ts } = setupRepo('export const x = `DUP and DUP again`;\n');
  const fc = fakeClaude('{"edits":[{"old_string":"DUP","new_string":"Z"}],"note":"x"}');
  process.env.GG_GATE_REPAIR = '1';
  const r = await tryGateRepair({ dim: 'schema', reason: 'x', articleTs: ts, worktree: wt, branch: 'testbranch', node: mkNode(fc), B, log });
  assert.equal(r, false);
  assert.ok(readFileSync(ts, 'utf8').includes('DUP and DUP'));
});
