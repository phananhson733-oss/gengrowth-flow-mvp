#!/usr/bin/env node
// gg-preview-wait.mjs — deterministically wait for a Vercel preview deployment for a
// branch, replacing the autopilot prompt gate's "Step 2 — get the Vercel preview URL".
//
// The old prompt step (seo-autopilot-tick.prompt.md Step 2) asked the LLM to poll:
//     gh api "repos/xdawayer/oracle/deployments?ref=<branch>" --jq '.[0].id'
//     gh api "repos/xdawayer/oracle/deployments/<id>/statuses" --jq '.[0] | {state,environment_url}'
// until state=="success", capturing environment_url. This script does that
// deterministically. It also enforces its OWN hard timeout: the call site
// (gg-seo-autopilot-tick.sh publish_if_pending) previously wrapped the whole
// `claude -p` gate in `gtimeout 1800`; once preview-wait is factored out of that
// gate it loses that cap, so it must bound its own polling.
//
// CLI:
//   --branch <ref>        REQUIRED. error '--branch is required' + nonzero if missing.
//   --repo <owner/repo>   default 'xdawayer/oracle'
//   --timeout-ms <n>      default 600000 (10 min)
//   --poll-ms <n>         default 10000
//   --json                emit a single JSON line to stdout
//
// Exit / output contract:
//   success  -> exit 0, { ok:true,  previewUrl }
//   terminal failure/error/cancelled -> exit 1, { ok:false, reason } (NO poll-to-timeout)
//   timeout  -> exit 1, { ok:false, reason:'timeout' }
//   bad args -> exit 2, stderr message
// Never throws an uncaught stack — always structured output.
//
// Run: node gg-preview-wait.mjs --branch <ref> [--repo o/r] [--timeout-ms n] [--poll-ms n] [--json]

import { spawn } from 'node:child_process';

export const DEFAULT_REPO = 'xdawayer/oracle';
// 600000ms = 10 min, intentionally ~2x the prompt's "~5 min" guidance: Vercel
// preview builds for this repo routinely exceed 5 min under cold caches / queueing,
// and this script now owns the hard cap that the old `gtimeout 1800` gate provided.
// Not a typo — the wider bound trades a longer worst-case wait for fewer false timeouts.
export const DEFAULT_TIMEOUT_MS = 600000;
export const DEFAULT_POLL_MS = 10000;

// Vercel/GitHub deployment status states. A status is one of:
//   queued | in_progress | pending | success | error | failure | inactive
// 'success' is the only success state; the terminal-failure set ends the wait early.
const TERMINAL_FAILURE_STATES = new Set(['failure', 'error', 'cancelled', 'canceled']);
const PENDING_STATES = new Set(['queued', 'pending', 'in_progress', 'inactive', 'waiting']);

export const EXIT = { OK: 0, FAIL: 1, ARGS: 2 };

// ── arg parsing ─────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const o = {
    branch: null,
    repo: DEFAULT_REPO,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pollMs: DEFAULT_POLL_MS,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--branch') o.branch = argv[++i];
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--timeout-ms') o.timeoutMs = Number(argv[++i]);
    else if (a === '--poll-ms') o.pollMs = Number(argv[++i]);
    else if (a === '--json') o.json = true;
    // ignore unknown flags rather than crash (terse, autopilot-friendly)
  }
  return o;
}

// ── pure parse helpers (unit-testable with canned fixtures) ───────────────────

// classifyState — map a raw deployment-status `state` string to one of
// 'success' | 'failure' | 'pending'. Unknown/empty states are treated as
// pending (keep polling) so a transient/odd state never aborts prematurely.
export function classifyState(state) {
  const s = String(state || '').toLowerCase().trim();
  if (s === 'success') return 'success';
  if (TERMINAL_FAILURE_STATES.has(s)) return 'failure';
  if (PENDING_STATES.has(s)) return 'pending';
  return 'pending';
}

// parseDeployments — pull the newest deployment id from the
// `gh api repos/<repo>/deployments?ref=<branch>` JSON array (the LLM used
// `--jq '.[0].id'`). Returns { id } or { id:null } if none yet.
export function parseDeployments(json) {
  let arr;
  try {
    arr = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return { id: null, error: 'unparseable deployments JSON' };
  }
  if (!Array.isArray(arr) || arr.length === 0) return { id: null };
  const top = arr[0];
  if (!top || top.id == null) return { id: null };
  return { id: top.id };
}

// parseStatus — interpret the newest deployment-status object from
// `gh api repos/<repo>/deployments/<id>/statuses` (LLM used `.[0]`).
// Returns { kind:'success', previewUrl } | { kind:'failure', reason }
// | { kind:'pending' }. previewUrl prefers environment_url, falls back to
// target_url (matches Step 2's `environment_url` capture).
export function parseStatus(json) {
  let arr;
  try {
    arr = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return { kind: 'pending', reason: 'unparseable statuses JSON' };
  }
  if (!Array.isArray(arr) || arr.length === 0) return { kind: 'pending' };
  const top = arr[0] || {};
  const kind = classifyState(top.state);
  if (kind === 'success') {
    const previewUrl = top.environment_url || top.target_url || null;
    if (!previewUrl) {
      // success but no URL is itself a publish blocker — can't verify a preview
      // we can't reach. Treat as terminal failure rather than spin to timeout.
      return { kind: 'failure', reason: 'deployment success but no environment_url/target_url' };
    }
    return { kind: 'success', previewUrl };
  }
  if (kind === 'failure') {
    const desc = top.description ? `: ${String(top.description).slice(0, 200)}` : '';
    return { kind: 'failure', reason: `deployment ${String(top.state).toLowerCase()}${desc}` };
  }
  return { kind: 'pending' };
}

// ── gh shell-out ──────────────────────────────────────────────────────────────
// runGh — spawn `gh <args>`, resolve { code, stdout, stderr }. Never rejects;
// a spawn error (gh missing) resolves with code:127 so the caller stays structured.
export function runGh(args, { spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: 127, stdout: '', stderr: String(e && e.message ? e.message : e) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout && child.stdout.on('data', (d) => { stdout += d; });
    child.stderr && child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      resolve({ code: 127, stdout, stderr: stderr || String(e && e.message ? e.message : e) });
    });
    child.on('close', (code) => {
      resolve({ code: code == null ? 1 : code, stdout, stderr });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── poll loop ─────────────────────────────────────────────────────────────────
// waitForPreview — poll deployments + statuses until success/terminal-failure or
// the self-enforced timeout. Returns the structured result object (does NOT exit).
// `deps` lets tests inject a fake gh and a fake clock; production uses real gh + Date.now.
export async function waitForPreview(opts, deps = {}) {
  const {
    runGhFn = runGh,
    now = () => Date.now(),
    sleepFn = sleep,
  } = deps;
  const { branch, repo, timeoutMs, pollMs } = opts;

  // Guard against non-finite / non-positive timeouts (NaN/Infinity/<=0). Without
  // this, deadline=now()+NaN=NaN, `now() >= NaN` is always false, and the loop
  // never terminates — a hard hang. Return a structured failure instead.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { ok: false, reason: 'invalid timeoutMs' };
  }
  // Clamp pollMs to a sane positive finite value: a NaN/Infinity/<=0 pollMs would
  // make sleep(NaN) busy-loop (or sleep forever). Fall back to the default.
  const safePollMs =
    Number.isFinite(pollMs) && pollMs > 0 ? pollMs : DEFAULT_POLL_MS;

  const deadline = now() + timeoutMs;

  while (true) {
    // 1) newest deployment for this branch ref.
    const depRes = await runGhFn(['api', `repos/${repo}/deployments?ref=${encodeURIComponent(branch)}`]);
    if (depRes.code === 0) {
      const { id } = parseDeployments(depRes.stdout);
      if (id != null) {
        // 2) newest status for that deployment.
        const stRes = await runGhFn(['api', `repos/${repo}/deployments/${id}/statuses`]);
        if (stRes.code === 0) {
          const st = parseStatus(stRes.stdout);
          if (st.kind === 'success') return { ok: true, previewUrl: st.previewUrl };
          if (st.kind === 'failure') return { ok: false, reason: st.reason };
          // pending → fall through to wait
        }
        // gh status call failed (transient) → keep polling until timeout
      }
      // no deployment yet → keep polling until timeout
    }
    // gh deployments call failed (transient/rate-limit) → keep polling until timeout

    // self-enforced timeout: stop BEFORE sleeping past the deadline.
    if (now() >= deadline) return { ok: false, reason: 'timeout' };
    const remaining = deadline - now();
    await sleepFn(Math.max(0, Math.min(safePollMs, remaining)));
    if (now() >= deadline) return { ok: false, reason: 'timeout' };
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
export async function main(argv) {
  const o = parseArgs(argv);

  if (!o.branch) {
    process.stderr.write('--branch is required\n');
    return EXIT.ARGS;
  }
  if (!Number.isFinite(o.timeoutMs) || o.timeoutMs <= 0) {
    process.stderr.write(`invalid --timeout-ms: ${o.timeoutMs}\n`);
    return EXIT.ARGS;
  }
  if (!Number.isFinite(o.pollMs) || o.pollMs <= 0) {
    process.stderr.write(`invalid --poll-ms: ${o.pollMs}\n`);
    return EXIT.ARGS;
  }

  let result;
  try {
    result = await waitForPreview(o);
  } catch (e) {
    // belt-and-suspenders: never let a stack escape — always structured.
    result = { ok: false, reason: `internal error: ${e && e.message ? e.message : e}` };
  }

  if (o.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else if (result.ok) {
    process.stdout.write(`${result.previewUrl}\n`);
  } else {
    process.stderr.write(`preview-wait failed: ${result.reason}\n`);
  }

  return result.ok ? EXIT.OK : EXIT.FAIL;
}

// Only run when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
