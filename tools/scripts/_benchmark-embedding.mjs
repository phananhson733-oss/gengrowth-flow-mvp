#!/usr/bin/env node
// _benchmark-embedding.mjs — three-way Ollama embedding model comparison
//
// 跑同一批关键词（默认 R=⚡快速胜利+📌长尾 / 475 词）通过 N 个 ollama embedding 模型
// 比较：cluster 数 / assigned 词数 / singleton 数 / 跑时 / cost ($0 for ollama)
// 也单独测 ind-002（50 词异质桶）能拆出几个子簇 — 这是判断 quality 的关键场景
//
// Outputs:
//   docs/EMBEDDING_BENCHMARK_<date>.md    detailed markdown report
//   .gg-cache/benchmark/embedding-<date>.json  raw numbers per model
//
// Usage:
//   node tools/scripts/_benchmark-embedding.mjs \
//     --models nomic-embed-text,mxbai-embed-large,qwen3-embedding:8b \
//     [--cosine-threshold 0.35]
//     [--workbook flow-mvp]
//     [--out docs/EMBEDDING_BENCHMARK_2026-05-23.md]

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { loadEnv, getAccessToken, gFetch } from './lib/gg-shared.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
function has(name) { return process.argv.includes(name); }

const MODELS = (arg('--models', 'nomic-embed-text,mxbai-embed-large,qwen3-embedding:8b'))
  .split(',').map((s) => s.trim()).filter(Boolean);
const COSINE_THRESHOLD = arg('--cosine-threshold', '0.35');
const WORKBOOK = arg('--workbook', 'flow-mvp');
const OUT_DOC = arg('--out', join(REPO, 'docs', `EMBEDDING_BENCHMARK_${new Date().toISOString().slice(0, 10)}.md`));
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

if (has('--help') || has('-h')) {
  console.log(`_benchmark-embedding.mjs — three-way ollama embedding comparison
用法:
  --models a,b,c           model names (default: nomic-embed-text,mxbai-embed-large,qwen3-embedding:8b)
  --cosine-threshold 0.35  same threshold across models for fair comparison
  --workbook flow-mvp      sheet workbook
  --out X.md               output markdown report path

输出:
  - docs/EMBEDDING_BENCHMARK_<date>.md (人读)
  - .gg-cache/benchmark/embedding-<date>.json (机读)
`);
  process.exit(0);
}

// ────────────────────────────────────────────────────────── sheet read
async function pullInputWords() {
  loadEnv();
  let sid;
  if (WORKBOOK === 'flow-mvp') sid = process.env.GG_SHEETS_FLOW_MVP_WORKBOOK_ID;
  else if (WORKBOOK === 'legacy') sid = process.env.GG_SHEETS_WORKBOOK_ID;
  else sid = WORKBOOK;
  if (!sid) throw new Error(`workbook "${WORKBOOK}" not configured`);

  const sa = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
  const auth = await getAccessToken(sa, ['https://www.googleapis.com/auth/spreadsheets.readonly']);
  const token = auth.token;

  // 关键词主表 A=关键词, R=分桶
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent('关键词主表!A2:R1500')}?valueRenderOption=UNFORMATTED_VALUE`;
  const j = await gFetch(url, token);
  const rows = j.values || [];
  const allWords = [];
  const ind002Words = [];
  for (const r of rows) {
    const kw = (r[0] || '').toString().trim();
    const bucket = (r[17] || '').toString().trim();
    if (!kw) continue;
    if (bucket.includes('快速胜利') || bucket.includes('长尾')) allWords.push(kw);
  }

  // ind-002 keywords: get from 主题集群表 L 列 where cluster_id='ind-002'
  const ind002Url = `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent('主题集群表!A2:L40')}?valueRenderOption=UNFORMATTED_VALUE`;
  const j2 = await gFetch(ind002Url, token);
  for (const r of (j2.values || [])) {
    const cid = (r[0] || '').toString().trim();
    if (cid === 'ind-002') {
      const kws = (r[11] || '').toString().split(/\n+/).map((s) => s.trim()).filter(Boolean);
      ind002Words.push(...kws);
      break;
    }
  }

  return { allWords, ind002Words };
}

// ────────────────────────────────────────────────────────── single-model run
function runOllamaCluster(model, words, label) {
  const tmpFile = join(REPO, '.gg-cache', 'benchmark', `input-${label}.txt`);
  mkdirSync(dirname(tmpFile), { recursive: true });
  writeFileSync(tmpFile, words.join('\n'));

  const t0 = Date.now();
  const res = spawnSync('node', [
    'tools/scripts/gg-cluster-init.mjs',
    '--algo', 'embedding',
    '--embed-backend', 'ollama',
    '--embed-model', model,
    '--input', tmpFile,
    '--min-size', '2',
    '--cosine-threshold', COSINE_THRESHOLD,
    '--dry-run',
  ], {
    cwd: REPO,
    encoding: 'utf-8',
    timeout: 600000, // 10 min ceiling
    env: { ...process.env },
  });
  const wallMs = Date.now() - t0;

  if (res.status !== 0) {
    return {
      model, label, ok: false,
      error: res.stderr.slice(-500) || res.stdout.slice(-500),
      wallMs,
    };
  }

  const out = res.stdout;
  // Parse: "汇总: N 集群 / M 词已分配 / K 未分配 / 输入 J 词"
  const sum = out.match(/汇总:\s*(\d+)\s*集群\s*\/\s*(\d+)\s*词已分配\s*\/\s*(\d+)\s*未分配\s*\/\s*输入\s*(\d+)\s*词/);
  // Parse: "embed done: cache=N api=M calls (K new words), L tokens, $X actual, Tms"
  const embed = out.match(/embed done:\s*cache=(\d+)\s+api=(\d+)\s+calls\s+\((\d+)\s+new\s+words\),\s+(\d+)\s+tokens,\s+\$([\d.]+)\s+actual,\s+(\d+)ms/);
  // Parse: "初步集群: N  未分配: M  (raw=K 含奇异点)"
  const initial = out.match(/初步集群:\s*(\d+)\s+未分配:\s*(\d+)\s+\(raw=(\d+)/);

  return {
    model, label, ok: true,
    wallMs,
    summary: {
      clusters: sum ? +sum[1] : null,
      assigned: sum ? +sum[2] : null,
      unassigned: sum ? +sum[3] : null,
      input: sum ? +sum[4] : null,
    },
    initial: {
      clusters: initial ? +initial[1] : null,
      unassigned: initial ? +initial[2] : null,
      raw_incl_singletons: initial ? +initial[3] : null,
    },
    embed: {
      cache_hits: embed ? +embed[1] : null,
      api_calls: embed ? +embed[2] : null,
      new_words: embed ? +embed[3] : null,
      tokens: embed ? +embed[4] : null,
      cost_usd: embed ? +embed[5] : null,
      embed_ms: embed ? +embed[6] : null,
    },
  };
}

// ────────────────────────────────────────────────────────── main
async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Ollama embedding benchmark — ${MODELS.length} models`);
  console.log(`Models : ${MODELS.join(', ')}`);
  console.log(`Threshold: ${COSINE_THRESHOLD} (cosine distance)`);
  console.log('');

  // Verify ollama daemon + models
  console.log('verifying ollama + models...');
  try {
    const r = await fetch(`${OLLAMA_HOST.replace(/\/+$/, '')}/api/tags`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const installed = (j.models || []).map((m) => m.name);
    for (const m of MODELS) {
      const found = installed.some((i) => i === m || i.startsWith(m + ':'));
      console.log(`  ${found ? '✅' : '❌'} ${m}${found ? '' : ' (run: ollama pull ' + m + ')'}`);
      if (!found) { process.exit(2); }
    }
  } catch (e) {
    console.error(`ERR: ollama unreachable at ${OLLAMA_HOST}: ${e.message}`);
    process.exit(2);
  }

  console.log('\nloading input from sheet...');
  const { allWords, ind002Words } = await pullInputWords();
  console.log(`  ${allWords.length} words from R=⚡快速胜利+📌长尾`);
  console.log(`  ${ind002Words.length} words from ind-002 (heterogeneous bucket)`);

  const results = { date: new Date().toISOString(), threshold: COSINE_THRESHOLD, models: {} };

  for (const m of MODELS) {
    console.log(`\n━━━ ${m} ━━━`);

    console.log(`  [1/2] full corpus (${allWords.length} words)...`);
    const full = runOllamaCluster(m, allWords, `full-${m.replace(/[:/]/g, '_')}`);
    if (!full.ok) {
      console.error(`  ❌ failed: ${full.error}`);
      results.models[m] = { full, ind002: null };
      continue;
    }
    console.log(`  ✅ ${full.summary.clusters} clusters / ${full.summary.assigned} assigned / ${full.summary.unassigned} unassigned / ${(full.wallMs / 1000).toFixed(1)}s wall`);

    if (ind002Words.length) {
      console.log(`  [2/2] ind-002 sub-cluster (${ind002Words.length} words)...`);
      const ind = runOllamaCluster(m, ind002Words, `ind002-${m.replace(/[:/]/g, '_')}`);
      if (!ind.ok) {
        console.error(`  ❌ ind-002 failed: ${ind.error}`);
        results.models[m] = { full, ind002: ind };
      } else {
        console.log(`  ✅ ${ind.summary.clusters} sub-clusters / ${ind.summary.assigned} assigned / ${(ind.wallMs / 1000).toFixed(1)}s wall`);
        results.models[m] = { full, ind002: ind };
      }
    } else {
      results.models[m] = { full, ind002: null };
    }
  }

  // Write JSON
  const jsonPath = join(REPO, '.gg-cache', 'benchmark', `embedding-${new Date().toISOString().slice(0, 10)}.json`);
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  console.log(`\n💾 raw JSON: ${jsonPath}`);

  // Write markdown
  const lines = [];
  lines.push(`---`);
  lines.push(`title: Ollama Embedding Model Benchmark — astrology SEO clustering`);
  lines.push(`date: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`type: benchmark`);
  lines.push(`---`);
  lines.push('');
  lines.push(`# Embedding Benchmark — ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(`**Setup**: ${MODELS.length} models × ${allWords.length} keywords (R=⚡快速胜利+📌长尾)`);
  lines.push(`**Threshold**: cosine distance ${COSINE_THRESHOLD}`);
  lines.push(`**Algorithm**: average-linkage agglomerative, pure JS`);
  lines.push(`**Backend**: ollama @ ${OLLAMA_HOST} (local, $0 cost)`);
  lines.push('');
  lines.push(`## 1. Full corpus (${allWords.length} words)`);
  lines.push('');
  lines.push(`| Model | Clusters | Assigned | Unassigned | Singletons (filtered) | Wall (s) | Embed (s) |`);
  lines.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
  for (const m of MODELS) {
    const r = results.models[m]?.full;
    if (!r || !r.ok) {
      lines.push(`| \`${m}\` | ❌ | — | — | — | — | — |`);
      continue;
    }
    const s = r.summary; const i = r.initial; const e = r.embed;
    const singletons = i && s ? (i.raw_incl_singletons - s.clusters) : '—';
    lines.push(`| \`${m}\` | ${s.clusters} | ${s.assigned} | ${s.unassigned} | ${singletons} | ${(r.wallMs / 1000).toFixed(1)} | ${(e.embed_ms / 1000).toFixed(2)} |`);
  }
  lines.push('');
  if (ind002Words.length) {
    lines.push(`## 2. ind-002 heterogeneous bucket (${ind002Words.length} words)`);
    lines.push('');
    lines.push(`**Goal**: split the astrology "其它" bucket into ≥3 semantic sub-clusters. Token-mode is at ceiling (1 cluster only).`);
    lines.push('');
    lines.push(`| Model | Sub-clusters | Assigned | Unassigned | Wall (s) |`);
    lines.push(`| --- | ---: | ---: | ---: | ---: |`);
    for (const m of MODELS) {
      const r = results.models[m]?.ind002;
      if (!r || !r.ok) { lines.push(`| \`${m}\` | ❌ | — | — | — |`); continue; }
      const s = r.summary;
      lines.push(`| \`${m}\` | ${s.clusters} | ${s.assigned} | ${s.unassigned} | ${(r.wallMs / 1000).toFixed(1)} |`);
    }
    lines.push('');
  }
  lines.push(`## 3. Recommendation`);
  lines.push('');
  // Pick winner: weighted multi-dim score (no longer just ind-002 cluster count)
  //   coverage      (assigned/input)         × 50    largest weight — direct production value
  //   sub-split     ind-002 sub-clusters     × 5     algorithm quality on hardest input
  //   anti-noise    -unassigned/input        × 30    less unassigned = better recall
  //   speed_bonus   wall < 5s → +2           × 1     tie-break preference for fast
  const scored = MODELS.map((m) => {
    const r = results.models[m];
    if (!r?.full?.ok) return { m, score: -1, breakdown: 'failed' };
    const s = r.full.summary;
    const coverage = s.assigned / Math.max(1, s.input);                            // 0..1
    const antiNoise = -s.unassigned / Math.max(1, s.input);                        // -1..0
    const subSplit = r.ind002?.ok ? r.ind002.summary.clusters : 0;
    const speedBonus = r.full.wallMs < 5000 ? 1 : 0;
    const score = coverage * 50 + antiNoise * 30 + subSplit * 5 + speedBonus * 2;
    return {
      m, score,
      breakdown: `coverage=${(coverage * 50).toFixed(1)} anti-noise=${(antiNoise * 30).toFixed(1)} ind002=${(subSplit * 5).toFixed(1)} speed=${speedBonus * 2}`,
    };
  }).sort((a, b) => b.score - a.score);
  const winner = scored[0];
  lines.push(`Selected winner: **\`${winner.m}\`** (score=${winner.score.toFixed(1)} = ${winner.breakdown}).`);
  lines.push('');
  lines.push(`All models ranked by score:`);
  for (const s of scored) {
    lines.push(`- \`${s.m}\`: **${s.score.toFixed(1)}**  (${s.breakdown})`);
  }
  lines.push('');
  lines.push(`Run real re-cluster: \`node tools/scripts/gg-cluster-init.mjs --algo embedding --embed-backend ollama --embed-model ${winner.m} --rebuild --write\``);
  lines.push('');

  mkdirSync(dirname(OUT_DOC), { recursive: true });
  writeFileSync(OUT_DOC, lines.join('\n'));
  console.log(`\n📄 markdown: ${OUT_DOC}`);
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Winner: ${winner.m}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
