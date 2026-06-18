#!/usr/bin/env node
// gg-llm-orchestrator.mjs — drive Stage 12 of docs/PIPELINE.md.
// DEFAULT: Claude-only (opus-4-8 xhigh). Cross-validation models codex (gpt-5.5
// high) / gemini (2.5-pro) stay available on demand via --models. The hermes
// model (≈GPT-equivalent, needs OPENROUTER_API_KEY) was dropped 2026-05-26.
// Parallel via Promise.allSettled + child_process.spawn. Each model gets --retry N
// attempts; --diversify-on-fail escalates to opus (codex→opus, gemini→opus).
// Usage:
//   node tools/scripts/gg-llm-orchestrator.mjs --prompt <path> --page-id <id> \
//     [--models claude] --out-dir _staging \
//     [--retry 2] [--diversify-on-fail] [--dry-run]
//   --models defaults to "claude" (Claude-only). Add codex/gemini for cross-val.
// Outputs: <out>/<page_id>-<llm>-v8.md  +  <out>/<page_id>-orchestrator.json
// FRONTIER-ONLY: refuses tiny prompts (<1KB), refuses downgraded Claude output
// (<3KB suggests silent Sonnet fallback), surfaces all guards in summary.json.
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logCost } from './lib/_cost-log.mjs';
import { stripPreH1 } from './lib/strip-preamble.mjs';
import { buildWorkerCommand } from './lib/llm-worker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');

// page_id flows directly into file paths via join(outDir, `${pageId}-...`),
// so a value like `../../etc/passwd` would escape --out-dir. Match the
// repo-wide page_id contract (see gg-sheet-to-brief.mjs, gg-brief-suggest.mjs)
// and reject anything outside [A-Za-z0-9_-]{1,64} before constructing paths.
const PAGE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

// ─── 1. Config — model registry, prices, command builders ──────────────────
// PRICING: per 1M tokens, estimates from provider public pages 2026-05-23.
// Generation models (overridable via env). Default authoring model = Sonnet 4.6 at
// xhigh effort (user pref 2026-06-05: Sonnet 4.6 xhigh writes; Opus 4.8 reviews).
// `--effort` accepts low|medium|high|xhigh|max (claude CLI). Opus 4.8 stays the
// cross-validation escalation ceiling (see DIVERSIFY_ESCALATION) and the reviewer.
const CLAUDE_MODEL = process.env.GG_CLAUDE_MODEL || 'claude-sonnet-4-6';
// Rate-limit fallback: if Sonnet 4.6 hits a quota/429/overloaded error, retry the
// SAME generation once on Opus (4.8 'high' by default; set GG_CLAUDE_FALLBACK_MODEL
// to claude-opus-4-7 if preferred). Keeps authoring flowing when Sonnet is throttled.
const CLAUDE_FALLBACK_MODEL = process.env.GG_CLAUDE_FALLBACK_MODEL || 'claude-opus-4-8';
const CLAUDE_FALLBACK_EFFORT = process.env.GG_CLAUDE_FALLBACK_EFFORT || 'high';
// Detect a rate-limit / quota / overload signal in a failed attempt's stderr.
function isRateLimited(stderr) {
  return /rate.?limit|\b429\b|overloaded|over capacity|quota|usage limit|too many requests|insufficient_quota/i.test(String(stderr || ''));
}
// Writing effort: 'high' (not 'xhigh'). Measured: Sonnet 4.6 xhigh = ~585s/gen
// (~10 min, ~3× Opus) → the 5-attempt feedback loop made each article take hours.
// For the highly-structured v8 prompt, 'high' is near-identical quality at ~3×
// the speed, and the Codex+Opus review pass backstops it. Override: GG_CLAUDE_EFFORT.
const CLAUDE_EFFORT = process.env.GG_CLAUDE_EFFORT || 'high';
const CODEX_EFFORT = process.env.GG_CODEX_EFFORT || 'xhigh';
const PRICING = {
  claude: { input_per_m: 3.0, output_per_m: 15.0, note: 'Sonnet 4.6 xhigh' },
  codex: { input_per_m: 10.0, output_per_m: 40.0, note: 'GPT 5.5 xhigh' },
  gemini: { input_per_m: 3.5, output_per_m: 10.5, note: 'Gemini 2.5 Pro' },
};
const WORDS_PER_TOKEN = 1 / 1.3; // ~1.3 tokens per English word
// Diversify map: a failing cross-validation model escalates to Opus 4.8 xhigh
// (diversity > repetition). claude is already the ceiling, so it escalates to null.
const DIVERSIFY_ESCALATION = { codex: 'claude', gemini: 'claude', claude: null };

// ── clean-shutdown worker reaping ────────────────────────────────────────────
// Workers are spawned detached (their own process GROUP). If THIS orchestrator is signaled — e.g.
// the gg-seo-author lane's `gtimeout` cap-hit SIGTERMs the whole wrapper process group, which
// includes this execFileSync'd orchestrator — Node's default action terminates us instantly, taking
// the per-worker watchdog with it and ORPHANING the detached worker groups (they are in their own
// session, so the group SIGTERM never reaches them). So trap terminating signals and killTree every
// in-flight worker group BEFORE exiting. Idempotent; a no-op when there are no live workers.
const liveWorkers = new Set();
let _orchShuttingDown = false;
function reapLiveWorkers(signal) {
  if (_orchShuttingDown) return;
  _orchShuttingDown = true;
  for (const c of liveWorkers) {
    try { process.kill(-c.pid, 'SIGKILL'); }   // negative pid = the worker's whole process group
    catch { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  process.exit(signal === 'SIGINT' ? 130 : 143);
}
process.on('SIGTERM', () => reapLiveWorkers('SIGTERM'));
process.on('SIGINT', () => reapLiveWorkers('SIGINT'));
process.on('SIGHUP', () => reapLiveWorkers('SIGHUP'));

// Build the argv array for each model. `bin` is resolved via PATH on spawn.
// stdin = prompt content, stdout captured to outputPath, stderr surfaced.
function buildCommand(model, promptPath, outputPath, opts = {}) {
  // Argv contract extracted to ./lib/llm-worker.mjs (Task 2) so the same text-worker shape is
  // reusable (gg-author-repair, review workers) and unit-testable. Defaults are resolved HERE and
  // passed through, so the emitted argv stays byte-identical (incl. the rate-limit Opus fallback
  // via opts.claudeModel/opts.claudeEffort). The stdin/stdout file layering stays in the wrapper.
  const { bin, args } = buildWorkerCommand(model, {
    claudeModel: opts.claudeModel || CLAUDE_MODEL,
    claudeEffort: opts.claudeEffort || CLAUDE_EFFORT,
    codexEffort: CODEX_EFFORT,
  });
  return { bin, args, stdinFromFile: promptPath, stdoutToFile: outputPath };
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
  --prompt <path>                  v8 prompt (>=1KB)
  --page-id <id>                   e.g. page_aura_color_blue
  [--models <csv>]                 subset of: claude,codex,gemini (default: claude)
  --out-dir <dir>                  default: _staging
  [--retry N]                      default: 2 attempts per model (range 0..5)
  [--diversify-on-fail]            after N retries on a model, escalate to claude opus
  [--max-cost-usd-per-page X]      per-model budget gate; abort further retries/
                                   diversify on this model once cumulative cost
                                   exceeds X. Default 5.0 (typical run 0.5-1.5).
  [--dry-run]                      print commands without invoking sub-CLIs
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
  // Claude-only is the default (2026-05-26). Cross-validation with codex/gemini
  // stays available on demand via --models but is NOT the default.
  const models = args.models
    ? String(args.models)
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean)
    : ['claude'];
  const valid = new Set(['claude', 'codex', 'gemini']);
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

  const maxCostUsd = args.max_cost_usd_per_page === undefined
    ? 5.0
    : Number.parseFloat(args.max_cost_usd_per_page);
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0 || maxCostUsd > 100) {
    errors.push('--max-cost-usd-per-page must be > 0 and ≤ 100 (default 5.0)');
  }

  return { errors, models, retry, maxCostUsd };
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
  return model;
}

// SHORT-OUTPUT GUARD. A real 1500-1800 word v8 article is ~9000-15000 bytes.
// Sub-3000B means the generation failed, truncated, or the CLI silently fell back
// to a weak default model (no --model honored). Threshold 3000B = clearly broken.
const CLAUDE_OPUS_MIN_BYTES = 3000;

function detectClaudeDowngrade(outputPath) {
  try {
    const size = statSync(outputPath).size;
    if (size < CLAUDE_OPUS_MIN_BYTES) {
      return {
        downgraded: true,
        bytes: size,
        message: `claude output is ${size}B (< ${CLAUDE_OPUS_MIN_BYTES}B) — generation failed/truncated or CLI ignored --model. Verify CLI honored --model ${CLAUDE_MODEL} --effort ${CLAUDE_EFFORT} (run \`claude --version\` and check ~/.claude/settings.json for a default model override). Re-run after fixing.`,
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
// Parse a `ps` TIME field ("MM:SS.ss" or "HH:MM:SS.ss") → cumulative CPU seconds.
function parseCpuTime(s) {
  const p = String(s).trim().split(':');
  if (p.length === 2) return parseFloat(p[0]) * 60 + parseFloat(p[1]);
  if (p.length === 3) return parseFloat(p[0]) * 3600 + parseFloat(p[1]) * 60 + parseFloat(p[2]);
  return 0;
}

// Sum cumulative CPU seconds across every process in a process GROUP (pgid). Used
// by the deadlock watchdog: a healthy generation's group burns CPU continuously
// (even while stdout-silent during server-side thinking); a deadlock leaves it flat.
function groupCpuSeconds(pgid) {
  try {
    const out = execSync('ps -axo pgid=,time=', { encoding: 'utf8', timeout: 10000 });
    let total = 0;
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\S+)$/);
      if (m && parseInt(m[1], 10) === pgid) total += parseCpuTime(m[2]);
    }
    return total;
  } catch { return -1; }
}

function runAttempt(model, promptPath, outputPath, opts = {}) {
  return new Promise((resolveAttempt) => {
    const cmd = buildCommand(model, promptPath, outputPath, opts);
    const t0 = Date.now();

    // Stale-output guard: delete any leftover output from a prior attempt
    // BEFORE spawning. Otherwise an empty-stdout run + the Claude sonnet
    // size check would silently read stale bytes from the previous try.
    // All current models route stdout → file, so this always applies.
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
    // detached:true → the child is its own process-group LEADER, so we can kill the
    // WHOLE tree (claude + any grandchildren) with process.kill(-pid). Without this,
    // a watchdog/timeout kill of `claude` leaves orphaned grandchildren (PPID=1)
    // that pile up and starve the box — the exact failure that hung NAKSH-001.
    const child = spawn(cmd.bin, cmd.args, {
      cwd: REPO,
      env: process.env,
      stdio,
      detached: true,
    });
    liveWorkers.add(child); // tracked so a SIGTERM to the orchestrator kills the worker group too

    let stderrBuf = '';
    let stdoutBuf = '';
    let promptContent = '';

    // ── DEADLOCK WATCHDOG (CPU-activity based) ─────────────────────────────
    // `claude -p` does NOT stream to stdout during its (silent) thinking phase — it
    // buffers and emits at the end — so "no stdout" is NOT a hang signal (measured:
    // a healthy 'high' gen is stdout-silent for 11+ min while thinking). But its
    // process GROUP burns CPU continuously the whole time (parsing the API's streamed
    // thinking tokens): cumulative CPU climbs steadily (measured ~0.3-1s per 20s). A
    // true deadlock (blocked on a lock / dead socket) leaves CPU FLAT. So the hang
    // signal is: group CPU (and stdout) have not advanced for CPU_STALL_MS. Plus a
    // HARD ceiling. On trigger, kill the whole process GROUP (detached pgid) → no
    // orphaned grandchildren (the bug that hung NAKSH-001 for 36 min).
    const CPU_STALL_MS = parseInt(process.env.GG_GEN_CPU_STALL_MS || '180000', 10); // 3 min flat CPU = deadlock
    const HARD_MS = parseInt(process.env.GG_GEN_HARD_MS || '1200000', 10);          // 20 min absolute ceiling
    let lastData = Date.now();       // stdout growth also counts as progress (streaming models)
    let maxCpu = -1;
    let lastProgressAt = Date.now();
    let killedReason = null;
    const killTree = (sig) => {
      try { process.kill(-child.pid, sig); }      // negative pid = whole process group
      catch { try { child.kill(sig); } catch { /* already gone */ } }
    };
    const watchdog = setInterval(() => {
      const total = Date.now() - t0;
      const cpu = groupCpuSeconds(child.pid);   // pgid === child.pid (spawned detached)
      if (cpu > maxCpu + 0.2) { maxCpu = cpu; lastProgressAt = Date.now(); } // CPU advanced → alive
      const idle = Date.now() - Math.max(lastProgressAt, lastData);
      if (idle >= CPU_STALL_MS) killedReason = `WATCHDOG: no CPU/output progress for ${Math.round(idle / 1000)}s (deadlock); group cpu=${cpu.toFixed(1)}s`;
      else if (total >= HARD_MS) killedReason = `WATCHDOG: exceeded hard ceiling ${Math.round(total / 1000)}s`;
      if (killedReason) {
        clearInterval(watchdog);
        process.stderr.write(`[orchestrator] ${killedReason} — killing process group ${child.pid}\n`);
        killTree('SIGKILL');
      }
    }, 30000);

    child.on('error', (err) => {
      clearInterval(watchdog);
      liveWorkers.delete(child);
      resolveAttempt({
        ok: false,
        exit_code: -1,
        duration_s: Number(((Date.now() - t0) / 1000).toFixed(1)),
        stderr_tail: `spawn failed: ${err.code || err.message}`,
        skipped: err.code === 'ENOENT',
      });
    });

    child.stdout.on('data', (d) => {
      lastData = Date.now();
      stdoutBuf += d.toString();
    });
    child.stderr.on('data', (d) => {
      lastData = Date.now();
      stderrBuf += d.toString();
    });

    child.on('close', (code) => {
      clearInterval(watchdog);
      liveWorkers.delete(child);
      const duration_s = Number(((Date.now() - t0) / 1000).toFixed(1));
      // Watchdog-killed → fail this attempt loudly so the retry loop moves on.
      if (killedReason) {
        return resolveAttempt({
          ok: false,
          exit_code: code === null ? -2 : code,
          duration_s,
          stderr_tail: killedReason,
        });
      }
      try {
        // Models that route stdout → file: write captured buffer now.
        // Always write — even when stdoutBuf is empty — so downstream size
        // checks (e.g. Claude sonnet-downgrade guard) see 0 bytes instead
        // of stale bytes left over from a deleted prior attempt.
        if (cmd.stdoutToFile) {
          mkdirSync(dirname(cmd.stdoutToFile), { recursive: true });
          // Drop any chatbot preamble before the first H1 (a nested `claude -p`
          // can emit meta-commentary reacting to inherited skill-injection hooks).
          // No-op when the draft already starts at the H1. See lib/strip-preamble.
          writeFileSync(cmd.stdoutToFile, stripPreH1(stdoutBuf));
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

// ─── 6. Model driver — retry + diversify + cost budget ────────────────────
// Estimate cumulative cost from prompt + output bytes after each attempt.
// Returns USD spent on this attempt (0 if file missing).
function attemptCostUsd(activeModel, promptPath, outputPath) {
  if (!existsSync(outputPath)) return 0;
  try {
    const promptText = readFileSync(promptPath, 'utf8');
    const outText = readFileSync(outputPath, 'utf8');
    const c = estimateCostUsd(activeModel, promptText, outText);
    return c?.usd || 0;
  } catch {
    return 0;
  }
}

async function driveModel({ model, promptPath, outDir, pageId, retry, diversifyOnFail, maxCostUsd }) {
  const attempts = [];
  let activeModel = model;
  let cumulativeCostUsd = 0;
  let budgetExceeded = false;

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
    const attemptCost = attemptCostUsd(activeModel, promptPath, outputPath);
    cumulativeCostUsd += attemptCost;
    attempts.push({
      try_index: i + 1,
      model: activeModel,
      command: renderShell(cmd),
      cost_usd: Number(attemptCost.toFixed(4)),
      cumulative_cost_usd: Number(cumulativeCostUsd.toFixed(4)),
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
    // Budget gate: abort further retries if cumulative cost would exceed maxCostUsd.
    if (cumulativeCostUsd >= maxCostUsd) {
      budgetExceeded = true;
      attempts[attempts.length - 1].budget_exceeded = true;
      process.stderr.write(
        `[orchestrator] ${model}: budget $${maxCostUsd.toFixed(2)} reached after ` +
          `${i + 1} attempt(s) (spent $${cumulativeCostUsd.toFixed(4)}) — aborting further retries\n`,
      );
      break;
    }
  }

  // RATE-LIMIT FALLBACK: Sonnet 4.6 throttled (429 / overloaded / quota) → retry the
  // SAME generation once on Opus (4.8 high). Writes to the SAME outputPath so the
  // caller transparently picks up the Opus draft as `<pageId>-claude-v8.md`.
  if (!lastResult?.ok && model === 'claude' && isRateLimited(lastResult?.stderr_tail) && !budgetExceeded) {
    process.stderr.write(
      `[orchestrator] claude (${CLAUDE_MODEL}) rate-limited — falling back to ${CLAUDE_FALLBACK_MODEL} ${CLAUDE_FALLBACK_EFFORT}\n`,
    );
    const fbOpts = { claudeModel: CLAUDE_FALLBACK_MODEL, claudeEffort: CLAUDE_FALLBACK_EFFORT };
    const cmd = buildCommand('claude', promptPath, outputPath, fbOpts);
    const attempt = await runAttempt('claude', promptPath, outputPath, fbOpts);
    const attemptCost = attemptCostUsd(activeModel, promptPath, outputPath);
    cumulativeCostUsd += attemptCost;
    attempts.push({
      try_index: attempts.length + 1,
      model: activeModel,
      rate_limit_fallback_to: CLAUDE_FALLBACK_MODEL,
      command: renderShell(cmd),
      cost_usd: Number(attemptCost.toFixed(4)),
      cumulative_cost_usd: Number(cumulativeCostUsd.toFixed(4)),
      ...attempt,
    });
    lastResult = attempt;
    if (attempt.ok) {
      const guard = detectClaudeDowngrade(outputPath);
      attempts[attempts.length - 1].sonnet_guard = guard;
      if (guard.downgraded) {
        attempt.ok = false;
        attempts[attempts.length - 1].ok = false;
        attempts[attempts.length - 1].stderr_tail = guard.message;
      }
    }
  }

  // If still failing AND diversify requested AND escalation target available AND budget allows.
  if (!lastResult?.ok && diversifyOnFail && !budgetExceeded) {
    const escalated = DIVERSIFY_ESCALATION[model];
    if (escalated && escalated !== activeModel && commandExists(modelBin(escalated))) {
      activeModel = escalated;
      outputPath = join(outDir, `${pageId}-${model}-then-${escalated}-v8.md`);
      const cmd = buildCommand(activeModel, promptPath, outputPath);
      const attempt = await runAttempt(activeModel, promptPath, outputPath);
      const attemptCost = attemptCostUsd(activeModel, promptPath, outputPath);
      cumulativeCostUsd += attemptCost;
      attempts.push({
        try_index: attempts.length + 1,
        model: activeModel,
        diversified_from: model,
        command: renderShell(cmd),
        cost_usd: Number(attemptCost.toFixed(4)),
        cumulative_cost_usd: Number(cumulativeCostUsd.toFixed(4)),
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
    cumulative_cost_usd: Number(cumulativeCostUsd.toFixed(4)),
    budget_exceeded: budgetExceeded,
    budget_usd: maxCostUsd,
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
  const { errors, models, retry, maxCostUsd } = validateInputs(args);
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
    `[orchestrator] page=${pageId} models=${models.join(',')} retry=${retry} diversify=${diversifyOnFail} budget=$${maxCostUsd.toFixed(2)}/model\n`,
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
        maxCostUsd,
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

  const budgetExceededModels = Object.entries(results)
    .filter(([, r]) => r.budget_exceeded)
    .map(([m]) => m);
  const summary = {
    page_id: pageId,
    prompt_path: promptPath,
    started_at: new Date().toISOString(),
    models_requested: models,
    retry,
    diversify_on_fail: diversifyOnFail,
    max_cost_usd_per_page: maxCostUsd,
    budget_exceeded_models: budgetExceededModels,
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
