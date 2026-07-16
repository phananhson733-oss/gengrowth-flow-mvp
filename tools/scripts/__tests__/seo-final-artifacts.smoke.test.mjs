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
  extraHeaders = {},
} = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const normalizedHeaders = Object.fromEntries(
    Object.entries(extraHeaders).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    redirected,
    headers: {
      get: (name) => name.toLowerCase() === 'content-type'
        ? contentType
        : (normalizedHeaders[name.toLowerCase()] || null),
    },
    text: async () => canonical == null
      ? bytes.toString('utf8')
      : `<html><head><link rel="canonical" href="${canonical}"></head></html>`,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];
const verifyAssets = (options) => verifyFinalAssets({
  resolveHost: publicResolver,
  ...options,
});

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

test('internal link redirects are manual structured failures and never request a private second hop', async () => {
  const requested = 'https://www.astrologywiki.com/en/wiki/real';
  const privateTarget = 'http://169.254.169.254/latest/meta-data';
  const calls = [];
  const guardedFetch = async (url, init = {}) => {
    calls.push({ url, redirect: init.redirect });
    if (url === privateTarget) {
      throw new Error('private redirect target must never be requested');
    }
    if (init.redirect === 'follow') {
      return guardedFetch(privateTarget, init);
    }
    return response({
      status: 302,
      url,
      extraHeaders: { location: privateTarget },
    });
  };
  const result = await verifyFinalLinks({
    html: '<a href="/en/wiki/real">real</a>',
    pageUrl: PAGE_URL,
    allowedRoutes: new Set(['/en/wiki/real']),
    fetch: guardedFetch,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, [{ url: requested, redirect: 'manual' }]);
  assert.equal(result.failed[0].status, 302);
  assert.equal(result.failed[0].location, privateTarget);
  assert.match(result.failed[0].reason, /redirect|HTTP 302/i);
});

test('every 3xx internal link response including missing Location fails without a second fetch', async () => {
  for (const status of [300, 301, 302, 303, 307, 308, 399]) {
    const calls = [];
    const result = await verifyFinalLinks({
      html: '<a href="/en/wiki/real">real</a>',
      pageUrl: PAGE_URL,
      allowedRoutes: new Set(['/en/wiki/real']),
      fetch: async (url, init = {}) => {
        calls.push({ url, redirect: init.redirect });
        return response({ status, url });
      },
    });
    assert.equal(result.ok, false, String(status));
    assert.deepEqual(calls, [{
      url: 'https://www.astrologywiki.com/en/wiki/real',
      redirect: 'manual',
    }], String(status));
    assert.match(result.failed[0].reason, /redirect|Location|HTTP 3/i, String(status));
  }
});

test('javascript and other unsafe non-http link protocols fail instead of being ignored as external', async () => {
  let fetched = 0;
  const result = await verifyFinalLinks({
    html: [
      '<a href="javascript:alert(1)">js</a>',
      '<a href="data:text/html,bad">data</a>',
      '<a href="file:///etc/passwd">file</a>',
    ].join(''),
    pageUrl: PAGE_URL,
    allowedRoutes: new Set(),
    sitemapUrls: new Set(),
    fetch: async () => { fetched++; throw new Error('must not fetch'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failed.length, 3);
  assert.equal(result.ignored.length, 0);
  assert.equal(fetched, 0);
  assert.equal(result.failed.every((entry) => /unsafe|protocol|invalid/i.test(entry.reason)), true);
});

for (const mode of ['404', 'wrong-mime', 'empty', 'decode-fail']) {
  test(`referenced image ${mode} blocks publish`, async () => {
    const decodeCalls = [];
    const result = await verifyAssets({
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
  const result = await verifyAssets({
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

test('the default raster parser accepts a complete PNG and rejects a truncated signature-only file', async () => {
  const verify = (body) => verifyAssets({
    html: '<img src="/images/hero.png">',
    pageUrl: PAGE_URL,
    fetch: async (url) => response({ url, contentType: 'image/png', body }),
  });
  assert.equal((await verify(PNG)).ok, true);
  const truncated = await verify(PNG.subarray(0, 24));
  assert.equal(truncated.ok, false);
  assert.match(truncated.failed[0].reason, /PNG/i);
});

test('empty img/source src and empty srcset candidates fail closed without fetching', async () => {
  for (const html of [
    '<img alt="missing source">',
    '<picture><source type="image/webp"></picture>',
    '<img src="">',
    '<picture><source src=""></picture>',
    '<picture><source srcset=""></picture>',
    '<picture><source srcset="/images/a.png 1x, "></picture>',
  ]) {
    let fetched = 0;
    const result = await verifyAssets({
      html,
      pageUrl: PAGE_URL,
      fetch: async () => { fetched++; throw new Error('must not fetch'); },
    });
    assert.equal(result.ok, false, html);
    assert.match(result.failed[0].reason, /empty|missing/i, html);
    assert.equal(fetched, 0, html);
  }
});

test('inline use fragment must belong to the same structurally valid inline SVG', async () => {
  const verify = (html) => verifyAssets({
    html,
    pageUrl: PAGE_URL,
    fetch: async () => { throw new Error('inline SVG must not fetch'); },
  });

  assert.equal((await verify(
    '<svg><symbol id="moon"><path d="M0 0"/></symbol><use href="#moon"></use></svg>',
  )).ok, true);

  for (const html of [
    '<div id="moon"></div><svg><use href="#moon"></use></svg>',
    '<svg><symbol id="moon"></symbol></svg><svg><use href="#moon"></use></svg>',
    '<svg><symbol id="moon"><use href="#moon"></svg>',
    '<use href="#moon"></use><svg><symbol id="moon"/></svg>',
    '<svg><script id="moon"></script><use href="#moon"></use></svg>',
    '<svg><style id="moon"></style><use href="#moon"></use></svg>',
    '<svg><metadata id="moon"></metadata><use href="#moon"></use></svg>',
    '<svg><desc id="moon"></desc><use href="#moon"></use></svg>',
    '<svg><title id="moon"></title><use href="#moon"></use></svg>',
  ]) {
    const result = await verify(html);
    assert.equal(result.ok, false, html);
    assert.match(result.failed[0].reason, /inline SVG|fragment|parser|structure/i, html);
  }
});

test('external SVG use validates the parser and referenced fragment', async () => {
  const result = await verifyAssets({
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
    const result = await verifyAssets({
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
  const result = await verifyAssets({
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
  const result = await verifyAssets({
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

test('404 response bodies retain bytes and sha256 and alter artifact SHA when the body changes', async () => {
  const verify = (body) => verifyAssets({
    html: '<img src="/images/missing.png">',
    pageUrl: PAGE_URL,
    fetch: async (url) => response({
      status: 404,
      url,
      contentType: 'image/png',
      body,
    }),
    resolveHost: publicResolver,
  });
  const first = await verify(Buffer.from('missing-a'));
  const second = await verify(Buffer.from('missing-b'));
  assert.equal(first.ok, false);
  assert.equal(first.failed[0].bytes, 9);
  assert.match(first.failed[0].sha256, /^[0-9a-f]{64}$/);
  const firstSha = artifactShaForEvidence({ articleSha: 'a'.repeat(64), finalAssets: first });
  const secondSha = artifactShaForEvidence({ articleSha: 'a'.repeat(64), finalAssets: second });
  assert.notEqual(firstSha, secondSha);
});

test('asset fetch blocks unsafe protocols, untrusted hosts, and private IP literals before fetch', async () => {
  const cases = [
    'file:///etc/passwd',
    'http://127.0.0.1/private.png',
    'http://169.254.169.254/latest/meta-data.png',
    'http://10.0.0.8/private.png',
    'https://evil.example/asset.png',
  ];
  for (const src of cases) {
    let fetched = 0;
    const result = await verifyAssets({
      html: `<img src="${src}">`,
      pageUrl: PAGE_URL,
      fetch: async () => { fetched++; throw new Error('must not fetch'); },
      resolveHost: publicResolver,
    });
    assert.equal(result.ok, false, src);
    assert.match(result.failed[0].reason, /unsafe|trusted|private|loopback|protocol|host/i, src);
    assert.equal(fetched, 0, src);
  }
});

test('an explicitly allowed CDN still fails before fetch when DNS resolves private', async () => {
  let fetched = 0;
  const result = await verifyAssets({
    html: '<img src="https://cdn.example/hero.png">',
    pageUrl: PAGE_URL,
    allowedAssetHosts: new Set(['cdn.example']),
    resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
    fetch: async () => { fetched++; throw new Error('must not fetch'); },
  });
  assert.equal(result.ok, false);
  assert.match(result.failed[0].reason, /private|loopback|unsafe|DNS/i);
  assert.equal(fetched, 0);
});

test('an explicitly allowed public CDN can be verified hermetically', async () => {
  const result = await verifyAssets({
    html: '<img src="https://cdn.example/hero.png">',
    pageUrl: PAGE_URL,
    allowedAssetHosts: new Set(['cdn.example']),
    resolveHost: publicResolver,
    fetch: async (url) => response({ url, contentType: 'image/png', body: PNG }),
  });
  assert.equal(result.ok, true, JSON.stringify(result.failed));
});

test('asset trust uses exact origins and never treats www, apex, scheme, or port as equivalent', async () => {
  for (const src of [
    'https://astrologywiki.com/images/hero.png',
    'http://www.astrologywiki.com/images/hero.png',
    'https://www.astrologywiki.com:8443/images/hero.png',
  ]) {
    let fetched = 0;
    const result = await verifyAssets({
      html: `<img src="${src}">`,
      pageUrl: PAGE_URL,
      resolveHost: publicResolver,
      fetch: async () => { fetched++; throw new Error('must not fetch'); },
    });
    assert.equal(result.ok, false, src);
    assert.match(result.failed[0].reason, /origin|trusted|host/i, src);
    assert.equal(fetched, 0, src);
  }
});

test('page and preview asset-base origins are DNS checked before fetch just like configured CDNs', async () => {
  for (const { address, assetBaseUrl, expectedHost } of [
    { address: '127.0.0.1', expectedHost: 'www.astrologywiki.com' },
    {
      address: '169.254.169.254',
      assetBaseUrl: 'https://preview.example.test/en/wiki/source',
      expectedHost: 'preview.example.test',
    },
    { address: '::1', expectedHost: 'www.astrologywiki.com' },
    { address: 'fe80::1', expectedHost: 'www.astrologywiki.com' },
  ]) {
    let fetched = 0;
    const resolved = [];
    const result = await verifyAssets({
      html: '<img src="/images/hero.png">',
      pageUrl: PAGE_URL,
      assetBaseUrl,
      resolveHost: async (hostname) => {
        resolved.push(hostname);
        return [{ address }];
      },
      fetch: async () => { fetched++; throw new Error('must not fetch'); },
    });
    assert.equal(result.ok, false, address);
    assert.match(result.failed[0].reason, /DNS|private|loopback|link-local|unsafe/i, address);
    assert.equal(fetched, 0, address);
    assert.deepEqual(resolved, [expectedHost], address);
  }
});

test('asset redirects are manually revalidated and cannot hop to a private or untrusted host', async () => {
  const calls = [];
  const result = await verifyAssets({
    html: '<img src="/images/hero.png">',
    pageUrl: PAGE_URL,
    resolveHost: publicResolver,
    fetch: async (url, init) => {
      calls.push({ url, redirect: init.redirect });
      return response({
        status: 302,
        url,
        contentType: 'text/html',
        extraHeaders: { location: 'http://169.254.169.254/latest/meta-data' },
      });
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.failed[0].reason, /redirect|private|trusted|unsafe/i);
  assert.deepEqual(calls, [{
    url: 'https://www.astrologywiki.com/images/hero.png',
    redirect: 'manual',
  }]);
});

test('a response final URL outside the trusted host set fails closed even without a redirect status', async () => {
  const result = await verifyAssets({
    html: '<img src="/images/hero.png">',
    pageUrl: PAGE_URL,
    resolveHost: publicResolver,
    fetch: async () => response({
      url: 'https://evil.example/hero.png',
      contentType: 'image/png',
      body: PNG,
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.failed[0].reason, /final|trusted|host|drift/i);
});
