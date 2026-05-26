#!/usr/bin/env node
// Smoke test for gg-status.mjs author-assignment pre-flight (Lane B / T8).
// Run: node --test tools/scripts/__tests__/gg-status-author-preflight.smoke.test.mjs
//
// Covers:
//   - pending page (override present, not published) with blank author → flagged
//   - pending page with cluster_domain not in author.map → flagged unmapped
//   - assigned page (author present, domain mapped) → not flagged
//   - published page with gap → NOT flagged (already shipped)
//   - report renderer lists the gaps / says "no gaps" when clean

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  auditAuthorAssignment,
  renderAuthorPreflight,
} from '../gg-status.mjs';
import { buildAuthorMap, AUTHOR_MAP_PREFIX } from '../lib/author-routing.mjs';

function makeRow(o = {}) {
  return {
    page_id: 'page_x',
    author: '',
    author_source: '',
    cluster_domain: '',
    override_path: '.gg-cache/overrides/x.json',
    wiki_published_path: '',
    ...o,
  };
}

const authorMap = buildAuthorMap({ [`${AUTHOR_MAP_PREFIX}aura`]: 'elena-vane' }).map;

test('auditAuthorAssignment: pending page with blank author → missingAuthor', () => {
  const rows = [makeRow({ page_id: 'page_blank', author: '', cluster_domain: 'aura' })];
  const report = auditAuthorAssignment(rows, authorMap);
  assert.equal(report.missingAuthor.length, 1);
  assert.equal(report.missingAuthor[0].page_id, 'page_blank');
});

test('auditAuthorAssignment: pending page, domain not in author.map → unmappedDomain', () => {
  const rows = [makeRow({ page_id: 'page_unmapped', author: '', cluster_domain: 'nodes' })];
  const report = auditAuthorAssignment(rows, authorMap);
  // blank author → also missingAuthor; domain unmapped → unmappedDomain too
  assert.ok(report.unmappedDomain.some((u) => u.page_id === 'page_unmapped'));
});

test('auditAuthorAssignment: assigned page (author + mapped domain) → no flags', () => {
  const rows = [makeRow({ page_id: 'page_ok', author: 'elena-vane', author_source: 'auto', cluster_domain: 'aura' })];
  const report = auditAuthorAssignment(rows, authorMap);
  assert.equal(report.missingAuthor.length, 0);
  assert.equal(report.unmappedDomain.length, 0);
});

test('auditAuthorAssignment: override page with unmapped domain → NOT unmappedDomain', () => {
  // explicit override is intentional; an unmapped domain is fine since the human chose.
  const rows = [makeRow({ page_id: 'page_ovr', author: 'julian-thorne', author_source: 'override', cluster_domain: 'nodes' })];
  const report = auditAuthorAssignment(rows, authorMap);
  assert.equal(report.missingAuthor.length, 0);
  assert.equal(report.unmappedDomain.length, 0);
});

test('auditAuthorAssignment: published page with gap → NOT flagged', () => {
  const rows = [makeRow({
    page_id: 'page_shipped', author: '', cluster_domain: 'nodes',
    wiki_published_path: '内容资产/astrologywiki/batch/page_shipped.md',
  })];
  const report = auditAuthorAssignment(rows, authorMap);
  assert.equal(report.missingAuthor.length, 0);
  assert.equal(report.unmappedDomain.length, 0);
});

test('auditAuthorAssignment: no override (not yet briefed) → not pending, skipped', () => {
  const rows = [makeRow({ page_id: 'page_nobrief', override_path: '', author: '' })];
  const report = auditAuthorAssignment(rows, authorMap);
  assert.equal(report.missingAuthor.length, 0);
});

test('renderAuthorPreflight: clean report says no gaps', () => {
  const out = renderAuthorPreflight({ missingAuthor: [], unmappedDomain: [] });
  assert.match(out, /No gaps|no gaps/);
});

test('renderAuthorPreflight: lists missing-author + unmapped pages', () => {
  const out = renderAuthorPreflight({
    missingAuthor: [{ page_id: 'page_blank', cluster_domain: 'aura' }],
    unmappedDomain: [{ page_id: 'page_unmapped', cluster_domain: 'nodes' }],
  });
  assert.match(out, /page_blank/);
  assert.match(out, /page_unmapped/);
  assert.match(out, /author\.map\.nodes/);
});
