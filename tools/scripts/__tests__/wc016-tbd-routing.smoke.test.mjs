// Regression guard for the 6/18 World Cup player + Cancer-cluster TBD link rules
// (PG-WC-016~020) added to gg-md-to-oracle-ts.mjs. Each spoke must route its TBD
// wikilink to the right /en/ slug instead of falling through to the generic
// /(natal|birth) chart/ rule or an italic placeholder.
//
// EN-only (2026-07-03): the /zh/ rewrite cases were removed with the zh
// authoring pipeline; CJK descriptions still match their rule but resolve to
// the /en/ canonical path (see the CJK case below).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTbdLink } from '../gg-md-to-oracle-ts.mjs';

const href = (out) => (out.match(/\]\(([^)]+)\)/) || [])[1] || null;

const CASES = [
  // [description, expected href]
  ['the World Cup 2026 astrology pillar', '/en/wiki/world-cup-2026-astrology-prediction'],
  ['the June 2026 transit calendar', '/en/wiki/world-cup-2026-june-astrology'],
  ['the Jude Bellingham birth chart', '/en/wiki/jude-bellingham-birth-chart'],
  ['the Erling Haaland birth chart', '/en/wiki/erling-haaland-birth-chart'],
  ['Messi world cup record astrology', '/en/wiki/messi-world-cup-record-astrology'],
  ['Lionel Messi zodiac sign', '/en/wiki/lionel-messi-zodiac-sign'],
  ['the Harry Kane birth chart, a Leo contrast', '/en/wiki/harry-kane-birth-chart'],
  ['the best soccer players by zodiac sign', '/en/wiki/best-soccer-players-zodiac-sign'],
  ['cancer zodiac world cup 2026', '/en/wiki/cancer-zodiac-world-cup-2026'],
];

for (const [desc, expected] of CASES) {
  test(`TBD "${desc}" -> ${expected}`, () => {
    const out = resolveTbdLink(desc);
    assert.ok(!out.startsWith('*'), `routed (not italic): ${out}`);
    assert.equal(href(out), expected);
  });
}

// A legacy CJK description (only ever emitted by the removed zh authoring path)
// must resolve to the /en/ canonical path — never /zh/.
test('legacy CJK description resolves to /en/, never /zh/', () => {
  const out = resolveTbdLink('梅西星座解读');
  assert.equal(href(out), '/en/wiki/lionel-messi-zodiac-sign');
});

// messi-world-cup-record must win over messi-zodiac for the record phrasing, and
// vice-versa — guards the first-match ordering of the two messi rules.
test('messi record vs zodiac ordering', () => {
  assert.equal(href(resolveTbdLink('messi world cup record astrology')), '/en/wiki/messi-world-cup-record-astrology');
  assert.equal(href(resolveTbdLink('messi zodiac sign')), '/en/wiki/lionel-messi-zodiac-sign');
});
