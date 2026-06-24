#!/usr/bin/env node
// Smoke tests for gg-index-monitor.mjs Phase 1 indexing tracker.
// Run: node --test tools/scripts/__tests__/gg-index-monitor.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  INDEX_TRACKING_HEADER,
  INDEX_TRACKING_TAB,
  buildTrackingSeedRow,
  classifyInspection,
  isDueForInspection,
  rowToSheetValues,
  sheetValuesToRow,
} from '../gg-index-monitor.mjs';

test('index tracking schema is a stable ASCII auto tab with Phase 1 fields', () => {
  assert.equal(INDEX_TRACKING_TAB, 'index-tracking');
  assert.deepEqual(INDEX_TRACKING_HEADER.slice(0, 6), [
    'url',
    'page_id',
    'slug',
    'title',
    'published_at',
    'first_tracked_at',
  ]);
  assert.ok(INDEX_TRACKING_HEADER.includes('current_gsc_status'));
  assert.ok(INDEX_TRACKING_HEADER.includes('first_indexed_at'));
  assert.ok(INDEX_TRACKING_HEADER.includes('diagnosis_category'));
  assert.ok(INDEX_TRACKING_HEADER.includes('fix_status'));
});

test('buildTrackingSeedRow creates an idempotent monitor row from a publish event', () => {
  const row = buildTrackingSeedRow({
    pageId: 'PG-TEST-001',
    slug: 'test-slug',
    title: 'A | Pipe Heavy Title',
    author: 'elena-vane',
    publishedAt: '2026-06-24',
    now: new Date('2026-06-24T09:00:00.000Z'),
  });

  assert.equal(row.url, 'https://www.astrologywiki.com/en/wiki/test-slug');
  assert.equal(row.page_id, 'PG-TEST-001');
  assert.equal(row.slug, 'test-slug');
  assert.equal(row.title, 'A / Pipe Heavy Title');
  assert.equal(row.published_at, '2026-06-24');
  assert.equal(row.first_tracked_at, '2026-06-24');
  assert.equal(row.monitor_status, 'monitoring');
  assert.equal(row.fix_status, '未处理');
  assert.equal(row.retry_round, 0);
  assert.equal(row.source, 'seo-autopilot');
  assert.equal(row.author, 'elena-vane');
});

test('sheetValuesToRow and rowToSheetValues round-trip by header order', () => {
  const row = buildTrackingSeedRow({
    pageId: 'PG-TEST-002',
    slug: 'round-trip',
    title: 'Round Trip',
    publishedAt: '2026-06-24',
    now: new Date('2026-06-24T10:00:00.000Z'),
  });
  const values = rowToSheetValues(row);
  assert.equal(values.length, INDEX_TRACKING_HEADER.length);
  assert.equal(values[0], row.url);
  assert.equal(values[1], 'PG-TEST-002');

  const parsed = sheetValuesToRow(values);
  assert.equal(parsed.url, row.url);
  assert.equal(parsed.page_id, 'PG-TEST-002');
  assert.equal(parsed.monitor_status, 'monitoring');
});

test('classifyInspection treats indexed pages as done without alerts', () => {
  const result = classifyInspection({
    verdict: 'PASS',
    coverageState: 'Submitted and indexed',
    indexingState: 'INDEXING_ALLOWED',
    pageFetchState: 'SUCCESSFUL',
    lastCrawlTime: '2026-06-24T01:00:00Z',
  }, { daysSinceFirstTracked: 7, now: new Date('2026-06-24T09:00:00Z') });

  assert.equal(result.monitor_status, 'indexed');
  assert.equal(result.diagnosis_category, 'indexed');
  assert.equal(result.alert_level, '');
  assert.equal(result.should_alert, false);
  assert.equal(result.first_indexed_at, '2026-06-24');
});

test('classifyInspection waits until D+21 for discovered-not-indexed queue noise', () => {
  const d14 = classifyInspection({
    verdict: 'NEUTRAL',
    coverageState: 'Discovered - currently not indexed',
  }, { daysSinceFirstTracked: 14, now: new Date('2026-06-24T09:00:00Z') });
  assert.equal(d14.monitor_status, 'monitoring');
  assert.equal(d14.diagnosis_category, 'normal_queue');
  assert.equal(d14.alert_level, '');
  assert.equal(d14.should_alert, false);

  const d21 = classifyInspection({
    verdict: 'NEUTRAL',
    coverageState: 'Discovered - currently not indexed',
  }, { daysSinceFirstTracked: 21, now: new Date('2026-06-24T09:00:00Z') });
  assert.equal(d21.monitor_status, 'needs_attention');
  assert.equal(d21.alert_level, 'P2');
  assert.equal(d21.should_alert, true);
});

test('classifyInspection alerts at D+14 for crawled-not-indexed', () => {
  const result = classifyInspection({
    verdict: 'NEUTRAL',
    coverageState: 'Crawled - currently not indexed',
  }, { daysSinceFirstTracked: 14, now: new Date('2026-06-24T09:00:00Z') });

  assert.equal(result.monitor_status, 'needs_attention');
  assert.equal(result.diagnosis_category, 'content_quality');
  assert.equal(result.alert_level, 'P1');
  assert.equal(result.should_alert, true);
  assert.match(result.recommendation, /content quality/i);
});

test('classifyInspection escalates hard crawl failures immediately', () => {
  for (const coverageState of ['Not found (404)', 'Server error (5xx)', 'Blocked due to access forbidden (403)']) {
    const result = classifyInspection({ verdict: 'FAIL', coverageState }, {
      daysSinceFirstTracked: 1,
      now: new Date('2026-06-24T09:00:00Z'),
    });
    assert.equal(result.monitor_status, 'urgent');
    assert.equal(result.alert_level, 'P0');
    assert.equal(result.should_alert, true);
  }
});

test('isDueForInspection checks D+3/D+7/D+14/D+21/D+30 milestones once each', () => {
  const base = {
    first_tracked_at: '2026-06-10',
    monitor_status: 'monitoring',
    last_checked_at: '',
  };
  assert.equal(isDueForInspection(base, new Date('2026-06-12T09:00:00Z')), false);
  assert.equal(isDueForInspection(base, new Date('2026-06-13T09:00:00Z')), true);
  assert.equal(isDueForInspection({ ...base, last_checked_at: '2026-06-13' }, new Date('2026-06-13T12:00:00Z')), false);
  assert.equal(isDueForInspection({ ...base, last_checked_at: '2026-06-13' }, new Date('2026-06-17T09:00:00Z')), true);
  assert.equal(isDueForInspection({ ...base, monitor_status: 'indexed' }, new Date('2026-06-24T09:00:00Z')), false);
});
