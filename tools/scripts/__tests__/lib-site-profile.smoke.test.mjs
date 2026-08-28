#!/usr/bin/env node
// Smoke test for lib/site-profile.mjs — GG_SITE multi-site resolver.
//
// Guards the load-bearing invariant: the DEFAULT path (GG_SITE unset / 'oracle'
// / unknown) must reproduce the original single-site behavior byte-for-byte,
// while a recognized non-default site gets an ISOLATED config-snapshot path so
// gg-config-sync for a second workbook can never clobber oracle's snapshot.
//
// Run: node --test tools/scripts/__tests__/lib-site-profile.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { join } from 'node:path';

import {
  DEFAULT_SITE,
  activeSite,
  isDefaultSite,
  configSnapshotPath,
  siteCtaHost,
} from '../lib/site-profile.mjs';

const ROOT = '/repo';

test('activeSite: unset / empty / oracle / unknown all resolve to default', () => {
  assert.equal(activeSite({}), 'oracle');
  assert.equal(activeSite({ GG_SITE: '' }), 'oracle');
  assert.equal(activeSite({ GG_SITE: '   ' }), 'oracle');
  assert.equal(activeSite({ GG_SITE: 'oracle' }), 'oracle');
  assert.equal(activeSite({ GG_SITE: 'astrologywiki' }), 'oracle'); // unknown → default
  assert.equal(activeSite({ GG_SITE: 'typo-site' }), 'oracle');
});

test('activeSite: recognized site resolves, case/whitespace-insensitive', () => {
  assert.equal(activeSite({ GG_SITE: 'gengrowth' }), 'gengrowth');
  assert.equal(activeSite({ GG_SITE: 'GenGrowth' }), 'gengrowth');
  assert.equal(activeSite({ GG_SITE: '  GENGROWTH  ' }), 'gengrowth');
});

test('isDefaultSite mirrors activeSite', () => {
  assert.equal(isDefaultSite({}), true);
  assert.equal(isDefaultSite({ GG_SITE: 'oracle' }), true);
  assert.equal(isDefaultSite({ GG_SITE: 'unknown' }), true);
  assert.equal(isDefaultSite({ GG_SITE: 'gengrowth' }), false);
  assert.equal(DEFAULT_SITE, 'oracle');
});

test('configSnapshotPath: default site → original global path (byte-for-byte)', () => {
  const expected = join(ROOT, '.gg-cache', 'config-snapshot.json');
  assert.equal(configSnapshotPath(ROOT, {}), expected);
  assert.equal(configSnapshotPath(ROOT, { GG_SITE: 'oracle' }), expected);
  assert.equal(configSnapshotPath(ROOT, { GG_SITE: 'unknown' }), expected);
});

test('configSnapshotPath: recognized site → isolated per-site path', () => {
  assert.equal(
    configSnapshotPath(ROOT, { GG_SITE: 'gengrowth' }),
    join(ROOT, '.gg-cache', 'sites', 'gengrowth', 'config-snapshot.json'),
  );
});

test('dramashortstv resolves to its own isolated site profile', () => {
  assert.equal(activeSite({ GG_SITE: 'dramashortstv' }), 'dramashortstv');
  assert.equal(isDefaultSite({ GG_SITE: 'dramashortstv' }), false);
  assert.equal(
    configSnapshotPath(ROOT, { GG_SITE: 'dramashortstv' }),
    join(ROOT, '.gg-cache', 'sites', 'dramashortstv', 'config-snapshot.json'),
  );
  assert.equal(siteCtaHost({ GG_SITE: 'dramashortstv' }), 'dramashortstv.com');
});

test('configSnapshotPath: default and non-default never collide', () => {
  const def = configSnapshotPath(ROOT, {});
  const gg = configSnapshotPath(ROOT, { GG_SITE: 'gengrowth' });
  assert.notEqual(def, gg);
});
