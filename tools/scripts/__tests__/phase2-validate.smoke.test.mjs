import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runStructuralChecks } from '../lib/iterate-prompt-checks.mjs';

const phase2Source = readFileSync(
  new URL('../_phase2-validate.mjs', import.meta.url),
  'utf8',
);
const phase2Path = fileURLToPath(new URL('../_phase2-validate.mjs', import.meta.url));
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

test('iterate rejects a forged pre-resolved structural profile instead of trusting its version alone', () => {
  assert.throws(() => runStructuralChecks('', {
    structuralProfile: {
      version: 'seo-structure-v1',
      h2Range: [0, 999],
      h3Range: [0, null],
      maxH4: 999,
      effectiveWordRange: [0, 999_999],
      keywordRange: [0, 999],
      tableMinimum: { columns: 0, rows: 0 },
      faqHeadingAliases: {},
    },
  }), /structural profile|h2Range|maxH4|invalid/i);
});

test('phase2 rejects excessive or inverted CLI structural overrides before touching the source', () => {
  const cases = [
    ['inverted word range', ['--word-min', '1800', '--word-max', '1500']],
    ['excessive word maximum', ['--word-max', '1000000']],
    ['inverted keyword range', ['--kw-min', '8', '--kw-max', '5']],
    ['excessive keyword maximum', ['--kw-max', '1000']],
    ['excessive H2 count', ['--expected-h2', '1000']],
  ];

  for (const [label, overrideArgs] of cases) {
    const tempDir = mkdtempSync(join(tmpdir(), 'phase2-structural-override-'));
    const sourcePath = join(tempDir, 'draft.md');
    const original = '# Test\r\n\r\nBody with trailing spaces.   \r\n';
    writeFileSync(sourcePath, original);
    try {
      const result = spawnSync(process.execPath, [
        phase2Path,
        '--source', sourcePath,
        '--tag', 'structural-override-test',
        '--page-id', 'page_structural_override_test',
        '--entity', 'Test Entity',
        '--target-keyword', 'test keyword',
        ...overrideArgs,
      ], {
        encoding: 'utf8',
        env: { ...process.env, GG_SITE: 'astrologywiki' },
      });

      assert.notEqual(result.status, 0, `${label} should fail closed`);
      assert.equal(readFileSync(sourcePath, 'utf8'), original, `${label} must not rewrite source`);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});
