#!/usr/bin/env node
// Smoke test for gg-md-to-oracle-ts.mjs — covers the bilingual-v9-full
// auto-merge feature: mergeIntoSibling regex hardening, F1 hard guards,
// F3 WikiArticle import check, F4 CRLF normalization, F5 stale-coexistence.
// Run: node --test tools/scripts/__tests__/gg-md-to-oracle-ts.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  emitExportBlock,
  emitTs,
  mergeIntoSibling,
  atomicWrite,
  slugToCamel,
} from '../gg-md-to-oracle-ts.mjs';

function makeEnSibling(varName = 'auraColorBlueEn') {
  return `import type { WikiArticle } from "../../types";

export const ${varName}: WikiArticle = {
  slug: "aura-color-blue",
  title: "EN placeholder",
  description: "x",
  author: "AstrologyWiki Team",
  date: "2026-05-22",
  schema: "Article",
  lang: "en",
  keywords: ["x"],
  content: \`# EN body\n\nEN body should survive merge.\n\`,
};
`;
}

function makeNewBlock(varName = 'auraColorBlueZh') {
  return emitExportBlock({
    slug: 'aura-color-blue',
    title: '蓝色气场',
    date: '2026-05-25',
    description: '中文描述',
    keywords: ['蓝色气场'],
    body: '# 蓝色气场\n\n中文正文。',
    varName,
    language: 'zh',
  });
}

test('emitExportBlock: ZH author is 团队 not Team', () => {
  const out = emitExportBlock({
    slug: 'x', title: 't', date: '2026-05-25', description: 'd',
    keywords: ['k'], body: 'b', varName: 'xZh', language: 'zh',
  });
  assert.match(out, /author: "AstrologyWiki 团队"/);
  assert.match(out, /lang: "zh"/);
});

test('emitTs: includes WikiArticle import + matches single-file dual-export shape', () => {
  const ts = emitTs({
    slug: 'x', title: 't', date: '2026-05-25', description: 'd',
    keywords: [], body: 'b', varName: 'xEn', language: 'en',
  });
  assert.match(ts, /import type \{ WikiArticle \} from "\.\.\/\.\.\/types";/);
  assert.match(ts, /export const xEn: WikiArticle = \{/);
  assert.match(ts, /^\};\n*$/m);
});

test('mergeIntoSibling: appends ZH block when no slugZh exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-merge-'));
  const p = join(dir, 'aura-color-blue.ts');
  writeFileSync(p, makeEnSibling());
  const r = mergeIntoSibling(p, makeNewBlock(), 'auraColorBlueZh');
  assert.equal(r.mode, 'appended');
  assert.match(r.merged, /export const auraColorBlueEn/);
  assert.match(r.merged, /export const auraColorBlueZh/);
  assert.match(r.merged, /EN body should survive merge/);
  rmSync(dir, { recursive: true });
});

test('mergeIntoSibling: replaces existing slugZh block (idempotent re-run)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-merge-'));
  const p = join(dir, 'aura-color-blue.ts');
  // First pass: append
  writeFileSync(p, makeEnSibling());
  const r1 = mergeIntoSibling(p, makeNewBlock(), 'auraColorBlueZh');
  writeFileSync(p, r1.merged);
  // Second pass: should replace, not duplicate
  const r2 = mergeIntoSibling(p, makeNewBlock(), 'auraColorBlueZh');
  assert.equal(r2.mode, 'replaced');
  // Exactly 2 exports (En + Zh), not 3
  const matches = r2.merged.match(/^export const auraColorBlue\w+:/gm) || [];
  assert.equal(matches.length, 2);
  rmSync(dir, { recursive: true });
});

test('mergeIntoSibling F1: trailing comment after }; still matches (regex tolerates [^\\n]*)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-merge-'));
  const p = join(dir, 'aura-color-blue.ts');
  // Sibling with existing slugZh that ends with `}; // legacy comment`
  const en = makeEnSibling();
  const stale = `\nexport const auraColorBlueZh: WikiArticle = {
  slug: "aura-color-blue", title: "old", description: "x", author: "x",
  date: "2026-05-22", schema: "Article", lang: "zh", keywords: [], content: \`x\`,
}; // tail comment\n`;
  writeFileSync(p, en + stale);
  const r = mergeIntoSibling(p, makeNewBlock(), 'auraColorBlueZh');
  assert.equal(r.mode, 'replaced');
  assert.doesNotMatch(r.merged, /title: "old"/);
  rmSync(dir, { recursive: true });
});

test('mergeIntoSibling F1: hard-guard when symbol exists but block extractor misses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-merge-'));
  const p = join(dir, 'aura-color-blue.ts');
  // Non-canonical single-line slugZh: no `};` on its own line at all
  const en = makeEnSibling();
  const oneLiner = '\nexport const auraColorBlueZh: WikiArticle = { slug: "x", title: "x", description: "x", author: "x", date: "2026-05-22", schema: "Article", lang: "zh", keywords: [], content: `x` };\n';
  writeFileSync(p, en + oneLiner);
  assert.throws(
    () => mergeIntoSibling(p, makeNewBlock(), 'auraColorBlueZh'),
    /Refusing to append a duplicate/,
  );
  rmSync(dir, { recursive: true });
});

test('mergeIntoSibling F3: throws when sibling lacks WikiArticle import/declaration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-merge-'));
  const p = join(dir, 'foo.ts');
  // Comment mentions WikiArticle but no actual import → must still throw
  writeFileSync(p, '// just a comment mentioning WikiArticle\nexport const x = 1;\n');
  assert.throws(
    () => mergeIntoSibling(p, makeNewBlock(), 'auraColorBlueZh'),
    /does not import\/declare WikiArticle/,
  );
  rmSync(dir, { recursive: true });
});

test('mergeIntoSibling F3: accepts local type declaration (not just import)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-merge-'));
  const p = join(dir, 'foo.ts');
  writeFileSync(p, 'interface WikiArticle { slug: string; }\nexport const x = 1;\n');
  const r = mergeIntoSibling(p, makeNewBlock(), 'auraColorBlueZh');
  assert.equal(r.mode, 'appended');
  rmSync(dir, { recursive: true });
});

test('mergeIntoSibling F4: normalizes CRLF input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-merge-'));
  const p = join(dir, 'aura-color-blue.ts');
  writeFileSync(p, makeEnSibling().replace(/\n/g, '\r\n'));
  const r = mergeIntoSibling(p, makeNewBlock(), 'auraColorBlueZh');
  assert.equal(r.mode, 'appended');
  // Output should not contain CR (regex anchors LF; CRLF normalized on read).
  assert.doesNotMatch(r.merged, /\r/);
  rmSync(dir, { recursive: true });
});

test('atomicWrite: tmp file does not leak after successful write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-atomic-'));
  const p = join(dir, 'target.txt');
  atomicWrite(p, 'hello');
  assert.equal(readFileSync(p, 'utf8'), 'hello');
  // Verify no .tmp.<pid> file leaked
  const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp.'));
  assert.equal(leftovers.length, 0);
  rmSync(dir, { recursive: true });
});

// ---------- slugToCamel: leading-ordinal slugs must yield VALID JS identifiers ----------
// (2026-05-26) "8th-house-meaning" → "8thHouseMeaningEn" is a syntax error that
// broke the oracle build. Leading ordinals spell out; identifiers stay valid.
test('slugToCamel: leading ordinal slugs → valid identifiers', () => {
  const valid = (s) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
  assert.equal(slugToCamel('8th-house-meaning', 'En'), 'eighthHouseMeaningEn');
  assert.equal(slugToCamel('9th-house-astrology', 'Zh'), 'ninthHouseAstrologyZh');
  assert.equal(slugToCamel('11th-house', 'En'), 'eleventhHouseEn');
  assert.equal(slugToCamel('12th-house-astrology', 'En'), 'twelfthHouseAstrologyEn');
  for (const s of ['8th-house-meaning', '9th-house-astrology', '11th-house', '12th-house-astrology']) {
    assert.ok(valid(slugToCamel(s, 'En')), `invalid id from ${s}`);
    assert.ok(valid(slugToCamel(s, 'Zh')), `invalid id from ${s}`);
  }
  // non-ordinal slugs unchanged
  assert.equal(slugToCamel('green-aura-meaning', 'En'), 'greenAuraMeaningEn');
});
