import test from 'node:test';
import assert from 'node:assert/strict';

import {
  authorFailureText,
  mergeAuthorFailures,
} from '../lib/author-failure-memory.mjs';

test('author failure memory preserves arrays as distinct deduplicated constraints', () => {
  const failures = mergeAuthorFailures(
    ['word count 1406 outside [1500, 1800]', 'RL4 drifted sections: Common Misreadings'],
    ['RL4 drifted sections: Common Misreadings', 'RL5 keyword count 11 outside [5, 8]'],
  );

  assert.deepEqual(failures, [
    'word count 1406 outside [1500, 1800]',
    'RL4 drifted sections: Common Misreadings',
    'RL5 keyword count 11 outside [5, 8]',
  ]);
  assert.equal(authorFailureText(failures).split('\n').length, 3);
});
