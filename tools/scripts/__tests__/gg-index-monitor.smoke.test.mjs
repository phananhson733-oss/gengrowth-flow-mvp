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
  REQUEST_INDEXING_QUEUE_HEADER,
  REQUEST_INDEXING_QUEUE_TAB,
  RECAP_TAB,
  buildRequestIndexingCandidateRows,
  buildTrackingSeedRow,
  classifyInspection,
  extractEnWikiSitemapRows,
  formatAlertMessage,
  isDueForInspection,
  mergeInspectionIntoRow,
  mergePublishedTrackingRow,
  preflightGscAccess,
  recapRowFromTrackingRow,
  rowToSheetValues,
  runIndexMonitor,
  sheetValuesToRow,
  submitSitemap,
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

test('workbook spec declares the request-indexing queue tab', () => {
  const tab = TABS.find((t) => t.name === REQUEST_INDEXING_QUEUE_TAB);
  assert.ok(tab, 'request-indexing-queue tab must be part of the workbook spec');
  assert.deepEqual(tab.header, [...REQUEST_INDEXING_QUEUE_HEADER]);
  assert.equal(tab.type, 'standard');
});

test('buildTrackingSeedRow creates an idempotent monitor row from a publish event', () => {
  const row = buildTrackingSeedRow({
    pageId: 'PG-TEST-001',
    slug: 'test-slug',
    title: 'A | Pipe Heavy Title',
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
  assert.equal(row.fix_status, '已提交');
  assert.equal(row.retry_round, 0);
  assert.equal(row.source, 'seo-autopilot');
});

test('extractEnWikiSitemapRows copies only live EN wiki article URLs from sitemap XML', () => {
  const rows = extractEnWikiSitemapRows(`
    <url><loc>https://www.astrologywiki.com/en/wiki/bruno-fernandes-zodiac-sign</loc><lastmod>2026-06-24</lastmod></url>
    <url><loc>https://www.astrologywiki.com/zh/wiki/bruno-fernandes-zodiac-sign</loc><lastmod>2026-06-24</lastmod></url>
    <url><loc>https://www.astrologywiki.com/en/wiki</loc><lastmod>2026-06-24</lastmod></url>
    <url><loc>https://www.astrologywiki.com/en/tools</loc><lastmod>2026-06-24</lastmod></url>
  `, { now: new Date('2026-06-25T00:00:00Z') });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'https://www.astrologywiki.com/en/wiki/bruno-fernandes-zodiac-sign');
  assert.equal(rows[0].slug, 'bruno-fernandes-zodiac-sign');
  assert.equal(rows[0].title, 'Bruno Fernandes Zodiac Sign');
  assert.equal(rows[0].page_id, '');
  assert.equal(rows[0].published_at, '2026-06-24');
  assert.equal(rows[0].first_tracked_at, '2026-06-24');
  assert.equal(rows[0].source, 'live-sitemap');
});

test('mergePublishedTrackingRow refreshes source fields without clobbering GSC state', () => {
  const existing = {
    ...buildTrackingSeedRow({
      pageId: 'PG-OLD',
      slug: 'old-slug',
      url: 'https://www.astrologywiki.com/en/wiki/bruno-fernandes-zodiac-sign',
      title: 'Old Title',
      publishedAt: '2026-06-20',
      now: new Date('2026-06-20T00:00:00Z'),
    }),
    _rowNumber: 7,
    last_checked_at: '2026-06-24',
    check_count: 3,
    current_gsc_status: 'Crawled - currently not indexed',
    monitor_status: 'needs_attention',
    alert_level: 'P1',
    notes: 'human note',
  };
  const fresh = buildTrackingSeedRow({
    slug: 'bruno-fernandes-zodiac-sign',
    url: 'https://www.astrologywiki.com/en/wiki/bruno-fernandes-zodiac-sign',
    title: 'Bruno Fernandes Zodiac Sign',
    publishedAt: '2026-06-24',
    now: new Date('2026-06-25T00:00:00Z'),
    firstTrackedAt: '2026-06-24',
    source: 'live-sitemap',
  });

  const merged = mergePublishedTrackingRow(existing, fresh);
  assert.equal(merged.slug, 'bruno-fernandes-zodiac-sign');
  assert.equal(merged.title, 'Bruno Fernandes Zodiac Sign');
  assert.equal(merged.published_at, '2026-06-24');
  assert.equal(merged.source, 'live-sitemap');
  assert.equal(merged.first_tracked_at, '2026-06-20');
  assert.equal(merged.last_checked_at, '2026-06-24');
  assert.equal(merged.current_gsc_status, 'Crawled - currently not indexed');
  assert.equal(merged.monitor_status, 'needs_attention');
  assert.equal(merged.notes, 'human note');
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

test('classifyInspection alerts at D+14 for discovered-not-indexed', () => {
  const d7 = classifyInspection({
    verdict: 'NEUTRAL',
    coverageState: 'Discovered - currently not indexed',
  }, { daysSinceFirstTracked: 7, now: new Date('2026-06-24T09:00:00Z') });
  assert.equal(d7.monitor_status, 'monitoring');
  assert.equal(d7.diagnosis_category, 'normal_queue');
  assert.equal(d7.alert_level, '');
  assert.equal(d7.should_alert, false);

  const d14 = classifyInspection({
    verdict: 'NEUTRAL',
    coverageState: 'Discovered - currently not indexed',
  }, { daysSinceFirstTracked: 14, now: new Date('2026-06-24T09:00:00Z') });
  assert.equal(d14.monitor_status, 'needs_attention');
  assert.equal(d14.alert_level, 'P2');
  assert.equal(d14.should_alert, true);
  assert.match(d14.recommendation, /D\+14/);
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

test('isDueForInspection checks D+3/D+7/D+14/D+30 milestones once each', () => {
  const base = {
    first_tracked_at: '2026-06-01',
    monitor_status: 'monitoring',
    last_checked_at: '',
  };
  assert.equal(isDueForInspection(base, new Date('2026-06-03T09:00:00Z')), false);
  assert.equal(isDueForInspection(base, new Date('2026-06-04T09:00:00Z')), true);
  assert.equal(isDueForInspection({ ...base, last_checked_at: '2026-06-04' }, new Date('2026-06-04T12:00:00Z')), false);
  assert.equal(isDueForInspection({ ...base, last_checked_at: '2026-06-04' }, new Date('2026-06-08T09:00:00Z')), true);
  assert.equal(isDueForInspection({ ...base, last_checked_at: '2026-06-15' }, new Date('2026-06-22T09:00:00Z')), false);
  assert.equal(isDueForInspection({ ...base, last_checked_at: '2026-06-15' }, new Date('2026-07-01T09:00:00Z')), true);
  assert.equal(isDueForInspection({ ...base, monitor_status: 'indexed' }, new Date('2026-06-24T09:00:00Z')), false);
});

test('mergeInspectionIntoRow writes the Chinese monitoring lifecycle status', () => {
  const base = {
    url: 'https://www.astrologywiki.com/en/wiki/lifecycle',
    page_id: 'PG-LIFE',
    title: 'Lifecycle Test',
    first_tracked_at: '2026-06-10',
    check_count: 0,
  };

  const overdue = mergeInspectionIntoRow(base, {
    verdict: 'NEUTRAL',
    coverageState: 'Crawled - currently not indexed',
  }, new Date('2026-06-24T09:00:00Z'));
  assert.equal(overdue.row.fix_status, '⚠️ 超期未收录（触发诊断）');

  const focus = mergeInspectionIntoRow(base, {
    verdict: 'NEUTRAL',
    coverageState: 'Crawled - currently not indexed',
  }, new Date('2026-07-10T09:00:00Z'));
  assert.equal(focus.row.fix_status, '需重点关注');

  const urgent = mergeInspectionIntoRow(base, {
    verdict: 'FAIL',
    coverageState: 'Not found (404)',
  }, new Date('2026-06-11T09:00:00Z'));
  assert.equal(urgent.row.fix_status, '🔴 紧急问题（404/5xx）');

  const indexed = mergeInspectionIntoRow(base, {
    verdict: 'PASS',
    coverageState: 'Submitted and indexed',
  }, new Date('2026-06-17T09:00:00Z'));
  assert.equal(indexed.row.fix_status, '✅ 已收录');
});

test('formatAlertMessage uses the D+14 indexing overdue reminder format', () => {
  const message = formatAlertMessage({
    title: 'Lifecycle Test',
    url: 'https://www.astrologywiki.com/en/wiki/lifecycle',
    page_id: 'PG-LIFE',
    published_at: '2026-06-10',
    days_since_first_tracked: 14,
    current_gsc_status: 'Crawled - currently not indexed',
    recommendation: 'Review content quality, internal links, duplicate overlap, metadata, and crawlable HTML.',
  }, {
    alert_level: 'P1',
    diagnosis_category: 'content_quality',
    recommendation: 'fallback',
  });

  assert.match(message, /^⚠️ 索引超期提醒/m);
  assert.match(message, /页面：Lifecycle Test/);
  assert.match(message, /URL：https:\/\/www\.astrologywiki\.com\/en\/wiki\/lifecycle/);
  assert.match(message, /发布日期：2026-06-10/);
  assert.match(message, /已过天数：D\+14/);
  assert.match(message, /当前 GSC 状态：Crawled - currently not indexed/);
  assert.match(message, /建议操作：Review content quality/);
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

test('recapRowFromTrackingRow presents latest GSC URL Inspection status in result recap fields', () => {
  const indexed = recapRowFromTrackingRow({
    url: 'https://www.astrologywiki.com/en/wiki/bruno-fernandes-zodiac-sign',
    page_id: 'PG-WC-033',
    current_gsc_status: 'Submitted and indexed',
    gsc_verdict: 'PASS',
    monitor_status: 'indexed',
    diagnosis_category: 'indexed',
    last_checked_at: '2026-06-24',
    source: 'live-sitemap',
  }, { now: new Date('2026-06-25T00:00:00Z') });

  assert.equal(indexed.outcome_id, 'out_PG-WC-033_latest');
  assert.equal(indexed.url, 'https://www.astrologywiki.com/en/wiki/bruno-fernandes-zodiac-sign');
  assert.equal(indexed.day14_收录, 'Y');
  assert.equal(indexed.索引修复状态, '已收录');
  assert.equal(indexed.记录日期, '2026-06-25');
  assert.match(indexed.备注, /GSC URL Inspection/);

  const notIndexed = recapRowFromTrackingRow({
    url: 'https://www.astrologywiki.com/en/wiki/luka-modric-zodiac-sign',
    current_gsc_status: 'Crawled - currently not indexed',
    monitor_status: 'needs_attention',
    diagnosis_category: 'content_quality',
    last_checked_at: '2026-06-24',
  }, { now: new Date('2026-06-25T00:00:00Z') });
  assert.equal(notIndexed.outcome_id, 'out_luka-modric-zodiac-sign_latest');
  assert.equal(notIndexed.day14_收录, 'N');
  assert.match(notIndexed.索引修复状态, /needs_attention/);
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
  assert.match(wrapper, /--sync-published/);
  assert.match(wrapper, /--submit-sitemap/);
  assert.match(wrapper, /--check-due/);
  assert.match(wrapper, /--sync-recap/);
  assert.match(wrapper, /--sync-request-queue/);
  assert.match(wrapper, /--write-sheet/);
  assert.match(wrapper, /--require-gsc-auth/);
  assert.match(wrapper, /rc=\$\{rc\}）。请查看 \$\{LOG\}/);
  assert.match(wrapper, /rc=\$\{rc\}）。请查看 \$\{LOG\}；/);
  assert.match(wrapper, /GSC reader SA 权限/);
  assert.doesNotMatch(wrapper, /oauth-init|refresh_token|Google OAuth/);
  assert.doesNotMatch(wrapper, /gg-seo-autopilot-tick|gg-seo-author-tick/);

  const plist = readFileSync(join(SCRIPTS, 'com.gengrowth.index-monitor.plist'), 'utf8');
  assert.match(plist, /com\.gengrowth\.index-monitor/);
  assert.match(plist, /gg-index-monitor-tick\.sh/);
  assert.match(plist, /StartCalendarInterval/);
});

test('index monitor automation mints Sheets tokens from service account, not testing OAuth', () => {
  const src = readFileSync(join(SCRIPTS, 'gg-index-monitor.mjs'), 'utf8');
  assert.doesNotMatch(src, /_oauth-token\.mjs/);
  assert.match(src, /spreadsheets/);
  assert.match(src, /getSaAccessToken/);
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

test('runIndexMonitor --sync-published upserts live sitemap EN URLs into the staging tab', async () => {
  const appended = [];
  let updated = null;
  const code = await runIndexMonitor(['--sync-published', '--write-sheet', '--workbook', 'wb-test'], {
    now: new Date('2026-06-25T00:00:00Z'),
    sheetToken: 'sheet-token',
    sitemapRows: extractEnWikiSitemapRows(`
      <url><loc>https://www.astrologywiki.com/en/wiki/existing-live</loc><lastmod>2026-06-24</lastmod></url>
      <url><loc>https://www.astrologywiki.com/en/wiki/new-live</loc><lastmod>2026-06-24</lastmod></url>
      <url><loc>https://www.astrologywiki.com/en/wiki/site-native-live</loc><lastmod>2026-06-24</lastmod></url>
      <url><loc>https://www.astrologywiki.com/zh/wiki/new-live</loc><lastmod>2026-06-24</lastmod></url>
    `),
    ensureIndexTrackingTab: async () => INDEX_TRACKING_TAB,
    readRecapRows: async () => [{
      page_id: 'PG-EXISTING',
      url: 'https://www.astrologywiki.com/en/wiki/existing-live',
    }, {
      page_id: 'PG-NEW',
      url: 'https://www.astrologywiki.com/en/wiki/new-live',
    }],
    readTrackingRows: async () => [{
      ...buildTrackingSeedRow({
        pageId: 'PG-EXISTING',
        slug: 'existing-live',
        url: 'https://www.astrologywiki.com/en/wiki/existing-live',
        title: '',
        publishedAt: '2026-06-20',
        now: new Date('2026-06-20T00:00:00Z'),
      }),
      _rowNumber: 2,
      current_gsc_status: 'Submitted and indexed',
      monitor_status: 'indexed',
    }],
    updateTrackingRow: async (token, workbookId, tabName, rowNumber, row) => {
      updated = { token, workbookId, tabName, rowNumber, row };
    },
    appendTrackingRows: async (token, workbookId, tabName, rows) => {
      appended.push(...rows);
    },
  });

  assert.equal(code, 0);
  assert.equal(updated.rowNumber, 2);
  assert.equal(updated.row.page_id, 'PG-EXISTING');
  assert.equal(updated.row.title, 'Existing Live');
  assert.equal(updated.row.current_gsc_status, 'Submitted and indexed');
  assert.equal(updated.row.source, 'live-sitemap');
  assert.equal(appended.length, 1);
  assert.equal(appended[0].url, 'https://www.astrologywiki.com/en/wiki/new-live');
  assert.equal(appended[0].page_id, 'PG-NEW');
  assert.equal(appended[0].title, 'New Live');
});

test('runIndexMonitor --sync-published can batch update tracking rows', async () => {
  let batched = null;
  const code = await runIndexMonitor(['--sync-published', '--write-sheet', '--workbook', 'wb-test'], {
    now: new Date('2026-06-25T00:00:00Z'),
    sheetToken: 'sheet-token',
    sitemapRows: extractEnWikiSitemapRows(`
      <url><loc>https://www.astrologywiki.com/en/wiki/existing-live</loc><lastmod>2026-06-24</lastmod></url>
    `),
    ensureIndexTrackingTab: async () => INDEX_TRACKING_TAB,
    readRecapRows: async () => [],
    readTrackingRows: async () => [{
      ...buildTrackingSeedRow({
        pageId: 'PG-EXISTING',
        slug: 'existing-live',
        url: 'https://www.astrologywiki.com/en/wiki/existing-live',
        title: '',
        publishedAt: '2026-06-20',
        now: new Date('2026-06-20T00:00:00Z'),
      }),
      _rowNumber: 2,
    }],
    batchUpdateTrackingRows: async (token, workbookId, tabName, updates, appends) => {
      batched = { token, workbookId, tabName, updates, appends };
    },
    updateTrackingRow: async () => {
      throw new Error('per-row update should not be used when batch is available');
    },
  });

  assert.equal(code, 0);
  assert.equal(batched.tabName, INDEX_TRACKING_TAB);
  assert.equal(batched.updates.length, 1);
  assert.equal(batched.appends.length, 0);
  assert.equal(batched.updates[0].merged.title, 'Existing Live');
});

test('runIndexMonitor --sync-recap upserts only page_id-backed final presentation rows', async () => {
  const appended = [];
  let updated = null;
  const code = await runIndexMonitor(['--sync-recap', '--write-sheet', '--workbook', 'wb-test'], {
    now: new Date('2026-06-25T00:00:00Z'),
    sheetToken: 'sheet-token',
    readTrackingRows: async () => [{
      url: 'https://www.astrologywiki.com/en/wiki/existing-live',
      page_id: 'PG-EXISTING',
      current_gsc_status: 'Submitted and indexed',
      gsc_verdict: 'PASS',
      monitor_status: 'indexed',
      last_checked_at: '2026-06-24',
      source: 'live-sitemap',
    }, {
      url: 'https://www.astrologywiki.com/en/wiki/new-live',
      page_id: '',
      current_gsc_status: 'Crawled - currently not indexed',
      monitor_status: 'needs_attention',
      diagnosis_category: 'content_quality',
      last_checked_at: '2026-06-24',
      source: 'live-sitemap',
    }, {
      url: 'https://www.astrologywiki.com/zh/wiki/ignored',
      current_gsc_status: 'Submitted and indexed',
      monitor_status: 'indexed',
    }],
    readRecapRows: async () => [{
      _rowNumber: 9,
      outcome_id: '',
      page_id: 'PG-EXISTING',
      url: 'https://www.astrologywiki.com/en/wiki/existing-live',
      备注: 'manual decision stays',
    }],
    updateRecapRow: async (token, workbookId, tabName, rowNumber, row) => {
      updated = { token, workbookId, tabName, rowNumber, row };
    },
    appendRecapRows: async (token, workbookId, tabName, rows) => {
      appended.push(...rows);
    },
  });

  assert.equal(code, 0);
  assert.equal(updated.tabName, RECAP_TAB);
  assert.equal(updated.rowNumber, 9);
  assert.equal(updated.row.day14_收录, 'Y');
  assert.equal(updated.row.备注, 'manual decision stays');
  assert.equal(appended.length, 0);
});

test('runIndexMonitor --sync-recap clears stale recap indexing flags until GSC evidence exists', async () => {
  let updated = null;
  const code = await runIndexMonitor(['--sync-recap', '--write-sheet', '--workbook', 'wb-test'], {
    now: new Date('2026-06-25T00:00:00Z'),
    sheetToken: 'sheet-token',
    readTrackingRows: async () => [{
      url: 'https://www.astrologywiki.com/en/wiki/pending-live',
      page_id: 'PG-PENDING',
      current_gsc_status: 'pending_first_check',
      monitor_status: 'monitoring',
      source: 'live-sitemap',
    }],
    readRecapRows: async () => [{
      _rowNumber: 12,
      outcome_id: 'out_PG-PENDING_latest',
      page_id: 'PG-PENDING',
      url: 'https://www.astrologywiki.com/en/wiki/pending-live',
      day14_收录: 'Y',
      索引修复状态: '已收录',
      备注: 'manual note stays',
    }],
    updateRecapRow: async (token, workbookId, tabName, rowNumber, row) => {
      updated = { token, workbookId, tabName, rowNumber, row };
    },
    appendRecapRows: async () => {},
  });

  assert.equal(code, 0);
  assert.equal(updated.rowNumber, 12);
  assert.equal(updated.row.day14_收录, '');
  assert.equal(updated.row.索引修复状态, '待GSC检查');
  assert.equal(updated.row.备注, 'manual note stays');
});

test('runIndexMonitor --sync-recap refreshes generated GSC notes while preserving manual notes', async () => {
  let updated = null;
  const code = await runIndexMonitor(['--sync-recap', '--write-sheet', '--workbook', 'wb-test'], {
    now: new Date('2026-06-25T00:00:00Z'),
    sheetToken: 'sheet-token',
    readTrackingRows: async () => [{
      url: 'https://www.astrologywiki.com/en/wiki/fresh-note',
      page_id: 'PG-FRESH',
      current_gsc_status: 'Submitted and indexed',
      gsc_verdict: 'PASS',
      monitor_status: 'indexed',
      last_checked_at: '2026-06-24',
      source: 'live-sitemap',
    }],
    readRecapRows: async () => [{
      _rowNumber: 8,
      outcome_id: 'out_PG-FRESH_latest',
      page_id: 'PG-FRESH',
      url: 'https://www.astrologywiki.com/en/wiki/fresh-note',
      day14_收录: 'N',
      索引修复状态: '待GSC检查',
      备注: 'GSC URL Inspection | status=pending_first_check | source=live-sitemap',
    }],
    updateRecapRow: async (token, workbookId, tabName, rowNumber, row) => {
      updated = { token, workbookId, tabName, rowNumber, row };
    },
    appendRecapRows: async () => {},
  });

  assert.equal(code, 0);
  assert.equal(updated.row.day14_收录, 'Y');
  assert.equal(updated.row.索引修复状态, '已收录');
  assert.match(updated.row.备注, /Submitted and indexed/);
  assert.match(updated.row.备注, /checked=2026-06-24/);
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

test('runIndexMonitor --check-all inspects pending rows before milestone due date', async () => {
  let inspected = null;
  let updated = null;
  const code = await runIndexMonitor(['--check-all', '--write-sheet', '--workbook', 'wb-test'], {
    now: new Date('2026-06-24T09:00:00Z'),
    sheetToken: 'sheet-token',
    gscToken: 'gsc-token',
    ensureIndexTrackingTab: async () => INDEX_TRACKING_TAB,
    readTrackingRows: async () => [{
      _rowNumber: 2,
      url: 'https://www.astrologywiki.com/en/wiki/not-yet-due',
      page_id: 'PG-NOT-YET',
      first_tracked_at: '2026-06-24',
      last_checked_at: '',
      current_gsc_status: 'pending_first_check',
      monitor_status: 'monitoring',
      check_count: 0,
    }],
    fetchUrlInspection: async (token, siteUrl, url) => {
      inspected = { token, siteUrl, url };
      return {
        verdict: 'NEUTRAL',
        coverageState: 'URL is unknown to Google',
      };
    },
    updateTrackingRow: async (token, workbookId, tabName, rowNumber, row) => {
      updated = { token, workbookId, tabName, rowNumber, row };
    },
  });

  assert.equal(code, 0);
  assert.equal(inspected.url, 'https://www.astrologywiki.com/en/wiki/not-yet-due');
  assert.equal(updated.rowNumber, 2);
  assert.equal(updated.row.current_gsc_status, 'URL is unknown to Google');
  assert.equal(updated.row.monitor_status, 'monitoring');
});

test('runIndexMonitor --check-all retries pending rows after same-day transient failures', async () => {
  let inspected = null;
  const code = await runIndexMonitor(['--check-all', '--write-sheet', '--workbook', 'wb-test'], {
    now: new Date('2026-06-24T09:00:00Z'),
    sheetToken: 'sheet-token',
    gscToken: 'gsc-token',
    ensureIndexTrackingTab: async () => INDEX_TRACKING_TAB,
    readTrackingRows: async () => [{
      _rowNumber: 2,
      url: 'https://www.astrologywiki.com/en/wiki/transient-failure',
      page_id: 'PG-RETRY',
      first_tracked_at: '2026-06-22',
      last_checked_at: '2026-06-24',
      current_gsc_status: 'pending_first_check',
      monitor_status: 'monitoring',
      notes: 'ERR_NETWORK: fetch failed',
      check_count: 1,
    }],
    fetchUrlInspection: async (token, siteUrl, url) => {
      inspected = { token, siteUrl, url };
      return {
        verdict: 'PASS',
        coverageState: 'Submitted and indexed',
      };
    },
    updateTrackingRow: async () => {},
  });

  assert.equal(code, 0);
  assert.equal(inspected.url, 'https://www.astrologywiki.com/en/wiki/transient-failure');
});

test('preflightGscAccess probes Search Analytics with the GSC reader SA token', async () => {
  let seen = null;
  await preflightGscAccess('gsc-sa-token', 'sc-domain:astrologywiki.com', async (url, token, init) => {
    seen = { url, token, init };
    return { rows: [] };
  });

  assert.match(seen.url, /\/webmasters\/v3\/sites\/sc-domain%3Aastrologywiki\.com\/searchAnalytics\/query$/);
  assert.equal(seen.token, 'gsc-sa-token');
  assert.equal(seen.init.method, 'POST');
  assert.equal(JSON.parse(seen.init.body).rowLimit, 1);
});

test('runIndexMonitor --require-gsc-auth preflights GSC service-account access when tracking rows exist', async () => {
  let tokenOptions = 'not-called';
  let preflight = null;
  const code = await runIndexMonitor(['--check-due', '--require-gsc-auth', '--workbook', 'wb-test'], {
    sheetToken: 'sheet-token',
    readTrackingRows: async () => [{
      url: 'https://www.astrologywiki.com/en/wiki/not-due',
      page_id: 'PG-NOT-DUE',
      first_tracked_at: '2026-06-24',
      last_checked_at: '',
      monitor_status: 'monitoring',
    }],
    getGscToken: async (opts) => {
      tokenOptions = opts;
      return 'gsc-sa-token';
    },
    preflightGscAccess: async (token, siteUrl) => {
      preflight = { token, siteUrl };
    },
  });

  assert.equal(code, 0);
  assert.equal(tokenOptions, undefined);
  assert.deepEqual(preflight, {
    token: 'gsc-sa-token',
    siteUrl: 'sc-domain:astrologywiki.com',
  });
});

test('submitSitemap uses the official Search Console Sitemaps submit endpoint', async () => {
  let seen = null;
  await submitSitemap('gsc-write-token', 'sc-domain:astrologywiki.com', 'https://www.astrologywiki.com/sitemap.xml', async (url, token, init) => {
    seen = { url, token, init };
    return {};
  });

  assert.match(seen.url, /\/webmasters\/v3\/sites\/sc-domain%3Aastrologywiki\.com\/sitemaps\/https%3A%2F%2Fwww\.astrologywiki\.com%2Fsitemap\.xml$/);
  assert.equal(seen.token, 'gsc-write-token');
  assert.equal(seen.init.method, 'PUT');
});

test('buildRequestIndexingCandidateRows prioritizes non-indexed page_id-backed rows for assisted submission', () => {
  const rows = buildRequestIndexingCandidateRows({
    recapRows: [{
      page_id: 'PG-UNKNOWN',
      url: 'https://www.astrologywiki.com/en/wiki/unknown-page',
      day14_收录: 'N',
      索引修复状态: 'needs_attention：unknown_attention',
      记录日期: '2026-06-24',
    }, {
      page_id: 'PG-INDEXED',
      url: 'https://www.astrologywiki.com/en/wiki/indexed-page',
      day14_收录: 'Y',
      索引修复状态: '已收录',
    }, {
      page_id: '',
      url: 'https://www.astrologywiki.com/en/wiki/site-native',
      day14_收录: 'N',
    }],
    trackingRows: [{
      page_id: 'PG-UNKNOWN',
      url: 'https://www.astrologywiki.com/en/wiki/unknown-page',
      title: 'Unknown Page',
      current_gsc_status: 'URL is unknown to Google',
      diagnosis_category: 'unknown_attention',
      monitor_status: 'needs_attention',
      first_tracked_at: '2026-06-01',
      last_checked_at: '2026-06-24',
      days_since_first_tracked: 23,
    }],
    now: new Date('2026-06-25T00:00:00Z'),
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].priority, 'P1');
  assert.equal(rows[0].page_id, 'PG-UNKNOWN');
  assert.match(rows[0].request_reason, /Google 尚未知/);
  assert.match(rows[0].gsc_inspection_url, /search-console\/inspect/);
  assert.equal(rows[0].computer_use_status, '待人工确认');
});

test('runIndexMonitor --sync-request-queue writes queue rows and sends Feishu notification', async () => {
  let queued = null;
  let formatted = null;
  let notified = null;
  const code = await runIndexMonitor(['--sync-request-queue', '--write-sheet', '--notify', '--workbook', 'wb-test'], {
    now: new Date('2026-06-25T00:00:00Z'),
    sheetToken: 'sheet-token',
    ensureRequestQueueTab: async () => REQUEST_INDEXING_QUEUE_TAB,
    readRecapRows: async () => [{
      page_id: 'PG-CONTENT',
      url: 'https://www.astrologywiki.com/en/wiki/content-page',
      day14_收录: 'N',
      索引修复状态: 'needs_attention：content_quality',
    }],
    readTrackingRows: async () => [{
      page_id: 'PG-CONTENT',
      url: 'https://www.astrologywiki.com/en/wiki/content-page',
      title: 'Content Page',
      current_gsc_status: 'Crawled - currently not indexed',
      diagnosis_category: 'content_quality',
      monitor_status: 'needs_attention',
      first_tracked_at: '2026-06-01',
      last_checked_at: '2026-06-24',
      days_since_first_tracked: 23,
    }],
    readRequestQueueRows: async () => [],
    replaceRequestQueueRows: async (token, workbookId, tabName, rows) => {
      queued = { token, workbookId, tabName, rows };
    },
    formatRequestQueue: async () => {
      formatted = true;
    },
    notify: (message) => {
      notified = message;
    },
  });

  assert.equal(code, 0);
  assert.equal(queued.tabName, REQUEST_INDEXING_QUEUE_TAB);
  assert.equal(queued.rows.length, 1);
  assert.equal(queued.rows[0].priority, 'P1');
  assert.match(notified, /Request Indexing 候选/);
  assert.equal(formatted, true);
});
