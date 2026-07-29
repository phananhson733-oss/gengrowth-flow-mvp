// Regression guard for the 执行表 v2 TBD link rules added to gg-md-to-oracle-ts.mjs:
// 实验七 K-pop 星盘 (BTS / BLACKPINK), 实验八 虚构角色 (Harry Potter), 实验九 流行音乐,
// plus the 7/24 celebrity-athlete spokes.
//
// WHY: the 7/27 batch shipped as orphan pages because none of these slugs had a rule —
// every "Related Reading" TBD fell through to an italic placeholder, so no page linked
// to any other page in the cluster. These cases lock the routing in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTbdLink } from '../gg-md-to-oracle-ts.mjs';

const href = (out) => (out.match(/\]\(([^)]+)\)/) || [])[1] || null;

const CASES = [
  // 实验七 K-pop — member spokes
  ['the Suga BTS birth chart', '/en/wiki/suga-bts-birth-chart'],
  ['the RM BTS birth chart', '/en/wiki/rm-bts-birth-chart'],
  ['Kim Namjoon birth chart', '/en/wiki/rm-bts-birth-chart'],
  ['the Jisoo birth chart', '/en/wiki/jisoo-birth-chart'],
  // 实验七 K-pop — group pillars
  ['BTS members zodiac signs', '/en/wiki/bts-members-zodiac-signs'],
  ['BLACKPINK zodiac signs', '/en/wiki/blackpink-zodiac-signs'],
  // 实验八 虚构角色
  ['Severus Snape zodiac sign', '/en/wiki/severus-snape-zodiac-sign'],
  ['Dumbledore zodiac sign', '/en/wiki/dumbledore-zodiac-sign'],
  ['Harry Potter characters zodiac signs', '/en/wiki/harry-potter-characters-zodiac-signs'],
  // 实验九 流行音乐
  ['the Rihanna birth chart', '/en/wiki/rihanna-birth-chart'],
  ['the Selena Gomez birth chart', '/en/wiki/selena-gomez-birth-chart'],
  // 7/24 名人/运动员
  ['Jalen Brunson birth chart', '/en/wiki/jalen-brunson-birth-chart'],
  ['Robert Downey Jr birth chart', '/en/wiki/robert-downey-jr-birth-chart'],
  ['Shohei Ohtani birth chart', '/en/wiki/shohei-ohtani-birth-chart'],
  ['Victor Wembanyama zodiac sign', '/en/wiki/victor-wembanyama-zodiac-sign'],
];

for (const [desc, expected] of CASES) {
  test(`TBD "${desc}" -> ${expected}`, () => {
    const out = resolveTbdLink(desc);
    assert.ok(!out.startsWith('*'), `routed (not italic): ${out}`);
    assert.equal(href(out), expected);
  });
}

// Member spokes must win over their group pillar (first-match ordering): a description
// naming one member must never be swallowed by the group rule.
test('member spoke wins over group pillar', () => {
  assert.equal(href(resolveTbdLink('Jisoo birth chart from the BLACKPINK zodiac signs guide')), '/en/wiki/jisoo-birth-chart');
  assert.equal(href(resolveTbdLink('Suga BTS birth chart within the BTS members zodiac signs roster')), '/en/wiki/suga-bts-birth-chart');
});

// `jalen brunson` is matched by FULL name so the live quinta-brunson-birth-chart page
// is not hijacked by a bare surname match.
test('bare "Brunson" does not route to the Jalen Brunson spoke', () => {
  assert.ok(resolveTbdLink('Quinta Brunson birth chart').startsWith('*'));
});

// The live taylor-swift-and-travis-kelce page keeps the synastry query — the 7/24
// duplicate spoke was dropped rather than published alongside it.
test('Swift-Kelce synastry still routes to the live page', () => {
  assert.equal(href(resolveTbdLink('Taylor Swift and Travis Kelce synastry')), '/en/wiki/taylor-swift-and-travis-kelce');
});

// --- 7/29 v2 全速期批次 ---
const JUL29 = [
  ['ENFP Gemini', '/en/wiki/enfp-gemini'],
  ['INTP zodiac sign', '/en/wiki/intp-zodiac-sign'],
  ['ESFP zodiac sign', '/en/wiki/esfp-zodiac-sign'],
  ['BTS compatibility zodiac', '/en/wiki/bts-compatibility-zodiac'],
  ['IVE members zodiac signs', '/en/wiki/ive-members-zodiac-signs'],
  ['SEVENTEEN zodiac signs', '/en/wiki/seventeen-zodiac-signs'],
  ['Marvel characters zodiac signs', '/en/wiki/marvel-characters-zodiac-signs'],
  ['Wanda Maximoff zodiac sign', '/en/wiki/wanda-maximoff-zodiac-sign'],
  ['Thor zodiac sign', '/en/wiki/thor-zodiac-sign'],
  ['Billie Eilish birth chart', '/en/wiki/billie-eilish-birth-chart'],
  ['Sabrina Carpenter zodiac sign', '/en/wiki/sabrina-carpenter-zodiac-sign'],
];

for (const [desc, expected] of JUL29) {
  test(`TBD "${desc}" -> ${expected}`, () => {
    const out = resolveTbdLink(desc);
    assert.ok(!out.startsWith('*'), `routed (not italic): ${out}`);
    assert.equal(href(out), expected);
  });
}

// Marvel character spokes must win over the Marvel pillar (first-match ordering).
test('Marvel character spoke wins over the Marvel pillar', () => {
  assert.equal(href(resolveTbdLink('Wanda Maximoff in the Marvel characters zodiac signs hub')), '/en/wiki/wanda-maximoff-zodiac-sign');
});

// The ENFP-Gemini crossover must not be captured by the /gemini/ sign rule.
test('ENFP Gemini beats the bare Gemini sign page', () => {
  assert.equal(href(resolveTbdLink('the ENFP Gemini crossover')), '/en/wiki/enfp-gemini');
});

// "Thorne" (the author surname) must not trigger the Thor spoke.
test('author surname "Thorne" does not route to the Thor spoke', () => {
  assert.ok(resolveTbdLink('Julian Thorne on psychological astrology').startsWith('*'));
});

// --- self-link 抑制 ---
// An article names its own entity in Related Reading ("Billie Eilish zodiac sign",
// "Billie Eilish moon sign"), and the person rule then points every one of them back
// at the page the reader is already on — 4 self-links on one page in the 7/29 batch.
test('resolveTbdLink suppresses a self-link when selfSlug is given', () => {
  const desc = 'Billie Eilish moon sign';
  assert.equal(href(resolveTbdLink(desc)), '/en/wiki/billie-eilish-birth-chart');
  assert.ok(resolveTbdLink(desc, 'billie-eilish-birth-chart').startsWith('*'),
    'same description must de-link to italic on its own page');
});

test('self-link suppression does not affect other targets', () => {
  // On the Billie page, a Sabrina link must still resolve.
  assert.equal(href(resolveTbdLink('Sabrina Carpenter zodiac sign', 'billie-eilish-birth-chart')),
    '/en/wiki/sabrina-carpenter-zodiac-sign');
  // And omitting selfSlug keeps the old behaviour for every caller that has no slug.
  assert.equal(href(resolveTbdLink('Thor zodiac sign')), '/en/wiki/thor-zodiac-sign');
});
