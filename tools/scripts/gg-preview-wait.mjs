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

// ── Vercel commit-status + PR-comment path (2026-06 Vercel behavior) ──────────
// Vercel for this repo no longer creates a GitHub *deployment* for branch pushes;
// it posts only a commit STATUS (context "Vercel", state pending→success, target_url
// = dashboard) and a PR *comment* from vercel[bot] that carries the real
// `*.vercel.app` preview hostname. So the deployments path above finds nothing and
// times out forever. These helpers add the commit-status (readiness) + comment (URL)
// path. All pure + fixture-testable; the poll loop shells out via runGh.

// toVercelPreviewUrl — normalize + VALIDATE. The bot blob stores a bare hostname
// (`oracle-git-…vercel.app`); the markdown link is fully-qualified. Returns the URL
// ONLY if it parses to an https://*.vercel.app host — otherwise null. This is the
// trust boundary for every extraction path (codex review: don't return arbitrary
// hosts/schemes from PR-comment text).
function toVercelPreviewUrl(u) {
  const s0 = String(u || '').trim();
  if (!s0) return null;
  const s = /^https?:\/\//i.test(s0) ? s0 : `https://${s0}`;
  let parsed;
  try { parsed = new URL(s); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;
  if (!/\.vercel\.app$/i.test(parsed.hostname)) return null;
  return s;
}

// extractVercelPreviewUrl — pull the preview URL from a single vercel[bot] PR
// comment body. Prefers the structured `[vc]: #<hash>:<base64>` metadata blob
// (decode → projects[].previewUrl), falls back to the markdown `[Preview](url)`
// link, then any `*.vercel.app` — always EXCLUDING vercel.live feedback links.
// Returns a fully-qualified https URL or null.
export function extractVercelPreviewUrl(commentBody) {
  if (!commentBody) return null;
  const body = String(commentBody);
  // 1) structured metadata blob (most reliable; survives markdown changes).
  const m = body.match(/\[vc\]:\s*#[^:\n]+:([A-Za-z0-9+/=]+)/);
  if (m) {
    try {
      const json = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
      const projects = Array.isArray(json && json.projects) ? json.projects : [];
      for (const p of projects) {
        if (p && p.previewUrl) {
          const u = toVercelPreviewUrl(p.previewUrl);
          if (u) return u;
        }
      }
    } catch { /* fall through to markdown */ }
  }
  // 2) markdown [Preview](url) — the explicit preview link (skip vercel.live).
  const md = body.match(/\[Preview\]\((https?:\/\/[^)]+)\)/i);
  if (md && !/vercel\.live/i.test(md[1])) {
    const u = toVercelPreviewUrl(md[1]);
    if (u) return u;
  }
  // 3) last resort: any bare *.vercel.app host that isn't a vercel.live link.
  const any = body.match(/https?:\/\/[a-z0-9-]+\.vercel\.app[^\s)"'<]*/i);
  if (any && !/vercel\.live/i.test(any[0])) {
    const u = toVercelPreviewUrl(any[0]);
    if (u) return u;
  }
  return null;
}

// pickVercelCommitState — classify the Vercel context from a combined
// `repos/<repo>/commits/<sha>/status` response (.statuses[] rolled up per
// context). Returns 'success' | 'failure' | 'pending' | 'none'. Failure takes
// precedence (fail-closed): any Vercel failure status ends the wait.
export function pickVercelCommitState(json) {
  let obj;
  try { obj = typeof json === 'string' ? JSON.parse(json) : json; }
  catch { return 'none'; }
  const statuses = Array.isArray(obj && obj.statuses) ? obj.statuses : [];
  // Anchored: the context must START with "Vercel" (e.g. "Vercel", "Vercel – oracle"),
  // NOT merely contain it (codex review: a context like "my-vercel-check" must not
  // satisfy readiness).
  const vercel = statuses.filter((s) => /^vercel\b/i.test(String((s && s.context) || '').trim()));
  if (!vercel.length) return 'none';
  let sawSuccess = false;
  for (const s of vercel) {
    const k = classifyState(s && s.state);
    if (k === 'failure') return 'failure';
    if (k === 'success') sawSuccess = true;
  }
  return sawSuccess ? 'success' : 'pending';
}

// parseCommitSha — pull .sha from a `repos/<repo>/commits/<ref>` response.
export function parseCommitSha(json) {
  try {
    const o = typeof json === 'string' ? JSON.parse(json) : json;
    return o && o.sha ? o.sha : null;
  } catch { return null; }
}

// parsePrNumber — pick the OPEN PR number from a `repos/<repo>/commits/<sha>/pulls`
// array. OPEN-only (codex review): a closed/merged PR's bot comment can carry a
// STALE preview URL after the branch advanced, so never fall back to a closed PR —
// if no PR is open for this HEAD, keep polling. Returns number or null.
export function parsePrNumber(json) {
  let arr;
  try { arr = typeof json === 'string' ? JSON.parse(json) : json; }
  catch { return null; }
  if (!Array.isArray(arr) || !arr.length) return null;
  const open = arr.find((p) => p && p.state === 'open');
  return open && open.number != null ? open.number : null;
}

// isVercelBotLogin — the trusted comment author. GitHub App bots post as
// `vercel[bot]`; accept the bare `vercel` too. Anchored so a lookalike like
// `not-vercel[bot]` or `vercel-evil` is rejected (codex review: only trust the bot).
export function isVercelBotLogin(login) {
  return /^vercel(\[bot\])?$/i.test(String(login || '').trim());
}

// findPreviewUrlInComments — scan an `issues/<n>/comments` array (oldest→newest)
// from the END for the vercel[bot] comment carrying a preview URL. ONLY the trusted
// bot author is honored — a preview URL pulled from an arbitrary commenter's body is
// an injection vector (codex review), so the `[vc]:`-any-author fallback is removed.
export function findPreviewUrlInComments(json) {
  let arr;
  try { arr = typeof json === 'string' ? JSON.parse(json) : json; }
  catch { return null; }
  if (!Array.isArray(arr)) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    const c = arr[i];
    if (!c || !c.body) continue;
    const login = c.user && c.user.login ? c.user.login : '';
    if (!isVercelBotLogin(login)) continue;
    const url = extractVercelPreviewUrl(c.body);
    if (url) return url;
  }
  return null;
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
    // ── Path A: GitHub deployment (legacy; still works if Vercel creates one) ──
    // 1) newest deployment for this branch ref.
    let deploymentFound = false;
    let deploymentsCallOk = false;
    const depRes = await runGhFn(['api', `repos/${repo}/deployments?ref=${encodeURIComponent(branch)}`]);
    if (depRes.code === 0) {
      deploymentsCallOk = true;
      const { id } = parseDeployments(depRes.stdout);
      if (id != null) {
        deploymentFound = true; // this repo IS using deployments → Path A is authoritative
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
    }

    // ── Path B: Vercel commit-status (readiness) + vercel[bot] PR comment (URL) ──
    // Only when the deployments call SUCCEEDED but returned NO deployment object —
    // a definitive "this repo isn't using deployments" signal (the current
    // Vercel-for-GitHub behavior posts no deployment, only a commit status + a PR
    // comment). A transient deployments-call failure is NOT that signal — we retry
    // Path A next poll rather than racing Path B. Gating this way also keeps the two
    // paths from interleaving (a repo uses one mechanism or the other per push).
    // Resolve the branch HEAD sha, read its combined commit status, and on Vercel
    // success extract the preview URL from the PR comment.
    if (deploymentsCallOk && !deploymentFound) {
      const shaRes = await runGhFn(['api', `repos/${repo}/commits/${encodeURIComponent(branch)}`]);
      if (shaRes.code === 0) {
        const sha = parseCommitSha(shaRes.stdout);
        if (sha) {
          const stsRes = await runGhFn(['api', `repos/${repo}/commits/${sha}/status`]);
          if (stsRes.code === 0) {
            const vState = pickVercelCommitState(stsRes.stdout);
            if (vState === 'failure') {
              return { ok: false, reason: 'vercel deployment failed (commit-status)' };
            }
            if (vState === 'success') {
              // Deployment is Ready — now fetch the preview URL from the PR comment.
              const pullsRes = await runGhFn(['api', `repos/${repo}/commits/${sha}/pulls`]);
              if (pullsRes.code === 0) {
                const prNum = parsePrNumber(pullsRes.stdout);
                if (prNum != null) {
                  const cmtRes = await runGhFn([
                    'api', `repos/${repo}/issues/${prNum}/comments`, '--paginate',
                  ]);
                  if (cmtRes.code === 0) {
                    const url = findPreviewUrlInComments(cmtRes.stdout);
                    if (url) return { ok: true, previewUrl: url };
                    // status=success but the bot comment hasn't landed yet → keep polling
                  }
                }
                // no PR yet (comment/PR lag) → keep polling
              }
            }
            // pending / none → fall through to wait
          }
        }
      }
    }
    // any gh call failed (transient/rate-limit) → keep polling until timeout

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
