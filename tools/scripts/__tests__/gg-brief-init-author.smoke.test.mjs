#!/usr/bin/env node
// Smoke test for gg-brief-init.mjs author routing (Lane B / T3).
// Run: node --test tools/scripts/__tests__/gg-brief-init-author.smoke.test.mjs
//
// Covers renderScaffold author fields on the manual scaffold path:
//   - valid --author → override
//   - --cluster-domain hits author map → auto
//   - no author + no domain → blank author + TODO cluster_domain
//   - illegal --author → rejected (blank)

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { renderScaffold } from '../gg-brief-init.mjs';

const authorMap = new Map([['aura', 'elena-vane']]);

test('renderScaffold: valid --author override', () => {
  const e = renderScaffold({
    pageId: 'page_x', entity: 'Orange Aura', tier: 'T2', template: 'Definition',
    authorOverride: 'Marcus-Orion', authorMap,
  });
  assert.equal(e.author, 'marcus-orion');
  assert.equal(e.author_source, 'override');
});

test('renderScaffold: --cluster-domain hits author map → auto', () => {
  const e = renderScaffold({
    pageId: 'page_x', entity: 'Orange Aura', tier: 'T2', template: 'Definition',
    clusterDomain: 'Aura', authorMap,
  });
  assert.equal(e.author, 'elena-vane');
  assert.equal(e.author_source, 'auto');
  assert.equal(e.cluster_domain, 'aura');
});

test('renderScaffold: no author + no domain → blank author, TODO cluster_domain', () => {
  const e = renderScaffold({
    pageId: 'page_x', entity: 'Orange Aura', tier: 'T2', template: 'Definition',
    authorMap,
  });
  assert.equal(e.author, '');
  assert.equal(e.author_source, undefined);
  assert.match(e.cluster_domain, /^TODO:/);
});

test('renderScaffold: illegal --author → rejected (blank)', () => {
  const e = renderScaffold({
    pageId: 'page_x', entity: 'Orange Aura', tier: 'T2', template: 'Definition',
    authorOverride: 'fake-writer', authorMap,
  });
  assert.equal(e.author, '');
  assert.equal(e.author_source, undefined);
});
