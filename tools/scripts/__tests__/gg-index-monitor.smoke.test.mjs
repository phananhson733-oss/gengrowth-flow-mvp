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
  URL_INVENTORY_HEADER,
  URL_INVENTORY_TAB,
  buildUrlInventoryRows,
  buildRequestIndexingCandidateRows,
  buildTrackingSeedRow,
  classifyInspection,
  extractEnWikiSitemapRows,
  extractIndexableSitemapInventoryRows,
  extractPageDiagnosticsFromHtml,
  formatAlertMessage,
  formatRecapStatusTab,
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
  assert.ok(INDEX_TRACKING_HEADER.includes('fixed_detected_at'));
  assert.ok(INDEX_TRACKING_HEADER.includes('resubmitted_at'));
  assert.ok(INDEX_TRACKING_HEADER.includes('next_check_after'));
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

test('workbook spec declares the URL inventory auto tab', () => {
  assert.equal(URL_INVENTORY_TAB, 'url-inventory');
  assert.deepEqual(URL_INVENTORY_HEADER.slice(0, 5), [
    'url',
    'path_family',
    'title',
    'source',
    'sitemap_lastmod',
  ]);
  assert.ok(URL_INVENTORY_HEADER.includes('inventory_status'));
  assert.ok(URL_INVENTORY_HEADER.includes('request_queue_allowed'));

  const tab = TABS.find((t) => t.name === URL_INVENTORY_TAB);
  assert.ok(tab, 'url-inventory tab must be part of the workbook spec');
  assert.deepEqual(tab.header, [...URL_INVENTORY_HEADER]);
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

test('URL inventory includes tools pages that existing EN wiki tracking intentionally skips', () => {
  const sitemapRows = extractIndexableSitemapInventoryRows(`
    <url><loc>https://www.astrologywiki.com/en/wiki/bruno-fernandes-zodiac-sign</loc><lastmod>2026-06-24</lastmod></url>
    <url><loc>https://www.astrologywiki.com/en/tools</loc><lastmod>2026-06-24</lastmod></url>
    <url><loc>https://www.astrologywiki.com/en/birth-chart-calculator</loc><lastmod>2026-06-24</lastmod></url>
    <url><loc>https://www.astrologywiki.com/en/wiki/classics/chart-interpretation</loc><lastmod>2026-06-24</lastmod></url>
    <url><loc>https://www.astrologywiki.com/zh/wiki/bruno-fernandes-zodiac-sign</loc><lastmod>2026-06-24</lastmod></url>
    <url><loc>https://example.com/en/tools</loc><lastmod>2026-06-24</lastmod></url>
  `, { now: new Date('2026-06-25T00:00:00Z') });

  assert.deepEqual(sitemapRows.map((row) => row.url), [
    'https://www.astrologywiki.com/en/wiki/bruno-fernandes-zodiac-sign',
    'https://www.astrologywiki.com/en/tools',
    'https://www.astrologywiki.com/en/birth-chart-calculator',
    'https://www.astrologywiki.com/en/wiki/classics/chart-interpretation',
  ]);
  assert.equal(sitemapRows[1].path_family, 'en_tools_hub');
  assert.equal(sitemapRows[2].path_family, 'en_tool');
  assert.equal(sitemapRows[3].path_family, 'en_wiki_nested');

  const rows = buildUrlInventoryRows({
    sitemapRows,
    trackingRows: [{
      page_id: 'PG-WIKI-001',
      url: 'https://www.astrologywiki.com/en/wiki/bruno-fernandes-zodiac-sign',
      title: 'Bruno Fernandes Zodiac Sign',
      current_gsc_status: 'Submitted and indexed',
      monitor_status: 'indexed',
      first_tracked_at: '2026-06-24',
      last_checked_at: '2026-06-25',
    }],
    recapRows: [{
      page_id: 'PG-WIKI-001',
      url: 'https://www.astrologywiki.com/en/wiki/bruno-fernandes-zodiac-sign',
      'day14_收录': 'Y',
      '索引修复状态': '已收录',
    }, {
      page_id: 'PG-CLASSIC-001',
      url: 'https://www.astrologywiki.com/en/wiki/classics/chart-interpretation',
      'day14_收录': 'N',
      '申请时间': '2026-06-24',
      '索引修复状态': '监控中',
    }],
    requestQueueRows: [{
      page_id: 'PG-CLASSIC-001',
      url: 'https://www.astrologywiki.com/en/wiki/classics/chart-interpretation',
      computer_use_status: '已提交',
    }],
    now: new Date('2026-06-25T00:00:00Z'),
    siteUrl: 'sc-domain:astrologywiki.com',
  });

  const byUrl = new Map(rows.map((row) => [row.url, row]));
  assert.equal(byUrl.get('https://www.astrologywiki.com/en/wiki/bruno-fernandes-zodiac-sign').inventory_status, '已收录');
  assert.equal(byUrl.get('https://www.astrologywiki.com/en/tools').inventory_status, '未纳入监控');
  assert.equal(byUrl.get('https://www.astrologywiki.com/en/tools').request_queue_allowed, 'Y');
  assert.equal(byUrl.get('https://www.astrologywiki.com/en/birth-chart-calculator').inventory_status, '未纳入监控');
  assert.equal(byUrl.get('https://www.astrologywiki.com/en/birth-chart-calculator').path_family, 'en_tool');
  assert.equal(byUrl.get('https://www.astrologywiki.com/en/wiki/classics/chart-interpretation').inventory_status, '已提交但未收录');
});

test('extractEnWikiSitemapRows seeds gengrowth /en/blog articles and excludes hub + category', () => {
  const rows = extractEnWikiSitemapRows(`
    <url><loc>https://gengrowth.ai/en/blog/cheap-seo</loc><lastmod>2026-07-02</lastmod></url>
    <url><loc>https://gengrowth.ai/en/blog</loc><lastmod>2026-07-02</lastmod></url>
    <url><loc>https://gengrowth.ai/en/blog/category/case-study</loc><lastmod>2026-07-02</lastmod></url>
    <url><loc>https://gengrowth.ai/zh/blog/cheap-seo</loc><lastmod>2026-07-02</lastmod></url>
    <url><loc>https://gengrowth.ai/en/features</loc><lastmod>2026-07-02</lastmod></url>
  `, { now: new Date('2026-07-03T00:00:00Z') });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'https://gengrowth.ai/en/blog/cheap-seo');
  assert.equal(rows[0].slug, 'cheap-seo');
  assert.equal(rows[0].title, 'Cheap Seo');
  assert.equal(rows[0].source, 'live-sitemap');
  assert.equal(rows[0].published_at, '2026-07-02');
});

test('URL inventory classifies gengrowth blog articles Y and drops blog hub + category', () => {
  const sitemapRows = extractIndexableSitemapInventoryRows(`
    <url><loc>https://gengrowth.ai/en/blog/ethical-seo-services</loc><lastmod>2026-07-03</lastmod></url>
    <url><loc>https://gengrowth.ai/en/blog</loc><lastmod>2026-07-03</lastmod></url>
    <url><loc>https://gengrowth.ai/en/blog/category/case-study</loc><lastmod>2026-07-03</lastmod></url>
  `, { now: new Date('2026-07-03T00:00:00Z') });

  // Only the single-segment article survives; the hub and the category listing are excluded.
  assert.deepEqual(sitemapRows.map((row) => row.url), [
    'https://gengrowth.ai/en/blog/ethical-seo-services',
  ]);
  assert.equal(sitemapRows[0].path_family, 'en_blog_article');

  const rows = buildUrlInventoryRows({
    sitemapRows,
    trackingRows: [],
    recapRows: [],
    requestQueueRows: [],
    now: new Date('2026-07-03T00:00:00Z'),
    siteUrl: 'sc-domain:gengrowth.ai',
  });
  const blog = new Map(rows.map((row) => [row.url, row])).get('https://gengrowth.ai/en/blog/ethical-seo-services');
  assert.equal(blog.path_family, 'en_blog_article');
  assert.equal(blog.request_queue_allowed, 'Y');
  assert.equal(blog.inventory_status, '未纳入监控');
});

test('mixed astrologywiki + gengrowth sitemap: wiki output unchanged, blog additively tracked', () => {
  const rows = extractEnWikiSitemapRows(`
    <url><loc>https://www.astrologywiki.com/en/wiki/bruno-fernandes-zodiac-sign</loc><lastmod>2026-06-24</lastmod></url>
    <url><loc>https://gengrowth.ai/en/blog/integrated-seo</loc><lastmod>2026-07-03</lastmod></url>
    <url><loc>https://www.astrologywiki.com/en/blog/future-migrated-article</loc><lastmod>2026-07-03</lastmod></url>
  `, { now: new Date('2026-07-03T00:00:00Z') });
  const byUrl = new Map(rows.map((row) => [row.url, row]));

  // astrologywiki /en/wiki article: byte-identical to pre-change behavior.
  assert.equal(byUrl.get('https://www.astrologywiki.com/en/wiki/bruno-fernandes-zodiac-sign').slug, 'bruno-fernandes-zodiac-sign');
  // gengrowth /en/blog article: now tracked.
  assert.equal(byUrl.get('https://gengrowth.ai/en/blog/integrated-seo').slug, 'integrated-seo');
  // Intended FORWARD behavior: a future astrologywiki /en/blog (post /wiki→/blog migration) is ALSO tracked.
  assert.equal(byUrl.get('https://www.astrologywiki.com/en/blog/future-migrated-article').slug, 'future-migrated-article');
  assert.equal(rows.length, 3);
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

test('extractPageDiagnosticsFromHtml counts visible words and reads meta robots', () => {
  const html = `
    <html>
      <head>
        <meta name="robots" content="noindex, nofollow">
        <meta name="author" content="GenGrowth">
        <meta property="article:published_time" content="2026-06-24">
      </head>
      <body>
        <script>ignored words ignored words</script>
        <main>${'astrology '.repeat(1210)}</main>
      </body>
    </html>
  `;
  const diagnostics = extractPageDiagnosticsFromHtml(html);

  assert.equal(diagnostics.meta_robots, 'noindex, nofollow');
  assert.equal(diagnostics.has_author, true);
  assert.equal(diagnostics.has_published_time, true);
  assert.ok(diagnostics.word_count >= 1210);
});

test('classifyInspection keeps discovered-not-indexed quiet at D+14 and escalates at D+21', () => {
  const d7 = classifyInspection({
    verdict: 'NEUTRAL',
    coverageState: 'Discovered - currently not indexed',
  }, { daysSinceFirstTracked: 7, now: new Date('2026-06-24T09:00:00Z') });
  assert.equal(d7.monitor_status, 'monitoring');
  assert.equal(d7.diagnosis_category, '正常排队（新站常见）');
  assert.equal(d7.alert_level, '');
  assert.equal(d7.should_alert, false);

  const d14 = classifyInspection({
    verdict: 'NEUTRAL',
    coverageState: 'Discovered - currently not indexed',
  }, { daysSinceFirstTracked: 14, now: new Date('2026-06-24T09:00:00Z') });
  assert.equal(d14.monitor_status, 'monitoring');
  assert.equal(d14.alert_level, '');
  assert.equal(d14.should_alert, false);
  assert.match(d14.recommendation, /D\+21/);

  const d21 = classifyInspection({
    verdict: 'NEUTRAL',
    coverageState: 'Discovered - currently not indexed',
  }, { daysSinceFirstTracked: 21, now: new Date('2026-06-24T09:00:00Z') });
  assert.equal(d21.monitor_status, 'needs_attention');
  assert.equal(d21.alert_level, 'P2');
  assert.equal(d21.should_alert, true);
});

test('classifyInspection maps common GSC states to diagnosis categories and recommendations', () => {
  const cases = [
    ['Crawled - currently not indexed', '内容质量问题', /目标 ≥ 1,200 词|内容扩充/],
    ['Excluded by noindex tag', '标签问题（需人工确认是否有意）', /确认是否有意设置 noindex/],
    ['Blocked by robots.txt', '配置错误（大概率无意）', /robots\.txt 当前内容/],
    ['Not found (404)', '技术故障', /立即处理/],
    ['Server error (5xx)', '技术故障', /立即处理/],
    ['Duplicate, Google chose different canonical than user', '重复内容 / canonical 问题', /canonical 标签/],
    ['Soft 404', '索引配置问题', /HTTP 状态|页面正文/],
    ['URL is unknown to Google', '未知状态', /分类框架/],
  ];

  for (const [coverageState, category, recommendation] of cases) {
    const result = classifyInspection({
      verdict: /404|5xx/.test(coverageState) ? 'FAIL' : 'NEUTRAL',
      coverageState,
    }, {
      daysSinceFirstTracked: 14,
      now: new Date('2026-06-24T09:00:00Z'),
      pageDiagnostics: {
        word_count: 780,
        meta_robots: 'index, follow',
        robots_txt: 'User-agent: *\nDisallow: /private',
      },
    });

    assert.equal(result.diagnosis_category, category, coverageState);
    assert.equal(result.should_alert, true, coverageState);
    assert.match(result.recommendation, recommendation, coverageState);
  }
});

test('classifyInspection only stops monitoring for truly indexed pages', () => {
  const result = classifyInspection({
    verdict: 'PASS',
    coverageState: 'Submitted and indexed',
  }, { daysSinceFirstTracked: 30, now: new Date('2026-06-24T09:00:00Z') });

  assert.equal(result.monitor_status, 'indexed');
  assert.equal(result.diagnosis_category, 'indexed');
  assert.equal(result.alert_level, '');
  assert.equal(result.should_alert, false);
});

test('classifyInspection alerts at D+14 for crawled-not-indexed', () => {
  const result = classifyInspection({
    verdict: 'NEUTRAL',
    coverageState: 'Crawled - currently not indexed',
  }, { daysSinceFirstTracked: 14, now: new Date('2026-06-24T09:00:00Z') });

  assert.equal(result.monitor_status, 'needs_attention');
  assert.equal(result.diagnosis_category, '内容质量问题');
  assert.equal(result.alert_level, 'P1');
  assert.equal(result.should_alert, true);
  assert.match(result.recommendation, /目标 ≥ 1,200 词/);
});

test('classifyInspection routes other 4xx blocks to P1 handling', () => {
  const result = classifyInspection({
    verdict: 'FAIL',
    coverageState: 'Blocked due to other 4xx issue',
  }, { daysSinceFirstTracked: 1, now: new Date('2026-06-24T09:00:00Z') });

  assert.equal(result.monitor_status, 'needs_attention');
  assert.equal(result.diagnosis_category, '访问权限或 4xx 问题');
  assert.equal(result.alert_level, 'P1');
  assert.equal(result.should_alert, true);
  assert.match(result.recommendation, /401|410|权限|误删/);
});

test('classifyInspection keeps indexed robots-blocked pages in P3 observation', () => {
  const result = classifyInspection({
    verdict: 'PASS',
    coverageState: 'Indexed, though blocked by robots.txt',
  }, {
    daysSinceFirstTracked: 14,
    now: new Date('2026-06-24T09:00:00Z'),
    pageDiagnostics: { robots_txt: 'User-agent: *\nDisallow: /en/wiki/' },
  });

  assert.equal(result.monitor_status, 'needs_attention');
  assert.equal(result.diagnosis_category, '已收录但 robots.txt 屏蔽');
  assert.equal(result.alert_level, 'P3');
  assert.equal(result.should_alert, true);
  assert.match(result.recommendation, /核查 robots\.txt|已收录但 robots\.txt/);
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
    first_tracked_at: '2026-06-01',
    monitor_status: 'monitoring',
    last_checked_at: '',
  };
  assert.equal(isDueForInspection(base, new Date('2026-06-03T09:00:00Z')), false);
  assert.equal(isDueForInspection(base, new Date('2026-06-04T09:00:00Z')), true);
  assert.equal(isDueForInspection({ ...base, last_checked_at: '2026-06-04' }, new Date('2026-06-04T12:00:00Z')), false);
  assert.equal(isDueForInspection({ ...base, last_checked_at: '2026-06-04' }, new Date('2026-06-08T09:00:00Z')), true);
  assert.equal(isDueForInspection({ ...base, last_checked_at: '2026-06-15' }, new Date('2026-06-22T09:00:00Z')), true);
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
    diagnosis_category: '内容质量问题',
    diagnosis_conclusion: '内容质量不足',
    recommendation: 'fallback',
  });

  assert.match(message, /^🔍 索引诊断报告/m);
  assert.match(message, /页面：Lifecycle Test/);
  assert.match(message, /URL：https:\/\/www\.astrologywiki\.com\/en\/wiki\/lifecycle/);
  assert.match(message, /GSC 状态：Crawled - currently not indexed/);
  assert.match(message, /诊断结论：内容质量不足/);
  assert.match(message, /建议操作：\n  □ Review content quality/);
  assert.match(message, /处理完成后：系统将自动刷新 sitemap 并进入 request-indexing-queue/);
});

test('runIndexMonitor sends the diagnosis report during the same D+14 check', async () => {
  let updated = null;
  const events = [];
  const code = await runIndexMonitor(['--check-due', '--write-sheet', '--workbook', 'wb-test'], {
    now: new Date('2026-06-24T09:00:00Z'),
    sheetToken: 'sheet-token',
    gscToken: 'gsc-token',
    ensureIndexTrackingTab: async () => INDEX_TRACKING_TAB,
    readTrackingRows: async () => [{
      _rowNumber: 2,
      url: 'https://www.astrologywiki.com/en/wiki/d14-diagnosis',
      page_id: 'PG-D14-001',
      title: 'D14 Diagnosis',
      published_at: '2026-06-10',
      first_tracked_at: '2026-06-10',
      last_checked_at: '2026-06-17',
      monitor_status: 'monitoring',
      check_count: 2,
    }],
    fetchUrlInspection: async () => ({
      verdict: 'NEUTRAL',
      coverageState: 'Crawled - currently not indexed',
    }),
    fetchPageDiagnostics: async () => ({
      word_count: 760,
      meta_robots: 'index, follow',
      has_author: true,
      has_published_time: true,
      robots_txt: '',
    }),
    updateTrackingRow: async (token, workbookId, tabName, rowNumber, row) => {
      events.push('update');
      updated = { token, workbookId, tabName, rowNumber, row };
    },
    notify: (message) => {
      events.push('notify');
      assert.match(message, /^🔍 索引诊断报告/m);
      assert.match(message, /GSC 状态：Crawled - currently not indexed/);
      assert.match(message, /诊断结论：内容质量不足/);
      assert.match(message, /□ 检查字数（当前 760，目标 ≥ 1,200 词）/);
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(events, ['notify', 'update']);
  assert.equal(updated.row.alert_sent_at, '2026-06-24');
  assert.equal(updated.row.diagnosis_category, '内容质量问题');
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
    fetchPageDiagnostics: async () => ({
      word_count: 900,
      meta_robots: 'index, follow',
      has_author: true,
      has_published_time: true,
      robots_txt: '',
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
  assert.equal(notIndexed.索引修复状态, '⚠️ 超期未收录（触发诊断）');

  const resubmitted = recapRowFromTrackingRow({
    url: 'https://www.astrologywiki.com/en/wiki/resubmitted-page',
    page_id: 'PG-RESUBMITTED',
    current_gsc_status: 'Crawled - currently not indexed',
    monitor_status: 'monitoring',
    fix_status: '已重新提交',
    last_checked_at: '2026-06-24',
  }, { now: new Date('2026-06-25T00:00:00Z') });
  assert.equal(resubmitted.索引修复状态, '已重新提交');
});

test('recapRowFromTrackingRow does not mark canonical duplicate states as indexed', () => {
  const row = recapRowFromTrackingRow({
    url: 'https://www.astrologywiki.com/en/wiki/canonical-duplicate',
    page_id: 'PG-CANON',
    current_gsc_status: 'Alternate page with proper canonical tag',
    gsc_verdict: 'PASS',
    monitor_status: 'needs_attention',
    diagnosis_category: '重复内容 / canonical 问题',
    last_checked_at: '2026-06-24',
  }, { now: new Date('2026-06-25T00:00:00Z') });

  assert.equal(row.day14_收录, 'N');
  assert.equal(row.索引修复状态, '⚠️ 超期未收录（触发诊断）');
});

test('recapRowFromTrackingRow keeps indexed robots-blocked rows visible as P3 observation', () => {
  const row = recapRowFromTrackingRow({
    url: 'https://www.astrologywiki.com/en/wiki/indexed-robots-blocked',
    page_id: 'PG-ROBOTS-P3',
    current_gsc_status: 'Indexed, though blocked by robots.txt',
    gsc_verdict: 'PASS',
    monitor_status: 'needs_attention',
    diagnosis_category: '已收录但 robots.txt 屏蔽',
    alert_level: 'P3',
    first_tracked_at: '2026-06-01',
    last_checked_at: '2026-06-24',
  }, { now: new Date('2026-06-25T00:00:00Z') });

  assert.equal(row.day14_收录, 'Y');
  assert.equal(row.索引修复状态, 'P3 观察');
});

test('recapRowFromTrackingRow fills cluster_id from the 选题登记表 page→cluster map', () => {
  const clusterByPage = new Map([['PG-TSE-001', 'total_solar_eclipse_2026']]);
  // page_id present in the map → cluster_id populated (index-tracking has no cluster col)
  const mapped = recapRowFromTrackingRow(
    { url: 'https://www.astrologywiki.com/en/wiki/total-solar-eclipse-2026', page_id: 'PG-TSE-001' },
    { now: new Date('2026-07-01T00:00:00Z'), clusterByPage },
  );
  assert.equal(mapped.cluster_id, 'total_solar_eclipse_2026');
  // page_id absent from the map → falls back to the row's own cluster_id, else empty
  const fallback = recapRowFromTrackingRow(
    { url: 'https://www.astrologywiki.com/en/wiki/x', page_id: 'PG-UNKNOWN', cluster_id: 'own_cluster' },
    { now: new Date('2026-07-01T00:00:00Z'), clusterByPage },
  );
  assert.equal(fallback.cluster_id, 'own_cluster');
  const empty = recapRowFromTrackingRow(
    { url: 'https://www.astrologywiki.com/en/wiki/y', page_id: 'PG-NONE' },
    { now: new Date('2026-07-01T00:00:00Z') },
  );
  assert.equal(empty.cluster_id, '');
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
  assert.match(wrapper, /--process-fixed/);
  assert.match(wrapper, /--submit-sitemap/);
  assert.match(wrapper, /--sync-url-inventory --write-sheet/);
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

test('repair resubmit wrapper loops products without unattended request-indexing notifications', () => {
  const wrapper = readFileSync(join(SCRIPTS, 'gg-index-repair-resubmit-tick.sh'), 'utf8');
  assert.match(wrapper, /index_repair_resubmit/);
  assert.match(wrapper, /GG_INDEX_MONITOR_PRODUCTS:-astrologywiki gengrowth/);
  assert.match(wrapper, /astrologywiki\|astrology/);
  assert.match(wrapper, /GG_SHEETS_ASTROLOGY_WORKBOOK_ID/);
  assert.match(wrapper, /gengrowth\|gengrowth-ai/);
  assert.match(wrapper, /GG_SHEETS_GENGROWTH_WORKBOOK_ID/);
  assert.match(wrapper, /GG_GSC_GENGROWTH_SITE/);
  assert.match(wrapper, /--process-fixed --write-sheet --notify/);
  assert.match(wrapper, /--workbook "\$GG_SHEETS_WORKBOOK_ID"/);
  assert.match(wrapper, /--sync-recap --write-sheet/);
  assert.match(wrapper, /--sync-request-queue --write-sheet/);
  assert.doesNotMatch(wrapper, /--sync-request-queue --write-sheet --notify/);
  assert.doesNotMatch(wrapper, /--check-due|--sync-published|gsc-index-submit|Google Indexing API/);
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

test('runIndexMonitor --sync-url-inventory writes an independent inventory tab without GSC inspection calls', async () => {
  let ensured = null;
  let written = null;
  let formatted = null;
  const code = await runIndexMonitor(['--sync-url-inventory', '--write-sheet', '--workbook', 'wb-test'], {
    now: new Date('2026-06-25T00:00:00Z'),
    sheetToken: 'sheet-token',
    sitemapInventoryRows: extractIndexableSitemapInventoryRows(`
      <url><loc>https://www.astrologywiki.com/en/tools</loc><lastmod>2026-06-24</lastmod></url>
      <url><loc>https://www.astrologywiki.com/en/birth-chart-calculator</loc><lastmod>2026-06-24</lastmod></url>
    `),
    ensureUrlInventoryTab: async (token, workbookId) => {
      ensured = { token, workbookId };
      return URL_INVENTORY_TAB;
    },
    readTrackingRows: async () => [],
    readRecapRows: async () => [],
    readRequestQueueRows: async () => [],
    replaceUrlInventoryRows: async (token, workbookId, tabName, rows) => {
      written = { token, workbookId, tabName, rows };
    },
    formatUrlInventory: async (token, workbookId, tabName) => {
      formatted = { token, workbookId, tabName };
    },
    fetchUrlInspection: async () => {
      throw new Error('inventory sync must not call URL Inspection');
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(ensured, { token: 'sheet-token', workbookId: 'wb-test' });
  assert.equal(written.tabName, URL_INVENTORY_TAB);
  assert.deepEqual(written.rows.map((row) => row.inventory_status), ['未纳入监控', '未纳入监控']);
  assert.deepEqual(written.rows.map((row) => row.path_family), ['en_tools_hub', 'en_tool']);
  assert.equal(formatted.tabName, URL_INVENTORY_TAB);
});

test('runIndexMonitor --sync-recap upserts only page_id-backed final presentation rows', async () => {
  const appended = [];
  let updated = null;
  let formatted = null;
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
    formatRecapStatus: async (token, workbookId, tabName) => {
      formatted = { token, workbookId, tabName };
    },
  });

  assert.equal(code, 0);
  assert.equal(updated.tabName, RECAP_TAB);
  assert.equal(updated.rowNumber, 9);
  assert.equal(updated.row.day14_收录, 'Y');
  assert.equal(updated.row.备注, 'manual decision stays');
  assert.equal(appended.length, 0);
  assert.deepEqual(formatted, { token: 'sheet-token', workbookId: 'wb-test', tabName: RECAP_TAB });
});

test('formatRecapStatusTab colors recap repair status values in column G', async () => {
  const calls = [];
  await formatRecapStatusTab('sheet-token', 'wb-test', RECAP_TAB, async (url, token, init) => {
    calls.push({ url, token, init });
    if (!init) {
      return {
        sheets: [{
          properties: { title: RECAP_TAB, sheetId: 77 },
          conditionalFormats: [{
            ranges: [{ sheetId: 77, startRowIndex: 1, startColumnIndex: 6, endColumnIndex: 7 }],
            booleanRule: { condition: { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: '旧规则' }] } },
          }],
        }],
      };
    }
    return {};
  });

  const batch = calls.find((call) => call.init?.method === 'POST');
  assert.ok(batch, 'expected a batchUpdate call');
  const body = JSON.parse(batch.init.body);
  assert.ok(body.requests.some((req) => req.deleteConditionalFormatRule?.sheetId === 77));
  const rules = body.requests
    .map((req) => req.addConditionalFormatRule?.rule?.booleanRule?.condition?.values?.[0]?.userEnteredValue)
    .filter(Boolean);
  assert.deepEqual(rules, [
    '🔴 紧急问题',
    '需重点关注',
    '⚠️ 超期未收录',
    '已收录',
    '监控中',
    '已重新提交',
    '待GSC检查',
    '已提交',
  ]);
  for (const req of body.requests.filter((r) => r.addConditionalFormatRule)) {
    const range = req.addConditionalFormatRule.rule.ranges[0];
    assert.equal(range.sheetId, 77);
    assert.equal(range.startRowIndex, 1);
    assert.equal(range.startColumnIndex, 6);
    assert.equal(range.endColumnIndex, 7);
  }
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
    fetchPageDiagnostics: async () => ({
      word_count: 0,
      meta_robots: '',
      has_author: false,
      has_published_time: false,
      robots_txt: '',
    }),
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
    fetchUrlInspection: async () => ({
      coverageState: 'URL is unknown to Google',
      verdict: 'FAIL',
    }),
    updateTrackingRow: async () => {},
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

test('runIndexMonitor --process-fixed resubmits fixed rows and writes tracking timestamps', async () => {
  const events = [];
  let trackingUpdate = null;
  let recapUpdate = null;
  let notified = null;
  const code = await runIndexMonitor(['--process-fixed', '--write-sheet', '--notify', '--workbook', 'wb-test'], {
    now: new Date('2026-06-24T12:34:56.000Z'),
    sheetToken: 'sheet-token',
    gscWriteToken: 'gsc-write-token',
    ensureIndexTrackingTab: async () => INDEX_TRACKING_TAB,
    readTrackingRows: async () => [{
      _rowNumber: 7,
      url: 'https://www.astrologywiki.com/en/wiki/fixed-page',
      page_id: 'PG-FIXED-001',
      title: 'Fixed Page',
      first_tracked_at: '2026-06-01',
      last_checked_at: '2026-06-24',
      current_gsc_status: 'Crawled - currently not indexed',
      monitor_status: 'needs_attention',
      alert_level: 'P1',
      alert_sent_at: '2026-06-24',
      fix_status: '⚠️ 超期未收录（触发诊断）',
      retry_round: 1,
      recommendation: 'old recommendation',
      notes: 'old note',
    }, {
      _rowNumber: 8,
      url: 'https://www.astrologywiki.com/en/wiki/not-fixed',
      page_id: 'PG-NOT-FIXED',
      fix_status: '监控中',
    }],
    readRecapRows: async () => [{
      _rowNumber: 4,
      page_id: 'PG-FIXED-001',
      url: 'https://www.astrologywiki.com/en/wiki/fixed-page',
      索引修复状态: '已修复',
      备注: 'manual fix done',
    }],
    submitSitemap: async (token, siteUrl, sitemapUrl) => {
      events.push({ type: 'submit', token, siteUrl, sitemapUrl });
    },
    updateTrackingRow: async (token, workbookId, tabName, rowNumber, row) => {
      events.push({ type: 'tracking', rowNumber });
      trackingUpdate = { token, workbookId, tabName, rowNumber, row };
    },
    updateRecapRow: async (token, workbookId, tabName, rowNumber, row) => {
      events.push({ type: 'recap', rowNumber });
      recapUpdate = { token, workbookId, tabName, rowNumber, row };
    },
    formatRecapStatus: async () => {
      events.push({ type: 'format-recap' });
    },
    notify: (message) => {
      notified = message;
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(events.map((event) => event.type), ['submit', 'tracking', 'recap', 'format-recap']);
  assert.equal(trackingUpdate.tabName, INDEX_TRACKING_TAB);
  assert.equal(trackingUpdate.rowNumber, 7);
  assert.equal(trackingUpdate.row.fix_status, '已重新提交');
  assert.equal(trackingUpdate.row.fixed_detected_at, '2026-06-24T12:34:56.000Z');
  assert.equal(trackingUpdate.row.resubmitted_at, '2026-06-24T12:34:56.000Z');
  assert.equal(trackingUpdate.row.next_check_after, '2026-06-24');
  assert.equal(trackingUpdate.row.retry_round, 2);
  assert.equal(trackingUpdate.row.monitor_status, 'monitoring');
  assert.equal(trackingUpdate.row.alert_level, '');
  assert.equal(trackingUpdate.row.alert_sent_at, '');
  assert.match(trackingUpdate.row.recommendation, /已重新提交 sitemap/);
  assert.match(trackingUpdate.row.notes, /resubmitted_after_fix=2026-06-24T12:34:56.000Z/);
  assert.equal(recapUpdate.tabName, RECAP_TAB);
  assert.equal(recapUpdate.row.索引修复状态, '已重新提交');
  assert.equal(recapUpdate.row.申请时间, '2026-06-24');
  assert.equal(recapUpdate.row.记录日期, '2026-06-24');
  assert.match(notified, /已重新提交修复 URL：1 条/);
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
  assert.equal(rows[0].gsc_inspection_url, 'https://search.google.com/search-console?resource_id=sc-domain%3Aastrologywiki.com');
  assert.doesNotMatch(rows[0].gsc_inspection_url, /\/inspect\?|[?&]id=/);
  assert.equal(rows[0].computer_use_status, '待人工确认');
  assert.match(rows[0].computer_use_instruction, /复制本行 url 列/);
});

test('buildRequestIndexingCandidateRows keeps other 4xx blocks at P1 priority', () => {
  const rows = buildRequestIndexingCandidateRows({
    recapRows: [{
      page_id: 'PG-4XX',
      url: 'https://www.astrologywiki.com/en/wiki/blocked-other-4xx',
      day14_收录: 'N',
      索引修复状态: '⚠️ 超期未收录（触发诊断）',
    }],
    trackingRows: [{
      page_id: 'PG-4XX',
      url: 'https://www.astrologywiki.com/en/wiki/blocked-other-4xx',
      title: 'Blocked 4xx',
      current_gsc_status: 'Blocked due to other 4xx issue',
      diagnosis_category: '访问权限或 4xx 问题',
      monitor_status: 'needs_attention',
      alert_level: 'P1',
      days_since_first_tracked: 14,
    }],
    now: new Date('2026-06-25T00:00:00Z'),
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].priority, 'P1');
  assert.match(rows[0].discovery_actions, /先修访问权限或 4xx/);
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
