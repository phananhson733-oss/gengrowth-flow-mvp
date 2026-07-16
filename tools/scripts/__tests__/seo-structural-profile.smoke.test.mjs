import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveStructuralProfile } from '../lib/seo-structural-profile.mjs';

test('legacy manifest keeps exact legacy Definition T2 structural behavior', () => {
  const profile = resolveStructuralProfile({
    site: 'astrologywiki',
    locale: 'en',
    template: 'Definition',
    contentTier: 'T2',
    manifest: {},
  });

  assert.equal(profile.version, 'seo-structure-v1');
  assert.deepEqual(profile.h2Range, [11, 11]);
  assert.deepEqual(profile.wordRange, [1500, 1800]);
  assert.deepEqual(profile.effectiveWordRange, [1485, 1800]);
  assert.deepEqual(profile.keywordRange, [5, 8]);
  assert.deepEqual(profile.internalLinkRange, [3, null]);
  assert.equal(profile.allowH3, true);
  assert.equal(profile.maxH4, 0);
  assert.equal(profile.faqMinimum, 3);
  assert.deepEqual(profile.tableMinimum, { columns: 4, rows: 3 });
});

test('legacy Pillar manifest keeps its exact structural defaults plus one-percent lower word tolerance', () => {
  const profile = resolveStructuralProfile({
    template: 'Pillar',
    contentTier: 'T1',
    manifest: {},
  });

  assert.deepEqual(profile.h2Range, [11, 11]);
  assert.deepEqual(profile.wordRange, [2500, 3500]);
  assert.deepEqual(profile.effectiveWordRange, [2475, 3500]);
  assert.deepEqual(profile.keywordRange, [8, 12]);
  assert.deepEqual(profile.internalLinkRange, [5, null]);
});

test('profile allows a declared optional section without weakening other safety thresholds', () => {
  const profile = resolveStructuralProfile({
    template: 'Definition',
    contentTier: 'T2',
    manifest: {
      structural_profile: {
        version: 'seo-structure-v1',
        h2_range: [11, 12],
      },
    },
  });

  assert.deepEqual(profile.h2Range, [11, 12]);
  assert.deepEqual(profile.keywordRange, [5, 8]);
  assert.equal(profile.faqMinimum, 3);
  assert.deepEqual(profile.tableMinimum, { columns: 4, rows: 3 });
});

test('one-percent word tolerance accepts 1497 for a 1500 minimum', () => {
  const profile = resolveStructuralProfile({
    template: 'Definition',
    contentTier: 'T2',
    manifest: {},
  });
  assert.equal(profile.effectiveWordRange[0], 1485);
  assert.equal(1497 >= profile.effectiveWordRange[0], true);
});

test('unsupported profile version fails closed', () => {
  assert.throws(() => resolveStructuralProfile({
    template: 'Definition',
    contentTier: 'T2',
    manifest: {
      structural_profile: {
        version: 'seo-structure-v2',
        h2_range: [11, 12],
      },
    },
  }), /unsupported structural profile version/i);
});

test('inverted or excessive explicit ranges fail closed', () => {
  assert.throws(() => resolveStructuralProfile({
    template: 'Definition',
    manifest: {
      structural_profile: {
        version: 'seo-structure-v1',
        h2_range: [12, 11],
      },
    },
  }), /h2_range.*invalid|invalid.*h2_range/i);

  assert.throws(() => resolveStructuralProfile({
    template: 'Definition',
    manifest: {
      structural_profile: {
        version: 'seo-structure-v1',
        h2_range: [11, 1000],
      },
    },
  }), /h2_range.*bounded|h2_range.*invalid|invalid.*h2_range/i);
});
