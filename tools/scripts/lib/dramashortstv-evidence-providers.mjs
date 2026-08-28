import { redditSearch } from './_reddit-oauth.mjs';
import { sanitize, scrubPII } from './gg-shared.mjs';

const DATAFORSEO_BASE = 'https://api.dataforseo.com/v3/';
const APPLE_SEARCH_URL = 'https://itunes.apple.com/search';

function cleanText(value) {
  return scrubPII(sanitize(value)).text;
}

function safeUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function isDataForSeoSuccess(statusCode) {
  return Number.isInteger(statusCode) && statusCode >= 20000 && statusCode < 30000;
}

function taskItems(task) {
  return Array.isArray(task?.result?.[0]?.items) ? task.result[0].items : [];
}

function isCanonicalAppleAppUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'apps.apple.com' && /^\/[a-z]{2}\/app\//i.test(url.pathname);
  } catch {
    return false;
  }
}

export async function dataForSeoLive({ endpoint, tasks, login, password, fetchImpl = fetch }) {
  if (!endpoint || !Array.isArray(tasks) || !login || !password) {
    throw new Error('DataForSEO endpoint, tasks, login, and password are required');
  }
  const response = await fetchImpl(`${DATAFORSEO_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(tasks),
  });
  if (!response?.ok) {
    throw new Error(`DataForSEO HTTP ${response?.status ?? 'unknown'}`);
  }
  const payload = await response.json();
  if (!isDataForSeoSuccess(payload?.status_code)) {
    throw new Error(`DataForSEO top-level failure: ${payload?.status_code ?? 'missing'} ${payload?.status_message ?? ''}`.trim());
  }
  if (!Array.isArray(payload.tasks) || payload.tasks.some((task) => !isDataForSeoSuccess(task?.status_code))) {
    throw new Error('DataForSEO task failure');
  }
  return payload;
}

export async function fetchGoogleSerpEvidence({ querySpecs, login, password, fetchImpl = fetch, now = new Date().toISOString() }) {
  if (!Array.isArray(querySpecs) || querySpecs.some(({ query, purpose }) => !query || !purpose)) {
    throw new Error('querySpecs must contain query and purpose');
  }
  const results = [];
  for (const { query, purpose } of querySpecs) {
    const payload = await dataForSeoLive({
      endpoint: 'serp/google/organic/live/advanced',
      tasks: [{
        keyword: query,
        location_code: 2840,
        language_code: 'en',
        depth: 10,
        tag: purpose,
      }],
      login,
      password,
      fetchImpl,
    });
    const task = payload.tasks[0];
    if (payload.tasks.length !== 1 || task?.data?.tag !== purpose) {
      throw new Error('DataForSEO task count or purpose/tag set mismatch');
    }
    for (const item of taskItems(task)) {
      if (item?.type !== 'organic') continue;
      const url = safeUrl(item.url);
      if (!url) continue;
      const domain = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
      results.push({
        id: `serp:${purpose}:${item.rank_absolute ?? item.rank_group ?? results.length + 1}`,
        type: 'organic',
        purpose,
        url,
        title: cleanText(item.title),
        snippet: cleanText(item.description),
        domain,
      });
    }
  }
  return { status: results.length ? 'ok' : 'insufficient', provider: 'dataforseo-google-serp', collectedAt: now, results };
}

function trendValues(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) trendValues(item, out);
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    out.push(value);
  }
  return out;
}

export async function fetchGoogleTrendsEvidence({ keyword, login, password, fetchImpl = fetch, now = new Date().toISOString() }) {
  const payload = await dataForSeoLive({
    endpoint: 'keywords_data/google_trends/explore/live',
    tasks: [{ keywords: [keyword], location_code: 2840, language_code: 'en', time_range: 'past_12_months', item_types: ['google_trends_graph'] }],
    login,
    password,
    fetchImpl,
  });
  const firstResult = payload.tasks[0]?.result?.[0];
  const graph = Array.isArray(firstResult?.items) ? firstResult.items.find((item) => item?.type === 'google_trends_graph') : null;
  const checkUrl = safeUrl(firstResult?.check_url);
  const values = trendValues(graph?.data?.map((point) => point?.values));
  const results = graph ? [{ id: 'trends:graph:1', type: 'google_trends_graph', values }] : [];
  return {
    status: checkUrl && values.some((value) => value > 0) ? 'ok' : 'insufficient',
    provider: 'dataforseo-google-trends',
    collectedAt: now,
    checkUrl,
    values,
    results,
  };
}

function meaningfulTokens(entity) {
  const ignored = new Set(['app', 'actor', 'drama', 'short', 'series', 'the', 'and', 'vs']);
  return String(entity || '').toLowerCase().match(/[a-z0-9]+/g)?.filter((token) => !ignored.has(token) && token.length > 1) || [];
}

export async function fetchAppleAppEvidence({ entity, fetchImpl = fetch, now = new Date().toISOString() }) {
  const url = new URL(APPLE_SEARCH_URL);
  url.searchParams.set('term', entity);
  url.searchParams.set('country', 'us');
  url.searchParams.set('entity', 'software');
  const response = await fetchImpl(url.toString(), { headers: { accept: 'application/json' } });
  if (!response?.ok) throw new Error(`Apple Search HTTP ${response?.status ?? 'unknown'}`);
  const payload = await response.json();
  const tokens = meaningfulTokens(entity);
  const results = (Array.isArray(payload?.results) ? payload.results : []).flatMap((item) => {
    const name = cleanText(item?.trackName);
    const trackUrl = safeUrl(item?.trackViewUrl);
    if (!name || !trackUrl || !isCanonicalAppleAppUrl(trackUrl) || !tokens.some((token) => name.toLowerCase().includes(token))) return [];
    return [{ id: `apple:${item.trackId ?? trackUrl}`, name, url: trackUrl, snippet: cleanText(item.description) }];
  });
  return { status: results.length ? 'ok' : 'insufficient', provider: 'apple-itunes', collectedAt: now, results };
}

export async function fetchRedditEvidence({ query, redditSearchImpl = redditSearch, now = new Date().toISOString() }) {
  const payload = await redditSearchImpl(query, { limit: 10, sort: 'relevance', t: 'year' });
  const results = (Array.isArray(payload?.data?.children) ? payload.data.children : []).flatMap(({ data }) => {
    const relative = String(data?.permalink || '');
    const url = safeUrl(relative.startsWith('/') ? `https://www.reddit.com${relative}` : relative);
    if (!url) return [];
    return [{
      id: `reddit:${data?.id ?? url}`,
      url,
      title: cleanText(data?.title),
      snippet: cleanText(data?.selftext),
      subreddit: cleanText(data?.subreddit),
    }];
  });
  return { status: results.length ? 'ok' : 'insufficient', provider: 'reddit-oauth', collectedAt: now, results };
}
