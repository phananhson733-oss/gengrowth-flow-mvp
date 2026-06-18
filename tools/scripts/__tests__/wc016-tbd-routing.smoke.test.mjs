// Regression guard for the 6/18 World Cup player + Cancer-cluster TBD link rules
// (PG-WC-016~020) added to gg-md-to-oracle-ts.mjs. Each new bilingual spoke must
// route its TBD wikilink to the right /en/ (and, rewritten, /zh/) slug instead of
// falling through to the generic /(natal|birth) chart/ rule or an italic placeholder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTbdLink } from '../gg-md-to-oracle-ts.mjs';

const href = (out) => (out.match(/\]\(([^)]+)\)/) || [])[1] || null;

const CASES = [
  // [description, lang, expected href]
  ['the World Cup 2026 astrology pillar', 'en', '/en/wiki/world-cup-2026-astrology-prediction'],
  ['the June 2026 transit calendar', 'en', '/en/wiki/world-cup-2026-june-astrology'],
  ['the Jude Bellingham birth chart', 'en', '/en/wiki/jude-bellingham-birth-chart'],
  ['the Erling Haaland birth chart', 'en', '/en/wiki/erling-haaland-birth-chart'],
  ['Messi world cup record astrology', 'en', '/en/wiki/messi-world-cup-record-astrology'],
  ['Lionel Messi zodiac sign', 'en', '/en/wiki/lionel-messi-zodiac-sign'],
  ['the Harry Kane birth chart, a Leo contrast', 'en', '/en/wiki/harry-kane-birth-chart'],
  ['the best soccer players by zodiac sign', 'en', '/en/wiki/best-soccer-players-zodiac-sign'],
  ['cancer zodiac world cup 2026', 'en', '/en/wiki/cancer-zodiac-world-cup-2026'],
  // ZH descriptions route to the same slug, /zh/ path
  ['2026世界杯占星总览', 'zh', '/zh/wiki/world-cup-2026-astrology-prediction'],
  ['世界杯2026年六月占星日历', 'zh', '/zh/wiki/world-cup-2026-june-astrology'],
  ['裘德·贝林厄姆星盘', 'zh', '/zh/wiki/jude-bellingham-birth-chart'],
  ['哈兰德星盘', 'zh', '/zh/wiki/erling-haaland-birth-chart'],
  ['梅西世界杯战绩占星', 'zh', '/zh/wiki/messi-world-cup-record-astrology'],
  ['梅西星座解读', 'zh', '/zh/wiki/lionel-messi-zodiac-sign'],
  ['哈里·凯恩星盘', 'zh', '/zh/wiki/harry-kane-birth-chart'],
  ['巨蟹座2026世界杯', 'zh', '/zh/wiki/cancer-zodiac-world-cup-2026'],
  ['顶尖足球运动员星座', 'zh', '/zh/wiki/best-soccer-players-zodiac-sign'],
];

for (const [desc, lang, expected] of CASES) {
  test(`TBD [${lang}] "${desc}" -> ${expected}`, () => {
    const out = resolveTbdLink(desc, lang);
    assert.ok(!out.startsWith('*'), `routed (not italic): ${out}`);
    assert.equal(href(out), expected);
  });
}

// messi-world-cup-record must win over messi-zodiac for the record phrasing, and
// vice-versa — guards the first-match ordering of the two messi rules.
test('messi record vs zodiac ordering', () => {
  assert.equal(href(resolveTbdLink('messi world cup record astrology', 'en')), '/en/wiki/messi-world-cup-record-astrology');
  assert.equal(href(resolveTbdLink('messi zodiac sign', 'en')), '/en/wiki/lionel-messi-zodiac-sign');
});
