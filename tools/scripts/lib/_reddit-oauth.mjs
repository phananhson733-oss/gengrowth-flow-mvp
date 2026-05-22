// _reddit-oauth.mjs — Reddit OAuth2 script-app helper.
//
// Unblocks B'.2 real friction-mine: gg-friction-mine.mjs currently scrapes
// anonymous old.reddit.com (heavily rate-limited and unreliable). With OAuth,
// you get oauth.reddit.com endpoints, 100 req/min, and ToS-clean auth.
//
// Setup (user side, ~5 min):
//   1. Go to https://www.reddit.com/prefs/apps
//   2. Click "create another app..." → choose "script" type
//   3. Name: "gengrowth-friction-mine"
//      Redirect URI: http://localhost:8080 (ignored for script-apps, must be set)
//   4. Copy the 14-char ID under your app name → REDDIT_CLIENT_ID
//   5. Copy the "secret" string → REDDIT_CLIENT_SECRET
//   6. Add 5 vars to ~/.config/gg/_gg.env (chmod 600):
//        REDDIT_CLIENT_ID=...
//        REDDIT_CLIENT_SECRET=...
//        REDDIT_USERNAME=<your reddit username>
//        REDDIT_PASSWORD=<your reddit password>
//        REDDIT_USER_AGENT=gengrowth-friction-mine/0.1 (by /u/<your username>)
//   7. Test: node tools/scripts/lib/_reddit-oauth.mjs --test
//
// API usage from other scripts:
//   import { getRedditToken, redditSearch } from './lib/_reddit-oauth.mjs';
//   const posts = await redditSearch('blue aura meaning', { subreddit: 'astrology', limit: 25 });

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REDDIT_OAUTH_BASE = 'https://oauth.reddit.com';
const REDDIT_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';

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
  const get = (k) => process.env[k] || fileEnv[k];
  return {
    clientId: get('REDDIT_CLIENT_ID'),
    clientSecret: get('REDDIT_CLIENT_SECRET'),
    username: get('REDDIT_USERNAME'),
    password: get('REDDIT_PASSWORD'),
    userAgent: get('REDDIT_USER_AGENT') || 'gengrowth-friction-mine/0.1',
  };
}

let cachedToken = null;
let cachedExpiry = 0;

/**
 * Acquire Reddit OAuth2 access token. Tokens are valid ~1 hour; cached
 * in-process. Throws with actionable setup hint if any cred is missing.
 */
export async function getRedditToken({ forceRefresh = false } = {}) {
  if (!forceRefresh && cachedToken && Date.now() < cachedExpiry - 60_000) {
    return cachedToken;
  }
  const { clientId, clientSecret, username, password, userAgent } = readCreds();
  const missing = [];
  if (!clientId) missing.push('REDDIT_CLIENT_ID');
  if (!clientSecret) missing.push('REDDIT_CLIENT_SECRET');
  if (!username) missing.push('REDDIT_USERNAME');
  if (!password) missing.push('REDDIT_PASSWORD');
  if (missing.length) {
    throw new Error(
      `Reddit OAuth setup incomplete. Missing: ${missing.join(', ')}. ` +
        `See header comments in tools/scripts/lib/_reddit-oauth.mjs for the 7-step setup.`,
    );
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'password',
    username,
    password,
  });
  const resp = await fetch(REDDIT_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent,
    },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Reddit OAuth ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  if (!data.access_token) {
    throw new Error(`Reddit OAuth missing access_token in response: ${JSON.stringify(data).slice(0, 300)}`);
  }
  cachedToken = data.access_token;
  cachedExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

/**
 * Authenticated Reddit fetch. Pass relative path (e.g. "/r/astrology/search").
 * Automatically retries once on 401 by refreshing the token.
 */
export async function redditFetch(path, { params = {}, retry = true } = {}) {
  const { userAgent } = readCreds();
  const token = await getRedditToken();
  const url = new URL(`${REDDIT_OAUTH_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': userAgent,
    },
  });
  if (resp.status === 401 && retry) {
    await getRedditToken({ forceRefresh: true });
    return redditFetch(path, { params, retry: false });
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
 * @param {string} query
 * @param {object} opts
 * @param {string} [opts.subreddit] — without "r/" prefix; omit for sitewide
 * @param {number} [opts.limit=25]
 * @param {string} [opts.sort='top']
 * @param {string} [opts.t='month'] — time filter for top/relevance
 */
export async function redditSearch(query, { subreddit, limit = 25, sort = 'top', t = 'month' } = {}) {
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

// Self-test CLI: `node tools/scripts/lib/_reddit-oauth.mjs --test`
if (import.meta.url === `file://${process.argv[1]}`) {
  const isTest = process.argv.includes('--test');
  if (!isTest) {
    process.stderr.write('usage: node _reddit-oauth.mjs --test\n');
    process.exit(2);
  }
  try {
    process.stderr.write('[reddit-oauth] obtaining token...\n');
    const token = await getRedditToken();
    process.stderr.write(`[reddit-oauth] token OK (${token.slice(0, 10)}...)\n`);
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
