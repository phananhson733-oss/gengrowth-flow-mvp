// red-lines.mjs — 6 binary red-line checks for gg-content-draft drafts.
//
// Pure function: input draft markdown + manifest-context object, output
//   { all_pass: bool, rules: [{ id, pass, note?, escape_reason? }, ...] }.
//
// Source of truth: gg-content-draft spec v1.1 §6 (PRD v0.7 §1.1 / §10 / 附录 B).
// All thresholds + competitor list + black-words list are exported as named constants
// so unit tests can import-and-assert without re-deriving values.
//
// Pure Node — no deps (beyond _config.mjs which itself is dep-free).

import { getConfig } from './_config.mjs';

// ============================================================
// Constants (exported for unit tests + audit)
// ============================================================
//
// Two layers per tunable threshold:
//   *_DEFAULT — the hardcoded fallback (used when sheet has no override).
//   *         — the resolved value (sheet snapshot if present, else *_DEFAULT).
//
// red-lines.mjs is called from non-async validators, so getConfig() is sync —
// it lazy-reads .gg-cache/config-snapshot.json via lib/_config.mjs. Snapshot
// is refreshed by gg-config-sync.mjs (pulls from sheet `config` tab).

// RL1: clinical-claim regex with required clinical-context follower (no disclaimer rescue, spec H3).
// "treats" / "diagnoses" / "cures" alone are too aggressive — plain English uses
// like "treats X as Y" / "diagnoses the problem" / "cures the boredom" trip FP.
// Tightening per 2026-05-21 E.4 incident: Claude v6 article said
// "writing treats color sensitivity as something..." → FP on "treats".
// Now requires clinical-context noun after the verb to flag.
export const RL1_CLINICAL_REGEX =
  /\b(diagnoses?\s+(your|the|a|patients?|symptoms?|illness|disorder|disease|anxiety|depression|trauma|grief|adhd|ocd|ptsd|bipolar|chronic|acute|condition)|treats?\s+(your|patients?|illness|symptoms?|disorder|disease|anxiety|depression|trauma|grief|adhd|ocd|ptsd|bipolar|chronic|acute|condition|inflammation|pain|insomnia|fatigue)|cures?\s+(your|the\s+(anxiety|depression|disease|illness|condition|chronic)|chronic|acute|illness|disease|symptoms?)|heals?\s+your\s+(anxiety|depression|trauma|grief|adhd|ocd|ptsd|bipolar|condition|illness)|prescribes?\s+(medication|treatment|drugs?|pills?|dosage)|prescription\s+for\s+\w+|therapy\s+for\s+\w+)\b/i;

// RL2: known competitor names + sentiment-window scan.
export const RL2_COMPETITORS = Object.freeze([
  'Cafe Astrology',
  'Astro-Seek',
  'Astro.com',
  'Co-Star',
  'AstroSofa',
  'TimePassages',
]);
export const RL2_SENTIMENT_REGEX =
  /\b(bad|wrong|inaccurate|scam|useless|terrible|garbage|misleading|fake|sucks|broken|outdated)\b/i;
export const RL2_WINDOW_CHARS = 200;

// RL3: SERP plagiarism — longest contiguous token n-gram overlap with top-3
// SERP snippets. > N tokens → fail. Override via sheet `config` key `phase2.RL3_n_gram`.
export const RL3_NGRAM_THRESHOLD_DEFAULT = 12;
export const RL3_NGRAM_THRESHOLD = getConfig('phase2.RL3_n_gram', RL3_NGRAM_THRESHOLD_DEFAULT);

// RL4: per-H2 drift — Jaccard + 5-gram shingle dual check.
// Sheet overrides: phase2.RL4_jaccard_floor / phase2.RL4_shingle_floor / phase2.RL4_drifted_sections_fail.
export const RL4_JACCARD_FLOOR_DEFAULT = 0.05;
export const RL4_JACCARD_FLOOR = getConfig('phase2.RL4_jaccard_floor', RL4_JACCARD_FLOOR_DEFAULT);
export const RL4_SHINGLE_FLOOR_DEFAULT = 0.10;
export const RL4_SHINGLE_FLOOR = getConfig('phase2.RL4_shingle_floor', RL4_SHINGLE_FLOOR_DEFAULT);
export const RL4_SHINGLE_N = 5;
export const RL4_DRIFTED_SECTIONS_FAIL_DEFAULT = 2;
export const RL4_DRIFTED_SECTIONS_FAIL = getConfig('phase2.RL4_drifted_sections_fail', RL4_DRIFTED_SECTIONS_FAIL_DEFAULT);

// RL5: keyword stuffing. Sheet override: phase2.RL5_keyword_max.
// Default lifted from 8 → 12 on 2026-05-23 after wzb 裁决 — production phase2
// 通过率 validated at 12 across 13 published pages; bootstrap default 8 too strict.
// Sheet `config` tab is source of truth; this constant is the fallback when
// `.gg-cache/config-snapshot.json` is missing.
export const RL5_MAX_COUNT_DEFAULT = 12;
export const RL5_MAX_COUNT = getConfig('phase2.RL5_keyword_max', RL5_MAX_COUNT_DEFAULT);
export const RL5_MIN_COUNT_WARN = 3;

// RL6: psych-safety — disclaimer + non-clinical language + black-words.
export const RL6_DISCLAIMER_REGEX =
  /this\s+is\s+not\s+a\s+(clinical|mental\s+health)\s+(interpretation|advice)/i;
export const RL6_FORBIDDEN_PHRASE_REGEX =
  /\byou\s+(have|are)\s+(a\s+)?(trauma|narciss\w*|anxious\s+because)/i;
// 12-word black-word list (spec §6 RL6 H3).
// Tier 1 = always-fails: healing, therapy, diagnose(s), treat(s), cure(s),
// remedy, prescribe(s), prescription, disorder, syndrome.
// Tier 2 = "condition" only when adjacent to mental/medical context.
export const RL6_BLACKLIST_ALWAYS = Object.freeze([
  'healing',
  'therapy',
  'diagnose',
  'diagnoses',
  'diagnosed',
  'treat',
  'treats',
  'treated',
  'cure',
  'cures',
  'cured',
  'remedy',
  'prescribe',
  'prescribes',
  'prescription',
  'disorder',
  'syndrome',
]);
export const RL6_CONDITION_CONTEXT_REGEX =
  /\b(mental|medical|anxiety|depression|psychiatric|psychological|health|trauma|chronic)\s+condition\b|\bcondition\s+(of|like|such\s+as)\s+(anxiety|depression|trauma|adhd|ocd|ptsd|bipolar|mental|psychiatric)/i;

// RL7: per-author banned tokens. No constant list here — the list is supplied
// per-article via ctx.authorBannedTokens (string[], compiled by Lane A
// content-draft from the chosen author persona capsule). RL7 has no notion of
// "default" black words; absent/empty → the author has no black list → pass.

// RL8: shared scientific-endorsement red line (all authors). Astrology / oracle
// content must never dress interpretation up as scientific proof. Exported for
// tests + audit (mirrors RL6_BLACKLIST_ALWAYS style). Measured: the 9 highest-
// risk phrases only — neutral mentions of "science" stay legal.
export const RL8_SCI_CLAIM_PHRASES = Object.freeze([
  'research shows',
  'studies show',
  'studies suggest',
  'scientifically proven',
  'evidence-based',
  'clinically proven',
  'data confirms',
  'proven by science',
  'scientific evidence',
]);
const RL8_PHRASE_PATTERN = RL8_SCI_CLAIM_PHRASES
  .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
  .join('|');
export const RL8_SCI_CLAIM_REGEX = new RegExp(`\\b(?:${RL8_PHRASE_PATTERN})\\b`, 'i');

// ============================================================
// Scope helpers — strip non-prose regions before scanning (Codex #9).
//   - YAML frontmatter: leading `---\n ... \n---` block.
//   - fenced code: ``` ... ``` blocks.
//   - blockquotes: lines beginning with `>` (after optional indent).
// Used by RL7 (frontmatter + blockquote + fenced) and RL8 (frontmatter +
// fenced; blockquotes kept since quoted "research shows" still implies the
// claim, but neutral mentions are covered by phrase specificity).
// ============================================================

export function stripFrontmatter(md) {
  if (typeof md !== 'string') return '';
  // Frontmatter only counts when it is the very first thing in the doc.
  const m = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? md.slice(m[0].length) : md;
}

function stripFencedCode(md) {
  // Remove ``` ... ``` (and ~~~ ... ~~~) fenced blocks, fences inclusive.
  return md.replace(/^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1[ \t]*$/gm, '');
}

function stripBlockquotes(md) {
  return md
    .split('\n')
    .filter((line) => !/^\s{0,3}>/.test(line))
    .join('\n');
}

// Prose body for RL7: drop frontmatter, fenced code, and blockquotes.
function proseBodyForAuthor(md) {
  return stripBlockquotes(stripFencedCode(stripFrontmatter(md)));
}

// Prose body for RL8: drop frontmatter and fenced code only.
function proseBodyForSci(md) {
  return stripFencedCode(stripFrontmatter(md));
}

// ============================================================
// Token helpers (kept simple to avoid edge-case surprises)
// ============================================================

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'as', 'by', 'from', 'into',
  'this', 'that', 'these', 'those', 'it', 'its', 'or', 'but', 'if', 'then',
  'so', 'do', 'does', 'did', 'has', 'have', 'had', 'you', 'your', 'we', 'our',
  'i', 'me', 'my', 'them', 'their', 'they', 'he', 'she', 'his', 'her',
]);

// bilingual-v9-full: domain lexicon for ZH compound rejoin. Intl.Segmenter's
// base Chinese dict knows common words like 蓝色 / 颜色 but doesn't know our
// niche compounds — 气场 / 脉轮 / 喉轮 etc. — and splits them char-by-char.
// We post-process the segmenter's output and greedily rejoin known compounds
// so jaccard/shingle matches concept overlap rather than character overlap.
// Ordered LONGEST-FIRST for greedy max-match correctness.
export const ZH_DOMAIN_LEXICON = [
  // 4-char compounds
  '自我觉察', '心理安全', '直觉敏感', '能量中心', '内省冷静',
  // 3-char compounds
  '能量场', '冥想者', '反思性', '对照表', '速查表',
  '海底轮', '生殖轮', '太阳轮', '眉心轮', '能量场',
  // 2-char compounds — chakras
  '脉轮', '心轮', '喉轮', '顶轮',
  // 2-char compounds — aura family
  '气场', '光环', '磁场', '能量',
  // 2-char compounds — astrology / oracle vocab
  '占星', '塔罗', '冥想', '瑜伽', '灵性', '神秘', '运势', '星盘',
  // 2-char compounds — color × concept
  '靛蓝', '气质', '反思', '觉察', '感知', '表达', '沟通',
];

// Greedy max-match rejoin: scan segmenter output for runs of single-char or
// short tokens that concatenate into a known compound in ZH_DOMAIN_LEXICON.
// E.g. ["气", "场"] → ["气场"]. Preserves all non-matching tokens verbatim.
export function rejoinZhCompounds(tokens) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    let matched = null;
    for (const term of ZH_DOMAIN_LEXICON) {
      let acc = '';
      let j = i;
      while (j < tokens.length && acc.length < term.length) {
        acc += tokens[j];
        j++;
        if (acc === term) { matched = { term, end: j }; break; }
        if (!term.startsWith(acc)) break;
      }
      if (matched) break;
    }
    if (matched) {
      out.push(matched.term);
      i = matched.end;
    } else {
      out.push(tokens[i]);
      i++;
    }
  }
  return out;
}

// Intl.Segmenter is in Node 18+ (built-in, no install) but its base Chinese
// dict is weak on domain vocab. We use it for baseline word boundary detection
// then rejoin our domain lexicon. Falls back to char-level when Segmenter is
// missing (edge case: ancient Node).
export function tokenizeZh(text) {
  if (typeof Intl.Segmenter !== 'function') {
    return (text.match(/[一-鿿]/g) || []);
  }
  const seg = new Intl.Segmenter('zh', { granularity: 'word' });
  const base = [...seg.segment(text)].filter((s) => s.isWordLike).map((s) => s.segment);
  return rejoinZhCompounds(base);
}

export function tokenizeKeepStop(text) {
  if (typeof text !== 'string') return [];
  // bilingual-v9-full: hybrid tokenizer.
  //   - EN/digits (lowercase alnum runs) — unchanged
  //   - CJK runs — segmented via Intl.Segmenter + domain lexicon rejoin
  // CJK runs are extracted as contiguous strings then tokenized; this keeps
  // EN behavior bit-identical when there's no CJK and avoids segmenter
  // overhead on EN-only docs.
  const lower = text.toLowerCase();
  if (!/[一-鿿]/.test(lower)) {
    // EN-only fast path — unchanged from v9-demo.
    return lower.match(/[a-z0-9]+/g) || [];
  }
  const tokens = [];
  // Walk text, accumulating EN-alnum / CJK runs separately, then dispatching.
  const re = /([a-z0-9]+)|([一-鿿]+)/g;
  let m;
  while ((m = re.exec(lower)) !== null) {
    if (m[1]) tokens.push(m[1]);
    else if (m[2]) tokens.push(...tokenizeZh(m[2]));
  }
  return tokens;
}

function tokensJaccard(a, b) {
  const sa = new Set(a.filter((t) => !STOP_WORDS.has(t)));
  const sb = new Set(b.filter((t) => !STOP_WORDS.has(t)));
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function shingles(tokens, n) {
  const out = new Set();
  for (let i = 0; i + n <= tokens.length; i++) {
    out.add(tokens.slice(i, i + n).join(' '));
  }
  return out;
}

function shingleOverlap(aTokens, bTokens, n) {
  const sa = shingles(aTokens, n);
  const sb = shingles(bTokens, n);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter++;
  return inter / Math.min(sa.size, sb.size);
}

// Longest common contiguous n-gram between two token arrays.
function longestCommonNgram(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  // DP table — O(a*b) memory, fine for short SERP snippets vs draft.
  let best = 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

// 2026-05-21 fix: structural section detection for RL4.
// Tables and pure ordered/bullet lists are not "drift" candidates — they encode
// structured data that naturally won't carry the target_keyword verbatim. The
// "no off-topic drift" check applies to prose only.
//
// A first-paragraph chunk is "structural" if ≥70% non-empty lines are either:
//   (a) markdown table rows (contain ≥ 2 pipe characters), or
//   (b) list items (start with `N.`, `N)`, `-`, `*`, or `+` followed by space)
//
// Exported for unit tests.
export function isStructuralFirstPara(firstPara) {
  if (!firstPara) return false;
  const lines = firstPara.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  const tableLines = lines.filter((l) => (l.match(/\|/g) || []).length >= 2);
  if (tableLines.length / lines.length >= 0.7) return true;
  const listLines = lines.filter((l) => /^(?:\d+[.)]|[-*+])\s/.test(l));
  if (listLines.length / lines.length >= 0.7) return true;
  return false;
}

// Split markdown by H2 headings. Returns [{ heading, body }].
function splitByH2(md) {
  const lines = md.split('\n');
  const sections = [];
  let current = null;
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      if (current) sections.push(current);
      current = { heading: h2[1], body: '' };
    } else if (current) {
      current.body += line + '\n';
    }
  }
  if (current) sections.push(current);
  return sections;
}

// ============================================================
// Individual rule checks
// ============================================================

export function checkRL1(draft) {
  const m = draft.match(RL1_CLINICAL_REGEX);
  if (m) {
    return {
      id: 'rl1_no_clinical_claim',
      pass: false,
      note: `clinical-claim phrase matched: "${m[0]}"`,
    };
  }
  return { id: 'rl1_no_clinical_claim', pass: true };
}

export function checkRL2(draft) {
  const lower = draft;
  for (const comp of RL2_COMPETITORS) {
    let idx = 0;
    while (true) {
      const found = lower.toLowerCase().indexOf(comp.toLowerCase(), idx);
      if (found === -1) break;
      const start = Math.max(0, found - RL2_WINDOW_CHARS);
      const end = Math.min(lower.length, found + comp.length + RL2_WINDOW_CHARS);
      const window = lower.slice(start, end);
      const sentMatch = window.match(RL2_SENTIMENT_REGEX);
      if (sentMatch) {
        return {
          id: 'rl2_no_competitor_smear',
          pass: false,
          note: `competitor "${comp}" appears within ±${RL2_WINDOW_CHARS} char of sentiment "${sentMatch[0]}"`,
        };
      }
      idx = found + comp.length;
    }
  }
  return {
    id: 'rl2_no_competitor_smear',
    pass: true,
    note: `scanned ${RL2_COMPETITORS.length} competitor names, ±${RL2_WINDOW_CHARS} char window`,
  };
}

// ctx: { serpState: 'hit' | 'missing-skipped', snippets: [string], escapeReason: string|null }
export function checkRL3(draft, ctx) {
  if (ctx.serpState === 'missing-skipped') {
    return {
      id: 'rl3_no_serp_plagiarism',
      pass: true,
      note: 'SERP cache missing — skipped via --allow-missing-serp',
      escape_reason: ctx.escapeReason || null,
      skipped: true,
    };
  }
  // Codex round 2 H1: undefined / null snippets means cache schema is broken or
  // caller forgot to pass them — treat as fail (was silently passing before).
  if (ctx.snippets === undefined || ctx.snippets === null) {
    return {
      id: 'rl3_no_serp_plagiarism',
      pass: false,
      note: 'SERP cache 缺失（snippets 字段不存在）— 请重新抓 SERP 或用 --allow-missing-serp --reason "<>"',
      escape_reason: null,
    };
  }
  if (!Array.isArray(ctx.snippets)) {
    return {
      id: 'rl3_no_serp_plagiarism',
      pass: false,
      note: 'SERP cache 格式异常（snippets 不是数组）',
      escape_reason: null,
    };
  }
  if (ctx.snippets.length === 0) {
    return {
      id: 'rl3_no_serp_plagiarism',
      pass: false,
      note: 'SERP cache 为空（snippets 数组长度 0，疑似缓存格式异常）— 请重新抓 SERP 或用 --allow-missing-serp --reason "<>"',
      escape_reason: null,
    };
  }
  const draftTokens = tokenizeKeepStop(draft);
  let maxOverlap = 0;
  for (const snippet of ctx.snippets) {
    const snipTokens = tokenizeKeepStop(snippet);
    const lc = longestCommonNgram(draftTokens, snipTokens);
    if (lc > maxOverlap) maxOverlap = lc;
  }
  const pass = maxOverlap <= RL3_NGRAM_THRESHOLD;
  return {
    id: 'rl3_no_serp_plagiarism',
    pass,
    note: `longest n-gram overlap with SERP top-${ctx.snippets.length} snippets: ${maxOverlap} tokens (threshold ${RL3_NGRAM_THRESHOLD})`,
    escape_reason: null,
  };
}

// ctx: { targetKeyword: string, entity: string }
export function checkRL4(draft, ctx) {
  const target = ctx.targetKeyword || '';
  const entity = (ctx.entity || '').toLowerCase();
  const targetTokens = tokenizeKeepStop(target);
  const sections = splitByH2(draft);
  if (sections.length === 0) {
    // No H2 sections at all — structure check will flag this; do not double-fail RL4.
    return {
      id: 'rl4_keyword_anchored',
      pass: true,
      note: 'no H2 sections to check (structure check is authoritative)',
    };
  }

  const drifted = [];
  const skippedStructural = [];
  for (const s of sections) {
    // Heuristic: take first paragraph of body (until first blank line) for anchor check.
    const firstPara = (s.body.split(/\n\s*\n/)[0] || '').trim();
    if (!firstPara) {
      drifted.push(`"${s.heading}" (empty body)`);
      continue;
    }
    // 2026-05-21 fix: skip structural sections (tables / numbered lists).
    // Anchor-to-keyword check is designed for prose drift; tabular / list data
    // legitimately won't carry the keyword verbatim.
    if (isStructuralFirstPara(firstPara)) {
      skippedStructural.push(s.heading);
      continue;
    }
    const paraTokens = tokenizeKeepStop(firstPara);
    const jac = tokensJaccard(paraTokens, targetTokens);
    const shg = shingleOverlap(paraTokens, targetTokens, RL4_SHINGLE_N);

    const driftedByMetrics = jac < RL4_JACCARD_FLOOR && shg < RL4_SHINGLE_FLOOR;
    const containsEntity = entity && firstPara.toLowerCase().includes(entity);
    // bilingual-v9-full: target-keyword recall (fraction of target tokens
    // present in para) is a stronger anchor signal than jaccard for short
    // keywords. Jaccard penalizes long paras because the union grows; recall
    // doesn't. We anchor the section if ≥50% of target tokens appear in the
    // para. Helps both EN (e.g. "aura color blue" → 2/3 present) and ZH
    // (e.g. "蓝色气场代表什么" → 2/4 present via word-segmented tokenizer).
    const paraSet = new Set(paraTokens);
    const presentCount = targetTokens.filter((t) => paraSet.has(t)).length;
    const targetCoverage = targetTokens.length === 0 ? 1 : presentCount / targetTokens.length;
    const targetAnchored = targetCoverage >= 0.5;

    if (driftedByMetrics && !containsEntity && !targetAnchored) {
      drifted.push(`"${s.heading}" (jaccard=${jac.toFixed(3)}, shingle=${shg.toFixed(3)}, target-recall=${targetCoverage.toFixed(2)})`);
    }
  }
  const pass = drifted.length < RL4_DRIFTED_SECTIONS_FAIL;
  const skipNote = skippedStructural.length
    ? ` (skipped ${skippedStructural.length} structural: ${skippedStructural.map((h) => `"${h}"`).join(', ')})`
    : '';
  return {
    id: 'rl4_keyword_anchored',
    pass,
    note: pass
      ? `all prose H2 sections reachable to target_keyword via jaccard or 5-gram shingle (drifted: ${drifted.length})${skipNote}`
      : `drifted sections: ${drifted.join('; ')}${skipNote}`,
  };
}

// ctx: { targetKeyword: string, maxCount?: number }
// maxCount lets Pillar pages raise the ceiling above the Definition default of 8
// (Pillar uses wider 8-12 spread because the hub topic naturally repeats more).
export function checkRL5(draft, ctx) {
  const target = (ctx.targetKeyword || '').trim();
  if (!target) {
    return { id: 'rl5_no_keyword_stuffing', pass: true, note: 'no target_keyword to count' };
  }
  const maxCount = Number.isFinite(ctx.maxCount) ? ctx.maxCount : RL5_MAX_COUNT;
  // Whole-word, case-insensitive count using lookahead/lookbehind to avoid
  // boundary-consumption issues when the keyword appears back-to-back.
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'gi');
  const matches = draft.match(re) || [];
  const count = matches.length;
  if (count > maxCount) {
    return {
      id: 'rl5_no_keyword_stuffing',
      pass: false,
      note: `target_keyword count = ${count} (limit ${maxCount})`,
    };
  }
  let note = `target_keyword count = ${count} (limit ${maxCount})`;
  if (count < RL5_MIN_COUNT_WARN) note += ` — warn: density low`;
  return { id: 'rl5_no_keyword_stuffing', pass: true, note };
}

// ctx: { effectivePsychSafety: 'Y' | 'N' } — also accepts legacy { psych_safety_flag } from v8 callers.
// codex review v2: strict mode — if neither field is set, fail loudly instead of silently
// passing as N/A. The whole point of RL6 is the disclaimer; if upstream forgot to pass the
// flag, that's a wiring bug, not a "no psych content" signal.
export function checkRL6(draft, ctx) {
  const ePs = ctx.effectivePsychSafety;
  const ePsLegacy = ctx.psych_safety_flag;
  // Both undefined → wiring bug. Refuse to silently pass.
  if (ePs === undefined && ePsLegacy === undefined) {
    return {
      id: 'rl6_psych_safety_disclaimer',
      pass: false,
      note: 'RL6 wiring bug: caller passed neither effectivePsychSafety nor psych_safety_flag — refusing to silently N/A. Pass an explicit "Y" or "N".',
    };
  }
  const flag = ePs ?? ePsLegacy;
  // Accept only the two canonical values; anything else (yes / y / 1 / true) is a wiring bug.
  if (flag !== 'Y' && flag !== 'N') {
    return {
      id: 'rl6_psych_safety_disclaimer',
      pass: false,
      note: `RL6 wiring bug: psych_safety value "${flag}" not in {Y, N} — refusing to silently N/A.`,
    };
  }
  if (flag !== 'Y') {
    return {
      id: 'rl6_psych_safety_disclaimer',
      pass: true,
      note: 'N/A (psych_safety=N)',
    };
  }
  // (a) disclaimer present
  const hasDisclaimer = RL6_DISCLAIMER_REGEX.test(draft);
  if (!hasDisclaimer) {
    return {
      id: 'rl6_psych_safety_disclaimer',
      pass: false,
      note: 'missing required disclaimer line ("This is not a clinical/mental health interpretation/advice")',
    };
  }
  // (b) no forbidden phrasing
  const forbidden = draft.match(RL6_FORBIDDEN_PHRASE_REGEX);
  if (forbidden) {
    return {
      id: 'rl6_psych_safety_disclaimer',
      pass: false,
      note: `forbidden phrase matched: "${forbidden[0]}"`,
    };
  }
  // (c) blacklist words — tier 1 always-fail
  const lower = draft.toLowerCase();
  for (const word of RL6_BLACKLIST_ALWAYS) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(lower)) {
      return {
        id: 'rl6_psych_safety_disclaimer',
        pass: false,
        note: `psych-safety blacklist word matched: "${word}"`,
      };
    }
  }
  // condition (tier 2) — only fail when context regex matches.
  if (RL6_CONDITION_CONTEXT_REGEX.test(lower)) {
    return {
      id: 'rl6_psych_safety_disclaimer',
      pass: false,
      note: 'psych-safety blacklist: "condition" used in mental/medical context',
    };
  }
  return {
    id: 'rl6_psych_safety_disclaimer',
    pass: true,
    note: 'disclaimer found, no forbidden phrases, no blacklist hits',
  };
}

// ctx: { authorBannedTokens?: string[], targetKeyword?: string }
// RL7 — per-author banned-token red line. Scans prose body only (frontmatter,
// blockquotes, fenced code stripped). A banned token that is a substring of the
// article's target_keyword is exempt for this article (avoids killing the very
// keyword the page must rank for). Word-boundary, case-insensitive. Hit = FAIL.
export function checkRL7(draft, ctx) {
  const banned = Array.isArray(ctx && ctx.authorBannedTokens) ? ctx.authorBannedTokens : [];
  if (banned.length === 0) {
    return {
      id: 'rl7_author_banned_tokens',
      pass: true,
      note: 'no authorBannedTokens for this author — N/A',
    };
  }
  const targetKeyword = (ctx.targetKeyword || '').toLowerCase();
  const body = proseBodyForAuthor(draft);
  const bodyLines = body.split('\n');
  const evidence = [];

  for (const rawToken of banned) {
    const token = String(rawToken || '').trim();
    if (!token) continue;
    // Exempt: token is a substring of the target_keyword for this article.
    if (targetKeyword && targetKeyword.includes(token.toLowerCase())) continue;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const re = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'i');
    for (let i = 0; i < bodyLines.length; i++) {
      const m = bodyLines[i].match(re);
      if (m) {
        evidence.push({ token, line: i + 1, context: bodyLines[i].trim().slice(0, 160) });
        break; // one hit per token is enough to fail; keep evidence compact.
      }
    }
  }

  if (evidence.length > 0) {
    return {
      id: 'rl7_author_banned_tokens',
      pass: false,
      note: `author banned token(s) matched: ${evidence.map((e) => `"${e.token}"`).join(', ')}`,
      evidence,
    };
  }
  return {
    id: 'rl7_author_banned_tokens',
    pass: true,
    note: `scanned ${banned.length} banned token(s), no hits`,
  };
}

// RL8 — shared scientific-endorsement red line (all authors). Detects phrasing
// that frames interpretation as scientific proof. Scans prose body with
// frontmatter + fenced code stripped. Hit = FAIL.
// Negation / disclaimer cues that flip a sci-claim into an honest "there is no
// scientific backing" statement, which is allowed (even desirable) on a
// metaphysical wiki. If one appears in the ~50 chars before the matched phrase,
// the match is not an endorsement.
const RL8_NEGATION_REGEX =
  /\b(no|not|never|without|lacks?|lacking|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|cannot|can't|nor|neither|unproven|unsupported)\b[^.?!]*$/i;

export function checkRL8(draft) {
  const body = proseBodyForSci(typeof draft === 'string' ? draft : '');
  const lines = body.split('\n');
  const evidence = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(RL8_SCI_CLAIM_REGEX);
    if (m) {
      const before = lines[i].slice(0, m.index);
      if (RL8_NEGATION_REGEX.test(before)) continue; // negated claim → allowed
      evidence.push({ phrase: m[0], line: i + 1, context: lines[i].trim().slice(0, 160) });
    }
  }
  if (evidence.length > 0) {
    return {
      id: 'rl8_no_scientific_endorsement',
      pass: false,
      note: `scientific-endorsement phrase(s) matched: ${evidence.map((e) => `"${e.phrase}"`).join(', ')}`,
      evidence,
    };
  }
  return {
    id: 'rl8_no_scientific_endorsement',
    pass: true,
    note: `scanned ${RL8_SCI_CLAIM_PHRASES.length} scientific-endorsement phrases, no hits`,
  };
}

// ============================================================
// Top-level orchestrator
// ============================================================

/**
 * Run all 6 red-line checks against a draft.
 *
 * @param {string} draftMd  the full markdown of the draft.
 * @param {object} ctx
 * @param {string} ctx.targetKeyword
 * @param {string} ctx.entity
 * @param {'Y'|'N'} ctx.effectivePsychSafety
 * @param {'hit'|'missing-skipped'} ctx.serpState
 * @param {string[]} [ctx.snippets]  SERP top-3 snippets (required when serpState='hit').
 * @param {string|null} [ctx.escapeReason]  reason text when serpState='missing-skipped'.
 * @param {string[]} [ctx.authorBannedTokens]  per-author black words (RL7); empty/absent → RL7 N/A.
 * @returns {{ all_pass: boolean, rules: object[] }}
 */
export function redLinesCheck(draftMd, ctx) {
  if (typeof draftMd !== 'string') {
    throw new Error('redLinesCheck: draftMd must be a string');
  }
  if (!ctx || typeof ctx !== 'object') {
    throw new Error('redLinesCheck: ctx required');
  }
  const rules = [
    checkRL1(draftMd),
    checkRL2(draftMd),
    checkRL3(draftMd, ctx),
    checkRL4(draftMd, ctx),
    checkRL5(draftMd, ctx),
    checkRL6(draftMd, ctx),
    checkRL7(draftMd, ctx),
    checkRL8(draftMd),
  ];
  const all_pass = rules.every((r) => r.pass);
  return { all_pass, rules };
}
