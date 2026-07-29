// The 选题登记表 Entity column is Title Case, which mangles acronyms and brands:
// INTP -> "Intp", BTS -> "Bts", IVE -> "Ive" (reads as "I've"). entity feeds the v8
// prompt and becomes the article's `## What Is <entity>?` H2, so the bad spelling
// reaches the published title. restoreEntityStylization puts them back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoreEntityStylization } from '../gg-sheet-to-brief.mjs';

const CASES = [
  ['Intp Zodiac Sign', 'INTP Zodiac Sign'],
  ['Esfp Zodiac Sign', 'ESFP Zodiac Sign'],
  ['Enfp Gemini', 'ENFP Gemini'],
  ['Bts Compatibility Zodiac', 'BTS Compatibility Zodiac'],
  ['Ive Members Zodiac Signs', 'IVE Members Zodiac Signs'],
  ['Rm Bts Birth Chart', 'RM BTS Birth Chart'],
  ['Highly Sensitive Person Hsp', 'Highly Sensitive Person HSP'],
];

for (const [input, expected] of CASES) {
  test(`restoreEntityStylization(${JSON.stringify(input)})`, () => {
    assert.equal(restoreEntityStylization(input), expected);
  });
}

// Whole-word only — an ordinary word that merely contains an acronym's letters
// must not be shouted, and an entity with no acronym must pass through untouched.
test('leaves ordinary words alone', () => {
  for (const s of ['Seventeen Zodiac Signs', 'Marvel Characters Zodiac Signs',
                   'Billie Eilish', 'Sabrina Carpenter', 'Rising Sign Meaning',
                   'Ivermectin Guide', 'Rmsomething']) {
    assert.equal(restoreEntityStylization(s), s, `should be unchanged: ${s}`);
  }
});

test('already-correct stylization is idempotent', () => {
  assert.equal(restoreEntityStylization('INTP Zodiac Sign'), 'INTP Zodiac Sign');
  assert.equal(restoreEntityStylization('BTS Members Zodiac Signs'), 'BTS Members Zodiac Signs');
});

test('null / empty input passes through', () => {
  assert.equal(restoreEntityStylization(null), null);
  assert.equal(restoreEntityStylization(''), '');
});
