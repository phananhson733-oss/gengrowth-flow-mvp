// entity-passport-sources.mjs — URL builders, placeholder/anti-bot filter,
// retry-with-backoff, and UA rotation for gg-entity-passport.mjs.
//
// Extracted 2026-05-21 to keep gg-entity-passport.mjs under 800 lines after
// expanding from 5 → 14 allowed hosts.
//
// Pure Node built-ins only. No npm.

import { createHash } from 'node:crypto';

// ============================================================
// Expanded source allowlist — v1.2 (2026-05-21).
// Original 6 plus aura/astrology-relevant hosts. Each is verified to be
// content-rich and not paywalled at module write time.
// ============================================================

export const ALLOWED_HOSTS = Object.freeze(
  new Set([
    // original 6 (v1.0/v1.1)
    'en.wikipedia.org',
    'www.astro.com',
    'old.reddit.com',
    'np.reddit.com',
    'cafeastrology.com',
    'chaninicholas.com',
    // v1.2 additions — aura / astrology / wellness coverage
    'www.mindbodygreen.com',
    'www.healthline.com',
    'www.wellandgood.com',
    'www.gaia.com',
    'www.energymuse.com',
    'energymuse.com',
    'www.psychologytoday.com',
    'astrotwins.com',
    'www.chani.com', // Chani Nicholas's new domain — chaninicholas.com 301s here.
    'www.allure.com',
  ]),
);

// ============================================================
// Source name registry (for ingest schema + ordering).
// ============================================================

export const SOURCE_NAMES = Object.freeze([
  'wikipedia',
  'astrodienst',
  'reddit',
  'cafe_astrology',
  'chani_nicholas',
  'mindbodygreen',
  'healthline',
  'wellandgood',
  'gaia',
  'energymuse',
  'psychology_today',
  'astrotwins',
  'allure',
]);

// ============================================================
// URL builders — one per source. All return https URLs that hit
// ALLOWED_HOSTS. For hosts without predictable article slugs we use
// the on-site search endpoint.
// ============================================================

function slugify(entity) {
  return entity.trim().toLowerCase().replace(/\s+/g, '-');
}

function titleSlug(entity) {
  return entity.trim().replace(/\s+/g, '_');
}

export function wikipediaUrl(entity) {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(titleSlug(entity))}`;
}

export function wikipediaSearchUrl(entity) {
  return `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(entity.trim())}&fulltext=Search`;
}

export function astrodienstUrl(entity) {
  return `https://www.astro.com/astrology/in_${encodeURIComponent(slugify(entity))}_e.htm`;
}

// cafe_astrology has two patterns. We try /articles/{slug} first then /?s={query}.
export function cafeAstrologyArticleUrl(entity) {
  return `https://cafeastrology.com/articles/${encodeURIComponent(slugify(entity))}`;
}

export function cafeAstrologySearchUrl(entity) {
  return `https://cafeastrology.com/?s=${encodeURIComponent(entity.trim())}`;
}

// chaninicholas.com 301s to www.chani.com — use new domain directly.
export function chaniUrl(entity) {
  return `https://www.chani.com/?s=${encodeURIComponent(entity.trim())}`;
}

export function redditSearchUrls(entity) {
  const q = encodeURIComponent(entity);
  return [
    `https://old.reddit.com/r/AskAstrologers/search.json?q=${q}&restrict_sr=1&sort=top&t=month&limit=10`,
    `https://old.reddit.com/r/astrology/search.json?q=${q}&restrict_sr=1&sort=top&t=month&limit=10`,
  ];
}

export function mindbodygreenUrl(entity) {
  return `https://www.mindbodygreen.com/search?q=${encodeURIComponent(entity.trim())}`;
}

export function healthlineUrl(entity) {
  return `https://www.healthline.com/search?q1=${encodeURIComponent(entity.trim())}`;
}

export function wellandgoodUrl(entity) {
  return `https://www.wellandgood.com/?s=${encodeURIComponent(entity.trim())}`;
}

export function gaiaUrl(entity) {
  return `https://www.gaia.com/search?q=${encodeURIComponent(entity.trim())}`;
}

export function energymuseUrl(entity) {
  return `https://www.energymuse.com/search?q=${encodeURIComponent(entity.trim())}`;
}

export function psychologyTodayUrl(entity) {
  return `https://www.psychologytoday.com/us/search/site/${encodeURIComponent(entity.trim())}`;
}

export function astrotwinsUrl(entity) {
  return `https://astrotwins.com/?s=${encodeURIComponent(entity.trim())}`;
}

export function allureUrl(entity) {
  return `https://www.allure.com/search?q=${encodeURIComponent(entity.trim())}`;
}

// ============================================================
// Anti-bot / placeholder content filter.
// ============================================================

const PLACEHOLDER_PATTERNS = Object.freeze([
  /JavaScript.{0,20}required/i,
  /enable.{0,20}javascript.{0,30}to (continue|proceed|view)/i,
  /checking your browser/i,
  /cloudflare.{0,20}ray\s*id/i,
  /captcha/i,
  /are you human/i,
  /just a moment\.\.\./i,
  /access denied/i,
  /please enable cookies/i,
  /verify you are human/i,
  /ddos[\- ]?guard/i,
  /attention required/i,
]);

const MIN_SNIPPET_LEN = 80;
const MAX_PUNCT_RATIO = 0.7;

/**
 * Return true when text looks like an anti-bot interstitial / loading
 * placeholder / garbage rather than a real snippet.
 *
 * @param {string|null|undefined} text
 * @returns {boolean}
 */
export function isPlaceholderContent(text) {
  if (text == null) return true;
  const s = String(text).trim();
  if (s.length < MIN_SNIPPET_LEN) return true;
  for (const re of PLACEHOLDER_PATTERNS) {
    if (re.test(s)) return true;
  }
  // Count non-letter / non-digit / non-CJK characters. If ≥70% then treat as
  // garbage. We use a permissive "letter or digit" check that covers CJK.
  let nonWord = 0;
  for (const ch of s) {
    // \p{L} = letter, \p{N} = number across all scripts.
    if (!/[\p{L}\p{N}]/u.test(ch)) nonWord++;
  }
  const ratio = nonWord / [...s].length;
  if (ratio >= MAX_PUNCT_RATIO) return true;
  return false;
}

/**
 * Filter an array of snippets, dropping any that match isPlaceholderContent.
 *
 * @param {string[]} snippets
 * @returns {string[]} kept snippets.
 */
export function filterPlaceholderSnippets(snippets) {
  if (!Array.isArray(snippets)) return [];
  return snippets.filter((s) => !isPlaceholderContent(s));
}

// ============================================================
// Retry-with-backoff.
// ============================================================

const DEFAULT_BACKOFFS = Object.freeze([500, 1500, 3000]);

/**
 * Wrap an async fn with retry-on-transient-error. Retries on:
 *   - network/timeout/abort errors (no .status)
 *   - 5xx HTTP errors (err.status >= 500 OR message matches /HTTP 5\d\d/)
 *
 * Does NOT retry on 404 / 403 / other 4xx, or on validation errors.
 *
 * @param {() => Promise<any>} fn
 * @param {object} [options]
 * @param {number} [options.maxAttempts=3]
 * @param {number[]} [options.backoffMs]  delays before each retry (length = maxAttempts-1).
 * @param {(ms: number) => Promise<void>} [options.sleep]  test seam.
 * @returns {Promise<any>}
 */
export async function withRetry(fn, options = {}) {
  const maxAttempts = options.maxAttempts ?? 3;
  const backoffMs = options.backoffMs || DEFAULT_BACKOFFS;
  const sleep = options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = typeof e?.status === 'number' ? e.status : extractStatus(e?.message);
      const isTransient =
        status == null
          ? /timeout|aborted|abort|fetch failed|network|enotfound|econnreset|econnrefused/i.test(
              String(e?.message || ''),
            )
          : status >= 500 && status < 600;
      if (!isTransient || attempt === maxAttempts) throw e;
      const delay = backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1] ?? 0;
      await sleep(delay);
    }
  }
  throw lastErr;
}

function extractStatus(message) {
  const m = /HTTP\s+(\d{3})/i.exec(String(message || ''));
  return m ? parseInt(m[1], 10) : null;
}

// ============================================================
// User-Agent rotation.
// ============================================================

const USER_AGENTS = Object.freeze([
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
  'curl/8.5.0',
]);

/**
 * Pick a deterministic UA for a given source name. Deterministic = same source
 * always gets same UA (easier to debug than random rotation).
 *
 * @param {string} sourceName
 * @returns {string}
 */
export function userAgentFor(sourceName) {
  const hash = createHash('sha1').update(String(sourceName || '')).digest();
  const idx = hash[0] % USER_AGENTS.length;
  return USER_AGENTS[idx];
}

export const _USER_AGENTS = USER_AGENTS;
