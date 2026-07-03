import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveExternalTbdLink,
  transformBody,
} from '../gg-md-to-oracle-ts.mjs';

// EN-only (2026-07-03): the zh.wikipedia host selection and 维基百科 service
// alias were removed with the zh authoring pipeline — everything resolves to
// en.wikipedia.org now.

test('resolveExternalTbdLink: Wikipedia topic → en.wikipedia link', () => {
  assert.equal(
    resolveExternalTbdLink('Wikipedia', 'Chakra'),
    '[Chakra (Wikipedia)](https://en.wikipedia.org/wiki/Chakra)',
  );
});

test('resolveExternalTbdLink: spaces and parens in topic become slug', () => {
  assert.equal(
    resolveExternalTbdLink('Wikipedia', 'House (astrology)'),
    '[House (astrology) (Wikipedia)](https://en.wikipedia.org/wiki/House_(astrology))',
  );
});

test('resolveExternalTbdLink: CJK topic still resolves to en.wikipedia host', () => {
  const out = resolveExternalTbdLink('Wikipedia', '月亮交点');
  assert.match(out, /en\.wikipedia\.org/);
  assert.doesNotMatch(out, /zh\.wikipedia\.org/);
});

test('resolveExternalTbdLink: unknown service → italic flag, no fake URL', () => {
  assert.equal(resolveExternalTbdLink('SomeBlog', 'Whatever'), '*Whatever*');
});

test('transformBody: resolves an external TBD placeholder inline', () => {
  const body =
    '- [[<TBD-external-link: Wikipedia | Lunar node | astronomy background>]] — context.';
  const out = transformBody(body);
  assert.ok(!out.includes('TBD-external-link'), 'placeholder must be gone');
  assert.ok(
    out.includes('[Lunar node (Wikipedia)](https://en.wikipedia.org/wiki/Lunar_node)'),
    'resolved Wikipedia link present',
  );
});
