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
