import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const phase2Source = readFileSync(
  new URL('../_phase2-validate.mjs', import.meta.url),
  'utf8',
);
const iterateSource = readFileSync(
  new URL('../lib/iterate-prompt-checks.mjs', import.meta.url),
  'utf8',
);

test('phase2 resolves one versioned profile and applies only its effective structural thresholds', () => {
  assert.match(phase2Source, /resolveStructuralProfile/);
  assert.match(phase2Source, /effectiveWordRange/);
  assert.match(phase2Source, /h2Range/);
  assert.match(phase2Source, /keywordRange/);
  assert.doesNotMatch(phase2Source, /Math\.(?:floor|ceil)\([^)]*0\.99/);
});

test('phase2 normalizes once before validation and writes only a protected-safe changed source', () => {
  assert.match(phase2Source, /normalizeStructuralMarkdown/);
  assert.match(phase2Source, /protectedDigestBefore/);
  assert.match(phase2Source, /protectedDigestAfter/);
  assert.match(phase2Source, /changes\.length\s*>\s*0/);
});

test('iterate structural checks share the same profile and normalizer instead of a second threshold table', () => {
  assert.match(iterateSource, /resolveStructuralProfile/);
  assert.match(iterateSource, /normalizeStructuralMarkdown/);
  assert.doesNotMatch(iterateSource, /const\s+\[lo,\s*hi\]\s*=\s*spec\.word_range\s*\|\|\s*\[1500,\s*1800\]/);
});
