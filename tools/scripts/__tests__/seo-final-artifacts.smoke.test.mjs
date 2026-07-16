import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  artifactShaForEvidence,
  artifactShaFromFiles,
  failureFingerprintFor,
  verifyFinalAssets,
  verifyFinalLinks,
} from '../lib/seo-final-artifacts.mjs';

const PAGE_URL = 'https://www.astrologywiki.com/en/wiki/source';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function response({
  status = 200,
  url,
  canonical,
  contentType = 'text/html; charset=utf-8',
  body = '',
  redirected = false,
} = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    redirected,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? contentType : null },
    text: async () => canonical == null
      ? bytes.toString('utf8')
      : `<html><head><link rel="canonical" href="${canonical}"></head></html>`,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

test('every rendered internal link must be route-or-sitemap verified, 200, and canonical', async () => {
  const result = await verifyFinalLinks({
    html: [
      '<a href="/en/wiki/real">real</a>',
      '<a href="/en/wiki/fabricated">bad</a>',
      '<a href="https://external.example/x">external</a>',
      '<a href="mailto:ops@example.test">mail</a>',
      '<a href="tel:+10000000000">phone</a>',
      '<a href="#faq">hash</a>',
    ].join(''),
    pageUrl: PAGE_URL,
    allowedRoutes: new Set(['/en/wiki/real']),
    sitemapUrls: new Set(['https://www.astrologywiki.com/en/wiki/real']),
    fetch: async (url) => response({ url, canonical: url }),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.failed.map((entry) => entry.path), ['/en/wiki/fabricated']);
  assert.deepEqual(
    result.ignored.map((entry) => entry.reason).sort(),
    ['external', 'hash', 'mailto', 'tel'],
  );
  assert.equal(result.checked[0].canonical, 'https://www.astrologywiki.com/en/wiki/real');
});

test('relative and query URLs normalize against the rendered page and preserve exact canonical', async () => {
  const expected = 'https://www.astrologywiki.com/en/wiki/real?view=full';
  const seen = [];
  const result = await verifyFinalLinks({
    html: '<a href="../wiki/real?view=full#section">relative query</a>',
    pageUrl: PAGE_URL,
    allowedRoutes: new Set(['/en/wiki/real']),
    sitemapUrls: new Set(),
    fetch: async (url) => {
      seen.push(url);
      return response({ url, canonical: expected });
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result.failed));
  assert.deepEqual(seen, [expected]);
  assert.equal(result.checked[0].url, expected);
  assert.equal(result.checked[0].path, '/en/wiki/real');
});

test('a redirect whose rendered document has the wrong canonical fails closed', async () => {
  const requested = 'https://www.astrologywiki.com/en/wiki/real';
  const result = await verifyFinalLinks({
    html: '<a href="/en/wiki/real">real</a>',
    pageUrl: PAGE_URL,
    allowedRoutes: new Set(['/en/wiki/real']),
    sitemapUrls: new Set(),
    fetch: async () => response({
      url: 'https://www.astrologywiki.com/en/wiki/other',
      canonical: 'https://www.astrologywiki.com/en/wiki/other',
      redirected: true,
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failed[0].url, requested);
  assert.match(result.failed[0].reason, /redirect|canonical/i);
});

test('a redirect target drift fails even if the redirected page claims the original canonical', async () => {
  const requested = 'https://www.astrologywiki.com/en/wiki/real';
  const result = await verifyFinalLinks({
    html: '<a href="/en/wiki/real">real</a>',
    pageUrl: PAGE_URL,
    allowedRoutes: new Set(['/en/wiki/real']),
    sitemapUrls: new Set(),
    fetch: async () => response({
      url: 'https://www.astrologywiki.com/en/wiki/other',
      canonical: requested,
      redirected: true,
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.failed[0].reason, /redirect target drift/i);
});

for (const mode of ['404', 'wrong-mime', 'empty', 'decode-fail']) {
  test(`referenced image ${mode} blocks publish`, async () => {
    const decodeCalls = [];
    const result = await verifyFinalAssets({
      html: '<img src="/images/blog/source-hero.png" alt="hero">',
      pageUrl: PAGE_URL,
      fetch: async (url) => {
        if (mode === '404') return response({ status: 404, url, contentType: 'image/png' });
        if (mode === 'wrong-mime') return response({ url, contentType: 'text/plain', body: PNG });
        if (mode === 'empty') return response({ url, contentType: 'image/png', body: Buffer.alloc(0) });
        return response({ url, contentType: 'image/png', body: PNG });
      },
      decodeImage: async (input) => {
        decodeCalls.push(input);
        return mode !== 'decode-fail';
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.failed.length, 1);
    if (mode !== '404') assert.match(result.failed[0].sha256, /^[0-9a-f]{64}$/);
    if (mode === 'wrong-mime') assert.equal(decodeCalls.length, 0);
  });
}

test('every srcset candidate is fetched, MIME checked, and decoded', async () => {
  const fetched = [];
  const decoded = [];
  const result = await verifyFinalAssets({
    html: '<picture><source srcset="/images/a.webp 1x, /images/a@2x.webp 2x"><img src="/images/fallback.png"></picture>',
    pageUrl: PAGE_URL,
    fetch: async (url) => {
      fetched.push(url);
      const webp = url.endsWith('.webp');
      return response({
        url,
        contentType: webp ? 'image/webp' : 'image/png',
        body: webp ? Buffer.from('RIFFxxxxWEBP', 'ascii') : PNG,
      });
    },
    decodeImage: async ({ url }) => {
      decoded.push(url);
      return true;
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result.failed));
  assert.deepEqual(fetched.sort(), [
    'https://www.astrologywiki.com/images/a.webp',
    'https://www.astrologywiki.com/images/a@2x.webp',
    'https://www.astrologywiki.com/images/fallback.png',
  ]);
  assert.equal(decoded.length, 3);
  assert.equal(result.checked.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256)), true);
});

test('external SVG use validates the parser and referenced fragment', async () => {
  const result = await verifyFinalAssets({
    html: '<svg aria-hidden="true"><use href="/images/icons.svg#moon"></use></svg>',
    pageUrl: PAGE_URL,
    fetch: async (url) => response({
      url,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="moon"><path d="M0 0"/></symbol></svg>',
    }),
  });
  assert.equal(result.ok, true, JSON.stringify(result.failed));
  assert.equal(result.checked[0].fragment, 'moon');
});

for (const [name, body] of [
  ['empty SVG', Buffer.alloc(0)],
  ['malformed SVG', '<svg><g></svg>'],
  ['missing SVG fragment', '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="sun"/></svg>'],
]) {
  test(`${name} blocks a rendered use reference`, async () => {
    const result = await verifyFinalAssets({
      html: '<svg><use href="/images/icons.svg#moon"></use></svg>',
      pageUrl: PAGE_URL,
      fetch: async (url) => response({
        url,
        contentType: 'image/svg+xml',
        body,
      }),
    });
    assert.equal(result.ok, false);
  });
}

test('wrong MIME blocks even when the bytes are decodable', async () => {
  let decoded = false;
  const result = await verifyFinalAssets({
    html: '<img src="/images/hero.png">',
    pageUrl: PAGE_URL,
    fetch: async (url) => response({ url, contentType: 'image/jpeg', body: PNG }),
    decodeImage: async () => { decoded = true; return true; },
  });
  assert.equal(result.ok, false);
  assert.equal(decoded, false);
  assert.match(result.failed[0].reason, /MIME/i);
});

test('an unreferenced optional hero marked needs_hero does not block', async () => {
  let fetched = 0;
  const result = await verifyFinalAssets({
    html: '<article><h1>No rendered hero</h1></article>',
    pageUrl: PAGE_URL,
    needsHero: true,
    fetch: async () => { fetched++; throw new Error('should not fetch'); },
  });
  assert.equal(result.ok, true);
  assert.equal(fetched, 0);
  assert.deepEqual(result.checked, []);
});

test('artifact SHA covers article and matching changed asset bytes only', () => {
  const root = mkdtempSync(join(tmpdir(), 'seo-artifact-sha-'));
  const worktree = join(root, 'oracle');
  const article = join(worktree, 'data/articles/source.ts');
  const hero = join(worktree, 'public/images/blog/source-hero.svg');
  const unrelated = join(worktree, 'public/images/blog/other-hero.svg');
  mkdirSync(join(worktree, 'data/articles'), { recursive: true });
  mkdirSync(join(worktree, 'public/images/blog'), { recursive: true });
  writeFileSync(article, 'export const source = "A";\n');
  writeFileSync(hero, '<svg><path/></svg>');
  writeFileSync(unrelated, '<svg><circle/></svg>');

  const first = artifactShaFromFiles({
    worktree,
    articlePath: article,
    slug: 'source',
    changedPaths: ['public/images/blog/source-hero.svg', 'public/images/blog/other-hero.svg'],
  });
  writeFileSync(unrelated, '<svg><rect/></svg>');
  const afterUnrelated = artifactShaFromFiles({
    worktree,
    articlePath: article,
    slug: 'source',
    changedPaths: ['public/images/blog/source-hero.svg', 'public/images/blog/other-hero.svg'],
  });
  assert.equal(afterUnrelated, first);

  writeFileSync(hero, '<svg><path d="M1 1"/></svg>');
  const afterHero = artifactShaFromFiles({
    worktree,
    articlePath: article,
    slug: 'source',
    changedPaths: ['public/images/blog/source-hero.svg'],
  });
  assert.notEqual(afterHero, first);
});

test('failure fingerprints are deterministic and change with structured failures', () => {
  const a = failureFingerprintFor({
    final_links: { failed: [{ url: '/bad', reason: 'not allowed' }] },
    final_assets: { failed: [] },
  });
  const b = failureFingerprintFor({
    final_assets: { failed: [] },
    final_links: { failed: [{ reason: 'not allowed', url: '/bad' }] },
  });
  const c = failureFingerprintFor({
    final_links: { failed: [{ url: '/other', reason: 'not allowed' }] },
    final_assets: { failed: [] },
  });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('failed fetched asset bytes participate in artifact SHA and reset no-progress when they change', () => {
  const failedAsset = (sha256) => ({
    ok: false,
    checked: [],
    failed: [{
      url: 'https://www.astrologywiki.com/images/hero.png',
      reason: 'MIME mismatch',
      sha256,
    }],
    ignored: [],
  });
  const first = artifactShaForEvidence({
    articleSha: 'a'.repeat(64),
    finalAssets: failedAsset('1'.repeat(64)),
  });
  const changed = artifactShaForEvidence({
    articleSha: 'a'.repeat(64),
    finalAssets: failedAsset('2'.repeat(64)),
  });
  assert.notEqual(first, changed);
});
