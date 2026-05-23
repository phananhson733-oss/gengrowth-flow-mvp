#!/usr/bin/env node
// gg-phase2-fix.mjs — Stage 13 auto-retry. Reads a FAIL manifest, templates
// fix instructions per failed RL, writes a retry prompt, optionally re-invokes
// gg-llm-orchestrator.mjs, re-runs _phase2-validate.mjs and reports the diff.
//
// Usage:
//   node tools/scripts/gg-phase2-fix.mjs --manifest <path>
//     [--llm claude|codex|hermes|gemini] [--dry-run] [--no-rerun]
//
// FRONTIER-ONLY: --llm one of claude/codex/hermes/gemini (default inferred
// from manifest.generated_by). SYNONYM DICT (RL5) below — extend by appending
// {head-noun: [synonyms...]} entries. Matching is "target_keyword contains key".

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkRL1,
  checkRL2,
  checkRL3,
  checkRL4,
  checkRL5,
  checkRL6,
} from './lib/red-lines.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');
const PROMPTS_DIR = join(REPO, '.gg-cache', 'prompts');
const SERP_DIR = join(REPO, '.gg-cache', 'serp');

// 30 head-noun → synonyms. Match: target_keyword contains key (lowercase).
const RL5_SYNONYMS = Object.freeze({
  aura: ['energy field', 'biofield', 'subtle body', 'energetic signature', 'personal field'],
  chakra: ['energy center', 'subtle center', 'vortex point', 'energy node'],
  zodiac: ['sun sign', 'astrological sign', 'birth sign', 'tropical sign'],
  horoscope: ['birth chart reading', 'astrological forecast', 'natal interpretation'],
  astrology: ['celestial study', 'star science', 'planetary symbolism', 'astrological tradition'],
  planet: ['celestial body', 'planetary archetype', 'transiting body'],
  moon: ['lunar archetype', 'lunar phase', 'Luna'],
  sun: ['solar archetype', 'solar self', 'core self'],
  rising: ['ascendant', 'first house cusp', 'rising sign'],
  ascendant: ['rising sign', 'first house cusp', 'social mask'],
  retrograde: ['apparent backward motion', 'reflective transit', 'review phase'],
  transit: ['planetary movement', 'current sky event', 'astrological cycle'],
  natal: ['birth-chart', 'birth-time', 'original chart'],
  cusp: ['sign threshold', 'boundary point', 'house edge'],
  house: ['life sector', 'area of experience', 'chart sector'],
  aspect: ['planetary angle', 'chart relationship', 'angular relationship'],
  conjunction: ['planetary merger', 'aligned aspect', 'fusion point'],
  saturn: ['Saturn archetype', 'the ringed planet', 'the karma teacher'],
  jupiter: ['Jupiter archetype', 'the expansive planet', 'the great benefic'],
  mercury: ['Mercury archetype', 'the messenger planet'],
  venus: ['Venus archetype', 'the planet of love'],
  mars: ['Mars archetype', 'the planet of action'],
  meaning: ['significance', 'interpretation', 'symbolism', 'what it represents'],
  personality: ['temperament', 'character pattern', 'archetypal traits', 'core nature'],
  return: ['cyclical return', 'returning transit', 'planetary homecoming'],
  spiritual: ['inner', 'soul-level', 'energetic', 'symbolic'],
  energy: ['vibrational quality', 'subtle current', 'flow', 'frequency'],
  color: ['hue', 'shade', 'chromatic tone', 'visual quality'],
  reading: ['interpretation', 'symbolic read', 'analysis'],
  sign: ['archetype', 'symbol', 'placement'],
});

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function fail(msg, code = 2) {
  process.stderr.write(`[phase2-fix] ERROR: ${msg}\n`);
  process.exit(code);
}

function usage() {
  process.stderr.write(`usage: gg-phase2-fix.mjs --manifest <path> [--llm claude|codex|hermes|gemini] [--dry-run] [--no-rerun]\n`);
}

function loadManifest(path) {
  if (!existsSync(path)) fail(`manifest not found: ${path}`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`manifest is not valid JSON (${err.message}): ${path}`);
  }
  if (!raw || typeof raw !== 'object') fail(`manifest root is not an object: ${path}`);
  for (const k of ['page_id', 'entity', 'target_keyword', 'template', 'source_path', 'phase2_checks']) {
    if (raw[k] === undefined) fail(`manifest missing field "${k}": ${path}`);
  }
  return raw;
}

function loadSerpCtx(pageId) {
  const p = join(SERP_DIR, `${pageId}.json`);
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    const snips = Array.isArray(raw.snippets) ? raw.snippets.filter((s) => typeof s === 'string' && s.length > 0) : [];
    return snips.length > 0
      ? { serpState: 'hit', snippets: snips, escapeReason: null }
      : { serpState: 'missing-skipped', snippets: [], escapeReason: 'cache present but empty' };
  } catch {
    return { serpState: 'missing-skipped', snippets: [], escapeReason: 'no cache' };
  }
}

// Strip YAML frontmatter — matches _phase2-validate.mjs.
function stripFrontmatter(text) {
  return text.startsWith('---\n') ? text.replace(/^---\n[\s\S]*?\n---\n+/, '') : text;
}

// Manifest only stores booleans — re-run checkers to get note strings for templating.
function recheckRedLines(draft, manifest) {
  const serpCtx = loadSerpCtx(manifest.page_id);
  // psych_safety_flag isn't always persisted to manifest; default 'N'.
  // The fixture sidecar (if present) is authoritative.
  const fixturePath = join(PROMPTS_DIR, `${manifest.page_id}.${manifest.prompt_version || 'v8'}-fixture.json`);
  let psychFlag = 'N';
  let kwMax = manifest.template === 'Pillar' ? 12 : 8;
  if (existsSync(fixturePath)) {
    try {
      const fx = JSON.parse(readFileSync(fixturePath, 'utf8'));
      const raw = String(fx.psych_safety || 'N').toUpperCase();
      psychFlag = (raw === 'Y' || raw === 'N') ? raw : 'N';
      if (Array.isArray(fx.kw_count_range)) kwMax = fx.kw_count_range[1];
    } catch { /* swallow; defaults used */ }
  }
  return {
    rl1: checkRL1(draft),
    rl2: checkRL2(draft),
    rl3: checkRL3(draft, serpCtx),
    rl4: checkRL4(draft, { targetKeyword: manifest.target_keyword, entity: manifest.entity }),
    rl5: checkRL5(draft, { targetKeyword: manifest.target_keyword, maxCount: kwMax }),
    rl6: checkRL6(draft, { effectivePsychSafety: psychFlag }),
  };
}

function snippetRL1(result) {
  const matched = (result.note || '').match(/matched: "([^"]+)"/)?.[1] || '(see check note)';
  return `**FIX RL1 (clinical claims)**: Remove ALL clinical/medical terminology. The phrase "${matched}" triggered the regex. Replace with experiential language — e.g. "feeling overwhelmed" instead of "anxiety disorder", "energy practice" instead of "therapy", "explore" instead of "diagnose". Re-scan your draft for any verb like treats/diagnoses/cures/heals/prescribes followed by clinical nouns and reword.`;
}

function snippetRL2(result) {
  const compMatch = (result.note || '').match(/competitor "([^"]+)" appears within ±\d+ char of sentiment "([^"]+)"/);
  const comp = compMatch?.[1] || '(competitor name)';
  const sent = compMatch?.[2] || '(negative word)';
  return `**FIX RL2 (competitor smear)**: The competitor "${comp}" appears within ±200 characters of negative word "${sent}". Either (a) remove the competitor mention entirely, or (b) reword the surrounding ±200 chars to be neutral / positive (e.g. drop "inaccurate", "outdated", "scam" etc.). Do not name-shame competitors anywhere in the article.`;
}

function snippetRL3(result) {
  const tokMatch = (result.note || '').match(/(\d+) tokens \(threshold (\d+)\)/);
  const got = tokMatch?.[1] || '>12';
  const thr = tokMatch?.[2] || '12';
  return `**FIX RL3 (SERP plagiarism)**: The draft has a ${got}-token contiguous overlap with one of the top SERP snippets (threshold ${thr}). Re-read your article for any 13+ word run that paraphrases SERP results verbatim. Reword using (1) different sentence structure (active↔passive, compound↔simple), (2) synonyms for content words, (3) different opening clauses. Break up long matching runs.`;
}

function snippetRL4(result, entity) {
  // Note format: 'drifted sections: "Heading A" (jaccard=0.020, shingle=0.000); "Heading B" (...)'
  const sectionsRaw = (result.note || '').replace(/^drifted sections:\s*/, '');
  return `**FIX RL4 (entity drift)**: These H2 sections drifted away from the target entity "${entity}":\n${sectionsRaw}\nIn the FIRST paragraph of each drifted section, add ONE sentence that explicitly names "${entity}" (literal phrase, exact casing). Example: "When we look at how ${entity} shows up in daily life, ...". Do not pad — replace an existing weak opener with the anchored version.`;
}

function snippetRL5(result, targetKeyword) {
  const countMatch = (result.note || '').match(/count = (\d+) \(limit (\d+)\)/);
  const count = Number.parseInt(countMatch?.[1] || '0', 10);
  const limit = Number.parseInt(countMatch?.[2] || '8', 10);
  const toRemove = Math.max(1, count - limit);
  // Pick synonym list by head-noun match.
  const lower = targetKeyword.toLowerCase();
  const matchedKey = Object.keys(RL5_SYNONYMS).find((k) => lower.includes(k));
  const synList = matchedKey ? RL5_SYNONYMS[matchedKey] : null;
  const synLine = synList
    ? `Suggested synonyms for "${targetKeyword}" (head noun "${matchedKey}"): ${synList.map((s) => `"${s}"`).join(', ')}. Mix several rather than picking one.`
    : `No pre-built synonym list for "${targetKeyword}" — use pronouns ("it", "this energy", "the same pattern") and demonstratives, plus rephrasings that drop the keyword while keeping topical anchoring.`;
  return `**FIX RL5 (keyword stuffing)**: Target keyword "${targetKeyword}" appears ${count} times (limit ${limit}). Replace ${toRemove} occurrence(s) with synonyms or pronouns. ${synLine} Preserve the keyword in the H1, the intro paragraph, and 1-2 H2 sections; thin everywhere else.`;
}

function snippetRL6(result) {
  const note = result.note || '';
  if (/missing required disclaimer/i.test(note)) {
    return `**FIX RL6 (psych safety — missing disclaimer)**: This page has psych_safety=Y, which requires a disclaimer line. Add this exact line at the END of the article (after the last H2 body, before any wikilinks):\n\n> This is not a clinical or mental health interpretation — for spiritual exploration only.\n\nUse the blockquote prefix "> " so it renders distinctly.`;
  }
  if (/blacklist word matched: "([^"]+)"/i.test(note)) {
    const word = note.match(/blacklist word matched: "([^"]+)"/i)[1];
    return `**FIX RL6 (psych safety — blacklist word)**: The word "${word}" is on the psych-safety blacklist. Remove ALL instances and replace with non-clinical alternatives (e.g. "healing" → "integration / processing / moving through", "therapy" → "practice / reflection work", "disorder" → "pattern"). Also keep the required disclaimer line.`;
  }
  if (/forbidden phrase matched/i.test(note)) {
    return `**FIX RL6 (psych safety — forbidden phrasing)**: The draft uses second-person diagnostic phrasing (e.g. "you have trauma"). Rewrite as observational, third-person, or experiential: "this can show up when someone has been through..." instead of "you have...". Keep the required disclaimer line.`;
  }
  return `**FIX RL6 (psych safety)**: ${note}. Re-check disclaimer line is present at end of article and remove any clinical blacklist words.`;
}

function buildFixInstructions(checks, entity, targetKeyword) {
  const fixes = [];
  if (!checks.rl1.pass) fixes.push(snippetRL1(checks.rl1));
  if (!checks.rl2.pass) fixes.push(snippetRL2(checks.rl2));
  if (!checks.rl3.pass) fixes.push(snippetRL3(checks.rl3));
  if (!checks.rl4.pass) fixes.push(snippetRL4(checks.rl4, entity));
  if (!checks.rl5.pass) fixes.push(snippetRL5(checks.rl5, targetKeyword));
  if (!checks.rl6.pass) fixes.push(snippetRL6(checks.rl6));
  return fixes;
}

function nextRetryIndex(pageId) {
  if (!existsSync(PROMPTS_DIR)) return 1;
  const existing = readdirSync(PROMPTS_DIR).filter((f) => f.startsWith(`${pageId}.retry-`) && f.endsWith('.md'));
  const indices = existing.map((f) => Number.parseInt(f.match(/\.retry-(\d+)\.md$/)?.[1] || '0', 10));
  return (indices.length === 0 ? 0 : Math.max(...indices)) + 1;
}

function assembleRetryPrompt({ originalPrompt, previousArticle, fixes, manifest }) {
  const fixBlock = fixes.length
    ? fixes.map((f, i) => `### Fix ${i + 1}\n${f}`).join('\n\n')
    : '(no automated fixes templated — see manifest manually)';
  return `${originalPrompt.trim()}

---

# RETRY INSTRUCTIONS — previous attempt failed phase2 red-line checks

Your previous draft for ${manifest.page_id} (entity: "${manifest.entity}", target_keyword: "${manifest.target_keyword}") failed one or more red-line checks. You MUST address every fix listed below in your rewrite. Keep all structural requirements from the original prompt above (H1=1, H2 count, word range, wikilinks, etc.) — only adjust the specific issues called out here.

## Fixes required

${fixBlock}

## Previous article (rewrite this, addressing every fix above)

\`\`\`markdown
${previousArticle.trim()}
\`\`\`

## Output

Produce ONLY the rewritten article markdown (starting from the H1 line). No preamble, no commentary, no trailing chat meta.
`;
}

function printSummary(beforeChecks, afterChecks) {
  const rls = ['rl1', 'rl2', 'rl3', 'rl4', 'rl5', 'rl6'];
  const lines = [];
  lines.push('━'.repeat(60));
  lines.push('RL diff summary (before retry → after retry)');
  lines.push('━'.repeat(60));
  for (const rl of rls) {
    const wasPass = beforeChecks[rl].pass;
    const nowPass = afterChecks ? afterChecks[rl].pass : null;
    const wasStr = wasPass ? 'PASS' : 'FAIL';
    const nowStr = afterChecks ? (nowPass ? 'PASS' : 'FAIL') : 'N/A (no rerun)';
    const arrow = afterChecks
      ? (wasPass === nowPass ? '=' : (nowPass ? '↑ FIXED' : '↓ REGRESSED'))
      : '-';
    lines.push(`  ${rl.toUpperCase()}: was ${wasStr.padEnd(4)} → now ${nowStr.padEnd(12)} ${arrow}`);
  }
  lines.push('━'.repeat(60));
  process.stdout.write(lines.join('\n') + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) { usage(); process.exit(0); }
  if (!args.manifest) { usage(); fail('--manifest is required'); }

  const manifestPath = resolve(args.manifest);
  const manifest = loadManifest(manifestPath);

  // Resolve source draft path (manifest stores it relative or absolute).
  let sourcePath = manifest.source_path;
  if (!existsSync(sourcePath)) sourcePath = resolve(REPO, manifest.source_path);
  if (!existsSync(sourcePath)) fail(`source draft not found: ${manifest.source_path}`);

  const phase2 = manifest.phase2_checks;
  const overall = (phase2 && typeof phase2 === 'object') ? phase2.overall : phase2;
  // If overall is explicitly "pass", nothing to fix.
  if (overall === 'pass') {
    process.stdout.write(`[phase2-fix] nothing to fix — manifest overall = "pass"\n`);
    process.exit(0);
  }

  // Live re-check to get note strings (manifest only stores booleans).
  const draft = stripFrontmatter(readFileSync(sourcePath, 'utf8'));
  const beforeChecks = recheckRedLines(draft, manifest);
  const failedRLs = Object.entries(beforeChecks).filter(([, r]) => !r.pass).map(([k]) => k);
  if (failedRLs.length === 0) {
    process.stdout.write(`[phase2-fix] manifest says overall != pass, but live re-check shows all RLs pass. Re-run validator manually.\n`);
    process.exit(0);
  }
  process.stderr.write(`[phase2-fix] failed RLs: ${failedRLs.join(', ')}\n`);

  // Build fix snippets.
  const fixes = buildFixInstructions(beforeChecks, manifest.entity, manifest.target_keyword);

  // Load original v8 prompt.
  const promptVersion = manifest.prompt_version || 'v8';
  const originalPromptPath = join(PROMPTS_DIR, `${manifest.page_id}.${promptVersion}-prompt.md`);
  if (!existsSync(originalPromptPath)) fail(`original prompt not found: ${originalPromptPath}`);
  const originalPrompt = readFileSync(originalPromptPath, 'utf8');

  // Assemble retry prompt.
  const retryPrompt = assembleRetryPrompt({
    originalPrompt,
    previousArticle: draft,
    fixes,
    manifest,
  });

  // Dry-run: print and exit.
  if (args.dry_run) {
    process.stdout.write(retryPrompt);
    process.exit(0);
  }

  // Write retry prompt.
  mkdirSync(PROMPTS_DIR, { recursive: true });
  const retryIdx = nextRetryIndex(manifest.page_id);
  const retryPath = join(PROMPTS_DIR, `${manifest.page_id}.retry-${retryIdx}.md`);
  writeFileSync(retryPath, retryPrompt);
  process.stderr.write(`[phase2-fix] wrote retry prompt: ${retryPath}\n`);

  if (args.no_rerun) {
    process.stdout.write(`[phase2-fix] --no-rerun set; stopping after writing retry prompt.\n`);
    printSummary(beforeChecks, null);
    process.exit(0);
  }

  // Pick LLM. Default = map manifest.generated_by → model key.
  const llmMap = { claude: 'claude', codex: 'codex', gemini: 'gemini', hermes: 'hermes' };
  let llm = args.llm;
  if (!llm) {
    const gb = String(manifest.generated_by || '').toLowerCase();
    llm = Object.keys(llmMap).find((k) => gb.includes(k)) || 'claude';
  }
  if (!llmMap[llm]) fail(`--llm must be one of: ${Object.keys(llmMap).join('/')} (frontier-only)`);

  // Invoke orchestrator.
  process.stderr.write(`[phase2-fix] invoking gg-llm-orchestrator with --models ${llm}\n`);
  const orch = spawnSync('node', [
    join(REPO, 'tools', 'scripts', 'gg-llm-orchestrator.mjs'),
    '--prompt', retryPath,
    '--page-id', manifest.page_id,
    '--models', llm,
    '--out-dir', dirname(sourcePath),
    '--retry', '1',
  ], { cwd: REPO, encoding: 'utf8', stdio: 'inherit' });
  if (orch.status !== 0) {
    process.stderr.write(`[phase2-fix] orchestrator exited ${orch.status}\n`);
    printSummary(beforeChecks, null);
    process.exit(orch.status || 1);
  }

  // Re-run validator on new draft.
  const newDraftPath = join(dirname(sourcePath), `${manifest.page_id}-${llm}-v8.md`);
  if (!existsSync(newDraftPath)) {
    process.stderr.write(`[phase2-fix] new draft not found at expected path: ${newDraftPath}\n`);
    printSummary(beforeChecks, null);
    process.exit(1);
  }
  const newDraft = stripFrontmatter(readFileSync(newDraftPath, 'utf8'));
  const afterChecks = recheckRedLines(newDraft, manifest);

  // Persist diff sidecar for audit trail.
  const diffPath = join(dirname(sourcePath), `${basename(manifestPath, '.json')}.retry-${retryIdx}-diff.json`);
  writeFileSync(diffPath, JSON.stringify({
    page_id: manifest.page_id,
    retry_index: retryIdx,
    retry_prompt_path: retryPath,
    new_draft_path: newDraftPath,
    llm,
    before: Object.fromEntries(Object.entries(beforeChecks).map(([k, v]) => [k, { pass: v.pass, note: v.note }])),
    after: Object.fromEntries(Object.entries(afterChecks).map(([k, v]) => [k, { pass: v.pass, note: v.note }])),
  }, null, 2));
  process.stderr.write(`[phase2-fix] wrote diff sidecar: ${diffPath}\n`);

  printSummary(beforeChecks, afterChecks);
  const allPass = Object.values(afterChecks).every((r) => r.pass);
  process.exit(allPass ? 0 : 11);
}

main().catch((err) => {
  process.stderr.write(`[phase2-fix] FATAL: ${err.stack || err.message}\n`);
  process.exit(1);
});
