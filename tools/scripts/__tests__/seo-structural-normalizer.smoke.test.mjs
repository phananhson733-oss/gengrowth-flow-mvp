import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeStructuralMarkdown } from '../lib/seo-structural-normalizer.mjs';

function profileFixture() {
  return {
    version: 'seo-structure-v1',
    faqHeadingAliases: {
      '## FAQ': '## Frequently Asked Questions',
      '## FAQs': '## Frequently Asked Questions',
    },
  };
}

function fixtureMarkdownWithProtectedContent() {
  return [
    '---\r',
    'title: "SEO Forecast 2026"\r',
    'slug: seo-forecast-2026\r',
    'canonical: https://example.com/en/blog/seo-forecast-2026?utm_source=qa#summary\r',
    'hero: /images/seo-forecast-2026.svg\r',
    '---\r',
    '# SEO Forecast 2026   \r',
    '\r',
    '\r',
    '\r',
    'The 2025 benchmark was 42.5%, based on 1,250 sampled pages.   \r',
    '\r',
    '* First observation   \r',
    '+ Second observation\r',
    '\r',
    '```md\r',
    '* keep this marker   \r',
    '\r',
    '\r',
    'https://inside.example/path?q=1#code\r',
    '```\r',
    '\r',
    '## FAQ\r',
    '\r',
    '**What changed on 2026-07-16?**\r',
    'The protected number stayed 42.5%.\r',
    '\r',
    '![Forecast chart](/images/seo-forecast-2026.svg)\r',
    '\r',
    '## Take Action\r',
    '[Start the audit](https://example.com/start?plan=pro#signup)\r',
    '\r',
    '## Sources\r',
    '- Source: [Search report](https://source.example/report?year=2025#table)\r',
    '',
  ].join('\n');
}

test('normalizer is deterministic, idempotent and preserves protected semantics', () => {
  const source = fixtureMarkdownWithProtectedContent();
  const first = normalizeStructuralMarkdown(source, profileFixture());
  const second = normalizeStructuralMarkdown(first.markdown, profileFixture());

  assert.equal(first.protectedDigestAfter, first.protectedDigestBefore);
  assert.equal(second.markdown, first.markdown);
  assert.deepEqual(second.changes, []);
  assert.match(first.markdown, /^---\ntitle: "SEO Forecast 2026"\nslug: seo-forecast-2026\n/m);
  assert.match(first.markdown, /https:\/\/example\.com\/en\/blog\/seo-forecast-2026\?utm_source=qa#summary/);
  assert.match(first.markdown, /!\[Forecast chart\]\(\/images\/seo-forecast-2026\.svg\)/);
});

test('normalizer performs only the declared mechanical transformations', () => {
  const result = normalizeStructuralMarkdown(fixtureMarkdownWithProtectedContent(), profileFixture());
  const outsideCode = result.markdown.replace(/```[\s\S]*?```/g, '');

  assert.doesNotMatch(result.markdown, /\r/);
  assert.doesNotMatch(result.markdown, / +$/m);
  assert.doesNotMatch(outsideCode, /\n{3,}/);
  assert.match(result.markdown, /^- First observation$/m);
  assert.match(result.markdown, /^- Second observation$/m);
  assert.match(result.markdown, /^## Frequently Asked Questions$/m);
  assert.ok(result.changes.length > 0);
});

test('normalizer preserves code-fence body bytes except global CRLF conversion', () => {
  const source = [
    '# Guide\r',
    '\r',
    '```md\r',
    '* keep this marker   \r',
    '\r',
    '\r',
    '+ keep this marker too\r',
    '```\r',
    '',
  ].join('\n');
  const result = normalizeStructuralMarkdown(source, profileFixture());

  assert.match(result.markdown, /```md\n\* keep this marker   \n\n\n\+ keep this marker too\n```/);
});

test('normalizer preserves frontmatter facts, URL query/hash, CTA/source lines and image references', () => {
  const source = fixtureMarkdownWithProtectedContent();
  const result = normalizeStructuralMarkdown(source, profileFixture());

  for (const protectedText of [
    'title: "SEO Forecast 2026"',
    'slug: seo-forecast-2026',
    'The 2025 benchmark was 42.5%, based on 1,250 sampled pages.',
    '[Start the audit](https://example.com/start?plan=pro#signup)',
    '- Source: [Search report](https://source.example/report?year=2025#table)',
    '![Forecast chart](/images/seo-forecast-2026.svg)',
  ]) {
    assert.match(result.markdown, new RegExp(protectedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.equal(result.protectedDigestAfter, result.protectedDigestBefore);
});
