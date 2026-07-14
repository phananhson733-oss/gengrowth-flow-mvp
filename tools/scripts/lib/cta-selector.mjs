// cta-selector.mjs — deterministic, product-scoped semantic CTA selection.
//
// This module deliberately has no Sheet or site-profile dependency. Every caller
// passes candidate rows and the active product host, which makes the selection
// testable and prevents a CTA from leaking between workbooks.

const PLACEHOLDER_RE = /(待搭建|占位|TODO|TBD|PLACEHOLDER)/i;
const DISALLOWED_KINDS = new Set(['blog', 'external', 'navigation']);

function clean(value) {
  return String(value ?? '').trim();
}

function normalized(value) {
  return clean(value).toLowerCase().replace(/\s+/g, ' ');
}

function enabled(value) {
  return value === true || /^(true|yes|y|1)$/i.test(clean(value));
}

function allowedHosts(allowedHost) {
  const values = Array.isArray(allowedHost) ? allowedHost : [allowedHost];
  const hosts = new Set();
  for (const value of values) {
    const host = normalized(value);
    if (!host) continue;
    hosts.add(host);
    if (!host.startsWith('www.')) hosts.add(`www.${host}`);
  }
  return hosts;
}

function isValidUrl(url, hosts) {
  const raw = clean(url);
  if (!raw || PLACEHOLDER_RE.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' && hosts.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function eligible(candidate, hosts) {
  return candidate
    && enabled(candidate.blog_eligible)
    && !DISALLOWED_KINDS.has(normalized(candidate.cta_kind))
    && clean(candidate.cta_id)
    && clean(candidate.cta_text)
    && isValidUrl(candidate.target_url, hosts);
}

function keywordList(value) {
  return clean(value)
    .split(/[;,，、\n]+/)
    .map((item) => normalized(item))
    .filter(Boolean);
}

function phraseMatches(phrase, value) {
  const p = normalized(phrase);
  const v = normalized(value);
  return Boolean(p && v && (v.includes(p) || p.includes(v)));
}

function scoreCandidate(candidate, context) {
  const keywords = keywordList(candidate.match_keywords).filter((keyword) => keyword !== '*');
  const fields = [
    ['target_keyword', 1000],
    ['entity', 800],
    ['associated_keywords', 100],
    ['content_angle', 40],
  ];
  let score = 0;
  const reasons = [];
  for (const [field, points] of fields) {
    const value = context[field];
    if (!value) continue;
    const hit = keywords.find((keyword) => phraseMatches(keyword, value));
    if (!hit) continue;
    score += points;
    reasons.push(`${field}:${hit}`);
  }
  if (normalized(context.preferred_kind) && normalized(candidate.cta_kind) === normalized(context.preferred_kind)) {
    score += 5;
    reasons.push(`preferred_kind:${normalized(candidate.cta_kind)}`);
  }
  return { score, reasons };
}

function priority(candidate) {
  const numeric = Number(candidate.priority);
  return Number.isFinite(numeric) ? numeric : 0;
}

function selection(candidate, reason) {
  return {
    ok: true,
    cta_id: clean(candidate.cta_id),
    cta_text: clean(candidate.cta_text),
    target_url: clean(candidate.target_url),
    ga4_event_name: clean(candidate.ga4_event_name),
    cta_selection_reason: reason,
  };
}

/**
 * Choose a primary non-blog CTA for a page.
 *
 * @param {{ candidates: object[], context?: object, allowedHost: string|string[] }} input
 * @returns {{ok: true, cta_id: string, cta_text: string, target_url: string, ga4_event_name: string, cta_selection_reason: string}|{ok: false, reason: string}}
 */
export function selectCta({ candidates, context = {}, allowedHost }) {
  const hosts = allowedHosts(allowedHost);
  const valid = (Array.isArray(candidates) ? candidates : []).filter((candidate) => eligible(candidate, hosts));
  const explicit = clean(context.explicit_cta);
  if (explicit) {
    const exact = valid.find((candidate) => candidate.cta_id === explicit || candidate.target_url === explicit);
    if (exact) return selection(exact, `explicit_catalog_cta:${exact.cta_id}`);
  }

  const scored = valid
    .map((candidate) => ({ candidate, ...scoreCandidate(candidate, context) }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || priority(b.candidate) - priority(a.candidate) || clean(a.candidate.cta_id).localeCompare(clean(b.candidate.cta_id)));
  if (scored.length) {
    const winner = scored[0];
    return selection(winner.candidate, `semantic_match:${winner.reasons.join(',')}`);
  }

  const wildcard = valid
    .filter((candidate) => keywordList(candidate.match_keywords).includes('*'))
    .sort((a, b) => priority(b) - priority(a) || clean(a.cta_id).localeCompare(clean(b.cta_id)));
  if (wildcard.length === 1) return selection(wildcard[0], `wildcard_fallback:${wildcard[0].cta_id}`);
  return { ok: false, reason: 'no_eligible_cta_match' };
}

export function isEligibleCta(candidate, allowedHost) {
  return eligible(candidate, allowedHosts(allowedHost));
}
