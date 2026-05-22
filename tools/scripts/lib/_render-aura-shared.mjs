// Shared renderer used by _render-{blue,purple,yellow}-aura-test.mjs.
// Mirrors _render-saturn-return-test.mjs structure with aura-specific defaults
// (chakra entity type → Energy Center column uses chakra naming per v8 P-7-002
// patch). Bypasses Sheet provisioning; reads Phase 0 RAG caches from
// .gg-cache/{page_id}/ and SERP cache from .gg-cache/serp/{page_id}.json.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function entityPassportBlock(cache) {
  if (!cache?.snippets?.length) return '';
  let out = '<source name="entity-passport">\n';
  for (const s of cache.snippets.slice(0, 12)) {
    out += `  <field name="${xmlEscape(s.source_id)}" domain="${xmlEscape(s.domain)}">${xmlEscape(s.text)}</field>\n`;
  }
  return out + '</source>';
}

function frictionMineBlock(cache) {
  if (!cache?.themes?.length) return '';
  let out = '<source name="friction-mine">\n';
  for (const t of cache.themes.slice(0, 8)) {
    out += `  <field name="${xmlEscape(t.theme)}" source="${xmlEscape(t.source_id)}" mentions="${t.mention_count}">${xmlEscape(t.scrubbed_quote)}</field>\n`;
  }
  return out + '</source>';
}

function obsidianRagBlock(cache) {
  if (!cache?.snippets?.length) {
    return '<!-- obsidian-rag: vault gap (no matching notes for this entity) -->';
  }
  let out = '<source name="obsidian-wiki" note="curated deep-reading book notes from wzb personal vault">\n';
  for (let i = 0; i < Math.min(12, cache.snippets.length); i++) {
    const s = cache.snippets[i];
    out += `  <field name="obsidian#${i + 1}" title="${xmlEscape(s.title || '')}" section="${xmlEscape(s.section || '')}">${xmlEscape(s.text)}</field>\n`;
  }
  return out + '</source>';
}

function serpSnippetsBlock(cache, fallbackKw) {
  if (!cache?.snippets?.length) {
    return '<!-- SERP cache missing -->';
  }
  let out = `<source name="serp-top" query="${xmlEscape(cache.query || fallbackKw)}">\n`;
  for (let i = 0; i < Math.min(10, cache.snippets.length); i++) {
    out += `  <field name="serp#${i + 1}">${xmlEscape(cache.snippets[i])}</field>\n`;
  }
  return out + '</source>';
}

export function renderAuraPrompt(cfg) {
  const PAGE_ID = cfg.page_id;
  const ENTITY = cfg.entity;
  const TARGET_KW = cfg.target_keyword;
  const ASSOC_KW = cfg.associated_keywords.join(', ');
  const PROMPT_VERSION = cfg.prompt_version || 'v8';

  // 1. Synth friction-mine (real Reddit OAuth pending — B'.2).
  const frictionCachePath = join(REPO, '.gg-cache', PAGE_ID, 'friction-mine.rag.json');
  mkdirSync(dirname(frictionCachePath), { recursive: true });
  const synthFriction = {
    schema_version: '1',
    page_id: PAGE_ID,
    entity: ENTITY,
    target_keyword: TARGET_KW,
    generated_at: new Date().toISOString(),
    themes: cfg.friction_themes,
    pii_audit: { total_redactions: 0, by_type: {} },
  };
  writeFileSync(frictionCachePath, JSON.stringify(synthFriction, null, 2));
  console.log('SYNTH friction-mine.rag.json:', frictionCachePath);

  // 2. Read template + caches.
  // Template selector: cfg.template = 'Definition' (default) | 'Pillar'.
  // Pillar template has different section structure (9 H2 hub/aggregator shape)
  // and different word/kw defaults (2500-3500 / 8-12) — fixture carries those
  // downstream to Phase 2 validator.
  const templateName = /^pillar$/i.test(cfg.template || '') ? 'pillar' : 'definition';
  const template = readFileSync(
    join(REPO, 'tools/scripts/lib/content-draft-templates', `${templateName}.prompt.md`),
    'utf8'
  );
  const passportCache = JSON.parse(
    readFileSync(join(REPO, '.gg-cache', PAGE_ID, 'entity-passport.rag.json'), 'utf8')
  );
  const obsidianCache = JSON.parse(
    readFileSync(join(REPO, '.gg-cache', PAGE_ID, 'obsidian-rag.json'), 'utf8')
  );
  const serpPath = join(REPO, '.gg-cache', 'serp', `${PAGE_ID}.json`);
  const serpCache = existsSync(serpPath) ? JSON.parse(readFileSync(serpPath, 'utf8')) : null;

  // 3. Replacements.
  const isPillar = templateName === 'pillar';
  const wordRangeArr = cfg.word_range || (isPillar ? [2500, 3500] : [1500, 1800]);
  const kwRangeArr = cfg.kw_count_range || (isPillar ? [8, 12] : [5, 8]);
  const replacements = {
    '{{TIER}}': cfg.tier || 'T2',
    '{{target_keyword}}': TARGET_KW,
    '{{associated_keywords}}': ASSOC_KW,
    '{{entity}}': ENTITY,
    '{{search_volume}}': cfg.search_volume,
    '{{intent}}': 'Info',
    '{{tier}}': cfg.tier || 'T2',
    '{{track}}': '量产线',
    '{{page_role}}': isPillar ? 'Hub' : 'Support',
    '{{cluster_jtbd}}': cfg.cluster_jtbd,
    '{{content_angle}}': cfg.content_angle,
    '{{internal_link_rule}}': cfg.internal_link_rule,
    '{{cta_text}}': cfg.cta_text,
    '{{cta_target_url}}': cfg.cta_target_url,
    '{{psych_safety_flag}}': cfg.psych_safety_flag || 'N',
    '{{target_country}}': 'US (English)',
    '{{TIER_GATE_BLOCK}}': cfg.tier_gate_block,
    '{{TIER_LOGIC_HINT}}': '',
    '{{PSYCH_SAFETY_BLOCK}}': '',
    '{{RL6_HINT}}': cfg.rl6_hint,
    '{{WORD_RANGE}}': `${wordRangeArr[0]}-${wordRangeArr[1]}`,
    '{{KW_COUNT_RANGE}}': `${kwRangeArr[0]}-${kwRangeArr[1]}`,
    '{{ENTITY_PASSPORT_BLOCK}}': entityPassportBlock(passportCache),
    '{{FRICTION_MINE_BLOCK}}': frictionMineBlock(synthFriction),
    '{{SERP_SNIPPETS_BLOCK}}': serpSnippetsBlock(serpCache, TARGET_KW),
    '{{OBSIDIAN_RAG_BLOCK}}': obsidianRagBlock(obsidianCache),
    // Pillar-only placeholders (Definition template never references these).
    '{{child_entities}}': Array.isArray(cfg.child_entities) ? cfg.child_entities.join(', ') : (cfg.child_entities || ''),
    '{{child_count}}': cfg.child_count != null ? String(cfg.child_count) : (Array.isArray(cfg.child_entities) ? String(cfg.child_entities.length) : ''),
  };

  let prompt = template;
  for (const [k, v] of Object.entries(replacements)) {
    prompt = prompt.split(k).join(v);
  }

  // 4. Write output.
  const outPath = join(REPO, '.gg-cache', 'prompts', `${PAGE_ID}.${PROMPT_VERSION}-prompt.md`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, prompt);
  console.log('\nV8 PROMPT WRITTEN:', outPath);
  console.log('Length:', prompt.length, 'chars,', prompt.split(/\s+/).filter(Boolean).length, 'tokens (rough)');

  const unmatched = prompt.match(/\{\{[A-Z_a-z]+\}\}/g);
  if (unmatched) {
    console.log('\n!!! UNREPLACED PLACEHOLDERS:', [...new Set(unmatched)]);
    process.exit(1);
  }
  console.log('All placeholders replaced ✓');
  console.log('SERP cache:', serpCache ? `hit (${serpCache.snippets?.length || 0} snippets)` : 'MISSING');
  console.log('Obsidian RAG:', obsidianCache.snippets?.length ? `hit (${obsidianCache.snippets.length} snippets)` : 'gap');

  // 5. Write fixture.json sidecar — Phase 2 validator can auto-load via --page-id.
  // Carries all parameters needed for downstream validation, so the operator
  // only passes --source + --tag + --llm-source at validate time.
  const fixturePath = join(REPO, '.gg-cache', 'prompts', `${PAGE_ID}.${PROMPT_VERSION}-fixture.json`);
  const fixture = {
    schema_version: '1',
    page_id: PAGE_ID,
    entity: ENTITY,
    target_keyword: TARGET_KW,
    associated_keywords: cfg.associated_keywords,
    template: isPillar ? 'Pillar' : 'Definition',
    tier: cfg.tier || 'T2',
    prompt_version: PROMPT_VERSION,
    word_range: wordRangeArr,
    kw_count_range: kwRangeArr,
    expected_h2: cfg.expected_h2 || (isPillar ? 9 : 7),
    psych_safety: cfg.psych_safety_flag || 'N',
    ...(isPillar && cfg.child_entities ? { child_entities: cfg.child_entities, child_count: cfg.child_count || cfg.child_entities.length } : {}),
    generated_at: new Date().toISOString(),
  };
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
  console.log('Fixture sidecar:', fixturePath);
}
