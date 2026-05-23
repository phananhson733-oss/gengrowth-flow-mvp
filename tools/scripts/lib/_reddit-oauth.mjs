// _reddit-oauth.mjs — Reddit OAuth2 script-app helper.
//
// Unblocks Stage 10 real friction-mine: gg-friction-mine.mjs currently scrapes
// anonymous old.reddit.com (heavily rate-limited and unreliable). With OAuth,
// you get oauth.reddit.com endpoints, 100 req/min, and ToS-clean auth.
//
// Full setup walkthrough: docs/REDDIT_OAUTH_SETUP.md.
//
// Env vars (resolved from process.env first, then ~/.config/gg/_gg.env):
//   GG_REDDIT_CLIENT_ID       (preferred) | REDDIT_CLIENT_ID     (legacy)
//   GG_REDDIT_CLIENT_SECRET   (preferred) | REDDIT_CLIENT_SECRET (legacy)
//   GG_REDDIT_USER_AGENT      (preferred) | REDDIT_USER_AGENT    (legacy)
//   REDDIT_USERNAME / REDDIT_PASSWORD (optional — only for password grant)
//
// Two OAuth flows supported:
//   - client_credentials (default for friction-mine) — app-only token, no user creds.
//     Works for public read endpoints (/r/<sub>/search, etc.).
//   - password (legacy)  — full user-scope token. Only used if username+password env present.
//
// API usage from other scripts:
//   import { getRedditToken, redditSearch } from './lib/_reddit-oauth.mjs';
//   const posts = await redditSearch('blue aura meaning', { subreddit: 'astrology', limit: 25 });

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REDDIT_OAUTH_BASE = 'https://oauth.reddit.com';
const REDDIT_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const REDDIT_APP_REGISTRATION_URL = 'https://www.reddit.com/prefs/apps';

// Subreddit name regex per Reddit naming rules (2-21 chars, alnum + underscore).
// Used for input validation — prevents URL-injection in subreddit name.
export const SUBREDDIT_REGEX = /^[A-Za-z0-9_]{2,21}$/;

// Conservative rate limiter: 1 req/sec. Reddit allows 100/min for OAuth apps;
// staying well under that avoids 429s and is a good neighbor.
const MIN_INTERVAL_MS = 1000;
let lastRequestAt = 0;

async function rateLimit() {
  const now = Date.now();
  const wait = lastRequestAt + MIN_INTERVAL_MS - now;
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
  lastRequestAt = Date.now();
}

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function readCreds() {
  const fileEnv = loadEnvFile(join(homedir(), '.config', 'gg', '_gg.env'));
  // GG_-prefixed names take precedence per docs/PIPELINE.md Stage 0 convention.
  // Plain REDDIT_* names are kept as legacy fallback.
  const get = (...keys) => {
    for (const k of keys) {
      const v = process.env[k] || fileEnv[k];
      if (v) return v;
    }
    return undefined;
  };
  return {
    clientId: get('GG_REDDIT_CLIENT_ID', 'REDDIT_CLIENT_ID'),
    clientSecret: get('GG_REDDIT_CLIENT_SECRET', 'REDDIT_CLIENT_SECRET'),
    username: get('GG_REDDIT_USERNAME', 'REDDIT_USERNAME'),
    password: get('GG_REDDIT_PASSWORD', 'REDDIT_PASSWORD'),
    userAgent:
      get('GG_REDDIT_USER_AGENT', 'REDDIT_USER_AGENT') ||
      'gengrowth-friction-mine/0.1 (by gg-friction-mine)',
  };
}

/**
 * Report which credentials are present, without revealing values.
 * @returns {{hasClientId: boolean, hasClientSecret: boolean, hasUserPass: boolean, userAgent: string}}
 */
export function inspectCreds() {
  const c = readCreds();
  return {
    hasClientId: Boolean(c.clientId),
    hasClientSecret: Boolean(c.clientSecret),
    hasUserPass: Boolean(c.username && c.password),
    userAgent: c.userAgent,
  };
}

/**
 * Stable error class so callers (CLI) can decide whether to print the
 * Reddit app registration URL vs a generic transient-error message.
 */
export class RedditOAuthError extends Error {
  constructor(message, { code, status, registrationUrl } = {}) {
    super(message);
    this.name = 'RedditOAuthError';
    this.code = code || 'OAUTH_FAIL';
    if (status) this.status = status;
    if (registrationUrl) this.registrationUrl = registrationUrl;
  }
}

let cachedToken = null;
let cachedExpiry = 0;

/**
 * Acquire Reddit OAuth2 access token. Tokens are valid ~1 hour; cached
 * in-process.
 *
 * Grant selection (explicit, no env-based auto-detect):
 *   - Default: `client_credentials` (app-only token, sufficient for
 *     read-only public endpoints like /r/<sub>/search). This is the
 *     only grant used by gg-friction-mine.
 *   - Opt-in: pass `{ grantType: 'password' }` if (and ONLY if) the
 *     caller needs to act AS the user. The caller is responsible for
 *     wiring its own --grant-type flag; we deliberately do NOT auto-
 *     switch based on the presence of REDDIT_USERNAME / REDDIT_PASSWORD
 *     env vars so that a stray env var can't silently upgrade the
 *     token's scope.
 *
 * Throws RedditOAuthError with `code` set so the CLI can decide whether to
 * print the registration URL vs treat it as a transient/network failure.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.forceRefresh=false]
 * @param {'client_credentials'|'password'} [opts.grantType='client_credentials']
 */
export async function getRedditToken({
  forceRefresh = false,
  grantType = 'client_credentials',
} = {}) {
  if (grantType !== 'client_credentials' && grantType !== 'password') {
    throw new RedditOAuthError(
      `unknown grantType "${grantType}" — must be 'client_credentials' or 'password'`,
      { code: 'OAUTH_BAD_GRANT' },
    );
  }
  if (!forceRefresh && cachedToken && Date.now() < cachedExpiry - 60_000) {
    return cachedToken;
  }
  const { clientId, clientSecret, username, password, userAgent } = readCreds();
  const missing = [];
  if (!clientId) missing.push('GG_REDDIT_CLIENT_ID');
  if (!clientSecret) missing.push('GG_REDDIT_CLIENT_SECRET');
  if (missing.length) {
    throw new RedditOAuthError(
      `Reddit OAuth not configured. Missing: ${missing.join(', ')}. ` +
        `Register a script-type app at ${REDDIT_APP_REGISTRATION_URL} ` +
        `and add credentials to ~/.config/gg/_gg.env. ` +
        `See docs/REDDIT_OAUTH_SETUP.md for the 5-step walkthrough.`,
      { code: 'OAUTH_NOT_CONFIGURED', registrationUrl: REDDIT_APP_REGISTRATION_URL },
    );
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  let body;
  if (grantType === 'password') {
    if (!username || !password) {
      throw new RedditOAuthError(
        `password grant requested but REDDIT_USERNAME / REDDIT_PASSWORD env vars not set`,
        { code: 'OAUTH_NOT_CONFIGURED' },
      );
    }
    body = new URLSearchParams({ grant_type: 'password', username, password });
  } else {
    body = new URLSearchParams({ grant_type: 'client_credentials' });
  }

  await rateLimit();
  let resp;
  try {
    resp = await fetch(REDDIT_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': userAgent,
      },
      body,
    });
  } catch (e) {
    throw new RedditOAuthError(`Reddit OAuth network error: ${e.message}`, {
      code: 'OAUTH_NETWORK',
    });
  }
  if (resp.status === 401 || resp.status === 403) {
    const text = await resp.text();
    throw new RedditOAuthError(
      `Reddit OAuth rejected (${resp.status}). Verify GG_REDDIT_CLIENT_ID + ` +
        `GG_REDDIT_CLIENT_SECRET match an active script-type app at ` +
        `${REDDIT_APP_REGISTRATION_URL}. Body: ${text.slice(0, 200)}`,
      { code: 'OAUTH_REJECTED', status: resp.status, registrationUrl: REDDIT_APP_REGISTRATION_URL },
    );
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new RedditOAuthError(`Reddit OAuth ${resp.status}: ${text.slice(0, 300)}`, {
      code: 'OAUTH_FAIL',
      status: resp.status,
    });
  }
  const data = await resp.json();
  if (!data.access_token) {
    throw new RedditOAuthError(
      `Reddit OAuth missing access_token: ${JSON.stringify(data).slice(0, 300)}`,
      { code: 'OAUTH_NO_TOKEN' },
    );
  }
  cachedToken = data.access_token;
  cachedExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

/**
 * Authenticated Reddit fetch.
 *
 * - Rate-limited to 1 req/sec (process-wide) — well under Reddit's 100/min OAuth cap.
 * - On 429 (rate-limited): exponential backoff 2s → 4s → 8s, max 3 attempts.
 * - On 401: refresh token once, retry once.
 *
 * @param {string} path  relative path e.g. "/r/astrology/search".
 * @param {object} [opts]
 * @param {object} [opts.params]
 * @param {boolean} [opts.retry=true]    retry once on 401
 * @param {number}  [opts.attempt=0]     internal: current backoff attempt
 */
export async function redditFetch(path, { params = {}, retry = true, attempt = 0 } = {}) {
  const { userAgent } = readCreds();
  const token = await getRedditToken();
  const url = new URL(`${REDDIT_OAUTH_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  await rateLimit();
  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': userAgent,
    },
  });
  if (resp.status === 429 && attempt < 3) {
    const delay = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
    await new Promise((r) => setTimeout(r, delay));
    return redditFetch(path, { params, retry, attempt: attempt + 1 });
  }
  if (resp.status === 401 && retry) {
    await getRedditToken({ forceRefresh: true });
    return redditFetch(path, { params, retry: false, attempt });
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Reddit ${path} ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

/**
 * Search a subreddit (or sitewide) for posts matching a query. Returns the
 * full JSON listing; caller picks fields from `data.children[].data`.
 *
 * Subreddit names are validated against ^[A-Za-z0-9_]{2,21}$ — defense against
 * URL-injection if the subreddit ever comes from caller-controlled input.
 *
 * @param {string} query
 * @param {object} opts
 * @param {string} [opts.subreddit] — without "r/" prefix; omit for sitewide
 * @param {number} [opts.limit=25]
 * @param {string} [opts.sort='top']
 * @param {string} [opts.t='month'] — time filter for top/relevance
 */
export async function redditSearch(query, { subreddit, limit = 25, sort = 'top', t = 'month' } = {}) {
  if (subreddit !== undefined && subreddit !== null && subreddit !== '') {
    if (typeof subreddit !== 'string' || !SUBREDDIT_REGEX.test(subreddit)) {
      throw new Error(
        `redditSearch: invalid subreddit name "${String(subreddit).slice(0, 32)}" ` +
          `(must match ${SUBREDDIT_REGEX})`,
      );
    }
  }
  const path = subreddit ? `/r/${subreddit}/search` : '/search';
  const params = {
    q: query,
    restrict_sr: subreddit ? 1 : 0,
    sort,
    t,
    limit,
  };
  return redditFetch(path, { params });
}

/**
 * Lightweight OAuth probe — just fetches a token. Returns true on success,
 * throws RedditOAuthError on any failure (so callers can branch on `.code`).
 */
export async function checkRedditOAuth() {
  await getRedditToken({ forceRefresh: true });
  return true;
}

// Self-test CLI: `node tools/scripts/lib/_reddit-oauth.mjs --test`
if (import.meta.url === `file://${process.argv[1]}`) {
  const isTest = process.argv.includes('--test');
  if (!isTest) {
    process.stderr.write('usage: node _reddit-oauth.mjs --test\n');
    process.exit(2);
  }
  try {
    process.stderr.write('[reddit-oauth] obtaining token...\n');
    // Probe only — don't log even a prefix of the bearer token; even 10
    // chars can leak entropy if combined with timing/length side-channels.
    await getRedditToken();
    process.stderr.write('[reddit-oauth] token OK\n');
    process.stderr.write('[reddit-oauth] sample search: "blue aura meaning" in r/astrology...\n');
    const data = await redditSearch('blue aura meaning', { subreddit: 'astrology', limit: 3 });
    const posts = data?.data?.children || [];
    process.stderr.write(`[reddit-oauth] got ${posts.length} posts\n`);
    for (const p of posts) {
      process.stderr.write(`  - r/${p.data.subreddit}: ${p.data.title.slice(0, 80)}\n`);
    }
    process.stderr.write('[reddit-oauth] OK — auth + search working\n');
  } catch (err) {
    process.stderr.write(`[reddit-oauth] FAIL: ${err.message}\n`);
    process.exit(1);
  }
}
