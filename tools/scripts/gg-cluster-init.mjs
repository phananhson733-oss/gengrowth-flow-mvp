#!/usr/bin/env node
// gg-cluster-init.mjs — 主题集群初稿生成器
//
// PRD v0.7 §7.3.2 修法 #4 落地：
//   只从 关键词主表 R 列 = "⚡快速胜利" 或 "📌长尾词" 的行喂入聚类，
//   避免趋势词/战略词污染集群（趋势词应人工精修线、战略词独立做）。
//
// 设计原则（与 SOP v2.5 一致）：
//   - 主题集群表 README 标"人工填" — 本脚本只写自动可推导部分：
//       cluster_id（自动序号 c-001…）
//       cluster_name（核心共词，如 "aura colors"）
//       keywords_included（'\n' 分隔的真实词列表）
//     业务字段（track / jtbd / content_angle / cta / priority / week）留空，人工补
//   - 聚类用 token 共现 + 最长公共词头（jaccard 轻量版），无 mock 无随机
//   - 默认 dry-run，--write 才落 sheet；--rebuild 清空现有数据后重建
//
// 用法：
//   node tools/scripts/gg-cluster-init.mjs --dry-run                     (默认 dry-run)
//   node tools/scripts/gg-cluster-init.mjs --write
//   node tools/scripts/gg-cluster-init.mjs --write --rebuild
//   node tools/scripts/gg-cluster-init.mjs --workbook legacy --dry-run
//   node tools/scripts/gg-cluster-init.mjs --buckets 快速胜利,长尾词 --write
//   node tools/scripts/gg-cluster-init.mjs --algo embedding --dry-run    (embedding 模式 Phase 3)
//   node tools/scripts/gg-cluster-init.mjs --algo embedding --input /tmp/ind-002-words.txt --dry-run
//
// env required:
//   GG_SHEETS_FLOW_MVP_WORKBOOK_ID (default) OR GG_SHEETS_WORKBOOK_ID (legacy)
//   ~/.config/gg/gg-writer-sa.json
//   OPENAI_API_KEY  — required only when --algo embedding

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getAccessToken, gFetch, loadEnv } from './lib/gg-shared.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f, def = null) => (has(f) ? argv[argv.indexOf(f) + 1] : def);

const WRITE = has('--write');
const DRY = !WRITE || has('--dry-run');
const REBUILD = has('--rebuild');
const WORKBOOK = arg('--workbook', 'flow-mvp');
const BUCKETS_ARG = arg('--buckets', '快速胜利,长尾词')
  .split(',')
  .map((s) => s.trim());
// Map shorthand → full R 列 value
const BUCKETS = BUCKETS_ARG.map((b) => {
  if (b.includes('快速胜利')) return '⚡快速胜利';
  if (b.includes('长尾')) return '📌长尾词';
  if (b.includes('趋势')) return '🚀趋势词';
  if (b.includes('战略')) return '🎯战略词';
  return b;
});
const MIN_CLUSTER_SIZE = parseInt(arg('--min-size', '2'), 10);
const MAX_CLUSTER_SIZE = parseInt(arg('--max-size', '15'), 10);

// Phase 3: embedding-mode flags
const ALGO = arg('--algo', 'token'); // 'token' (default, backward compat) | 'embedding'
const COSINE_THRESHOLD = parseFloat(arg('--cosine-threshold', '0.35'));
// Backend: 'ollama' (local, free) | 'openai' (cloud, $). Auto-detect default:
// OPENAI_API_KEY set → openai; else → ollama (assumes daemon at OLLAMA_HOST).
const EMBED_BACKEND = arg(
  '--embed-backend',
  process.env.OPENAI_API_KEY ? 'openai' : 'ollama',
);
const DEFAULT_MODEL_BY_BACKEND = {
  openai: 'text-embedding-3-small',
  ollama: 'nomic-embed-text',
};
const EMBED_MODEL = arg('--embed-model', DEFAULT_MODEL_BY_BACKEND[EMBED_BACKEND] || 'nomic-embed-text');
const EMBED_BATCH_SIZE = parseInt(arg('--embed-batch', '100'), 10);
const OLLAMA_HOST = arg('--ollama-host', process.env.OLLAMA_HOST || 'http://localhost:11434');
const INPUT_FILE = arg('--input', null); // 可选 newline-separated 关键词文件（绕过 sheet）

if (!['token', 'embedding'].includes(ALGO)) {
  console.error(`ERR: --algo must be 'token' or 'embedding', got '${ALGO}'`);
  process.exit(2);
}
if (!['openai', 'ollama'].includes(EMBED_BACKEND)) {
  console.error(`ERR: --embed-backend must be 'openai' or 'ollama', got '${EMBED_BACKEND}'`);
  process.exit(2);
}

if (has('--help') || has('-h')) {
  console.log(`gg-cluster-init.mjs — 主题集群初稿（PRD §7.3.2 修法 #4 + Phase 3 embedding）

用法:
  --write                落到 sheet（默认 dry-run 只打印）
  --rebuild              清空 主题集群表 现有数据后重建
  --dry-run              强制 dry-run（不写）
  --workbook X           flow-mvp (默认) | legacy | <sheet-id>
  --buckets a,b          喂入桶（默认 "快速胜利,长尾词"，PRD 修法 #4）
  --min-size N           最小集群词数（默认 2）
  --max-size N           最大集群词数（默认 15，超出拆分）
  --algo X               token (默认) | embedding
                         embedding 模式: 向量化 + 凝聚聚类（agglomerative）
  --embed-backend X      ollama (默认无 key) | openai (设了 OPENAI_API_KEY 自动选)
  --embed-model X        embedding model id
                           ollama 默认: nomic-embed-text (768 dim, 137M, MIT)
                                  备选: mxbai-embed-large (1024 dim, 335M, MTEB SOTA)
                           openai 默认: text-embedding-3-small (1536 dim)
  --ollama-host X        默认 http://localhost:11434 (env OLLAMA_HOST 也可)
  --cosine-threshold X   embedding 模式下的余弦距离阈值（默认 0.35；越小越严苛）
  --embed-batch N        embedding API 单批次上限（默认 100）
  --input FILE           从文件读关键词列表（绕过 sheet，每行一个；用于 ind-002 子聚类测试）

embedding 模式 env:
  OPENAI_API_KEY  必填；从 env 读取（绝不 log）；缺失则报错退出
  缓存: .gg-cache/embeddings/<sha256(keyword)>.json（命中跳 API；已加入 .gitignore）
`);
  process.exit(0);
}

// ============================================================
// 1. token + cluster heuristics（无 mock，纯字面分析）
// ============================================================

// 英文 SEO 关键词常见 stopwords（话题无关）
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'for', 'in', 'on', 'to', 'is', 'are',
  'was', 'were', 'be', 'been', 'do', 'does', 'did', 'have', 'has', 'had',
  'what', 'why', 'how', 'when', 'where', 'who', 'which', 'that', 'this',
  'these', 'those', 'my', 'your', 'his', 'her', 'its', 'their', 'our',
  'me', 'you', 'him', 'them', 'us', 'i', 'we', 'they', 'it',
  'best', 'top', 'good', 'better', 'free', 'online', 'app', 'apps',
  'guide', 'tutorial', 'tips', 'meaning', 'means', 'mean', 'definition',
  'chart', 'calculator', 'tool', 'list', 'review', 'reviews',
  'vs', 'with', 'without', 'by', 'from', 'about', 'as', 'at',
  'can', 'should', 'will', 'would', 'could',
]);

// 修补#3：cluster_name 美化用的次级 stopword（参与 tokenize 但命名时跳过）
const NAMING_NOISE = new Set([
  'calculator', 'chart', 'meaning', 'mean', 'definition', 'sign',
  'free', 'online', 'best', 'top', 'guide', 'tool', 'app',
]);

// 修补#3：brand token 识别（用作命名前缀，便于人工识别）
const BRAND_PATTERNS = [
  { pattern: /astro[\s-]?seek/i, brand: 'astro-seek' },
  { pattern: /\bcafe astrology\b/i, brand: 'cafe-astrology' },
  { pattern: /\bco[\s-]?star\b/i, brand: 'co-star' },
  { pattern: /\bchani\b/i, brand: 'chani' },
  { pattern: /\bthe pattern\b/i, brand: 'the-pattern' },
  { pattern: /\bastro\.com\b/i, brand: 'astro.com' },
  { pattern: /\bastrosage\b/i, brand: 'astrosage' },
];

function tokenize(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t) && t.length >= 2);
}

// 修补#3：cluster name 美化
//   1. 若任一成员命中 brand pattern，加 [brand:X] 前缀
//   2. 在 cluster 内重新跑 trigram，若有 trigram 覆盖 ≥40% 成员，用 trigram 替代 raw seed
//   3. 剥离命名层 noise（calculator/chart/meaning…）
function prettifyClusterName(rawSeed, members) {
  if (!members || !members.length) return rawSeed;

  // brand 检测
  let brand = null;
  for (const { pattern, brand: b } of BRAND_PATTERNS) {
    if (members.some((m) => pattern.test(m))) { brand = b; break; }
  }

  // trigram 优选
  const trigramCount = new Map();
  for (const w of members) {
    const tokens = tokenize(w);
    for (let i = 0; i < tokens.length - 2; i++) {
      const tg = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`;
      trigramCount.set(tg, (trigramCount.get(tg) || 0) + 1);
    }
  }
  const minCoverage = Math.max(2, Math.ceil(members.length * 0.4));
  const topTrigram = [...trigramCount.entries()]
    .filter(([, n]) => n >= minCoverage)
    .sort((a, b) => b[1] - a[1])[0];

  let name = topTrigram ? topTrigram[0] : rawSeed;

  // 剥离 NAMING_NOISE token（仅当剥离后仍 ≥1 实义 token）
  const stripped = name
    .split(/\s+/)
    .filter((t) => !NAMING_NOISE.has(t.toLowerCase()))
    .join(' ');
  if (stripped && stripped.split(/\s+/).length >= 1) name = stripped;

  return brand ? `[${brand}] ${name}` : name;
}

// 找最频繁的 unigram + bigram（除停用词），按出现频次倒序
function findClusterSeeds(words) {
  const unigramCount = new Map();
  const bigramCount = new Map();
  for (const w of words) {
    const tokens = tokenize(w);
    for (const t of tokens) unigramCount.set(t, (unigramCount.get(t) || 0) + 1);
    for (let i = 0; i < tokens.length - 1; i++) {
      const bg = `${tokens[i]} ${tokens[i + 1]}`;
      bigramCount.set(bg, (bigramCount.get(bg) || 0) + 1);
    }
  }
  // 优先 bigram（更具体），降序
  const bigramSeeds = [...bigramCount.entries()]
    .filter(([, n]) => n >= MIN_CLUSTER_SIZE)
    .sort((a, b) => b[1] - a[1])
    .map(([bg]) => bg);
  const unigramSeeds = [...unigramCount.entries()]
    .filter(([, n]) => n >= MIN_CLUSTER_SIZE)
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);
  return { bigramSeeds, unigramSeeds };
}

// 修补#2：扫所有 bigram seed 找匹配，选最长（最具体）的。
// 全无 bigram 匹配才 fallback unigram（词边界匹配，避免 natal→prenatal 误判）。
// 防止母词虹吸：避免 astrology 这种高频短词把 north node / square / house 等子主题词全吃掉。
function assignClusters(words, seeds) {
  const clusters = new Map();
  const unassigned = [];

  for (const w of words) {
    const wl = w.toLowerCase();
    // bigram 最长匹配
    let bestBigram = null;
    for (const seed of seeds.bigramSeeds) {
      if (wl.includes(seed)) {
        if (!bestBigram || seed.length > bestBigram.length) bestBigram = seed;
      }
    }
    if (bestBigram) {
      if (!clusters.has(bestBigram)) clusters.set(bestBigram, []);
      clusters.get(bestBigram).push(w);
      continue;
    }
    // fallback: unigram 词边界匹配（first-match-wins，按 freq 倒序即可）
    let matched = null;
    for (const seed of seeds.unigramSeeds) {
      const re = new RegExp(`\\b${seed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (re.test(wl)) { matched = seed; break; }
    }
    if (matched) {
      if (!clusters.has(matched)) clusters.set(matched, []);
      clusters.get(matched).push(w);
    } else {
      unassigned.push(w);
    }
  }

  return { clusters, unassigned };
}

// 拆分超大集群（>MAX_CLUSTER_SIZE） → 二级 bigram 细分
function splitLargeClusters(clusters) {
  const result = new Map();
  for (const [name, words] of clusters.entries()) {
    if (words.length <= MAX_CLUSTER_SIZE) {
      result.set(name, words);
      continue;
    }
    // 二级 seed
    const sub = findClusterSeeds(words);
    const subSeeds = sub.bigramSeeds.filter((s) => s !== name).slice(0, 6);
    if (!subSeeds.length) {
      // 无法二级分裂，按字母序切块
      for (let i = 0; i < words.length; i += MAX_CLUSTER_SIZE) {
        const chunk = words.slice(i, i + MAX_CLUSTER_SIZE);
        result.set(`${name} (${Math.floor(i / MAX_CLUSTER_SIZE) + 1})`, chunk);
      }
      continue;
    }
    const subAssigned = assignClusters(words, { bigramSeeds: subSeeds, unigramSeeds: [] });
    // 修补#1：子桶 size < MIN_CLUSTER_SIZE 全部回流到 "(其它)" 兜底桶，不独立成集群。
    // 防止二级分裂时 freq=1 的 bigram 配贪心匹配产生 1 词桶（c-064~c-088 的根因）。
    const overflow = [...subAssigned.unassigned];
    for (const [subName, subWords] of subAssigned.clusters.entries()) {
      if (subWords.length >= MIN_CLUSTER_SIZE) {
        result.set(`${name} / ${subName}`, subWords);
      } else {
        overflow.push(...subWords);
      }
    }
    if (overflow.length) {
      result.set(`${name} (其它)`, overflow);
    }
  }
  return result;
}

// ============================================================
// 2. embedding-based clustering (Phase 3)
//
// Pipeline:
//   words → OpenAI text-embedding-3-small (1536 dim, batched, cached)
//   → L2-normalize vectors
//   → average-linkage agglomerative clustering with cosine-distance threshold
//   → reuse prettifyClusterName for human-readable names
//
// Cost model (2026-05): $0.020 / 1M tokens. ~3 tokens / short keyword.
// 500 words ≈ 1500 tokens ≈ $0.00003 per full run (effectively free).
// ============================================================

const CACHE_ROOT = join(process.cwd(), '.gg-cache', 'embeddings');

function ensureCacheDir() {
  if (!existsSync(CACHE_ROOT)) {
    mkdirSync(CACHE_ROOT, { recursive: true });
  }
}

function cachePathFor(key) {
  // key = `${model}:${keyword}` so model upgrade busts the cache.
  const sha = createHash('sha256').update(key).digest('hex');
  return join(CACHE_ROOT, `${sha}.json`);
}

function readCachedEmbedding(model, word) {
  const p = cachePathFor(`${model}:${word}`);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (j && Array.isArray(j.embedding) && j.embedding.length >= 16) return j.embedding;
  } catch {
    return null;
  }
  return null;
}

function writeCachedEmbedding(model, word, embedding) {
  ensureCacheDir();
  const p = cachePathFor(`${model}:${word}`);
  writeFileSync(p, JSON.stringify({ model, word, embedding, ts: Date.now() }));
}

function estimateTokens(words) {
  // Rough heuristic: 1 token ≈ 4 chars for short English phrases.
  // Good enough for "estimated cost" preview; we'll report actual usage from API.
  let total = 0;
  for (const w of words) total += Math.max(1, Math.ceil(w.length / 4));
  return total;
}

function estimateCostUsd(tokens, model = EMBED_MODEL, backend = EMBED_BACKEND) {
  // Ollama runs locally → $0.
  if (backend === 'ollama') return 0;
  // text-embedding-3-small: $0.020 / 1M tokens (2026-05 OpenAI pricing).
  // text-embedding-3-large: $0.130 / 1M tokens.
  const rate = model === 'text-embedding-3-large' ? 0.130 : 0.020;
  return (tokens / 1_000_000) * rate;
}

async function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call OpenAI embeddings API for a batch of strings.
 * Throws on persistent failure after retries.
 *
 * NOTE: never logs OPENAI_API_KEY.
 */
async function callOpenAIEmbed(batch, apiKey, model) {
  const url = 'https://api.openai.com/v1/embeddings';
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ input: batch, model }),
      });
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      if (!res.ok) {
        const errMsg = typeof body === 'object' && body.error
          ? body.error.message || JSON.stringify(body.error)
          : (typeof body === 'string' ? body : JSON.stringify(body));
        throw new Error(`OpenAI ${res.status} ${res.statusText}: ${errMsg}`);
      }
      if (!body.data || !Array.isArray(body.data) || body.data.length !== batch.length) {
        throw new Error(`OpenAI: unexpected response shape (data.length=${body.data?.length} vs batch=${batch.length})`);
      }
      // Ordered by API contract: body.data[i].embedding aligns with batch[i].
      return {
        embeddings: body.data.map((d) => d.embedding),
        usage: body.usage || null,
      };
    } catch (e) {
      lastErr = e;
      // Exponential backoff: 500ms, 1500ms, 4500ms
      const wait = 500 * Math.pow(3, attempt);
      console.error(`  ⚠ openai embed attempt ${attempt + 1} failed: ${e.message} (retry in ${wait}ms)`);
      if (attempt < 2) await sleepMs(wait);
    }
  }
  throw lastErr || new Error('OpenAI embeddings: exhausted retries');
}

/**
 * Call Ollama embeddings API for a batch of strings.
 * Uses POST /api/embed with input: [] (Ollama ≥0.1.46). Local, no auth.
 */
async function callOllamaEmbed(batch, model, host) {
  const url = `${host.replace(/\/+$/, '')}/api/embed`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: batch }),
      });
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      if (!res.ok) {
        const errMsg = typeof body === 'object' && body.error
          ? (typeof body.error === 'string' ? body.error : JSON.stringify(body.error))
          : (typeof body === 'string' ? body : JSON.stringify(body));
        throw new Error(`Ollama ${res.status} ${res.statusText}: ${errMsg}`);
      }
      if (!body.embeddings || !Array.isArray(body.embeddings) || body.embeddings.length !== batch.length) {
        throw new Error(`Ollama: unexpected response shape (embeddings.length=${body.embeddings?.length} vs batch=${batch.length})`);
      }
      // Synthesize a "usage" so estimateCostUsd has something (cost is 0 for ollama).
      const tokensApprox = batch.reduce((s, w) => s + Math.max(1, Math.ceil(w.length / 4)), 0);
      return {
        embeddings: body.embeddings,
        usage: { total_tokens: tokensApprox },
      };
    } catch (e) {
      lastErr = e;
      // Ollama is local: ECONNREFUSED usually means daemon not running.
      // Don't retry forever; surface fast.
      if (/ECONNREFUSED|fetch failed/i.test(String(e.message))) {
        throw new Error(
          `Ollama daemon unreachable at ${host}. Start with: ollama serve  ` +
          `(or check OLLAMA_HOST env). Original: ${e.message}`,
        );
      }
      const wait = 500 * Math.pow(3, attempt);
      console.error(`  ⚠ ollama embed attempt ${attempt + 1} failed: ${e.message} (retry in ${wait}ms)`);
      if (attempt < 2) await sleepMs(wait);
    }
  }
  throw lastErr || new Error('Ollama embeddings: exhausted retries');
}

/**
 * Dispatch to the right backend.
 */
async function callEmbeddingApi(batch, model, opts) {
  if (opts.backend === 'ollama') {
    return callOllamaEmbed(batch, model, opts.host);
  }
  // OpenAI is the default for backward compat.
  return callOpenAIEmbed(batch, opts.apiKey, model);
}

/**
 * Embed an array of words. Returns { vectors: number[][], tokensUsed, cacheHits, apiCalls }.
 * Cache hits skip API entirely.
 *
 * Signature is back-compat:
 *   embedWords(words, apiKey, model, batchSize)    — old, defaults backend=openai
 *   embedWords(words, { backend, apiKey, host, model, batchSize })  — new
 */
async function embedWords(words, optsOrApiKey, modelArg, batchSizeArg) {
  ensureCacheDir();

  // Normalize options.
  let opts;
  if (typeof optsOrApiKey === 'string' || optsOrApiKey === null || optsOrApiKey === undefined) {
    // Legacy positional call: (words, apiKey, model, batchSize)
    opts = {
      backend: optsOrApiKey ? 'openai' : EMBED_BACKEND, // null/empty key + ollama default works
      apiKey: optsOrApiKey || null,
      host: OLLAMA_HOST,
      model: modelArg || EMBED_MODEL,
      batchSize: batchSizeArg || EMBED_BATCH_SIZE,
    };
  } else {
    opts = {
      backend: optsOrApiKey.backend || EMBED_BACKEND,
      apiKey: optsOrApiKey.apiKey || process.env.OPENAI_API_KEY || null,
      host: optsOrApiKey.host || OLLAMA_HOST,
      model: optsOrApiKey.model || EMBED_MODEL,
      batchSize: optsOrApiKey.batchSize || EMBED_BATCH_SIZE,
    };
  }

  if (opts.backend === 'openai' && !opts.apiKey) {
    throw new Error('embedWords: backend=openai but no apiKey (OPENAI_API_KEY).');
  }

  const vectors = new Array(words.length);
  const missingIdx = [];
  let cacheHits = 0;

  // Cache key includes model name → different backends/models don't collide.
  for (let i = 0; i < words.length; i++) {
    const cached = readCachedEmbedding(opts.model, words[i]);
    if (cached) {
      vectors[i] = cached;
      cacheHits++;
    } else {
      missingIdx.push(i);
    }
  }

  let tokensUsed = 0;
  let apiCalls = 0;

  for (let off = 0; off < missingIdx.length; off += opts.batchSize) {
    const idxBatch = missingIdx.slice(off, off + opts.batchSize);
    const wordBatch = idxBatch.map((i) => words[i]);
    const { embeddings, usage } = await callEmbeddingApi(wordBatch, opts.model, opts);
    apiCalls++;
    if (usage && typeof usage.total_tokens === 'number') tokensUsed += usage.total_tokens;
    for (let k = 0; k < idxBatch.length; k++) {
      vectors[idxBatch[k]] = embeddings[k];
      writeCachedEmbedding(opts.model, words[idxBatch[k]], embeddings[k]);
    }
  }

  return { vectors, tokensUsed, cacheHits, apiCalls, totalMissing: missingIdx.length, backend: opts.backend, model: opts.model };
}

/**
 * L2-normalize a vector in place (returns a new array).
 */
function l2normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/**
 * Cosine distance between two L2-normalized vectors = 1 - dot.
 */
function cosDist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return 1 - s;
}

/**
 * Average-linkage agglomerative clustering with cosine distance.
 *
 * Vectors must already be L2-normalized. Returns array of clusters (each = array of original indices).
 * Stops merging when minimum inter-cluster distance > threshold.
 *
 * Complexity: O(N^2) memory + O(N^2 log N) time worst-case. Fine for N ≤ ~2000.
 * For larger inputs, switch to HDBSCAN (out of scope for v1).
 */
function agglomerativeCluster(vectors, threshold) {
  const n = vectors.length;
  if (n === 0) return [];
  if (n === 1) return [[0]];

  // Each cluster starts as a singleton.
  const clusters = vectors.map((_, i) => ({ id: i, members: [i], active: true }));

  // Pairwise distance matrix (upper triangular).
  const dist = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = cosDist(vectors[i], vectors[j]);
      dist[i * n + j] = d;
      dist[j * n + i] = d;
    }
  }

  // Track per-cluster sum used for average-linkage update.
  // For average-linkage: D(A∪B, C) = (|A|·D(A,C) + |B|·D(B,C)) / (|A|+|B|)
  // We maintain dist as cluster-to-cluster average (indexed by cluster.id).

  while (true) {
    // Find minimum-distance active pair.
    let minD = Infinity;
    let minI = -1, minJ = -1;
    for (let i = 0; i < n; i++) {
      if (!clusters[i].active) continue;
      for (let j = i + 1; j < n; j++) {
        if (!clusters[j].active) continue;
        const d = dist[i * n + j];
        if (d < minD) { minD = d; minI = i; minJ = j; }
      }
    }

    if (minI === -1 || minD > threshold) break;

    // Merge j into i.
    const A = clusters[minI];
    const B = clusters[minJ];
    const sizeA = A.members.length;
    const sizeB = B.members.length;

    // Update distances: new distance from merged cluster (at id minI) to every other active cluster.
    for (let k = 0; k < n; k++) {
      if (k === minI || k === minJ || !clusters[k].active) continue;
      const dAk = dist[minI * n + k];
      const dBk = dist[minJ * n + k];
      const dNew = (sizeA * dAk + sizeB * dBk) / (sizeA + sizeB);
      dist[minI * n + k] = dNew;
      dist[k * n + minI] = dNew;
    }

    // Merge members; mark B inactive.
    A.members = A.members.concat(B.members);
    B.active = false;
  }

  return clusters.filter((c) => c.active).map((c) => c.members);
}

/**
 * Pick a representative "seed" name for a cluster from its member keywords.
 * Heuristic: longest shared bigram if any, else most-frequent unigram across members,
 * else first member verbatim. Then runs through prettifyClusterName for branding/noise-stripping.
 */
function seedNameForClusterMembers(members) {
  // Reuse findClusterSeeds locally on the cluster's own words.
  const sub = findClusterSeeds(members);
  let rawSeed = null;
  if (sub.bigramSeeds.length) rawSeed = sub.bigramSeeds[0];
  else if (sub.unigramSeeds.length) rawSeed = sub.unigramSeeds[0];
  else rawSeed = members[0]; // fallback: first keyword
  return prettifyClusterName(rawSeed, members);
}

/**
 * Run embedding-based clustering on `words`. Returns { clusters: Map<name, words[]>, unassigned: words[], stats }.
 *
 * Singletons (cluster size 1) and clusters smaller than MIN_CLUSTER_SIZE are collected into `unassigned`.
 */
async function clusterByEmbedding(words, apiKey) {
  const tokensEst = estimateTokens(words);
  const costEst = estimateCostUsd(tokensEst, EMBED_MODEL);
  console.log(`\nembedding 模式：${words.length} 词，估算 ~${tokensEst} tokens，~$${costEst.toFixed(6)}`);
  console.log(`  model=${EMBED_MODEL}  cosine-threshold=${COSINE_THRESHOLD}  batch=${EMBED_BATCH_SIZE}`);

  const t0 = Date.now();
  const { vectors, tokensUsed, cacheHits, apiCalls, totalMissing } = await embedWords(words, apiKey, EMBED_MODEL, EMBED_BATCH_SIZE);
  const tEmbed = Date.now() - t0;
  const actualCost = estimateCostUsd(tokensUsed, EMBED_MODEL);
  console.log(`  embed done: cache=${cacheHits} api=${apiCalls} calls (${totalMissing} new words), ${tokensUsed} tokens, $${actualCost.toFixed(6)} actual, ${tEmbed}ms`);

  // L2-normalize all vectors for cosine.
  const normed = vectors.map(l2normalize);

  // Agglomerative.
  const t1 = Date.now();
  const rawClusters = agglomerativeCluster(normed, COSINE_THRESHOLD);
  const tCluster = Date.now() - t1;
  console.log(`  agglomerative done: ${rawClusters.length} raw clusters (incl. singletons), ${tCluster}ms`);

  // Build Map<name, words[]> + collect singletons/sub-MIN as unassigned.
  const clusters = new Map();
  const unassigned = [];
  const usedNames = new Set();

  // Sort large-first so name collisions resolve in favor of bigger cluster.
  const sorted = rawClusters
    .map((idxs) => idxs.map((i) => words[i]))
    .sort((a, b) => b.length - a.length);

  for (const members of sorted) {
    if (members.length < MIN_CLUSTER_SIZE) {
      unassigned.push(...members);
      continue;
    }
    let name = seedNameForClusterMembers(members);
    // De-dupe naming collisions across clusters.
    let suffix = 2;
    let base = name;
    while (usedNames.has(name)) {
      name = `${base} (${suffix++})`;
    }
    usedNames.add(name);
    clusters.set(name, members);
  }

  return {
    clusters,
    unassigned,
    stats: {
      inputWords: words.length,
      tokensUsed,
      cacheHits,
      apiCalls,
      totalMissing,
      actualCostUsd: actualCost,
      estimatedCostUsd: costEst,
      embedMs: tEmbed,
      clusterMs: tCluster,
      rawClusterCount: rawClusters.length,
      finalClusterCount: clusters.size,
      unassignedCount: unassigned.length,
    },
  };
}

// ============================================================
// 3. sheet io
// ============================================================

async function fetchValues(token, sid, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`;
  return ((await gFetch(url, token)).values) || [];
}

async function updateValues(token, sid, range, values, valueInputOption = 'RAW') {
  return gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}?valueInputOption=${valueInputOption}`,
    token,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values }),
    },
  );
}

async function clearRange(token, sid, range) {
  return gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}:clear`,
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    },
  );
}

// ============================================================
// 4. main
// ============================================================

/**
 * Build the rows-to-write payload from a (clusters, unassigned) pair.
 * Shared by token and embedding modes so sheet schema stays in lockstep.
 */
function buildOutputRows(clusters, unassigned) {
  const out = [];
  let seq = 1;
  for (const [name, members] of [...clusters.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const cluster_id = `c-${String(seq).padStart(3, '0')}`;
    // token-mode runs prettify here (raw seed → branded); embedding-mode already prettifies
    // upstream in seedNameForClusterMembers, so a re-pass is idempotent.
    const prettyName = prettifyClusterName(name, members);
    out.push([
      cluster_id,                    // A cluster_id
      prettyName,                    // B cluster_name (auto-prettified, 人工可改)
      '',                            // C track (人工)
      '',                            // D content_layer (人工)
      '',                            // E business_role (人工)
      '',                            // F primary_entity (人工)
      '',                            // G jtbd (人工)
      '',                            // H content_angle (人工)
      '',                            // I us_share (人工)
      '',                            // J pillar_page (人工)
      '',                            // K series_pattern (人工)
      members.join('\n'),            // L keywords_included (auto)
      '',                            // M page_assets (人工)
      '',                            // N internal_link_rule (人工)
      '',                            // O cta_primary (人工)
      '',                            // P psych_safety_flag (人工)
      '',                            // Q priority (人工)
      '',                            // R week (人工)
      '',                            // S success_metric (人工)
    ]);
    seq++;
  }
  if (unassigned && unassigned.length) {
    out.push([
      `c-${String(seq).padStart(3, '0')}`,
      '(未聚类 — 人工分配)',
      '', '', '', '', '', '', '', '', '',
      unassigned.join('\n'),
      '', '', '', '', '', '', '',
    ]);
  }
  return out;
}

function readInputFile(path) {
  const raw = readFileSync(path, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
}

async function main() {
  loadEnv();

  // Resolve credentials / daemon up front so embedding mode fails loud before we waste effort.
  let openaiKey = null;
  if (ALGO === 'embedding') {
    if (EMBED_BACKEND === 'openai') {
      openaiKey = process.env.OPENAI_API_KEY || null;
      if (!openaiKey) {
        console.error('ERR: --embed-backend openai requires OPENAI_API_KEY in env (~/.config/gg/_gg.env or shell).');
        console.error('     Key is never logged. Set OPENAI_API_KEY=sk-... or use --embed-backend ollama.');
        process.exit(2);
      }
    } else if (EMBED_BACKEND === 'ollama') {
      // Quick health probe; daemon unreachable → fail loud with actionable hint.
      try {
        const r = await fetch(`${OLLAMA_HOST.replace(/\/+$/, '')}/api/tags`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        const models = (j.models || []).map((m) => m.name);
        if (!models.some((m) => m === EMBED_MODEL || m.startsWith(EMBED_MODEL + ':'))) {
          console.error(`ERR: ollama model '${EMBED_MODEL}' not found on ${OLLAMA_HOST}.`);
          console.error(`     Pull it first: ollama pull ${EMBED_MODEL}`);
          console.error(`     Or pick from installed: ${models.join(', ') || '(none)'}`);
          process.exit(2);
        }
      } catch (e) {
        console.error(`ERR: cannot reach ollama daemon at ${OLLAMA_HOST}: ${e.message}`);
        console.error('     Start it: ollama serve  (or set OLLAMA_HOST / --ollama-host)');
        process.exit(2);
      }
    }
  }

  // Source words: either --input file (test path, bypasses sheet) or 关键词主表 R 列.
  let words = [];
  let sid = null;
  let token = null;

  if (INPUT_FILE) {
    if (!existsSync(INPUT_FILE)) {
      console.error(`ERR: --input file not found: ${INPUT_FILE}`);
      process.exit(2);
    }
    words = readInputFile(INPUT_FILE);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Source:   --input ${INPUT_FILE}  (${words.length} words)`);
    console.log(`Algo:     ${ALGO}${ALGO === 'embedding' ? `  threshold=${COSINE_THRESHOLD}` : ''}`);
    console.log(`Mode:     ${DRY ? 'DRY-RUN' : 'WRITE'}${REBUILD ? ' + REBUILD' : ''}`);
    console.log('');
    if (!DRY) {
      // --write only meaningful for the sheet; with --input we have no original sheet rows
      // to overwrite — refuse so we don't surprise the user.
      console.error('ERR: --input FILE only supports --dry-run (sheet write would orphan main-table provenance).');
      process.exit(2);
    }
  } else {
    if (WORKBOOK === 'flow-mvp') sid = process.env.GG_SHEETS_FLOW_MVP_WORKBOOK_ID;
    else if (WORKBOOK === 'legacy') sid = process.env.GG_SHEETS_WORKBOOK_ID;
    else sid = WORKBOOK;
    if (!sid) {
      console.error(`ERR: workbook "${WORKBOOK}" — set GG_SHEETS_FLOW_MVP_WORKBOOK_ID or pass --workbook <id>`);
      process.exit(2);
    }
    const sa = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
    if (!existsSync(sa)) {
      console.error(`ERR: writer SA not found: ${sa}`);
      process.exit(2);
    }
    const auth = await getAccessToken(sa, ['https://www.googleapis.com/auth/spreadsheets']);
    token = auth.token;

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Workbook: ${WORKBOOK} (${sid.slice(0, 12)}…)`);
    console.log(`Buckets:  ${BUCKETS.join(' / ')}`);
    console.log(`Algo:     ${ALGO}${ALGO === 'embedding' ? `  threshold=${COSINE_THRESHOLD}` : ''}`);
    console.log(`Mode:     ${DRY ? 'DRY-RUN' : 'WRITE'}${REBUILD ? ' + REBUILD' : ''}`);
    console.log('');

    const rows = await fetchValues(token, sid, '关键词主表!A2:R1500');
    console.log(`关键词主表 总行数: ${rows.length}`);
    const eligible = rows.filter((r) => r[0] && BUCKETS.includes(r[17])); // R = col index 17
    console.log(`  ${BUCKETS.join('/')} 桶合格行: ${eligible.length}`);

    if (eligible.length === 0) {
      console.log('\n⚠ 无合格行可聚类。');
      console.log('  这通常意味着关键词主表 I 列（自有站 DR）未填，');
      console.log('  导致 J 列差值=G-I 偏大，N 列 DR 闸门判 ❌跳过，R 列归入 ❌跳过。');
      console.log('  → 按 SOP 在 Ahrefs 查 astrologywiki.com 当前 DR 并填入 I 列，再重跑。');
      console.log('\nDRY-RUN: 无 sheet 写入。');
      process.exit(0);
    }
    words = eligible.map((r) => String(r[0]));
  }

  // ----- Cluster (mode-dependent) -----
  let clusters;
  let unassigned;

  if (ALGO === 'token') {
    const seeds = findClusterSeeds(words);
    console.log(`\n种子词: bigram=${seeds.bigramSeeds.length} unigram=${seeds.unigramSeeds.length}`);
    const initial = assignClusters(words, seeds);

    // 修补#1（一级补强）：一级集群 size < MIN_CLUSTER_SIZE 也回流到 unassigned 兜底，
    // 不让 "find"/"ic"/"white" 这种 freq=2 的 unigram fallback 产生 1-2 词僵尸集群。
    const oneLevelOverflow = [];
    for (const [name, mem] of [...initial.clusters.entries()]) {
      if (mem.length < MIN_CLUSTER_SIZE) {
        oneLevelOverflow.push(...mem);
        initial.clusters.delete(name);
      }
    }
    if (oneLevelOverflow.length) initial.unassigned.push(...oneLevelOverflow);

    clusters = splitLargeClusters(initial.clusters);
    unassigned = initial.unassigned;
    console.log(`初步集群: ${clusters.size}  未分配: ${unassigned.length}`);
  } else {
    // embedding mode
    const result = await clusterByEmbedding(words, openaiKey);
    clusters = result.clusters;
    unassigned = result.unassigned;
    const s = result.stats;
    console.log(`初步集群: ${clusters.size}  未分配: ${unassigned.length}  (raw=${s.rawClusterCount} 含奇异点)`);
    console.log(`cache hits: ${s.cacheHits}/${s.inputWords}  api calls: ${s.apiCalls}  tokens: ${s.tokensUsed}  actual $${s.actualCostUsd.toFixed(6)}`);
  }

  // ----- Build rows + report -----
  const out = buildOutputRows(clusters, unassigned);

  console.log('\n━━━ 集群草稿（按词数倒序前 10）━━━');
  for (const row of out.slice(0, 10)) {
    const memberCount = row[11].split('\n').filter(Boolean).length;
    console.log(`  ${row[0]}  ${String(row[1]).padEnd(36)}  ${String(memberCount).padStart(3)} 词`);
    const preview = row[11].split('\n').slice(0, 3).join(' | ');
    console.log(`         ↳ ${preview}${memberCount > 3 ? ' …' : ''}`);
  }
  if (out.length > 10) console.log(`  ... (+${out.length - 10} more clusters)`);

  // Stats summary (useful for token-vs-embedding comparison runs)
  const totalAssigned = [...clusters.values()].reduce((n, m) => n + m.length, 0);
  console.log(`\n汇总: ${clusters.size} 集群 / ${totalAssigned} 词已分配 / ${unassigned.length} 未分配 / 输入 ${words.length} 词`);

  if (DRY) {
    console.log('\nDRY-RUN: 无 sheet 写入。加 --write 落盘。');
    return;
  }

  if (REBUILD) {
    console.log('\nREBUILD: 清空 主题集群表!A2:S1500 ...');
    await clearRange(token, sid, '主题集群表!A2:S1500');
  }

  const lastRow = 1 + out.length;
  const range = `主题集群表!A2:S${lastRow}`;
  console.log(`WRITE → ${range} (${out.length} clusters)`);
  await updateValues(token, sid, range, out);
  console.log(`✓ wrote ${out.length} clusters`);
  console.log(`  Open: https://docs.google.com/spreadsheets/d/${sid}/edit`);
}

// 仅在直接 invoke 时跑（保护 import 复用算法函数）
import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('FATAL:', e.message);
    process.exit(1);
  });
}

export {
  tokenize,
  findClusterSeeds,
  assignClusters,
  splitLargeClusters,
  prettifyClusterName,
  // embedding-mode exports for tests / reuse
  cachePathFor,
  readCachedEmbedding,
  writeCachedEmbedding,
  l2normalize,
  cosDist,
  agglomerativeCluster,
  seedNameForClusterMembers,
  clusterByEmbedding,
  embedWords,
};
