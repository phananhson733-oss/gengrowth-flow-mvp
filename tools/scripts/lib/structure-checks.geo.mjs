// structure-checks.geo.mjs — SC-GEO: GEO citability check (warn-only first).
//
// SEPARATE from the shared lib/structure-checks.mjs on purpose: SC-GEO only
// runs in the gengrowth (B2B SEO+GEO) profile and must never enter the oracle
// line's check run-list. Scoring engine is the clean-room citability port
// (lib/citability.mjs, GEO paper Aggarwal et al. KDD2024).
//
// Phase 1 policy: mode='warn' (default). It surfaces an advisory but never
// fails the pipeline, so we can calibrate the threshold against real PG-WLS
// drafts before promoting to mode='fail'. Do NOT gate on this until calibrated.

import { scoreCitability, DEFAULT_WEIGHTS } from './citability.mjs';

// Un-calibrated heuristic floor on the 0-1 citability score. Below → advisory.
// Recalibrate from real gengrowth.ai drafts before flipping any caller to 'fail'.
export const SC_GEO_DEFAULT_THRESHOLD = 0.5;

// Per-feature floors used only to name the weakest levers in the advisory text
// (so the author knows what to add: stats / citations / quotes / definitions).
const FEATURE_FLOOR = 0.5;

/**
 * SC-GEO check on a markdown draft.
 * @param {string} markdown
 * @param {{threshold?:number, mode?:'warn'|'fail', weights?:object}} [opts]
 * @returns {{check:'SC-GEO', score:number, threshold:number, mode:'warn'|'fail',
 *            pass:boolean, level:'ok'|'warn'|'fail', weakFeatures:string[],
 *            detail:string, features:object}}
 */
export function checkScGeo(markdown, opts = {}) {
  const threshold =
    typeof opts.threshold === 'number' ? opts.threshold : SC_GEO_DEFAULT_THRESHOLD;
  const mode = opts.mode === 'fail' ? 'fail' : 'warn';
  const weights = opts.weights || DEFAULT_WEIGHTS;

  const { score, features } = scoreCitability(typeof markdown === 'string' ? markdown : '', weights);
  const below = score < threshold;

  // warn mode never fails the pipeline; fail mode fails when below threshold.
  const pass = mode === 'fail' ? !below : true;
  const level = !below ? 'ok' : mode;

  // Name the weakest normalized features (ascending) to guide the author.
  const norm = features.normalized || {};
  const weakFeatures = Object.entries(norm)
    .filter(([, v]) => typeof v === 'number' && v < FEATURE_FLOOR)
    .sort((a, b) => a[1] - b[1])
    .map(([k, v]) => `${k}=${v}`);

  const detail =
    `citability=${score} (threshold ${threshold}, mode ${mode})` +
    (below
      ? ` — BELOW; weakest levers: ${weakFeatures.join(', ') || 'n/a'}`
      : ' — ok');

  return { check: 'SC-GEO', score, threshold, mode, pass, level, weakFeatures, detail, features };
}
