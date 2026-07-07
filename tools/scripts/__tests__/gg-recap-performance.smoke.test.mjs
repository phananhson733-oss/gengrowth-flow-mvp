#!/usr/bin/env node
// Smoke tests for gg-recap-performance.mjs — performance recap and action list.
// Run: node --test tools/scripts/__tests__/gg-recap-performance.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  RECAP_PERFORMANCE_REPORT_DIR,
  buildPerformancePlan,
  classifyOptimizationTasks,
  fetchGscUrlMetrics,
  mergePerformanceIntoRecapRow,
  renderOptimizationMarkdown,
  runRecapPerformance,
} from '../gg-recap-performance.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(__dirname, '..');

test('buildPerformancePlan selects D14/D30/D60 windows from published tracking rows', () => {
  const plan = buildPerformancePlan({
    now: new Date('2026-07-07T00:00:00Z'),
    trackingRows: [{
      page_id: 'PG-D36',
      url: 'https://www.astrologywiki.com/en/wiki/bing-hastert-birth-chart',
      published_at: '2026-06-01',
      monitor_status: 'indexed',
    }, {
      page_id: 'PG-D12',
      url: 'https://www.astrologywiki.com/en/wiki/too-new',
      published_at: '2026-06-25',
      monitor_status: 'indexed',
    }, {
      page_id: 'PG-D66',
      url: 'https://www.astrologywiki.com/en/wiki/old-page',
      published_at: '2026-05-01',
      monitor_status: 'indexed',
    }, {
      page_id: 'PG-ZH',
      url: 'https://www.astrologywiki.com/zh/wiki/ignored',
      published_at: '2026-05-01',
      monitor_status: 'indexed',
    }],
    recapRows: [{
      _rowNumber: 9,
      page_id: 'PG-D36',
      url: 'https://www.astrologywiki.com/en/wiki/bing-hastert-birth-chart',
    }, {
      _rowNumber: 10,
      page_id: 'PG-D66',
      url: 'https://www.astrologywiki.com/en/wiki/old-page',
    }],
  });

  assert.deepEqual(plan.map((item) => ({
    page_id: item.page_id,
    windows: item.windows.map((w) => `${w.milestone}:${w.startDate}..${w.endDate}`),
  })), [{
    page_id: 'PG-D36',
    windows: ['day14:2026-06-01..2026-06-14', 'day30:2026-06-01..2026-06-30'],
  }, {
    page_id: 'PG-D66',
    windows: [
      'day14:2026-05-01..2026-05-14',
      'day30:2026-05-01..2026-05-30',
      'day60:2026-05-01..2026-06-29',
    ],
  }]);
});

test('mergePerformanceIntoRecapRow fills milestone metrics without clobbering manual fields', () => {
  const merged = mergePerformanceIntoRecapRow({
    old: {
      outcome_id: 'out_PG-D36_latest',
      page_id: 'PG-D36',
      cluster_id: 'celeb_wc',
      url: 'https://www.astrologywiki.com/en/wiki/bing-hastert-birth-chart',
      day14_收录: 'Y',
      索引修复状态: '已收录',
      决策: '继续',
      备注: 'manual note stays',
    },
    tracking: {
      title: 'Bing Hastert Birth Chart',
      published_at: '2026-06-01',
    },
    performance: {
      day14: { impressions: 7281, clicks: 29, ctr: 0.004, bestQuery: 'bing hastert birth chart', bestPosition: 8.2, top50Count: 4 },
      day30: { impressions: 9130, clicks: 41, ctr: 0.0045, bestQuery: 'bing hastert birth chart', bestPosition: 7.4, top50Count: 6 },
      day60: { pageViews: 812, targetCountryPageViews: 688 },
    },
    now: new Date('2026-07-07T00:00:00Z'),
  });

  assert.equal(merged.outcome_id, 'out_PG-D36_latest');
  assert.equal(merged.day14_收录, 'Y');
  assert.equal(merged.索引修复状态, '已收录');
  assert.equal(merged.day14_impressions, 7281);
  assert.equal(merged.记录日期, '2026-07-07');
  assert.equal(merged.day30_进Top50词数, 6);
  assert.equal(merged['当前最高排名词（排名）'], 'bing hastert birth chart (P7.4)');
  assert.equal(merged.day30_clicks, 41);
  assert.equal(merged.day60_pv, 812);
  assert.equal(merged.day60_目标国pv, 688);
  assert.equal(merged.决策, '继续');
  assert.match(merged.备注, /manual note stays/);
  assert.match(merged.备注, /Performance recap/);
});

test('classifyOptimizationTasks implements the recap action rules', () => {
  const tasks = classifyOptimizationTasks({
    page_id: 'PG-P0',
    slug: 'bing-hastert-birth-chart',
    title: 'Bing Hastert Birth Chart',
    url: 'https://www.astrologywiki.com/en/wiki/bing-hastert-birth-chart',
    day14_收录: 'Y',
    day14_impressions: 7281,
    day30_clicks: 29,
    day30_进Top50词数: 4,
    '当前最高排名词（排名）': 'bing hastert birth chart (P8.2)',
    day60_pv: 40,
    day60_目标国pv: 8,
    has_faq_schema: false,
  });

  assert.ok(tasks.some((task) => task.bucket === 'P0' && /title/.test(task.action)));
  assert.ok(tasks.some((task) => task.bucket === 'P1' && /FAQ schema/.test(task.action)));
  assert.ok(tasks.some((task) => task.bucket === 'P2' && /目标英语区/.test(task.reason)));

  const technical = classifyOptimizationTasks({
    page_id: 'PG-TECH',
    slug: 'zero-impression',
    url: 'https://www.astrologywiki.com/en/wiki/zero-impression',
    day14_收录: 'Y',
    day14_impressions: 0,
  });
  assert.equal(technical[0].bucket, '技术排查');
  assert.match(technical[0].action, /技术问题/);

  const intent = classifyOptimizationTasks({
    page_id: 'PG-INTENT',
    slug: 'no-top50',
    url: 'https://www.astrologywiki.com/en/wiki/no-top50',
    day14_收录: 'Y',
    day14_impressions: 120,
    day30_clicks: 0,
    day30_进Top50词数: 0,
  });
  assert.ok(intent.some((task) => task.bucket === 'P1' && /搜索意图/.test(task.action)));

  const observe = classifyOptimizationTasks({
    page_id: 'PG-OBSERVE',
    slug: 'low-impression',
    url: 'https://www.astrologywiki.com/en/wiki/low-impression',
    day14_收录: 'Y',
    day14_impressions: 7,
  });
  assert.equal(observe[0].bucket, 'P2');
  assert.match(observe[0].action, /60天后再看/);
});

test('renderOptimizationMarkdown groups the daily action list by priority', () => {
  const markdown = renderOptimizationMarkdown([
    { bucket: '技术排查', slug: 'zero-impression', reason: '已收录但零曝光', action: '排查技术问题' },
    { bucket: 'P0', slug: 'bing-hastert-birth-chart', reason: '曝光 7,281 次，CTR 仅 0.4%', action: '改 title + meta description' },
    { bucket: 'P1', slug: 'harry-kane-birth-chart', reason: '排名 P18', action: '加内链 + 确认 FAQ schema' },
  ], { generatedAt: new Date('2026-07-07T00:00:00Z'), siteName: 'AstrologyWiki' });

  assert.match(markdown, /^# AstrologyWiki 博客优化任务清单/m);
  assert.match(markdown, /生成时间：2026-07-07/);
  assert.match(markdown, /【技术排查】/);
  assert.match(markdown, /【P0 立即处理】/);
  assert.match(markdown, /【P1 本周处理】/);
  assert.match(markdown, /bing-hastert-birth-chart：曝光 7,281 次，CTR 仅 0.4%，改 title \+ meta description/);
});

test('fetchGscUrlMetrics filters target country with ISO alpha-3 code', async () => {
  let requestBody = null;
  const metrics = await fetchGscUrlMetrics(
    'analytics-token',
    'sc-domain:astrologywiki.com',
    'https://www.astrologywiki.com/en/wiki/bing-hastert-birth-chart',
    { startDate: '2026-06-01', endDate: '2026-06-14' },
    {
      targetCountry: 'US',
      fetcher: async (_url, _token, init) => {
        requestBody = JSON.parse(init.body);
        return {
          rows: [{
            keys: ['bing hastert birth chart'],
            clicks: 4,
            impressions: 100,
            ctr: 0.04,
            position: 8.2,
          }],
        };
      },
    },
  );

  const filters = requestBody.dimensionFilterGroups[0].filters;
  assert.deepEqual(filters.find((f) => f.dimension === 'country'), {
    dimension: 'country',
    operator: 'equals',
    expression: 'USA',
  });
  assert.equal(metrics.impressions, 100);
  assert.equal(metrics.bestPosition, 8.2);
});

test('runRecapPerformance updates recap rows and writes a Markdown task list without publish side effects', async () => {
  const calls = [];
  const code = await runRecapPerformance([
    '--write-sheet',
    '--write-report',
    '--workbook', 'wb-test',
    '--site', 'sc-domain:astrologywiki.com',
    '--ga4-property', 'properties/123',
  ], {
    now: new Date('2026-07-07T00:00:00Z'),
    sheetToken: 'sheet-token',
    analyticsToken: 'analytics-token',
    readTrackingRows: async () => [{
      page_id: 'PG-D36',
      slug: 'bing-hastert-birth-chart',
      title: 'Bing Hastert Birth Chart',
      url: 'https://www.astrologywiki.com/en/wiki/bing-hastert-birth-chart',
      published_at: '2026-06-01',
      monitor_status: 'indexed',
    }],
    readRecapRows: async () => [{
      _rowNumber: 9,
      outcome_id: 'out_PG-D36_latest',
      page_id: 'PG-D36',
      url: 'https://www.astrologywiki.com/en/wiki/bing-hastert-birth-chart',
      day14_收录: 'Y',
      索引修复状态: '已收录',
      备注: 'manual',
    }],
    fetchGscUrlMetrics: async (token, site, url, window) => {
      calls.push(['gsc', token, site, url, window.milestone]);
      return window.milestone === 'day14'
        ? { impressions: 7281, clicks: 29, ctr: 0.004, bestQuery: 'bing hastert birth chart', bestPosition: 8.2, top50Count: 4 }
        : { impressions: 9130, clicks: 41, ctr: 0.0045, bestQuery: 'bing hastert birth chart', bestPosition: 7.4, top50Count: 6 };
    },
    fetchGa4PageViews: async () => {
      calls.push(['ga4']);
      return { pageViews: 0, targetCountryPageViews: 0 };
    },
    batchUpdateRecapRows: async (token, workbookId, tabName, updates, appends) => {
      calls.push(['batchUpdate', token, workbookId, tabName, updates, appends]);
    },
    writeFile: async (path, content) => {
      calls.push(['writeFile', path, content]);
    },
  });

  assert.equal(code, 0);
  const batch = calls.find((call) => call[0] === 'batchUpdate');
  assert.ok(batch, 'expected recap batch update');
  assert.equal(batch[4].length, 1);
  assert.equal(batch[4][0].merged.day14_impressions, 7281);
  assert.equal(batch[4][0].merged.day30_clicks, 41);
  const write = calls.find((call) => call[0] === 'writeFile');
  assert.ok(write, 'expected markdown report write');
  assert.match(write[1], new RegExp(`${RECAP_PERFORMANCE_REPORT_DIR}/2026-07-07-astrologywiki-optimization-tasks.md$`));
  assert.match(write[2], /【P0 立即处理】/);
  assert.equal(calls.some((call) => /publish|author|deploy/i.test(String(call[0]))), false);
});

test('daily wrapper loops products and only runs recap performance sync', () => {
  const wrapper = readFileSync(join(SCRIPTS, 'gg-recap-performance-tick.sh'), 'utf8');
  assert.match(wrapper, /GG_RECAP_PERFORMANCE_PRODUCTS:-astrologywiki gengrowth/);
  assert.match(wrapper, /gg-recap-performance\.mjs/);
  assert.match(wrapper, /--write-sheet --write-report/);
  assert.match(wrapper, /GG_SHEETS_ASTROLOGY_WORKBOOK_ID/);
  assert.match(wrapper, /GG_SHEETS_GENGROWTH_WORKBOOK_ID/);
  assert.match(wrapper, /GG_GA4_ASTROLOGY_PROPERTY/);
  assert.match(wrapper, /GG_GA4_GENGROWTH_PROPERTY/);
  assert.doesNotMatch(wrapper, /gg-seo-author|gg-gengrowth-publish|Request Indexing|--submit-sitemap/);
});

test('launchd plist schedules the recap performance wrapper daily', () => {
  const plist = readFileSync(join(SCRIPTS, 'com.gengrowth.recap-performance.plist'), 'utf8');
  assert.match(plist, /com\.gengrowth\.recap-performance/);
  assert.match(plist, /gg-recap-performance-tick\.sh/);
  assert.match(plist, /StartCalendarInterval/);
  assert.match(plist, /<key>Hour<\/key>\s*<integer>10<\/integer>/);
  assert.match(plist, /recap_performance\/launchd\.out\.log/);
  assert.match(plist, /recap_performance\/launchd\.err\.log/);
});
