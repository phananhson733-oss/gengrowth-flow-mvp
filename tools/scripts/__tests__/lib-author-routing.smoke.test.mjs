#!/usr/bin/env node
// Smoke test for lib/author-routing.mjs (Lane B / T3 core routing).
// Run: node --test tools/scripts/__tests__/lib-author-routing.smoke.test.mjs
//
// Covers:
//   - normalizeAuthorId / isValidAuthorId (case + whitespace)
//   - buildAuthorMap: valid keys parsed, illegal author_id skipped + warned
//   - resolveAuthor: domain hit → auto / miss → blank / override → override
//     (not overwritten by auto) / illegal override → rejected + blank

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  KNOWN_AUTHOR_IDS,
  AUTHOR_MAP_PREFIX,
  normalizeAuthorId,
  isValidAuthorId,
  normalizeDomain,
  buildAuthorMap,
  resolveAuthor,
} from '../lib/author-routing.mjs';

test('KNOWN_AUTHOR_IDS holds the 4 expected kebab ids', () => {
  assert.deepEqual(
    [...KNOWN_AUTHOR_IDS].sort(),
    ['aditi-sharma', 'elena-vane', 'julian-thorne', 'marcus-orion'],
  );
});

test('normalizeAuthorId: trim + lowercase', () => {
  assert.equal(normalizeAuthorId('  Marcus-Orion '), 'marcus-orion');
  assert.equal(normalizeAuthorId(null), '');
});

test('isValidAuthorId: case-insensitive membership', () => {
  assert.equal(isValidAuthorId('Elena-Vane'), true);
  assert.equal(isValidAuthorId('marcus-orion'), true);
  assert.equal(isValidAuthorId('bob-smith'), false);
  assert.equal(isValidAuthorId(''), false);
});

test('buildAuthorMap: valid author.map keys parsed + normalized', () => {
  const { map, warnings } = buildAuthorMap({
    [`${AUTHOR_MAP_PREFIX}Aura`]: 'Elena-Vane',
    [`${AUTHOR_MAP_PREFIX}transits`]: 'marcus-orion',
    'mine.max_kd': 50, // unrelated key ignored
  });
  assert.equal(map.get('aura'), 'elena-vane');
  assert.equal(map.get('transits'), 'marcus-orion');
  assert.equal(map.size, 2);
  assert.equal(warnings.length, 0);
});

test('buildAuthorMap: illegal author_id value skipped + warned', () => {
  const { map, warnings } = buildAuthorMap({
    [`${AUTHOR_MAP_PREFIX}aura`]: 'nonexistent-writer',
  });
  assert.equal(map.size, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not a known author_id/);
});

test('resolveAuthor: domain HIT → author + author_source=auto', () => {
  const { map } = buildAuthorMap({ [`${AUTHOR_MAP_PREFIX}aura`]: 'elena-vane' });
  const r = resolveAuthor({ clusterDomain: 'Aura', overrideRaw: '', authorMap: map });
  assert.equal(r.author, 'elena-vane');
  assert.equal(r.author_source, 'auto');
  assert.equal(r.cluster_domain, 'aura');
  assert.equal(r.warnings.length, 0);
});

test('resolveAuthor: domain MISS → author blank, no source', () => {
  const { map } = buildAuthorMap({ [`${AUTHOR_MAP_PREFIX}aura`]: 'elena-vane' });
  const r = resolveAuthor({ clusterDomain: 'nodes', overrideRaw: '', authorMap: map });
  assert.equal(r.author, '');
  assert.equal(r.author_source, undefined);
  assert.equal(r.cluster_domain, 'nodes');
});

test('resolveAuthor: valid override wins + is NOT overwritten by auto', () => {
  // auto would map aura → elena-vane, but override forces julian-thorne.
  const { map } = buildAuthorMap({ [`${AUTHOR_MAP_PREFIX}aura`]: 'elena-vane' });
  const r = resolveAuthor({ clusterDomain: 'aura', overrideRaw: ' Julian-Thorne ', authorMap: map });
  assert.equal(r.author, 'julian-thorne');
  assert.equal(r.author_source, 'override');
});

test('resolveAuthor: illegal override → rejected, author blank + warning', () => {
  const { map } = buildAuthorMap({ [`${AUTHOR_MAP_PREFIX}aura`]: 'elena-vane' });
  const r = resolveAuthor({ clusterDomain: 'aura', overrideRaw: 'fake-person', authorMap: map });
  assert.equal(r.author, '');
  assert.equal(r.author_source, undefined);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /not a known author_id/);
});

test('normalizeDomain: trim + lowercase', () => {
  assert.equal(normalizeDomain('  Vedic '), 'vedic');
  assert.equal(normalizeDomain(null), '');
});
