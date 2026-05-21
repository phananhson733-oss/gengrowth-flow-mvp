#!/usr/bin/env node
// Smoke test for lib/entity-passport-sources.mjs
// Run:  node --test tools/scripts/__tests__/lib-entity-passport-sources.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  ALLOWED_HOSTS,
  SOURCE_NAMES,
  wikipediaUrl,
  wikipediaSearchUrl,
  astrodienstUrl,
  cafeAstrologyArticleUrl,
  cafeAstrologySearchUrl,
  chaniUrl,
  redditSearchUrls,
  mindbodygreenUrl,
  healthlineUrl,
  wellandgoodUrl,
  gaiaUrl,
  energymuseUrl,
  psychologyTodayUrl,
  astrotwinsUrl,
  allureUrl,
  isPlaceholderContent,
  filterPlaceholderSnippets,
  withRetry,
  userAgentFor,
  _USER_AGENTS,
} from '../lib/entity-passport-sources.mjs';

// ============================================================
// ALLOWED_HOSTS expansion (v1.2)
// ============================================================

test('ALLOWED_HOSTS has 16 entries (6 original + 10 v1.2 additions)', () => {
  assert.equal(ALLOWED_HOSTS.size, 16);
});

test('ALLOWED_HOSTS keeps all 6 original hosts', () => {
  for (const h of [
    'en.wikipedia.org', 'www.astro.com', 'old.reddit.com', 'np.reddit.com',
    'cafeastrology.com', 'chaninicholas.com',
  ]) {
    assert.ok(ALLOWED_HOSTS.has(h), `missing ${h}`);
  }
});

test('ALLOWED_HOSTS adds www.chani.com (new chani nicholas domain)', () => {
  assert.ok(ALLOWED_HOSTS.has('www.chani.com'));
});

test('ALLOWED_HOSTS adds mindbodygreen/healthline/wellandgood/gaia/energymuse/psychologytoday/astrotwins/allure', () => {
  for (const h of [
    'www.mindbodygreen.com', 'www.healthline.com', 'www.wellandgood.com',
    'www.gaia.com', 'www.energymuse.com', 'www.psychologytoday.com',
    'astrotwins.com', 'www.allure.com',
  ]) {
    assert.ok(ALLOWED_HOSTS.has(h), `missing ${h}`);
  }
});

// ============================================================
// URL builders
// ============================================================

test('wikipediaUrl builds /wiki/{Title_Slug}', () => {
  assert.equal(wikipediaUrl('saturn return'), 'https://en.wikipedia.org/wiki/saturn_return');
  assert.equal(wikipediaUrl('Blue Aura'), 'https://en.wikipedia.org/wiki/Blue_Aura');
});

test('wikipediaSearchUrl builds full-text search URL', () => {
  const u = wikipediaSearchUrl('blue aura');
  assert.match(u, /en\.wikipedia\.org\/w\/index\.php/);
  assert.match(u, /fulltext=Search/);
  assert.match(u, /search=blue%20aura/);
});

test('chaniUrl uses www.chani.com (NOT chaninicholas.com)', () => {
  const u = chaniUrl('blue aura');
  assert.match(u, /^https:\/\/www\.chani\.com\/\?s=/);
  assert.ok(!u.includes('chaninicholas.com'));
});

test('cafeAstrologyArticleUrl and cafeAstrologySearchUrl produce distinct hosts/paths', () => {
  const a = cafeAstrologyArticleUrl('saturn return');
  const s = cafeAstrologySearchUrl('saturn return');
  assert.match(a, /^https:\/\/cafeastrology\.com\/articles\//);
  assert.match(s, /^https:\/\/cafeastrology\.com\/\?s=/);
});

test('all v1.2 URL builders return https://{allowed-host}/* URLs', () => {
  const builders = [
    [wikipediaUrl, 'en.wikipedia.org'],
    [astrodienstUrl, 'www.astro.com'],
    [cafeAstrologyArticleUrl, 'cafeastrology.com'],
    [chaniUrl, 'www.chani.com'],
    [mindbodygreenUrl, 'www.mindbodygreen.com'],
    [healthlineUrl, 'www.healthline.com'],
    [wellandgoodUrl, 'www.wellandgood.com'],
    [gaiaUrl, 'www.gaia.com'],
    [energymuseUrl, 'www.energymuse.com'],
    [psychologyTodayUrl, 'www.psychologytoday.com'],
    [astrotwinsUrl, 'astrotwins.com'],
    [allureUrl, 'www.allure.com'],
  ];
  for (const [fn, host] of builders) {
    const u = new URL(fn('test query'));
    assert.equal(u.protocol, 'https:', `${fn.name} returned non-https`);
    assert.equal(u.hostname, host, `${fn.name} returned wrong host ${u.hostname}`);
    assert.ok(ALLOWED_HOSTS.has(u.hostname), `${u.hostname} not in ALLOWED_HOSTS`);
  }
});

test('redditSearchUrls returns 2 search endpoints (AskAstrologers + astrology)', () => {
  const urls = redditSearchUrls('saturn return');
  assert.equal(urls.length, 2);
  assert.ok(urls[0].includes('/r/AskAstrologers/search.json'));
  assert.ok(urls[1].includes('/r/astrology/search.json'));
});

// ============================================================
// isPlaceholderContent — anti-bot / garbage filter
// ============================================================

test('isPlaceholderContent flags "JavaScript required" phrase', () => {
  assert.equal(
    isPlaceholderContent('Please enable JavaScript. This site requires JavaScript to view content properly. JavaScript is required.'),
    true,
  );
});

test('isPlaceholderContent flags "Checking your browser" (Cloudflare)', () => {
  assert.equal(
    isPlaceholderContent('Checking your browser before accessing the site. This process is automatic. Cloudflare Ray ID: abc123'),
    true,
  );
});

test('isPlaceholderContent flags Captcha / Just a moment / access denied', () => {
  assert.equal(isPlaceholderContent('Please complete the captcha to continue browsing this site for security verification.'), true);
  assert.equal(isPlaceholderContent('Just a moment... we are checking your browser for security purposes please wait now'), true);
  assert.equal(isPlaceholderContent('Access denied. You do not have permission to access this resource on this server.'), true);
});

test('isPlaceholderContent flags content < 80 chars', () => {
  assert.equal(isPlaceholderContent('short'), true);
  assert.equal(isPlaceholderContent(''), true);
  assert.equal(isPlaceholderContent(null), true);
});

test('isPlaceholderContent flags ≥70% punctuation', () => {
  assert.equal(isPlaceholderContent('*** ... *** ... *** ... *** ... *** ... *** ... *** ... *** ... ***'), true);
  assert.equal(isPlaceholderContent('-------------------- -------------------- -------------------- ---'), true);
});

test('isPlaceholderContent ACCEPTS real article text', () => {
  const real =
    'Saturn return is an astrological transit that occurs when the planet Saturn returns to the same position in the sky that it occupied at the moment of a person\'s birth. The cycle is approximately 29.5 years.';
  assert.equal(isPlaceholderContent(real), false);
});

test('isPlaceholderContent ACCEPTS Chinese article text', () => {
  const real = '蓝色光环代表平静与沟通能力强大的人格特质。许多灵性传统认为蓝色光环与喉轮紧密相关联，体现表达与真理的内在力量。这种灵性解读在西方新世纪运动中较为流行，常出现在能量疗愈与冥想引导的相关书籍中。';
  assert.equal(isPlaceholderContent(real), false);
});

test('filterPlaceholderSnippets keeps only real ones', () => {
  const input = [
    'JavaScript is required to view this page properly. Please enable javascript.',
    'Saturn return is an astrological phenomenon occurring every 29.5 years approximately when the planet returns to its natal position.',
    'short',
    'Another real snippet with enough substance to be considered useful for a downstream RAG pipeline analysis.',
  ];
  const out = filterPlaceholderSnippets(input);
  assert.equal(out.length, 2);
});

test('filterPlaceholderSnippets handles non-array gracefully', () => {
  assert.deepEqual(filterPlaceholderSnippets(null), []);
  assert.deepEqual(filterPlaceholderSnippets(undefined), []);
  assert.deepEqual(filterPlaceholderSnippets('not an array'), []);
});

// ============================================================
// withRetry — transient backoff
// ============================================================

test('withRetry resolves immediately on success (no retries)', async () => {
  let calls = 0;
  const out = await withRetry(async () => { calls++; return 'ok'; }, { sleep: async () => {} });
  assert.equal(out, 'ok');
  assert.equal(calls, 1);
});

test('withRetry retries on transient network error then succeeds', async () => {
  let calls = 0;
  const out = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new Error('fetch failed');
    return 'ok';
  }, { sleep: async () => {} });
  assert.equal(out, 'ok');
  assert.equal(calls, 3);
});

test('withRetry retries on HTTP 503 then surfaces last error', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => {
      calls++;
      const e = new Error('HTTP 503');
      throw e;
    }, { sleep: async () => {}, maxAttempts: 3 }),
    /HTTP 503/,
  );
  assert.equal(calls, 3);
});

test('withRetry does NOT retry on HTTP 404 (permanent)', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => {
      calls++;
      throw new Error('HTTP 404');
    }, { sleep: async () => {} }),
    /HTTP 404/,
  );
  assert.equal(calls, 1);
});

test('withRetry does NOT retry on validation errors', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => {
      calls++;
      throw new Error('URL not in allowlist: https://x');
    }, { sleep: async () => {} }),
  );
  assert.equal(calls, 1);
});

test('withRetry respects custom backoffMs delays', async () => {
  const delays = [];
  let calls = 0;
  try {
    await withRetry(async () => {
      calls++;
      throw new Error('network timeout');
    }, {
      maxAttempts: 3,
      backoffMs: [10, 20],
      sleep: async (ms) => { delays.push(ms); },
    });
  } catch {}
  assert.deepEqual(delays, [10, 20]);
  assert.equal(calls, 3);
});

// ============================================================
// userAgentFor — deterministic UA rotation
// ============================================================

test('userAgentFor returns one of the UA pool entries', () => {
  const ua = userAgentFor('wikipedia');
  assert.ok(_USER_AGENTS.includes(ua));
});

test('userAgentFor is deterministic for the same source name', () => {
  assert.equal(userAgentFor('wikipedia'), userAgentFor('wikipedia'));
  assert.equal(userAgentFor('reddit'), userAgentFor('reddit'));
});

test('userAgentFor distributes across the UA pool', () => {
  const seen = new Set();
  for (const src of SOURCE_NAMES) {
    seen.add(userAgentFor(src));
  }
  // With 13 sources hashed mod 3, we expect to see all 3 UAs (probabilistically).
  assert.ok(seen.size >= 2, `expected ≥2 distinct UAs, got ${seen.size}`);
});
