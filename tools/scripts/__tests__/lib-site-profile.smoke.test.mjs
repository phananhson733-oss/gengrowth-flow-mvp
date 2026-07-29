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
  DEFAULT_PUBLISH_REPO,
  publishRepo,
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

test('configSnapshotPath: default and non-default never collide', () => {
  const def = configSnapshotPath(ROOT, {});
  const gg = configSnapshotPath(ROOT, { GG_SITE: 'gengrowth' });
  assert.notEqual(def, gg);
});

// --- publishRepo: the `gh --repo` slug ---------------------------------------
// The slug was copy-pasted into 4 scripts / 8 call sites. When the oracle repo
// moved GitHub accounts on 2026-07-27 the old one started 404ing, priming every
// publish-path `gh` call to fail the moment autopilot restarted.

test('publishRepo: defaults to the current publish repo', () => {
  assert.equal(publishRepo({}), DEFAULT_PUBLISH_REPO);
  assert.equal(publishRepo({ GG_SITE: 'oracle' }), DEFAULT_PUBLISH_REPO);
});

test('publishRepo: GG_PUBLISH_REPO overrides', () => {
  assert.equal(publishRepo({ GG_PUBLISH_REPO: 'someone/fork' }), 'someone/fork');
});

test('publishRepo: blank override falls back rather than emitting an empty --repo', () => {
  // An empty --repo makes gh resolve against the cwd remote, which silently
  // targets whatever repo the caller happens to be standing in.
  for (const blank of ['', '   ', '\t']) {
    assert.equal(publishRepo({ GG_PUBLISH_REPO: blank }), DEFAULT_PUBLISH_REPO);
  }
});

test('publishRepo: the retired slug is gone', () => {
  assert.notEqual(DEFAULT_PUBLISH_REPO, 'xdawayer/oracle');
  assert.match(DEFAULT_PUBLISH_REPO, /^[\w.-]+\/[\w.-]+$/, 'must be owner/name for gh --repo');
});
