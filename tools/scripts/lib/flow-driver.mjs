// lib/flow-driver.mjs — overlay driver 的纯规划层：把 ledger 里每个 needs_human park 分诊成一个动作。
// P1 只规划、不执行（dry-run）。action: 'retry'(transient) / 'fix'(fixable,自修) / 'archive'(unfixable)。
import { triagePark } from './park-classify.mjs';

const TRIAGE_TO_ACTION = { transient: 'retry', fixable: 'fix', unfixable: 'archive' };

export function planDriverActions(claims) {
  const out = [];
  for (const [pid, claim] of Object.entries(claims || {})) {
    if (!claim || claim.status !== 'needs_human') continue;
    const triage = triagePark(claim);
    out.push({
      pid,
      triage,
      action: TRIAGE_TO_ACTION[triage],
      slug: claim.slug || '',
      stage: claim.stage || '',
      reason: String(claim.error || '').slice(0, 120),
    });
  }
  return out;
}
