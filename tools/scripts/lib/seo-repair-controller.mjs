import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  acquireRepairLease,
  listEligibleRepairEvents,
  recoverExpiredLeases,
  transitionRepairEvent,
} from './seo-repair-events.mjs';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = resolve(LIB_DIR, '..');
const FLOW_DIR = resolve(SCRIPTS_DIR, '../..');
const DEFAULT_AGENT_PROMPT = join(SCRIPTS_DIR, 'prompts/gg-seo-repair-controller.txt');

const TRANSIENT_KINDS = new Set(['tool_exit', 'timeout', 'publish_fail']);
const DETERMINISTIC_KINDS = new Set(['state_fail', 'backfill_fail']);
const AGENT_FIXABLE_KINDS = new Set(['gate_fail', 'asset_fail', 'link_fail']);
const NONDELEGABLE_TYPES = new Set([
  'oauth_login',
  'captcha',
  'human_approval',
  'account_owner_authorization',
  'permission_denied',
  'missing_authoritative_source',
]);
const TERMINALS = new Set(['published', 'archived', 'human_only']);
const STRATEGY_CHAINS = {
  transient: ['deterministic_retry', 'agent_diagnosis', 'agent_code_environment'],
  deterministic_fixable: ['deterministic_repair', 'agent_diagnosis', 'agent_code_environment'],
  agent_fixable: ['agent_content_asset_link', 'agent_code_environment'],
  nondelegable: ['safe_authorization_path'],
  unpublishable: ['archive_with_evidence'],
};

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('invalid controller time');
  return date;
}

function clockValue(now) {
  return asDate(typeof now === 'function' ? now() : (now || new Date()));
}

function boundedRepairEvidence(value) {
  let text;
  try { text = JSON.stringify(value); }
  catch { text = String(value || ''); }
  const redacted = text
    .replace(/\b(bearer)\s+[a-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b(token|password|secret|api[_-]?key)\s*[:=]\s*[^\\"\s,}]+/gi, '$1=[REDACTED]');
  return redacted.length <= 12_000 ? redacted : redacted.slice(-12_000);
}

export function buildRepairAgentPrompt({ template, record, strategy, target }) {
  const safeEvent = {
    schemaVersion: record?.event?.schemaVersion,
    eventId: record?.event?.eventId,
    runId: record?.event?.runId,
    site: record?.event?.site,
    lane: record?.event?.lane,
    pageId: record?.event?.pageId,
    slug: record?.event?.slug,
    stage: record?.event?.stage,
    errorKind: record?.event?.errorKind,
    summary: record?.event?.summary,
    stderr: record?.event?.stderr,
    logFile: record?.event?.logFile,
    logOffsetStart: record?.event?.logOffsetStart,
    logOffsetEnd: record?.event?.logOffsetEnd,
    createdAt: record?.event?.createdAt,
  };
  const payload = {
    fingerprint: record?.fingerprint,
    strategy,
    event: safeEvent,
    authoritativeLogWindow: {
      file: safeEvent.logFile,
      offsetStart: safeEvent.logOffsetStart,
      offsetEnd: safeEvent.logOffsetEnd,
      stderr: safeEvent.stderr,
    },
    recentRepairEvidence: (record?.history || [])
      .filter((entry) => entry?.evidence)
      .slice(-3)
      .map((entry) => ({
        status: entry.status,
        at: entry.at,
        evidence: boundedRepairEvidence(entry.evidence),
      })),
    target,
  };
  return [
    String(template || '').trim(),
    '',
    'Runtime constraints:',
    '- Process exactly this target; never start a batch or top-level nightly wrapper.',
    '- For pipeline code, create an isolated git worktree and a codex/seo-repair-* branch before editing.',
    '- Treat Agent output as repair diagnostics only; deterministic regating and terminal verification run afterward.',
    '- Use only target.allowedActions and verifiedLinkCandidates; do not invent routes or bypass gates.',
    '- Do not read personal profiles and do not print or persist credentials.',
    '',
    'REPAIR_TARGET_JSON:',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

function defaultAgentRun({ prompt, target, timeoutSeconds }) {
  const codexBin = process.env.GG_SEO_REPAIR_CODEX_BIN || join(homedir(), '.local', 'bin', 'codex');
  if (!existsSync(codexBin)) {
    return { code: 127, stdout: '', stderr: `codex binary missing: ${codexBin}`, timedOut: false };
  }
  const cwd = target?.worktree || FLOW_DIR;
  const codexArgs = [
    codexBin,
    'exec',
    '--sandbox', 'danger-full-access',
    '-C', cwd,
    '-',
  ];
  const timeoutBin = process.env.GG_SEO_REPAIR_TIMEOUT_BIN || '/opt/homebrew/bin/gtimeout';
  const command = existsSync(timeoutBin) ? timeoutBin : codexBin;
  const args = existsSync(timeoutBin) ? [String(timeoutSeconds), ...codexArgs] : codexArgs.slice(1);
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    input: prompt,
    encoding: 'utf8',
    timeout: (timeoutSeconds + 30) * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    code: result.status ?? 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || result.error?.message || ''),
    timedOut: result.status === 124 || result.error?.code === 'ETIMEDOUT',
  };
}

export async function invokeTargetRepairAgent(input, deps = {}) {
  const promptFile = deps.promptFile || process.env.GG_SEO_REPAIR_CONTROLLER_PROMPT_FILE || DEFAULT_AGENT_PROMPT;
  const template = deps.template !== undefined
    ? deps.template
    : readFileSync(promptFile, 'utf8');
  const prompt = buildRepairAgentPrompt({ ...input, template });
  const timeoutSeconds = Math.max(1, Number(deps.timeoutSeconds
    || process.env.GG_SEO_REPAIR_TIMEOUT_SECONDS
    || 2700));
  const runAgent = deps.runAgent || defaultAgentRun;
  let result;
  try {
    result = await runAgent({ prompt, target: input.target, timeoutSeconds });
  } catch (error) {
    return {
      ok: false,
      evidence: { type: 'agent_crash', message: error instanceof Error ? error.message : String(error) },
    };
  }
  if (result?.timedOut || result?.code === 124) {
    return {
      ok: false,
      evidence: {
        type: 'agent_timeout',
        code: result?.code ?? null,
        stderr: String(result?.stderr || '').slice(-8_192),
      },
    };
  }
  if (result?.code !== 0) {
    return {
      ok: false,
      evidence: {
        type: 'agent_exit',
        code: result?.code ?? null,
        stdout: String(result?.stdout || '').slice(-8_192),
        stderr: String(result?.stderr || '').slice(-8_192),
      },
    };
  }
  return {
    ok: true,
    evidence: {
      type: 'agent_completed_repair_attempt',
      stdout: String(result?.stdout || '').slice(-16_384),
      stderr: String(result?.stderr || '').slice(-8_192),
    },
  };
}

export function isNondelegableEvidence(evidence) {
  return Boolean(
    evidence
    && NONDELEGABLE_TYPES.has(String(evidence.type || ''))
    && evidence.safeAuthorizationAttempted === true
    && evidence.stillBlocked === true,
  );
}

export function classifyRepairEvent(event, evidence = null) {
  const kind = String(event?.errorKind || '');
  if (kind === 'stale') return 'unpublishable';
  if (kind === 'auth' || kind === 'source') {
    return isNondelegableEvidence(evidence) ? 'nondelegable' : 'agent_fixable';
  }
  if (TRANSIENT_KINDS.has(kind)) return 'transient';
  if (DETERMINISTIC_KINDS.has(kind)) return 'deterministic_fixable';
  if (AGENT_FIXABLE_KINDS.has(kind)) return 'agent_fixable';
  return 'agent_fixable';
}

function chainFor(classification) {
  return STRATEGY_CHAINS[classification] || STRATEGY_CHAINS.agent_fixable;
}

function normalizedCurrentStrategy(record) {
  const chain = chainFor(record.classification);
  return chain.includes(record.strategy) ? record.strategy : chain[0];
}

export function nextRepairStrategy(record, outcome, {
  maxAttempts = 2,
  now = new Date(),
  backoffMs = 6 * 60 * 60 * 1000,
} = {}) {
  const chain = chainFor(record.classification);
  const current = normalizedCurrentStrategy(record);
  const attempts = Number(record.strategyAttempts?.[current] || 0);
  if (outcome?.ok === true) {
    return { status: 'regating', strategy: current, nextEligibleAt: null };
  }
  if (attempts < Math.max(1, Number(maxAttempts) || 1)) {
    return { status: 'queued', strategy: current, nextEligibleAt: null };
  }
  const index = chain.indexOf(current);
  if (index >= 0 && index < chain.length - 1) {
    return { status: 'queued', strategy: chain[index + 1], nextEligibleAt: null };
  }
  const at = asDate(now);
  return {
    status: 'repair_pending',
    strategy: current,
    nextEligibleAt: new Date(at.getTime() + Math.max(1, Number(backoffMs) || 1)).toISOString(),
  };
}

export function terminalNotificationKey(record, terminal) {
  if (!TERMINALS.has(terminal)) throw new TypeError(`unsupported terminal: ${terminal}`);
  return `${terminal}:${record.event.site}:${record.event.pageId}:${record.fingerprint}`;
}

export function terminalMessageUuid(idempotencyKey) {
  const hex = createHash('sha256').update(String(idempotencyKey || '')).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function initialStrategy(classification) {
  return chainFor(classification)[0];
}

function acceptedTerminal(result) {
  const terminal = result?.terminal;
  if (!TERMINALS.has(terminal)) return null;
  if (terminal === 'human_only' && !isNondelegableEvidence(result.evidence)) return null;
  if (terminal === 'archived' && !result?.evidence) return null;
  if (terminal === 'published' && !result?.evidence) return null;
  return terminal;
}

export async function drainRepairQueue({
  queueDir,
  adapters,
  notifyTerminal = async () => {},
  owner = `seo-repair-controller:${process.pid}`,
  now = () => new Date(),
  maxTargets = Number.POSITIVE_INFINITY,
  budgetMs = 15 * 60 * 1000,
  leaseMs = 20 * 60 * 1000,
  maxStrategyAttempts = 2,
  backoffMs = 6 * 60 * 60 * 1000,
  agingMs,
} = {}) {
  if (!queueDir) throw new TypeError('queueDir is required');
  if (!adapters || typeof adapters !== 'object') throw new TypeError('adapters are required');
  const startedWallMs = Date.now();
  const hardMax = Number.isFinite(Number(maxTargets))
    ? Math.max(0, Math.floor(Number(maxTargets)))
    : Number.POSITIVE_INFINITY;
  const recovered = await recoverExpiredLeases({ queueDir, now: clockValue(now) });
  const terminals = [];
  const failures = [];
  let processed = 0;

  while (processed < hardMax && Date.now() - startedWallMs < Math.max(1, Number(budgetMs) || 1)) {
    const eligible = await listEligibleRepairEvents({
      queueDir,
      now: clockValue(now),
      ...(agingMs === undefined ? {} : { agingMs }),
    });
    if (eligible.length === 0) break;
    const leased = await acquireRepairLease(eligible[0], {
      queueDir,
      owner,
      now: clockValue(now),
      leaseMs,
    });
    if (!leased) continue;
    processed += 1;

    const classification = classifyRepairEvent(leased.event, leased.classificationEvidence);
    const strategy = chainFor(classification).includes(leased.strategy)
      ? leased.strategy
      : initialStrategy(classification);
    const strategyAttempts = {
      ...(leased.strategyAttempts || {}),
      [strategy]: Number(leased.strategyAttempts?.[strategy] || 0) + 1,
    };
    const active = await transitionRepairEvent(leased, {
      status: 'repairing',
      classification,
      strategy,
      strategyAttempts,
      evidence: { classification, strategy, attempt: strategyAttempts[strategy] },
    }, {
      queueDir,
      now: clockValue(now),
    });

    let result;
    const adapter = adapters[active.event.site];
    try {
      if (!adapter || typeof adapter.execute !== 'function') {
        throw new Error(`missing repair adapter for ${active.event.site}`);
      }
      result = await adapter.execute({
        record: active,
        classification,
        strategy,
      });
    } catch (error) {
      result = {
        ok: false,
        evidence: {
          type: 'controller_or_adapter_error',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const terminal = acceptedTerminal(result);
    if (terminal) {
      const idempotencyKey = terminalNotificationKey(active, terminal);
      const terminalRecord = await transitionRepairEvent(active, {
        status: terminal,
        evidence: result.evidence,
        terminalNotificationKey: idempotencyKey,
      }, {
        queueDir,
        now: clockValue(now),
      });
      await notifyTerminal({
        terminal,
        site: terminalRecord.event.site,
        pageId: terminalRecord.event.pageId,
        slug: terminalRecord.event.slug,
        fingerprint: terminalRecord.fingerprint,
        evidence: result.evidence,
        idempotencyKey,
        messageUuid: terminalMessageUuid(idempotencyKey),
      });
      terminals.push({ pageId: terminalRecord.event.pageId, terminal, idempotencyKey });
      continue;
    }

    const decision = nextRepairStrategy(active, result, {
      maxAttempts: maxStrategyAttempts,
      now: clockValue(now),
      backoffMs,
    });
    const pending = await transitionRepairEvent(active, {
      status: decision.status,
      strategy: decision.strategy,
      nextEligibleAt: decision.nextEligibleAt,
      evidence: result?.evidence || { type: 'repair_failed_without_evidence' },
    }, {
      queueDir,
      now: clockValue(now),
    });
    failures.push({
      pageId: pending.event.pageId,
      status: pending.status,
      strategy: pending.strategy,
    });
  }

  const remaining = (await listEligibleRepairEvents({
    queueDir,
    now: clockValue(now),
    ...(agingMs === undefined ? {} : { agingMs }),
  })).length;
  return {
    ok: true,
    processed,
    remaining,
    recovered,
    terminals,
    failures,
  };
}
