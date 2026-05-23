#!/usr/bin/env node
// gg-cluster-fields-suggest.mjs — LLM 起草 6 业务字段（主题集群表 Stage 5 加速器）
//
// 主题集群表 24 publishable units × 6 字段 = 144 cells 人工填。本工具用 LLM 出
// 初稿（每集群 <$0.05），wzb 只需 review/accept。失败时回落到确定性 heuristic，
// 不会 crash。
//
// 6 字段：C=track / G=jtbd / H=content_angle / O=cta_primary / Q=priority / R=week
//
// 写盘策略（安全顺序）：
//   --dry-run        只打印，不落盘
//   --write-file     默认；落到 .gg-cache/cluster-fields-suggestions.json
//   --write-sheet    显式同意才落到 sheet 列 T（20 列，header 只用到 S，T 空闲）
//
// LLM（frontier-only，见 docs/OPS_OVERVIEW.md）：
//   --llm hermes (默认) → _call-hermes.mjs --model anthropic/claude-opus-4
//   --llm claude        → claude -p --model claude-opus-4-7
//   --llm codex         → codex exec -c model="gpt-5.5"
//
// env: GG_SHEETS_FLOW_MVP_WORKBOOK_ID, ~/.config/gg/gg-writer-sa.json,
//      OPENROUTER_API_KEY (only for --llm hermes)

import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { getAccessToken, gFetch, loadEnv } from './lib/gg-shared.mjs';

// ---- CLI ----
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f, def = null) => (has(f) ? argv[argv.indexOf(f) + 1] : def);

if (has('--help') || has('-h')) {
  console.log(`gg-cluster-fields-suggest.mjs — LLM 起草 6 业务字段（C/G/H/O/Q/R）

flags:
  --cluster <id>     仅处理一个 cluster（如 fam-aura）。默认全表
  --llm <name>       hermes (默认) | claude | codex
  --dry-run          只打印，不落任何盘（覆盖 --write-*）
  --write-file       落 .gg-cache/cluster-fields-suggestions.json（默认）
  --write-sheet      落 sheet 列 T（需显式同意；默认 OFF）
  --workbook X       flow-mvp (默认) | <sheet-id>
  --max-keywords N   prompt 里塞的关键词上限（默认 20）
  --help / -h        本帮助
`);
  process.exit(0);
}

const TARGET_CLUSTER = arg('--cluster', null);
const LLM = (arg('--llm', 'hermes') || 'hermes').toLowerCase();
const DRY = has('--dry-run');
const WRITE_SHEET = has('--write-sheet') && !DRY;
const WRITE_FILE = (has('--write-file') || !WRITE_SHEET) && !DRY; // default
const WORKBOOK = arg('--workbook', 'flow-mvp');
const MAX_KEYWORDS = parseInt(arg('--max-keywords', '20'), 10);

if (!['hermes', 'claude', 'codex'].includes(LLM)) {
  console.error(`ERR: unknown --llm "${LLM}" (use hermes|claude|codex)`);
  process.exit(2);
}

// ---- constants (heuristic hints + family descriptions) ----
const FAMILY_DESCRIPTIONS = {
  'fam-aura': '🌈 Aura Family — pillar + 8 颜色子页（green/purple/orange/red/white/blue/yellow + reading/quiz/test）',
  'fam-birth-chart': '📋 Birth Chart Calculator Family — 工具页防御 pillar + Vedic/Sidereal/Tropical/Starseed/Twin Flame 变体',
  'fam-lunar-nodes': '🌗 Lunar Nodes Family — North + South Node pillar + 12 sign 子页 = 24 篇 series',
  'fam-vedic': '🕉 Vedic Astrology Family — Vedic Astrology Complete Guide + sidereal + nakshatra 引流',
  'fam-nakshatra': '⭐ 27 Nakshatras Family — Index pillar + 27 子页',
  'fam-houses': '🏛 Astrological Houses Family — pillar + 12 house 子页',
};

// CLUSTER_AUDIT §四 P0 list (multi-LLM consensus)
const P0_FAMILIES = new Set([
  'fam-aura', 'fam-lunar-nodes', 'fam-birth-chart', 'fam-houses', 'fam-nakshatra', 'fam-vedic',
]);
const P0_KEYWORD_HINTS = ['aura', 'lunar', 'north node', 'south node', 'birth chart', 'natal', 'hsp', 'highly sensitive', 'past life', 'full moon', 'pisces'];

// Allowed values (must match _workbook-spec.mjs data validations)
const ALLOWED_TRACK = ['量产线', '精修线'];
const ALLOWED_CTA = ['Newsletter', '工具页', '星盘页', '注册'];
const ALLOWED_PRIORITY = ['P0', 'P1', 'P2'];
const ALLOWED_WEEK = ['Week 1', 'Week 2', 'Week 3', 'Backlog'];

// ---- sheet io ----
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

function resolveSid() {
  if (WORKBOOK === 'flow-mvp') return process.env.GG_SHEETS_FLOW_MVP_WORKBOOK_ID;
  if (WORKBOOK === 'legacy') return process.env.GG_SHEETS_WORKBOOK_ID;
  return WORKBOOK;
}

// ---- LLM call ----
function buildPrompt({ cluster_id, cluster_name, keywords }) {
  const famHint = FAMILY_DESCRIPTIONS[cluster_id]
    ? `\nFamily pattern hint: ${FAMILY_DESCRIPTIONS[cluster_id]}\n`
    : '';
  const sample = keywords.slice(0, MAX_KEYWORDS).map((k) => `- ${k}`).join('\n');
  return `You are an SEO program manager for astrologywiki.com. Suggest the 6 business
fields for one keyword cluster. Respond with a single fenced \`\`\`json block, nothing else.

Cluster: ${cluster_id} — ${cluster_name}
Keyword count: ${keywords.length}${famHint}
Top keywords (up to ${MAX_KEYWORDS}):
${sample}

Field rules (pick EXACTLY one allowed value per enum field; free-text for jtbd & content_angle):
  track         : one of ${JSON.stringify(ALLOWED_TRACK)}  (量产线 if ≥10 templatable kws; 精修线 if needs differentiated angle)
  jtbd          : free-text Chinese, 1 sentence ("用户带着什么任务来 X")
  content_angle : free-text Chinese, 1 sentence (精修线必填差异化角度；量产线 "模板默认")
  cta_primary   : one of ${JSON.stringify(ALLOWED_CTA)}  (Newsletter: aura/full-moon/lunar; 工具页/星盘页: birth-chart; 注册: quiz/past-life/HSP)
  priority      : one of ${JSON.stringify(ALLOWED_PRIORITY)}  (P0 if family >40 kws or in [aura/lunar-nodes/birth-chart/HSP/past-life/full-moon/pisces-transit])
  week          : one of ${JSON.stringify(ALLOWED_WEEK)}  (P0→Week 1; high P1→Week 2; low P1→Week 3; P2→Backlog)

Also include: confidence ("high"|"medium"|"low") and rationale (1 short Chinese sentence — why).

Example:
\`\`\`json
{"track":"量产线","jtbd":"用户想知道自己 aura 颜色含义并做情绪映射","content_angle":"8 颜色 pillar+子页，每页配 color quiz","cta_primary":"Newsletter","priority":"P0","week":"Week 1","confidence":"high","rationale":"高频族群，pillar+series 模板友好"}
\`\`\``;
}

function modelIdFor(llm) {
  if (llm === 'hermes') return 'anthropic/claude-opus-4';
  if (llm === 'claude') return 'claude-opus-4-7';
  if (llm === 'codex') return 'gpt-5.5';
  return llm;
}

function runOrThrow(label, cmd, args, opts) {
  const r = spawnSync(cmd, args, opts);
  if (r.status !== 0) throw new Error(`${label} exit ${r.status}: ${(r.stderr || '').slice(0, 300)}`);
  return r.stdout;
}

function callLlm({ llm, prompt }) {
  const cacheDir = join(process.cwd(), '.gg-cache', 'cluster-fields-prompts');
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const promptPath = join(cacheDir, `prompt-${Date.now().toString(36)}.md`);
  writeFileSync(promptPath, prompt);
  if (llm === 'hermes') {
    const hermesScript = join(dirname(fileURLToPath(import.meta.url)), '_call-hermes.mjs');
    return runOrThrow('hermes', 'node',
      [hermesScript, '--prompt', promptPath, '--model', modelIdFor('hermes'), '--max-tokens', '1200', '--temperature', '0.4'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }
  if (llm === 'claude') {
    return runOrThrow('claude', 'claude', ['-p', '--model', modelIdFor('claude')],
      { input: prompt, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  }
  if (llm === 'codex') {
    return runOrThrow('codex', 'codex',
      ['exec', '-c', `model="${modelIdFor('codex')}"`, '-c', 'model_reasoning_effort="high"', '-'],
      { input: prompt, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  }
  throw new Error(`unsupported llm: ${llm}`);
}

function parseLlmJson(text) {
  if (!text) throw new Error('empty LLM output');
  // Strict: prefer ```json fenced block; tolerate plain ``` and bare JSON.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  // Trim leading text before first {.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('no JSON object found in LLM output');
  return JSON.parse(raw.slice(start, end + 1));
}

// ---- deterministic fallback (used when LLM call/parse fails) ----
function heuristicSuggestion({ cluster_id, cluster_name, keywords }) {
  const cid = (cluster_id || '').toLowerCase();
  const n = keywords.length;
  const hay = ((cluster_name || '') + ' ' + keywords.slice(0, 30).join(' ')).toLowerCase();
  let priority = 'P2';
  if (P0_FAMILIES.has(cid) || n > 40 || P0_KEYWORD_HINTS.some((k) => hay.includes(k))) priority = 'P0';
  else if (n >= 5) priority = 'P1';
  const track = n >= 10 ? '量产线' : '精修线';
  // Order matters: more specific routes first; newsletter-anchor families before generic quiz/test catch.
  let cta = 'Newsletter';
  if (/aura|full\s*moon|lunar|north node|south node/.test(hay)) cta = 'Newsletter';
  else if (/birth\s*chart|natal|calculator|astro.?seek|chani/.test(hay)) cta = '工具页';
  else if (/past\s*life|highly\s*sensitive|\bhsp\b|shadow|quiz|test|reading/.test(hay)) cta = '注册';
  else if (/birth|natal|chart/.test(hay)) cta = '星盘页';
  const week = priority === 'P0' ? 'Week 1' : priority === 'P1' ? 'Week 2' : 'Backlog';
  const angle = track === '量产线'
    ? `模板默认（pillar + series），共 ${n} 词覆盖`
    : `差异化角度：用 ${cluster_name} 反思情绪/关系模式（精修线）`;
  return {
    track,
    jtbd: `用户带着 "${cluster_name}" 相关任务来，想理解含义或查询自己的 ${cluster_name}`,
    content_angle: angle,
    cta_primary: cta,
    priority,
    week,
    confidence: 'low',
    rationale: 'heuristic fallback — LLM unavailable',
  };
}

// ---- normalize / validate against sheet enums ----
function pickAllowed(value, allowed, fallback) {
  if (!value) return fallback;
  const v = String(value).trim();
  if (allowed.includes(v)) return v;
  // case-insensitive + loose match
  const lower = v.toLowerCase();
  for (const a of allowed) if (a.toLowerCase() === lower) return a;
  // partial keyword match (e.g. LLM returns "newsletter" lowercase, or "Week1")
  for (const a of allowed) if (lower.replace(/\s+/g, '') === a.toLowerCase().replace(/\s+/g, '')) return a;
  return fallback;
}

function normalize(s, heuristic) {
  return {
    track: pickAllowed(s.track, ALLOWED_TRACK, heuristic.track),
    jtbd: String(s.jtbd || heuristic.jtbd).trim().slice(0, 500),
    content_angle: String(s.content_angle || heuristic.content_angle).trim().slice(0, 500),
    cta_primary: pickAllowed(s.cta_primary, ALLOWED_CTA, heuristic.cta_primary),
    priority: pickAllowed(s.priority, ALLOWED_PRIORITY, heuristic.priority),
    week: pickAllowed(s.week, ALLOWED_WEEK, heuristic.week),
  };
}

// ---- main ----
async function main() {
  loadEnv();
  const sid = resolveSid();
  if (!sid) {
    console.error(`ERR: workbook "${WORKBOOK}" — set GG_SHEETS_FLOW_MVP_WORKBOOK_ID or pass --workbook <id>`);
    process.exit(2);
  }
  const sa = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
  if (!existsSync(sa)) {
    console.error(`ERR: writer SA not found: ${sa}`);
    process.exit(2);
  }
  const { token } = await getAccessToken(sa, ['https://www.googleapis.com/auth/spreadsheets']);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Workbook : ${WORKBOOK} (${sid.slice(0, 12)}…)`);
  console.log(`LLM      : ${LLM} (${modelIdFor(LLM)})`);
  console.log(`Target   : ${TARGET_CLUSTER || '<all clusters>'}`);
  console.log(`Mode     : ${DRY ? 'DRY-RUN' : WRITE_SHEET ? 'WRITE-SHEET (col T)' : 'WRITE-FILE (.gg-cache)'}`);
  console.log('');

  // 1. read clusters A=id, B=name, L=keywords (col index 0/1/11)
  const rows = await fetchValues(token, sid, '主题集群表!A2:L1500');
  const clusters = rows
    .filter((r) => (r[0] || '').toString().trim())
    .map((r) => ({
      cluster_id: (r[0] || '').toString().trim(),
      cluster_name: (r[1] || '').toString().trim(),
      keywords: (r[11] || '').toString().split(/\n+/).map((s) => s.trim()).filter(Boolean),
    }));
  console.log(`总集群数: ${clusters.length}`);

  const targets = TARGET_CLUSTER ? clusters.filter((c) => c.cluster_id === TARGET_CLUSTER) : clusters;
  if (TARGET_CLUSTER && targets.length === 0) {
    console.error(`ERR: cluster "${TARGET_CLUSTER}" not found on sheet.`);
    process.exit(3);
  }
  console.log(`待处理   : ${targets.length}\n`);

  // 2. per-cluster: prompt → LLM → parse → normalize (heuristic fallback on any failure)
  const results = [];
  for (let i = 0; i < targets.length; i++) {
    const c = targets[i];
    process.stdout.write(`[${i + 1}/${targets.length}] ${c.cluster_id}  ${c.cluster_name.padEnd(32)} `);
    const heuristic = heuristicSuggestion(c);
    let llmErr = null, parsed = null, usedLlm = LLM;
    try {
      parsed = parseLlmJson(callLlm({ llm: LLM, prompt: buildPrompt(c) }));
      process.stdout.write('LLM ✓\n');
    } catch (e) {
      llmErr = e.message;
      usedLlm = `${LLM}+fallback`;
      process.stdout.write(`LLM ✗ (${e.message.slice(0, 60)}) — heuristic\n`);
      parsed = { ...heuristic };
    }
    results.push({
      cluster_id: c.cluster_id,
      cluster_name: c.cluster_name,
      keyword_count: c.keywords.length,
      suggestions: normalize(parsed, heuristic),
      llm: usedLlm,
      model: llmErr ? null : modelIdFor(LLM),
      confidence: String(parsed.confidence || heuristic.confidence || 'low').toLowerCase(),
      rationale: String(parsed.rationale || heuristic.rationale || '').slice(0, 240),
      llm_error: llmErr,
      generated_at: new Date().toISOString(),
    });
  }

  // 3. print summary
  console.log('\n━━━ 建议预览 ━━━');
  for (const r of results.slice(0, 5)) {
    console.log(`\n${r.cluster_id}  ${r.cluster_name}  (${r.keyword_count} 词, conf=${r.confidence})`);
    console.log(`  track        : ${r.suggestions.track}`);
    console.log(`  jtbd         : ${r.suggestions.jtbd}`);
    console.log(`  content_angle: ${r.suggestions.content_angle}`);
    console.log(`  cta_primary  : ${r.suggestions.cta_primary}`);
    console.log(`  priority     : ${r.suggestions.priority}`);
    console.log(`  week         : ${r.suggestions.week}`);
    console.log(`  rationale    : ${r.rationale}`);
  }
  if (results.length > 5) console.log(`  ... (+${results.length - 5} more)`);

  // 4. write
  if (DRY) {
    console.log('\nDRY-RUN: 无写入。加 --write-file（默认）或 --write-sheet 落盘。');
    return;
  }
  if (WRITE_FILE) {
    const outPath = join(process.cwd(), '.gg-cache', 'cluster-fields-suggestions.json');
    if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
    // Merge with existing file if present so partial runs accumulate.
    let merged = {};
    if (existsSync(outPath)) {
      try { merged = JSON.parse(readFileSync(outPath, 'utf8')); } catch { merged = {}; }
    }
    if (!merged.suggestions || typeof merged.suggestions !== 'object') merged.suggestions = {};
    for (const r of results) merged.suggestions[r.cluster_id] = r;
    merged.updated_at = new Date().toISOString();
    merged.workbook_id = sid;
    merged.llm = LLM;
    writeFileSync(outPath, JSON.stringify(merged, null, 2));
    const stat = JSON.stringify(merged, null, 2).length;
    console.log(`\n✓ WRITE-FILE → ${outPath}  (${stat} bytes, ${Object.keys(merged.suggestions).length} clusters total)`);
    console.log('  Review the JSON, then run with --write-sheet to push to col T,');
    console.log('  or manually copy values into 主题集群表 cols C/G/H/O/Q/R.');
  }
  if (WRITE_SHEET) {
    // Build full-table writes: one row per target cluster, col T only.
    // We must know the row number of each cluster — re-read col A to map id→row.
    const aCol = await fetchValues(token, sid, '主题集群表!A2:A1500');
    const idToRow = new Map();
    for (let i = 0; i < aCol.length; i++) {
      const id = (aCol[i][0] || '').toString().trim();
      if (id) idToRow.set(id, i + 2); // sheet row (1-indexed, +1 for header)
    }
    let wrote = 0;
    for (const r of results) {
      const row = idToRow.get(r.cluster_id);
      if (!row) {
        console.warn(`  ⚠ ${r.cluster_id}: not found in col A — skip`);
        continue;
      }
      const blob = JSON.stringify({
        suggestions: r.suggestions,
        llm: r.llm,
        confidence: r.confidence,
        rationale: r.rationale,
        generated_at: r.generated_at,
      });
      await updateValues(token, sid, `主题集群表!T${row}:T${row}`, [[blob]]);
      wrote++;
    }
    console.log(`\n✓ WRITE-SHEET → 主题集群表!T (${wrote}/${results.length} rows)`);
    console.log(`  Open: https://docs.google.com/spreadsheets/d/${sid}/edit`);
  }
}

// Run only when invoked directly (so unit tests can import helpers).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('FATAL:', e.message);
    process.exit(1);
  });
}

export {
  buildPrompt, parseLlmJson, heuristicSuggestion, normalize, pickAllowed, modelIdFor,
  ALLOWED_TRACK, ALLOWED_CTA, ALLOWED_PRIORITY, ALLOWED_WEEK, FAMILY_DESCRIPTIONS,
};
