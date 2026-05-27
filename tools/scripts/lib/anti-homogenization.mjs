// anti-homogenization.mjs — SOP v4.3 §7 ANTI-HOMOGENIZATION (batch uniqueness).
//
// SOP §7: "If Cluster_Context is provided, strictly avoid all listed metaphors,
// FAQ topics, authorities, modulation angles, and core analogies to ensure Batch
// Uniqueness." Same-cluster pages otherwise read as "one article reworded" (the
// audit flagged this on the aura / node clusters).
//
// This is the CONSUMER: given a draft + a cluster_context (the set of devices
// sibling pages already used), flag any reuse. It is conditional — with no
// cluster_context it has no opinion (pass). POPULATING cluster_context (tracking
// what siblings used) is a separate upstream concern; this check enforces it once
// provided, matching the SOP's "if provided" framing.
//
// Severity: WARN. Reuse hurts uniqueness but is not a safety/correctness failure,
// and the term lists are fuzzy, so we surface without blocking publish.
//
// Pure Node — no deps.

// Accepts both snake_case (SOP / fixture) and camelCase keys for each category.
const CATEGORY_KEYS = Object.freeze({
  metaphor: ['used_metaphors', 'usedMetaphors'],
  authority: ['used_authorities', 'usedAuthorities'],
  faq: ['used_faq', 'usedFaq', 'used_faq_topics', 'usedFaqTopics'],
  modulation: ['used_modulation_angles', 'usedModulationAngles'],
  analogy: ['used_core_analogies', 'usedCoreAnalogies'],
});

// A term shorter than this is too generic to match safely (avoids flagging
// stop-words / single letters that appear in any prose).
const MIN_TERM_LEN = 4;

function collectTerms(clusterContext) {
  const terms = [];
  if (!clusterContext || typeof clusterContext !== 'object') return terms;
  for (const [category, keys] of Object.entries(CATEGORY_KEYS)) {
    for (const key of keys) {
      const val = clusterContext[key];
      if (!Array.isArray(val)) continue;
      for (const raw of val) {
        const term = String(raw || '').trim();
        if (term.length >= MIN_TERM_LEN) terms.push({ category, term });
      }
    }
  }
  return terms;
}

export function checkAntiHomogenization(draft, clusterContext) {
  const id = 'anti_homogenization';
  if (typeof draft !== 'string' || !draft) {
    return { id, pass: true, warn: false, violations: [], note: 'empty draft — skipped' };
  }
  const terms = collectTerms(clusterContext);
  if (terms.length === 0) {
    return { id, pass: true, warn: false, violations: [], note: 'no cluster_context provided — no opinion' };
  }
  const haystack = draft.toLowerCase();
  const violations = [];
  for (const { category, term } of terms) {
    if (haystack.includes(term.toLowerCase())) {
      violations.push({ category, term, hint: `cluster already used this ${category} ("${term}") — pick a distinct one for batch uniqueness (SOP §7)` });
    }
  }
  if (violations.length === 0) {
    return { id, pass: true, warn: false, violations: [], note: `checked ${terms.length} cluster_context term(s), none reused` };
  }
  return {
    id,
    pass: true,
    warn: true,
    violations,
    note: `cluster_context reuse (WARN): ${violations.map((v) => `${v.category}:"${v.term}"`).join(', ')}`,
  };
}
