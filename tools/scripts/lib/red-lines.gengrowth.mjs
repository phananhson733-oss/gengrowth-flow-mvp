// red-lines.gengrowth.mjs — B2B SEO+GEO red-line profile (drop-in for the EN path).
//
// Loaded by _phase2-validate.mjs ONLY when GG_SITE=gengrowth (the default path
// keeps importing lib/red-lines.mjs, byte-identical behavior). Exports the SAME
// 13 checkRL1..checkRL13 names so the validator's dispatch is unchanged.
//
// Strategy vs the oracle (astrology) red-lines:
//   REUSE as-is (domain-generic): RL3 (n-gram plagiarism), RL4 (keyword anchor
//     drift), RL5 (keyword stuffing), RL7 (per-author banned tokens), RL10 (chat
//     residue), RL11 (weak verbs, warn), RL13 (AI-slop jargon).
//   DROP (astrology-only, would mis-fire or be irrelevant on B2B): RL1 (clinical
//     claims), RL2 (astrology-competitor smear), RL6 (psych-safety/occult), RL9
//     (atom-label leak — template scaffolding differs).
//   REPLACE (the safe RL8 inversion, kept OUT of the shared module): RL8 -> B2B
//     attribution guard, RL12 -> B2B citation-integrity guard. Oracle forbids
//     scientific framing; B2B REQUIRES research be attributed and checkable and
//     FAILS invented/vague citations. This is the anti-fabrication guard.

import { stripFrontmatter } from './red-lines.mjs';

// Reuse the domain-generic oracle checks verbatim (same signatures/return shape).
// RL5 (keyword density/stuffing) stays plain: it counts the EXACT unhyphenated
// target keyword, so a B2B article that writes "white-label keyword research"
// throughout does NOT trip a false stuffing flag (those hyphenated mentions
// aren't the exact unhyphenated phrase).
export {
  checkRL3,
  checkRL5,
  checkRL7,
  checkRL10,
  checkRL11,
  checkRL13,
} from './red-lines.mjs';

// RL4 (keyword ANCHOR drift) is made HYPHEN-INSENSITIVE for B2B: terms like
// "white-label", "real-time", "end-to-end" hyphenate naturally in prose while
// the search query is the unhyphenated form. Oracle RL4 tokenizes "white-label"
// as one token, so the unhyphenated target keyword never anchors a section that
// only uses the hyphenated form → false drift. Normalize hyphens→spaces in the
// draft VIEW + keyword/entity before delegating; the stored draft is untouched.
// (Only RL4 — anti-drift — gets this; RL5 — anti-stuffing — must NOT, or every
// hyphenated mention would inflate the count into a false stuffing flag.)
import { checkRL4 as _oracleRL4 } from './red-lines.mjs';
const _dehyphen = (s) => (typeof s === 'string' ? s.replace(/([A-Za-z])-([A-Za-z])/g, '$1 $2') : s);
// 4-word B2B keywords legitimately can't anchor every H2 (sections use short
// forms / pronouns). Raise the drift ceiling via ctx (no global config snapshot,
// so oracle-path tests are unaffected even under GG_SITE=gengrowth). Oracle
// default is 2.
export const GENGROWTH_RL4_DRIFT_FAIL = 4;
export function checkRL4(draft, ctx = {}) {
  return _oracleRL4(_dehyphen(draft), {
    ...ctx,
    targetKeyword: _dehyphen(ctx.targetKeyword),
    entity: _dehyphen(ctx.entity),
    driftThreshold: typeof ctx.driftThreshold === 'number' ? ctx.driftThreshold : GENGROWTH_RL4_DRIFT_FAIL,
  });
}

// ---------- dropped (astrology-only) → no-op PASS for the B2B profile ----------
const dropped = (id, why) => ({ id, pass: true, note: `n/a for gengrowth B2B profile (${why})` });
export function checkRL1(/* draft */) { return dropped('rl1_no_clinical_claim', 'no clinical/medical domain'); }
export function checkRL2(/* draft */) { return dropped('rl2_no_competitor_smear', 'astrology-competitor list n/a'); }
export function checkRL6(/* draft, ctx */) { return dropped('rl6_psych_safety', 'no psych/occult content'); }
export function checkRL9(/* draft */) { return dropped('rl9_atom_label_leak', 'B2B template scaffolding differs'); }

// ---------- helpers (self-contained; no reliance on un-exported internals) ----------
// Drop fenced code blocks + the Sources section so URLs/quotes there don't
// trip the prose-level guards (Sources/Related Reading legitimately list refs).
function proseBody(md) {
  let t = stripFrontmatter(typeof md === 'string' ? md : '');
  t = t.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  // Cut everything from a "## Sources" / "## Related Reading" heading onward.
  t = t.replace(/^#{1,6}\s*(?:sources|references|related reading)\b[\s\S]*$/im, '');
  return t;
}

// ---------- RL8 (B2B): attribution required for research claims ----------
// FAIL a vague "research/studies/data shows ..." claim UNLESS the same line
// carries an attribution (according to / by <Source> / a <year> study / source:).
export const RL8B2B_REJECT = Object.freeze([
  /\b(?:research|studies|study|data|evidence|surveys?)\s+(?:show|shows|showed|suggest|suggests|confirm|confirms|reveal|reveals|indicate|indicates|prove|proves|find|finds|found)\b/i,
  /\b(?:scientists?|researchers?|experts?|analysts?)\s+(?:say|says|said|agree|agrees|found|find|discovered|believe|believes)\b/i,
  /\(\s*(?:studies?|research|data)\s*\)/i,
]);
export const RL8B2B_ALLOW = Object.freeze([
  /according to\b/i,
  /\bper (?:a|an|the)\b/i,
  /\bsource\s*:/i,
  /\b(?:study|report|survey|analysis|research|data|index|benchmark)\s+(?:by|from)\b/i,
  /\b(?:by|from)\s+[A-Z][A-Za-z.&'-]+/, // "... by Ahrefs", "from Gartner"
  /\b\d{4}\b/, // a concrete year on the line (e.g. "a 2024 report")
  /\]\(https?:\/\//, // an inline markdown link to a source
]);

export function checkRL8(draft) {
  const id = 'rl8b2b_attribution_required';
  const lines = proseBody(draft).split('\n');
  const evidence = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hit = RL8B2B_REJECT.find((re) => re.test(line));
    if (!hit) continue;
    if (RL8B2B_ALLOW.some((re) => re.test(line))) continue;
    evidence.push({ phrase: (line.match(hit) || [''])[0], line: i + 1, context: line.trim().slice(0, 160) });
  }
  if (evidence.length) {
    return {
      id,
      pass: false,
      note: `unattributed research claim(s): ${evidence.map((e) => `"${e.phrase}" (L${e.line})`).join('; ')} — add "according to <source>" / a year / a link, or remove the claim`,
      evidence,
    };
  }
  return { id, pass: true, note: 'research claims are attributed or absent' };
}

// ---------- RL12 (B2B): citation integrity / anti-fabrication ----------
// FAIL bare external URLs (not in a markdown link or a [[<TBD-external-link>]]
// placeholder) and orphaned "et al." with no preceding author. ALLOW proper
// markdown links + TBD placeholders + attributed names.
const BARE_URL = /(?<!\]\()(?<!<)\bhttps?:\/\/[^\s<>)\]]+/g;
export function checkRL12(draft, _ctx = {}) {
  const id = 'rl12b2b_citation_integrity';
  const lines = proseBody(draft).split('\n');
  const evidence = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\[\[<TBD-external-link/i.test(line)) continue; // explicitly-deferred external link
    for (const m of line.matchAll(BARE_URL)) {
      const url = m[0].replace(/[.,;:!?)\]]+$/, '');
      evidence.push({ sub: 'bare-url', line: i + 1, context: url.slice(0, 100) });
    }
    // orphaned "et al." (no "Name et al" before it on the line)
    if (/\bet al\.?/i.test(line) && !/[A-Z][A-Za-z'-]+\s+(?:&\s+[A-Z][A-Za-z'-]+\s+)?et al\.?/.test(line)) {
      evidence.push({ sub: 'orphan-et-al', line: i + 1, context: line.trim().slice(0, 100) });
    }
  }
  if (evidence.length) {
    return {
      id,
      pass: false,
      note: `citation integrity issue(s): ${evidence.map((e) => `[${e.sub}] L${e.line}`).join(', ')} — use a markdown link, an [[<TBD-external-link: ...>]] placeholder, or a real "Author (year)"`,
      evidence,
    };
  }
  return { id, pass: true, note: 'no bare URLs / orphaned citations' };
}

// NOTE: no aggregate redLinesCheck() here on purpose. The gengrowth production
// path runs the EN checks individually via _phase2-validate.mjs (which builds a
// full ctx). gg-content-draft's redLinesCheck is on a different (non-gengrowth)
// path and keeps importing the oracle red-lines.mjs. Exposing a ctx-less
// aggregate here would only invite mis-calls of RL3/RL4/RL5 (which need ctx).
