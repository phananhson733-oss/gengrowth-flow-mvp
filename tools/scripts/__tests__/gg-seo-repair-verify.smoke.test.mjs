import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyRepairTarget } from '../gg-seo-repair-verify.mjs';

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
      cta_target_url: 'https://astrologywiki.com/en/birth-chart-calculator',
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
  ['cta_matches_sheet', (d) => {
    d.sheetRow.cta_target_url = 'https://astrologywiki.com/forecast';
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
