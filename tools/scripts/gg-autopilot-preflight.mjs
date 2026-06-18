#!/usr/bin/env node
// gg-autopilot-preflight.mjs — Mac-mini runtime preflight for the SEO autopilot.
//
// Runs once per launchd/cron fire BEFORE the publish/author loop begins. Confirms
// the host has everything the autopilot needs so a fire fails loudly & immediately
// (with an actionable error list) instead of mid-cycle in some half-published state.
//
// Checks (ALL collected — never bails on the first failure):
//   1. required dirs exist  — GG_FLOW_REPO / GG_OPS_DIR / GG_ORACLE_DIR
//   2. required commands in PATH — node / git / gh / claude / codex
//   3. WARN (not error) if VERCEL_AUTOMATION_BYPASS_SECRET is unset
//   4. unless --skip-live-cli: a 60s `claude -p 'Return exactly: OK'` smoke; error
//      unless the model returns OK.
//
// CRITICAL — default paths (2026-06-18 fix): the v0.1 reference impl in
//   docs/plans/2026-06-13-oauth-cli-worker-autopilot-plan.md defaulted GG_OPS_DIR /
//   GG_ORACLE_DIR to ~/Code/gengrowth-ops + ~/Code/oracle, which DO NOT EXIST on
//   awayer_mini (the real publish node) — every unattended fire would exit(2).
//   The real layout (matching gg-seo-autopilot.mjs defaults verbatim) is:
//     GG_FLOW_REPO  → ~/gengrowth-flow-mvp
//     GG_OPS_DIR    → ~/gengrowth-ops      (NO 'Code' segment)
//     GG_ORACLE_DIR → ~/oracle             (NO 'Code' segment)
//
// CLI: --json (machine-readable {ok,dirs,errors,warnings}), --skip-live-cli (skip
//      the slow/flaky live claude smoke — recommended in cron).
// Output: {ok, dirs, errors, warnings}. Exit 0 if ok, else 2.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const HOME = homedir();
const args = new Set(process.argv.slice(2));
const json = args.has('--json');
const skipLiveCli = args.has('--skip-live-cli');

// Defaults MUST mirror gg-seo-autopilot.mjs (~/gengrowth-flow-mvp, ~/oracle,
// ~/gengrowth-ops). No 'Code' segment — that path does not exist on this machine.
const requiredDirs = {
  GG_FLOW_REPO: process.env.GG_FLOW_REPO || join(HOME, 'gengrowth-flow-mvp'),
  GG_OPS_DIR: process.env.GG_OPS_DIR || join(HOME, 'gengrowth-ops'),
  GG_ORACLE_DIR: process.env.GG_ORACLE_DIR || join(HOME, 'oracle'),
};

function commandExists(name) {
  for (const dir of String(process.env.PATH || '').split(':')) {
    if (dir && existsSync(join(dir, name))) return true;
  }
  return false;
}

const errors = [];
const warnings = [];

// 1. required directories
for (const [key, value] of Object.entries(requiredDirs)) {
  if (!existsSync(value)) errors.push(`${key} missing: ${value}`);
}

// 2. required commands in PATH
for (const cmd of ['node', 'git', 'gh', 'claude', 'codex']) {
  if (!commandExists(cmd)) errors.push(`command not in PATH: ${cmd}`);
}

// 3. preview-bypass secret — WARN only (often sourced from _gg.env later in tick).
if (!process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
  warnings.push(
    'VERCEL_AUTOMATION_BYPASS_SECRET is not exported; preview verification may fail unless _gg.env is sourced later',
  );
}

// 4. live claude CLI smoke — slow/flaky unattended, so cron should pass --skip-live-cli.
if (!skipLiveCli && commandExists('claude')) {
  const r = spawnSync('claude', ['-p', 'Return exactly: OK'], {
    encoding: 'utf8',
    timeout: 60000,
    env: process.env,
  });
  if (r.status !== 0 || !String(r.stdout || '').includes('OK')) {
    errors.push(
      `claude CLI smoke failed: ${String(r.stderr || r.stdout || r.error?.message || '').slice(-200)}`,
    );
  }
}

const result = {
  ok: errors.length === 0,
  dirs: requiredDirs,
  errors,
  warnings,
};

if (json) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else {
  process.stdout.write(result.ok ? 'preflight: ok\n' : 'preflight: failed\n');
  for (const e of errors) process.stdout.write(`ERROR ${e}\n`);
  for (const w of warnings) process.stdout.write(`WARN ${w}\n`);
}

process.exit(result.ok ? 0 : 2);
