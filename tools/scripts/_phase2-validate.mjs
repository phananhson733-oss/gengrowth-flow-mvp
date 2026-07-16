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
// EN red-line module is site-selected: GG_SITE=gengrowth → B2B profile
// (drops astrology-only RLs, inverts RL8/RL12 for attribution); default/unset →
// the oracle red-lines.mjs, byte-identical behavior. Namespace-import both and
// pick at load so the rest of the file's checkRL* call sites stay unchanged.
import * as oracleRedLines from './lib/red-lines.mjs';
import * as gengrowthRedLines from './lib/red-lines.gengrowth.mjs';
const _EN_RL = process.env.GG_SITE === 'gengrowth' ? gengrowthRedLines : oracleRedLines;
const {
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
  checkRL13,
} = _EN_RL;
import {
  checkBoldedDefinition,
  checkInternalLinkTier,
  checkParagraphLength,
  checkSectionScatter,
  checkLinkDistribution,
  checkFaqSection,
  checkH1ValueProp,
  checkSnippetBullets,
  checkCtaUrl,
  checkSourcesSection,
  checkSourcesNamesInBody,
  checkTableIntegrity,
  checkParagraphFragmentation,
  checkBannedHeadings,
  EN_FAQ_HEADING_RE,
  EN_TABLE_HEADING_RE,
} from './lib/structure-checks.mjs';
// GEO citability advisory (print-only; never gates OVERALL). See header of
// lib/structure-checks.geo.mjs for the advisory-not-gate posture on the oracle path.
import { formatScGeoAdvisory } from './lib/structure-checks.geo.mjs';
import { logFailure } from './lib/_failure-log.mjs';
import { checkAntiHomogenization } from './lib/anti-homogenization.mjs';
import { isValidAuthorId, normalizeAuthorId } from './lib/author-routing.mjs';
import { authorityNamesFor } from './lib/authority-allowlist.mjs';
import { loadPersona } from './lib/author-personas/loader.mjs';
import {
  resolveStructuralProfile,
} from './lib/seo-structural-profile.mjs';
import { normalizeStructuralMarkdown } from './lib/seo-structural-normalizer.mjs';

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

// EN-only (2026-07-03): zh authoring was removed from the pipeline. A zh request
// is a hard error — rejecting loudly beats silently validating a Chinese draft
// against the English contract and shipping garbage.
const langRaw = String(args.language || fixture.language || 'en').toLowerCase();
if (langRaw !== 'en') {
  process.stderr.write(`[phase2] --language ${langRaw} is no longer supported — the pipeline is EN-only (zh removed 2026-07-03)\n`);
  process.exit(2);
}
const language = 'en';
const tier = pick('tier', 'tier', 'T2');

function optionalCliInteger(name) {
  const raw = args[name];
  if (raw === undefined) return undefined;
  if (raw === true || !/^\d+$/.test(String(raw))) {
    throw new TypeError(`--${name.replace(/_/g, '-')} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`--${name.replace(/_/g, '-')} must be a safe integer`);
  }
  return value;
}

let structuralProfile;
try {
  structuralProfile = resolveStructuralProfile({
    site: process.env.GG_SITE || 'astrologywiki',
    locale: language,
    template,
    intent: fixture.intent || '',
    contentTier: tier,
    manifest: fixture,
    overrides: {
      wordMinimum: optionalCliInteger('word_min'),
      wordMaximum: optionalCliInteger('word_max'),
      keywordMinimum: optionalCliInteger('kw_min'),
      keywordMaximum: optionalCliInteger('kw_max'),
      h2Count: optionalCliInteger('expected_h2'),
    },
  });
} catch (err) {
  process.stderr.write(`[phase2] structural profile invalid: ${err.message}\n`);
  process.exit(2);
}
const h2Range = structuralProfile.h2Range;
const effectiveWordRange = structuralProfile.effectiveWordRange;
const keywordRange = structuralProfile.keywordRange;

const ctx = {
  source: req('source'),
  tag: req('tag'),
  page_id: pick('page_id', 'page_id', '__required__'),
  entity: pick('entity', 'entity', '__required__'),
  target_keyword: pick('target_keyword', 'target_keyword', '__required__'),
  associated_keywords: associated,
  template,
  tier,
  cta_target_url: pick('cta_target_url', 'cta_target_url', ''),
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
  structural_profile: structuralProfile,
  h2_range: h2Range,
  word_range_min: effectiveWordRange[0],
  word_range_max: effectiveWordRange[1],
  kw_min: keywordRange[0],
  kw_max: keywordRange[1],
  expected_h1: 1,
  // v4.4: section count is canonical per template (tplDef = 9/11). Prefer the
  // template default over a fixture sidecar so a STALE fixture (e.g. an old
  // `.gg-cache/prompts/*.json` carrying expected_h2: 7) can't silently pin the
  // pre-v4.4 count. Only an explicit CLI --expected-h2 overrides. fixture is the
  // last-resort fallback (covers templates absent from templateDefaults).
  expected_h2: h2Range[0],
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
// SOP §7 anti-homogenization: the set of metaphors / authorities / FAQ topics /
// modulation angles / core analogies sibling pages already used. Sourced from the
// fixture (ops-provided per SOP's optional Cluster_Context variable). Absent →
// the check has no opinion.
ctx.clusterContext = fixture.cluster_context || fixture.clusterContext || undefined;
const outBasename = `${ctx.page_id}-${ctx.tag}`;

// bilingual-v9: EN H2 spec builder (extracted from prior inline structure).
// Literal entity substitution — LLM is expected to keep entity name verbatim
// in EN articles (it's a noun phrase like "Blue Aura" / "Aura Colors").
//
// 2026-06-13 de-templating: the intro / comparison / observation H2s are matched
// by ROLE (matchFn), not by a literal entity-substituted string, so the templates
// can emit grammatical, de-templated headings (Title-Case "What Is …", a real
// comparison naming the adjacent concept, natural "How to Read …") without
// tripping "missing required H2". SC11 (structure-checks.mjs) independently FAILS
// the banned casing/boilerplate forms.
function buildEnH2Specs(ctx) {
  // Role matchers — presence of the section regardless of exact entity wording.
  // Intro: "## What Is/Are …?" (Title Case preferred; legacy "is/are" still
  // matches presence so SC11 owns the casing verdict, not a double "missing H2").
  const introMatch = (d) => /^##\s+What\s+(Is|Are|is|are)\b/m.test(d);
  // Comparison: a real "X vs Y" / "X versus Y" / "How X Differs From Y" heading.
  const comparisonMatch = (d) =>
    /^##\s+[^\n]*\b(vs\.?|versus)\b/im.test(d) || /^##\s+How\s+[^\n]*\bDiffer/i.test(d);
  const introVariants = ctx.template === 'Pillar'
    ? [
        `## What Are ${ctx.entity}?`,
        `## What Are the ${ctx.entity}?`,
        `## What Is ${ctx.entity}?`,
        `## What Is the ${ctx.entity}?`,
      ]
    : [
        `## What Is ${ctx.entity}?`,
        `## What Is the ${ctx.entity}?`,
        `## What Is a ${ctx.entity}?`,
        `## What Is an ${ctx.entity}?`,
        `## What Are ${ctx.entity}?`,
      ];
  return ctx.template === 'Pillar'
    ? [
        { variants: introVariants, matchFn: introMatch, label: '## What Are/Is <entity>? (定义 section; Title Case)' },
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
        // v4.5.1 Phase C — FAQ heading may vary per entity (role token required).
        { variants: ['## Frequently Asked Questions'], matchFn: (d) => EN_FAQ_HEADING_RE.test(d), label: '## <entity> Questions / FAQ (varied; needs a questions/FAQ/ask token)' },
        { variants: ['## Reflection Prompts'], label: '## Reflection Prompts' },
        { variants: ['## Related Reading'], label: '## Related Reading' },
        { variants: ['## Take Action'], label: '## Take Action' },
        { variants: ['## Sources'], label: '## Sources' },
      ]
    : [
        { variants: introVariants, matchFn: introMatch, label: '## What Is <entity>? (定义 section; Title Case)' },
        { variants: ['## Why It Matters for Self-Awareness'], label: '## Why It Matters for Self-Awareness' },
        {
          // De-templated: a real comparison heading naming the adjacent concept
          // ("X vs Y" / "How X Differs From Y"), NOT the banned "vs Adjacent
          // Concepts" boilerplate (which SC11 fails outright).
          variants: [
            `## ${ctx.entity} vs `,
          ],
          matchFn: comparisonMatch,
          label: '## <entity> vs <real adjacent concept> (comparison section; no "Adjacent Concepts" boilerplate)',
        },
        {
          variants: [
            `## How to Read ${ctx.entity} in Yourself`,
            `## How to Read ${ctx.entity} in Your Aura`,
            `## How to Read ${ctx.entity} in Your Chart`,
            `## How to Read ${ctx.entity} in Your Timing`,
          ],
          matchFn: (d) => /^##\s+How to (Read|Spot|Recognize|Work With)\b/m.test(d),
          label: `## How to Read ${ctx.entity} in Yourself`,
        },
        { variants: ['## Common Misreadings', '## Common Misreads', '## Common Misreads + Framework Limits'], matchFn: (d) => /^##\s+Common Misread/m.test(d), label: '## Common Misreadings' },
        // v4.5.1 Phase C — heading variation (去模板感): the table + FAQ headings
        // may vary per entity as long as they carry a stable ROLE token, so the
        // library doesn't read as N identical "Quick Reference Table" / "Frequently
        // Asked Questions" rows. SC10 verifies the table by shape, and the oracle
        // FAQPage JSON-LD detector matches the same role tokens.
        { variants: ['## Quick Reference Table'], matchFn: (d) => EN_TABLE_HEADING_RE.test(d), label: '## <entity> at a Glance / Quick Reference (varied; needs a table/reference/glance token)' },
        { variants: ['## Frequently Asked Questions'], matchFn: (d) => EN_FAQ_HEADING_RE.test(d), label: '## <entity> Questions / FAQ (varied; needs a questions/FAQ/ask token)' },
        { variants: ['## Reflection Prompts'], label: '## Reflection Prompts' },
        { variants: ['## Related Reading'], label: '## Related Reading' },
        { variants: ['## Take Action'], label: '## Take Action' },
        { variants: ['## Sources'], label: '## Sources' },
      ];
}

// gengrowth (B2B SEO+GEO) EN H2 spec builder — matches guide.prompt.md's 11
// sections by ROLE (matchFn), since the LLM varies exact wording. EN-only
// (gengrowth is EN-first). No astrology titles. Same spec shape as buildEnH2Specs;
// only loaded when GG_SITE=gengrowth, so the oracle path is untouched.
function buildGengrowthH2Specs(ctx) {
  const e = ctx.entity;
  return [
    {
      variants: [`## What Is ${e}?`, `## What Is a ${e}?`, `## What Is an ${e}?`, `## What Are ${e}?`],
      matchFn: (d) => /^##\s+What\s+(Is|Are)\b/m.test(d),
      label: '## What Is <entity>? (definition section)',
    },
    { variants: ['## Why It Matters'], matchFn: (d) => /^##\s+Why It Matters\b/m.test(d), label: '## Why It Matters for Your Workflow' },
    {
      variants: ['## How '],
      matchFn: (d) => /^##\s+How\b[^\n]*\b(Real|Agenc|SaaS|Scenario|Rollout|Practice|Works?|Reaches?|Plays?|Deliver|Client|Looks?|Happens?|Flows?|Fits?|Shows?)\b/im.test(d),
      label: '## How <entity> Works / Plays Out in Real Agency-SaaS Scenarios',
    },
    { variants: ['## Common '], matchFn: (d) => /^##\s+Common\b[^\n]*\bMisread/im.test(d), label: '## Common Implementation Misreadings' },
    {
      variants: ['at a Glance', 'Quick Reference'],
      matchFn: (d) => /^##\s+[^\n]*\b(at[- ]a[- ]Glance|Quick Reference|Quick Guide|Decision (Grid|Table)|Comparison Table)\b/im.test(d),
      label: '## <entity> at a Glance / Quick Reference (decision table)',
    },
    { variants: ['## How to Evaluate', '## How to Choose'], matchFn: (d) => /^##\s+How to (Evaluate|Choose|Assess|Compare|Pick|Select|Vet|Decide)\b/im.test(d), label: '## How to Evaluate <entity>' },
    {
      variants: ['Step by Step'],
      matchFn: (d) => /^##\s+How to (Implement|Roll Out|Set Up|Deploy|Get Started|Build|Launch|Adopt|Run)\b/im.test(d) || /^##\s+[^\n]*\bStep by Step\b/im.test(d),
      label: '## How to Implement <entity> Step by Step',
    },
    { variants: ['## Frequently Asked Questions', '## Common Questions'], matchFn: (d) => EN_FAQ_HEADING_RE.test(d), label: '## Common Questions About <entity> (FAQ; needs questions/FAQ/ask token)' },
    { variants: ['## Related Reading'], label: '## Related Reading' },
    { variants: ['## Take Action'], label: '## Take Action' },
    { variants: ['## Sources'], label: '## Sources' },
  ];
}

function structureCheck(draft) {
  const findings = [];
  const h1Count = (draft.match(/^# /gm) || []).length;
  const h2Count = (draft.match(/^## /gm) || []).length;
  const h3Count = (draft.match(/^### /gm) || []).length;
  const h4Count = (draft.match(/^#### /gm) || []).length;
  if (h1Count !== ctx.expected_h1) findings.push(`H1 count = ${h1Count}, expected ${ctx.expected_h1}`);
  if (h2Count < ctx.h2_range[0] || h2Count > ctx.h2_range[1]) {
    const expected = ctx.h2_range[0] === ctx.h2_range[1]
      ? String(ctx.h2_range[0])
      : `${ctx.h2_range[0]}-${ctx.h2_range[1]}`;
    findings.push(`H2 count = ${h2Count}, expected ${expected}`);
  }
  // H3 allowed both sites (user 2026-06-22: "需要有 H3，如果有必要的话"); SC3C
  // (structure-checks) governs subsection quality / wall-of-text. H4 stays banned (too deep).
  if (h4Count > ctx.structural_profile.maxH4) {
    findings.push(`H4 count = ${h4Count}, expected ${ctx.structural_profile.maxH4}`);
  }

  const words = draft.trim().split(/\s+/).filter(Boolean).length;
  // Under-min is a hard FAIL (thin content must not ship). Over-max is a soft
  // WARN (long-form is acceptable) — surfaced in the warnings block below so it
  // never flips `ok`. (2026-05-27, per word-count pilot: prompt aim raised to
  // 1800 to clear the 1500 floor, so habitual over-1800 must not block.)
  if (words < ctx.word_range_min) findings.push(`word count ${words} < min ${ctx.word_range_min}`);

  // Required H2 list is template-aware (Definition leaf vs Pillar hub).
  const requiredH2Specs = process.env.GG_SITE === 'gengrowth'
    ? buildGengrowthH2Specs(ctx)
    : buildEnH2Specs(ctx);

  for (const spec of requiredH2Specs) {
    // spec.matchFn (if present) is a regex-aware matcher; fall back to
    // substring variants for everything else.
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
  // Tier-agnostic safety net for UNKNOWN tiers only — SC2 (tier-aware FAIL) owns
  // the T1/T2/T3 ladder, so this no longer mis-fires on a legitimate T3=1 page.
  const knownTier = ['T1', 'T2', 'T3'].includes(String(ctx.tier || '').toUpperCase());
  if (!knownTier && internalTbd.length < 2) {
    findings.push(`internal wikilink count ${internalTbd.length} < 2 (unknown tier; SC2 tier ladder not applicable)`);
  }

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

  // SC1 — bolded direct-answer definition in first H2 section (FAIL;
  // both templates hard-require it).
  const boldDef = checkBoldedDefinition(draft);
  if (!boldDef.pass) {
    findings.push(`SC1 bolded definition: ${boldDef.note}`);
  }

  // SC3 — atomic paragraph length (FAIL, both langs; 清单 §3 段落 ≤ 4 行).
  // A wall-of-text prose paragraph blocks AI Overview extraction + hurts
  // readability, so over-length is a hard fail. Each over-long paragraph is
  // surfaced with its line + size so the rewrite is targeted.
  const paraLen = checkParagraphLength(draft);
  if (!paraLen.pass) {
    findings.push(`SC3 paragraph length: ${paraLen.note}`);
    paraLen.violations.forEach((v) => findings.push(`  L${v.line}: ${v.hint}`));
  }

  // SC3c — section scatter (FAIL, both langs; v4.5.1 — 一个 H2 下不得散成 4+ 短段).
  // The reading unit is the H2 section: one coherent paragraph, or 引子 + 编号列表.
  const scatter = checkSectionScatter(draft);
  if (!scatter.pass) {
    findings.push(`SC3c section scatter: ${scatter.note}`);
    scatter.violations.forEach((v) => findings.push(`  L${v.line}: ${v.hint}`));
  }

  // SC4 — internal-link distribution (FAIL, both langs; 清单 §2 首链优先权).
  // Links must be woven into the body, not all dumped in Related Reading.
  const linkDist = checkLinkDistribution(draft);
  if (!linkDist.pass) {
    findings.push(`SC4 link distribution: ${linkDist.note}`);
    linkDist.violations.forEach((v) => findings.push(`  L${v.line}: ${v.hint}`));
  }

  // SC5 — FAQ section present with >= 3 PAA Q&A (FAIL, both langs; v4.4 schema).
  const faq = checkFaqSection(draft);
  if (!faq.pass) {
    findings.push(`SC5 FAQ section: ${faq.note}`);
    faq.violations.forEach((v) => findings.push(`  L${v.line}: ${v.hint}`));
  }

  // SC8 — Take Action / CTA section: real link + matches cta_target_url + no
  // banned anchor text (FAIL, both langs; v4.4 #6).
  const ctaUrl = checkCtaUrl(draft, { cta_target_url: ctx.cta_target_url });
  if (!ctaUrl.pass) {
    findings.push(`SC8 CTA link: ${ctaUrl.note}`);
    ctaUrl.violations.forEach((v) => findings.push(`  L${v.line}: ${v.hint}`));
  }

  // SC9 — controlled Sources section present with >= 1 entry (FAIL; v4.4 schema).
  const sources = checkSourcesSection(draft);
  if (!sources.pass) {
    findings.push(`SC9 Sources section: ${sources.note}`);
    sources.violations.forEach((v) => findings.push(`  L${v.line}: ${v.hint}`));
  }

  // SC10 — Decision-Value / Quick-Reference table shape ≥4 cols × ≥3 rows
  // (FAIL; v4.4 #3 — guards the audit-named table 崩盘点 + SOP §5 / 清单 §3).
  // Definition + Pillar mandate a quick-reference table (section 6); Tutorial does
  // not. required=true makes SC10 fail on a missing table instead of delegating
  // absence to the (now role-token, false-positive-prone) H2 spec.
  const table = checkTableIntegrity(draft, { required: ctx.template === 'Definition' || ctx.template === 'Pillar' });
  if (!table.pass) {
    findings.push(`SC10 table integrity: ${table.note}`);
    table.violations.forEach((v) => findings.push(`  L${v.line}: ${v.hint}`));
  }

  // SC2 — internal-link tier ladder (FAIL; v4.4 #5 — SOP §3 / 清单 §2 T1=5/T2=3/T3=1-2).
  const linkTier = checkInternalLinkTier(draft, { tier: ctx.tier });
  if (!linkTier.pass) {
    findings.push(`SC2 internal-link tier: ${linkTier.note}`);
    linkTier.violations.forEach((v) => findings.push(`  L${v.line}: ${v.hint}`));
  }

  // SC7 — snippet bullets after the bolded definition (FAIL; v4.4 #8 — 审计 #4 致命).
  const bullets = checkSnippetBullets(draft);
  if (!bullets.pass) {
    findings.push(`SC7 snippet bullets: ${bullets.note}`);
    bullets.violations.forEach((v) => findings.push(`  L${v.line}: ${v.hint}`));
  }

  // SC11 — banned templated heading patterns (FAIL, EN only; 2026-06-13 SEO audit).
  // "vs Adjacent Concepts" boilerplate + broken-casing "What is <lowercase>" /
  // "How to Read <lowercase>" headings signal AI mass-production and hurt indexing.
  const bannedHeadings = checkBannedHeadings(draft);
  if (!bannedHeadings.pass) {
    findings.push(`SC11 banned headings: ${bannedHeadings.note}`);
    bannedHeadings.violations.forEach((v) => findings.push(`  L${v.line}: ${v.hint}`));
  }

  // ---- WARN-only checks (surfaced separately so they never flip `ok`) ----
  const warnings = [];

  // Soft word-count ceiling: over word_range_max is informational only.
  if (words > ctx.word_range_max) {
    warnings.push(`word count ${words} > max ${ctx.word_range_max} (soft ceiling — long-form OK, not blocking)`);
  }

  // SC6 — H1 value proposition (WARN, both langs; 清单 §1 / 审计 4.2).
  const h1Value = checkH1ValueProp(draft, { target_keyword: ctx.target_keyword });
  if (!h1Value.pass) {
    warnings.push(`SC6 H1 value-prop: ${h1Value.note}`);
  }

  // SC9b — Sources entries should appear in the body (WARN; v4.4 #9 — FP-safe).
  const srcNames = checkSourcesNamesInBody(draft);
  if (!srcNames.pass) {
    warnings.push(`SC9b sources named in body: ${srcNames.note}`);
    srcNames.violations.forEach((v) => warnings.push(`  L${v.line}: ${v.hint}`));
  }

  // SC3b — over-fragmentation (WARN; paragraphs should be 4-5 句 idea units).
  const fragmentation = checkParagraphFragmentation(draft);
  if (!fragmentation.pass) {
    warnings.push(`SC3b paragraph fragmentation: ${fragmentation.note}`);
    fragmentation.violations.forEach((v) => warnings.push(`  ${v.hint}`));
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
const normalization = normalizeStructuralMarkdown(rawSource, structuralProfile);
if (normalization.changes.length > 0) {
  if (normalization.protectedDigestBefore !== normalization.protectedDigestAfter) {
    throw new Error('protected digest mismatch; refusing normalized phase2 source');
  }
  writeFileSync(ctx.source, normalization.markdown);
}
// Strip YAML frontmatter if present. Fresh LLM output has none; re-runs on
// published files carry an auto-added frontmatter listing target_keyword +
// associated_keywords which would otherwise double-count and falsely fail RL5.
const draft = normalization.markdown.startsWith('---\n')
  ? normalization.markdown.replace(/^---\n[\s\S]*?\n---\n+/, '')
  : normalization.markdown;
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

const rlChecks = [
  ['RL1 (clinical claims)', () => checkRL1(draft)],
  ['RL2 (competitor smear)', () => checkRL2(draft)],
  ['RL3 (SERP plagiarism)', () => checkRL3(draft, serpCtx)],
  ['RL4 (keyword anchored)', () => checkRL4(draft, { targetKeyword: ctx.target_keyword, entity: ctx.entity })],
  ['RL5 (keyword stuffing)', () => checkRL5(draft, { targetKeyword: ctx.target_keyword, maxCount: ctx.kw_max })],
  // targetKeyword lets RL6 exempt a blacklist word that IS the SEO keyword
  // (e.g. "Healing Your Inner Wound" → "healing"); other clinical-overreach
  // words still fail.
  ['RL6 (psych safety)', () => checkRL6(draft, { effectivePsychSafety: ctx.psych_safety_flag, targetKeyword: ctx.target_keyword })],
  // RL7 — per-author black words; empty token list → N/A pass.
  ['RL7 (author banned tokens)', () => checkRL7(draft, { authorBannedTokens: ctx.authorBannedTokens, targetKeyword: ctx.target_keyword })],
  // RL8 — shared scientific-endorsement red line (all authors).
  ['RL8 (scientific endorsement)', () => checkRL8(draft)],
  // RL9 — atom-block scaffold-label leak (FAIL).
  ['RL9 (atom-label leak)', () => checkRL9(draft)],
  // RL10 — de-personalization / chat residue (FAIL).
  ['RL10 (depersonalization)', () => checkRL10(draft)],
  // RL11 — weak definitional verbs (WARN only; pass stays true, never blocks).
  ['RL11 (weak verb)', () => checkRL11(draft)],
  // RL12 — citation/external-link hallucination guard. (a) bare URL / (b) fringe
  // Wikipedia title / (c) hallucinated citation markers → FAIL; (d) off-allowlist
  // named attribution → WARN.
  ['RL12 (citation/external-link)', () => checkRL12(draft, { authorityAllowlist: ctx.authorityAllowlist })],
  // RL13 — SOP §7 banned jargon + AI metaphors. HARD terms FAIL; SOFT terms WARN.
  ['RL13 (banned jargon)', () => checkRL13(draft)],
  // Anti-homogenization — SOP §7 batch uniqueness (WARN). Conditional on a
  // fixture-provided cluster_context; no opinion when absent. Both languages.
  ['Anti-homogenization (SOP §7)', () => checkAntiHomogenization(draft, ctx.clusterContext)],
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

// ---- GEO citability advisory (non-gating; never flips OVERALL) ----
// PRINT-ONLY: surfaces the AI-search citability score + weakest levers so the
// author can add a verifiable factual anchor (astronomy/history/survey — see the
// "GEO 事实锚点杠杆" block in the prompt templates). It is deliberately NOT added
// to struct.findings / struct.warnings / manifest and NEVER touches `pass`, so
// the oracle pass/fail contract stays byte-identical. try/catch guarantees an
// advisory bug can only print a WARN, never block phase2. Runs for all sites.
console.log('\n▸ GEO citability (advisory)');
try {
  console.log(`  ⓘ ${formatScGeoAdvisory(draft)}`);
} catch (e) {
  console.log(`  ⚠ advisory skipped: ${e.message}`);
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
slug: ${ctx.target_keyword.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}
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

mkdirSync(STAGING_DIR, { recursive: true });
const outMdPath = join(STAGING_DIR, `${outBasename}.md`);
const outManifestPath = join(STAGING_DIR, `${outBasename}.manifest.json`);

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
