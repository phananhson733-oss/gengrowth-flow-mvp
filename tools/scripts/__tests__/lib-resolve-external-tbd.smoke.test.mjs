import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveExternalTbdLink,
  transformBody,
} from '../gg-md-to-oracle-ts.mjs';

test('resolveExternalTbdLink: EN Wikipedia topic → en.wikipedia link', () => {
  assert.equal(
    resolveExternalTbdLink('Wikipedia', 'Chakra', 'en'),
    '[Chakra (Wikipedia)](https://en.wikipedia.org/wiki/Chakra)',
  );
});

test('resolveExternalTbdLink: spaces and parens in topic become slug', () => {
  assert.equal(
    resolveExternalTbdLink('Wikipedia', 'House (astrology)', 'en'),
    '[House (astrology) (Wikipedia)](https://en.wikipedia.org/wiki/House_(astrology))',
  );
});

test('resolveExternalTbdLink: ZH service → zh.wikipedia + fullwidth label', () => {
  const out = resolveExternalTbdLink('维基百科', '月亮交点', 'zh');
  assert.match(out, /^\[月亮交点（维基百科）\]\(https:\/\/zh\.wikipedia\.org\/wiki\//);
});

test('resolveExternalTbdLink: CJK topic forces zh host even if lang=en', () => {
  const out = resolveExternalTbdLink('Wikipedia', '月亮交点', 'en');
  assert.match(out, /zh\.wikipedia\.org/);
});

test('resolveExternalTbdLink: unknown service → italic flag, no fake URL', () => {
  assert.equal(resolveExternalTbdLink('SomeBlog', 'Whatever', 'en'), '*Whatever*');
});

test('transformBody: resolves an external TBD placeholder inline', () => {
  const body =
    '- [[<TBD-external-link: Wikipedia | Lunar node | astronomy background>]] — context.';
  const out = transformBody(body, 'en');
  assert.ok(!out.includes('TBD-external-link'), 'placeholder must be gone');
  assert.ok(
    out.includes('[Lunar node (Wikipedia)](https://en.wikipedia.org/wiki/Lunar_node)'),
    'resolved Wikipedia link present',
  );
});
