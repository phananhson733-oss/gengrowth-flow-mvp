#!/usr/bin/env node
// gg-status.mjs — scan all pipeline artifacts (.gg-cache / _staging) and the Sheet,
// emit one row per page covering candidate → approve → promote → brief → render → phase2 → publish.
//
// Modes:
//   --md         print a markdown table to stdout (default)
//   --sheet      write rows to GG_SHEETS_FLOW_MVP_WORKBOOK_ID `pipeline-status` + `publish-log` + `quality-metrics`
//   --html       write docs/dashboard.html
//   --page <id>  filter to a single page_id
//
// Read-only on local filesystem. Writes Sheet only when --sheet given.
//
// Sheet env:
//   GG_SHEETS_FLOW_MVP_WORKBOOK_ID (new v8 workbook)
//   GG_WRITER_SA_JSON (default ~/.config/gg/gg-writer-sa.json)

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadEnv, getAccessToken, gFetch } from './lib/gg-shared.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = join(REPO, '.gg-cache');
const STAGING = join(REPO, '_staging');

function parseArgs(argv) {
  const out = { md: false, sheet: false, html: false, page: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--md') out.md = true;
    else if (a === '--sheet') out.sheet = true;
    else if (a === '--html') out.html = true;
    else if (a === '--page') { out.page = argv[++i]; }
    else if (a === '--help' || a === '-h') { out.help = true; }
  }
  if (!out.md && !out.sheet && !out.html) out.md = true;
  return out;
}

function help() {
  process.stdout.write(`gg-status — scan pipeline artifacts + emit per-page status

usage:
  node tools/scripts/gg-status.mjs                  # markdown table to stdout
  node tools/scripts/gg-status.mjs --html           # docs/dashboard.html
  node tools/scripts/gg-status.mjs --sheet          # write to Sheet (needs SA + new workbook ID)
  node tools/scripts/gg-status.mjs --md --html --sheet  # do all three
  node tools/scripts/gg-status.mjs --page page_X    # one page only

env (--sheet only):
  GG_SHEETS_FLOW_MVP_WORKBOOK_ID
  GG_WRITER_SA_JSON  (default ~/.config/gg/gg-writer-sa.json)
`);
}

// ---------- local scan ----------
function safeReadJson(p) {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function safeStat(p) {
  try { return statSync(p); } catch { return null; }
}

function scanLocalPages() {
  // Discover page_ids from .gg-cache/<page_id>/ subdirs + _staging/<page_id>-<llm>-v<version>.md
  const pages = new Map();

  // From RAG dirs
  if (existsSync(CACHE)) {
    for (const name of readdirSync(CACHE)) {
      if (name.startsWith('page_') && safeStat(join(CACHE, name))?.isDirectory()) {
        pages.set(name, pages.get(name) || makeRow(name));
      }
    }
  }

  // From _staging md files: pattern <page_id>-<llm>-v<n>.md (also -v<n>-<tag>.md)
  if (existsSync(STAGING)) {
    for (const fn of readdirSync(STAGING)) {
      const m = fn.match(/^(page_[A-Za-z0-9_-]+?)-([a-z]+)-v(\d+)(?:-([a-z0-9-]+))?\.md$/);
      if (!m) continue;
      const [, pid, llm, version] = m;
      const row = pages.get(pid) || makeRow(pid);
      row.rendered_llms.add(llm);
      row.versions.add(`v${version}`);
      pages.set(pid, row);
    }
  }

  // Decorate every page with paths
  for (const [pid, row] of pages) {
    row.override_path = findOverridePath(pid);
    row.batch_path = findBatchPath(pid);
    row.rag_entity = existsSync(join(CACHE, pid, 'entity-passport.rag.json')) ? join('.gg-cache', pid, 'entity-passport.rag.json') : '';
    row.rag_obsidian = existsSync(join(CACHE, pid, 'obsidian-rag.json')) ? join('.gg-cache', pid, 'obsidian-rag.json') : '';
    // friction-mine is real only if has themes && !_synth marker
    const frictionPath = join(CACHE, pid, 'friction-mine.rag.json');
    const fr = safeReadJson(frictionPath);
    row.rag_friction_real = fr && Array.isArray(fr.themes) && fr.themes.length && !fr._synth ? 'real' : (fr ? 'synth' : '');
    row.prompt_path = existsSync(join(CACHE, 'prompts', `${pid}.v8-prompt.md`)) ? join('.gg-cache', 'prompts', `${pid}.v8-prompt.md`) : '';
    row.prompt_size = row.prompt_path ? safeStat(join(REPO, row.prompt_path))?.size || 0 : 0;
    // phase2 status: latest manifest among llm variants
    row.phase2_status = computePhase2Status(pid);
  }

  return [...pages.values()];
}

function makeRow(page_id) {
  return {
    page_id,
    target_keyword: '',
    cluster_id: '',
    tier: '',
    template: '',
    candidate_in_sheet: '',
    approved: '',
    promoted: '',
    brief_filled: '',
    override_path: '',
    batch_path: '',
    rag_entity: '',
    rag_obsidian: '',
    rag_friction_real: '',
    prompt_path: '',
    prompt_size: 0,
    rendered_llms: new Set(),
    versions: new Set(),
    phase2_status: '',
    wiki_published_path: '',
    commit_hash: '',
    last_updated: new Date().toISOString().slice(0, 19) + 'Z',
  };
}

function findOverridePath(page_id) {
  const dir = join(CACHE, 'overrides');
  if (!existsSync(dir)) return '';
  for (const fn of readdirSync(dir)) {
    if (!fn.endsWith('.json')) continue;
    const j = safeReadJson(join(dir, fn));
    if (j && (j[page_id] || (j._source && JSON.stringify(j).includes(page_id)))) {
      return join('.gg-cache', 'overrides', fn);
    }
  }
  return '';
}

function findBatchPath(page_id) {
  const dir = join(CACHE, 'batches');
  if (!existsSync(dir)) return '';
  for (const fn of readdirSync(dir)) {
    if (!fn.endsWith('.json')) continue;
    const j = safeReadJson(join(dir, fn));
    if (j && Array.isArray(j.rows) && j.rows.some((r) => r.page_id === page_id)) {
      return join('.gg-cache', 'batches', fn);
    }
  }
  return '';
}

function computePhase2Status(page_id) {
  if (!existsSync(STAGING)) return '';
  const passes = [];
  const fails = [];
  for (const fn of readdirSync(STAGING)) {
    const m = fn.match(/^(page_[A-Za-z0-9_-]+?)-([a-z]+)-v\d+.*\.manifest\.json$/);
    if (!m || m[1] !== page_id) continue;
    const j = safeReadJson(join(STAGING, fn));
    if (!j) continue;
    const status = j.phase2_checks?.overall || 'unknown';
    (status === 'pass' ? passes : fails).push(`${m[2]}:${status}`);
  }
  if (!passes.length && !fails.length) return '';
  return [...passes, ...fails].join(', ');
}

// ---------- decorate with Sheet data ----------
async function decorateFromSheet(rows, opts) {
  const wb = opts.wb || process.env.GG_SHEETS_FLOW_MVP_WORKBOOK_ID;
  if (!wb) return rows;
  const saPath = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
  if (!existsSync(saPath)) return rows;
  let token;
  try {
    ({ token } = await getAccessToken(saPath, ['https://www.googleapis.com/auth/spreadsheets']));
  } catch {
    return rows;
  }

  // Pull 选题登记表 A1:U400 (v8 21-col schema)
  let pagesRaw = { values: [] };
  try {
    pagesRaw = await gFetch(`https://sheets.googleapis.com/v4/spreadsheets/${wb}/values/${encodeURIComponent('选题登记表!A1:U500')}?majorDimension=ROWS`, token);
  } catch {}
  const pagesRows = (pagesRaw.values || []).slice(1);
  // index page_id (col P = idx 15) → row obj
  const byPid = new Map();
  for (const r of pagesRows) {
    const pid = String(r[15] || '').trim();
    if (pid) byPid.set(pid, r);
  }
  // Also map target_keyword → row (for pages that haven't got page_id yet)
  const byKw = new Map();
  for (const r of pagesRows) {
    const kw = String(r[0] || '').trim().toLowerCase();
    if (kw && !byPid.has(String(r[15] || '').trim())) byKw.set(kw, r);
  }

  // Pull keyword_candidates A1:K100
  let candRaw = { values: [] };
  try {
    candRaw = await gFetch(`https://sheets.googleapis.com/v4/spreadsheets/${wb}/values/${encodeURIComponent('keyword_candidates!A1:K500')}?majorDimension=ROWS`, token);
  } catch {}
  const candRows = (candRaw.values || []).slice(1);
  const candByQuery = new Map();
  for (const r of candRows) {
    const q = String(r[2] || '').trim().toLowerCase();
    if (q) candByQuery.set(q, r);
  }

  for (const row of rows) {
    const p = byPid.get(row.page_id);
    if (p) {
      row.target_keyword = String(p[0] || '');
      row.tier = String(p[5] || '');
      row.template = String(p[6] || '');
      row.cluster_id = String(p[16] || '');
      // brief_filled: F (Tier) + G (Template) + H (Entity) + Q (cluster_id) + R (page_role) all non-empty
      const required = [p[5], p[6], p[7], p[16], p[17]];
      row.brief_filled = required.every((v) => String(v || '').trim()) ? 'Y' : 'N';
      row.promoted = 'Y';
    }
    // Match candidate by target_keyword
    if (row.target_keyword) {
      const cand = candByQuery.get(row.target_keyword.toLowerCase());
      if (cand) {
        row.candidate_in_sheet = 'Y';
        row.approved = (String(cand[10] || '').trim() === 'Y') ? 'Y' : 'N';
      }
    }
  }

  return rows;
}

// ---------- wiki/git decoration ----------
function decorateWikiPublish(rows) {
  const wikiProd = '/Users/wzb/gengrowth-wiki/内容资产/astrologywiki';
  if (!existsSync(wikiProd)) return rows;
  // Build slug → page_id map from rows
  const slugByPid = new Map();
  for (const r of rows) slugByPid.set(r.page_id, r.page_id.replace(/^page_/, '').replace(/_/g, '-'));
  // Walk wiki dirs
  for (const batchDir of readdirSync(wikiProd)) {
    const full = join(wikiProd, batchDir);
    if (!safeStat(full)?.isDirectory()) continue;
    for (const fn of readdirSync(full)) {
      if (!fn.endsWith('.md')) continue;
      for (const row of rows) {
        const slug = slugByPid.get(row.page_id);
        if (slug && fn.includes(slug)) {
          row.wiki_published_path = join('内容资产/astrologywiki', batchDir, fn);
          break;
        }
      }
    }
  }
  return rows;
}

// ---------- output: markdown ----------
function emitMarkdown(rows) {
  const cols = ['page_id', 'tier', 'template', 'approved', 'promoted', 'brief_filled', 'override', 'prompt', 'rendered', 'phase2', 'published'];
  const lines = [];
  lines.push(`# gengrowth-flow-mvp · pipeline status (${new Date().toISOString().slice(0, 19)}Z)`);
  lines.push('');
  lines.push(`Total pages tracked: **${rows.length}**`);
  lines.push('');
  lines.push('| ' + cols.join(' | ') + ' |');
  lines.push('|' + cols.map(() => '---').join('|') + '|');
  for (const r of rows) {
    const mark = (v) => v === 'Y' ? '✅' : v === 'N' ? '❌' : (v || '—');
    const yesno = (s) => s ? '✅' : '—';
    const phase2 = r.phase2_status || '—';
    lines.push('| ' + [
      r.page_id,
      r.tier || '—',
      r.template || '—',
      mark(r.approved),
      mark(r.promoted),
      mark(r.brief_filled),
      yesno(r.override_path),
      yesno(r.prompt_path),
      r.rendered_llms.size ? [...r.rendered_llms].join('/') : '—',
      phase2.length > 30 ? phase2.slice(0, 27) + '...' : phase2,
      r.wiki_published_path ? '✅' : '—',
    ].join(' | ') + ' |');
  }
  lines.push('');
  lines.push('Legend: ✅ done, ❌ blocked, — n/a/not started');
  lines.push('');
  lines.push('## Bottlenecks');
  const breakdowns = {
    'mine → approve': rows.filter((r) => r.candidate_in_sheet === 'Y' && r.approved === 'N').length,
    'approved → promote': rows.filter((r) => r.approved === 'Y' && !r.promoted).length,
    'promote → brief_fill': rows.filter((r) => r.promoted === 'Y' && r.brief_filled === 'N').length,
    'brief → bridge (override)': rows.filter((r) => r.brief_filled === 'Y' && !r.override_path).length,
    'bridge → render (prompt)': rows.filter((r) => r.override_path && !r.prompt_path).length,
    'render → LLM': rows.filter((r) => r.prompt_path && !r.rendered_llms.size).length,
    'LLM → phase2 PASS': rows.filter((r) => r.rendered_llms.size && !r.phase2_status.includes('pass')).length,
    'phase2 PASS → publish': rows.filter((r) => r.phase2_status.includes('pass') && !r.wiki_published_path).length,
  };
  for (const [k, n] of Object.entries(breakdowns)) {
    lines.push(`- ${k}: **${n}** page(s)`);
  }
  return lines.join('\n');
}

// ---------- output: html dashboard ----------
function emitHtml(rows) {
  const head = `<!doctype html><html><head><meta charset=utf8><title>flow-mvp dashboard</title><style>
body{font:14px -apple-system,sans-serif;margin:24px;color:#222}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border:1px solid #ddd;padding:6px 10px;text-align:left;vertical-align:top}
th{background:#f6f6f6;font-weight:600}
tr:nth-child(even){background:#fafafa}
.ok{color:#0a0} .bad{color:#c00} .na{color:#aaa}
code{font:12px ui-monospace,monospace;background:#f4f4f4;padding:1px 5px;border-radius:3px}
h1{font-size:18px} h2{font-size:15px;margin-top:24px}
</style></head><body>`;
  const tail = `</body></html>`;
  const stamp = new Date().toISOString().slice(0, 19) + 'Z';
  const cols = ['page_id', 'tier', 'tmpl', 'approved', 'promote', 'brief', 'override', 'prompt', 'rendered', 'phase2', 'published'];
  const rowsHtml = rows.map((r) => {
    const cell = (v, ok) => v ? `<span class=${ok ? 'ok' : 'bad'}>${v}</span>` : `<span class=na>—</span>`;
    return '<tr>' + [
      `<code>${r.page_id}</code>`,
      r.tier || '—',
      r.template || '—',
      cell(r.approved === 'Y' ? '✅' : r.approved === 'N' ? '❌' : '', r.approved === 'Y'),
      cell(r.promoted === 'Y' ? '✅' : '', true),
      cell(r.brief_filled === 'Y' ? '✅' : r.brief_filled === 'N' ? '❌' : '', r.brief_filled === 'Y'),
      r.override_path ? `<code>${basename(r.override_path)}</code>` : '—',
      r.prompt_path ? `<code>${basename(r.prompt_path)}</code> (${(r.prompt_size / 1024).toFixed(1)} KB)` : '—',
      r.rendered_llms.size ? [...r.rendered_llms].join(', ') : '—',
      cell(r.phase2_status || '', r.phase2_status.includes('pass')),
      r.wiki_published_path ? '✅' : '—',
    ].map((c) => `<td>${c}</td>`).join('') + '</tr>';
  }).join('\n');
  const breakdowns = {
    'mine → approve': rows.filter((r) => r.candidate_in_sheet === 'Y' && r.approved === 'N').length,
    'approved → promote': rows.filter((r) => r.approved === 'Y' && !r.promoted).length,
    'promote → brief_fill': rows.filter((r) => r.promoted === 'Y' && r.brief_filled === 'N').length,
    'brief → bridge (override)': rows.filter((r) => r.brief_filled === 'Y' && !r.override_path).length,
    'bridge → render (prompt)': rows.filter((r) => r.override_path && !r.prompt_path).length,
    'render → LLM': rows.filter((r) => r.prompt_path && !r.rendered_llms.size).length,
    'LLM → phase2 PASS': rows.filter((r) => r.rendered_llms.size && !r.phase2_status.includes('pass')).length,
    'phase2 PASS → publish': rows.filter((r) => r.phase2_status.includes('pass') && !r.wiki_published_path).length,
  };
  const bottleneckRows = Object.entries(breakdowns).map(([k, n]) => `<tr><td>${k}</td><td><strong>${n}</strong></td></tr>`).join('');
  return head + `
<h1>gengrowth-flow-mvp · pipeline status</h1>
<p>Generated ${stamp} · Total pages: <strong>${rows.length}</strong></p>
<h2>Per-page status</h2>
<table><thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>
${rowsHtml}
</tbody></table>
<h2>Bottlenecks (count of pages stuck at each transition)</h2>
<table><thead><tr><th>Transition</th><th>Pages stuck</th></tr></thead><tbody>${bottleneckRows}</tbody></table>
<p style="margin-top:24px;color:#888">Legend: ✅ done · ❌ explicitly blocked · — not started/n/a · paths are relative to repo root.</p>
` + tail;
}

// ---------- output: sheet ----------
async function emitSheet(rows) {
  const wb = process.env.GG_SHEETS_FLOW_MVP_WORKBOOK_ID;
  if (!wb) {
    console.error('GG_SHEETS_FLOW_MVP_WORKBOOK_ID not set — skipping --sheet');
    return;
  }
  const saPath = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
  const { token } = await getAccessToken(saPath, ['https://www.googleapis.com/auth/spreadsheets']);

  // Build pipeline-status rows in declared column order
  const dataRows = rows.map((r) => [
    r.page_id, r.target_keyword, r.cluster_id, r.tier, r.template,
    r.candidate_in_sheet, r.approved, r.promoted, r.brief_filled,
    r.override_path, r.batch_path,
    r.rag_entity, r.rag_obsidian, r.rag_friction_real,
    r.prompt_path,
    [...r.rendered_llms].join(','),
    r.phase2_status,
    r.wiki_published_path, r.commit_hash,
    r.last_updated,
  ]);

  // Wipe + rewrite pipeline-status (idempotent)
  await gFetch(`https://sheets.googleapis.com/v4/spreadsheets/${wb}/values/${encodeURIComponent('pipeline-status!A2:T1000')}:clear`, token, { method: 'POST' });
  if (dataRows.length) {
    await gFetch(`https://sheets.googleapis.com/v4/spreadsheets/${wb}/values/${encodeURIComponent('pipeline-status!A2')}?valueInputOption=RAW`, token, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: dataRows }),
    });
  }
  console.error(`  ✓ pipeline-status: wrote ${dataRows.length} rows`);

  // Append quality-metrics rows for any new phase2 manifest since last sync.
  // Read existing quality-metrics page_id+tag set to dedupe.
  let existing = new Set();
  try {
    const ex = await gFetch(`https://sheets.googleapis.com/v4/spreadsheets/${wb}/values/${encodeURIComponent('quality-metrics!A2:D1000')}?majorDimension=ROWS`, token);
    for (const r of ex.values || []) existing.add(`${r[1]}|${r[2]}|${r[3]}`); // page_id|llm|tag
  } catch {}

  const qmRows = [];
  if (existsSync(STAGING)) {
    for (const fn of readdirSync(STAGING)) {
      const m = fn.match(/^(page_[A-Za-z0-9_-]+?)-([a-z]+)-v\d+(?:-([a-z0-9-]+))?\.manifest\.json$/);
      if (!m) continue;
      const [, pid, llm, tag] = m;
      const tagVal = tag || 'default';
      const key = `${pid}|${llm}|${tagVal}`;
      if (existing.has(key)) continue;
      const mani = safeReadJson(join(STAGING, fn));
      if (!mani || !mani.phase2_checks) continue;
      const pc = mani.phase2_checks;
      qmRows.push([
        mani.generated_at || new Date().toISOString(),
        pid, llm, tagVal,
        pc.structure?.h2Count !== undefined ? 'Y' : '—',
        pc.rl1 === true ? 'Y' : (pc.rl1 === false ? 'N' : '—'),
        pc.rl2 === true ? 'Y' : (pc.rl2 === false ? 'N' : '—'),
        pc.rl3 === true ? 'Y' : (pc.rl3 === false ? 'N' : '—'),
        pc.rl4 === true ? 'Y' : (pc.rl4 === false ? 'N' : '—'),
        pc.rl5 === true ? 'Y' : (pc.rl5 === false ? 'N' : '—'),
        pc.rl6 === true ? 'Y' : (pc.rl6 === false ? 'N' : '—'),
        pc.overall || '',
        pc.structure?.words || '',
        '', '', // rl4_drifted, rl5_count (not in manifest yet)
      ]);
    }
  }
  if (qmRows.length) {
    await gFetch(`https://sheets.googleapis.com/v4/spreadsheets/${wb}/values/${encodeURIComponent('quality-metrics!A:O')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: qmRows }),
    });
  }
  console.error(`  ✓ quality-metrics: appended ${qmRows.length} new rows`);

  // Publish-log: for every wiki_published row, if not already in log, append.
  let logExisting = new Set();
  try {
    const ex = await gFetch(`https://sheets.googleapis.com/v4/spreadsheets/${wb}/values/${encodeURIComponent('publish-log!A2:F500')}?majorDimension=ROWS`, token);
    for (const r of ex.values || []) logExisting.add(`${r[1]}|${r[2]}|${r[5]}`); // page_id|llm|wiki_path_prod
  } catch {}

  const plRows = [];
  for (const r of rows) {
    if (!r.wiki_published_path) continue;
    for (const llm of r.rendered_llms) {
      const slug = r.page_id.replace(/^page_/, '').replace(/_/g, '-');
      if (!r.wiki_published_path.includes(`${slug}-${llm}`)) continue;
      const key = `${r.page_id}|${llm}|${r.wiki_published_path}`;
      if (logExisting.has(key)) continue;
      plRows.push([
        r.last_updated, r.page_id, llm, r.tier, r.template,
        r.wiki_published_path, '', '',
        r.phase2_status.split(',').map((s) => s.split(':')[1]).find((s) => s === 'pass') || '',
        '', '', '', 'gg-status auto',
      ]);
    }
  }
  if (plRows.length) {
    await gFetch(`https://sheets.googleapis.com/v4/spreadsheets/${wb}/values/${encodeURIComponent('publish-log!A:M')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: plRows }),
    });
  }
  console.error(`  ✓ publish-log: appended ${plRows.length} new rows`);
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { help(); return 0; }
  loadEnv();

  let rows = scanLocalPages();
  if (args.page) rows = rows.filter((r) => r.page_id === args.page);

  rows = await decorateFromSheet(rows, {});
  rows = decorateWikiPublish(rows);

  rows.sort((a, b) => a.page_id.localeCompare(b.page_id));

  if (args.md) process.stdout.write(emitMarkdown(rows) + '\n');
  if (args.html) {
    const outDir = join(REPO, 'docs');
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'dashboard.html'), emitHtml(rows));
    console.error(`  ✓ wrote docs/dashboard.html (${rows.length} pages)`);
  }
  if (args.sheet) await emitSheet(rows);

  return 0;
}

main().then((c) => process.exit(c || 0)).catch((e) => { console.error('ERR:', e.message); process.exit(1); });
