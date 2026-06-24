#!/usr/bin/env node
// Smoke tests for gg-index-monitor.mjs Phase 1 indexing tracker.
// Run: node --test tools/scripts/__tests__/gg-index-monitor.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TABS } from '../lib/_workbook-spec.mjs';
import {
  INDEX_TRACKING_HEADER,
  INDEX_TRACKING_TAB,
  buildTrackingSeedRow,
  classifyInspection,
  isDueForInspection,
  rowToSheetValues,
  runIndexMonitor,
  sheetValuesToRow,
} from '../gg-index-monitor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(__dirname, '..');

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

test('workbook spec declares the index-tracking auto tab', () => {
  const tab = TABS.find((t) => t.name === INDEX_TRACKING_TAB);
  assert.ok(tab, 'index-tracking tab must be part of the workbook spec');
  assert.deepEqual(tab.header, [...INDEX_TRACKING_HEADER]);
  assert.equal(tab.type, 'standard');
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

test('classifyInspection treats alternate canonical pages as normal canonicalization', () => {
  const result = classifyInspection({
    verdict: 'PASS',
    coverageState: 'Alternate page with proper canonical tag',
  }, { daysSinceFirstTracked: 30, now: new Date('2026-06-24T09:00:00Z') });

  assert.equal(result.monitor_status, 'canonical_ok');
  assert.equal(result.diagnosis_category, 'normal_canonical');
  assert.equal(result.alert_level, '');
  assert.equal(result.should_alert, false);
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

test('classifyInspection escalates unresolved non-indexed pages at D+30', () => {
  const result = classifyInspection({
    verdict: 'NEUTRAL',
    coverageState: 'Crawled - currently not indexed',
  }, { daysSinceFirstTracked: 30, now: new Date('2026-06-24T09:00:00Z') });

  assert.equal(result.monitor_status, 'needs_focus');
  assert.equal(result.alert_level, 'P1');
  assert.equal(result.should_alert, true);
  assert.match(result.recommendation, /escalate|重点/i);
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

test('runIndexMonitor sends a D+30 upgrade even after an earlier lower-level alert', async () => {
  let updated = null;
  let notified = null;
  const code = await runIndexMonitor(['--check-due', '--write-sheet', '--workbook', 'wb-test'], {
    now: new Date('2026-06-24T09:00:00Z'),
    sheetToken: 'sheet-token',
    gscToken: 'gsc-token',
    ensureIndexTrackingTab: async () => INDEX_TRACKING_TAB,
    readTrackingRows: async () => [{
      _rowNumber: 2,
      url: 'https://www.astrologywiki.com/en/wiki/d30-test',
      page_id: 'PG-D30-001',
      title: 'D30 Test',
      first_tracked_at: '2026-05-25',
      last_checked_at: '2026-06-15',
      monitor_status: 'needs_attention',
      alert_level: 'P2',
      alert_sent_at: '2026-06-15',
      check_count: 2,
    }],
    fetchUrlInspection: async () => ({
      verdict: 'NEUTRAL',
      coverageState: 'Crawled - currently not indexed',
    }),
    updateTrackingRow: async (token, workbookId, tabName, rowNumber, row) => {
      updated = { token, workbookId, tabName, rowNumber, row };
    },
    notify: (message) => {
      notified = message;
    },
  });

  assert.equal(code, 0);
  assert.equal(updated.row.monitor_status, 'needs_focus');
  assert.equal(updated.row.alert_level, 'P1');
  assert.equal(updated.row.alert_sent_at, '2026-06-24');
  assert.match(notified, /D30 Test/);
});

test('seo autopilot enqueues index tracking instead of calling article Indexing API', () => {
  const src = readFileSync(join(SCRIPTS, 'gg-seo-autopilot.mjs'), 'utf8');
  assert.match(src, /gg-index-monitor\.mjs/);
  assert.match(src, /--enqueue-published/);
  assert.doesNotMatch(src, /scripts\/gsc-index-submit\.mjs/);
});

test('gengrowth article publisher does not use Google Indexing API for ordinary articles', () => {
  const src = readFileSync(join(SCRIPTS, 'gg-gengrowth-publish.mjs'), 'utf8');
  assert.doesNotMatch(src, /gsc-index-submit\.mjs/);
  assert.doesNotMatch(src, /Google Indexing API submit/);
});

test('launchd wrapper runs only the lightweight index monitor check', () => {
  const wrapper = readFileSync(join(SCRIPTS, 'gg-index-monitor-tick.sh'), 'utf8');
  assert.match(wrapper, /gg-index-monitor\.mjs/);
  assert.match(wrapper, /--check-due/);
  assert.match(wrapper, /--write-sheet/);
  assert.doesNotMatch(wrapper, /gg-seo-autopilot-tick|gg-seo-author-tick/);

  const plist = readFileSync(join(SCRIPTS, 'com.gengrowth.index-monitor.plist'), 'utf8');
  assert.match(plist, /com\.gengrowth\.index-monitor/);
  assert.match(plist, /gg-index-monitor-tick\.sh/);
  assert.match(plist, /StartCalendarInterval/);
});

test('runIndexMonitor --ensure-tab creates the tracking sheet without GSC calls', async () => {
  let ensured = null;
  const code = await runIndexMonitor(['--ensure-tab', '--workbook', 'wb-test'], {
    sheetToken: 'sheet-token',
    ensureIndexTrackingTab: async (token, workbookId) => {
      ensured = { token, workbookId };
      return INDEX_TRACKING_TAB;
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(ensured, { token: 'sheet-token', workbookId: 'wb-test' });
});

test('runIndexMonitor --check-due skips GSC token when no rows are due', async () => {
  let readArgs = null;
  const code = await runIndexMonitor(['--check-due', '--workbook', 'wb-test'], {
    sheetToken: 'sheet-token',
    readTrackingRows: async (token, workbookId, tabName) => {
      readArgs = { token, workbookId, tabName };
      return [];
    },
    getGscToken: async () => {
      throw new Error('GSC token should not be requested for an empty due set');
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(readArgs, {
    token: 'sheet-token',
    workbookId: 'wb-test',
    tabName: INDEX_TRACKING_TAB,
  });
});
