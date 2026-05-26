// Shared renderer used by _render-{blue,purple,yellow}-aura-test.mjs.
// Mirrors _render-saturn-return-test.mjs structure with aura-specific defaults
// (chakra entity type → Energy Center column uses chakra naming per v8 P-7-002
// patch). Bypasses Sheet provisioning; reads Phase 0 RAG caches from
// .gg-cache/{page_id}/ and SERP cache from .gg-cache/serp/{page_id}.json.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidAuthorId, normalizeAuthorId } from './author-routing.mjs';
import { loadPersona } from './author-personas/loader.mjs';

// Author fields for the fixture sidecar (Lane B / T3). When cfg carries a valid
// author_id (resolved at pull time), pull the persona's display name, version, and
// banned_tokens so _phase2-validate can publish the byline AND enforce RL7 in the
// batch path. Invalid/absent → {} (graceful: EN fixtures without an author stay
// clean). loadPersona failure is swallowed — a bad card must not break rendering.
export function authorFixtureFields(cfg) {
  const raw = String(cfg.author_id || '').replace(/^["']|["']$/g, '').trim();
  if (!raw || !isValidAuthorId(raw)) return {};
  const id = normalizeAuthorId(raw);
  try {
    const p = loadPersona(id);
    return {
      author_id: id,
      ...(cfg.author_source ? { author_source: cfg.author_source } : {}),
      author_display_name: p.displayName,
      persona_version: p.version,
      banned_tokens: p.bannedTokens,
    };
  } catch {
    return {};
  }
}

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

// Stable page_id regex — matches gg-friction-mine PAGE_ID_REGEX and gg-sheet-pull PAGE_ID_REGEX.
// renderAuraPrompt writes files at .gg-cache/<page_id>/, so we MUST fail closed on invalid input
// to prevent any path-traversal escape from upstream callers (bridges, batch scripts, overrides).
export const PAGE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

export function renderAuraPrompt(cfg) {
  const PAGE_ID = cfg.page_id;
  if (!PAGE_ID || !PAGE_ID_REGEX.test(String(PAGE_ID))) {
    throw new Error(`renderAuraPrompt: invalid page_id "${PAGE_ID}" — must match /^[A-Za-z0-9_-]{1,64}$/`);
  }
  const ENTITY = cfg.entity;
  const TARGET_KW = cfg.target_keyword;
  const ASSOC_KW = cfg.associated_keywords.join(', ');
  const PROMPT_VERSION = cfg.prompt_version || 'v8';

  // 1. friction-mine cache — prefer real Reddit-mined data when present,
  // fall back to synth from cfg.friction_themes (v0.18: before this fix
  // the synth call unconditionally overwrote any real RAG cache produced
  // by gg-friction-mine --for-rag, silently dropping real user data).
  const frictionCachePath = join(REPO, '.gg-cache', PAGE_ID, 'friction-mine.rag.json');
  mkdirSync(dirname(frictionCachePath), { recursive: true });
  let frictionPayload = null;
  if (existsSync(frictionCachePath)) {
    try {
      const existing = JSON.parse(readFileSync(frictionCachePath, 'utf8'));
      if (Array.isArray(existing?.themes) && existing.themes.length > 0) {
        frictionPayload = existing;
        console.log('REAL friction-mine.rag.json:', frictionCachePath, `(${existing.themes.length} themes)`);
      }
    } catch {
      // corrupt or unreadable → fall through to synth
    }
  }
  if (!frictionPayload) {
    frictionPayload = {
      schema_version: '1',
      page_id: PAGE_ID,
      entity: ENTITY,
      target_keyword: TARGET_KW,
      generated_at: new Date().toISOString(),
      themes: cfg.friction_themes,
      pii_audit: { total_redactions: 0, by_type: {} },
      _synth: true,
    };
    writeFileSync(frictionCachePath, JSON.stringify(frictionPayload, null, 2));
    console.log('SYNTH friction-mine.rag.json:', frictionCachePath);
  }

  // 2. Read template + caches.
  // Template selector: cfg.template = 'Definition' (default) | 'Pillar'.
  // Pillar template has different section structure (9 H2 hub/aggregator shape)
  // and different word/kw defaults (2500-3500 / 8-12) — fixture carries those
  // downstream to Phase 2 validator.
  //
  // bilingual-v9: cfg.language = 'en' (default) | 'zh' picks the language
  // variant. ZH templates are full rewrites (not translations) tuned for
  // cultural adaptation; EN remains the default for back-compat.
  const lang = cfg.language === 'zh' ? 'zh' : 'en';
  const templateName = /^pillar$/i.test(cfg.template || '') ? 'pillar' : 'definition';
  const templateFile = lang === 'zh'
    ? `${templateName}.prompt.zh.md`
    : `${templateName}.prompt.md`;
  const template = readFileSync(
    join(REPO, 'tools/scripts/lib/content-draft-templates', templateFile),
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
  // ZH defaults: Chinese articles measure in characters, not words. Tuned
  // 2026-05-25 from first opus 4.7 production run (actual output 1590 chars).
  // Chinese expression is denser; 1500-2000 chars ≈ EN 1500-1800 words depth.
  const enWordDefault = isPillar ? [2500, 3500] : [1500, 1800];
  const zhWordDefault = isPillar ? [3000, 4000] : [1500, 2000];
  const wordRangeArr = cfg.word_range || (lang === 'zh' ? zhWordDefault : enWordDefault);
  const kwRangeArr = cfg.kw_count_range || (isPillar ? [8, 12] : [5, 8]);
  const targetCountry = lang === 'zh' ? 'CN/华语圈 (简体中文)' : 'US (English)';
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
    '{{target_country}}': targetCountry,
    '{{TIER_GATE_BLOCK}}': cfg.tier_gate_block,
    '{{TIER_LOGIC_HINT}}': '',
    '{{PSYCH_SAFETY_BLOCK}}': '',
    '{{RL6_HINT}}': cfg.rl6_hint,
    '{{WORD_RANGE}}': `${wordRangeArr[0]}-${wordRangeArr[1]}`,
    '{{KW_COUNT_RANGE}}': `${kwRangeArr[0]}-${kwRangeArr[1]}`,
    '{{ENTITY_PASSPORT_BLOCK}}': entityPassportBlock(passportCache),
    '{{FRICTION_MINE_BLOCK}}': frictionMineBlock(frictionPayload),
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

  // 4. Write output. ZH variants get a .zh infix so EN and ZH coexist for the
  // same page_id without overwriting each other:
  //   EN: <page_id>.v8-prompt.md      ZH: <page_id>.v8.zh-prompt.md
  const langInfix = lang === 'zh' ? '.zh' : '';
  const outPath = join(REPO, '.gg-cache', 'prompts', `${PAGE_ID}.${PROMPT_VERSION}${langInfix}-prompt.md`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, prompt);
  console.log(`\n${lang.toUpperCase()} V8 PROMPT WRITTEN:`, outPath);
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
  const fixturePath = join(REPO, '.gg-cache', 'prompts', `${PAGE_ID}.${PROMPT_VERSION}${langInfix}-fixture.json`);
  const fixture = {
    schema_version: '1',
    page_id: PAGE_ID,
    entity: ENTITY,
    target_keyword: TARGET_KW,
    associated_keywords: cfg.associated_keywords,
    template: isPillar ? 'Pillar' : 'Definition',
    tier: cfg.tier || 'T2',
    prompt_version: PROMPT_VERSION,
    language: lang,
    word_range: wordRangeArr,
    kw_count_range: kwRangeArr,
    expected_h2: cfg.expected_h2 || (isPillar ? 9 : 7),
    psych_safety: cfg.psych_safety_flag || 'N',
    // bilingual-v9: ZH main long-tail (ops-filled). Carries through to phase2
    // RL4/RL5 anchor check. Omitted when not provided so EN fixtures don't get
    // a noise field.
    ...(cfg.target_keyword_zh ? { target_keyword_zh: cfg.target_keyword_zh } : {}),
    ...(isPillar && cfg.child_entities ? { child_entities: cfg.child_entities, child_count: cfg.child_count || cfg.child_entities.length } : {}),
    ...authorFixtureFields(cfg),
    generated_at: new Date().toISOString(),
  };
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
  console.log('Fixture sidecar:', fixturePath);
}
