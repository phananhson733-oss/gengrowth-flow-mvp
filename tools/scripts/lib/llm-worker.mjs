// llm-worker.mjs — the LLM CLI argv contract, extracted from
// gg-llm-orchestrator.mjs buildCommand. PURE: no spawn, no fs. Given a model
// and opts, returns {bin, args} byte-for-byte identical to the inline argv the
// orchestrator builds, so the orchestrator keeps runAttempt + the watchdog /
// downgrade / rate-limit guards untouched.
//
// Env-default semantics MUST match the orchestrator's module-level consts:
//   CLAUDE_MODEL  = process.env.GG_CLAUDE_MODEL  || 'claude-sonnet-4-6'
//   CLAUDE_EFFORT = process.env.GG_CLAUDE_EFFORT || 'high'
//   CODEX_EFFORT  = process.env.GG_CODEX_EFFORT  || 'xhigh'
// The orchestrator passes opts.claudeModel / opts.claudeEffort for the
// rate-limit fallback (Opus retry); those take precedence over the env default,
// exactly as the original `opts.claudeModel || CLAUDE_MODEL` did.

const DEFAULT_CLAUDE_MODEL = process.env.GG_CLAUDE_MODEL || 'claude-sonnet-4-6';
const DEFAULT_CLAUDE_EFFORT = process.env.GG_CLAUDE_EFFORT || 'high';
const DEFAULT_CODEX_EFFORT = process.env.GG_CODEX_EFFORT || 'xhigh';

// Build the argv array for one model. `bin` is resolved via PATH on spawn by
// the caller. Returns only {bin, args}; the orchestrator layers
// stdinFromFile / stdoutToFile on top, so this stays pure and trivially testable.
export function buildWorkerCommand(model, opts = {}) {
  switch (model) {
    case 'claude':
      // --model is load-bearing — without it the CLI uses its default session
      // model. --effort sets reasoning depth. opts.claudeModel / opts.claudeEffort
      // let the rate-limit fallback swap in the Opus model/effort for one retry.
      return {
        bin: 'claude',
        args: [
          '-p',
          '--model', opts.claudeModel || DEFAULT_CLAUDE_MODEL,
          '--effort', opts.claudeEffort || DEFAULT_CLAUDE_EFFORT,
        ],
      };
    case 'codex':
      return {
        bin: 'codex',
        args: ['exec', '-c', 'model=gpt-5.5', '-c', `reasoning_effort=${opts.codexEffort || DEFAULT_CODEX_EFFORT}`, '-'],
      };
    case 'gemini':
      return {
        bin: 'gemini',
        args: ['--model', 'gemini-2.5-pro'],
      };
    default:
      throw new Error(`unknown model: ${model}`);
  }
}

export default buildWorkerCommand;
