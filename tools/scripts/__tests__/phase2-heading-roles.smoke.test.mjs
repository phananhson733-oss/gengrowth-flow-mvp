#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { hasEnComparisonHeading } from '../lib/phase2-heading-roles.mjs';

test('recognizes a prompt-approved "How X Differs From Y" H2 below the H1', () => {
  const draft = [
    '# How Long Does Saturn Return Last?',
    '',
    '## What Is a Saturn Return?',
    '',
    'Body.',
    '',
    '## How a Saturn Return Differs From a Saturn Square',
    '',
    'Comparison.',
  ].join('\n');

  assert.equal(hasEnComparisonHeading(draft), true);
});

test('recognizes X vs Y but rejects the boilerplate adjacent-concepts heading', () => {
  assert.equal(hasEnComparisonHeading('## Blue Aura vs Green Aura'), true);
  assert.equal(hasEnComparisonHeading('## Blue Aura vs Adjacent Concepts'), false);
});
