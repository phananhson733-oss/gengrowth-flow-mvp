#!/usr/bin/env node
// gg-llm-orchestrator.mjs — drive Stage 12 of docs/PIPELINE.md across 4 LLMs.
// Models: claude (opus-4-7 xhigh) / codex (gpt-5.5 high) / gemini (2.5-pro) / hermes (405b).
// Parallel via Promise.allSettled + child_process.spawn. Each model gets --retry N
// attempts; --diversify-on-fail escalates to opus (hermes→opus, codex→opus, gemini→opus).
// Usage:
//   node tools/scripts/gg-llm-orchestrator.mjs --prompt <path> --page-id <id> \
//     --models "claude,codex,gemini,hermes" --out-dir _staging \
//     [--retry 2] [--diversify-on-fail] [--dry-run]
// Outputs: <out>/<page_id>-<llm>-v8.md  +  <out>/<page_id>-orchestrator.json
// FRONTIER-ONLY: refuses tiny prompts (<1KB), refuses downgraded Claude output
// (<3KB suggests silent Sonnet fallback), surfaces all guards in summary.json.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logCost } from './lib/_cost-log.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');

// page_id flows directly into file paths via join(outDir, `${pageId}-...`),
// so a value like `../../etc/passwd` would escape --out-dir. Match the
// repo-wide page_id contract (see gg-sheet-to-brief.mjs, gg-brief-suggest.mjs)
// and reject anything outside [A-Za-z0-9_-]{1,64} before constructing paths.
const PAGE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

// ─── 1. Config — model registry, prices, command builders ──────────────────
// PRICING: per 1M tokens, estimates from provider public pages 2026-05-23.
const PRICING = {
  claude: { input_per_m: 15.0, output_per_m: 75.0, note: 'Opus 4.7 xhigh' },
  codex: { input_per_m: 10.0, output_per_m: 40.0, note: 'GPT 5.5 high' },
  gemini: { input_per_m: 3.5, output_per_m: 10.5, note: 'Gemini 2.5 Pro' },
  hermes: { input_per_m: 4.0, output_per_m: 4.0, note: 'OpenRouter estimate' },
};
const WORDS_PER_TOKEN = 1 / 1.3; // ~1.3 tokens per English word
// Diversify map per PIPELINE.md L312 ("hermes 失败 2 次 → 切 Opus 4.7 xhigh").
const DIVERSIFY_ESCALATION = { hermes: 'claude', codex: 'claude', gemini: 'claude', claude: null };

// Build the argv array for each model. `bin` is resolved via PATH on spawn.
// stdin = prompt content, stdout captured to outputPath, stderr surfaced.
function buildCommand(model, promptPath, outputPath) {
  switch (model) {
    case 'claude':
      // CRITICAL: --model claude-opus-4-7 is load-bearing. Without it Claude
      // CLI silently downgrades to Sonnet. We re-verify below in validation.
      return {
        bin: 'claude',
        args: ['-p', '--model', 'claude-opus-4-7'],
        stdinFromFile: promptPath,
        stdoutToFile: outputPath,
      };
    case 'codex':
      return {
        bin: 'codex',
        args: ['exec', '-c', 'model=gpt-5.5', '-c', 'reasoning_effort=high', '-'],
        stdinFromFile: promptPath,
        stdoutToFile: outputPath,
      };
    case 'gemini':
      // TODO(2026-Hx): when google/gemini-cli ships gemini-3 in the bundle,
      // bump model id here (verify with `gemini --help | grep gemini-3`).
      return {
        bin: 'gemini',
        args: ['--model', 'gemini-2.5-pro'],
        stdinFromFile: promptPath,
        stdoutToFile: outputPath,
      };
    case 'hermes':
      // Hermes script handles its own file IO + API key from env.
      return {
        bin: 'node',
        args: [
          join(REPO, 'tools', 'scripts', '_call-hermes.mjs'),
          '--prompt',
          promptPath,
          '--output',
          outputPath,
          '--model',
          'nousresearch/hermes-3-llama-3.1-405b',
        ],
        stdinFromFile: null,
        stdoutToFile: null,
      };
    default:
      throw new Error(`unknown model: ${model}`);
  }
}

// Human-readable shell representation, for --dry-run and summary.json.
function renderShell(cmd) {
  const head = [cmd.bin, ...cmd.args].map(shellQuote).join(' ');
  const stdin = cmd.stdinFromFile ? ` < ${shellQuote(cmd.stdinFromFile)}` : '';
  const stdout = cmd.stdoutToFile ? ` > ${shellQuote(cmd.stdoutToFile)}` : '';
  return head + stdin + stdout;
}

function shellQuote(s) {
  if (s === undefined || s === null) return '';
  if (/^[A-Za-z0-9_\-./=:,]+$/.test(s)) return s;
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// ─── 2. CLI parsing + validation ───────────────────────────────────────────
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

function usage() {
  process.stderr.write(
    `usage: gg-llm-orchestrator.mjs \\
  --prompt <path>          v8 prompt (>=1KB)
  --page-id <id>           e.g. page_aura_color_blue
  --models <csv>           subset of: claude,codex,gemini,hermes
  --out-dir <dir>          default: _staging
  [--retry N]              default: 2 attempts per model
  [--diversify-on-fail]    after N retries on a model, escalate to claude opus
  [--dry-run]              print commands without invoking sub-CLIs
`,
  );
}

function validateInputs(args) {
  const errors = [];
  if (!args.prompt) errors.push('--prompt is required');
  if (!args.page_id) {
    errors.push('--page-id is required');
  } else if (!PAGE_ID_REGEX.test(String(args.page_id))) {
    // Path-traversal guard: page_id is interpolated into output file paths.
    errors.push(`--page-id "${String(args.page_id).slice(0, 80)}" invalid — must match ${PAGE_ID_REGEX}`);
  }
  if (!args.models) errors.push('--models is required (csv)');

  const models = args.models
    ? String(args.models)
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean)
    : [];
  const valid = new Set(['claude', 'codex', 'gemini', 'hermes']);
  for (const m of models) if (!valid.has(m)) errors.push(`unknown model in --models: ${m}`);

  // Skip prompt-file existence + size guard in --dry-run: dry-run only renders
  // the planned shell command, so a stub or missing prompt path is fine.
  if (!args.dry_run) {
    if (args.prompt && !existsSync(args.prompt)) {
      errors.push(`prompt file not found: ${args.prompt}`);
    } else if (args.prompt) {
      const size = statSync(args.prompt).size;
      if (size < 1024) {
        errors.push(`prompt file too small (${size}B < 1024B) — renderer usually emits ~30KB; refusing to burn frontier tokens on a stub`);
      }
    }
  }

  const retry = args.retry === undefined ? 2 : Number.parseInt(args.retry, 10);
  if (!Number.isFinite(retry) || retry < 0 || retry > 5) errors.push('--retry must be 0..5');

  return { errors, models, retry };
}

// ─── 3. Sub-CLI availability + post-run guards ─────────────────────────────
function commandExists(bin) {
  const PATH = process.env.PATH || '';
  for (const dir of PATH.split(':')) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return true;
  }
  return false;
}

function modelBin(model) {
  if (model === 'hermes') return 'node';
  return model;
}

// SONNET DOWNGRADE GUARD. Claude Sonnet typically produces 600-1500 byte
// articles for our v8 prompts (it ignores depth instructions); Opus produces
// 6000-15000 bytes. Threshold of 3000B = clearly downgraded.
const CLAUDE_OPUS_MIN_BYTES = 3000;

function detectClaudeDowngrade(outputPath) {
  try {
    const size = statSync(outputPath).size;
    if (size < CLAUDE_OPUS_MIN_BYTES) {
      return {
        downgraded: true,
        bytes: size,
        message: `claude output is ${size}B (< ${CLAUDE_OPUS_MIN_BYTES}B). Sonnet downgrade suspected. Verify CLI honored --model claude-opus-4-7 (run \`claude --version\` and check ~/.claude/settings.json for a default model override). Re-run after fixing.`,
      };
    }
    return { downgraded: false, bytes: size };
  } catch {
    return { downgraded: false, bytes: 0 };
  }
}

// ─── 4. Cost estimation ────────────────────────────────────────────────────
function wordCount(text) {
  return (text.match(/\S+/g) || []).length;
}

function estimateCostUsd(model, promptText, outputText) {
  const p = PRICING[model];
  if (!p) return null;
  const inTokens = wordCount(promptText) / WORDS_PER_TOKEN;
  const outTokens = wordCount(outputText) / WORDS_PER_TOKEN;
  const cost = (inTokens / 1_000_000) * p.input_per_m + (outTokens / 1_000_000) * p.output_per_m;
  return {
    usd: Number(cost.toFixed(4)),
    input_tokens_est: Math.round(inTokens),
    output_tokens_est: Math.round(outTokens),
    pricing_note: p.note,
  };
}

// ─── 5. Attempt runner — single model, single try ──────────────────────────
function runAttempt(model, promptPath, outputPath) {
  return new Promise((resolveAttempt) => {
    const cmd = buildCommand(model, promptPath, outputPath);
    const t0 = Date.now();

    // Stale-output guard: delete any leftover output from a prior attempt
    // BEFORE spawning. Otherwise an empty-stdout run + the Claude sonnet
    // size check would silently read stale bytes from the previous try.
    // Only delete for paths we'll write via stdoutToFile; hermes manages
    // its own file IO and is its own source of truth.
    if (cmd.stdoutToFile) {
      try {
        statSync(cmd.stdoutToFile);
        unlinkSync(cmd.stdoutToFile);
      } catch {
        // ENOENT (no prior file) is fine; swallow.
      }
    }

    // Open stdin/stdout file handles via shell-equivalent pipes.
    const stdio = ['pipe', 'pipe', 'pipe'];
    // Security: never pass secrets via argv (they would show in `ps`).
    // Hermes script reads OPENROUTER_API_KEY from process.env directly.
    const child = spawn(cmd.bin, cmd.args, {
      cwd: REPO,
      env: process.env,
      stdio,
    });

    let stderrBuf = '';
    let stdoutBuf = '';
    let promptContent = '';

    child.on('error', (err) => {
      resolveAttempt({
        ok: false,
        exit_code: -1,
        duration_s: Number(((Date.now() - t0) / 1000).toFixed(1)),
        stderr_tail: `spawn failed: ${err.code || err.message}`,
        skipped: err.code === 'ENOENT',
      });
    });

    child.stdout.on('data', (d) => {
      stdoutBuf += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderrBuf += d.toString();
    });

    child.on('close', (code) => {
      const duration_s = Number(((Date.now() - t0) / 1000).toFixed(1));
      try {
        // Models that route stdout → file: write captured buffer now.
        // Always write — even when stdoutBuf is empty — so downstream size
        // checks (e.g. Claude sonnet-downgrade guard) see 0 bytes instead
        // of stale bytes left over from a deleted prior attempt.
        if (cmd.stdoutToFile) {
          mkdirSync(dirname(cmd.stdoutToFile), { recursive: true });
          writeFileSync(cmd.stdoutToFile, stdoutBuf);
        }
      } catch (err) {
        return resolveAttempt({
          ok: false,
          exit_code: code,
          duration_s,
          stderr_tail: `failed to write output: ${err.message}`,
        });
      }
      const tail = stderrBuf.slice(-500).trim();
      resolveAttempt({
        ok: code === 0,
        exit_code: code,
        duration_s,
        stderr_tail: tail,
        stdout_bytes: stdoutBuf.length,
      });
    });

    // Pipe prompt file into child stdin if required.
    if (cmd.stdinFromFile) {
      try {
        promptContent = readFileSync(cmd.stdinFromFile);
      } catch (err) {
        child.kill();
        return resolveAttempt({
          ok: false,
          exit_code: -1,
          duration_s: 0,
          stderr_tail: `prompt read failed: ${err.message}`,
        });
      }
      child.stdin.write(promptContent);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

// ─── 6. Model driver — retry + diversify ───────────────────────────────────
async function driveModel({ model, promptPath, outDir, pageId, retry, diversifyOnFail }) {
  const attempts = [];
  let activeModel = model;

  // Pre-flight: is sub-CLI installed? If not, gracefully skip (don't crash).
  if (!commandExists(modelBin(activeModel))) {
    return {
      model,
      active_model: activeModel,
      ok: false,
      skipped: true,
      reason: `${modelBin(activeModel)} not in PATH — install the CLI or remove from --models`,
      attempts: [],
    };
  }

  // Up to (retry+1) tries with the original model.
  const totalTries = retry + 1;
  let outputPath = join(outDir, `${pageId}-${activeModel}-v8.md`);
  let lastResult = null;

  for (let i = 0; i < totalTries; i++) {
    const cmd = buildCommand(activeModel, promptPath, outputPath);
    const attempt = await runAttempt(activeModel, promptPath, outputPath);
    attempts.push({
      try_index: i + 1,
      model: activeModel,
      command: renderShell(cmd),
      ...attempt,
    });
    lastResult = attempt;
    if (attempt.ok) {
      // Claude downgrade guard runs only on success.
      if (activeModel === 'claude') {
        const guard = detectClaudeDowngrade(outputPath);
        attempts[attempts.length - 1].sonnet_guard = guard;
        if (guard.downgraded) {
          attempt.ok = false;
          attempts[attempts.length - 1].ok = false;
          attempts[attempts.length - 1].stderr_tail = guard.message;
          continue;
        }
      }
      break;
    }
  }

  // If still failing AND diversify requested AND escalation target available.
  if (!lastResult?.ok && diversifyOnFail) {
    const escalated = DIVERSIFY_ESCALATION[model];
    if (escalated && escalated !== activeModel && commandExists(modelBin(escalated))) {
      activeModel = escalated;
      outputPath = join(outDir, `${pageId}-${model}-then-${escalated}-v8.md`);
      const cmd = buildCommand(activeModel, promptPath, outputPath);
      const attempt = await runAttempt(activeModel, promptPath, outputPath);
      attempts.push({
        try_index: attempts.length + 1,
        model: activeModel,
        diversified_from: model,
        command: renderShell(cmd),
        ...attempt,
      });
      lastResult = attempt;
      if (attempt.ok && activeModel === 'claude') {
        const guard = detectClaudeDowngrade(outputPath);
        attempts[attempts.length - 1].sonnet_guard = guard;
        if (guard.downgraded) {
          attempt.ok = false;
          attempts[attempts.length - 1].ok = false;
          attempts[attempts.length - 1].stderr_tail = guard.message;
        }
      }
    }
  }

  // Cost estimate from the last successful attempt's output, if any.
  let cost = null;
  if (lastResult?.ok && existsSync(outputPath)) {
    const promptText = readFileSync(promptPath, 'utf8');
    const outText = readFileSync(outputPath, 'utf8');
    cost = estimateCostUsd(activeModel, promptText, outText);
  }

  return {
    model,
    active_model: activeModel,
    diversified: activeModel !== model,
    ok: !!lastResult?.ok,
    output_path: lastResult?.ok ? outputPath : null,
    retries: Math.max(0, attempts.length - 1),
    duration_s: attempts.reduce((s, a) => s + (a.duration_s || 0), 0),
    cost_estimate_usd: cost,
    attempts,
  };
}

// ─── 7. Dry-run printer ────────────────────────────────────────────────────
function printDryRun(models, promptPath, outDir, pageId) {
  process.stdout.write(`# dry-run (no sub-CLI invoked)\n`);
  process.stdout.write(`# prompt   : ${promptPath}\n`);
  process.stdout.write(`# page_id  : ${pageId}\n`);
  process.stdout.write(`# out_dir  : ${outDir}\n\n`);
  for (const model of models) {
    const outputPath = join(outDir, `${pageId}-${model}-v8.md`);
    const cmd = buildCommand(model, promptPath, outputPath);
    process.stdout.write(`## ${model}\n`);
    process.stdout.write(`${renderShell(cmd)}\n\n`);
  }
}

// ─── 8. Main ───────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    process.exit(0);
  }
  const { errors, models, retry } = validateInputs(args);
  if (errors.length) {
    for (const e of errors) process.stderr.write(`[orchestrator] ERROR: ${e}\n`);
    process.stderr.write('\n');
    usage();
    process.exit(2);
  }

  const promptPath = resolve(args.prompt);
  const outDir = resolve(args.out_dir || '_staging');
  const pageId = String(args.page_id);
  const diversifyOnFail = !!args.diversify_on_fail;
  const dryRun = !!args.dry_run;

  // Defense-in-depth re-check (validateInputs already enforces this, but
  // page_id flows into join() below so we re-assert before any path is built).
  if (!PAGE_ID_REGEX.test(pageId)) {
    console.error(`[orchestrator] ERROR: --page-id "${pageId.slice(0, 80)}" invalid — must match ${PAGE_ID_REGEX}`);
    process.exit(2);
  }

  if (dryRun) {
    // Dry-run must be read-only: do NOT create outDir.
    printDryRun(models, promptPath, outDir, pageId);
    process.exit(0);
  }

  mkdirSync(outDir, { recursive: true });

  process.stderr.write(
    `[orchestrator] page=${pageId} models=${models.join(',')} retry=${retry} diversify=${diversifyOnFail}\n`,
  );

  // Parallel exec. allSettled so one model crash doesn't sink the rest.
  const settled = await Promise.allSettled(
    models.map((m) =>
      driveModel({
        model: m,
        promptPath,
        outDir,
        pageId,
        retry,
        diversifyOnFail,
      }),
    ),
  );

  const results = {};
  let okCount = 0;
  let totalCost = 0;
  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const s = settled[i];
    if (s.status === 'fulfilled') {
      results[m] = s.value;
      if (s.value.ok) okCount++;
      if (s.value.cost_estimate_usd?.usd) totalCost += s.value.cost_estimate_usd.usd;
    } else {
      results[m] = { model: m, ok: false, error: String(s.reason?.message || s.reason) };
    }
  }

  const summary = {
    page_id: pageId,
    prompt_path: promptPath,
    started_at: new Date().toISOString(),
    models_requested: models,
    retry,
    diversify_on_fail: diversifyOnFail,
    ok_count: okCount,
    total_cost_estimate_usd: Number(totalCost.toFixed(4)),
    results,
  };

  const summaryPath = join(outDir, `${pageId}-orchestrator.json`);
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  process.stderr.write(`[orchestrator] wrote ${summaryPath} (ok=${okCount}/${models.length}, est=$${totalCost.toFixed(4)})\n`);

  // Append one cost-tracking row per model attempted (Stage 12 telemetry).
  const costRows = [];
  for (const m of models) {
    const r = results[m];
    if (!r) continue;
    const c = r.cost_estimate_usd;
    costRows.push({
      operation: 'llm_call',
      tool: 'gg-llm-orchestrator',
      page_id: pageId,
      tokens_in: c?.input_tokens_est || 0,
      tokens_out: c?.output_tokens_est || 0,
      cost_usd: c?.usd || 0,
      api_calls: (r.attempts?.length) || 1,
      notes: `${r.active_model || m}${r.diversified ? ` (diversified from ${m})` : ''} · ok=${r.ok ? 'yes' : 'no'} · retries=${r.retries ?? 0}`,
    });
  }
  await logCost(costRows);

  // Exit non-zero if every model failed; partial success = exit 0 (downstream
  // publish picks whichever passed phase2).
  process.exit(okCount === 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`[orchestrator] FATAL: ${err.stack || err.message}\n`);
  process.exit(1);
});
