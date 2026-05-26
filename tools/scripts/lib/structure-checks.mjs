// structure-checks.mjs — structural (non-red-line) validators for gg-content
// drafts. Pure functions: input draft markdown (+ light ctx), output
//   { id, pass, severity: 'fail'|'warn', violations: [{line, text, hint?}], note }.
//
// These complement red-lines.mjs (content red lines). Where a red line asks
// "did the author write something forbidden", structure checks ask "does the
// document's SKELETON match what the current template instructs the LLM to
// produce". Severity is chosen against the LIVE templates
// (lib/content-draft-templates/{definition,pillar}.prompt.md), never against
// older SOP revisions whose requirements were intentionally dropped.
//
// Pure Node — no deps.

// ============================================================
// SC1 — Bolded direct-answer definition in the first H2 section.
//
// Both templates HARD-REQUIRE the opening section (`## What is/are <entity>?`)
// to contain exactly one markdown-bolded phrase that is the direct answer /
// core definition of the target_keyword (definition.prompt.md §输出结构 1;
// pillar.prompt.md §输出结构 1). The H1→H2 gap must stay empty (enforced
// elsewhere), so the "first non-empty content block after H1" is the body of
// the first H2 section. We assert that body contains at least one `**...**`
// span. Because the template mandates this, absence is a FAIL.
//
// We deliberately do NOT count exactly-one / position / ≤N words here — those
// are softer "ideal" shaping the template phrases as guidance, and over-strict
// counting risks failing legitimate output. Presence of a bolded span is the
// load-bearing, template-mandated, low-false-positive signal.
// ============================================================

// Match a non-empty bolded span: **...** with at least one non-space, non-star
// char inside. Avoids matching an empty `****` or a stray `** **`.
const BOLD_SPAN_REGEX = /\*\*(?=\S)([^*]+?)\*\*/;

// First H2 section body = lines after the first `## ` heading, up to the next
// `## ` heading (or EOF). Returns { headingLine, bodyLines:[{n,text}] } or null.
function firstH2Section(lines) {
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { startIdx = i; break; }
  }
  if (startIdx === -1) return null;
  const bodyLines = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    bodyLines.push({ n: i + 1, text: lines[i] });
  }
  return { headingLine: startIdx + 1, heading: lines[startIdx], bodyLines };
}

export function checkBoldedDefinition(draft) {
  const id = 'sc1_bolded_definition';
  const severity = 'fail';
  if (typeof draft !== 'string' || !draft) {
    return { id, severity, pass: true, violations: [], note: 'empty draft — skipped (structure check authoritative)' };
  }
  const lines = draft.split('\n');
  const section = firstH2Section(lines);
  if (!section) {
    // No H2 at all — structure check (H2 count) is authoritative; do not double-fail.
    return { id, severity, pass: true, violations: [], note: 'no H2 section (H2-count check authoritative)' };
  }
  const hasBold = section.bodyLines.some((l) => BOLD_SPAN_REGEX.test(l.text));
  if (hasBold) {
    return {
      id,
      severity,
      pass: true,
      violations: [],
      note: `bolded definition phrase present in first H2 section ("${section.heading.trim().slice(0, 48)}")`,
    };
  }
  return {
    id,
    severity,
    pass: false,
    violations: [{
      line: section.headingLine,
      text: section.heading.trim().slice(0, 80),
      hint: 'first H2 section must contain one **bolded** direct-answer definition of the target_keyword (template §输出结构 1)',
    }],
    note: 'no bolded direct-answer phrase found in first H2 section body',
  };
}

// ============================================================
// SC2 — Internal-link tier counting (WARN only).
//
// Extends the existing `_phase2-validate.mjs` "wikilink ≥ 2" soft hint by
// applying tier-aware floors to the count of TBD internal-link placeholders:
//   T2 → ≥ 3   (hub-ish breadth)
//   T3 → 1-2   (leaf; too many links dilutes a thin page)
// Only the canonical `[[<TBD-internal-link: ...>]]` form is counted — invented
// anchors are a red line handled elsewhere. We never inspect external links /
// target=_blank (external links are intentionally forbidden).
//
// Severity is WARN: an editor may intentionally tune link count, so this never
// blocks publish. Out-of-band counts surface as a violation with a hint.
// ============================================================

const TBD_LINK_REGEX = /\[\[<TBD-internal-link:[^\]]*?>\]\]/g;

// Tier floors/ceilings. Unknown tiers → no opinion (pass, note only).
const TIER_LINK_BOUNDS = Object.freeze({
  T2: { min: 3, max: Infinity },
  T3: { min: 1, max: 2 },
});

function countTbdLinks(draft) {
  const matches = draft.match(TBD_LINK_REGEX) || [];
  return matches.length;
}

// Line number of the first TBD link (for evidence), or null.
function firstTbdLinkLine(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (/\[\[<TBD-internal-link:/.test(lines[i])) return i + 1;
  }
  return null;
}

// ctx: { tier?: 'T1'|'T2'|'T3' }
export function checkInternalLinkTier(draft, ctx = {}) {
  const id = 'sc2_internal_link_tier';
  const severity = 'warn';
  if (typeof draft !== 'string' || !draft) {
    return { id, severity, pass: true, violations: [], note: 'empty draft — skipped' };
  }
  const tier = String(ctx.tier || '').trim().toUpperCase();
  const count = countTbdLinks(draft);
  const bounds = TIER_LINK_BOUNDS[tier];
  if (!bounds) {
    return {
      id,
      severity,
      pass: true,
      violations: [],
      note: `${count} TBD internal-link(s); tier "${tier || '(none)'}" has no tier floor — no opinion`,
    };
  }
  const lines = draft.split('\n');
  const evidenceLine = firstTbdLinkLine(lines) || 1;
  if (count < bounds.min) {
    return {
      id,
      severity,
      pass: false,
      violations: [{
        line: evidenceLine,
        text: `${count} internal link(s)`,
        hint: `${tier} suggests ≥ ${bounds.min} internal links (found ${count}) — WARN only, editor may tune`,
      }],
      note: `${count} TBD internal-link(s) < ${tier} floor ${bounds.min} (WARN)`,
    };
  }
  if (count > bounds.max) {
    return {
      id,
      severity,
      pass: false,
      violations: [{
        line: evidenceLine,
        text: `${count} internal link(s)`,
        hint: `${tier} suggests ≤ ${bounds.max} internal links (found ${count}) — WARN only, editor may tune`,
      }],
      note: `${count} TBD internal-link(s) > ${tier} ceiling ${bounds.max} (WARN)`,
    };
  }
  return {
    id,
    severity,
    pass: true,
    violations: [],
    note: `${count} TBD internal-link(s) within ${tier} band [${bounds.min}, ${bounds.max === Infinity ? '∞' : bounds.max}]`,
  };
}
