import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildClusterLinkPlan,
  renderManagedClusterLinks,
  replaceManagedClusterLinks,
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
  assert.deepEqual(plan.get('PG-005').map((link) => link.page_id), ['PG-006']);
  for (const [pageId, links] of plan) {
    assert.equal(new Set(links.map((link) => link.slug)).size, links.length);
    assert.equal(links.some((link) => link.page_id === pageId), false);
  }
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
