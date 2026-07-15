import { spawnSync } from 'node:child_process';
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

export function createGengrowthRepairAdapter(deps = {}) {
  const scriptsDir = resolve(deps.scriptsDir || DEFAULT_SCRIPTS);
  const flow = resolve(deps.flow || DEFAULT_FLOW);
  const runCommand = deps.runCommand || defaultRunCommand;
  const resolveTarget = deps.resolveTarget || ((event) => defaultResolveTarget(event, { flow }));
  const verifyTerminal = deps.verifyTerminal
    || ((event, target) => defaultVerifyTerminal(event, target, { runCommand, scriptsDir }));
  const invokeAgent = deps.invokeAgent
    || ((target, context) => invokeTargetRepairAgent({ target, ...context }));

  return {
    async execute({ record, strategy }) {
      const event = record.event;
      const target = await resolveTarget(event);
      const context = {
        scriptsDir,
        pageId: event.pageId,
        mdPath: target.mdPath,
      };
      if (['agent_content_asset_link', 'agent_diagnosis', 'agent_code_environment'].includes(strategy)) {
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
          return { ok: false, evidence: repaired?.evidence || { type: 'agent_repair_failed' } };
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
          evidence: {
            type: verdict.verdict === 'FAIL' ? 'fact_gate_fail' : 'reviewer_tool_failure',
            strategy,
            verdict: verdict.verdict,
            reason: verdict.reason,
            code: reviewed.code,
            stdout: reviewed.stdout,
            stderr: reviewed.stderr,
            timedOut: reviewed.timedOut,
          },
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
          evidence: {
            type: 'publish_fail',
            strategy,
            code: published.code,
            stdout: published.stdout,
            stderr: published.stderr,
            timedOut: published.timedOut,
          },
        };
      }

      const verified = await verifyTerminal(event, target);
      if (verified?.ok === true && verified?.terminal === 'published') {
        return { terminal: 'published', evidence: verified };
      }
      return {
        ok: false,
        evidence: {
          type: 'terminal_verifier_failed',
          strategy,
          verification: verified || null,
        },
      };
    },
  };
}
