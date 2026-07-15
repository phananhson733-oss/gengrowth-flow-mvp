import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveCtaAudits,
  verifyGengrowthRepairTarget,
  verifyRepairTarget,
} from '../gg-seo-repair-verify.mjs';

const TARGET = { pageId: 'PG-A-001', slug: 'alpha', stage: 'authoring' };
const URL = 'https://www.astrologywiki.com/en/wiki/alpha';

function goodDeps() {
  return {
    claim: {
      status: 'done',
      slug: 'alpha',
      branch: 'seo/auto/2026-07-15-PG-A-001',
      mergedAt: '2026-07-15T10:00:00Z',
    },
    planText: '- [x] `PG-A-001` alpha\n',
    publishLogText: `| 2026-07-15 | PG-A-001 | alpha | ${URL} |\n`,
    sheetRow: {
      status: '已发布',
      publish_url: URL,
    },
    ctaAudit: {
      cta_id: 'url_tool_birth_chart',
      cta_target_url: 'https://astrologywiki.com/en/birth-chart-calculator',
      cta_intent_tags: 'natal-self',
      cta_selection_reason: 'semantic_match:intent_tags:natal-self',
    },
    pendingWriteback: null,
    fetchDocument: async (url) => url.endsWith('/sitemap.xml')
      ? { ok: true, status: 200, text: `<url><loc>${URL}</loc></url>` }
      : {
          ok: true,
          status: 200,
          text: `<html><head><link href="${URL}" rel="canonical"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Article"}</script></head><body><a href="/en/birth-chart-calculator">Take Action</a></body></html>`,
        },
  };
}

test('all deterministic publish and backfill checks produce published terminal', async () => {
  const result = await verifyRepairTarget(TARGET, goodDeps());
  assert.equal(result.ok, true);
  assert.equal(result.terminal, 'published');
  assert.deepEqual(Object.values(result.checks).every(Boolean), true);
});

const failures = [
  ['ledger_done', (d) => { d.claim.status = 'needs_human'; }],
  ['branch_and_merge', (d) => { delete d.claim.mergedAt; }],
  ['http_200', (d) => { d.fetchDocument = async () => ({ ok: false, status: 503, text: '' }); }],
  ['canonical', (d) => {
    d.fetchDocument = async (url) => url.endsWith('/sitemap.xml')
      ? { ok: true, status: 200, text: `<loc>${URL}</loc>` }
      : { ok: true, status: 200, text: '<script type="application/ld+json">{"@type":"Article"}</script>' };
  }],
  ['article_jsonld', (d) => {
    d.fetchDocument = async (url) => url.endsWith('/sitemap.xml')
      ? { ok: true, status: 200, text: `<loc>${URL}</loc>` }
      : { ok: true, status: 200, text: `<link rel="canonical" href="${URL}">` };
  }],
  ['sitemap', (d) => {
    const original = d.fetchDocument;
    d.fetchDocument = async (url) => url.endsWith('/sitemap.xml')
      ? { ok: true, status: 200, text: '<urlset></urlset>' }
      : original(url);
  }],
  ['plan_checked', (d) => { d.planText = '- [ ] `PG-A-001` alpha\n'; }],
  ['publish_log', (d) => { d.publishLogText = ''; }],
  ['sheet_published', (d) => { d.sheetRow = { status: '待写', publish_url: '' }; }],
  ['cta_audit', (d) => {
    d.ctaAudit.cta_intent_tags = '';
  }],
  ['cta_matches_map', (d) => {
    d.ctaAudit.cta_target_url = 'https://astrologywiki.com/forecast';
  }],
  ['writeback_clear', (d) => { d.pendingWriteback = { pageId: 'PG-A-001', done: ['sheet'] }; }],
];

for (const [check, mutate] of failures) {
  test(`failed ${check} check never reports published`, async () => {
    const deps = goodDeps();
    mutate(deps);
    const result = await verifyRepairTarget(TARGET, deps);
    assert.equal(result.ok, false);
    assert.equal(result.terminal, 'pending');
    assert.equal(result.checks[check], false);
    assert.match(result.reason, new RegExp(check));
  });
}

test('canonical parser accepts rel/href attributes in either order', async () => {
  const deps = goodDeps();
  deps.fetchDocument = async (url) => url.endsWith('/sitemap.xml')
    ? { ok: true, status: 200, text: `<loc>${URL}</loc>` }
    : { ok: true, status: 200, text: `<link href="${URL}" data-x="1" rel="canonical"><script type="application/ld+json">{"@type":"Article"}</script>` };
  assert.equal((await verifyRepairTarget(TARGET, deps)).checks.canonical, true);
});

test('CTA audit is re-derived from the current pages row and CTA Map', () => {
  const pagesRaw = [
    ['Target Keyword', 'Status', 'URL', 'page_id', 'CTA', 'Entity'],
    ['why am I afraid of commitment', '已发布', URL, 'PG-A-001', 'https://astrologywiki.com/en/birth-chart-calculator', 'commitment patterns'],
  ];
  const ctaRaw = [
    ['cta_id', 'page_role', 'cta_文案', 'target_url', 'cta_kind', 'blog_eligible', 'priority', 'intent_tags'],
    ['url_tool_birth_chart', 'article', 'Read Your Birth Chart', 'https://astrologywiki.com/en/birth-chart-calculator', 'tool', 'Y', '10', 'natal-self'],
  ];
  const audits = deriveCtaAudits([TARGET], { pagesRaw, clustersRaw: [], ctaRaw });
  assert.deepEqual(audits['PG-A-001'], {
    cta_id: 'url_tool_birth_chart',
    cta_target_url: 'https://astrologywiki.com/en/birth-chart-calculator',
    cta_intent_tags: 'natal-self',
    cta_selection_reason: 'explicit_catalog_cta:url_tool_birth_chart',
  });
});

test('explicit archived terminal is accepted without calling live dependencies', async () => {
  let calls = 0;
  const result = await verifyRepairTarget(
    { ...TARGET, terminal: 'archived', terminalReason: 'stale topic — do not publish' },
    { fetchDocument: async () => { calls++; throw new Error('should not fetch'); } },
  );
  assert.equal(result.ok, true);
  assert.equal(result.terminal, 'archived');
  assert.equal(calls, 0);
});

test('gengrowth verifier requires Supabase, live page, W25 plan, Sheet, vault, and clear writeback', async () => {
  const target = { pageId: 'PG-WLS-007', slug: 'chatgpt-seo' };
  const url = 'https://gengrowth.ai/en/blog/chatgpt-seo';
  const deps = {
    supabaseRow: { status: 'published', slug: 'chatgpt-seo', locale: 'en' },
    manifest: { phase2_checks: { overall: 'pass' } },
    planText: '- [x] `PG-WLS-007` chatgpt seo\n',
    sheetRow: { status: '已发布', publish_url: url },
    vaultArchived: true,
    pendingWriteback: null,
    fetchDocument: async (requested) => requested.endsWith('/sitemap.xml')
      ? { ok: true, status: 200, text: `<loc>${url}</loc>` }
      : {
          ok: true,
          status: 200,
          text: `<link rel="canonical" href="${url}"><script type="application/ld+json">{"@type":"Article"}</script>`,
        },
  };
  const result = await verifyGengrowthRepairTarget(target, deps);
  assert.equal(result.ok, true);
  assert.equal(result.terminal, 'published');
  assert.equal(Object.values(result.checks).every(Boolean), true);

  for (const [check, mutate] of [
    ['supabase_published', (copy) => { copy.supabaseRow = { status: 'draft' }; }],
    ['staging_manifest', (copy) => { copy.manifest = { phase2_checks: { overall: 'fail' } }; }],
    ['plan_checked', (copy) => { copy.planText = '- [ ] `PG-WLS-007` chatgpt seo\n'; }],
    ['sheet_published', (copy) => { copy.sheetRow = { status: '待发布', publish_url: '' }; }],
    ['vault_archived', (copy) => { copy.vaultArchived = false; }],
    ['writeback_clear', (copy) => { copy.pendingWriteback = { pageId: 'PG-WLS-007' }; }],
  ]) {
    const copy = { ...deps };
    mutate(copy);
    const failed = await verifyGengrowthRepairTarget(target, copy);
    assert.equal(failed.ok, false, check);
    assert.equal(failed.checks[check], false, check);
  }
});

test('gengrowth verifier CLI accepts one exact page and emits named terminal checks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gengrowth-repair-verify-cli-'));
  const fixture = join(dir, 'fixture.json');
  const url = 'https://gengrowth.ai/en/blog/chatgpt-seo';
  writeFileSync(fixture, JSON.stringify({
    supabaseRow: { status: 'published', slug: 'chatgpt-seo', locale: 'en' },
    manifest: { phase2_checks: { overall: 'pass' } },
    planText: '- [x] `PG-WLS-007` chatgpt seo\n',
    sheetRow: { status: '已发布', publish_url: url },
    vaultArchived: true,
    pendingWriteback: null,
    pageHtml: `<link rel="canonical" href="${url}"><script type="application/ld+json">{"@type":"Article"}</script>`,
    sitemapText: `<loc>${url}</loc>`,
  }));
  const result = spawnSync('node', [
    'tools/scripts/gg-seo-repair-verify.mjs',
    '--site', 'gengrowth',
    '--page-id', 'PG-WLS-007',
    '--slug', 'chatgpt-seo',
    '--gengrowth-fixture', fixture,
    '--json',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, GG_FLOW_STATE_DIR: join(dir, 'state') },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.results[0].pageId, 'PG-WLS-007');
  assert.equal(output.results[0].terminal, 'published');
  assert.equal(Object.values(output.results[0].checks).every(Boolean), true);
});

test('CLI JSON keeps pageId and slug attached to each verifier result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repair-verify-cli-'));
  const targets = join(dir, 'targets.json');
  const claims = join(dir, 'claims.json');
  const plan = join(dir, 'plan.md');
  writeFileSync(targets, JSON.stringify([{
    pageId: 'PG-S-001',
    slug: 'stale-topic',
    terminal: 'archived',
    terminalReason: 'stale topic — do not publish',
  }]));
  writeFileSync(claims, '{}');
  writeFileSync(plan, '- [ ] `PG-S-001` stale topic\n');

  const result = spawnSync('node', [
    'tools/scripts/gg-seo-repair-verify.mjs',
    '--targets', targets,
    '--claims', claims,
    '--plan', plan,
    '--json',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, GG_FLOW_STATE_DIR: join(dir, 'state') },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.results[0].pageId, 'PG-S-001');
  assert.equal(output.results[0].slug, 'stale-topic');
  assert.equal(output.results[0].terminal, 'archived');
});
