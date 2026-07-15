import {
  acquireRepairLease,
  listEligibleRepairEvents,
  recoverExpiredLeases,
  transitionRepairEvent,
} from './seo-repair-events.mjs';

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
