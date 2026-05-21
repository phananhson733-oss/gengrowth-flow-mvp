// One-off renderer for v5 prompt validation. Not part of prod pipeline.
// Reads definition.prompt.md template + mock fixture, outputs v5 prompt to disk.
// Synthesizes a fake friction-mine.rag.json since real Reddit scrape is gated on Phase 2 LLM round-trip.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const REPO = '/Users/wzb/gengrowth-wiki';
const PAGE_ID = 'page_blue_aura_meaning';
const ENTITY = 'Blue Aura';
const TARGET_KW = 'blue aura meaning';

// 1. Synthesize friction-mine.rag.json (real Reddit scrape requires Phase 2 round-trip)
const frictionCachePath = join(REPO, '.gg-cache', PAGE_ID, 'friction-mine.rag.json');
mkdirSync(dirname(frictionCachePath), { recursive: true });
const synthFriction = {
  schema_version: '1',
  page_id: PAGE_ID,
  entity: ENTITY,
  target_keyword: TARGET_KW,
  generated_at: new Date().toISOString(),
  themes: [
    {
      theme: 'color_confusion',
      scrubbed_quote: 'I keep seeing two shades of blue in my aura photos and the practitioners give me opposite readings for each',
      source_id: 'reddit#1',
      domain: 'old.reddit.com',
      mention_count: 4,
    },
    {
      theme: 'meaning_anxiety',
      scrubbed_quote: 'is having a mostly blue aura a bad sign? my friend said it means I am cold or shut down',
      source_id: 'reddit#2',
      domain: 'old.reddit.com',
      mention_count: 6,
    },
    {
      theme: 'how_to_see',
      scrubbed_quote: 'how do you actually see your own aura color without a photo? the kirlian camera at the metaphysical store gave me one color and a friend said something different',
      source_id: 'reddit#3',
      domain: 'old.reddit.com',
      mention_count: 5,
    },
  ],
  pii_audit: { total_redactions: 0, by_type: {} },
};
writeFileSync(frictionCachePath, JSON.stringify(synthFriction, null, 2));
console.log('SYNTH friction-mine.rag.json:', frictionCachePath);

// 2. Read templates + caches
const template = readFileSync(join(REPO, 'tools/scripts/lib/content-draft-templates/definition.prompt.md'), 'utf8');
const passportCache = JSON.parse(readFileSync(join(REPO, '.gg-cache', PAGE_ID, 'entity-passport.rag.json'), 'utf8'));
const frictionCache = synthFriction;

// 3. Build RAG blocks (mirrors gg-content-draft.mjs builder logic, simplified)
function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function entityPassportBlock(cache) {
  if (!cache || !cache.snippets || cache.snippets.length === 0) return '';
  let out = '<source name="entity-passport">\n';
  for (const s of cache.snippets.slice(0, 12)) {
    out += `  <field name="${xmlEscape(s.source_id)}" domain="${xmlEscape(s.domain)}">${xmlEscape(s.text)}</field>\n`;
  }
  out += '</source>';
  return out;
}
function frictionMineBlock(cache) {
  if (!cache || !cache.themes || cache.themes.length === 0) return '';
  let out = '<source name="friction-mine">\n';
  for (const t of cache.themes.slice(0, 8)) {
    out += `  <field name="${xmlEscape(t.theme)}" source="${xmlEscape(t.source_id)}" mentions="${t.mention_count}">${xmlEscape(t.scrubbed_quote)}</field>\n`;
  }
  out += '</source>';
  return out;
}

const replacements = {
  '{{TIER}}': 'T2',
  '{{target_keyword}}': TARGET_KW,
  '{{associated_keywords}}': 'blue aura color, what does blue aura mean, blue aura personality',
  '{{entity}}': ENTITY,
  '{{search_volume}}': '2400',
  '{{intent}}': 'Info',
  '{{tier}}': 'T2',
  '{{track}}': '量产线',
  '{{page_role}}': 'Support',
  '{{cluster_jtbd}}': '1 分钟知道这个颜色代表什么 + 自我反思入口',
  '{{content_angle}}': 'color-system applied to blue specifically — 1-min answer + 3 reflection prompts',
  '{{internal_link_rule}}': 'all → pillar page on aura colors overview',
  '{{cta_text}}': 'Take the 60-second Aura Color Quiz to identify your dominant color',
  '{{cta_target_url}}': 'https://astrologywiki.com/tools/aura-color-quiz',
  '{{psych_safety_flag}}': 'N',
  '{{target_country}}': 'US (English)',
  '{{TIER_GATE_BLOCK}}': `## Tier Gate（T2 Definition）

- 必读 Friction（来自选题登记表 col J）: 用户搜 'blue aura meaning' 想快速 1 分钟知道蓝色光环代表什么性格 / 情绪状态 / 能量场，但搜出来全是占星师卖课的长文章绕半天才进入定义
- 必读 Logic（col K）: 光环颜色对应能量场频率不同；蓝色频率落在喉轮（沟通）+ 心轮过渡区，对应平静 / 表达 / 沟通能力；与黄色（智力）/紫色（直觉）形成对比；机制是颜色频率与脉轮的对应关系，权衡是颜色解读因人/文化语境而异
- T2 = 标准版（不是 Tier 1 重装）— 字数 1500-1800，结构按 7 sections 严格走`,
  '{{TIER_LOGIC_HINT}}': '',
  '{{PSYCH_SAFETY_BLOCK}}': '',
  '{{RL6_HINT}}': '不写让脆弱读者感到病理化 / 命定 / 受害者化的语言',
  '{{WORD_RANGE}}': '1500-1800',
  '{{KW_COUNT_RANGE}}': '5-8',
  '{{ENTITY_PASSPORT_BLOCK}}': entityPassportBlock(passportCache),
  '{{FRICTION_MINE_BLOCK}}': frictionMineBlock(frictionCache),
  '{{SERP_SNIPPETS_BLOCK}}': '<!-- SERP cache missing — skipped for v5 validation only -->',
};

let prompt = template;
for (const [k, v] of Object.entries(replacements)) {
  prompt = prompt.split(k).join(v);
}

// 4. Write output
const outPath = join(REPO, '.gg-cache/prompts/page_blue_aura_meaning.v5-prompt.md');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, prompt);
console.log('\nV5 PROMPT WRITTEN:', outPath);
console.log('Length:', prompt.length, 'chars,', prompt.split(/\s+/).filter(Boolean).length, 'tokens (rough)');

// Sanity: did all {{...}} get replaced?
const unmatched = prompt.match(/\{\{[A-Z_a-z]+\}\}/g);
if (unmatched) {
  console.log('\n!!! UNREPLACED PLACEHOLDERS:', [...new Set(unmatched)]);
} else {
  console.log('All placeholders replaced ✓');
}
