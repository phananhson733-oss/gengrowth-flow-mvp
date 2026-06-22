#!/usr/bin/env node
// Smoke tests for lib/oracle-live.mjs — reconciling "no row in 选题登记表" authoring
// failures whose topic is already published in oracle (the stale-duplicate park class).
// Run: node --test tools/scripts/__tests__/lib-oracle-live.smoke.test.mjs
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keywordLiveSlug } from '../lib/oracle-live.mjs';

function fixtureOracle(slugs) {
  const root = mkdtempSync(join(tmpdir(), 'oracle-live-'));
  const dir = join(root, 'data', 'articles');
  mkdirSync(dir, { recursive: true });
  for (const s of slugs) writeFileSync(join(dir, `${s}.ts`), 'export default {};\n');
  writeFileSync(
    join(dir, 'index.ts'),
    slugs.map((s) => `export { default as ${s.replace(/-/g, '_')} } from "./${s}";`).join('\n') + '\n',
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('keywordLiveSlug returns the slug when the keyword topic is already live + indexed', () => {
  const fx = fixtureOracle(['north-node-in-leo', 'rahu-and-ketu-astrology']);
  try {
    assert.equal(keywordLiveSlug('north node in leo', fx.root), 'north-node-in-leo');
    assert.equal(keywordLiveSlug('Rahu and Ketu Astrology', fx.root), 'rahu-and-ketu-astrology');
  } finally {
    fx.cleanup();
  }
});

test('keywordLiveSlug returns null when no matching article exists', () => {
  const fx = fixtureOracle(['north-node-in-leo']);
  try {
    assert.equal(keywordLiveSlug('totally unrelated topic xyz', fx.root), null);
  } finally {
    fx.cleanup();
  }
});

test('keywordLiveSlug returns null when the .ts exists but is NOT registered in index.ts', () => {
  const root = mkdtempSync(join(tmpdir(), 'oracle-live-'));
  const dir = join(root, 'data', 'articles');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'orphan-slug.ts'), 'export default {};\n');
  writeFileSync(join(dir, 'index.ts'), '// nothing imported here\n');
  try {
    assert.equal(keywordLiveSlug('orphan slug', root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('keywordLiveSlug returns null for an empty/blank keyword', () => {
  const fx = fixtureOracle(['x-y-z']);
  try {
    assert.equal(keywordLiveSlug('', fx.root), null);
    assert.equal(keywordLiveSlug('   ', fx.root), null);
  } finally {
    fx.cleanup();
  }
});
