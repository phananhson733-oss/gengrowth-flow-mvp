#!/usr/bin/env node
// gg-brief-init.mjs — scaffold a brief override entry for a new page_id.
//
// Pairs with step 1 of docs/PIPELINE.md. Writes a JSON file with the 13 cfg
// fields renderAuraPrompt needs, populating page_id/entity/tier/template/
// CTA defaults automatically and leaving 6 fields as `TODO: <hint>` for the
// user to fill in. Those 6 are the ones that actually need editorial input —
// cluster_jtbd / content_angle / internal_link_rule / tier_gate_block /
// rl6_hint / friction_themes — and can't be machine-derived.
//
// Usage:
//   node tools/scripts/gg-brief-init.mjs \
//     --page-id page_orange_aura_meaning \
//     --entity "Orange Aura" \
//     --tier T2 --template Definition
//
//   node tools/scripts/gg-brief-init.mjs \
//     --page-id page_chakra_system_overview \
//     --entity "Chakra System" \
//     --tier T1 --template Pillar \
//     --child-entities "root chakra,sacral chakra,solar plexus chakra,heart chakra,throat chakra,third eye chakra,crown chakra"
//
// Writes:
//   .gg-cache/overrides/<page_id>.json
//
// Then: open that file, replace every `TODO: ...` string with real content,
// proceed to PIPELINE.md step 2.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');

const DEFAULT_CTA_TEXT = 'Take the 60-second Aura Reading Quiz to see how your colors map';
const DEFAULT_CTA_URL = 'https://astrologywiki.com/tools/aura-reading-quiz';

export function parseArgs(argv) {
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

// Derive target_keyword from entity name (heuristic, user can override).
// "Orange Aura" → "orange aura meaning" for T2 Definition
// "Chakra System" → "chakra system" for T1 Pillar (broader keyword)
export function deriveTargetKeyword(entity, template) {
  const lc = entity.toLowerCase();
  if (template === 'Pillar') return lc;
  return /\b(meaning|guide|framework|system)\b/.test(lc) ? lc : `${lc} meaning`;
}

// Derive associated_keywords seed (3 variants — user edits).
export function deriveAssociatedKeywords(entity) {
  const lc = entity.toLowerCase();
  return [
    lc,
    `${lc} personality`,
    `what does ${lc} mean`,
  ];
}

// Render the TODO scaffold for a single brief entry.
export function renderScaffold({ pageId, entity, tier, template, childEntities }) {
  const targetKeyword = deriveTargetKeyword(entity, template);
  const associatedKeywords = deriveAssociatedKeywords(entity);
  const isPillar = template === 'Pillar';
  const wordRange = isPillar ? '2500-3500' : '1500-1800';
  const sectionCount = isPillar ? '9 sections' : '7 sections';

  const entry = {
    _ai_draft: true,
    _review_status: 'needs_human_review_before_publish',
    page_id: pageId,
    entity,
    target_keyword: targetKeyword,
    associated_keywords: associatedKeywords,
    search_volume: 'TODO: monthly search volume (e.g. "8100"); pull from Ahrefs / GSC',
    cluster_jtbd: `TODO: 1-2 sentence JTBD — what does the reader actually want when searching "${targetKeyword}"? Include the core friction (what they keep failing to find) and what a satisfying answer looks like.`,
    content_angle: `TODO: framing for the article — what's the through-line that distinguishes this page from existing top-10 results? Include: (1) interpretive-framework framing (not measurable physics), (2) shade-/variant-awareness if applicable, (3) explicit disclaimer about scope.`,
    internal_link_rule: `TODO: which other ${isPillar ? 'sibling Definition pages + sub-clusters' : 'pillar + sibling Definition pages + chakra/element reference'} should this article link out to. Use natural noun phrases (used inside [[<TBD-internal-link: ...>]]).`,
    cta_text: DEFAULT_CTA_TEXT,
    cta_target_url: DEFAULT_CTA_URL,
    tier_gate_block: `## Tier Gate（${tier} ${template}）\n\n- 必读 Friction（col J）: TODO — 3 个用户搜 "${targetKeyword}" 时常见的状态/痛点，每个 1 句话\n- 必读 Logic（col K）: TODO — 主流 source 怎么写这个 entity，shade/variant 分别什么含义，为什么这是 interpretive framework 不是 measurable phenomenon\n- ${tier} = ${isPillar ? 'Hub' : '标准版'} — 字数 ${wordRange}，结构严格按 ${sectionCount}`,
    rl6_hint: `TODO: 1-2 sentence reminder of what NOT to write — common framing mistakes specific to this entity (e.g. "don't reduce X to a clinical diagnosis" / "don't pathologize Y / don't write it as personality verdict").`,
    friction_themes: [
      {
        theme: 'TODO: theme_1_snake_case (e.g. shade_confusion)',
        scrubbed_quote: 'TODO: scrubbed Reddit-style quote capturing the friction in 1-2 sentences — what does a user say when they hit this wall?',
        source_id: 'reddit#1',
        domain: 'old.reddit.com',
        mention_count: 8,
      },
      {
        theme: 'TODO: theme_2_snake_case',
        scrubbed_quote: 'TODO: scrubbed quote #2',
        source_id: 'reddit#2',
        domain: 'old.reddit.com',
        mention_count: 6,
      },
      {
        theme: 'TODO: theme_3_snake_case',
        scrubbed_quote: 'TODO: scrubbed quote #3',
        source_id: 'reddit#3',
        domain: 'old.reddit.com',
        mention_count: 5,
      },
    ],
    tier,
    template,
  };

  if (isPillar && childEntities && childEntities.length) {
    entry.child_entities = childEntities;
    entry.child_count = childEntities.length;
  }

  return entry;
}

async function main(argv) {
  const args = parseArgs(argv);

  if (args.help || args.h) {
    process.stdout.write(`gg-brief-init — scaffold a brief override entry

usage:
  node tools/scripts/gg-brief-init.mjs --page-id <id> --entity "<X>" [--tier T2] [--template Definition]
  node tools/scripts/gg-brief-init.mjs --page-id <id> --entity "<X>" --tier T1 --template Pillar \\
    --child-entities "a,b,c,d,e,f,g"

flags:
  --page-id <slug>          required, matches [A-Za-z0-9_-]{1,64}
  --entity "<text>"         required, Title Cased entity name
  --tier T1|T2              default T2
  --template Pillar|Definition  default Definition
  --child-entities "a,b,c"  Pillar only, comma-separated
  --out <path>              default .gg-cache/overrides/<page_id>.json
  --merge <existing-file>   merge into existing overrides JSON (adds page_id key)
  --force                   overwrite existing file
`);
    return 0;
  }

  if (!args.page_id || !args.entity) {
    process.stderr.write('missing --page-id or --entity (run with --help)\n');
    return 2;
  }

  const pageId = args.page_id;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(pageId)) {
    process.stderr.write(`invalid page_id "${pageId}" — must match /^[A-Za-z0-9_-]{1,64}$/\n`);
    return 2;
  }

  const tier = args.tier || 'T2';
  const template = args.template || 'Definition';
  if (!['T1', 'T2', 'T3'].includes(tier)) {
    process.stderr.write(`invalid --tier "${tier}" — must be T1, T2, or T3\n`);
    return 2;
  }
  if (!['Definition', 'Pillar'].includes(template)) {
    process.stderr.write(`invalid --template "${template}" — must be Definition or Pillar\n`);
    return 2;
  }

  const childEntities = args.child_entities
    ? String(args.child_entities).split(',').map((s) => s.trim()).filter(Boolean)
    : null;

  const entry = renderScaffold({
    pageId,
    entity: args.entity,
    tier,
    template,
    childEntities,
  });

  const defaultOut = join(REPO, '.gg-cache', 'overrides', `${pageId}.json`);
  const outPath = args.out || defaultOut;

  if (args.merge) {
    if (!existsSync(args.merge)) {
      process.stderr.write(`--merge target not found: ${args.merge}\n`);
      return 2;
    }
    const existing = JSON.parse(readFileSync(args.merge, 'utf8'));
    if (existing[pageId] && !args.force) {
      process.stderr.write(`page_id "${pageId}" already exists in ${args.merge} — use --force to overwrite\n`);
      return 2;
    }
    existing[pageId] = entry;
    writeFileSync(args.merge, JSON.stringify(existing, null, 2) + '\n');
    process.stdout.write(`✓ merged page_id "${pageId}" into ${args.merge}\n`);
    process.stdout.write(`  next: edit the 6 TODO fields, then proceed to PIPELINE.md step 2\n`);
    return 0;
  }

  if (existsSync(outPath) && !args.force) {
    process.stderr.write(`output exists: ${outPath} — use --force to overwrite or --merge <other-file>\n`);
    return 2;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  const wrapper = {
    _note: `Brief override for ${pageId} (${tier} ${template}). Scaffolded ${new Date().toISOString()}. Replace every TODO: marker with real editorial content before running gg-render-batch.mjs.`,
    [pageId]: entry,
  };
  writeFileSync(outPath, JSON.stringify(wrapper, null, 2) + '\n');
  process.stdout.write(`✓ wrote brief scaffold: ${outPath}\n`);
  process.stdout.write(`  next: open the file, replace each "TODO: ..." string with real content\n`);
  process.stdout.write(`  required edits (~12 TODO markers): grep TODO: ${outPath.replace(REPO + '/', '')}\n`);
  process.stdout.write(`  fields: search_volume, cluster_jtbd, content_angle, internal_link_rule,\n`);
  process.stdout.write(`          tier_gate_block (Friction + Logic), rl6_hint, friction_themes × 3\n`);
  process.stdout.write(`  then: see docs/PIPELINE.md step 2 (RAG) → step 12 (deploy verify)\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch((e) => {
    process.stderr.write(`fatal: ${e.message}\n`);
    process.exit(1);
  });
}

export { main };
