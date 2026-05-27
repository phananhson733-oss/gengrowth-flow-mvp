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

// ============================================================
// SC3 — Atomic paragraph length (FAIL, both langs).
//
// blog创作要求清单 v4.0 §3 (Atomic GEO Layout) requires "任何段落不得超过 4 行":
// prose must break into atomic 事实金句→逻辑/机制→实例 chunks so AI Overview /
// featured-snippet extraction can quote a clean unit and human readers aren't
// hit by a wall of text. Both definition templates now carry the rule
// (§段落原子化), so an over-long prose paragraph is a FAIL.
//
// "4 lines" is layout-dependent, so we proxy by length. Language-aware:
//   - CJK-bearing paragraph → CJK character count (≈ 4 lines × ~45 字 ≈ 180;
//     fail above CJK_MAX with headroom).
//   - otherwise → whitespace word count (4 lines × ~18 words ≈ 72; fail above
//     EN_MAX with headroom).
// We measure only PROSE paragraphs — headings, table rows, list items,
// blockquotes and fenced code never count (they are not walls of prose and
// have their own structural rules).
// ============================================================

const SC3_EN_WORD_MAX = 85;   // EN prose paragraph hard ceiling (target ≤ ~70)
const SC3_CJK_CHAR_MAX = 200; // CJK prose paragraph hard ceiling (target ≤ ~150)

// Group consecutive prose lines into paragraphs. Returns [{ startLine, text }].
// Skips structural lines so only real prose is measured.
function proseParagraphs(lines) {
  const paras = [];
  let inFence = false;
  let cur = null; // { startLine, parts: [] }
  const flush = () => {
    if (cur && cur.parts.join(' ').trim()) {
      paras.push({ startLine: cur.startLine, text: cur.parts.join(' ') });
    }
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (/^```/.test(line) || /^~~~/.test(line)) { inFence = !inFence; flush(); continue; }
    if (inFence) { flush(); continue; }
    const isStructural =
      line === '' ||
      /^#{1,6}\s/.test(line) ||      // heading
      /^\|/.test(line) ||             // table row
      /^>/.test(line) ||              // blockquote
      /^(\d+[.)]|[-*+])\s/.test(line); // ordered/unordered list item
    if (isStructural) { flush(); continue; }
    if (!cur) cur = { startLine: i + 1, parts: [] };
    cur.parts.push(line);
  }
  flush();
  return paras;
}

// Measure a paragraph against BOTH metrics independently, so a mixed
// CJK+Latin paragraph cannot dodge the ceiling: a long English paragraph with a
// stray CJK char is still caught by the word metric, and a long Chinese
// paragraph (whose whitespace-token count is ~1) is caught by the char metric.
// A paragraph fails if EITHER metric exceeds its ceiling.
function measureParagraph(text) {
  const cjkSize = (text.match(/[㐀-鿿　-〿＀-￯]/g) || []).length;
  const wordSize = text.split(/\s+/).filter(Boolean).length;
  if (cjkSize > SC3_CJK_CHAR_MAX) return { over: true, metric: '字', size: cjkSize, max: SC3_CJK_CHAR_MAX };
  if (wordSize > SC3_EN_WORD_MAX) return { over: true, metric: 'words', size: wordSize, max: SC3_EN_WORD_MAX };
  return { over: false };
}

export function checkParagraphLength(draft) {
  const id = 'sc3_paragraph_length';
  const severity = 'fail';
  if (typeof draft !== 'string' || !draft) {
    return { id, severity, pass: true, violations: [], note: 'empty draft — skipped' };
  }
  const lines = draft.split('\n');
  const paras = proseParagraphs(lines);
  const violations = [];
  for (const p of paras) {
    const m = measureParagraph(p.text);
    if (m.over) {
      violations.push({
        line: p.startLine,
        text: `${m.size} ${m.metric} — "${p.text.slice(0, 48)}…"`,
        hint: `prose paragraph too long (${m.size} ${m.metric} > ${m.max}); split into atomic 事实金句→机制→实例 chunks (≤ 4 行, 清单 §3)`,
      });
    }
  }
  if (violations.length === 0) {
    return { id, severity, pass: true, violations: [], note: `${paras.length} prose paragraph(s), all within atomic length` };
  }
  return {
    id,
    severity,
    pass: false,
    violations,
    note: `${violations.length} prose paragraph(s) exceed atomic length (≤ 4 行)`,
  };
}

// ============================================================
// SC4 — Internal-link distribution (FAIL, both langs).
//
// blog创作要求清单 v4.0 §2 (Link Master) requires 首链优先权: links must be
// woven INTO the body (a pillar/上位 back-link early, spokes inline mid-body),
// not all dumped in the trailing "Related Reading" section. Dumping every link
// at the end passes no link weight through the body and serves no reader flow.
// Both templates now instruct inline distribution (§内链分布), so "zero inline
// internal links in the body" is a FAIL.
//
// We split on the Related Reading H2 (EN "Related Reading" / ZH "延伸阅读"):
// every canonical TBD internal-link BEFORE that heading AND sitting on a PROSE
// line counts as "inline body". A link buried in a table row, numbered list,
// blockquote or heading does NOT count — 首链优先权 means the pillar/spoke link
// is woven into a sentence, not parked in a structural block. Require ≥ 1 such
// inline body link whenever the article has any internal links at all. No
// Related Reading heading → prose-line links anywhere count (pass). Zero links
// total → no opinion (SC2 / red-line handles count).
// ============================================================

const SC4_TBD_LINE_REGEX = /\[\[<TBD-internal-link:/;

// A line that is NOT prose: heading / table row / list item / blockquote.
// (Fenced code is handled by the caller's fence toggle.) Mirrors the skip set
// in proseParagraphs so SC3 and SC4 agree on what "prose" means.
function isStructuralLine(line) {
  const t = line.trim();
  return (
    t === '' ||
    /^#{1,6}\s/.test(t) ||
    /^\|/.test(t) ||
    /^>/.test(t) ||
    /^(\d+[.)]|[-*+])\s/.test(t)
  );
}

function relatedReadingIdx(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]) && /(related reading|延伸阅读|延伸閱讀)/i.test(lines[i])) {
      return i;
    }
  }
  return -1;
}

export function checkLinkDistribution(draft) {
  const id = 'sc4_link_distribution';
  const severity = 'fail';
  if (typeof draft !== 'string' || !draft) {
    return { id, severity, pass: true, violations: [], note: 'empty draft — skipped' };
  }
  const lines = draft.split('\n');
  const total = (draft.match(/\[\[<TBD-internal-link:/g) || []).length;
  if (total === 0) {
    return { id, severity, pass: true, violations: [], note: 'no TBD internal links — no opinion (SC2/red-line authoritative)' };
  }
  const rrIdx = relatedReadingIdx(lines);
  // Body = everything before the Related Reading heading. No heading → whole doc.
  const bodyEnd = rrIdx === -1 ? lines.length : rrIdx;
  let bodyLinks = 0;        // links on prose lines before Related Reading (首链优先权)
  let firstBodyLinkLine = null;
  let inFence = false;
  for (let i = 0; i < bodyEnd; i++) {
    if (/^```/.test(lines[i].trim()) || /^~~~/.test(lines[i].trim())) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (isStructuralLine(lines[i])) continue; // skip table/list/heading/quote
    if (SC4_TBD_LINE_REGEX.test(lines[i])) {
      bodyLinks += 1;
      if (firstBodyLinkLine === null) firstBodyLinkLine = i + 1;
    }
  }
  if (bodyLinks >= 1) {
    return {
      id,
      severity,
      pass: true,
      violations: [],
      note: `${bodyLinks}/${total} internal link(s) inline in body prose (首链优先权 satisfied)`,
    };
  }
  return {
    id,
    severity,
    pass: false,
    violations: [{
      line: rrIdx === -1 ? 1 : rrIdx + 1,
      text: `0/${total} internal links inline in body prose`,
      hint: 'no internal link woven into a body sentence (all in Related Reading or structural blocks); weave ≥ 1 pillar/spoke link into a body paragraph (首链优先权, 清单 §2)',
    }],
    note: `0/${total} internal link(s) inline in body prose — all parked in Related Reading / structural blocks (FAIL)`,
  };
}
