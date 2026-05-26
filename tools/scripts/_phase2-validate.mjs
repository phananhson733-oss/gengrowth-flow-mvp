// Generalized Phase 2 validation + publish script. Reusable per entity.
// Bypasses Sheet integration (Sheet row may not be filled). Runs binary checks
// via lib/red-lines.mjs + structure check. If all pass → writes _staging/{base}.md
// with frontmatter + manifest.json.
//
// Usage (modern, with fixture sidecar from renderer):
//   node tools/scripts/_phase2-validate.mjs \
//     --source <path-to-llm-output.md> \
//     --tag <suffix> \
//     --page-id <page_X> \
//     [--llm-source "gpt-5.2"] [--prompt-version v8]
//   # Auto-loads .gg-cache/prompts/<page_X>.<prompt_version>-fixture.json
//   # CLI flags below override fixture values.
//
// Usage (legacy, every value via CLI flag):
//   node tools/scripts/_phase2-validate.mjs \
//     --source <path-to-llm-output.md> --tag <suffix> --page-id <page_X> \
//     --entity "Display Name" --target-keyword "keyword phrase" \
//     [--associated-keywords "k1, k2, k3"] \
//     [--template Definition] [--tier T2] \
//     [--word-min 1500] [--word-max 1800] \
//     [--kw-min 5] [--kw-max 8] [--expected-h2 7] \
//     [--psych-safety N] [--llm-source "..."] [--prompt-version v8]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  checkRL1,
  checkRL2,
  checkRL3,
  checkRL4,
  checkRL5,
  checkRL6,
  checkRL7,
  checkRL8,
  checkRL9,
  checkRL10,
  checkRL11,
  checkRL12,
} from './lib/red-lines.mjs';
import {
  checkRL1Zh,
  checkRL2Zh,
  checkRL6Zh,
  checkRL7Zh,
  checkRL8Zh,
  checkRL10Zh,
} from './lib/red-lines.zh.mjs';
import {
  checkBoldedDefinition,
  checkInternalLinkTier,
} from './lib/structure-checks.mjs';
import { logFailure } from './lib/_failure-log.mjs';
import { isValidAuthorId, normalizeAuthorId } from './lib/author-routing.mjs';
import { authorityNamesFor } from './lib/authority-allowlist.mjs';
import { loadPersona } from './lib/author-personas/loader.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const STAGING_DIR = join(REPO, '_staging');
const SERP_DIR = join(REPO, '.gg-cache', 'serp');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  process.stdout.write(`_phase2-validate.mjs — generalized Phase 2 binary validator

Runs structure check + RL1-RL6 (clinical / competitor / plagiarism / anchor / stuffing / psych)
against an LLM-generated article. PASS → writes manifest.json next to source. FAIL → no manifest
(downstream publish skips).

Usage (modern, with fixture sidecar from renderer):
  node tools/scripts/_phase2-validate.mjs \\
    --source <path-to-llm-output.md> \\
    --tag <suffix> \\
    --page-id <page_X> \\
    [--llm-source "claude-opus-4-7"] [--prompt-version v8]
  # Auto-loads .gg-cache/prompts/<page_X>.<prompt_version>-fixture.json
  # CLI flags below override fixture values.

Usage (legacy, every value via CLI flag):
  node tools/scripts/_phase2-validate.mjs \\
    --source <path-to-llm-output.md> --tag <suffix> --page-id <page_X> \\
    --entity "Display Name" --target-keyword "keyword phrase" \\
    [--associated-keywords "k1, k2, k3"] \\
    [--template Definition] [--tier T2] \\
    [--word-min 1500] [--word-max 1800] \\
    [--kw-min 5] [--kw-max 8] [--expected-h2 7] \\
    [--psych-safety N] [--llm-source "..."] [--prompt-version v8]

Flags:
  --source <path>           required — LLM output .md
  --tag <str>               required — output suffix tag (e.g. claude-v8)
  --page-id <page_X>        required — page identifier (matches PAGE_ID_REGEX)
  --fixture <path>          override auto-load fixture path
  --allow-missing-serp      RL3 plagiarism skips when SERP cache missing
  --help, -h                show this message
`);
  process.exit(0);
}

function req(name) {
  if (!args[name]) {
    process.stderr.write(`[phase2] missing --${name.replace(/_/g, '-')}\n`);
    process.exit(2);
  }
  return args[name];
}

// Auto-load fixture sidecar written by renderer (carries entity / target_keyword /
// associated_keywords / template / tier / ranges / expected_h2 / psych_safety).
// Resolution: explicit --fixture wins; else if --page-id provided, try
// .gg-cache/prompts/<page_id>.<prompt_version>-fixture.json. Missing fixture is
// non-fatal — operator can still pass every value via CLI flags (legacy path).
const promptVersion = args.prompt_version || 'v8';
let fixture = {};
let fixturePath = args.fixture;
if (!fixturePath && args.page_id) {
  const candidate = join(REPO, '.gg-cache', 'prompts', `${args.page_id}.${promptVersion}-fixture.json`);
  if (existsSync(candidate)) fixturePath = candidate;
}
if (fixturePath) {
  try {
    fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    process.stderr.write(`[phase2] loaded fixture: ${fixturePath}\n`);
  } catch (err) {
    process.stderr.write(`[phase2] fixture load failed: ${err.message}\n`);
    process.exit(2);
  }
}

function pick(cliKey, fixtureKey, fallback) {
  if (args[cliKey] !== undefined && args[cliKey] !== true) return args[cliKey];
  if (fixture[fixtureKey] !== undefined) return fixture[fixtureKey];
  if (fallback === '__required__') {
    process.stderr.write(`[phase2] missing --${cliKey.replace(/_/g, '-')} (also absent from fixture)\n`);
    process.exit(2);
  }
  return fallback;
}

const assocRaw = args.associated_keywords;
const associated = assocRaw
  ? assocRaw.split(',').map((s) => s.trim()).filter(Boolean)
  : (Array.isArray(fixture.associated_keywords) ? fixture.associated_keywords : []);

const templateRaw = pick('template', 'template', 'Definition');
// Normalize case: accept "Definition" / "definition" / "Pillar" / "pillar".
const template = /^pillar$/i.test(templateRaw) ? 'Pillar' : 'Definition';

// bilingual-v9: ZH defaults use Chinese character counts (≈ 1.4x EN word
// counts) since Chinese has no whitespace word boundaries. wordCount() below
// branches on language to count correctly.
const templateDefaults = {
  en: {
    Definition: { word_range: [1500, 1800], kw_count_range: [5, 8], expected_h2: 7 },
    Pillar: { word_range: [2500, 3500], kw_count_range: [8, 12], expected_h2: 9 },
  },
  zh: {
    // ZH word_range tuned 2026-05-25 from first opus 4.7 demo run: actual
    // production output landed at 1590 chars; Chinese expression is denser
    // than English so 1500-2000 chars ≈ EN 1500-1800 words in info density.
    Definition: { word_range: [1500, 2000], kw_count_range: [5, 8], expected_h2: 7 },
    Pillar: { word_range: [3000, 4000], kw_count_range: [8, 12], expected_h2: 9 },
  },
};
const langRaw = (args.language || fixture.language || 'en').toLowerCase();
const language = langRaw === 'zh' ? 'zh' : 'en';
const tplDef = templateDefaults[language][template];

const wordRange = fixture.word_range || tplDef.word_range;
const kwRange = fixture.kw_count_range || tplDef.kw_count_range;

const ctx = {
  source: req('source'),
  tag: req('tag'),
  page_id: pick('page_id', 'page_id', '__required__'),
  entity: pick('entity', 'entity', '__required__'),
  target_keyword: pick('target_keyword', 'target_keyword', '__required__'),
  associated_keywords: associated,
  template,
  tier: pick('tier', 'tier', 'T2'),
  track: '量产线',
  page_role: template === 'Pillar' ? 'Hub' : 'Support',
  // RL6 strict mode (codex review): empty / null / unknown must default to 'N',
  // not pass through as wiring-bug fail. Canonical values are 'Y' | 'N'.
  psych_safety_flag: (() => {
    const raw = pick('psych_safety', 'psych_safety', 'N');
    const s = String(raw || '').trim().toUpperCase();
    return (s === 'Y' || s === 'N') ? s : 'N';
  })(),
  llm_source: args.llm_source || 'unknown',
  prompt_version: promptVersion,
  language,
  word_range_min: Number.parseInt(args.word_min, 10) || wordRange[0],
  word_range_max: Number.parseInt(args.word_max, 10) || wordRange[1],
  kw_min: Number.parseInt(args.kw_min, 10) || kwRange[0],
  kw_max: Number.parseInt(args.kw_max, 10) || kwRange[1],
  expected_h1: 1,
  expected_h2: Number.parseInt(args.expected_h2, 10) || fixture.expected_h2 || tplDef.expected_h2,
  // RL7: per-author black words. Source priority: CLI --banned_tokens (comma
  // list) > fixture.banned_tokens (compiled by Lane A content-draft from the
  // chosen author persona capsule). Empty/absent → RL7 N/A (author has no list).
  authorBannedTokens: (() => {
    const cli = (typeof args.banned_tokens === 'string' && args.banned_tokens !== 'true')
      ? args.banned_tokens.split(',').map((s) => s.trim()).filter(Boolean)
      : null;
    if (cli && cli.length) return cli;
    return Array.isArray(fixture.banned_tokens)
      ? fixture.banned_tokens.map((s) => String(s).trim()).filter(Boolean)
      : [];
  })(),
  // Author byline (T10 / C2): the persona id whose byline publishes to the oracle.
  // Source priority: CLI --author > fixture.author_id. Display name comes from the
  // persona card. Absent/invalid → null → no byline emitted (oracle falls back to
  // the house team). This is the publish-frontmatter writer for the batch path, the
  // counterpart to content-draft's buildAuthorFrontmatter on the human-in-loop path.
  author: (() => {
    const raw = (typeof args.author === 'string' && args.author !== 'true')
      ? args.author
      : (fixture.author_id || '');
    const id = String(raw || '').replace(/^["']|["']$/g, '').trim();
    if (!id || !isValidAuthorId(id)) return null;
    const norm = normalizeAuthorId(id);
    try {
      const p = loadPersona(norm);
      return { id: norm, displayName: p.displayName };
    } catch {
      return null;
    }
  })(),
};
// RL12 sub-(d): the per-page authority allowlist (real founders this domain may
// name). Resolved from the same author_id as the byline. No author → leave
// undefined so RL12 skips (d) entirely (no context to decide off-list); (a)(b)(c)
// still run. An authored page passes the array (possibly empty if the domain has
// no curated founders), enabling the off-allowlist WARN.
ctx.authorityAllowlist = ctx.author ? authorityNamesFor(ctx.author.id) : undefined;
const outBasename = `${ctx.page_id}-${ctx.tag}`;

// bilingual-v9: EN H2 spec builder (extracted from prior inline structure).
// Literal entity substitution — LLM is expected to keep entity name verbatim
// in EN articles (it's a noun phrase like "Blue Aura" / "Aura Colors").
function buildEnH2Specs(ctx) {
  const introVariants = ctx.template === 'Pillar'
    ? [
        `## What are ${ctx.entity}?`,
        `## What are the ${ctx.entity}?`,
        `## What is ${ctx.entity}?`,
        `## What is the ${ctx.entity}?`,
      ]
    : [
        `## What is ${ctx.entity}?`,
        `## What is the ${ctx.entity}?`,
        `## What is a ${ctx.entity}?`,
        `## What is an ${ctx.entity}?`,
        `## What are ${ctx.entity}?`,
      ];
  return ctx.template === 'Pillar'
    ? [
        { variants: introVariants, label: introVariants[0] },
        { variants: ['## Why It Matters for Self-Awareness'], label: '## Why It Matters for Self-Awareness' },
        {
          variants: [
            `## ${ctx.entity} at a Glance`,
            `## The ${ctx.entity} at a Glance`,
          ],
          label: `## The ${ctx.entity} at a Glance`,
        },
        { variants: [': Quick Guide'], label: '<...>: Quick Guide' },
        { variants: ['## How Shade and Combination Shift Readings'], label: '## How Shade and Combination Shift Readings' },
        { variants: ['## Common Misreads + Framework Limits'], label: '## Common Misreads + Framework Limits' },
        { variants: ['## Reflection Prompts'], label: '## Reflection Prompts' },
        { variants: ['## Related Reading'], label: '## Related Reading' },
        { variants: ['## Take Action'], label: '## Take Action' },
      ]
    : [
        { variants: introVariants, label: introVariants[0] },
        { variants: ['## Why It Matters for Self-Awareness'], label: '## Why It Matters for Self-Awareness' },
        {
          variants: [
            `## ${ctx.entity} vs Adjacent Concepts: Mechanism + Trade-offs`,
            `## The ${ctx.entity} vs Adjacent Concepts: Mechanism + Trade-offs`,
          ],
          label: `## ${ctx.entity} vs Adjacent Concepts: Mechanism + Trade-offs`,
        },
        { variants: ['## Quick Reference Table'], label: '## Quick Reference Table' },
        { variants: ['## Reflection Prompts'], label: '## Reflection Prompts' },
        { variants: ['## Related Reading'], label: '## Related Reading' },
        { variants: ['## Take Action'], label: '## Take Action' },
      ];
}

// bilingual-v9: ZH H2 spec builder. ZH templates require LLM to translate
// {{entity}} → native Chinese, so we can't substitute the EN entity literally.
// Instead match by stable Chinese suffix (e.g. `是什么？` / `速查表` /
// `自我觉察小提示`) — the LLM is constrained to those exact section titles
// (definition.prompt.zh.md `## 输出结构` section).
//
// Question mark is full-width `？` per ZH typographic convention; we also accept
// half-width `?` since LLM mixing is common.
function buildZhH2Specs(ctx) {
  const introQuestionMark = ['？', '?'];
  const introVariants = introQuestionMark.flatMap((q) => [
    `## ${ctx.entity} 是什么${q}`,           // EN entity kept (fallback)
    `## ${ctx.entity}（${ctx.entity}） 是什么${q}`, // hybrid (we discourage but accept)
  ]);
  // For ZH, also match any line that ends with `是什么？` or `是什么?` since the
  // LLM may translate the entity to a native Chinese name.
  const introSuffixMatch = (draft) => {
    const re = /^## [^\n]+?\s*是什么[？?]/m;
    return re.test(draft);
  };
  return ctx.template === 'Pillar'
    ? [
        { variants: introVariants, label: `## <entity 中文译名> 是什么？`, matchFn: introSuffixMatch },
        { variants: ['## 为什么先理解整个家族再看单一颜色', '## 为什么先理解整个家族'], label: '## 为什么先理解整个家族' },
        { variants: ['一览表'], label: '## <entity> 一览表 (substring `一览表`)' },
        { variants: ['：速览', ': 速览', '速览'], label: '## <count> 个 <entity>：速览' },
        { variants: ['## 色调浓淡与组合如何改变解读'], label: '## 色调浓淡与组合如何改变解读' },
        { variants: ['## 常见误读 + 框架边界', '## 常见误读+框架边界'], label: '## 常见误读 + 框架边界' },
        { variants: ['## 自我觉察小提示'], label: '## 自我觉察小提示' },
        { variants: ['## 延伸阅读'], label: '## 延伸阅读' },
        { variants: ['## 下一步行动'], label: '## 下一步行动' },
      ]
    : [
        { variants: introVariants, label: `## <entity 中文译名> 是什么？`, matchFn: introSuffixMatch },
        { variants: ['## 为什么了解它能帮助自我觉察'], label: '## 为什么了解它能帮助自我觉察' },
        { variants: ['与相近概念'], label: '## <entity> 与相近概念：机制 + 取舍 (substring `与相近概念`)' },
        { variants: ['速查表'], label: '## <entity> 速查表 (substring `速查表`)' },
        { variants: ['## 自我觉察小提示'], label: '## 自我觉察小提示' },
        { variants: ['## 延伸阅读'], label: '## 延伸阅读' },
        { variants: ['## 下一步行动'], label: '## 下一步行动' },
      ];
}

function structureCheck(draft) {
  const findings = [];
  const h1Count = (draft.match(/^# /gm) || []).length;
  const h2Count = (draft.match(/^## /gm) || []).length;
  const h3Count = (draft.match(/^### /gm) || []).length;
  const h4Count = (draft.match(/^#### /gm) || []).length;
  if (h1Count !== ctx.expected_h1) findings.push(`H1 count = ${h1Count}, expected ${ctx.expected_h1}`);
  if (h2Count !== ctx.expected_h2) findings.push(`H2 count = ${h2Count}, expected ${ctx.expected_h2}`);
  if (h3Count !== 0) findings.push(`H3 count = ${h3Count}, expected 0`);
  if (h4Count !== 0) findings.push(`H4 count = ${h4Count}, expected 0`);

  // bilingual-v9: word count branches on language. EN uses whitespace word
  // count; ZH counts CJK characters + latin words + digit groups (close to
  // "tokens" for a Chinese reader). Without this, ZH drafts get ~1 word from
  // split(/\s+/) and always fail the lower bound.
  let words;
  if (ctx.language === 'zh') {
    const cjk = draft.match(/[一-鿿]/g) || [];
    const latin = draft.match(/[A-Za-z]+/g) || [];
    const digits = draft.match(/[0-9]+/g) || [];
    words = cjk.length + latin.length + digits.length;
  } else {
    words = draft.trim().split(/\s+/).filter(Boolean).length;
  }
  if (words < ctx.word_range_min) findings.push(`word count ${words} < min ${ctx.word_range_min}`);
  if (words > ctx.word_range_max) findings.push(`word count ${words} > max ${ctx.word_range_max}`);

  // Required H2 list is template-aware (Definition leaf vs Pillar hub) AND
  // language-aware (EN literal-match vs ZH substring-match — ZH entity may be
  // translated by LLM so we match by stable Chinese suffix instead of literal
  // {{entity}} substitution).
  const requiredH2Specs = ctx.language === 'zh'
    ? buildZhH2Specs(ctx)
    : buildEnH2Specs(ctx);

  for (const spec of requiredH2Specs) {
    // bilingual-v9: spec.matchFn (if present) is a regex-aware matcher used
    // for the ZH intro H2 where the entity may be translated by the LLM. If
    // present, prefer it; fall back to substring variants for everything else.
    const found = (typeof spec.matchFn === 'function' && spec.matchFn(draft))
      || spec.variants.some((v) => draft.includes(v));
    if (!found) findings.push(`missing required H2: "${spec.label}"`);
  }

  // Both TBD shapes are valid: internal-link (SEO mesh) and external-link
  // (T2 authority placeholder, added with the founders-allowlist relaxation).
  // Only internal links count toward the internal-link floor; external authority
  // placeholders must not be rejected as "malformed".
  const wikilinks = draft.match(/\[\[[^\]]+\]\]/g) || [];
  const internalTbd = wikilinks.filter((l) => /^\[\[<TBD-internal-link: /.test(l));
  const externalTbd = wikilinks.filter((l) => /^\[\[<TBD-external-link: /.test(l));
  const tbdLinks = [...internalTbd, ...externalTbd];
  if (wikilinks.length !== tbdLinks.length) {
    findings.push(`${wikilinks.length - tbdLinks.length} wikilink(s) not in TBD format`);
  }
  if (internalTbd.length < 2) findings.push(`Related Reading has only ${internalTbd.length} internal wikilink(s), recommend ≥3`);

  // Anti-fluff: no preamble between H1 and first H2.
  const lines = draft.split('\n');
  let inPreambleZone = false;
  for (const line of lines) {
    if (/^# /.test(line)) { inPreambleZone = true; continue; }
    if (inPreambleZone) {
      if (/^## /.test(line)) break;
      if (line.trim() !== '' && !line.startsWith('#')) {
        findings.push(`preamble paragraph found between H1 and H2 #1: "${line.slice(0, 60)}…"`);
        break;
      }
    }
  }

  // Trailing chatbot meta scan.
  const tail = draft.slice(-500);
  if (/(would you like|let me know|i can also|do you want to|happy to help)/i.test(tail)) {
    findings.push('trailing chatbot meta detected in last 500 chars');
  }

  // SC1 — bolded direct-answer definition in first H2 section (FAIL, both langs;
  // both templates hard-require it). EN entity is literal; ZH translates the
  // entity but still mandates the bolded definition (definition.prompt.zh.md).
  const boldDef = checkBoldedDefinition(draft);
  if (!boldDef.pass) {
    findings.push(`SC1 bolded definition: ${boldDef.note}`);
  }

  // SC2 — internal-link tier counting (WARN only; never blocks publish).
  // Surfaced as a separate `warnings` list so it does not flip `ok`.
  const warnings = [];
  const linkTier = checkInternalLinkTier(draft, { tier: ctx.tier });
  if (!linkTier.pass) {
    warnings.push(`SC2 internal-link tier: ${linkTier.note}`);
  }

  return {
    ok: findings.length === 0,
    findings,
    warnings,
    stats: { h1Count, h2Count, h3Count, h4Count, words, wikilinks: wikilinks.length, tbdLinks: tbdLinks.length },
  };
}

// ---------- main ----------

console.log('━'.repeat(60));
console.log(`Phase 2 validation: ${ctx.page_id} (${ctx.entity})`);
console.log(`Source: ${ctx.source}`);
console.log(`LLM: ${ctx.llm_source} / prompt: ${ctx.prompt_version}`);
console.log('━'.repeat(60));

const rawSource = readFileSync(ctx.source, 'utf8');
// Strip YAML frontmatter if present. Fresh LLM output has none; re-runs on
// published files carry an auto-added frontmatter listing target_keyword +
// associated_keywords which would otherwise double-count and falsely fail RL5.
const draft = rawSource.startsWith('---\n')
  ? rawSource.replace(/^---\n[\s\S]*?\n---\n+/, '')
  : rawSource;
if (!draft.match(/^#\s+.+$/m)) {
  console.error('ERROR: draft has no H1; aborting');
  process.exit(1);
}

const results = {};
let pass = true;

console.log('\n▸ Structure check');
const struct = structureCheck(draft);
results.structure = struct;
if (struct.ok) {
  console.log(`  ✓ PASS  H1=${struct.stats.h1Count} H2=${struct.stats.h2Count} H3=${struct.stats.h3Count} words=${struct.stats.words} wikilinks=${struct.stats.wikilinks} (all TBD)`);
} else {
  pass = false;
  console.log('  ✗ FAIL');
  struct.findings.forEach((f) => console.log(`    - ${f}`));
}
// SC2 + other WARN-level structure notes — non-blocking (never flips pass).
(struct.warnings || []).forEach((w) => console.log(`  ⚠ WARN  ${w}`));

// SERP cache load
const serpPath = join(SERP_DIR, `${ctx.page_id}.json`);
let serpCtx;
try {
  const raw = JSON.parse(readFileSync(serpPath, 'utf8'));
  const snips = Array.isArray(raw.snippets) ? raw.snippets.filter((s) => typeof s === 'string' && s.length > 0) : [];
  serpCtx = snips.length > 0
    ? { serpState: 'hit', snippets: snips, escapeReason: null }
    : { serpState: 'missing-skipped', snippets: [], escapeReason: 'cache present but empty' };
} catch {
  serpCtx = { serpState: 'missing-skipped', snippets: [], escapeReason: 'no cache' };
}

// bilingual-v9: ZH dispatcher for RL1/RL2/RL6. RL3 (SERP plagiarism) shares
// EN algorithm (n-gram overlap is language-agnostic). RL4 (anchored) and
// RL5 (stuffing) resolve the primary Chinese long-tail keyword via 3-step
// priority: CLI --zh-keyword > fixture.target_keyword_zh > derive from H1
// (split on full/half-width colon, take the head segment).
//
// Falls back to the EN target_keyword if no ZH keyword resolves at all,
// which lets RL5 still count occurrences (will warn density low; that's the
// already-known v9-full follow-up).
function deriveZhKeywordFromDraft(s) {
  const m = s.match(/^#\s+([^\n]+?)\s*$/m);
  if (!m) return null;
  const h1 = m[1].trim();
  // Split on full-width or half-width colon — H1 convention is
  // "<主中文长尾词>：<副标题>" per definition.prompt.zh.md examples
  const head = h1.split(/[：:]/, 1)[0].trim();
  // Sanity: must contain CJK chars; if not, the H1 was EN — bail out.
  if (!/[一-鿿]/.test(head)) return null;
  return head;
}

const isZh = ctx.language === 'zh';
let zhKeyword = null;
if (isZh) {
  if (args.zh_keyword && args.zh_keyword !== true) zhKeyword = String(args.zh_keyword);
  else if (fixture.target_keyword_zh) zhKeyword = String(fixture.target_keyword_zh);
  else zhKeyword = deriveZhKeywordFromDraft(draft);
  if (zhKeyword) {
    console.log(`[zh-keyword] resolved: "${zhKeyword}" (source: ${args.zh_keyword ? 'CLI' : fixture.target_keyword_zh ? 'fixture' : 'H1-derive'})`);
  } else {
    console.log(`[zh-keyword] could not resolve — RL4/RL5 will fall back to EN target_keyword "${ctx.target_keyword}" (low density warning expected)`);
  }
}
const rl4Keyword = isZh ? (zhKeyword || ctx.target_keyword) : ctx.target_keyword;
const rl5Keyword = isZh ? (zhKeyword || ctx.target_keyword) : ctx.target_keyword;

const rlChecks = [
  ['RL1 (clinical claims)', () => isZh ? checkRL1Zh(draft) : checkRL1(draft)],
  ['RL2 (competitor smear)', () => isZh ? checkRL2Zh(draft) : checkRL2(draft)],
  ['RL3 (SERP plagiarism)', () => checkRL3(draft, serpCtx)],
  ['RL4 (keyword anchored)', () => checkRL4(draft, { targetKeyword: rl4Keyword, entity: ctx.entity })],
  ['RL5 (keyword stuffing)', () => checkRL5(draft, { targetKeyword: rl5Keyword, maxCount: ctx.kw_max })],
  ['RL6 (psych safety)', () => isZh
    ? checkRL6Zh(draft, { effectivePsychSafety: ctx.psych_safety_flag })
    : checkRL6(draft, { effectivePsychSafety: ctx.psych_safety_flag })],
  // RL7 — per-author black words. ZH uses checkRL7Zh (CJK substring + ASCII
  // word-boundary); empty token list → N/A pass in either language.
  ['RL7 (author banned tokens)', () => isZh
    ? checkRL7Zh(draft, { authorBannedTokens: ctx.authorBannedTokens, targetKeyword: ctx.target_keyword })
    : checkRL7(draft, { authorBannedTokens: ctx.authorBannedTokens, targetKeyword: ctx.target_keyword })],
  // RL8 — shared scientific-endorsement red line (all authors, both languages).
  ['RL8 (scientific endorsement)', () => isZh ? checkRL8Zh(draft) : checkRL8(draft)],
  // RL9 — atom-block scaffold-label leak (FAIL). EN-only: the label vocabulary
  // (Topic Sentence / Process / Example) is English scaffolding; ZH drafts use a
  // translated structure with no equivalent leak vector, so skip when isZh.
  ...(isZh ? [] : [['RL9 (atom-label leak)', () => checkRL9(draft)]]),
  // RL10 — de-personalization / chat residue (FAIL, both languages).
  ['RL10 (depersonalization)', () => isZh ? checkRL10Zh(draft) : checkRL10(draft)],
  // RL11 — weak definitional verbs (WARN only; pass stays true, never blocks).
  // EN-only ("is about" / "relates to" are English constructions).
  ...(isZh ? [] : [['RL11 (weak verb)', () => checkRL11(draft)]]),
  // RL12 — citation/external-link hallucination guard. (a) bare URL / (b) fringe
  // Wikipedia title / (c) hallucinated citation markers → FAIL; (d) off-allowlist
  // named attribution → WARN. Runs both languages: (a)(b) are language-agnostic;
  // (c)(d) only match Latin-script citation/name shapes so ZH bodies are unaffected.
  ['RL12 (citation/external-link)', () => checkRL12(draft, { authorityAllowlist: ctx.authorityAllowlist })],
];

const WAIVERS = new Set(); // No waivers — B'.3 SERP cache now live.

for (const [name, fn] of rlChecks) {
  console.log(`\n▸ ${name}`);
  try {
    const r = fn();
    results[name] = r;
    if (r.pass === true) {
      // WARN-level checks (e.g. RL11) pass:true but carry warn:true — surface
      // them with a ⚠ marker so they are visible without blocking publish.
      if (r.warn === true) {
        console.log(`  ⚠ WARN  ${r.note || ''}`);
      } else {
        console.log(`  ✓ PASS  ${r.note || ''}`);
      }
    } else {
      const rlKey = name.split(' ')[0];
      if (WAIVERS.has(rlKey)) {
        results[name].waived = true;
        console.log(`  ⚠ WAIVED (${rlKey}) — ${r.note || ''}`);
      } else {
        pass = false;
        console.log(`  ✗ FAIL  ${r.note || JSON.stringify(r)}`);
      }
    }
  } catch (e) {
    pass = false;
    console.log(`  ✗ ERROR: ${e.message}`);
    results[name] = { pass: false, error: e.message };
  }
}

console.log('\n' + '━'.repeat(60));
if (!pass) {
  console.log('OVERALL: FAIL — not writing to _staging');
  // Append a row to `failure-log` sheet tab for retro 聚类 ("80% fail = RL4...")
  // Best-effort: never blocks exit; OAuth/network failure is silently skipped.
  const failedChecks = Object.entries(results)
    .filter(([, r]) => !r.pass && !r.waived)
    .map(([name]) => name.split(' ')[0]);
  const failReasons = Object.entries(results)
    .filter(([, r]) => !r.pass && !r.waived)
    .map(([name, r]) => `${name.split(' ')[0]}: ${r.note || r.error || JSON.stringify(r).slice(0, 80)}`)
    .join(' | ');
  await logFailure({
    stage: 'phase2',
    tool: '_phase2-validate',
    page_id: ctx.page_id || '',
    llm: ctx.llm_source || '',
    tag: args.tag || '',
    failed_checks: failedChecks,
    fail_reason: failReasons,
    notes: `tier=${ctx.tier || ''} template=${ctx.template || ''} prompt_version=${ctx.prompt_version || ''}`,
  });
  process.exit(11);
}
console.log('OVERALL: PASS — writing to _staging');

// ---------- write publish-ready file ----------

const sha = createHash('sha256').update(draft).digest('hex').slice(0, 16);
const generatedAt = new Date().toISOString();

const titleCased = ctx.target_keyword
  .split(/\s+/)
  .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
  .join(' ');
// Byline lines (C2): emit author_id so the oracle converter resolves the persona
// byline instead of the house team. JSON.stringify keeps the value YAML-safe and
// matches the quote-tolerant read in gg-md-to-oracle-ts.resolveAuthorMeta.
const authorLines = ctx.author
  ? `author_id: ${JSON.stringify(ctx.author.id)}\nauthor_display_name: ${JSON.stringify(ctx.author.displayName)}\n`
  : '';
const frontmatter = `---
title: ${titleCased}
slug: ${ctx.target_keyword.replace(/\s+/g, '-')}
date: ${generatedAt.slice(0, 10)}
status: ready-to-review
type: wiki-entry
template: ${ctx.template}
tier: ${ctx.tier}
track: ${ctx.track}
page_id: ${ctx.page_id}
${authorLines}target_keyword: ${ctx.target_keyword}
associated_keywords:
${ctx.associated_keywords.map((k) => `  - ${k}`).join('\n')}
generated_by: ${ctx.llm_source}
prompt_version: ${ctx.prompt_version}
generated_at: ${generatedAt}
content_sha256_short: ${sha}
phase2_checks: all-pass
---

`;

// bilingual-v9: ZH-language pass outputs go to _staging/zh-demo/ to match
// orchestrator --out-dir convention and what gg-md-to-oracle-ts.mjs --language
// zh reads. EN unchanged at _staging/.
const stagingDirEffective = isZh ? join(STAGING_DIR, 'zh-demo') : STAGING_DIR;
mkdirSync(stagingDirEffective, { recursive: true });
const outMdPath = join(stagingDirEffective, `${outBasename}.md`);
const outManifestPath = join(stagingDirEffective, `${outBasename}.manifest.json`);

writeFileSync(outMdPath, frontmatter + draft);
console.log(`\n  ✓ wrote ${outMdPath} (${(frontmatter + draft).length} bytes)`);

const manifest = {
  schema_version: '1',
  page_id: ctx.page_id,
  entity: ctx.entity,
  target_keyword: ctx.target_keyword,
  template: ctx.template,
  tier: ctx.tier,
  track: ctx.track,
  generated_by: ctx.llm_source,
  prompt_version: ctx.prompt_version,
  generated_at: generatedAt,
  content_sha256_short: sha,
  source_path: ctx.source,
  staging_path: outMdPath,
  phase2_checks: {
    overall: 'pass',
    structure: struct.stats,
    rl1: results['RL1 (clinical claims)']?.pass ?? false,
    rl2: results['RL2 (competitor smear)']?.pass ?? false,
    rl3: results['RL3 (SERP plagiarism)']?.pass ?? false,
    rl4: results['RL4 (keyword anchored)']?.pass ?? false,
    rl5: results['RL5 (keyword stuffing)']?.pass ?? false,
    rl6: results['RL6 (psych safety)']?.pass ?? false,
  },
};
writeFileSync(outManifestPath, JSON.stringify(manifest, null, 2));
console.log(`  ✓ wrote ${outManifestPath}`);
console.log('\n' + '━'.repeat(60));
console.log('DONE');
