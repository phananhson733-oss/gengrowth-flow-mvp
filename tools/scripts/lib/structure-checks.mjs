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
// SC2 — Internal-link tier counting (FAIL).
//
// SOP §3 / 清单 §2 mandate a per-tier internal-link ladder; the v4.3 audit named
// internal-linking collapse as a 崩盘点. We apply tier-aware floors/ceilings to
// the count of TBD internal-link placeholders:
//   T1 → ≥ 5   (pillar/spoke mesh; SOP "T1: 5 links")
//   T2 → ≥ 3   (hub-ish breadth)
//   T3 → 1-2   (leaf; too many links dilutes a thin page)
// Only the canonical `[[<TBD-internal-link: ...>]]` form is counted — invented
// anchors are a red line handled elsewhere. We never inspect external links /
// target=_blank (external links are intentionally forbidden).
//
// Severity is FAIL (tri-model eval 2026-05-27): the ladder is a hard SOP/清单
// requirement, not an editor preference. Unknown tiers → no opinion (pass).
// ============================================================

const TBD_LINK_REGEX = /\[\[<TBD-internal-link:[^\]]*?>\]\]/g;

// Tier floors/ceilings. Unknown tiers → no opinion (pass, note only).
const TIER_LINK_BOUNDS = Object.freeze({
  T1: { min: 5, max: Infinity },
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
  const severity = 'fail';
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
        hint: `${tier} 要求 ≥ ${bounds.min} 条内链（SOP §3 / 清单 §2 阶梯），当前 ${count} 条`,
      }],
      note: `${count} TBD internal-link(s) < ${tier} floor ${bounds.min} (FAIL)`,
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
        hint: `${tier} 上限 ≤ ${bounds.max} 条内链（薄页过度堆链稀释权重，SOP §3），当前 ${count} 条`,
      }],
      note: `${count} TBD internal-link(s) > ${tier} ceiling ${bounds.max} (FAIL)`,
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
// SC3 — Prose paragraph rhythm (FAIL, both langs).
//
// Spec (2026-05-27, user clarification): a "paragraph" is the text block under
// an H1/H2/H3 between blank lines, and each should be a complete idea unit of
// 4-5 SENTENCES (sentence boundary = terminal punctuation . ! ? 。！？). The
// earlier "≤ 4 行 / atomic chunk" wording was a misread that pushed the model to
// break every 1-2 sentences, producing a page of fragments and whitespace.
//
// So SC3 now measures SENTENCES per prose paragraph (the user's unit):
//   - FAIL if a paragraph runs past SC3_MAX_SENTENCES (wall of text), or past a
//     raised word/char backstop (a few run-on sentences that are still huge).
// Under-length (over-fragmentation) is handled separately by
// checkParagraphFragmentation (WARN) so a single short transition never FAILs.
// We measure only PROSE paragraphs — headings, table rows, list items,
// blockquotes and fenced code never count (they have their own rules).
// ============================================================

// v4.5.1 (user, 2026-05-28): the unit is the SECTION, not the sentence. A coherent
// paragraph (up to ~6-7 sentences) reads fine; chopping into 2-sentence stubs reads
// "scattered" (user's word). So SC3 anti-wall stays LENIENT (only genuine run-on
// walls fail); the real lever is checkSectionScatter (paragraph COUNT per H2).
const SC3_MAX_SENTENCES = 7;  // FAIL above 7 (genuine wall); a coherent 4-6 句 paragraph is fine
const SC3_EN_WORD_MAX = 180;  // FAIL above 180 (run-on wall); the intro definition (~120-160) is OK
const SC3_CJK_CHAR_MAX = 430; // FAIL above 430 (run-on wall)

// Sentence boundary = terminal punctuation (EN . ! ?  /  ZH 。！？). Minor
// over-count on abbreviations/decimals ("e.g.", "3.5") is absorbed by the >6
// threshold. Used by SC3 and checkParagraphFragmentation so both agree.
function countSentences(text) {
  return (text.match(/[.!?。！？]/g) || []).length;
}

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
  const sentences = countSentences(text);
  const cjkSize = (text.match(/[㐀-鿿　-〿＀-￯]/g) || []).length;
  const wordSize = text.split(/\s+/).filter(Boolean).length;
  if (sentences > SC3_MAX_SENTENCES) return { over: true, metric: '句', size: sentences, max: SC3_MAX_SENTENCES };
  if (cjkSize > SC3_CJK_CHAR_MAX) return { over: true, metric: '字', size: cjkSize, max: SC3_CJK_CHAR_MAX };
  if (wordSize > SC3_EN_WORD_MAX) return { over: true, metric: 'words', size: wordSize, max: SC3_EN_WORD_MAX };
  return { over: false };
}

// A list-item line: ordered (`1.` / `1)`) or unordered (`-` `*` `+`). Captures
// the leading indent so continuation lines (indented under a marker) can be
// folded into the same item.
const LIST_ITEM_RE = /^(\s*)(\d+[.)]|[-*+])\s+(.*)$/;

// Collect list items as measurable blocks: the marker line + any indented
// continuation lines, joined; the marker and an optional leading bold label
// (`**Label.**`) are stripped so we measure the prose the item actually carries.
// SC3 measures these against the SAME wall ceiling as prose, so a wall hidden
// inside one list item (e.g. `1. <220 words>`) is still caught — the user's
// 引子+编号列表 rule means each item is a 1-2-句 point, not a paragraph in disguise.
function listItemBlocks(lines) {
  const items = [];
  let inFence = false;
  let cur = null; // { startLine, parts: [] }
  const flush = () => {
    if (cur) {
      const joined = cur.parts.join(' ').trim();
      const text = joined.replace(/^\*\*[^*\n]+\*\*[.:：]?\s*/, ''); // drop a leading bold label
      if (text) items.push({ startLine: cur.startLine, text });
    }
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (/^```/.test(trimmed) || /^~~~/.test(trimmed)) { inFence = !inFence; flush(); continue; }
    if (inFence) continue;
    const m = raw.match(LIST_ITEM_RE);
    if (m) { flush(); cur = { startLine: i + 1, parts: [m[3]] }; continue; }
    if (cur && trimmed !== '' && /^\s/.test(raw)) { cur.parts.push(trimmed); continue; } // indented continuation
    flush(); // blank / non-indented / heading / table ends the item
  }
  flush();
  return items;
}

export function checkParagraphLength(draft) {
  const id = 'sc3_paragraph_length';
  const severity = 'fail';
  if (typeof draft !== 'string' || !draft) {
    return { id, severity, pass: true, violations: [], note: 'empty draft — skipped' };
  }
  const lines = draft.split('\n');
  const paras = proseParagraphs(lines);
  const items = listItemBlocks(lines);
  const violations = [];
  for (const p of paras) {
    const m = measureParagraph(p.text);
    if (m.over) {
      violations.push({
        line: p.startLine,
        text: `${m.size} ${m.metric} — "${p.text.slice(0, 48)}…"`,
        hint: `prose paragraph wall (${m.size} ${m.metric} > ${m.max}); 把多要点改成「引子 + 编号列表」，或拆成连贯短段 (v4.5.1)`,
      });
    }
  }
  for (const it of items) {
    const m = measureParagraph(it.text);
    if (m.over) {
      violations.push({
        line: it.startLine,
        text: `list item ${m.size} ${m.metric} — "${it.text.slice(0, 48)}…"`,
        hint: `list item wall (${m.size} ${m.metric} > ${m.max}); 编号项应是 1-2 句的要点，过长就拆成多项或挪进正文段 (v4.5.1)`,
      });
    }
  }
  if (violations.length === 0) {
    return { id, severity, pass: true, violations: [], note: `${paras.length} prose paragraph(s) + ${items.length} list item(s), no wall` };
  }
  return {
    id,
    severity,
    pass: false,
    violations,
    note: `${violations.length} block(s) over wall limit`,
  };
}

// SC3b — Over-fragmentation (WARN, both langs). The opposite failure mode from
// SC3's wall-of-text: a page where almost every prose paragraph is 1-2 sentences
// reads as broken-up whitespace, not 4-5-sentence idea units. We flag it when the
// MEDIAN sentences-per-paragraph is <= 2 across a body with enough paragraphs to
// judge (median is robust to a few legitimately short transitions). WARN only —
// "good rhythm" is fuzzy, so it informs without blocking; the template is the
// primary lever.
const SC3B_MIN_PARAS = 10;       // need enough paragraphs to judge rhythm (~20% looser)
// v4.5: target is now 2-3 sentences/para, so a median of 2 is HEALTHY (not a
// warning). Only a body where almost every paragraph is a single sentence
// (median <= 1) is genuinely over-fragmented.
const SC3B_MEDIAN_FLOOR = 1;     // median sentences/para <= this = over-fragmented

// ============================================================
// v4.5.1 Phase C — heading variation (去模板感). The table + FAQ section titles
// may vary per entity, detected by a stable ROLE TOKEN instead of an exact
// string, so a growing library doesn't repeat "Quick Reference Table" /
// "Frequently Asked Questions" verbatim on every page. Single source of truth
// shared by SC3b/SC3c (short-by-design skip), SC5 (FAQ) and the _phase2 H2 specs,
// and MUST be mirrored by the oracle FAQPage JSON-LD detector
// (WikiArticleDetailPage.tsx).
//   FAQ:   EN needs faq(s) / questions / Q&A; ZH needs a real question compound
//          问题/问答/常问/疑问 (+ 繁體 問題/問答/常問/疑問).
//   Table: EN needs a glance / reference / table / cheat-sheet token;
//          ZH needs 速查 / 一览 / 速览 / 概览 / 对照表.
// Other section titles (Reflection Prompts, Sources, Take Action, …) stay fixed,
// so they never carry these tokens and can't masquerade as table / FAQ.
// EN FAQ: faq(s) / questions / Q&A — NOT bare "ask" (false-matched "How to Ask
// Your Practitioner"). \bfaqs?\b so plural "FAQs" matches too. ZH FAQ: a real
// question compound, NOT bare 问 (false-matched 访问/学问/顾问); include 繁體 so a
// "## 常見問題" heading is still recognized (the H2 spec accepts that variant).
export const EN_FAQ_HEADING_RE = /^##\s+[^\n]*(?:\bfaqs?\b|\bquestions?\b|\bq\s*&\s*a\b)/im;
export const ZH_FAQ_HEADING_RE = /^##\s*[^\n]*(?:问题|问答|常问|疑问|問題|問答|常問|疑問)/m;
// Table tokens are STRONG table-headers only (dropped key traits/properties/
// signals/by-the-numbers — those false-matched narrative headings, and SC10
// passes when no table exists, so a narrative "Key Signals" H2 could have stood
// in for a missing table). SC10 is now required-aware as the real backstop.
export const EN_TABLE_HEADING_RE = /^##\s+[^\n]*(?:at a glance|quick reference|reference table|cheat ?sheet|\btable\b)/im;
export const ZH_TABLE_HEADING_RE = /^##\s*[^\n]*(?:速查表?|一览表?|一覽表?|速览|速覽|概览|概覽|对照表|對照表|速查)/m;

// Sections whose prose is legitimately short (FAQ answers, CTA, source list,
// reflection prompts, related links) must NOT drag the SC3b rhythm median down
// nor trip SC3c scatter. Match by H2 heading, EN + ZH. The FAQ + table parts are
// role-based (Phase C) so a varied heading is still recognized as short-by-design;
// the rest are fixed-title sections.
const SC3B_EXCLUDED_FIXED = /Sources|Take Action|Related Reading|Reflection Prompts|参考来源|下一步|行动|延伸阅读|自我觉察/i;
function isShortByDesignHeading(line) {
  return SC3B_EXCLUDED_FIXED.test(line)
    || EN_FAQ_HEADING_RE.test(line) || ZH_FAQ_HEADING_RE.test(line)
    || EN_TABLE_HEADING_RE.test(line) || ZH_TABLE_HEADING_RE.test(line);
}

// Prose paragraphs in NARRATIVE sections only (excludes the short-by-design
// sections above). Mirrors proseParagraphs' structural skipping + heading track.
function narrativeProseParagraphs(lines) {
  const paras = [];
  let inFence = false;
  let excluded = false;   // inside a short-by-design section
  let inListItem = false; // last line was a list marker or its indented continuation
  let cur = null;
  const flush = () => {
    if (cur && cur.parts.join(' ').trim()) paras.push({ startLine: cur.startLine, text: cur.parts.join(' ') });
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (/^```/.test(line) || /^~~~/.test(line)) { inFence = !inFence; flush(); inListItem = false; continue; }
    if (inFence) { flush(); inListItem = false; continue; }
    if (/^#{1,6}\s/.test(line)) { flush(); excluded = isShortByDesignHeading(line); inListItem = false; continue; }
    if (line === '') { flush(); inListItem = false; continue; }
    if (/^(\d+[.)]|[-*+])\s/.test(line)) { flush(); inListItem = true; continue; } // list marker
    if (inListItem && /^\s/.test(raw)) { continue; } // indented list continuation — not prose
    if (/^\|/.test(line) || /^>/.test(line)) { flush(); inListItem = false; continue; } // table / blockquote
    inListItem = false;
    if (excluded) { flush(); continue; }
    if (!cur) cur = { startLine: i + 1, parts: [] };
    cur.parts.push(line);
  }
  flush();
  return paras;
}

export function checkParagraphFragmentation(draft) {
  const id = 'sc3b_paragraph_fragmentation';
  const severity = 'warn';
  if (typeof draft !== 'string' || !draft) {
    return { id, severity, pass: true, violations: [], note: 'empty draft — skipped' };
  }
  const paras = narrativeProseParagraphs(draft.split('\n'));
  if (paras.length < SC3B_MIN_PARAS) {
    return { id, severity, pass: true, violations: [], note: `only ${paras.length} prose paragraph(s) — too few to judge rhythm` };
  }
  const counts = paras.map((p) => countSentences(p.text)).sort((a, b) => a - b);
  const mid = Math.floor(counts.length / 2);
  const median = counts.length % 2 ? counts[mid] : (counts[mid - 1] + counts[mid]) / 2;
  if (median <= SC3B_MEDIAN_FLOOR) {
    const shortCount = counts.filter((c) => c <= 2).length;
    return {
      id,
      severity,
      pass: false,
      violations: [{
        line: 0,
        text: `median ${median} sentences/paragraph across ${paras.length} paragraphs (${shortCount} are ≤2 句)`,
        hint: '段落过度碎片化：多数段落只有 1-2 句。每段应是 4-5 句的完整意思单元，把相邻零碎段并起来。',
      }],
      note: `over-fragmented: median ${median} 句/段 (${shortCount}/${paras.length} paragraphs ≤2 句)`,
    };
  }
  return { id, severity, pass: true, violations: [], note: `median ${median} 句/段 across ${paras.length} paragraphs — OK` };
}

// ============================================================
// SC3c — Section scatter (FAIL, both langs).
//
// v4.5.1 (user, 2026-05-28): the reading unit is the H2 SECTION, not the
// sentence. "段落应该是 H2 标题；如果下面段落中需要分模块，用标识或编号标出来，
// 而不是换行看起来非常散". What the user rejected was an H2 chopped into 4+ short
// prose paragraphs split by blank lines — visually "scattered". So each narrative
// H2 should read as ONE coherent paragraph, OR a lead-in paragraph + a numbered/
// bulleted list (the list items carry the sub-points). We FAIL a narrative H2
// whose body holds more than SC3C_MAX_SECTION_PARAS separate PROSE paragraph
// blocks. List items, table rows, blockquotes and headings are NOT prose blocks,
// so the approved "引子 + 编号列表" shape counts as 1-2 blocks and passes.
// Short-by-design sections (FAQ, Sources, CTA…) are excluded via the SC3b set.
// ============================================================
const SC3C_MAX_SECTION_PARAS = 3; // > 3 separate prose paragraphs under one H2 = scattered

// Count separate prose paragraph blocks per H2 section. A block is a run of
// consecutive prose lines bounded by blank/structural lines. Returns one entry
// per NON-excluded H2 section: { heading, startLine, paraCount }. Content before
// the first H2 (the H1 title) is ignored; H3+ headings only break the run.
function sectionProseBlocks(lines) {
  const sections = [];
  let inFence = false;
  let cur = null;        // { heading, startLine, paraCount, excluded }
  let inPara = false;    // currently inside a prose block
  let inListItem = false; // last line was a list marker or its indented continuation
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (/^```/.test(line) || /^~~~/.test(line)) { inFence = !inFence; inPara = false; inListItem = false; continue; }
    if (inFence) { inPara = false; inListItem = false; continue; }
    if (/^##\s/.test(line)) { // H2 opens a new section
      if (cur && !cur.excluded) sections.push(cur);
      cur = { heading: line.replace(/^#+\s*/, ''), startLine: i + 1, paraCount: 0, excluded: isShortByDesignHeading(line) };
      inPara = false; inListItem = false;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) { inPara = false; inListItem = false; continue; } // H1 / H3+ — break run, no new section
    if (line === '') { inPara = false; inListItem = false; continue; }
    if (/^(\d+[.)]|[-*+])\s/.test(line)) { inPara = false; inListItem = true; continue; } // list marker
    // An indented line under a list item is a wrapped continuation, NOT a new
    // prose block (else a list item that wraps would falsely count as scatter).
    if (inListItem && /^\s/.test(raw)) continue;
    if (/^\|/.test(line) || /^>/.test(line)) { inPara = false; inListItem = false; continue; } // table / blockquote
    inListItem = false;
    if (!inPara) { if (cur) cur.paraCount += 1; inPara = true; } // start of a new prose block
  }
  if (cur && !cur.excluded) sections.push(cur);
  return sections;
}

export function checkSectionScatter(draft) {
  const id = 'sc3c_section_scatter';
  const severity = 'fail';
  if (typeof draft !== 'string' || !draft) {
    return { id, severity, pass: true, violations: [], note: 'empty draft — skipped' };
  }
  const sections = sectionProseBlocks(draft.split('\n'));
  const violations = [];
  for (const s of sections) {
    if (s.paraCount > SC3C_MAX_SECTION_PARAS) {
      violations.push({
        line: s.startLine,
        text: `"${s.heading}" 下有 ${s.paraCount} 段散开的 prose 段落`,
        hint: `H2 section 段落散开 (${s.paraCount} > ${SC3C_MAX_SECTION_PARAS}); 改成「引子 + 编号列表」，把子要点收进编号项而不是用空行散成多段 (v4.5.1)`,
      });
    }
  }
  if (violations.length === 0) {
    return { id, severity, pass: true, violations: [], note: `${sections.length} narrative section(s), none scattered` };
  }
  return { id, severity, pass: false, violations, note: `${violations.length} section(s) with >${SC3C_MAX_SECTION_PARAS} scattered prose paragraphs` };
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
// 首链优先权: the first body internal link must appear within the opening window
// — SOP §3 "Spoke-to-Pillar within first 150 words"; 清单 §2 "开篇 150 字内".
// EN measured in words, ZH in CJK chars (with headroom).
const SC4_FIRST_LINK_MAX_WORDS = 150;
const SC4_FIRST_LINK_MAX_CJK = 200;

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
  let wordsBeforeFirstLink = null; // EN words of prose preceding the first link
  let cjkBeforeFirstLink = null;   // ZH chars of prose preceding the first link
  let wordsSoFar = 0;
  let cjkSoFar = 0;
  let bodyWords = 0;
  let bodyCjk = 0;
  let inFence = false;
  for (let i = 0; i < bodyEnd; i++) {
    const t = lines[i].trim();
    if (/^```/.test(t) || /^~~~/.test(t)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (isStructuralLine(lines[i])) continue; // skip table/list/heading/quote
    if (SC4_TBD_LINE_REGEX.test(lines[i]) && firstBodyLinkLine === null) {
      firstBodyLinkLine = i + 1;
      wordsBeforeFirstLink = wordsSoFar;
      cjkBeforeFirstLink = cjkSoFar;
    }
    if (SC4_TBD_LINE_REGEX.test(lines[i])) bodyLinks += 1;
    const w = t.split(/\s+/).filter(Boolean).length;
    const c = (t.match(/[㐀-鿿　-〿＀-￯]/g) || []).length;
    wordsSoFar += w; cjkSoFar += c; bodyWords += w; bodyCjk += c;
  }
  if (bodyLinks === 0) {
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
  // 首链 must be within the opening window. ZH measured in 字, EN in words.
  const isCjk = bodyCjk > bodyWords;
  const offset = isCjk ? cjkBeforeFirstLink : wordsBeforeFirstLink;
  const limit = isCjk ? SC4_FIRST_LINK_MAX_CJK : SC4_FIRST_LINK_MAX_WORDS;
  if (offset !== null && offset > limit) {
    return {
      id,
      severity,
      pass: false,
      violations: [{
        line: firstBodyLinkLine,
        text: `first internal link at ~${offset} ${isCjk ? '字' : 'words'} (> ${limit})`,
        hint: `首链优先权：第一条内链须在开篇 ${limit} ${isCjk ? '字' : '词'}内（SOP §3 / 清单 §2），当前在 ~${offset} ${isCjk ? '字' : '词'}处`,
      }],
      note: `first body internal link too late (~${offset} ${isCjk ? '字' : 'words'} > ${limit})`,
    };
  }
  return {
    id,
    severity,
    pass: true,
    violations: [],
    note: `${bodyLinks}/${total} internal link(s) inline in body prose; first at ~${offset} ${isCjk ? '字' : 'words'} (首链优先权 satisfied)`,
  };
}

// ============================================================
// Shared helper — section body by heading matcher.
//
// Returns { headingLine, heading, bodyLines:[{n,text}] } for the first `## `
// heading whose text matches `re`, or null. Mirrors firstH2Section but keyed on
// a heading regex so SC5/SC8/SC9 can locate FAQ / Take Action / Sources.
// ============================================================
function sectionByHeading(lines, re) {
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]) && re.test(lines[i])) { startIdx = i; break; }
  }
  if (startIdx === -1) return null;
  const bodyLines = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    bodyLines.push({ n: i + 1, text: lines[i] });
  }
  return { headingLine: startIdx + 1, heading: lines[startIdx], bodyLines };
}

// ============================================================
// SC5 — FAQ section present with >=3 PAA-style Q&A (FAIL, both langs).
//
// v4.4 schema adds a mandatory FAQ section (## Frequently Asked Questions /
// ## 常见问题) carrying 3-4 People-Also-Ask questions. PAA + Featured Snippet +
// long-tail coverage is the highest-ROI SEO structure the prior batch missed, so
// absence — or fewer than 3 questions — is a hard fail. Questions are formatted
// as a bold line ending in `?`/`？` (H3 is forbidden by the structure check, so
// FAQ cannot use ### sub-headings). We count those bold-question lines.
// SC5 locates the FAQ section by either language's role token (single line — the
// `m` flag is harmless when testing one line at a time via sectionByHeading).
// Mirrors EN_FAQ_HEADING_RE / ZH_FAQ_HEADING_RE (defined above with the other
// Phase C role regexes), combined for a single-pass per-line match.
const FAQ_HEADING_REGEX = /^##\s+[^\n]*(?:\bfaqs?\b|\bquestions?\b|\bq\s*&\s*a\b|问题|问答|常问|疑问|問題|問答|常問|疑問)/i;
// A question must be a WHOLE bold line ending in `?`/`？` — not an inline bold
// fragment mid-answer (e.g. `Answer: **really?** maybe`).
const FAQ_QUESTION_REGEX = /^\s*\*\*(?=\S)[^*\n]*[?？]\s*\*\*\s*$/;
const FAQ_MIN_QUESTIONS = 3;

export function checkFaqSection(draft) {
  const id = 'sc5_faq_section';
  const severity = 'fail';
  if (typeof draft !== 'string' || !draft) {
    return { id, severity, pass: true, violations: [], note: 'empty draft — skipped' };
  }
  const lines = draft.split('\n');
  const section = sectionByHeading(lines, FAQ_HEADING_REGEX);
  if (!section) {
    return {
      id,
      severity,
      pass: false,
      violations: [{
        line: 1,
        text: 'no FAQ heading',
        hint: '缺少 FAQ 段（## Frequently Asked Questions / ## 常见问题），v4.4 schema 强制要求 3-4 个 PAA 问答',
      }],
      note: 'FAQ section missing (v4.4 mandatory)',
    };
  }
  const qCount = section.bodyLines.filter((l) => FAQ_QUESTION_REGEX.test(l.text)).length;
  if (qCount >= FAQ_MIN_QUESTIONS) {
    return { id, severity, pass: true, violations: [], note: `FAQ section present with ${qCount} question(s)` };
  }
  return {
    id,
    severity,
    pass: false,
    violations: [{
      line: section.headingLine,
      text: `${qCount} bolded question(s) found`,
      hint: `FAQ 段至少需 ${FAQ_MIN_QUESTIONS} 个问答（每个问题写成加粗整行并以 ?/？ 结尾），当前 ${qCount} 个`,
    }],
    note: `FAQ section has only ${qCount} question(s) (need >= ${FAQ_MIN_QUESTIONS})`,
  };
}

// ============================================================
// SC6 — H1 carries a value proposition, not a bare keyword (WARN, both langs).
//
// 清单 §1 / 审计 4.2: a magnetic H1 keeps the keyword up front but must add a
// value proposition / angle — a bare-keyword H1 (e.g. "Orange Aura Meaning")
// leaves CTR on the table. We treat a subtitle separator (: ： — – or " - ") as
// proof of a value-prop subtitle (the template's no-colon rule is about avoiding
// `[kw]: [clause]` templates, but a magnetic dash/subtitle is encouraged). With
// no separator, an H1 that is essentially just the target_keyword (<=1 extra
// token, or CJK length close to the keyword) is flagged. WARN, never blocks.
// ============================================================
const H1_SEPARATOR_REGEX = /[:：]|—|–|\s-\s/;
const CJK_REGEX = /[㐀-鿿　-〿＀-￯]/;

export function checkH1ValueProp(draft, ctx = {}) {
  const id = 'sc6_h1_value_prop';
  const severity = 'warn';
  if (typeof draft !== 'string' || !draft) {
    return { id, severity, pass: true, violations: [], note: 'empty draft — skipped' };
  }
  const m = draft.match(/^#\s+(.+?)\s*$/m);
  if (!m) {
    return { id, severity, pass: true, violations: [], note: 'no H1 (H1-count check authoritative)' };
  }
  const h1 = m[1].trim();
  const line = (draft.slice(0, m.index).match(/\n/g) || []).length + 1;
  const kw = (ctx.target_keyword || '').trim();
  const fail = (hint, note) => ({
    id, severity, pass: false, violations: [{ line, text: h1.slice(0, 80), hint }], note,
  });

  // 清单 v4.0 §1: 严禁 `[关键词]: [从句]` 死板冒号模板. Flag an H1 that leads with the
  // bare target keyword immediately followed by a colon (the rigid template).
  const colonIdx = h1.search(/[:：]/);
  if (colonIdx > -1 && kw) {
    const beforeColon = h1.slice(0, colonIdx).trim().toLowerCase().replace(/\s+/g, ' ');
    if (beforeColon === kw.toLowerCase().replace(/\s+/g, ' ')) {
      return fail(
        'H1 用了清单 §1 禁止的 `[关键词]: [从句]` 死板模板；把关键词自然融进一个磁性标题（前 60 字符/前 3-5 词内含关键词，不要"关键词 + 冒号 + 从句"）',
        'H1 uses the forbidden `[keyword]: [clause]` rigid template (清单 §1)',
      );
    }
  }

  // Bare keyword (no value proposition / magnetic angle).
  const isCjk = CJK_REGEX.test(h1);
  let bare;
  if (isCjk) {
    const len = h1.replace(/\s/g, '').length;
    bare = len <= 12 && !H1_SEPARATOR_REGEX.test(h1);
  } else {
    const h1Tokens = h1.split(/\s+/).filter(Boolean).length;
    const kwTokens = kw ? kw.split(/\s+/).filter(Boolean).length : 0;
    bare = kw ? (h1Tokens - kwTokens) <= 1 : h1Tokens <= 4;
  }
  if (bare) {
    return fail(
      'H1 看起来是纯关键词；做成磁性标题（含角度/价值主张），关键词自然融入前 60 字符，勿用 `[kw]: [从句]` 死板模板（清单 §1）',
      'H1 appears to be a bare keyword without a magnetic angle',
    );
  }
  return { id, severity, pass: true, violations: [], note: 'H1 is a magnetic title with the keyword woven in (no rigid colon template)' };
}

// ============================================================
// SC7 — snippet bold definition followed by >=3 bullet points (WARN).
//
// 审计 #4 / 清单 §1: after the bolded direct-answer definition, the opening
// section MUST carry ≥3 bullet points summarizing core traits, so AI Overview /
// Featured Snippet extraction has a clean list to lift. The audit named "缺
// bullets" as a 致命 Featured-Snippet defect, so the tri-model eval (2026-05-27)
// upgraded this from WARN to FAIL. We count list-item lines in the first H2
// section body; <3 is a hard fail (extras are fine — not a ceiling).
// ============================================================
const BULLET_LINE_REGEX = /^\s*([-*+]|\d+[.)])\s+\S/;
const SNIPPET_MIN_BULLETS = 3;

export function checkSnippetBullets(draft) {
  const id = 'sc7_snippet_bullets';
  const severity = 'fail';
  if (typeof draft !== 'string' || !draft) {
    return { id, severity, pass: true, violations: [], note: 'empty draft — skipped' };
  }
  const lines = draft.split('\n');
  const section = firstH2Section(lines);
  if (!section) {
    return { id, severity, pass: true, violations: [], note: 'no H2 section (H2-count check authoritative)' };
  }
  const bullets = section.bodyLines.filter((l) => BULLET_LINE_REGEX.test(l.text)).length;
  if (bullets >= SNIPPET_MIN_BULLETS) {
    return { id, severity, pass: true, violations: [], note: `${bullets} bullet(s) in opening section` };
  }
  return {
    id,
    severity,
    pass: false,
    violations: [{
      line: section.headingLine,
      text: `${bullets} bullet(s) after the definition`,
      hint: `加粗定义句后必须跟 >= ${SNIPPET_MIN_BULLETS} 个 bullet 概括核心特征，便于 AI Overview / Featured Snippet 提取（审计 #4 判"缺 bullets 致命"），当前 ${bullets} 个`,
    }],
    note: `opening section has only ${bullets} bullet(s) (require >= ${SNIPPET_MIN_BULLETS})`,
  };
}

// ============================================================
// SC8 — Take Action / CTA section contains a real link (FAIL, both langs).
//
// 审计 4.x: the CTA must drive an action, which requires an actual destination —
// a link-less single-sentence CTA is the defect. We accept either a real URL or
// a TBD link placeholder (draft stage resolves placeholders later; RL12 owns
// bare-URL hallucination). Section absence is left to the H2-spec check.
// ============================================================
const TAKE_ACTION_HEADING_REGEX = /^##\s+(take action|下一步行动|下一步|采取行动)/i;
// v4.4: CTA must carry a REAL destination URL ({{cta_target_url}} is substituted
// into the prompt before generation, so the LLM emits the real link). A TBD
// placeholder or an `example.com` stub is NOT an acceptable CTA target.
const CTA_LINK_REGEX = /https?:\/\/(?!(?:www\.)?example\.(?:com|org|net)\b)\S+/i;
// All http(s) URLs in a line (global), trimmed of trailing punctuation/markdown.
const CTA_URL_GLOBAL_REGEX = /https?:\/\/[^\s)\]]+/gi;
// SOP §9 / 清单 §2: CTA anchor text must NOT be a bare "here" / "click here" /
// "read more". Match a markdown link whose anchor IS one of these.
const CTA_BANNED_ANCHORS = ['here', 'click here', 'read more', 'this link', '点击这里', '这里', '阅读更多', '了解更多', '点这里'];
const MD_LINK_REGEX = /\[([^\]]+)\]\(([^)]+)\)/g;

// Canonical URL for comparison: lowercase, drop scheme/protocol-relative noise,
// strip trailing slash + a trailing #fragment. Conservative — only normalizes
// what is safe to treat as equal.
function canonicalUrl(u) {
  return String(u || '')
    .trim()
    .replace(/[).,;]+$/, '')
    .replace(/^https?:\/\//i, '')
    .replace(/#.*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

// ctx: { cta_target_url?: string }
export function checkCtaUrl(draft, ctx = {}) {
  const id = 'sc8_cta_url';
  const severity = 'fail';
  if (typeof draft !== 'string' || !draft) {
    return { id, severity, pass: true, violations: [], note: 'empty draft — skipped' };
  }
  const lines = draft.split('\n');
  const section = sectionByHeading(lines, TAKE_ACTION_HEADING_REGEX);
  if (!section) {
    return { id, severity, pass: true, violations: [], note: 'no Take Action section (H2-spec check authoritative)' };
  }
  const violations = [];
  const hasLink = section.bodyLines.some((l) => CTA_LINK_REGEX.test(l.text));
  if (!hasLink) {
    return {
      id,
      severity,
      pass: false,
      violations: [{
        line: section.headingLine,
        text: section.heading.trim().slice(0, 80),
        hint: 'Take Action / CTA 段缺真实 CTA URL（http(s)://，非占位符、非 example.com），不能是无链接的单句弱 CTA（审计 4.x；模板要求用真实 cta_target_url）',
      }],
      note: 'CTA section has no link/URL',
    };
  }
  // Exact-target check: the CTA must point at the brief's cta_target_url, not
  // an unrelated own-domain page (closes the SC8/RL12 own-domain false-negative).
  const target = canonicalUrl(ctx.cta_target_url);
  if (target) {
    const urls = section.bodyLines.flatMap((l) => (l.text.match(CTA_URL_GLOBAL_REGEX) || []));
    const matched = urls.some((u) => canonicalUrl(u) === target);
    if (!matched) {
      violations.push({
        line: section.headingLine,
        text: `CTA URL(s) [${urls.map((u) => canonicalUrl(u)).join(', ').slice(0, 80)}] ≠ cta_target_url`,
        hint: `CTA 链接必须指向 brief 的 cta_target_url（${target}），不能是其他自有域页面（SOP §9）`,
      });
    }
  }
  // Banned anchor text on any markdown link in the CTA section.
  for (const l of section.bodyLines) {
    let m;
    MD_LINK_REGEX.lastIndex = 0;
    while ((m = MD_LINK_REGEX.exec(l.text)) !== null) {
      const anchor = m[1].trim().toLowerCase();
      if (CTA_BANNED_ANCHORS.includes(anchor)) {
        violations.push({
          line: l.n,
          text: `banned CTA anchor "${m[1].trim()}"`,
          hint: 'CTA 锚文本禁用 "here"/"click here"/"read more"/"这里" 等空泛词（SOP §9），改用描述目标的语义锚文本',
        });
      }
    }
  }
  if (violations.length === 0) {
    return { id, severity, pass: true, violations: [], note: target ? 'CTA points at cta_target_url, anchor ok' : 'CTA section contains a link / URL' };
  }
  return { id, severity, pass: false, violations, note: `CTA issues (SC8): ${violations.map((v) => v.text).join('; ')}` };
}

// ============================================================
// SC9 — Sources section present with >=1 named entry (FAIL, both langs).
//
// v4.4 schema adds a controlled Sources section (## Sources / ## 参考来源)
// listing authorities already named in the body — an E-E-A-T signal AI engines
// check at page bottom. The section is RL12-safe by construction: entries are
// `- Name — one-line contribution` with no fabricated titles / years / URLs, so
// they never trip RL12's hallucination patterns. Here we only assert presence
// and >=1 list entry; off-allowlist names remain RL12 (d)'s job.
// ============================================================
// Anchored exact-heading match so `## Sources of Confusion` / `## Data Sources`
// can't be mistaken for the canonical `## Sources` section.
const SOURCES_HEADING_REGEX = /^##\s+(sources|参考来源|參考來源|参考资料|參考資料)\s*$/i;

export function checkSourcesSection(draft) {
  const id = 'sc9_sources_section';
  const severity = 'fail';
  if (typeof draft !== 'string' || !draft) {
    return { id, severity, pass: true, violations: [], note: 'empty draft — skipped' };
  }
  const lines = draft.split('\n');
  const section = sectionByHeading(lines, SOURCES_HEADING_REGEX);
  if (!section) {
    return {
      id,
      severity,
      pass: false,
      violations: [{
        line: 1,
        text: 'no Sources heading',
        hint: '缺少 Sources 段（## Sources / ## 参考来源），v4.4 schema 要求列出正文已具名的权威（仅名字+一句贡献，勿编造书名/年份/URL）',
      }],
      note: 'Sources section missing (v4.4 mandatory)',
    };
  }
  const entries = section.bodyLines.filter((l) => BULLET_LINE_REGEX.test(l.text)).length;
  if (entries >= 1) {
    return { id, severity, pass: true, violations: [], note: `Sources section present with ${entries} entry(ies)` };
  }
  return {
    id,
    severity,
    pass: false,
    violations: [{
      line: section.headingLine,
      text: 'Sources section is empty',
      hint: 'Sources 段需至少 1 条 `- 权威名 — 一句话贡献`',
    }],
    note: 'Sources section has no list entries',
  };
}

// ============================================================
// SC10 — Decision-Value / Quick-Reference table structural integrity (FAIL).
//
// The v4.3 audit named "header tampering" + a degenerate reference table as a
// 崩盘点; SOP §5 requires the table to have ≥4 columns and "Min 3 rows", and
// 创作要求清单 §3 requires a decision table with full short-sentence cells. SC10
// enforces the OBJECTIVE shape only — column count and data-row count — on the
// first markdown table found (the reference/decision grid).
//
// Deliberately NOT enforced here:
//   - exact column NAMES: they differ by template (Definition's How-to-Observe
//     grid vs Pillar's per-child grid); over-fitting risks false fails.
//   - "full sentence in every cell": legitimate reference cells are short tokens
//     ("Throat", "Sacral"); a prose-quality gate would false-fail. Left to the
//     template + human review.
//   - banned "Mechanism" header word: table rows are prose-scanned by RL13, so
//     the banned word is already a hard fail there.
//
// No table found → pass (the table SECTION's absence is caught by the H2-spec
// missing-section check in _phase2-validate, not here).
// ============================================================
const TABLE_MIN_COLS = 4;
const TABLE_MIN_ROWS = 3;
// A markdown table row: starts (after optional ws) with `|` and contains ≥1 more.
const TABLE_ROW_REGEX = /^\s*\|.*\|\s*$/;
// The separator row under the header: only |, -, :, space.
const TABLE_SEPARATOR_REGEX = /^\s*\|[\s:|-]+\|\s*$/;

// Count columns in a `| a | b | c |` row (drop the empty edge cells).
function countTableCols(rowText) {
  return rowText.trim().replace(/^\||\|$/g, '').split('|').length;
}

// `opts.required` (v4.5.1 Phase C): Definition + Pillar MANDATE a quick-reference
// table, so "no table found" is a FAIL — not a pass delegated to the H2 spec. The
// H2 spec now matches the table heading by role token, which can false-positive
// (a narrative "Key Signals" heading), so SC10 must independently verify the
// table actually exists. Tutorial (no table) passes when required is false.
export function checkTableIntegrity(draft, opts = {}) {
  const id = 'sc10_table_integrity';
  const severity = 'fail';
  const required = opts.required === true;
  if (typeof draft !== 'string' || !draft) {
    return { id, severity, pass: true, violations: [], note: 'empty draft — skipped' };
  }
  const lines = draft.split('\n');
  // Find the first header row immediately followed by a separator row.
  let headerIdx = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    if (TABLE_ROW_REGEX.test(lines[i]) && !TABLE_SEPARATOR_REGEX.test(lines[i])
        && TABLE_SEPARATOR_REGEX.test(lines[i + 1])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    if (required) {
      return {
        id,
        severity,
        pass: false,
        violations: [{
          line: 0,
          text: 'no markdown table found',
          hint: '本模板要求一个速查表 / Quick-Reference 表格（≥4 列 × ≥3 行）；正文里没有任何 markdown 表格。变体标题可以，但表格本体必须存在。',
        }],
        note: 'required table missing (no markdown table in draft)',
      };
    }
    return { id, severity, pass: true, violations: [], note: 'no markdown table found (section absence checked by H2 spec)' };
  }
  const cols = countTableCols(lines[headerIdx]);
  let dataRows = 0;
  for (let i = headerIdx + 2; i < lines.length; i++) {
    if (!TABLE_ROW_REGEX.test(lines[i])) break;
    dataRows += 1;
  }
  const violations = [];
  if (cols < TABLE_MIN_COLS) {
    violations.push({
      line: headerIdx + 1,
      text: `table has ${cols} columns`,
      hint: `决策表至少 ${TABLE_MIN_COLS} 列（含「如何观察 / How to Observe」列，清单 §3）；当前 ${cols} 列`,
    });
  }
  if (dataRows < TABLE_MIN_ROWS) {
    violations.push({
      line: headerIdx + 1,
      text: `table has ${dataRows} data rows`,
      hint: `决策表至少 ${TABLE_MIN_ROWS} 行数据（SOP §5 "Min 3 rows"）；当前 ${dataRows} 行`,
    });
  }
  if (violations.length === 0) {
    return { id, severity, pass: true, violations: [], note: `table ok (${cols} cols × ${dataRows} rows)` };
  }
  return { id, severity, pass: false, violations, note: `table integrity (SC10): ${violations.map((v) => v.text).join('; ')}` };
}

// ============================================================
// SC9b — Sources entries name-checked against the body (WARN).
//
// SOP §8 / 清单 §4: the Sources section lists authorities ALREADY named in the
// body (E-E-A-T). A source that never appears in the article is either a
// fabricated citation or a dangling name. SC9 (FAIL) owns presence; SC9b is a
// softer WARN flag because name extraction is fuzzy (em-dash variants, markdown,
// "First Last" vs surname). To keep false-positives low we pass if EITHER the
// full extracted name OR its longest token appears in the body prose.
// ============================================================
// Split a Sources bullet into its name part (before the first dash/colon).
const SOURCE_NAME_SPLIT_REGEX = /\s+[—–-]\s+|[：:]/;

function extractSourceName(bulletText) {
  // Drop the leading list marker (NOT BULLET_LINE_REGEX — that one also consumes
  // the first content char), then strip markdown emphasis / link syntax.
  let s = bulletText.replace(/^\s*([-*+]|\d+[.)])\s+/, '');
  s = s.split(SOURCE_NAME_SPLIT_REGEX)[0] || '';
  s = s.replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
  return s;
}

export function checkSourcesNamesInBody(draft) {
  const id = 'sc9b_sources_named_in_body';
  const severity = 'warn';
  if (typeof draft !== 'string' || !draft) {
    return { id, severity, pass: true, violations: [], note: 'empty draft — skipped' };
  }
  const lines = draft.split('\n');
  const section = sectionByHeading(lines, SOURCES_HEADING_REGEX);
  if (!section) {
    return { id, severity, pass: true, violations: [], note: 'no Sources section (SC9 authoritative)' };
  }
  // Body = the article with the Sources section lines removed.
  const srcLineNums = new Set([section.headingLine, ...section.bodyLines.map((l) => l.n)]);
  const body = lines.filter((_, i) => !srcLineNums.has(i + 1)).join('\n').toLowerCase();
  const violations = [];
  for (const l of section.bodyLines) {
    if (!BULLET_LINE_REGEX.test(l.text)) continue;
    const name = extractSourceName(l.text);
    if (name.length < 3) continue; // too short to verify safely
    const lower = name.toLowerCase();
    const tokens = name.split(/\s+/).filter((t) => t.length >= 3);
    const longest = tokens.sort((a, b) => b.length - a.length)[0] || lower;
    const found = body.includes(lower) || body.includes(longest.toLowerCase());
    if (!found) {
      violations.push({
        line: l.n,
        text: `source "${name}" not found in body`,
        hint: `Sources 条目「${name}」未在正文出现 —— 来源须是正文已具名的权威（SOP §8 / 清单 §4），否则是悬空/编造引用`,
      });
    }
  }
  if (violations.length === 0) {
    return { id, severity, pass: true, violations: [], note: 'all Sources entries appear in body' };
  }
  return { id, severity, pass: false, violations, note: `${violations.length} Sources entry(ies) not found in body (WARN)` };
}
