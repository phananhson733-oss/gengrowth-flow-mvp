#!/usr/bin/env node
// Run: node --test tools/scripts/__tests__/lib-cta-selector.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { selectCta } from '../lib/cta-selector.mjs';

const CTAS = [
  {
    cta_id: 'cta_app',
    cta_text: 'Start your free trial',
    target_url: 'https://gengrowth.ai/app',
    cta_kind: 'product',
    match_keywords: 'trial;get started;*',
    blog_eligible: 'TRUE',
    priority: '10',
  },
  {
    cta_id: 'cta_pricing',
    cta_text: 'Explore plans',
    target_url: 'https://gengrowth.ai/en/pricing',
    cta_kind: 'product',
    match_keywords: 'pricing;price;cost;plan',
    blog_eligible: 'TRUE',
    priority: '100',
  },
  {
    cta_id: 'cta_features',
    cta_text: 'Explore features',
    target_url: 'https://gengrowth.ai/en/features',
    cta_kind: 'feature',
    match_keywords: 'seo;automation;analytics',
    blog_eligible: 'TRUE',
    priority: '100',
  },
  {
    cta_id: 'cta_blog_article',
    cta_text: 'Read our pricing article',
    target_url: 'https://gengrowth.ai/en/blog/pricing',
    cta_kind: 'blog',
    match_keywords: 'pricing',
    blog_eligible: 'FALSE',
    priority: '999',
  },
  {
    cta_id: 'cta_foreign',
    cta_text: 'Foreign CTA',
    target_url: 'https://astrologywiki.com/en/birth-chart-calculator',
    cta_kind: 'tool',
    match_keywords: 'pricing',
    blog_eligible: 'TRUE',
    priority: '999',
  },
];

const CONTEXT = { target_keyword: 'gengrowth pricing', entity: 'pricing' };

test('target keyword selects the matching eligible CTA instead of higher-priority blog or foreign rows', () => {
  const selected = selectCta({ candidates: CTAS, context: CONTEXT, allowedHost: 'gengrowth.ai' });
  assert.equal(selected.ok, true);
  assert.equal(selected.cta_id, 'cta_pricing');
  assert.equal(selected.target_url, 'https://gengrowth.ai/en/pricing');
  assert.match(selected.cta_selection_reason, /target_keyword/i);
});

test('explicit catalog CTA wins only when it is eligible for the current product', () => {
  const selected = selectCta({
    candidates: CTAS,
    context: { ...CONTEXT, explicit_cta: 'cta_features' },
    allowedHost: 'gengrowth.ai',
  });
  assert.equal(selected.cta_id, 'cta_features');
  assert.match(selected.cta_selection_reason, /explicit/i);

  const rejected = selectCta({
    candidates: CTAS,
    context: { ...CONTEXT, explicit_cta: 'cta_blog_article' },
    allowedHost: 'gengrowth.ai',
  });
  assert.equal(rejected.cta_id, 'cta_pricing');
});

test('generic content uses the sole wildcard fallback', () => {
  const selected = selectCta({
    candidates: CTAS,
    context: { target_keyword: 'growth strategy', entity: 'growth strategy' },
    allowedHost: 'gengrowth.ai',
  });
  assert.equal(selected.cta_id, 'cta_app');
  assert.match(selected.cta_selection_reason, /wildcard/i);
});

test('ties are deterministic: priority descending, then cta_id ascending', () => {
  const candidates = [
    ...CTAS.filter((cta) => cta.cta_id === 'cta_app'),
    {
      cta_id: 'cta_zeta', cta_text: 'Zeta', target_url: 'https://gengrowth.ai/z', cta_kind: 'product',
      match_keywords: 'research', blog_eligible: 'TRUE', priority: '2',
    },
    {
      cta_id: 'cta_alpha', cta_text: 'Alpha', target_url: 'https://gengrowth.ai/a', cta_kind: 'product',
      match_keywords: 'research', blog_eligible: 'TRUE', priority: '2',
    },
  ];
  const selected = selectCta({
    candidates,
    context: { target_keyword: 'research workflow' },
    allowedHost: 'gengrowth.ai',
  });
  assert.equal(selected.cta_id, 'cta_alpha');
});

test('returns a publish-blocking result when there is no semantic or wildcard match', () => {
  const selected = selectCta({
    candidates: CTAS.filter((cta) => cta.cta_id !== 'cta_app'),
    context: { target_keyword: 'growth strategy' },
    allowedHost: 'gengrowth.ai',
  });
  assert.deepEqual(selected, { ok: false, reason: 'no_eligible_cta_match' });
});
