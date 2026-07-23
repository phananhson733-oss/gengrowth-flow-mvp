import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildClusterLinkPlan,
  assertRegisteredOracleArticles,
  buildClusterLinkInput,
  parsePublishedArticleLog,
  readCanonicalClusterRows,
  resolveOraclePublishedArticles,
  renderManagedClusterLinks,
  replaceManagedClusterLinks,
  validateClusterLinkInput,
} from '../gg-cluster-internal-links.mjs';

const pages = [
  { page_id: 'PG-001', cluster_id: 'aura_colors', page_role: 'Hub', slug: 'aura-colors-guide', title: 'Aura Colors Guide', published: true },
  { page_id: 'PG-002', cluster_id: 'aura_colors', page_role: 'Spoke', slug: 'blue-aura-meaning', title: 'Blue Aura Meaning', published: true },
  { page_id: 'PG-003', cluster_id: 'aura_colors', page_role: 'Spoke', slug: 'green-aura-meaning', title: 'Green Aura Meaning', published: true },
  { page_id: 'PG-004', cluster_id: 'aura_colors', page_role: 'Spoke', slug: 'draft-aura-meaning', title: 'Draft Aura Meaning', published: false },
  { page_id: 'PG-005', cluster_id: 'planetary_placements_natal', page_role: 'Spoke', slug: 'venus-in-gemini', title: 'Venus in Gemini', published: true },
  { page_id: 'PG-006', cluster_id: 'planetary_placements_natal', page_role: 'Spoke', slug: 'mars-in-scorpio', title: 'Mars in Scorpio', published: true },
];

test('Hub/Spoke links are deterministic, published-only, deduplicated, and never self-links', () => {
  const plan = buildClusterLinkPlan(pages);
  assert.deepEqual(plan.get('PG-002').map((link) => link.page_id), ['PG-001']);
  assert.deepEqual(plan.get('PG-001').map((link) => link.page_id), ['PG-002', 'PG-003']);
  assert.equal(plan.has('PG-004'), false);
  assert.deepEqual(plan.get('PG-005').map((link) => link.page_id), ['tool:birth-chart-calculator']);
  for (const [pageId, links] of plan) {
    assert.equal(new Set(links.map((link) => link.slug)).size, links.length);
    assert.equal(links.some((link) => link.page_id === pageId), false);
  }
});

test('PRD cluster rules keep planet, artist, and IP links inside their declared group', () => {
  const planned = buildClusterLinkPlan([
    { page_id: 'P-01', cluster_id: 'planetary_placements_natal', page_role: 'Series', slug: 'venus-in-gemini', title: 'Venus in Gemini', published: true },
    { page_id: 'P-02', cluster_id: 'planetary_placements_natal', page_role: 'Series', slug: 'venus-in-taurus', title: 'Venus in Taurus', published: true },
    { page_id: 'P-03', cluster_id: 'planetary_placements_natal', page_role: 'Series', slug: 'mars-in-scorpio', title: 'Mars in Scorpio', published: true },
    { page_id: 'M-01', cluster_id: 'pop_music_birthchart', page_role: 'Pillar', artist_group: 'rihanna', slug: 'rihanna-birth-chart', title: 'Rihanna Birth Chart', published: true },
    { page_id: 'M-02', cluster_id: 'pop_music_birthchart', page_role: 'Series', artist_group: 'rihanna', slug: 'rihanna-zodiac-sign', title: 'Rihanna Zodiac Sign', published: true },
    { page_id: 'M-03', cluster_id: 'pop_music_birthchart', page_role: 'Pillar', artist_group: 'selena_gomez', slug: 'selena-gomez-birth-chart', title: 'Selena Gomez Birth Chart', published: true },
    { page_id: 'M-04', cluster_id: 'pop_music_birthchart', page_role: 'Series', artist_group: 'selena_gomez', slug: 'selena-gomez-zodiac-sign', title: 'Selena Gomez Zodiac Sign', published: true },
    { page_id: 'F-01', cluster_id: 'fiction_hp', page_role: 'Pillar', slug: 'harry-potter-characters-zodiac-signs', title: 'Harry Potter Characters', published: true },
    { page_id: 'F-02', cluster_id: 'fiction_hp', page_role: 'Series', slug: 'harry-potter-zodiac-sign', title: 'Harry Potter', published: true },
    { page_id: 'F-03', cluster_id: 'fiction_hp', page_role: 'Series', slug: 'hermione-granger-zodiac-sign', title: 'Hermione Granger', published: true },
    { page_id: 'F-04', cluster_id: 'fiction_hp', page_role: 'Series', slug: 'draco-malfoy-zodiac-sign', title: 'Draco Malfoy', published: true },
    { page_id: 'F-05', cluster_id: 'fiction_hp', page_role: 'Series', slug: 'ron-weasley-zodiac-sign', title: 'Ron Weasley', published: true },
    { page_id: 'K-01', cluster_id: 'kpop_bts', page_role: 'Pillar', slug: 'bts-members-zodiac-signs', title: 'BTS Members', published: true },
    { page_id: 'K-02', cluster_id: 'kpop_bts', page_role: 'Series', slug: 'jungkook-birth-chart', title: 'Jungkook Birth Chart', published: true },
    { page_id: 'K-03', cluster_id: 'kpop_blackpink', page_role: 'Pillar', slug: 'blackpink-zodiac-signs', title: 'BLACKPINK Members', published: true },
  ]);

  assert.deepEqual(
    planned.get('P-01').map((link) => link.href || `/en/wiki/${link.slug}`),
    ['/en/wiki/venus-in-taurus', '/en/birth-chart-calculator'],
  );
  assert.deepEqual(planned.get('M-02').map((link) => link.page_id), ['M-01']);
  assert.deepEqual(planned.get('M-01').map((link) => link.page_id), ['M-02']);
  assert.deepEqual(planned.get('M-04').map((link) => link.page_id), ['M-03']);
  assert.deepEqual(planned.get('F-02').map((link) => link.page_id), ['F-01', 'F-03', 'F-04', 'F-05']);
  assert.deepEqual(planned.get('F-01').map((link) => link.page_id), ['F-02', 'F-03', 'F-04', 'F-05']);
  assert.deepEqual(planned.get('K-02').map((link) => link.page_id), ['K-01']);
  assert.equal(planned.get('K-02').some((link) => link.page_id === 'K-03'), false);
});

test('Pillar links include every published Series and canonical input attests artist_group', () => {
  const spokes = Array.from({ length: 10 }, (_, index) => ({
    page_id: `S-${String(index + 1).padStart(2, '0')}`,
    cluster_id: 'saturn_return',
    page_role: 'Series',
    slug: `saturn-return-topic-${index + 1}`,
    title: `Saturn Return Topic ${index + 1}`,
    published: true,
  }));
  const planned = buildClusterLinkPlan([
    { page_id: 'H-01', cluster_id: 'saturn_return', page_role: 'Pillar', slug: 'saturn-return-guide', title: 'Saturn Return Guide', published: true },
    ...spokes,
  ]);
  assert.deepEqual(planned.get('H-01').map((link) => link.page_id), spokes.map((page) => page.page_id));

  const input = buildClusterLinkInput({
    pagesRaw: [
      ['Target Keyword', 'page_id', 'cluster_id', 'page_role', 'artist_group'],
      ['Rihanna birth chart', 'M-01', 'pop_music_birthchart', 'Pillar', 'rihanna'],
    ],
    clustersRaw: [['cluster_id'], ['pop_music_birthchart']],
    publishedArticles: [{ page_id: 'M-01', slug: 'rihanna-birth-chart', title: 'Rihanna Birth Chart' }],
  });
  assert.equal(input.pages[0].artist_group, 'rihanna');
});

test('managed Cluster links replace only their own block and are idempotent', () => {
  const links = [{ page_id: 'PG-001', slug: 'aura-colors-guide', title: 'Aura Colors Guide' }];
  const original = '# Title\n\nHuman prose and [manual link](/en/wiki/manual).\n\n## Related Reading\n\n- Manual item\n';
  const once = replaceManagedClusterLinks(original, links);
  const twice = replaceManagedClusterLinks(once, links);
  assert.equal(twice, once);
  assert.match(once, /Human prose and \[manual link\]/);
  assert.match(once, /Manual item/);
  assert.match(once, /<!-- gg-cluster-links:start -->/);
  assert.equal(renderManagedClusterLinks(links).match(/aura-colors-guide/g).length, 1);
});

test('Cluster link input accepts only one published OPS-approved page per page ID and slug', () => {
  const input = {
    version: 1,
    snapshot_id: 'a'.repeat(64),
    approved_cluster_ids: ['aura_colors'],
    pages: [{
      page_id: 'PG-001',
      cluster_id: 'aura_colors',
      page_role: 'Hub',
      slug: 'aura-colors-guide',
      title: 'Aura Colors Guide',
      published: true,
    }],
  };
  assert.deepEqual(validateClusterLinkInput(input), input);
  assert.throws(
    () => validateClusterLinkInput({ ...input, approved_cluster_ids: ['other_cluster'] }),
    /PG-001.*unapproved cluster_id/i,
  );
  assert.throws(
    () => validateClusterLinkInput({ ...input, pages: [...input.pages, { ...input.pages[0] }] }),
    /duplicate page_id.*PG-001/i,
  );
  assert.throws(
    () => validateClusterLinkInput({ ...input, pages: [{ ...input.pages[0], published: false }] }),
    /PG-001.*not published/i,
  );
});

test('canonical rows create a deterministic attested input and fail closed for a published page without OPS Cluster ID', () => {
  const pagesRaw = [
    ['Target Keyword', 'page_id', 'cluster_id', 'page_role'],
    ['Aura colors', 'PG-001', 'aura_colors', 'Hub'],
    ['Blue aura', 'PG-002', 'aura_colors', 'Spoke'],
  ];
  const clustersRaw = [
    ['cluster_id', 'cluster_name'],
    ['aura_colors', 'Aura Colors'],
  ];
  const publishedArticles = [
    { page_id: 'PG-001', slug: 'aura-colors-guide', title: 'Aura Colors Guide' },
    { page_id: 'PG-002', slug: 'blue-aura-meaning', title: 'Blue Aura Meaning' },
  ];
  const first = buildClusterLinkInput({ pagesRaw, clustersRaw, publishedArticles });
  const second = buildClusterLinkInput({ pagesRaw, clustersRaw, publishedArticles });
  assert.deepEqual(first, second);
  assert.match(first.snapshot_id, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.approved_cluster_ids, ['aura_colors']);
  assert.equal(first.pages[1].published, true);
  assert.throws(
    () => buildClusterLinkInput({
      pagesRaw: [pagesRaw[0], [pagesRaw[1][0], pagesRaw[1][1], '', pagesRaw[1][3]], pagesRaw[2]],
      clustersRaw,
      publishedArticles,
    }),
    /PG-001.*missing cluster_id/i,
  );
});

test('duplicate OPS Cluster metadata rows remain one approved Cluster ID without selecting metadata', () => {
  const pagesRaw = [
    ['Target Keyword', 'page_id', 'cluster_id', 'page_role'],
    ['Aura colors', 'PG-001', 'aura_colors', 'Hub'],
  ];
  const clustersRaw = [
    ['cluster_id', 'cluster_name'],
    ['aura_colors', 'Aura Colors'],
    ['aura_colors', 'Legacy Aura Colors'],
    ['moon_signs', 'Moon Signs'],
    ['moon_signs', 'Legacy Moon Signs'],
  ];
  const input = buildClusterLinkInput({
    pagesRaw,
    clustersRaw,
    publishedArticles: [{ page_id: 'PG-001', slug: 'aura-colors-guide', title: 'Aura Colors Guide' }],
  });
  assert.deepEqual(input.approved_cluster_ids, ['aura_colors', 'moon_signs']);
  assert.deepEqual(input.pages.map((page) => page.page_id), ['PG-001']);
});

test('published-register parser accepts only unique published Page ID to slug records', () => {
  const log = [
    '| 日期 | PG-id | slug | 标题 | 作者 | 线上 URL | 状态 |',
    '|---|---|---|---|---|---|---|',
    '| 2026-07-20 | PG-001 | aura-colors-guide | Aura Colors Guide | editor | https://example.test/en/wiki/aura-colors-guide | published |',
    '| 2026-07-21 | PG-002 | blue-aura-meaning | Blue Aura Meaning | editor | https://example.test/en/wiki/blue-aura-meaning | published |',
    '| 2026-07-22 | PG-003 | draft-page | Draft Page | editor | https://example.test/en/wiki/draft-page | planned |',
  ].join('\n');
  assert.deepEqual(parsePublishedArticleLog(log), [
    { page_id: 'PG-001', slug: 'aura-colors-guide', title: 'Aura Colors Guide' },
    { page_id: 'PG-002', slug: 'blue-aura-meaning', title: 'Blue Aura Meaning' },
  ]);
  assert.throws(
    () => parsePublishedArticleLog(`${log}\n| 2026-07-22 | PG-001 | renamed | Renamed | editor | https://example.test/en/wiki/renamed | published |`),
    /duplicate published page_id PG-001/i,
  );
});

test('canonical reader fetches only Pages and Cluster tabs from one injected read boundary', async () => {
  const calls = [];
  const rows = await readCanonicalClusterRows({
    readRows: async (tab) => {
      calls.push(tab);
      return [[tab]];
    },
  });
  assert.deepEqual(calls, ['选题登记表', '主题集群表']);
  assert.deepEqual(rows, { pagesRaw: [['选题登记表']], clustersRaw: [['主题集群表']] });
});

test('Oracle registration verifier rejects a missing or unregistered article before apply', () => {
  const root = mkdtempSync(join(tmpdir(), 'gg-cluster-links-oracle-'));
  try {
    const articles = join(root, 'data', 'articles');
    mkdirSync(articles, { recursive: true });
    writeFileSync(join(articles, 'index.ts'), 'import { alpha } from "./alpha";\n');
    writeFileSync(join(articles, 'alpha.ts'), 'export const alpha = {};\n');
    assert.doesNotThrow(() => assertRegisteredOracleArticles(root, [{ page_id: 'PG-001', slug: 'alpha' }]));
    assert.throws(
      () => assertRegisteredOracleArticles(root, [{ page_id: 'PG-002', slug: 'beta' }]),
      /PG-002.*registered Oracle article file/i,
    );
    writeFileSync(join(articles, 'beta.ts'), 'export const beta = {};\n');
    assert.throws(
      () => assertRegisteredOracleArticles(root, [{ page_id: 'PG-002', slug: 'beta' }]),
      /PG-002.*registered in Oracle article index/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('published-log slugs resolve only through an Oracle permanent English wiki redirect', () => {
  const root = mkdtempSync(join(tmpdir(), 'gg-cluster-links-redirect-'));
  try {
    const articles = join(root, 'data', 'articles');
    mkdirSync(articles, { recursive: true });
    writeFileSync(join(articles, 'index.ts'), 'import { canonical } from "./canonical";\n');
    writeFileSync(join(articles, 'canonical.ts'), 'export const canonical = {};\n');
    writeFileSync(join(root, 'vercel.json'), JSON.stringify({ redirects: [
      { source: '/en/wiki/retired', destination: '/en/wiki/canonical', permanent: true },
      { source: '/en/wiki/temporary', destination: '/en/wiki/canonical', permanent: false },
    ] }));

    assert.deepEqual(
      resolveOraclePublishedArticles(root, [{ page_id: 'PG-001', slug: 'retired', title: 'Canonical title' }]),
      [{ page_id: 'PG-001', slug: 'canonical', title: 'Canonical title' }],
    );
    assert.throws(
      () => assertRegisteredOracleArticles(root, resolveOraclePublishedArticles(root, [{ page_id: 'PG-002', slug: 'temporary', title: 'Temporary' }])),
      /PG-002.*registered Oracle article file/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
