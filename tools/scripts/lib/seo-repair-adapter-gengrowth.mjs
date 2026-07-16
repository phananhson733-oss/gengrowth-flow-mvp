import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyCodex } from '../gg-preview-gate.mjs';
import { invokeTargetRepairAgent } from './seo-repair-controller.mjs';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCRIPTS = resolve(LIB_DIR, '..');
const DEFAULT_FLOW = resolve(DEFAULT_SCRIPTS, '../..');

function resultFromSpawn(result) {
  return {
    code: result.status ?? 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || result.error?.message || ''),
    timedOut: result.error?.code === 'ETIMEDOUT',
  };
}

async function defaultRunCommand(argv, { cwd = DEFAULT_FLOW, env = process.env, timeoutMs = 600_000 } = {}) {
  return resultFromSpawn(spawnSync(argv[0], argv.slice(1), {
    cwd,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  }));
}

function parseSlug(markdown) {
  const frontmatter = String(markdown || '').match(/^---\s*\n([\s\S]*?)\n---/m)?.[1] || '';
  return frontmatter.match(/^slug:\s*["']?([^\n"']+)/m)?.[1]?.trim() || '';
}

async function defaultResolveTarget(event, { flow = DEFAULT_FLOW } = {}) {
  const stagingDir = resolve(process.env.GG_GENGROWTH_STAGING_DIR || join(flow, '_staging'));
  const prefix = `${event.pageId}-`;
  const candidates = readdirSync(stagingDir)
    .filter((name) => name.startsWith(prefix) && /-v8\.md$/i.test(name))
    .sort()
    .reverse();
  for (const name of candidates) {
    const mdPath = resolve(stagingDir, name);
    if (!mdPath.startsWith(`${stagingDir}${sep}`)) continue;
    const manifestPath = mdPath.replace(/\.md$/, '.manifest.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { continue; }
    if (manifest?.phase2_checks?.overall !== 'pass') continue;
    const slug = parseSlug(readFileSync(mdPath, 'utf8'));
    if (!slug || (event.slug && slug !== event.slug)) continue;
    return { mdPath, manifestPath, manifest, slug };
  }
  throw new Error(`publish-ready Gengrowth target not found for ${event.pageId}`);
}

function parseLastJson(stdout) {
  for (const line of String(stdout || '').trim().split('\n').reverse()) {
    try { return JSON.parse(line); } catch {}
  }
  return null;
}

function gengrowthArtifactSha(target) {
  try {
    return createHash('sha256').update(readFileSync(target.mdPath)).digest('hex');
  } catch {
    return null;
  }
}

async function defaultVerifyTerminal(event, target, {
  runCommand = defaultRunCommand,
  scriptsDir = DEFAULT_SCRIPTS,
} = {}) {
  const result = await runCommand([
    'node',
    join(scriptsDir, 'gg-seo-repair-verify.mjs'),
    '--site', 'gengrowth',
    '--page-id', event.pageId,
    '--slug', target.slug,
    '--json',
  ], { timeoutMs: 180_000 });
  const output = parseLastJson(result.stdout);
  return output?.results?.[0] || output || {
    ok: false,
    terminal: 'pending',
    reason: result.stderr || `verifier exited ${result.code}`,
  };
}

export function isAllowedGengrowthAction(argv, context) {
  if (!Array.isArray(argv)) return false;
  const reviewer = [
    'node',
    join(context.scriptsDir, 'gg-codex-pr-review.mjs'),
    '--source',
    context.mdPath,
  ];
  const publisher = [
    'node',
    join(context.scriptsDir, 'gg-gengrowth-publish.mjs'),
    '--apply',
    '--pages',
    context.pageId,
    '--limit',
    '1',
  ];
  return [reviewer, publisher].some((allowed) => (
    allowed.length === argv.length && allowed.every((part, index) => part === argv[index])
  ));
}

function isAuthoringEvent(event) {
  return [event?.stage, event?.lane]
    .some((value) => String(value || '').toLowerCase().includes('author'));
}

export async function recoverGengrowthAuthoring(event, deps = {}) {
  const scriptsDir = resolve(deps.scriptsDir || DEFAULT_SCRIPTS);
  const flow = resolve(deps.flow || DEFAULT_FLOW);
  const runCommand = deps.runCommand || defaultRunCommand;
  const resolveAuthoredTarget = deps.resolveAuthoredTarget
    || ((value) => defaultResolveTarget(value, { flow }));
  const pageId = String(event?.pageId || '');
  if (!/^PG-[A-Z0-9]+-[0-9]+$/.test(pageId)) {
    return {
      target: null,
      evidence: { type: 'author_recovery_failed', reason: 'invalid_page_id', pageId },
    };
  }
  const commands = [
    {
      role: 'retry_author',
      argv: ['node', join(scriptsDir, 'gg-seo-autopilot.mjs'), '--retry-author', '--task', pageId],
      timeoutMs: 2 * 60 * 1000,
    },
    {
      role: 'author',
      argv: ['node', join(scriptsDir, 'gg-seo-autopilot.mjs'), '--author', '--task', pageId, '--limit', '1'],
      timeoutMs: Math.min(
        20 * 60 * 1000,
        Math.max(1, Number(process.env.GG_GENGROWTH_AUTHOR_RECOVERY_TIMEOUT_MS) || (20 * 60 * 1000)),
      ),
    },
    {
      role: 'handoff',
      argv: ['node', join(scriptsDir, 'gg-gengrowth-author-handoff.mjs'), '--page-id', pageId],
      timeoutMs: 60 * 1000,
    },
  ];
  const results = [];
  let agentMutationInvoked = false;
  for (const command of commands) {
    let result;
    try {
      result = await runCommand(command.argv, {
        cwd: flow,
        env: process.env,
        timeoutMs: command.timeoutMs,
      });
    } catch (error) {
      result = {
        code: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
      };
    }
    if (command.role === 'author') agentMutationInvoked = true;
    results.push({
      role: command.role,
      argv: command.argv,
      code: result?.code ?? 1,
      timedOut: result?.timedOut === true,
      stdout: String(result?.stdout || '').slice(-4_096),
      stderr: String(result?.stderr || '').slice(-4_096),
    });
    const failed = result?.code !== 0 || result?.timedOut;
    if (failed && command.role !== 'author') {
      return {
        target: null,
        agentMutationInvoked,
        evidence: {
          type: 'author_recovery_failed',
          failedCommand: command.argv,
          results,
        },
      };
    }
  }
  try {
    const target = await resolveAuthoredTarget(event);
    return {
      target,
      agentMutationInvoked,
      evidence: {
        type: 'author_recovered_and_handed_off',
        authorCut: results.find((result) => result.role === 'author')?.code !== 0
          || results.find((result) => result.role === 'author')?.timedOut === true,
        results,
      },
    };
  } catch (error) {
    return {
      target: null,
      agentMutationInvoked,
      evidence: {
        type: 'author_recovery_failed',
        reason: 'publish_ready_target_missing_after_handoff',
        message: error instanceof Error ? error.message : String(error),
        results,
      },
    };
  }
}

export function createGengrowthRepairAdapter(deps = {}) {
  const scriptsDir = resolve(deps.scriptsDir || DEFAULT_SCRIPTS);
  const flow = resolve(deps.flow || DEFAULT_FLOW);
  const runCommand = deps.runCommand || defaultRunCommand;
  const resolveTarget = deps.resolveTarget || ((event) => defaultResolveTarget(event, { flow }));
  const resolveAuthoredTarget = deps.resolveAuthoredTarget || resolveTarget;
  const verifyTerminal = deps.verifyTerminal
    || ((event, target) => defaultVerifyTerminal(event, target, { runCommand, scriptsDir }));
  const invokeAgent = deps.invokeAgent
    || ((target, context) => invokeTargetRepairAgent({ target, ...context }));

  return {
    async execute({ record, strategy }) {
      const event = record.event;
      let target;
      let authorRecoveryEvidence = null;
      let authorMutationInvoked = false;
      if (isAuthoringEvent(event)) {
        const recovered = await recoverGengrowthAuthoring(event, {
          scriptsDir,
          flow,
          runCommand,
          resolveAuthoredTarget,
        });
        if (!recovered.target) {
          return {
            ok: false,
            agentMutationInvoked: recovered.agentMutationInvoked === true,
            evidence: recovered.evidence,
          };
        }
        target = recovered.target;
        authorRecoveryEvidence = recovered.evidence;
        authorMutationInvoked = recovered.agentMutationInvoked === true;
      } else {
        try {
          target = await resolveTarget(event);
        } catch (error) {
          return {
            ok: false,
            agentMutationInvoked: false,
            evidence: {
              type: 'target_resolution_failed',
              message: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }
      const withAuthorRecovery = (evidence) => ({
        ...(evidence || {}),
        ...(gengrowthArtifactSha(target) ? { artifactSha: gengrowthArtifactSha(target) } : {}),
        ...(authorRecoveryEvidence ? { authorRecovery: authorRecoveryEvidence } : {}),
      });
      const context = {
        scriptsDir,
        pageId: event.pageId,
        mdPath: target.mdPath,
      };
      const needsAgent = ['agent_content_asset_link', 'agent_diagnosis', 'agent_code_environment']
        .includes(strategy);
      const mutationInvoked = () => needsAgent || authorMutationInvoked;
      if (needsAgent) {
        const repaired = await invokeAgent({
          site: 'gengrowth',
          pageId: event.pageId,
          slug: target.slug,
          articleFile: target.mdPath,
          changedFiles: [target.mdPath, target.manifestPath].filter(Boolean),
          assetFiles: [],
          verifiedLinkCandidates: [],
          gateEvidence: [event.summary, event.stderr].filter(Boolean).join('\n'),
          allowedActions: [
            ['node', join(scriptsDir, 'gg-codex-pr-review.mjs'), '--source', target.mdPath],
            ['node', join(scriptsDir, 'gg-gengrowth-publish.mjs'), '--apply', '--pages', event.pageId, '--limit', '1'],
          ],
          terminalVerifier: [
            'node', join(scriptsDir, 'gg-seo-repair-verify.mjs'), '--site', 'gengrowth',
            '--page-id', event.pageId, '--slug', target.slug, '--json',
          ],
        }, { record, strategy });
        if (repaired?.ok !== true) {
          return {
            ok: false,
            agentMutationInvoked: true,
            evidence: withAuthorRecovery(repaired?.evidence || { type: 'agent_repair_failed' }),
          };
        }
      }
      const reviewerArgv = [
        'node',
        join(scriptsDir, 'gg-codex-pr-review.mjs'),
        '--source',
        target.mdPath,
      ];
      if (!isAllowedGengrowthAction(reviewerArgv, context)) {
        throw new Error('reviewer action rejected by Gengrowth adapter whitelist');
      }
      const reviewed = await runCommand(reviewerArgv, {
        cwd: flow,
        env: process.env,
        timeoutMs: Number(process.env.GG_CODEX_REVIEW_TIMEOUT_MS) || 600_000,
      });
      const verdict = classifyCodex({
        code: reviewed.code,
        stdout: reviewed.stdout,
        timedOut: reviewed.timedOut,
      });
      if (verdict.verdict !== 'PASS') {
        return {
          ok: false,
          agentMutationInvoked: mutationInvoked(),
          evidence: withAuthorRecovery({
            type: verdict.verdict === 'FAIL' ? 'fact_gate_fail' : 'reviewer_tool_failure',
            strategy,
            verdict: verdict.verdict,
            reason: verdict.reason,
            code: reviewed.code,
            stdout: reviewed.stdout,
            stderr: reviewed.stderr,
            timedOut: reviewed.timedOut,
          }),
        };
      }

      const publishArgv = [
        'node',
        join(scriptsDir, 'gg-gengrowth-publish.mjs'),
        '--apply',
        '--pages',
        event.pageId,
        '--limit',
        '1',
      ];
      if (!isAllowedGengrowthAction(publishArgv, context)) {
        throw new Error('publisher action rejected by Gengrowth adapter whitelist');
      }
      const published = await runCommand(publishArgv, {
        cwd: flow,
        env: process.env,
        timeoutMs: Number(process.env.GG_GENGROWTH_PUBLISH_TIMEOUT_MS) || 300_000,
      });
      if (published.code !== 0 || published.timedOut) {
        return {
          ok: false,
          agentMutationInvoked: mutationInvoked(),
          evidence: withAuthorRecovery({
            type: 'publish_fail',
            strategy,
            code: published.code,
            stdout: published.stdout,
            stderr: published.stderr,
            timedOut: published.timedOut,
          }),
        };
      }

      const verified = await verifyTerminal(event, target);
      if (verified?.ok === true && verified?.terminal === 'published') {
        return {
          terminal: 'published',
          agentMutationInvoked: mutationInvoked(),
          evidence: withAuthorRecovery(verified),
        };
      }
      return {
        ok: false,
        agentMutationInvoked: mutationInvoked(),
        evidence: withAuthorRecovery({
          type: 'terminal_verifier_failed',
          strategy,
          verification: verified || null,
        }),
      };
    },
  };
}
