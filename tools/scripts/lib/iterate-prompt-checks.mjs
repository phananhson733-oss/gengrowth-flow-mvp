#!/usr/bin/env node
// iterate-prompt-checks.mjs — deterministic binary structural checks for one LLM output.
//
// Pure function: input draft markdown + spec object, output
//   { all_pass: bool, checks: [{ id, pass, expected, actual, note? }, ...] }
//
// Source of truth: tools/scripts/lib/content-draft-templates/definition.prompt.md
//
// Spec defaults match Definition × T2 template:
//   - 1 H1, 7 H2, 0 H3, 0 H4
//   - word_range: [1500, 1800]
//   - kw_count_range: [5, 8]
//   - reflection prompts: exactly 3, each ≤ 25 words
//   - quick ref table: ≥ 4 columns × ≥ 3 rows
//   - all wikilinks: literal [[<TBD-internal-link: ...>]]
//   - no trailing meta after CTA URL
//   - first sentence starts with `<entity> is`
//
// Pure Node — no deps. Mirrors red-lines.mjs structure.

// ============================================================
// Constants
// ============================================================

const TRAILING_META_REGEX =
  /\b(would you like|let me know|i can also|do you want|happy to|feel free to|if you'd like|if you want)\b/i;

const TRAILING_META_SCAN_CHARS = 300;

const AI_TELL_WORDS = Object.freeze([
  'delve', 'crucial', 'pivotal', 'paramount', 'navigate the',
  "it's important to note", 'in conclusion', 'in summary',
  'unleash', 'unlock the', 'tapestry', 'realm', 'embark',
]);

// ============================================================
// Helpers
// ============================================================

function countHeading(md, level) {
  const re = new RegExp(`^${'#'.repeat(level)}\\s+`, 'gm');
  return (md.match(re) || []).length;
}

function wordCount(md) {
  return md.split(/\s+/).filter(Boolean).length;
}

function getH2Sections(md) {
  const lines = md.split('\n');
  const sections = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (current) sections.push(current);
      current = { heading: m[1], body: '' };
    } else if (current) {
      current.body += line + '\n';
    }
  }
  if (current) sections.push(current);
  return sections;
}

function findSection(sections, regex) {
  return sections.find((s) => regex.test(s.heading));
}

function firstSentenceAfterH1(md) {
  // Skip H1 line, then take first non-empty non-heading paragraph and grab first sentence.
  const lines = md.split('\n');
  let i = 0;
  // skip until past H1
  while (i < lines.length && !/^#\s+/.test(lines[i])) i++;
  i++;
  // skip blanks and headings until first prose line
  while (i < lines.length) {
    const l = lines[i].trim();
    if (l && !/^#{1,6}\s+/.test(l)) break;
    i++;
  }
  if (i >= lines.length) return '';
  const para = lines[i].trim();
  // first sentence = up to first period followed by space/EOL
  const m = para.match(/^[^.!?]+[.!?]/);
  return m ? m[0].trim() : para.slice(0, 200);
}

// ============================================================
// Individual checks
// ============================================================

export function checkH1Count(md, spec) {
  const expected = spec.h1_count ?? 1;
  const actual = countHeading(md, 1);
  return {
    id: 'h1_count',
    pass: actual === expected,
    expected,
    actual,
  };
}

export function checkH2Count(md, spec) {
  const expected = spec.h2_count ?? 7;
  const actual = countHeading(md, 2);
  return {
    id: 'h2_count',
    pass: actual === expected,
    expected,
    actual,
  };
}

export function checkH3H4Forbidden(md) {
  const h3 = countHeading(md, 3);
  const h4 = countHeading(md, 4);
  return {
    id: 'h3_h4_forbidden',
    pass: h3 === 0 && h4 === 0,
    expected: '0 H3, 0 H4',
    actual: `${h3} H3, ${h4} H4`,
  };
}

export function checkWordCount(md, spec) {
  const [lo, hi] = spec.word_range || [1500, 1800];
  const actual = wordCount(md);
  return {
    id: 'word_count',
    pass: actual >= lo && actual <= hi + 200, // tolerant on upper
    expected: `${lo}-${hi}`,
    actual,
    note: actual < lo ? 'below floor' : actual > hi ? 'above ceiling (tolerant +200)' : 'in range',
  };
}

export function checkKeywordCount(md, spec) {
  const target = (spec.target_keyword || '').trim();
  if (!target) {
    return { id: 'keyword_count', pass: true, expected: 'n/a', actual: 0, note: 'no target_keyword in spec' };
  }
  const [lo, hi] = spec.kw_count_range || [5, 8];
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'gi');
  const actual = (md.match(re) || []).length;
  return {
    id: 'keyword_count',
    pass: actual >= lo && actual <= hi,
    expected: `${lo}-${hi}`,
    actual,
    note: actual > hi ? 'over upper bound — RL5 risk' : actual < lo ? 'below floor — SEO underweight' : 'in range',
  };
}

export function checkWikilinkFormat(md) {
  // Any `[[...]]` that does NOT follow the literal `[[<TBD-internal-link: ` format is a fail.
  const allWikilinks = md.match(/\[\[[^\]]+\]\]/g) || [];
  const bad = allWikilinks.filter((w) => !/^\[\[<TBD-internal-link:\s.+>\]\]$/.test(w));
  return {
    id: 'wikilink_format',
    pass: allWikilinks.length === 0 || bad.length === 0,
    expected: 'all wikilinks use [[<TBD-internal-link: ...>]] format',
    actual: `${allWikilinks.length} total, ${bad.length} malformed`,
    note: bad.length > 0 ? `bad: ${bad.slice(0, 3).join(' | ')}` : undefined,
  };
}

export function checkReflectionPrompts(md, spec) {
  const sections = getH2Sections(md);
  const reflect = findSection(sections, /reflection\s+prompts?/i);
  if (!reflect) {
    return {
      id: 'reflection_prompts',
      pass: false,
      expected: 'exactly 3 prompts, each ≤ 25 words',
      actual: 'no Reflection Prompts section found',
    };
  }
  // Count numbered / bulleted lines OR sentence-ish lines.
  const lines = reflect.body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(?:\d+[.)]|[-*+])\s+/.test(l));
  const expectedCount = spec.reflection_count ?? 3;
  const maxWords = spec.reflection_max_words ?? 25;
  const tooLong = lines.filter((l) => wordCount(l) > maxWords);
  const countPass = lines.length === expectedCount;
  const lengthPass = tooLong.length === 0;
  return {
    id: 'reflection_prompts',
    pass: countPass && lengthPass,
    expected: `${expectedCount} prompts × ≤ ${maxWords} words`,
    actual: `${lines.length} prompts, ${tooLong.length} over word limit`,
    note: tooLong.length > 0 ? `over-limit: ${tooLong.map((l) => `(${wordCount(l)}w)`).join(' ')}` : undefined,
  };
}

export function checkQuickRefTable(md) {
  const sections = getH2Sections(md);
  const ref = findSection(sections, /quick\s+reference\s+table/i);
  if (!ref) {
    return {
      id: 'quick_ref_table',
      pass: false,
      expected: '≥ 4 columns × ≥ 3 data rows',
      actual: 'no Quick Reference Table section found',
    };
  }
  const tableLines = ref.body.split('\n').filter((l) => /\|/.test(l) && (l.match(/\|/g) || []).length >= 3);
  if (tableLines.length === 0) {
    return { id: 'quick_ref_table', pass: false, expected: '≥ 4 cols × ≥ 3 rows', actual: 'no table found' };
  }
  // First row = header, second = separator, rest = data.
  const cols = (tableLines[0].match(/\|/g) || []).length - 1; // pipes - 1 ≈ columns
  const dataRows = tableLines.length - 2; // minus header + separator
  const pass = cols >= 4 && dataRows >= 3;
  return {
    id: 'quick_ref_table',
    pass,
    expected: '≥ 4 cols × ≥ 3 rows',
    actual: `${cols} cols × ${dataRows} data rows`,
  };
}

export function checkTrailingMeta(md) {
  const tail = md.slice(-TRAILING_META_SCAN_CHARS);
  const m = tail.match(TRAILING_META_REGEX);
  return {
    id: 'no_trailing_meta',
    pass: !m,
    expected: 'no chatbot follow-up after CTA',
    actual: m ? `matched "${m[0]}"` : 'clean',
  };
}

export function checkFirstSentenceSubject(md, spec) {
  const entity = (spec.entity || '').trim();
  if (!entity) {
    return { id: 'first_sentence_subject', pass: true, expected: 'n/a', actual: 'no entity in spec' };
  }
  const first = firstSentenceAfterH1(md);
  // Must start with entity (case-insensitive) and include " is "
  const re = new RegExp(`^${entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+is\\b`, 'i');
  return {
    id: 'first_sentence_subject',
    pass: re.test(first),
    expected: `"${entity} is ..."`,
    actual: first.slice(0, 120),
  };
}

export function checkAITells(md) {
  const lower = md.toLowerCase();
  const hits = AI_TELL_WORDS.filter((w) => lower.includes(w));
  return {
    id: 'ai_tells_lite',
    pass: hits.length === 0,
    expected: 'no obvious AI-tell vocabulary',
    actual: hits.length === 0 ? 'clean' : `hits: ${hits.join(', ')}`,
    note: 'lite scan only — full quality audit is in subagent step',
  };
}

// ============================================================
// Top-level orchestrator
// ============================================================

/**
 * @param {string} draftMd
 * @param {object} spec  { entity, target_keyword, h1_count, h2_count, word_range, kw_count_range,
 *                         reflection_count, reflection_max_words }
 */
export function runStructuralChecks(draftMd, spec = {}) {
  const checks = [
    checkH1Count(draftMd, spec),
    checkH2Count(draftMd, spec),
    checkH3H4Forbidden(draftMd),
    checkWordCount(draftMd, spec),
    checkKeywordCount(draftMd, spec),
    checkWikilinkFormat(draftMd),
    checkReflectionPrompts(draftMd, spec),
    checkQuickRefTable(draftMd),
    checkTrailingMeta(draftMd),
    checkFirstSentenceSubject(draftMd, spec),
    checkAITells(draftMd),
  ];
  return {
    all_pass: checks.every((c) => c.pass),
    checks,
  };
}

// ============================================================
// CLI entry: `node iterate-prompt-checks.mjs <file.md> [--spec key=val ...]`
// Prints JSON for easy parsing by the skill.
// ============================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function parseCliArgs(argv) {
  const file = argv[2];
  const spec = {};
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, ...rest] = a.slice(2).split('=');
      const v = rest.join('=');
      if (k === 'word_range' || k === 'kw_count_range') {
        spec[k] = v.split(',').map(Number);
      } else if (k === 'h1_count' || k === 'h2_count' || k === 'reflection_count' || k === 'reflection_max_words') {
        spec[k] = Number(v);
      } else {
        spec[k] = v;
      }
    }
  }
  return { file, spec };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { file, spec } = parseCliArgs(process.argv);
  if (!file) {
    console.error('usage: iterate-prompt-checks.mjs <file.md> [--entity=...] [--target_keyword=...] [--word_range=1500,1800] [--kw_count_range=5,8] [--h2_count=7]');
    process.exit(2);
  }
  const md = readFileSync(file, 'utf8');
  const result = runStructuralChecks(md, spec);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.all_pass ? 0 : 1);
}
