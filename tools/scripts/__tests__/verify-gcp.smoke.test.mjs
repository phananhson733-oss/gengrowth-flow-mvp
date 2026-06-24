#!/usr/bin/env node
// Smoke tests for verify-gcp.mjs configuration hygiene.
// Run: node --test tools/scripts/__tests__/verify-gcp.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(__dirname, '..');

test('verify-gcp checks the canonical Flow MVP workbook before legacy workbook env', () => {
  const src = readFileSync(join(SCRIPTS, 'verify-gcp.mjs'), 'utf8');
  assert.match(src, /resolveWorkbookId/);
  assert.match(src, /GG_SHEETS_FLOW_MVP_WORKBOOK_ID/);
  assert.doesNotMatch(src, /workbookId:\s*process\.env\.GG_SHEETS_WORKBOOK_ID/);
});
