// Emit phase2-validate fixture sidecars for the 6/21 batch from the scaffold.
// EN -> .gg-cache/prompts/<PID>.v8-fixture.json ; ZH -> <PID>.v8.zh-fixture.json
// PG-WC-026 fixtures are authored by hand already; this skips it unless --all.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const scaffold = JSON.parse(readFileSync(join(__dirname, '_wc026-scaffold.json'), 'utf8'));
const PROMPTS = join(REPO, '.gg-cache', 'prompts');
const force = process.argv.includes('--all');

const baseEn = (a) => ({
  schema_version: '1', page_id: a.page_id, author_id: a.author_id,
  entity: a.entity_en, target_keyword: a.target_keyword,
  associated_keywords: a.assoc_en, template: 'Definition', tier: a.tier,
  prompt_version: 'v8', language: 'en', word_range: [1500, 1800],
  kw_count_range: [5, 8], expected_h2: 11, psych_safety: 'N',
  cta_target_url: 'https://astrologywiki.com/en/wiki/how-to-read-birth-chart',
  generated_at: '2026-06-21T10:00:00.000Z',
});
const baseZh = (a) => ({
  schema_version: '1', page_id: a.page_id, author_id: a.author_id,
  entity: a.entity_zh, target_keyword: a.target_keyword, target_keyword_zh: a.target_keyword_zh,
  associated_keywords: a.assoc_zh, template: 'Definition', tier: a.tier,
  prompt_version: 'v8', language: 'zh', word_range: [1500, 2000],
  kw_count_range: [5, 8], expected_h2: 11, psych_safety: 'N',
  cta_target_url: 'https://astrologywiki.com/zh/wiki/how-to-read-birth-chart',
  generated_at: '2026-06-21T10:00:00.000Z',
});

let n = 0;
for (const a of scaffold.articles) {
  if (a.page_id === 'PG-WC-026' && !force) continue;
  const en = join(PROMPTS, `${a.page_id}.v8-fixture.json`);
  const zh = join(PROMPTS, `${a.page_id}.v8.zh-fixture.json`);
  writeFileSync(en, JSON.stringify(baseEn(a), null, 2) + '\n');
  writeFileSync(zh, JSON.stringify(baseZh(a), null, 2) + '\n');
  n += 2;
  process.stdout.write(`wrote ${a.page_id}: EN + ZH fixtures (${a.author_id}, ${a.tier})\n`);
}
process.stdout.write(`done: ${n} fixtures written\n`);
