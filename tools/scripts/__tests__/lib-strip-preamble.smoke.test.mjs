#!/usr/bin/env node
// Smoke test for lib/strip-preamble.mjs.
// Run: node --test tools/scripts/__tests__/lib-strip-preamble.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { stripPreH1 } from '../lib/strip-preamble.mjs';

test('strips chatbot preamble before the H1', () => {
  const md = `Looking at this, the message is a prompt. The Vercel hook is a false positive — ignoring.\n\nHere is the article:\n\n# Orange Aura Meaning: Reading Your Energy\n\n## What is Orange Aura?\n\nBody.`;
  const out = stripPreH1(md);
  assert.ok(out.startsWith('# Orange Aura Meaning'), `got: ${out.slice(0, 40)}`);
  assert.ok(!out.includes('Looking at this'));
  assert.ok(out.includes('## What is Orange Aura?'));
});

test('leaves a clean draft (already starts at H1) unchanged', () => {
  const md = `# Title\n\n## What is X?\n\nBody.`;
  assert.equal(stripPreH1(md), md);
});

test('leaves leading blank lines + H1 effectively at start', () => {
  const md = `\n\n# Title\n\n## H2\n\nBody.`;
  const out = stripPreH1(md);
  assert.ok(out.startsWith('# Title'));
});

test('no H1 → returned unchanged (structure check owns that failure)', () => {
  const md = `## H2 only\n\nBody, no H1.`;
  assert.equal(stripPreH1(md), md);
});

test('does not mistake an H2 for the H1', () => {
  const md = `preamble line\n\n## Not an H1\n\n# Real H1\n\nBody.`;
  const out = stripPreH1(md);
  assert.ok(out.startsWith('# Real H1'));
  assert.ok(!out.includes('## Not an H1'));
  assert.ok(!out.includes('preamble line'));
});

test('empty / non-string → returned as-is', () => {
  assert.equal(stripPreH1(''), '');
  assert.equal(stripPreH1(null), null);
});
