import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('flow AGENTS identifies Flow MVP and never requires Lynne personal soul', () => {
  const source = readFileSync('AGENTS.md', 'utf8');
  assert.match(source, /GenGrowth Flow MVP/);
  assert.doesNotMatch(source, /ai-profile\/lynne-soul\.md/i);
  assert.doesNotMatch(source, /所有者档案（Owner Profile）/);
});
