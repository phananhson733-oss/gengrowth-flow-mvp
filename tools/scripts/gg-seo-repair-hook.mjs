#!/usr/bin/env node
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { stateDir } from './lib/flow-state.mjs';
import {
  beginRepairAttempts,
  parseUncheckedPlanIds,
  selectRepairTargets,
} from './lib/seo-repair-hook.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const SCRIPTS = dirname(SCRIPT);
const FLOW = resolve(SCRIPTS, '../..');
const OPS = process.env.GG_OPS_DIR || join(homedir(), 'gengrowth-ops');
const PROMPT_FILE = process.env.GG_SEO_REPAIR_PROMPT_FILE || join(SCRIPTS, 'prompts/gg-seo-repair-hook.txt');
const VERIFY_BIN = process.env.GG_REPAIR_VERIFY_BIN || join(SCRIPTS, 'gg-seo-repair-verify.mjs');
const NOTIFY_BIN = join(SCRIPTS, 'gg-notify.mjs');
const STATE_NAME = 'seo-repair-hook.json';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
  }
  return out;
}

function numberValue(value, fallback, minimum = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function readState(path) {
  if (!existsSync(path)) return { ok: true, state: {} };
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    return state && typeof state === 'object' && !Array.isArray(state)
      ? { ok: true, state }
      : { ok: false, error: 'state root is not an object' };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function writeState(path, state) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

function executable(path) {
  if (!path) return false;
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

function readLogWindow(path, offset) {
  try {
    const bytes = readFileSync(path);
    return bytes.subarray(Math.min(bytes.length, Math.max(0, offset))).toString('utf8');
  } catch { return ''; }
}

function deriveRunError(exitCode, logWindow) {
  const lines = String(logWindow || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const explicit = lines.filter((line) => /PARK|no passing en draft|publish scan produced no branch|gate parked|\bFAIL\b|fatal|exception/i.test(line));
  if (exitCode !== 0) return `nightly exited ${exitCode}: ${(explicit.length ? explicit : lines).slice(-8).join(' | ') || 'no diagnostic output'}`;
  return explicit.slice(-8).join(' | ');
}

function planKeywords(planText) {
  const map = new Map();
  for (const match of String(planText || '').matchAll(/^\s*-\s*\[ \]\s*`?(PG-[A-Z0-9]+-\d+)`?\s*(.*)$/gm)) {
    map.set(match[1], match[2].trim());
  }
  return map;
}

function archiveIds() {
  const path = join(OPS, 'inbox/06-tasks/tasks/.flow-driver-archived.json');
  const value = readJson(path, []);
  return new Set(Array.isArray(value) ? value : []);
}

function saveTerminalUpdates(state, updates, nowIso) {
  const next = { ...state };
  for (const update of updates) {
    const previous = next[update.fingerprint] || {};
    next[update.fingerprint] = {
      ...previous,
      pageId: update.pageId,
      stage: update.stage,
      error: update.error,
      attempts: Number(previous.attempts || 0),
      status: update.terminal,
      terminalReason: update.terminalReason,
      finishedAt: nowIso,
    };
  }
  return next;
}

function resultLine(result) {
  process.stdout.write(`SEO_REPAIR_HOOK_RESULT: ${JSON.stringify(result)}\n`);
}

function appendRunLog(text) {
  try {
    const dir = process.env.GG_SEO_REPAIR_LOG_DIR || join(homedir(), 'gengrowth-agents/cron-sync/seo_repair_hook');
    mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(join(dir, `${day}.log`), `${text}\n`);
  } catch { /* logging must not alter the control result */ }
}

function notifyTerminal(result) {
  if (process.env.GG_SEO_REPAIR_NO_NOTIFY === '1') return;
  if (!['published', 'archived', 'human_only'].includes(result.terminal)) return;
  const pages = (result.results || result.targets || []).map((item) => item.pageId).filter(Boolean).join(', ') || 'run';
  const text = `SEO repair hook: ${result.terminal} — ${pages}${result.reason ? ` — ${result.reason}` : ''}`;
  spawnSync('node', [NOTIFY_BIN, 'raw', '--text', text], { cwd: FLOW, encoding: 'utf8', timeout: 30000 });
}

function parseVerifierOutput(stdout) {
  const lines = String(stdout || '').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* inspect earlier line */ }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const claimsPath = args.claims;
  const planPath = args.plan;
  if (!claimsPath || !planPath) {
    resultLine({ triggered: false, terminal: 'human_only', reason: 'claims_and_plan_required' });
    process.exit(2);
  }

  const baseState = stateDir();
  if (!baseState) {
    resultLine({ triggered: false, terminal: 'state_unavailable', reason: 'flow-state directory unavailable' });
    process.exit(2);
  }
  const statePath = join(baseState, STATE_NAME);
  const loaded = readState(statePath);
  if (!loaded.ok) {
    resultLine({ triggered: false, terminal: 'state_unavailable', reason: loaded.error });
    process.exit(2);
  }

  let claims;
  let planText;
  try {
    claims = JSON.parse(readFileSync(claimsPath, 'utf8'));
    planText = readFileSync(planPath, 'utf8');
  } catch (error) {
    resultLine({ triggered: false, terminal: 'human_only', reason: `input_unavailable:${error.message}` });
    process.exit(2);
  }

  const exitCode = numberValue(args['run-exit'], 0, 0);
  const logWindow = readLogWindow(args['log-file'], numberValue(args['log-offset'], 0, 0));
  const runError = deriveRunError(exitCode, logWindow);
  const maxTargets = numberValue(process.env.GG_SEO_REPAIR_MAX_TARGETS, 2, 1);
  const maxAttempts = numberValue(process.env.GG_SEO_REPAIR_MAX_ATTEMPTS, 2, 1);
  const timeoutSeconds = numberValue(process.env.GG_SEO_REPAIR_TIMEOUT_SECONDS, 2700, 1);
  const nowIso = new Date().toISOString();
  const selected = selectRepairTargets({
    claims,
    planIds: parseUncheckedPlanIds(planText),
    state: loaded.state,
    archivedIds: archiveIds(),
    runError,
    maxTargets,
    maxAttempts,
    inflightTtlMs: (timeoutSeconds + 900) * 1000,
  });
  const keywords = planKeywords(planText);
  const targets = selected.targets.map((target) => ({ ...target, keyword: keywords.get(target.pageId) || '' }));
  let state = saveTerminalUpdates(loaded.state, selected.terminalUpdates, nowIso);
  if (selected.terminalUpdates.length) writeState(statePath, state);

  if (!targets.length) {
    const humanOnly = selected.terminalUpdates.filter((update) => update.terminal === 'human_only');
    const archived = selected.terminalUpdates.filter((update) => update.terminal === 'archived');
    const result = humanOnly.length
      ? { triggered: false, terminal: 'human_only', targets: humanOnly, reason: 'repair attempt cap reached' }
      : archived.length
        ? { triggered: false, terminal: 'archived', targets: archived }
        : { triggered: false, terminal: 'clean', targets: [] };
    appendRunLog(JSON.stringify(result));
    notifyTerminal(result);
    resultLine(result);
    process.exit(humanOnly.length ? 2 : 0);
  }

  if (process.env.GG_SEO_REPAIR_HOOK_ENABLED !== '1') {
    const result = { triggered: false, terminal: 'human_only', targets, reason: 'hook_disabled' };
    appendRunLog(JSON.stringify(result));
    resultLine(result);
    process.exit(2);
  }

  const codexBin = process.env.GG_SEO_REPAIR_CODEX_BIN || join(homedir(), '.local/bin/codex');
  const timeoutBin = process.env.GG_SEO_REPAIR_TIMEOUT_BIN || '/opt/homebrew/bin/gtimeout';
  if (!executable(codexBin) || !executable(timeoutBin) || !existsSync(PROMPT_FILE) || !existsSync(VERIFY_BIN)) {
    const result = { triggered: false, terminal: 'human_only', targets, reason: 'repair_runtime_unavailable' };
    appendRunLog(JSON.stringify(result));
    resultLine(result);
    process.exit(2);
  }

  state = beginRepairAttempts(state, targets, nowIso);
  try { writeState(statePath, state); }
  catch (error) {
    resultLine({ triggered: false, terminal: 'state_unavailable', reason: error.message });
    process.exit(2);
  }

  const context = {
    runStart: args['run-start'] || '',
    runExit: exitCode,
    flow: FLOW,
    ops: OPS,
    plan: planPath,
    claims: claimsPath,
    oracleBaseline: process.env.GG_AUTOMATION_ORACLE_DIR || join(homedir(), 'oracle-autopilot'),
  };
  const prompt = `${readFileSync(PROMPT_FILE, 'utf8').trim()}\n\nRUN_CONTEXT_JSON:\n${JSON.stringify(context, null, 2)}\n\nTARGETS_JSON:\n${JSON.stringify(targets, null, 2)}\n\nLOG_WINDOW:\n${logWindow.slice(-24000)}\n`;
  const agent = spawnSync(timeoutBin, [
    String(timeoutSeconds),
    codexBin,
    'exec',
    '--sandbox', 'danger-full-access',
    '-C', FLOW,
    '--add-dir', OPS,
    '--add-dir', context.oracleBaseline,
    '-',
  ], {
    cwd: FLOW,
    env: process.env,
    input: prompt,
    encoding: 'utf8',
    timeout: (timeoutSeconds + 30) * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });
  appendRunLog(`agent targets=${targets.map((target) => target.pageId).join(',')} status=${agent.status}\n${agent.stdout || ''}\n${agent.stderr || ''}`);

  if (agent.status !== 0 || agent.error) {
    const detail = agent.error?.code === 'ETIMEDOUT' ? 'timeout' : String(agent.status ?? 'signal');
    for (const target of targets) {
      state[target.fingerprint] = {
        ...state[target.fingerprint],
        status: 'pending',
        finishedAt: new Date().toISOString(),
        lastError: `codex exit ${detail}`,
      };
    }
    writeState(statePath, state);
    const result = { triggered: true, terminal: 'pending', targets, reason: `codex exit ${detail}` };
    resultLine(result);
    process.exit(2);
  }

  const targetsPath = join(baseState, `seo-repair-targets-${process.pid}.json`);
  writeFileSync(targetsPath, `${JSON.stringify(targets, null, 2)}\n`);
  const verified = spawnSync('node', [
    VERIFY_BIN,
    '--targets', targetsPath,
    '--claims', claimsPath,
    '--plan', planPath,
    '--json',
  ], {
    cwd: FLOW,
    env: process.env,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const verification = parseVerifierOutput(verified.stdout);
  const results = [];
  for (const target of targets) {
    const check = verification?.results?.find((item) => item.pageId === target.pageId) || {
      pageId: target.pageId,
      slug: target.slug,
      ok: false,
      terminal: 'pending',
      reason: 'verifier result missing',
    };
    const entry = state[target.fingerprint];
    let status = check.terminal === 'published' || check.terminal === 'archived' ? check.terminal : 'pending';
    if (status === 'pending' && Number(entry.attempts || 0) >= maxAttempts) status = 'human_only';
    state[target.fingerprint] = {
      ...entry,
      status,
      finishedAt: new Date().toISOString(),
      lastError: check.ok ? null : check.reason || 'deterministic verifier failed',
      checks: check.checks || {},
    };
    results.push({ ...check, terminal: status });
  }
  writeState(statePath, state);

  const allTerminal = results.every((item) => ['published', 'archived'].includes(item.terminal));
  const hasHumanOnly = results.some((item) => item.terminal === 'human_only');
  const terminal = allTerminal
    ? results.some((item) => item.terminal === 'published') ? 'published' : 'archived'
    : hasHumanOnly ? 'human_only' : 'pending';
  const result = {
    triggered: true,
    terminal,
    results,
    reason: results.filter((item) => !item.ok).map((item) => `${item.pageId}:${item.reason}`).join(';'),
  };
  appendRunLog(`verifier status=${verified.status} ${JSON.stringify(result)}`);
  notifyTerminal(result);
  resultLine(result);
  process.exit(allTerminal ? 0 : 2);
}

await main();
