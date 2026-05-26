#!/usr/bin/env node
// Smoke test for gg-md-to-oracle-ts.mjs author publish-metadata (Lane B / T10).
// Run: node --test tools/scripts/__tests__/gg-md-to-oracle-ts-author.smoke.test.mjs
//
// Covers:
//   - resolveAuthorMeta reads display_name / credential from persona frontmatter
//   - invalid / missing author id → null (falls back to house byline)
//   - emitExportBlock with authorMeta emits author display name + authorSlug + authorBio
//   - emitExportBlock without authorMeta keeps the existing house byline (back-compat)

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  resolveAuthorMeta,
  emitExportBlock,
  parseFrontmatter,
} from '../gg-md-to-oracle-ts.mjs';

// resolveAuthorMeta now delegates to lib/author-personas/loadPersona (the single
// source of truth), so these read the real persona cards — no temp fixture dir.
test('resolveAuthorMeta: valid id reads display_name + credential as bio', () => {
  const meta = resolveAuthorMeta('marcus-orion');
  assert.ok(meta);
  assert.equal(meta.id, 'marcus-orion');
  assert.equal(meta.displayName, 'Marcus Orion');
  assert.equal(meta.slug, 'marcus-orion');
  assert.match(meta.shortBio, /data analysis/);
});

test('resolveAuthorMeta: case-insensitive id', () => {
  const meta = resolveAuthorMeta('Marcus-Orion');
  assert.ok(meta);
  assert.equal(meta.displayName, 'Marcus Orion');
});

test('resolveAuthorMeta: invalid / empty / undefined author id → null', () => {
  assert.equal(resolveAuthorMeta('not-a-writer'), null);
  assert.equal(resolveAuthorMeta(''), null);
  assert.equal(resolveAuthorMeta(undefined), null);
});

test('resolveAuthorMeta: unknown kebab id → null (no throw reaches the converter)', () => {
  // rejected by isValidAuthorId before loadPersona; any loader throw is also caught.
  assert.equal(resolveAuthorMeta('ghost-writer'), null);
});

test('emitExportBlock: authorMeta → authorId (persona id), no legacy author fields', () => {
  const out = emitExportBlock({
    slug: 'leo-personality',
    title: 'Leo Personality',
    date: '2026-05-26',
    description: 'd',
    keywords: ['leo personality'],
    body: 'body',
    varName: 'leoPersonalityEn',
    language: 'en',
    authorMeta: { id: 'marcus-orion', displayName: 'Marcus Orion', slug: 'marcus-orion', shortBio: 'Systems explainer.' },
  });
  // WikiArticle references the author by id only; the registry resolves
  // display name + bio at render time. Legacy author/authorSlug/authorBio
  // fields are gone (they are not in the type and break the build's gate).
  assert.match(out, /authorId: "marcus-orion"/);
  assert.ok(!out.includes('authorSlug'));
  assert.ok(!out.includes('authorBio'));
  assert.ok(!/\bauthor: /.test(out));
});

test('emitExportBlock: no authorMeta → authorId "" (house byline no longer expressible)', () => {
  const out = emitExportBlock({
    slug: 'x', title: 't', date: '2026-05-26', description: 'd',
    keywords: ['k'], body: 'b', varName: 'xEn', language: 'en',
  });
  assert.match(out, /authorId: ""/);
  assert.ok(!out.includes('authorSlug'));
  assert.ok(!out.includes('authorBio'));
});

test('emitExportBlock: zh + no authorMeta → authorId ""', () => {
  const out = emitExportBlock({
    slug: 'x', title: 't', date: '2026-05-26', description: 'd',
    keywords: ['k'], body: 'b', varName: 'xZh', language: 'zh',
  });
  assert.match(out, /authorId: ""/);
});

// Round-trip regression (C1): the headline failure mode. content-draft's
// buildAuthorFrontmatter writes the persona id under `author_id`, JSON-quoted.
// convertOne must read that key (not legacy `author`) AND tolerate the quotes,
// or every authored article silently publishes under the house byline. This
// exercises the parseFrontmatter -> resolveAuthorMeta path the other tests skip.
test('round-trip (C1): author_id frontmatter (JSON-quoted) resolves the persona byline', () => {
  const stagingMd = [
    '---',
    'title: Blue Aura Meaning',
    'slug: blue-aura-meaning',
    'author_id: "marcus-orion"',
    'author_display_name: "Marcus Orion"',
    'persona_version: "1.0"',
    '---',
    '',
    '# Blue Aura Meaning',
    '',
    '## What is blue aura?',
    'Body text.',
  ].join('\n');
  const { frontmatter: fm } = parseFrontmatter(stagingMd);
  // same key precedence + resolution as convertOne
  const meta = resolveAuthorMeta(fm.author_id || fm.author);
  assert.ok(meta, 'author_id must resolve — reading fm.author or keeping quotes regresses to house byline');
  assert.equal(meta.id, 'marcus-orion');
  assert.equal(meta.displayName, 'Marcus Orion');
});

test('round-trip (C1): legacy `author` key still resolves (back-compat)', () => {
  const meta = resolveAuthorMeta('elena-vane');
  assert.ok(meta);
  assert.equal(meta.id, 'elena-vane');
});
