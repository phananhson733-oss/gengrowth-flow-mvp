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
// Global variant for scanning EVERY phrase on a line (not just the first). A
// non-global match() stops at the first hit, so a negated disclaimer followed by
// an affirmative claim on the same line ("no evidence, but studies show ...")
// would slip through. matchAll over the global regex closes that bypass.
const RL8_SCI_CLAIM_REGEX_G = new RegExp(`\\b(?:${RL8_PHRASE_PATTERN})\\b`, 'gi');

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
  // (c) blacklist words — tier 1 always-fail. A banned word that IS the page's
  // target keyword is exempt (mirrors RL7 isTokenExemptByKeyword): e.g. the
  // keyword "Healing Your Inner Wound" must be allowed to use "healing", or the
  // page can never rank. Exemption is per-word — other clinical-overreach claims
  // (treat/cure/diagnose…) still fail. ctx.targetKeyword absent → no exemption.
  const lower = draft.toLowerCase();
  const targetKeyword = ctx.targetKeyword || '';
  for (const word of RL6_BLACKLIST_ALWAYS) {
    if (isTokenExemptByKeyword(word, targetKeyword)) continue;
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

// A banned token is exempt only when it appears as a whole word/phrase inside a
// GENUINE target keyword. Caps on length (80 chars) and word count (7) stop a
// crafted bag-of-words keyword from exempting an author's entire ban list, and
// the match is whole-word so "energy" isn't exempted by the keyword "synergy".
const RL7_KEYWORD_MAX_LEN = 80;
const RL7_KEYWORD_MAX_WORDS = 7;
function isTokenExemptByKeyword(token, targetKeyword) {
  if (!targetKeyword) return false;
  if (targetKeyword.length > RL7_KEYWORD_MAX_LEN) return false;
  if (targetKeyword.split(/\s+/).filter(Boolean).length > RL7_KEYWORD_MAX_WORDS) return false;
  const escaped = token.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(targetKeyword);
}

// ctx: { authorBannedTokens?: string[], targetKeyword?: string }
// RL7 — per-author banned-token red line. Scans prose body only (frontmatter,
// blockquotes, fenced code stripped). A banned token that appears as a whole word
// inside a genuine target_keyword is exempt for this article (avoids killing the
// very keyword the page must rank for). Multi-word tokens are matched against the
// whole body so a phrase wrapped across a line break is still caught. Word-
// boundary, case-insensitive. Hit = FAIL.
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
    if (isTokenExemptByKeyword(token, targetKeyword)) continue;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    // Scan the whole body (not per line) so a multi-word token split across a
    // newline still matches — \s+ spans the line break. Line number is derived
    // from the match offset for evidence.
    const re = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'i');
    const m = body.match(re);
    if (m) {
      const lineNo = body.slice(0, m.index).split('\n').length;
      evidence.push({ token, line: lineNo, context: (bodyLines[lineNo - 1] || '').trim().slice(0, 160) });
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
// metaphysical wiki. The cue only exempts a claim when it sits in the SAME
// clause as the phrase — see clauseBeforeMatch. (Residual limitation: an
// intensifier-negation like "there is no doubt that research shows ..." still
// reads as a negation in-clause; that rarer construction is accepted as a
// known false-negative rather than risking false-positives on honest disclaimers.)
const RL8_NEGATION_REGEX =
  /\b(no|not|never|without|lacks?|lacking|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|cannot|can't|nor|neither|unproven|unsupported)\b[^,;:.?!]*$/i;

// Slice the pre-match text down to the clause directly preceding the phrase, so a
// negation in an earlier clause ("Not surprisingly, research shows ...") does not
// falsely exempt an affirmative claim.
function clauseBeforeMatch(before) {
  let lastBoundary = -1;
  for (const ch of [',', ';', ':', '.', '?', '!']) {
    const idx = before.lastIndexOf(ch);
    if (idx > lastBoundary) lastBoundary = idx;
  }
  return lastBoundary >= 0 ? before.slice(lastBoundary + 1) : before;
}

export function checkRL8(draft) {
  const body = proseBodyForSci(typeof draft === 'string' ? draft : '');
  const lines = body.split('\n');
  const evidence = [];
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(RL8_SCI_CLAIM_REGEX_G)) {
      const before = lines[i].slice(0, m.index);
      if (RL8_NEGATION_REGEX.test(clauseBeforeMatch(before))) continue; // negated in-clause → allowed
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
// RL9 — atom-block scaffold-label leak (FAIL).
//
// The current templates (definition.prompt.md / pillar.prompt.md) instruct the
// LLM to write FLOWING prose — they never tell it to print the internal
// "Topic-Process-Example" atom-block labels into the body. When those labels
// leak verbatim (a sign the model echoed scaffolding instead of composing), the
// page reads like a fill-in-the-blank worksheet. High confidence → FAIL.
//
// CRITICAL false-positive guard: we only match a label when it is a STRUCTURAL
// MARKER — i.e. it sits at the start of a line and is immediately followed by a
// colon or wrapped in parentheses, OR the whole (trimmed) line equals the label.
// Ordinary prose like "For example, Saturn..." / "for instance, ..." must NOT
// trip this. See lib-red-lines-rl9.smoke.test.mjs for the proof.
// ============================================================

// The leak shapes we flag, per line (already left-trimmed before testing):
//   1. Whole line equals a bare label (optionally wrapped in parens):
//        "Topic Sentence"   "(Topic Sentence)"   "Example"
//   2. Label used as a structural marker prefix: label + ":" possibly with text
//        "Topic Sentence: Saturn return is..."   "Process: first ..."
//        "Example: when transiting ..."
//      An optional markdown bullet / bold wrapper is tolerated before the label
//      so "- **Process:** ..." / "**Example:** ..." also fail.
//   3. The combined "Topic-Process-Example" scaffold name on its own line
//      (with or without a trailing colon / paren wrap).
//
// Only the UNAMBIGUOUS scaffold markers are flagged. Bare "Process:" / "Example:"
// at line-start are common in legitimate prose ("Example: a blue aura shows up
// as calm speech.") so they are deliberately excluded to keep RL9 false-positive
// free; the Topic-Process-Example framework leak is caught by its two canonical
// names below.
const RL9_ATOM_LABELS = Object.freeze([
  'Topic Sentence',
  'Topic-Process-Example',
]);

// Build a per-line regex. Allowed leading wrapper: optional list bullet
// (`-`/`*`/`+` or `N.`) and/or markdown bold `**`. Then the label, then either
// end-of-line (bare label) or a `:` marker. Parenthesised bare label handled
// separately. Anchored to line start to stay a "structural marker", never
// mid-sentence prose.
const RL9_LABEL_ALT = RL9_ATOM_LABELS
  .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
// (a) marker prefix: optional bullet + optional bold, label, then `:`.
const RL9_MARKER_PREFIX_REGEX = new RegExp(
  `^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)?(?:\\*\\*\\s*)?(?:${RL9_LABEL_ALT})(?:\\s*\\*\\*)?\\s*:`,
);
// (b) bare label line (optionally paren-wrapped, optionally bold), nothing else.
const RL9_BARE_LABEL_REGEX = new RegExp(
  `^\\s*(?:\\*\\*\\s*)?\\(?(?:${RL9_LABEL_ALT})\\)?(?:\\s*\\*\\*)?\\s*$`,
);

export function checkRL9(draft) {
  const id = 'rl9_atom_label_leak';
  const body = proseBodyForSci(typeof draft === 'string' ? draft : '');
  const lines = body.split('\n');
  const evidence = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip H1/H2 heading lines — section titles are validated by structureCheck.
    if (/^#{1,6}\s/.test(line.trim())) continue;
    if (RL9_MARKER_PREFIX_REGEX.test(line) || RL9_BARE_LABEL_REGEX.test(line)) {
      evidence.push({ line: i + 1, context: line.trim().slice(0, 160) });
    }
  }
  if (evidence.length > 0) {
    return {
      id,
      pass: false,
      note: `atom-block scaffold label leaked into body (${evidence.length} line(s)): ${evidence.map((e) => `L${e.line} "${e.context.slice(0, 40)}"`).join('; ')}`,
      evidence,
    };
  }
  return { id, pass: true, note: `scanned ${lines.length} body lines, no scaffold-label leaks` };
}

// ============================================================
// RL10 — de-personalization / chat residue (FAIL).
//
// Wiki entries are not chat replies. The templates forbid first-person and
// chatbot framing. A bare second-person "you"/"your" is LEGAL (FAQ voice), so
// we only flag a fixed set of explicit two-person CONVERSATIONAL residue
// phrases that betray a chat turn ("as you said", "you mentioned", "your
// logic", ...). Whole-line scan with line numbers; case-insensitive. Hit =
// FAIL. ZH equivalent lives in red-lines.zh.mjs (checkRL10Zh).
// ============================================================

// Only phrases that unambiguously betray a chat turn. Generic second-person
// hypotheticals ("you might feel", "makes you feel") are LEGITIMATE in astrology
// / self-awareness prose ("During a Saturn return, you might feel pressure...")
// and were removed to avoid FAIL-level false positives — they are not chat
// residue, just direct address, which RL10's own contract permits.
export const RL10_CHAT_RESIDUE_PHRASES = Object.freeze([
  'as you said',
  'like you said',
  'as you mentioned',
  'you mentioned',
  'your logic',
]);
const RL10_PHRASE_PATTERN = RL10_CHAT_RESIDUE_PHRASES
  .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
  .join('|');
export const RL10_CHAT_RESIDUE_REGEX = new RegExp(`\\b(?:${RL10_PHRASE_PATTERN})\\b`, 'i');
const RL10_CHAT_RESIDUE_REGEX_G = new RegExp(`\\b(?:${RL10_PHRASE_PATTERN})\\b`, 'gi');

export function checkRL10(draft) {
  const id = 'rl10_depersonalization';
  const body = proseBodyForSci(typeof draft === 'string' ? draft : '');
  const lines = body.split('\n');
  const evidence = [];
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(RL10_CHAT_RESIDUE_REGEX_G)) {
      evidence.push({ phrase: m[0], line: i + 1, context: lines[i].trim().slice(0, 160) });
    }
  }
  if (evidence.length > 0) {
    return {
      id,
      pass: false,
      note: `chat-residue phrase(s) matched: ${evidence.map((e) => `"${e.phrase}" (L${e.line})`).join(', ')}`,
      evidence,
    };
  }
  return { id, pass: true, note: `scanned ${RL10_CHAT_RESIDUE_PHRASES.length} chat-residue phrases, no hits` };
}

// ============================================================
// RL11 — weak definitional verbs (WARN, NOT fail).
//
// In a definition / claim context, "is about" and "relates to" are vague where
// the template wants a precise mechanism verb. False-positive risk is high
// ("this section is about to ...", "she relates to her sister"), so this is
// WARN ONLY — it never blocks publish, it just surfaces a suggested stronger
// verb. Returned shape carries pass:true plus a `warn:true` flag + violations
// so the dispatcher can print it as a soft note rather than a hard fail.
// ============================================================

export const RL11_WEAK_VERB_PHRASES = Object.freeze(['is about', 'relates to']);
const RL11_SUGGESTED_REPLACEMENTS = 'governs / filters / modulates / correlates with';
const RL11_PATTERN = RL11_WEAK_VERB_PHRASES
  .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
  .join('|');
const RL11_WEAK_VERB_REGEX_G = new RegExp(`\\b(?:${RL11_PATTERN})\\b`, 'gi');

export function checkRL11(draft) {
  const id = 'rl11_weak_verb';
  const body = proseBodyForSci(typeof draft === 'string' ? draft : '');
  const lines = body.split('\n');
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i].trim())) continue; // skip headings
    for (const m of lines[i].matchAll(RL11_WEAK_VERB_REGEX_G)) {
      violations.push({
        phrase: m[0],
        line: i + 1,
        context: lines[i].trim().slice(0, 160),
        hint: `consider a precise mechanism verb (${RL11_SUGGESTED_REPLACEMENTS})`,
      });
    }
  }
  // WARN semantics: pass stays true (never blocks), warn flag set when hits.
  return {
    id,
    pass: true,
    warn: violations.length > 0,
    violations,
    note: violations.length > 0
      ? `weak verb(s) flagged (WARN, non-blocking): ${violations.map((v) => `"${v.phrase}" (L${v.line})`).join(', ')} — suggest ${RL11_SUGGESTED_REPLACEMENTS}`
      : `scanned ${RL11_WEAK_VERB_PHRASES.length} weak-verb phrases, none flagged`,
  };
}

// ============================================================
// RL12 — anti-hallucination citation / external-link guard.
//
// The v9-followup relaxed the blanket "never name anyone" rule to allow naming a
// per-page allowlist of REAL founders (see authority-allowlist.json), and to
// allow EXTERNAL links only as TBD placeholders (never real URLs). RL12 enforces
// the boundary that relaxation must not punch a hole in:
//
//   (a) FAIL — a bare EXTERNAL URL in the body (http(s)://) that is NOT inside a
//       [[<TBD-external-link: ...>]] placeholder, is NOT on the own publish
//       domain (ctx.ownDomains, default astrologywiki.com — the CTA target lives
//       there and legitimately appears verbatim in the Take Action section), and
//       is NOT an explicitly allowed URL (ctx.allowedUrls). The LLM must never
//       INVENT a real off-site URL (hallucinated dead citations); only the
//       human/lookup step resolves a TBD placeholder into a real target.
//   (b) FAIL — a TBD-external-link placeholder whose Wikipedia/source TITLE
//       (middle segment) contains paranormal / pseudoscience / alternative — these
//       Wikipedia disambiguation pages frame the topic as fringe and hurt EEAT.
//   (c) FAIL — hallucinated-citation markers: italic *Title* adjacent to a
//       Capitalized Name, a (year) paren adjacent to an attribution, "et al.", or
//       "<University> study/research".
//   (d) WARN — an attributed "Capitalized First Last" (says/writes/describes/
//       founded/...) that is NOT on this page's author allowlist. WARN only
//       (false-positive risk: ordinary capitalized noun phrases). Requires the
//       page allowlist via ctx.authorityAllowlist; absent → (d) skipped, (a)(b)(c)
//       still run.
//
// Strip frontmatter + fenced code first (proseBodyForSci), same scope as RL8–11.
// ============================================================

// (a) Any external URL, with OR without a scheme — LLMs frequently drop the
// scheme ("en.wikipedia.org/wiki/Chakra", "www.example.com/aura-study"), and the
// "never raw URLs" boundary must hold for those too. Matches: http(s):// URLs,
// www.* hosts, and bare host+path with a known TLD. We then subtract URLs inside
// a TBD placeholder and own-domain/allowed URLs. Bare hosts WITHOUT a path are
// not matched (keeps incidental "example.com" sentence mentions from tripping).
const RL12_URL_REGEX_G =
  /(?:https?:\/\/|www\.)[^\s<>)\]]+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|io|co|uk|us|ai|info|dev)\/[^\s<>)\]]+/gi;
// A TBD external-link placeholder, captured so we can read its title segment.
// Shape: [[<TBD-external-link: <source> | <title> | <reason>>]]
const RL12_TBD_EXTERNAL_REGEX_G =
  /\[\[<TBD-external-link:\s*([^|\]]*?)\s*\|\s*([^|\]]*?)\s*\|\s*([^\]]*?)>\]\]/gi;
// Disallowed Wikipedia disambiguation qualifiers in a TBD title.
const RL12_BAD_TITLE_REGEX = /\((?:paranormal|pseudoscience|alternative)\)/i;
// (c) Hallucinated-citation markers.
//   - italic *Title* near a Capitalized "First Last" name (book-title citation
//     shape: "<Name> in *Title*", "*Title* by <Name>", "<Name>'s *Title*"). The
//     name and the italic span may be separated by a few connective words
//     ("in", "wrote in", etc.), so allow a short gap.
const RL12_ITALIC_NEAR_NAME_REGEX =
  /([A-Z][a-z]+\s+[A-Z][a-z]+(?:'s)?(?:\s+\w+){0,3}\s+\*[^*\n]+\*|\*[^*\n]+\*\s+by\s+[A-Z][a-z]+\s+[A-Z][a-z]+)/;
//   - (1900–2099) paren year next to an attribution verb (either side).
const RL12_YEAR_ATTRIB_REGEX =
  /([A-Z][a-z]+\s+\((?:19|20)\d{2}\)\s*(?:writes?|says?|notes?|describes?|argues?|claims?|found|observed?)|(?:writes?|says?|notes?|describes?|argues?|claims?|according\s+to)[^.\n]{0,40}\((?:19|20)\d{2}\))/i;
//   - "et al."
const RL12_ET_AL_REGEX = /\bet\s+al\.?/i;
//   - "<University/Institute/Lab> study/research" and "a 2015 study"-style.
const RL12_INSTITUTION_STUDY_REGEX =
  /\b([A-Z][A-Za-z]+\s+(?:University|Institute|Laboratory|Lab|College)\s+(?:study|studies|research|researchers?)|(?:a|an|the|one)\s+(?:19|20)\d{2}\s+(?:study|paper|trial|experiment|review))\b/i;
// (d) Attributed "First Last" — a capitalized two-token name in an attribution
// frame. Three high-precision shapes so plain noun phrases ("Blue Aura
// governs...", "Mercury Retrograde's influence", "from New York") do not trip it:
//   1. name + attribution verb            "Jane Doe describes / founded ..."
//   2. name's + authorship noun           "Liz Greene's framework / lineage ..."
//   3. authority connective + name        "according to / descending from Jane Doe"
const RL12_NAME = `[A-Z][a-z]+(?:\\s+[A-Z]\\.)?\\s+[A-Z][a-z]+`;
const RL12_ATTRIBUTED_NAME_REGEXES = [
  new RegExp(`\\b(${RL12_NAME})\\s+(?:says?|writes?|wrote|describes?|argues?|claims?|notes?|founded|established|developed|coined|introduced)\\b`, 'g'),
  new RegExp(`\\b(${RL12_NAME})'s\\s+(?:system|framework|tradition|lineage|method|approach|model|work|teaching|teachings|school)\\b`, 'g'),
  // Connective is capitalization-tolerant (sentence-start "According to ...");
  // the NAME group stays case-sensitive so lowercase words are not read as names.
  new RegExp(`\\b(?:[Aa]ccording\\s+to|[Dd]escending\\s+from|[Bb]uilding\\s+on|[Ff]ounded\\s+by|[Dd]eveloped\\s+by|[Ii]ntroduced\\s+by|[Ii]n\\s+the\\s+tradition\\s+of)\\s+(${RL12_NAME})\\b`, 'g'),
];

export function checkRL12(draft, ctx = {}) {
  const id = 'rl12_citation_hallucination';
  const body = proseBodyForSci(typeof draft === 'string' ? draft : '');
  const lines = body.split('\n');
  const failEvidence = [];
  const warnViolations = [];
  // Known-good URLs the LLM is allowed to render verbatim (the page's own CTA
  // target etc.). Normalize by stripping a trailing slash so trivial variants
  // still match. A bare URL equal to one of these is NOT a hallucination.
  const trimSlash = (u) => String(u).replace(/\/+$/, '');
  const allowedUrls = new Set(
    (Array.isArray(ctx.allowedUrls) ? ctx.allowedUrls : [])
      .map((u) => trimSlash(u).toLowerCase())
      .filter(Boolean),
  );
  // Own publish domain(s) — URLs here are internal/CTA, not external citations.
  const ownDomains = (Array.isArray(ctx.ownDomains) && ctx.ownDomains.length
    ? ctx.ownDomains
    : ['astrologywiki.com']
  ).map((d) => String(d).toLowerCase().replace(/^www\./, ''));
  const isOwnDomain = (url) => {
    // Host extraction tolerant of missing scheme and a www. prefix.
    const m = url.match(/^(?:https?:\/\/)?(?:www\.)?([^/?#\s]+)/i);
    if (!m) return false;
    const host = m[1].toLowerCase().replace(/^www\./, '');
    return ownDomains.some((d) => host === d || host.endsWith(`.${d}`));
  };

  // Precompute the per-line spans covered by TBD external-link placeholders so we
  // can exempt URLs that sit inside them (a TBD placeholder cannot contain a real
  // URL by spec, but exempting defensively keeps (a) free of placeholder text).
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // Collect TBD placeholder spans + check their titles (b).
    const tbdSpans = [];
    for (const m of line.matchAll(RL12_TBD_EXTERNAL_REGEX_G)) {
      tbdSpans.push([m.index, m.index + m[0].length]);
      const title = (m[2] || '').trim();
      if (RL12_BAD_TITLE_REGEX.test(title)) {
        failEvidence.push({
          sub: 'b',
          line: lineNo,
          context: `TBD external-link title flagged as fringe: "${title}"`,
        });
      }
    }
    const inTbd = (idx) => tbdSpans.some(([s, e]) => idx >= s && idx < e);

    // (a) bare external URL not inside a TBD placeholder and not an allowed URL.
    for (const m of line.matchAll(RL12_URL_REGEX_G)) {
      if (inTbd(m.index)) continue;
      // Trailing punctuation (".", ")", ",") is not part of the URL.
      const url = m[0].replace(/[.,;:!?)\]]+$/, '');
      if (allowedUrls.has(trimSlash(url).toLowerCase())) continue;
      if (isOwnDomain(url)) continue; // own-site CTA / internal link — not a citation
      failEvidence.push({ sub: 'a', line: lineNo, context: `bare external URL: ${url.slice(0, 80)}` });
    }

    // (c) hallucinated-citation markers.
    if (RL12_ITALIC_NEAR_NAME_REGEX.test(line)) {
      failEvidence.push({ sub: 'c', line: lineNo, context: `italic-title near name: ${line.trim().slice(0, 80)}` });
    }
    if (RL12_YEAR_ATTRIB_REGEX.test(line)) {
      failEvidence.push({ sub: 'c', line: lineNo, context: `year-attribution: ${line.trim().slice(0, 80)}` });
    }
    if (RL12_ET_AL_REGEX.test(line)) {
      failEvidence.push({ sub: 'c', line: lineNo, context: `"et al." citation: ${line.trim().slice(0, 80)}` });
    }
    if (RL12_INSTITUTION_STUDY_REGEX.test(line)) {
      failEvidence.push({ sub: 'c', line: lineNo, context: `institution/year study: ${line.trim().slice(0, 80)}` });
    }

    // (d) attributed name not on this page's allowlist — WARN. Skip entirely when
    // no allowlist context is supplied (no author → cannot decide off-list).
    if (Array.isArray(ctx.authorityAllowlist)) {
      const allowed = new Set(ctx.authorityAllowlist.map((n) => String(n).toLowerCase().trim()));
      const seen = new Set();
      for (const re of RL12_ATTRIBUTED_NAME_REGEXES) {
        for (const m of line.matchAll(re)) {
          const name = m[1].trim();
          const key = `${name.toLowerCase()}@${lineNo}`;
          if (!allowed.has(name.toLowerCase()) && !seen.has(key)) {
            seen.add(key);
            warnViolations.push({ name, line: lineNo, context: line.trim().slice(0, 120) });
          }
        }
      }
    }
  }

  if (failEvidence.length > 0) {
    return {
      id,
      pass: false,
      warn: warnViolations.length > 0,
      violations: warnViolations,
      note: `citation/external-link violation(s): ${failEvidence.map((e) => `[${e.sub}] L${e.line} ${e.context}`).join('; ')}`,
      evidence: failEvidence,
    };
  }
  if (warnViolations.length > 0) {
    return {
      id,
      pass: true,
      warn: true,
      violations: warnViolations,
      note: `off-allowlist named attribution (WARN, non-blocking): ${warnViolations.map((v) => `"${v.name}" (L${v.line})`).join(', ')} — verify the person is a real founder for this domain or use anonymous attribution`,
    };
  }
  return { id, pass: true, note: `no bare URLs, no fringe-title links, no hallucinated citations${Array.isArray(ctx.authorityAllowlist) ? ', no off-allowlist names' : ''}` };
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
 * @param {string[]} [ctx.authorityAllowlist]  per-page allowed founder names (RL12 sub-d); absent → (d) skipped.
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
    checkRL9(draftMd),
    checkRL10(draftMd),
    checkRL11(draftMd), // WARN-only: pass stays true, never blocks all_pass.
    // RL12 — citation/external-link hallucination guard. (a)(b)(c) FAIL,
    // (d) off-allowlist name WARN. ctx.authorityAllowlist (string[]) gates (d);
    // absent → (d) skipped, (a)(b)(c) still enforced.
    checkRL12(draftMd, ctx),
    // RL13 — SOP §7 banned jargon + AI metaphors. HARD terms FAIL; SOFT terms
    // WARN (pass stays true). "mechanism" intentionally excluded (kept as a
    // structural table/section term). EN-only matching; ZH bodies are unaffected.
    checkRL13(draftMd),
  ];
  const all_pass = rules.every((r) => r.pass);
  return { all_pass, rules };
}

// ============================================================
// RL13 — banned AI-slop jargon + AI metaphors (SOP v4.3 §7).
//
// SOP §7 lists BANNED JARGON + BANNED AI METAPHORS. Split by false-positive risk:
//   HARD (FAIL): terms that never appear in legitimate astrology prose.
//   SOFT (WARN): terms with occasional legitimate use (search ENGINE, jet LAG…).
// "mechanism" and "architecture" are both banned (SOP §7 + blog 创作要求清单 v4.0
// §5.3 list them as AI-slop jargon; the v4.3 audit named "Mechanism" in H2/table
// headers as a defect). The tri-model eval (2026-05-27) reversed the earlier
// "keep mechanism for the table column" decision: the EN templates were reworded
// to "How It Works" so the structural role no longer needs the banned word.
// EN-only: the list is English AI-slop; ZH drafts carry no equivalent vector
// (Chinese 机制 is normal prose, so ZH headings use 运作方式 only for consistency).
// ============================================================
export const RL13_HARD_JARGON = Object.freeze([
  'recursive', 'systemic', 'navigate the landscape', 'delve', 'unlock',
  'high-bandwidth', 'antenna', 'rebooting', 'architecture', 'mechanism',
]);
export const RL13_SOFT_JARGON = Object.freeze(['engine', 'module', 'robust', 'lag']);

const rl13Escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RL13_HARD_REGEX_G = new RegExp(`\\b(?:${RL13_HARD_JARGON.map(rl13Escape).join('|')})\\b`, 'gi');
const RL13_SOFT_REGEX_G = new RegExp(`\\b(?:${RL13_SOFT_JARGON.map(rl13Escape).join('|')})\\b`, 'gi');

export function checkRL13(draft) {
  const id = 'rl13_banned_jargon';
  const body = proseBodyForSci(typeof draft === 'string' ? draft : '');
  const lines = body.split('\n');
  const hard = [];
  const soft = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i].trim())) continue; // skip headings
    for (const m of lines[i].matchAll(RL13_HARD_REGEX_G)) {
      hard.push({ phrase: m[0], line: i + 1, context: lines[i].trim().slice(0, 160), hint: 'SOP §7 banned jargon/metaphor — rewrite in plain language' });
    }
    for (const m of lines[i].matchAll(RL13_SOFT_REGEX_G)) {
      soft.push({ phrase: m[0], line: i + 1, context: lines[i].trim().slice(0, 160), hint: 'SOP §7 listed term — confirm a real domain use, not AI-slop' });
    }
  }
  const violations = [...hard, ...soft];
  if (hard.length > 0) {
    return {
      id,
      pass: false,
      warn: soft.length > 0,
      violations,
      note: `SOP §7 banned jargon (FAIL): ${hard.map((v) => `"${v.phrase}" (L${v.line})`).join(', ')}`,
    };
  }
  if (soft.length > 0) {
    return {
      id,
      pass: true,
      warn: true,
      violations,
      note: `SOP §7 soft jargon (WARN): ${soft.map((v) => `"${v.phrase}" (L${v.line})`).join(', ')}`,
    };
  }
  return {
    id,
    pass: true,
    warn: false,
    violations: [],
    note: `scanned ${RL13_HARD_JARGON.length + RL13_SOFT_JARGON.length} SOP §7 banned terms, none flagged`,
  };
}
