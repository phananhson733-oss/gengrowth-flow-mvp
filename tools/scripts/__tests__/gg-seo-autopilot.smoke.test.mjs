#!/usr/bin/env node
// Smoke tests for gg-seo-autopilot.mjs safety gates.
// Run: node --test tools/scripts/__tests__/gg-seo-autopilot.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'gg-seo-autopilot.mjs');
const REVIEWED_HEAD = 'a'.repeat(40);

function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), 'gg-seo-autopilot-'));
  const ops = join(root, 'ops');
  const tasks = join(ops, 'inbox-maboyang', '06-tasks', 'tasks');
  const oracle = join(root, 'oracle');
  const bin = join(root, 'bin');
  mkdirSync(tasks, { recursive: true });
  mkdirSync(oracle, { recursive: true });
  mkdirSync(bin, { recursive: true });
  return {
    root,
    ops,
    tasks,
    oracle,
    bin,
    state: join(root, 'flow-state'),
    claimsPath: join(tasks, '.autopilot-claims.json'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runAuto(h, args, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: join(__dirname, '..', '..', '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${h.bin}:${process.env.PATH}`,
      GG_OPS_DIR: h.ops,
      GG_ORACLE_DIR: h.oracle,
      GG_FLOW_REPO: join(__dirname, '..', '..', '..'),
      GG_FLOW_STATE_DIR: h.state,
      GG_AUTHOR_GLOBAL_LOCK: join(h.root, 'global-author.lock'),
      GG_SEO_REPAIR_CONTROLLER_V2_ENABLED: '0',
      GG_AUTOPILOT_NO_NOTIFY: '1', // never send a real Feishu push from tests
      GG_AUTOPILOT_NO_INDEX_TRACKING: '1',
      ...extraEnv,
    },
  });
}

// 异步版 runAuto：通知用例的本地飞书 mock server 跑在测试进程里，spawnSync 会把
// 事件循环卡死（server 无法应答 → 子进程 fetch 超时）。凡是需要 mock server 存活
// 的用例必须用这个异步 runner。
function runAutoAsync(h, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: join(__dirname, '..', '..', '..'),
      env: {
        ...process.env,
        PATH: `${h.bin}:${process.env.PATH}`,
        GG_OPS_DIR: h.ops,
        GG_ORACLE_DIR: h.oracle,
        GG_FLOW_REPO: join(__dirname, '..', '..', '..'),
        GG_FLOW_STATE_DIR: h.state,
        GG_AUTHOR_GLOBAL_LOCK: join(h.root, 'global-author.lock'),
        GG_SEO_REPAIR_CONTROLLER_V2_ENABLED: '0',
        GG_AUTOPILOT_NO_NOTIFY: '1', // never send a real Feishu push from tests
        GG_AUTOPILOT_NO_INDEX_TRACKING: '1',
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function writeFakeRepairController(h, { exitCode = 0 } = {}) {
  const file = join(h.root, 'fake-repair-controller.mjs');
  const calls = join(h.root, 'repair-controller-calls.log');
  writeFileSync(file, [
    "import { appendFileSync, existsSync } from 'node:fs';",
    "if (existsSync(process.env.GG_TEST_CLAIMS_LOCK)) {",
    "  process.stderr.write('controller invoked while claims lock held\\n');",
    '  process.exit(19);',
    '}',
    "appendFileSync(process.env.GG_TEST_REPAIR_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');",
    `process.stdout.write(JSON.stringify({ ok: ${exitCode === 0}, command: 'drain', busy: false }) + '\\n');`,
    `process.exit(${exitCode});`,
    '',
  ].join('\n'));
  return { file, calls };
}

function writeClaims(h, claims) {
  writeFileSync(h.claimsPath, JSON.stringify(claims, null, 2) + '\n');
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initOracleWithOrigin(h) {
  const origin = join(h.root, 'origin.git');
  git(h.root, ['init', '--bare', origin]);
  git(h.oracle, ['init', '-b', 'main']);
  git(h.oracle, ['config', 'user.name', 'Test User']);
  git(h.oracle, ['config', 'user.email', 'test@example.com']);
  mkdirSync(join(h.oracle, 'data', 'articles'), { recursive: true });
  mkdirSync(join(h.oracle, 'data', 'authors'), { recursive: true });
  mkdirSync(join(h.oracle, 'scripts'), { recursive: true });
  writeFileSync(join(h.oracle, 'README.md'), 'clean\n');
  writeFileSync(join(h.oracle, 'data', 'articles', 'index.ts'), 'const ARTICLES_EN: WikiArticle[] = [\n];\nconst ARTICLES_ZH: WikiArticle[] = [\n];\n');
  writeFileSync(join(h.oracle, 'data', 'authors', 'index.ts'), 'export const authors = [{ id: "test-author" }];\n');
  writeFileSync(join(h.oracle, 'scripts', 'generate-seo-pages.mjs'), 'const ARTICLE_SLUGS = [\n];\nconst ARTICLE_SLUGS_EN_ONLY = [\n];\n');
  git(h.oracle, ['add', '.']);
  git(h.oracle, ['commit', '-m', 'init']);
  git(h.oracle, ['remote', 'add', 'origin', origin]);
  git(h.oracle, ['push', '-u', 'origin', 'main']);
  git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
}

function addRemoteMainCommit(h) {
  const clone = join(h.root, 'remote-clone');
  git(h.root, ['clone', join(h.root, 'origin.git'), clone]);
  git(clone, ['config', 'user.name', 'Remote User']);
  git(clone, ['config', 'user.email', 'remote@example.com']);
  writeFileSync(join(clone, 'README.md'), 'remote update\n');
  git(clone, ['add', 'README.md']);
  git(clone, ['commit', '-m', 'remote update']);
  git(clone, ['push', 'origin', 'main']);
}

function writeStubFlow(h, slug = 'test-slug', { zh = false } = {}) {
  const flow = join(h.root, 'flow');
  const scripts = join(flow, 'tools', 'scripts');
  const staging = join(flow, '_staging');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(staging, { recursive: true });
  mkdirSync(join(staging, 'zh-demo'), { recursive: true });
  writeFileSync(join(staging, 'PG-TEST-001-en.md'), `---\nslug: ${slug}\nauthor_id: test-author\n---\n# Test\n\nBody.\n`);
  writeFileSync(join(staging, 'PG-TEST-001-en.manifest.json'), JSON.stringify({ phase2_checks: { overall: 'pass' } }));
  if (zh) writeFileSync(join(staging, 'zh-demo', 'PG-TEST-001-zh.md'), `---\nslug: ${slug}\nauthor_id: test-author\n---\n# 测试\n\n正文。\n`);
  writeFileSync(join(scripts, 'gg-md-to-oracle-ts.mjs'), `#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const out = process.argv[process.argv.indexOf('--out') + 1];
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, 'export const testSlugEn = { authorId: "test-author" };\\n');
`);
  writeFileSync(join(scripts, 'gg-oracle-register-index.mjs'), 'process.exit(0);\n');
  return flow;
}

function writeStubAuthorBackfillFlow(h, { seedEn = true, blankSearchVolume = false, renderRequiresSearchVolume = false } = {}) {
  const flow = join(h.root, 'flow-author');
  const scripts = join(flow, 'tools', 'scripts');
  const staging = join(flow, '_staging');
  const prompts = join(flow, '.gg-cache', 'prompts');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(staging, 'zh-demo'), { recursive: true });
  mkdirSync(prompts, { recursive: true });
  if (seedEn) {
    writeFileSync(join(staging, 'PG-TEST-001-en.md'), '---\nslug: test-slug\nauthor_id: test-author\n---\n# Test\n\nBody.\n');
    writeFileSync(join(staging, 'PG-TEST-001-en.manifest.json'), JSON.stringify({ phase2_checks: { overall: 'pass' } }));
  }

  writeFileSync(join(scripts, 'gg-sheet-pull.mjs'), `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const args = process.argv.slice(2);
const out = args[args.indexOf('--out') + 1];
mkdirSync(dirname(out), { recursive: true });
const row = {
  source_row: '7',
  page_id: 'page_test_keyword',
  brief: {
    target_keyword: 'test keyword',
    entity: 'test keyword',
    associated_keywords: ['test keyword meaning'],
    search_volume: '${blankSearchVolume ? '' : '100'}',
    content_angle: 'angle',
    cta_target_url: '工具页',
    template: 'Definition',
    tier: 'T2'
  }
};
writeFileSync(out, JSON.stringify({ rows: [row] }));
`);

  writeFileSync(join(scripts, 'gg-sheet-to-brief.mjs'), `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const args = process.argv.slice(2);
const out = args[args.indexOf('--out') + 1];
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({
  'PG-TEST-001': {
    target_keyword: 'test keyword',
    entity: 'test keyword',
    associated_keywords: ['test keyword meaning'],
    search_volume: '${blankSearchVolume ? '' : '100'}',
    content_angle: 'angle',
    cta_id: 'cta_tools_hub',
    cta_text: 'Explore astrology tools',
    cta_target_url: 'https://astrologywiki.com/en/tools',
    cta_selection_reason: 'wildcard_fallback:cta_tools_hub',
    cluster_domain: 'mystic',
    cluster_jtbd: 'jtbd',
    internal_link_rule: 'link naturally',
    tier_gate_block: 'tier gate',
    rl6_hint: 'rl6',
    friction_themes: [{ theme: 'theme', scrubbed_quote: 'quote' }],
    template: 'Definition'
  }
}, null, 2));
`);

  writeFileSync(join(scripts, 'gg-gbrain-rag.mjs'), `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const pageId = args[args.indexOf('--page-id') + 1];
mkdirSync('.gg-cache/' + pageId, { recursive: true });
writeFileSync('.gg-cache/' + pageId + '/obsidian-rag.json', JSON.stringify({ ok: true }));
`);

  writeFileSync(join(scripts, 'gg-entity-passport.mjs'), `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const pageId = args[args.indexOf('--page-id') + 1];
mkdirSync('.gg-cache/' + pageId, { recursive: true });
writeFileSync('.gg-cache/' + pageId + '/entity-passport.rag.json', JSON.stringify({ pad: 'x'.repeat(800) }));
`);

  writeFileSync(join(scripts, 'gg-render-batch.mjs'), `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const isZh = args.includes('--language') && args[args.indexOf('--language') + 1] === 'zh';
const overrides = args[args.indexOf('--overrides') + 1];
if (${renderRequiresSearchVolume ? 'true' : 'false'} && overrides) {
  const j = JSON.parse(readFileSync(overrides, 'utf8'));
  const entry = j['PG-TEST-001'];
  if (!entry || entry.search_volume === '') {
    process.stdout.write('skipped — missing cfg fields: search_volume\\n');
    process.exit(0);
  }
}
mkdirSync('.gg-cache/prompts', { recursive: true });
const suffix = isZh ? '.zh' : '';
writeFileSync('.gg-cache/prompts/PG-TEST-001.v8' + suffix + '-prompt.md', '# prompt\\n\\nbody');
writeFileSync('.gg-cache/prompts/PG-TEST-001.v8' + suffix + '-fixture.json', JSON.stringify({ language: isZh ? 'zh' : 'en' }));
`);

  writeFileSync(join(scripts, 'gg-llm-orchestrator.mjs'), `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const outDir = args[args.indexOf('--out-dir') + 1];
const pageId = args[args.indexOf('--page-id') + 1];
const prompt = args[args.indexOf('--prompt') + 1];
if (process.env.GG_TEST_AUTHOR_PROMPT_LOG) {
  appendFileSync(process.env.GG_TEST_AUTHOR_PROMPT_LOG, '\\n===PROMPT===\\n' + readFileSync(prompt, 'utf8'));
}
mkdirSync(outDir, { recursive: true });
const statePath = process.env.GG_TEST_ORCHESTRATOR_STATE || '';
const attempt = statePath && existsSync(statePath) ? Number(readFileSync(statePath, 'utf8')) : 0;
if (statePath) writeFileSync(statePath, String(attempt + 1));
if (Number(process.env.GG_TEST_ORCHESTRATOR_NO_DRAFT_AT || 0) === attempt + 1) {
  rmSync(outDir + '/' + pageId + '-claude-v8.md', { force: true });
  process.stderr.write('simulated watchdog with no draft\\n');
  process.exit(2);
}
writeFileSync(outDir + '/' + pageId + '-claude-v8.md', '# 中文稿\\n\\n这里是中文正文。');
`);

  writeFileSync(join(scripts, '_phase2-validate.mjs'), `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const pageId = args[args.indexOf('--page-id') + 1];
const tag = args[args.indexOf('--tag') + 1];
const lang = args.includes('--language') ? args[args.indexOf('--language') + 1] : 'en';
const failures = JSON.parse(process.env.GG_TEST_PHASE2_FAILURES || '[]');
const statePath = process.env.GG_TEST_PHASE2_STATE || '';
const attempt = statePath && existsSync(statePath) ? Number(readFileSync(statePath, 'utf8')) : 0;
if (statePath) writeFileSync(statePath, String(attempt + 1));
if (attempt < failures.length) {
  process.stderr.write(failures[attempt] + '\\n');
  process.exit(11);
}
const dir = lang === 'zh' ? '_staging/zh-demo' : '_staging';
mkdirSync(dir, { recursive: true });
writeFileSync(dir + '/' + pageId + '-' + tag + '.md', '---\\nslug: test-slug\\nauthor_id: test-author\\n---\\n# 成稿\\n\\n正文。\\n');
writeFileSync(dir + '/' + pageId + '-' + tag + '.manifest.json', JSON.stringify({ phase2_checks: { overall: 'pass' } }));
`);

  writeFileSync(join(scripts, 'gg-author-review.mjs'), 'process.exit(0);\n');
  writeFileSync(join(scripts, 'gg-author-repair.mjs'), `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const source = args[args.indexOf('--source') + 1];
const out = args[args.indexOf('--out') + 1];
if (process.env.GG_TEST_REPAIR_WORKER_CALLS) {
  appendFileSync(process.env.GG_TEST_REPAIR_WORKER_CALLS, JSON.stringify(args) + '\\n');
}
writeFileSync(out, readFileSync(source, 'utf8') + '\\n\\nRepair pass.');
`);
  return flow;
}

function writeStubAuthorParkFlow(h) {
  const flow = join(h.root, 'flow-author-park');
  const scripts = join(flow, 'tools', 'scripts');
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, 'gg-sheet-pull.mjs'), `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const args = process.argv.slice(2);
const out = args[args.indexOf('--out') + 1];
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ rows: [] }));
`);
  return flow;
}

test('--merge refuses a pushed-preview branch that has not been marked verified', () => {
  const h = makeHarness();
  try {
    const marker = join(h.root, 'gh-called');
    writeFileSync(join(h.bin, 'gh'), `#!/bin/sh\ntouch "${marker}"\nexit 0\n`, { mode: 0o755 });
    writeClaims(h, {
      'PG-TEST-001': {
        status: 'pushed-preview',
        branch: 'seo/auto/2026-06-03-PG-TEST-001',
        slug: 'test-slug',
      },
    });

    const r = runAuto(h, ['--merge', '--branch', 'seo/auto/2026-06-03-PG-TEST-001']);

    assert.notEqual(r.status, 0, 'merge should fail before calling gh');
    assert.match(`${r.stdout}${r.stderr}`, /verified-preview/);
    assert.equal(existsSync(marker), false, 'gh must not be called when ledger is unverified');
  } finally {
    h.cleanup();
  }
});

test('--cluster-link-dry-run requires an explicit attested input instead of falling back to article publishing', () => {
  const h = makeHarness();
  try {
    const r = runAuto(h, ['--cluster-link-dry-run']);
    assert.notEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /cluster-link-input/i);
  } finally {
    h.cleanup();
  }
});

test('--cluster-link-pr requires an explicit attested input before it can touch the Oracle baseline', () => {
  const h = makeHarness();
  try {
    const r = runAuto(h, ['--cluster-link-pr']);
    assert.notEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /cluster-link-input/i);
  } finally {
    h.cleanup();
  }
});

test('--cluster-link-pr rejects an invalid input before attempting Oracle synchronization', () => {
  const h = makeHarness();
  try {
    const input = join(h.root, 'invalid-cluster-links.json');
    writeFileSync(input, JSON.stringify({ version: 1, snapshot_id: 'c'.repeat(64), approved_cluster_ids: [], pages: [] }));
    const r = runAuto(h, ['--cluster-link-pr', '--cluster-link-input', input]);
    assert.notEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /approved_cluster_ids/i);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /synced oracle/i);
  } finally {
    h.cleanup();
  }
});

test('--cluster-link-pr changes only a dedicated review branch and never the Oracle baseline', () => {
  const h = makeHarness();
  try {
    initOracleWithOrigin(h);
    const articles = join(h.oracle, 'data', 'articles');
    const alpha = join(articles, 'alpha.ts');
    const beta = join(articles, 'beta.ts');
    writeFileSync(alpha, 'export const alpha = { content: `# Alpha\n\n## Related Reading\n\n- Manual alpha\n` };\n');
    writeFileSync(beta, 'export const beta = { content: `# Beta\n\n## Related Reading\n\n- Manual beta\n` };\n');
    writeFileSync(join(articles, 'index.ts'), 'import { alpha } from "./alpha";\nimport { beta } from "./beta";\nexport { alpha, beta };\n');
    writeFileSync(join(h.oracle, 'scripts', 'check-internal-links.mjs'), 'process.exit(0);\n');
    writeFileSync(join(h.oracle, 'package.json'), JSON.stringify({ scripts: { build: 'true' } }));
    git(h.oracle, ['add', '.']);
    git(h.oracle, ['commit', '-m', 'seed articles']);
    git(h.oracle, ['push', 'origin', 'main']);
    const input = join(h.root, 'cluster-links.json');
    const snapshot = 'b'.repeat(64);
    writeFileSync(input, JSON.stringify({
      version: 1,
      snapshot_id: snapshot,
      approved_cluster_ids: ['test_cluster'],
      pages: [
        { page_id: 'PG-001', cluster_id: 'test_cluster', page_role: 'Hub', slug: 'alpha', title: 'Alpha', published: true },
        { page_id: 'PG-002', cluster_id: 'test_cluster', page_role: 'Spoke', slug: 'beta', title: 'Beta', published: true },
      ],
    }));
    writeFileSync(join(h.bin, 'gh'), '#!/bin/sh\nif [ "$1" = "pr" ] && [ "$2" = "create" ]; then printf "%s\\n" "https://example.test/pr/cluster"; exit 0; fi\nexit 1\n', { mode: 0o755 });

    const r = runAuto(h, ['--cluster-link-pr', '--cluster-link-input', input], {
      GG_ORACLE_WORKTREE_ROOT: join(h.root, 'worktrees'),
    });

    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const result = JSON.parse(r.stdout);
    assert.equal(result.status, 'pushed-preview');
    assert.equal(result.pr, 'https://example.test/pr/cluster');
    assert.doesNotMatch(readFileSync(alpha, 'utf8'), /gg-cluster-links:start/);
    const origin = join(h.root, 'origin.git');
    const branch = `refs/heads/seo/internal-links/${snapshot.slice(0, 12)}`;
    const pushed = git(h.root, [`--git-dir=${origin}`, 'show', `${branch}:data/articles/alpha.ts`]);
    assert.match(pushed, /gg-cluster-links:start/);
    const main = git(h.root, [`--git-dir=${origin}`, 'show', 'refs/heads/main:data/articles/alpha.ts']);
    assert.doesNotMatch(main, /gg-cluster-links:start/);
  } finally {
    h.cleanup();
  }
});

test('--mark-verified records preview evidence and allows the subsequent merge command to reach gh', () => {
  const h = makeHarness();
  try {
    const marker = join(h.root, 'gh-called');
    writeFileSync(
      join(h.bin, 'gh'),
      `#!/bin/sh\ntouch "${marker}"\nprintf '%s' "${REVIEWED_HEAD}"\nexit 0\n`,
      { mode: 0o755 },
    );
    writeClaims(h, {
      'PG-TEST-001': {
        status: 'pushed-preview',
        branch: 'seo/auto/2026-06-03-PG-TEST-001',
        slug: 'test-slug',
        zh: true,
      },
    });

    const marked = runAuto(h, [
      '--mark-verified',
      '--branch',
      'seo/auto/2026-06-03-PG-TEST-001',
      '--preview-url',
      'https://example-preview.vercel.app',
      '--evidence',
      'codex+chrome manual pass',
      '--head-ref-oid',
      REVIEWED_HEAD,
    ]);
    assert.equal(marked.status, 0, `${marked.stdout}${marked.stderr}`);
    const claims = JSON.parse(readFileSync(h.claimsPath, 'utf8'));
    assert.equal(claims['PG-TEST-001'].status, 'verified-preview');
    assert.equal(claims['PG-TEST-001'].previewUrl, 'https://example-preview.vercel.app');
    assert.match(claims['PG-TEST-001'].verifiedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(claims['PG-TEST-001'].headRefOid, REVIEWED_HEAD);

    const merged = runAuto(h, ['--merge', '--branch', 'seo/auto/2026-06-03-PG-TEST-001']);
    assert.equal(existsSync(marker), true, `${merged.stdout}${merged.stderr}`);
  } finally {
    h.cleanup();
  }
});

test('--mark-failed parks a pushed preview with a required failure reason', () => {
  const h = makeHarness();
  try {
    writeClaims(h, {
      'PG-TEST-001': {
        status: 'pushed-preview',
        branch: 'seo/auto/2026-06-03-PG-TEST-001',
        slug: 'test-slug',
      },
    });

    const missingReason = runAuto(h, ['--mark-failed', '--branch', 'seo/auto/2026-06-03-PG-TEST-001']);
    assert.notEqual(missingReason.status, 0);
    assert.match(`${missingReason.stdout}${missingReason.stderr}`, /--reason/);

    const failed = runAuto(h, [
      '--mark-failed',
      '--branch',
      'seo/auto/2026-06-03-PG-TEST-001',
      '--reason',
      'preview rendered soft 404',
    ]);
    assert.equal(failed.status, 0, `${failed.stdout}${failed.stderr}`);
    const claims = JSON.parse(readFileSync(h.claimsPath, 'utf8'));
    assert.equal(claims['PG-TEST-001'].status, 'needs_human');
    assert.equal(claims['PG-TEST-001'].error, 'preview rendered soft 404');
    assert.equal(
      existsSync(join(h.state, 'seo-repair-queue')),
      false,
      'default smoke harness must keep the production repair controller disabled',
    );
  } finally {
    h.cleanup();
  }
});

test('--mark-failed persists repair work after releasing the claims lock', async () => {
  const h = makeHarness();
  try {
    const repair = writeFakeRepairController(h);
    writeClaims(h, {
      'PG-TEST-001': {
        status: 'pushed-preview',
        stage: 'pushed-preview',
        branch: 'seo/auto/2026-06-03-PG-TEST-001',
        slug: 'test-slug',
      },
    });

    const failed = await runAutoAsync(h, [
      '--mark-failed',
      '--branch',
      'seo/auto/2026-06-03-PG-TEST-001',
      '--reason',
      'preview rendered soft 404',
    ], {
      GG_FLOW_STATE_DIR: join(h.root, 'state'),
      GG_SEO_REPAIR_CONTROLLER_V2_ENABLED: '1',
      GG_SEO_REPAIR_CONTROLLER_BIN: repair.file,
      GG_TEST_REPAIR_CALLS: repair.calls,
      GG_TEST_CLAIMS_LOCK: `${h.claimsPath}.lock`,
    });

    assert.equal(failed.status, 0, `${failed.stdout}${failed.stderr}`);
    const calls = readFileSync(repair.calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'drain');
    const queue = join(h.root, 'state', 'seo-repair-queue');
    const files = (await import('node:fs/promises')).readdir(queue);
    assert.equal((await files).filter((name) => name.endsWith('.json')).length, 1);
  } finally {
    h.cleanup();
  }
});

test('--mark-failed async controller rejection reaches the fatal handler after durable enqueue', async () => {
  const h = makeHarness();
  try {
    const repair = writeFakeRepairController(h, { exitCode: 2 });
    writeClaims(h, {
      'PG-TEST-001': {
        status: 'pushed-preview',
        stage: 'pushed-preview',
        branch: 'seo/auto/2026-06-03-PG-TEST-001',
        slug: 'test-slug',
      },
    });

    const failed = await runAutoAsync(h, [
      '--mark-failed',
      '--branch',
      'seo/auto/2026-06-03-PG-TEST-001',
      '--reason',
      'schema review failed',
    ], {
      GG_FLOW_STATE_DIR: join(h.root, 'state'),
      GG_SEO_REPAIR_CONTROLLER_V2_ENABLED: '1',
      GG_SEO_REPAIR_CONTROLLER_BIN: repair.file,
      GG_TEST_REPAIR_CALLS: repair.calls,
      GG_TEST_CLAIMS_LOCK: `${h.claimsPath}.lock`,
    });

    assert.equal(failed.status, 1, `${failed.stdout}${failed.stderr}`);
    assert.match(failed.stderr, /repair controller exited 2/);
    const claims = JSON.parse(readFileSync(h.claimsPath, 'utf8'));
    assert.equal(claims['PG-TEST-001'].status, 'needs_human');
    const queue = join(h.root, 'state', 'seo-repair-queue');
    const files = await (await import('node:fs/promises')).readdir(queue);
    assert.equal(files.filter((name) => name.endsWith('.json')).length, 1);
  } finally {
    h.cleanup();
  }
});

test('--author park uses the active Gengrowth site and invokes repair only after releasing claims lock', async () => {
  const h = makeHarness();
  try {
    const repair = writeFakeRepairController(h);
    const flow = writeStubAuthorParkFlow(h);
    const planName = '2026-07-16-gengrowth-blog-output-plan.md';
    const repairLog = join(h.root, 'gengrowth-author.log');
    const oldLog = 'OLD FIRE EVIDENCE\n';
    const currentLog = 'CURRENT FIRE AUTHORING FAILURE\n';
    writeFileSync(repairLog, `${oldLog}${currentLog}`);
    writeFileSync(join(h.tasks, planName), '- [ ] `PG-GJ2U-001` google july 2026 update\n');
    writeClaims(h, {});

    const parked = await runAutoAsync(h, [
      '--author',
      '--task',
      'PG-GJ2U-001',
      '--limit',
      '1',
    ], {
      GG_FLOW_REPO: flow,
      GG_AUTOPILOT_PLAN: planName,
      GG_SITE: 'gengrowth',
      GG_SEO_REPAIR_RUN_ID: 'gengrowth-author-natural-fire',
      GG_SEO_REPAIR_LOG_FILE: repairLog,
      GG_SEO_REPAIR_LOG_OFFSET_START: String(Buffer.byteLength(oldLog)),
      GG_FLOW_STATE_DIR: join(h.root, 'state'),
      GG_SEO_REPAIR_CONTROLLER_V2_ENABLED: '1',
      GG_SEO_REPAIR_CONTROLLER_BIN: repair.file,
      GG_TEST_REPAIR_CALLS: repair.calls,
      GG_TEST_CLAIMS_LOCK: `${h.claimsPath}.lock`,
    });

    assert.equal(parked.status, 0, `${parked.stdout}${parked.stderr}`);
    const queue = join(h.root, 'state', 'seo-repair-queue');
    const names = await (await import('node:fs/promises')).readdir(queue);
    const records = names
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(queue, name), 'utf8')));
    assert.equal(records.length, 1);
    const [record] = records;
    assert.equal(record.event.site, 'gengrowth');
    assert.equal(record.event.lane, 'author');
    assert.equal(record.event.runId, 'gengrowth-author-natural-fire');
    assert.equal(record.event.stderr, currentLog);
    assert.equal(record.event.logOffsetStart, Buffer.byteLength(oldLog));
    assert.equal(record.event.logOffsetEnd, Buffer.byteLength(oldLog + currentLog));
    assert.deepEqual(record.event.canonicalRetry.slice(-3), [
      '--retry-author',
      '--task',
      'PG-GJ2U-001',
    ]);
    assert.equal(readFileSync(repair.calls, 'utf8').trim().split('\n').length, 1);
  } finally {
    h.cleanup();
  }
});

test('--author awaits the repair tail so controller failure reaches the fatal handler', async () => {
  const h = makeHarness();
  try {
    const repair = writeFakeRepairController(h, { exitCode: 2 });
    const flow = writeStubAuthorParkFlow(h);
    const planName = '2026-07-16-gengrowth-blog-output-plan.md';
    writeFileSync(join(h.tasks, planName), '- [ ] `PG-GJ2U-001` google july 2026 update\n');
    writeClaims(h, {});

    const parked = await runAutoAsync(h, ['--author', '--task', 'PG-GJ2U-001'], {
      GG_FLOW_REPO: flow,
      GG_AUTOPILOT_PLAN: planName,
      GG_SITE: 'gengrowth',
      GG_FLOW_STATE_DIR: join(h.root, 'state'),
      GG_SEO_REPAIR_CONTROLLER_V2_ENABLED: '1',
      GG_SEO_REPAIR_CONTROLLER_BIN: repair.file,
      GG_TEST_REPAIR_CALLS: repair.calls,
      GG_TEST_CLAIMS_LOCK: `${h.claimsPath}.lock`,
    });

    assert.equal(parked.status, 1, `${parked.stdout}${parked.stderr}`);
    assert.match(parked.stderr, /repair controller exited 2/);
    const claim = JSON.parse(readFileSync(h.claimsPath, 'utf8'))['PG-GJ2U-001'];
    assert.equal(claim.status, 'needs_human');
  } finally {
    h.cleanup();
  }
});

test('--author skips safely when another product owns the global author executor', () => {
  const h = makeHarness();
  try {
    const lock = join(h.root, 'global-author.lock');
    mkdirSync(lock, { recursive: true });
    const start = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({
      pid: process.pid,
      start,
      token: 'test-owner',
      lane: 'other-product',
    }));

    const r = runAuto(
      h,
      ['--author', '--task', 'PG-TEST-001'],
      { GG_AUTHOR_GLOBAL_LOCK: lock },
    );

    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /author executor busy.*other-product/i);
    assert.equal(existsSync(h.claimsPath), false, 'busy author must not mutate claims');
  } finally {
    h.cleanup();
  }
});

test('repair controller child timeout includes the five-minute persistence and unlock margin', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  assert.match(
    source,
    /repairControllerBudgetSeconds\(\)[\s\S]*budgetSeconds \+ 300\) \* 1000/,
    'producer must not kill the controller before its budget plus five-minute safe cleanup margin',
  );
});

test('--retry-failed restores a human-fixed parked preview without bypassing verification', () => {
  const h = makeHarness();
  try {
    writeClaims(h, {
      'PG-TEST-001': {
        status: 'needs_human',
        branch: 'seo/auto/2026-06-03-PG-TEST-001',
        slug: 'test-slug',
        pr: 'https://github.com/xdawayer/oracle/pull/123',
        needs_hero: true,
        error: 'review[schema] FAIL: description truncated',
        failedAt: '2026-06-03T00:00:00.000Z',
      },
    });

    const r = runAuto(h, [
      '--retry-failed',
      '--branch',
      'seo/auto/2026-06-03-PG-TEST-001',
      '--evidence',
      'description regenerated and hero fixed',
      '--clear-needs-hero',
    ]);

    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const claims = JSON.parse(readFileSync(h.claimsPath, 'utf8'));
    const c = claims['PG-TEST-001'];
    assert.equal(c.status, 'pushed-preview');
    assert.equal(c.stage, 'pushed-preview');
    assert.equal(c.error, undefined);
    assert.equal(c.failedAt, undefined);
    assert.equal(c.needs_hero, undefined);
    assert.equal(c.retryEvidence, 'description regenerated and hero fixed');
    assert.match(c.retryAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.notEqual(c.status, 'verified-preview', 'retry must not bypass the verification gate');

    const verified = runAuto(h, ['--merge', '--branch', 'seo/auto/2026-06-03-PG-TEST-001']);
    assert.notEqual(verified.status, 0, 'merge must still require a later mark-verified');
  } finally {
    h.cleanup();
  }
});

test('--retry-failed refuses non-parked claims', () => {
  const h = makeHarness();
  try {
    writeClaims(h, {
      'PG-TEST-001': {
        status: 'active',
        branch: 'seo/auto/2026-06-03-PG-TEST-001',
        slug: 'test-slug',
      },
    });
    const r = runAuto(h, ['--retry-failed', '--branch', 'seo/auto/2026-06-03-PG-TEST-001']);
    assert.notEqual(r.status, 0);
    assert.match(`${r.stdout}${r.stderr}`, /needs_human/);
  } finally {
    h.cleanup();
  }
});

test('--retry-author clears only parked authoring claims so a fixed author bug can rerun', () => {
  const h = makeHarness();
  try {
    writeClaims(h, {
      'PG-TEST-001': {
        status: 'needs_human',
        stage: 'authoring',
        slug: 'test-keyword',
        error: 'authoring: render produced no v8 prompt',
      },
      'PG-TEST-002': {
        status: 'needs_human',
        stage: 'pushed-preview',
        branch: 'seo/auto/PG-TEST-002',
        error: 'preview failed',
      },
    });

    const r = runAuto(h, ['--retry-author', '--task', 'PG-TEST-001', '--reason', 'renderer search_volume fallback fixed']);

    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const claims = JSON.parse(readFileSync(h.claimsPath, 'utf8'));
    assert.equal(claims['PG-TEST-001'], undefined);
    assert.equal(claims['PG-TEST-002'].status, 'needs_human');

    const refused = runAuto(h, ['--retry-author', '--task', 'PG-TEST-002']);
    assert.notEqual(refused.status, 0);
    assert.match(`${refused.stdout}${refused.stderr}`, /stage "pushed-preview"/);
  } finally {
    h.cleanup();
  }
});

test('--scan refuses to hard-reset a dirty oracle workspace', () => {
  const h = makeHarness();
  try {
    initOracleWithOrigin(h);

    writeFileSync(join(h.tasks, '2026-06-03-blog-output-plan.md'), '- [ ] `PG-TEST-001` test keyword\n');
    writeFileSync(join(h.oracle, 'README.md'), 'human local edit\n');

    const r = runAuto(h, ['--scan', '--limit', '1']);

    assert.notEqual(r.status, 0);
    assert.match(`${r.stdout}${r.stderr}`, /dirty|refusing/i);
    assert.equal(readFileSync(join(h.oracle, 'README.md'), 'utf8'), 'human local edit\n');
  } finally {
    h.cleanup();
  }
});

test('--scan does not reclaim a task already waiting in pushed-preview', () => {
  const h = makeHarness();
  try {
    initOracleWithOrigin(h);
    const flow = writeStubFlow(h);
    writeFileSync(join(h.bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(h.tasks, '2026-06-03-blog-output-plan.md'), '- [ ] `PG-TEST-001` test keyword\n');
    writeClaims(h, {
      'PG-TEST-001': {
        status: 'pushed-preview',
        branch: 'seo/auto/2026-06-03-PG-TEST-001',
        slug: 'test-slug',
      },
    });

    const r = runAuto(h, ['--scan', '--dry-run', '--limit', '1'], { GG_FLOW_REPO: flow });

    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const claims = JSON.parse(readFileSync(h.claimsPath, 'utf8'));
    assert.equal(claims['PG-TEST-001'].status, 'pushed-preview');
    assert.match(`${r.stdout}${r.stderr}`, /claim=pushed-preview/);
  } finally {
    h.cleanup();
  }
});

test('--scan updates /oracle main first, then publishes from a separate worktree', () => {
  const h = makeHarness();
  try {
    initOracleWithOrigin(h);
    addRemoteMainCommit(h);
    const flow = writeStubFlow(h);
    const worktreeRoot = join(h.root, 'oracle-worktrees');
    writeFileSync(join(h.bin, 'npm'), [
      '#!/bin/sh',
      'mkdir -p public/og/articles',
      'printf "build-only\\n" > public/og/articles/build-only.png',
      'printf "build mutated tracked output\\n" > README.md',
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });
    writeFileSync(join(h.bin, 'gh'), '#!/bin/sh\nprintf "https://github.com/xdawayer/oracle/pull/123\\n"\n', { mode: 0o755 });
    writeFileSync(join(h.tasks, '2026-06-03-blog-output-plan.md'), '- [ ] `PG-TEST-001` test keyword\n');

    const r = runAuto(h, ['--scan', '--limit', '1'], {
      GG_FLOW_REPO: flow,
      GG_ORACLE_WORKTREE_ROOT: worktreeRoot,
    });

    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.equal(git(h.oracle, ['branch', '--show-current']).trim(), 'main');
    assert.equal(git(h.oracle, ['rev-parse', 'main']).trim(), git(h.oracle, ['rev-parse', 'origin/main']).trim());
    assert.equal(readFileSync(join(h.oracle, 'README.md'), 'utf8'), 'remote update\n');
    assert.equal(existsSync(join(h.oracle, 'data', 'articles', 'test-slug.ts')), false);

    const claims = JSON.parse(readFileSync(h.claimsPath, 'utf8'));
    const claim = claims['PG-TEST-001'];
    assert.equal(claim.status, 'pushed-preview');
    // Task 8: a published claim carries lease/stage heartbeat metadata.
    assert.equal(claim.stage, 'pushed-preview', 'final stage should be stamped');
    assert.ok(String(claim.lockedBy || '').length > 0, 'lockedBy should be stamped');
    assert.match(claim.leaseUntil, /^\d{4}-\d{2}-\d{2}T/, 'leaseUntil should be an ISO timestamp');
    assert.match(claim.updatedAt, /^\d{4}-\d{2}-\d{2}T/, 'updatedAt should be an ISO timestamp');
    assert.ok(claim.worktree && claim.worktree.startsWith(worktreeRoot), `unexpected worktree: ${claim.worktree}`);
    assert.notEqual(claim.worktree, h.oracle);
    assert.match(git(h.oracle, ['show', `${claim.branch}:data/articles/test-slug.ts`]), /authorId: "test-author"/);
    assert.equal(
      git(claim.worktree, ['status', '--porcelain=v1', '--untracked-files=all']).trim(),
      '',
      'build-generated files must stay inside an isolated validation worktree',
    );
    assert.equal(
      existsSync(join(claim.worktree, 'public', 'og', 'articles', 'build-only.png')),
      false,
      'build-only output must not leak into the review worktree',
    );
  } finally {
    h.cleanup();
  }
});

// EN-only regression (2026-07-03): a checked done task with a leftover
// _staging/zh-demo/ draft was previously a "zh backfill candidate" that --scan
// re-claimed and republished bilingual. That path is deleted — the task must
// stay skipped ("already checked in plan") and the claim untouched.
test('--scan never re-claims a checked done task, even with a leftover zh-demo draft', () => {
  const h = makeHarness();
  try {
    initOracleWithOrigin(h);
    writeFileSync(join(h.oracle, 'data', 'articles', 'test-slug.ts'), 'export const testSlugEn = { authorId: "test-author" };\n');
    writeFileSync(join(h.oracle, 'scripts', 'generate-seo-pages.mjs'), 'const ARTICLE_SLUGS = [\n];\nconst ARTICLE_SLUGS_EN_ONLY = [\n  \'test-slug\',\n];\n');
    git(h.oracle, ['add', 'data/articles/test-slug.ts', 'scripts/generate-seo-pages.mjs']);
    git(h.oracle, ['commit', '-m', 'seed en-only article']);
    git(h.oracle, ['push', 'origin', 'main']);

    const flow = writeStubFlow(h, 'test-slug', { zh: true });
    const worktreeRoot = join(h.root, 'oracle-worktrees');
    writeFileSync(join(h.bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(h.bin, 'gh'), '#!/bin/sh\nprintf "https://github.com/xdawayer/oracle/pull/456\\n"\n', { mode: 0o755 });
    writeFileSync(join(h.tasks, '2026-06-03-blog-output-plan.md'), '- [x] `PG-TEST-001` test keyword\n');
    writeClaims(h, {
      'PG-TEST-001': {
        status: 'done',
        slug: 'test-slug',
        owner: 'autopilot',
        zh: false,
      },
    });

    const r = runAuto(h, ['--scan', '--limit', '1'], {
      GG_FLOW_REPO: flow,
      GG_ORACLE_WORKTREE_ROOT: worktreeRoot,
    });

    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /already checked in plan/);
    const claims = JSON.parse(readFileSync(h.claimsPath, 'utf8'));
    const claim = claims['PG-TEST-001'];
    assert.equal(claim.status, 'done', 'checked done task must stay done — no zh backfill re-claim');
    assert.notEqual(claim.zh, true, 'no bilingual promotion may happen');
  } finally {
    h.cleanup();
  }
});

test('--scan skips a draft whose entity-derived slug is already live under a different (human-renamed) slug — duplicate-content guard', () => {
  const h = makeHarness();
  try {
    initOracleWithOrigin(h);
    // Oracle already has the article live under the ENTITY-derived slug — exactly what a
    // human does when they rename the keyword-derived slug before publishing.
    writeFileSync(
      join(h.oracle, 'data', 'articles', 'signs-of-a-highly-sensitive-person.ts'),
      'export const signsOfAHighlySensitivePersonEn = { authorId: "test-author" };\n',
    );
    git(h.oracle, ['add', 'data/articles/signs-of-a-highly-sensitive-person.ts']);
    git(h.oracle, ['commit', '-m', 'seed live article under entity-derived slug']);
    git(h.oracle, ['push', 'origin', 'main']);

    const flow = writeStubFlow(h, 'signs-you-re-a-highly-sensitive-person');
    // Same draft, but its frontmatter slug is the KEYWORD-derived one (differs from the live
    // entity slug). entity slugifies back to the live slug, so the alias check must catch it.
    writeFileSync(
      join(flow, '_staging', 'PG-TEST-001-en.md'),
      '---\nslug: signs-you-re-a-highly-sensitive-person\nentity: Signs of a Highly Sensitive Person\ntarget_keyword: signs you\'re a highly sensitive person\nauthor_id: test-author\n---\n# Test\n\nBody.\n',
    );
    writeFileSync(join(h.bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(
      join(h.tasks, '2026-06-03-blog-output-plan.md'),
      "- [ ] `PG-TEST-001` signs you're a highly sensitive person\n",
    );

    const r = runAuto(h, ['--scan', '--dry-run', '--limit', '1'], { GG_FLOW_REPO: flow });

    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    // Must recognize the live entity alias and skip, NOT publish a second copy.
    assert.match(
      `${r.stdout}${r.stderr}`,
      /skip PG-TEST-001: oracle already has signs-of-a-highly-sensitive-person\.ts/,
    );
    const claims = existsSync(h.claimsPath) ? JSON.parse(readFileSync(h.claimsPath, 'utf8')) : {};
    assert.notEqual(
      (claims['PG-TEST-001'] || {}).status,
      'dry-run-ok',
      'duplicate draft must not be picked for publish',
    );
  } finally {
    h.cleanup();
  }
});

// EN-only regression (2026-07-03): a checked done task was previously the
// trigger for the --author zh-source-backfill lane. That lane is deleted —
// --author must find nothing to do and never write into _staging/zh-demo/.
test('--author has nothing to do for a checked done task (zh backfill lane removed)', () => {
  const h = makeHarness();
  try {
    const flow = writeStubAuthorBackfillFlow(h);
    writeFileSync(join(h.tasks, '2026-06-03-blog-output-plan.md'), '- [x] `PG-TEST-001` test keyword\n');
    writeClaims(h, {
      'PG-TEST-001': {
        status: 'done',
        slug: 'test-slug',
        owner: 'autopilot',
        zh: false,
      },
    });

    const r = runAuto(h, ['--author'], { GG_FLOW_REPO: flow });

    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /nothing to author this run/);
    assert.equal(existsSync(join(flow, '_staging', 'zh-demo', 'PG-TEST-001-zh.md')), false, 'zh source draft must NOT be generated');
    assert.equal(existsSync(join(flow, '.gg-cache', 'prompts', 'PG-TEST-001.v8.zh-prompt.md')), false, 'zh prompt must NOT be generated');
  } finally {
    h.cleanup();
  }
});

test('--author --task preserves an existing Phase 2 PASS draft for the same-tick publish scan', () => {
  const h = makeHarness();
  try {
    const flow = writeStubFlow(h);
    writeFileSync(join(h.tasks, '2026-06-03-blog-output-plan.md'), '- [ ] `PG-TEST-001` test keyword\n');
    writeClaims(h, {});
    const draftBefore = readFileSync(join(flow, '_staging', 'PG-TEST-001-en.md'), 'utf8');
    const manifestBefore = readFileSync(join(flow, '_staging', 'PG-TEST-001-en.manifest.json'), 'utf8');

    const r = runAuto(h, ['--author', '--task', 'PG-TEST-001'], { GG_FLOW_REPO: flow });

    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /already has a Phase 2 PASS draft.*scan/i);
    assert.equal(readFileSync(join(flow, '_staging', 'PG-TEST-001-en.md'), 'utf8'), draftBefore);
    assert.equal(readFileSync(join(flow, '_staging', 'PG-TEST-001-en.manifest.json'), 'utf8'), manifestBefore);
    assert.deepEqual(JSON.parse(readFileSync(h.claimsPath, 'utf8')), {});
  } finally {
    h.cleanup();
  }
});

test('--author normalizes blank search_volume before render so newly registered topics do not park', () => {
  const h = makeHarness();
  try {
    const flow = writeStubAuthorBackfillFlow(h, {
      seedEn: false,
      blankSearchVolume: true,
      renderRequiresSearchVolume: true,
    });
    writeFileSync(join(h.tasks, '2026-06-03-blog-output-plan.md'), '- [ ] `PG-TEST-001` test keyword\n');
    writeClaims(h, {});

    const r = runAuto(h, ['--author'], { GG_FLOW_REPO: flow });

    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.equal(existsSync(join(flow, '.gg-cache', 'prompts', 'PG-TEST-001.v8-prompt.md')), true, `${r.stdout}${r.stderr}`);
    assert.equal(existsSync(join(flow, '_staging', 'PG-TEST-001-en.md')), true, `${r.stdout}${r.stderr}`);
    const override = JSON.parse(readFileSync(join(flow, '.gg-cache', 'overrides', 'PG-TEST-001.json'), 'utf8'));
    assert.equal(override['PG-TEST-001'].search_volume, '0');
    assert.equal(
      override['PG-TEST-001'].cta_target_url,
      'https://astrologywiki.com/en/tools',
    );
    assert.match(`${r.stdout}${r.stderr}`, /AUTHORED PG-TEST-001/);
  } finally {
    h.cleanup();
  }
});

test('--author accumulates and persists distinct Phase 2 constraints across attempts and cron retries', () => {
  const h = makeHarness();
  try {
    const flow = writeStubAuthorBackfillFlow(h, { seedEn: false });
    writeFileSync(join(h.tasks, '2026-06-03-blog-output-plan.md'), '- [ ] `PG-TEST-001` test keyword\n');
    writeClaims(h, {});
    const promptLog = join(h.root, 'author-prompts.log');
    const phase2State = join(h.root, 'phase2-state');
    const failures = [
      '✗ FAIL word count 1406 outside [1500, 1800]\\n  - RL4 drifted sections: Common Misreadings; Take Action',
      '✗ FAIL RL5 keyword count 11 outside [5, 8]\\n  - SC5 FAQ questions found: 0',
    ];

    const first = runAuto(h, ['--author', '--task', 'PG-TEST-001'], {
      GG_FLOW_REPO: flow,
      GG_AUTHOR_GEN_ATTEMPTS: '2',
      GG_AUTHOR_REPAIR: '0',
      GG_TEST_AUTHOR_PROMPT_LOG: promptLog,
      GG_TEST_PHASE2_STATE: phase2State,
      GG_TEST_PHASE2_FAILURES: JSON.stringify(failures),
    });

    assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
    const prompts = readFileSync(promptLog, 'utf8').split('\n===PROMPT===\n').filter(Boolean);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /word count 1406 outside/);
    assert.match(prompts[1], /Common Misreadings/);
    const memoryPath = join(flow, '_staging', 'PG-TEST-001-author-failures.json');
    const memory = JSON.parse(readFileSync(memoryPath, 'utf8'));
    assert.equal(memory.status, 'failed');
    assert.match(memory.failures.join('\n'), /word count 1406 outside/);
    assert.match(memory.failures.join('\n'), /RL5 keyword count 11 outside/);
    assert.equal(existsSync(join(flow, '_staging', 'PG-TEST-001-last-failing-v8.md')), true);

    writeClaims(h, {});
    writeFileSync(promptLog, '');
    writeFileSync(phase2State, '0');
    const second = runAuto(h, ['--author', '--task', 'PG-TEST-001'], {
      GG_FLOW_REPO: flow,
      GG_AUTHOR_GEN_ATTEMPTS: '1',
      GG_AUTHOR_REPAIR: '0',
      GG_TEST_AUTHOR_PROMPT_LOG: promptLog,
      GG_TEST_PHASE2_STATE: phase2State,
      GG_TEST_PHASE2_FAILURES: '[]',
    });

    assert.equal(second.status, 0, `${second.stdout}${second.stderr}`);
    const retryPrompt = readFileSync(promptLog, 'utf8');
    assert.match(retryPrompt, /word count 1406 outside/);
    assert.match(retryPrompt, /RL5 keyword count 11 outside/);
    const passedMemory = JSON.parse(readFileSync(memoryPath, 'utf8'));
    assert.equal(passedMemory.status, 'passed');
    assert.deepEqual(passedMemory.failures, []);
  } finally {
    h.cleanup();
  }
});

test('--author gives a failed repair candidate one bounded second repair with the new exact failures', () => {
  const h = makeHarness();
  try {
    const flow = writeStubAuthorBackfillFlow(h, { seedEn: false });
    writeFileSync(join(h.tasks, '2026-06-03-blog-output-plan.md'), '- [ ] `PG-TEST-001` test keyword\n');
    writeClaims(h, {});
    const phase2State = join(h.root, 'repair-phase2-state');
    const repairCalls = join(h.root, 'repair-worker-calls.log');
    const failures = [
      '✗ FAIL RL4 drifted sections: Common Misreadings',
      '✗ FAIL RL5 keyword count 11 outside [5, 8]\\n  - SC3 paragraph has 8 sentences',
    ];

    const r = runAuto(h, ['--author', '--task', 'PG-TEST-001'], {
      GG_FLOW_REPO: flow,
      GG_AUTHOR_GEN_ATTEMPTS: '1',
      GG_AUTHOR_REPAIR_ATTEMPTS: '2',
      GG_AUTHOR_REPAIR_TIMEOUT_MS: '1000',
      GG_TEST_PHASE2_STATE: phase2State,
      GG_TEST_PHASE2_FAILURES: JSON.stringify(failures),
      GG_TEST_REPAIR_WORKER_CALLS: repairCalls,
    });

    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /retrying candidate once with new exact failures/);
    assert.match(`${r.stdout}${r.stderr}`, /AUTHORED PG-TEST-001.*deterministic repair/);
    const calls = readFileSync(repairCalls, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.match(calls[1][calls[1].indexOf('--failures') + 1], /RL5 keyword count 11/);
    assert.match(calls[1][calls[1].indexOf('--failures') + 1], /SC3 paragraph has 8 sentences/);
    assert.equal(existsSync(join(flow, '_staging', 'PG-TEST-001-repair-candidate-attempt-2.md')), true);
    assert.equal(existsSync(join(flow, '_staging', 'PG-TEST-001-en.md')), true);
  } finally {
    h.cleanup();
  }
});

test('--author preserves the last failing draft for repair when the final orchestrator attempt produces no draft', () => {
  const h = makeHarness();
  try {
    const flow = writeStubAuthorBackfillFlow(h, { seedEn: false });
    writeFileSync(join(h.tasks, '2026-06-03-blog-output-plan.md'), '- [ ] `PG-TEST-001` test keyword\n');
    writeClaims(h, {});
    const phase2State = join(h.root, 'snapshot-phase2-state');
    const orchState = join(h.root, 'snapshot-orchestrator-state');
    const repairCalls = join(h.root, 'snapshot-repair-calls.log');

    const r = runAuto(h, ['--author', '--task', 'PG-TEST-001'], {
      GG_FLOW_REPO: flow,
      GG_AUTHOR_GEN_ATTEMPTS: '2',
      GG_AUTHOR_REPAIR_ATTEMPTS: '1',
      GG_AUTHOR_REPAIR_TIMEOUT_MS: '1000',
      GG_TEST_PHASE2_STATE: phase2State,
      GG_TEST_PHASE2_FAILURES: JSON.stringify(['✗ FAIL RL4 drifted sections: Common Misreadings']),
      GG_TEST_ORCHESTRATOR_STATE: orchState,
      GG_TEST_ORCHESTRATOR_NO_DRAFT_AT: '2',
      GG_TEST_REPAIR_WORKER_CALLS: repairCalls,
    });

    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /orchestrator produced no draft|simulated watchdog/);
    assert.match(`${r.stdout}${r.stderr}`, /AUTHORED PG-TEST-001.*deterministic repair/);
    const calls = readFileSync(repairCalls, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(calls.length, 1);
    assert.match(calls[0][calls[0].indexOf('--source') + 1], /PG-TEST-001-last-failing-v8\.md$/);
  } finally {
    h.cleanup();
  }
});

test('--stale-report flags in-flight claims past their lease, read-only, excludes terminal claims', () => {
  const h = makeHarness();
  try {
    const past = new Date(Date.now() - 3600e3).toISOString();
    const future = new Date(Date.now() + 3600e3).toISOString();
    writeClaims(h, {
      'PG-STALE': { status: 'active', slug: 's1', stage: 'convert', lockedBy: '999', leaseUntil: past, updatedAt: past, branch: 'b1' },
      'PG-FRESH': { status: 'pushed-preview', slug: 's2', stage: 'pushed-preview', leaseUntil: future, branch: 'b2' },
      'PG-DONE': { status: 'done', slug: 's3' },
    });
    const before = readFileSync(h.claimsPath, 'utf8');

    const r = runAuto(h, ['--stale-report']);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const out = JSON.parse(r.stdout);
    const byId = Object.fromEntries(out.inflight.map((x) => [x.pgId, x]));
    assert.equal(byId['PG-STALE'].stale, true, 'an active claim past its lease is stale');
    assert.equal(byId['PG-STALE'].stage, 'convert', 'stale report carries the last stage');
    assert.equal(byId['PG-FRESH'].stale, false, 'a claim within its lease is not stale');
    assert.equal(byId['PG-DONE'], undefined, 'terminal (done) claims are excluded from the in-flight report');
    assert.equal(out.staleCount, 1);
    // READ-ONLY: the ledger must be byte-identical after a stale report.
    assert.equal(readFileSync(h.claimsPath, 'utf8'), before, '--stale-report must not mutate the ledger');
  } finally {
    h.cleanup();
  }
});

// 阶段 1（通知统一）：--merge 的发布通报走统一事件层（lib/gg-notify 的 published 事件），
// 模板文案与 @ 策略由事件表决定，不再裸拼「SEO autopilot …」字符串。传输指向本地 http
// mock（GG_LARK_API_BASE），状态目录/凭据/审计日志全部 env 覆盖——绝不碰真网络/真飞书。
test('--merge sends the published event through the unified notify layer (contract template, no @)', async () => {
  const h = makeHarness();
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* keep raw-less */ }
      requests.push({ url: req.url, body });
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        res.end(JSON.stringify({ code: 0, tenant_access_token: 't-test' }));
        return;
      }
      res.end(JSON.stringify({ code: 0, data: { message_id: 'om_test' } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    initOracleWithOrigin(h);
    const flow = writeStubFlow(h); // _staging/PG-TEST-001-en.md：slug=test-slug、author_id=test-author、无 title
    writeFileSync(
      join(h.bin, 'gh'),
      `#!/bin/sh\nprintf '%s' "${REVIEWED_HEAD}"\nexit 0\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(h.tasks, '2026-06-03-blog-output-plan.md'), '- [ ] `PG-TEST-001` test keyword\n');
    const hermes = join(h.root, 'hermes.env');
    writeFileSync(hermes, 'FEISHU_APP_ID=cli_test\nFEISHU_APP_SECRET=sec_test\n');
    const emptyEnvFile = join(h.root, 'empty-gg.env'); // 屏蔽宿主机 ~/.config/gg/_gg.env，保持用例封闭
    writeFileSync(emptyEnvFile, '');
    writeClaims(h, {
      'PG-TEST-001': {
        status: 'verified-preview',
        branch: 'seo/auto/2026-06-03-PG-TEST-001',
        slug: 'test-slug',
        previewUrl: 'https://example-preview.vercel.app',
        headRefOid: REVIEWED_HEAD,
      },
    });

    const r = await runAutoAsync(h, ['--merge', '--branch', 'seo/auto/2026-06-03-PG-TEST-001'], {
      GG_FLOW_REPO: flow,
      GG_AUTOPILOT_NO_NOTIFY: '', // 打开通知（覆盖 harness 默认的 '1'）——传输已指向本地 mock
      GG_ENV_FILE: emptyEnvFile,
      GG_LARK_API_BASE: `http://127.0.0.1:${server.address().port}`,
      GG_FLOW_STATE_DIR: join(h.root, 'flow-state'),
      GG_LARK_AUDIT_LOG: join(h.root, 'lark-audit.log'),
      HERMES_ENV: hermes,
      GG_LARK_SEND_RETRIES: '0',
      GG_LARK_NOTIFY_SILENCE: '',
      GG_LARK_NOTIFY_CHAT_ID: 'oc_test_chat',
    });

    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const msgs = requests.filter((q) => q.url.startsWith('/open-apis/im/v1/messages'));
    assert.equal(msgs.length, 1, `expected exactly one Feishu message, got ${msgs.length}`);
    const text = JSON.parse(msgs[0].body.content).text;
    // published 事件模板（NOTIFY-CONTRACT.md 逐字）：统一头 + [astrologywiki] 站点标签。
    assert.equal(
      text,
      '✅ [astrologywiki] 已发布上线：test-slug\nhttps://www.astrologywiki.com/en/wiki/test-slug\n（作者 test-author，已登记到 ops）',
    );
    assert.doesNotMatch(text, /<at user_id=/, 'published 事件按事件表不 @ 任何人');
    assert.equal(msgs[0].body.receive_id, 'oc_test_chat');
  } finally {
    server.close();
    h.cleanup();
  }
});

test('--merge keeps the publish terminal and durable when post-merge oracle sync is deferred', () => {
  const h = makeHarness();
  try {
    initOracleWithOrigin(h);
    writeFileSync(
      join(h.bin, 'gh'),
      `#!/bin/sh\nprintf '%s' "${REVIEWED_HEAD}"\nexit 0\n`,
      { mode: 0o755 },
    );
    const plan = join(h.tasks, '2026-06-03-blog-output-plan.md');
    writeFileSync(plan, '- [ ] `PG-TEST-001` test keyword\n');
    writeClaims(h, {
      'PG-TEST-001': {
        status: 'verified-preview',
        branch: 'seo/auto/2026-06-03-PG-TEST-001',
        slug: 'test-slug',
        previewUrl: 'https://example-preview.vercel.app',
        headRefOid: REVIEWED_HEAD,
      },
    });
    // Simulate the production incident: GitHub merge succeeds, then the local
    // baseline refuses sync because it contains tracked user changes.
    writeFileSync(join(h.oracle, 'README.md'), 'user change\n');
    const state = join(h.root, 'flow-state');

    const r = runAuto(h, ['--merge', '--branch', 'seo/auto/2026-06-03-PG-TEST-001'], {
      GG_FLOW_STATE_DIR: state,
    });

    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /post-merge oracle sync deferred/i);
    const claim = JSON.parse(readFileSync(h.claimsPath, 'utf8'))['PG-TEST-001'];
    assert.equal(claim.status, 'done');
    assert.equal(claim.error, undefined);
    assert.equal(claim.failedAt, undefined);
    assert.match(claim.mergedAt, /^\d{4}-\d{2}-\d{2}T/);
    const walPath = join(state, 'pending-writeback', 'PG-TEST-001.json');
    if (existsSync(walPath)) {
      const wal = JSON.parse(readFileSync(walPath, 'utf8'));
      assert.equal(wal.pageId, 'PG-TEST-001');
      assert.equal(wal.slug, 'test-slug');
      assert.equal(wal.site, 'astrologywiki');
      assert.equal(wal.planPath, plan);
    } else {
      assert.match(
        `${r.stdout}${r.stderr}`,
        /backfill PG-TEST-001/i,
        'a resolved WAL must leave explicit backfill completion/defer evidence',
      );
    }
    assert.match(
      readFileSync(join(h.tasks, '..', 'seo-autopilot-publish-log.md'), 'utf8'),
      /\| PG-TEST-001 \| test-slug \|/,
      'the publish register must be durable before local oracle sync',
    );
  } finally {
    h.cleanup();
  }
});

test('--status removes stale failure fields from an already-done claim', () => {
  const h = makeHarness();
  try {
    writeClaims(h, {
      'PG-TEST-001': {
        status: 'done',
        branch: 'seo/auto/2026-06-03-PG-TEST-001',
        slug: 'test-slug',
        mergedAt: '2026-07-16T13:22:00.000Z',
        error: 'stale post-merge local sync failure',
        failedAt: '2026-07-16T13:22:01.000Z',
      },
    });

    const r = runAuto(h, ['--status']);

    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const claim = JSON.parse(readFileSync(h.claimsPath, 'utf8'))['PG-TEST-001'];
    assert.equal(claim.status, 'done');
    assert.equal(claim.error, undefined);
    assert.equal(claim.failedAt, undefined);
  } finally {
    h.cleanup();
  }
});

test('--reconcile-published marks parked claims done when oracle already has the article registered', () => {
  const h = makeHarness();
  try {
    initOracleWithOrigin(h);
    writeFileSync(
      join(h.oracle, 'data', 'articles', 'already-live.ts'),
      'export const alreadyLiveEn = { id: "already-live", authorId: "test-author" };\n',
    );
    writeFileSync(
      join(h.oracle, 'data', 'articles', 'index.ts'),
      'import { alreadyLiveEn } from "./already-live";\nconst ARTICLES_EN: WikiArticle[] = [\n  alreadyLiveEn,\n];\nconst ARTICLES_ZH: WikiArticle[] = [\n];\n',
    );
    git(h.oracle, ['add', 'data/articles/already-live.ts', 'data/articles/index.ts']);
    git(h.oracle, ['commit', '-m', 'seed already-live article']);
    git(h.oracle, ['push', 'origin', 'main']);
    writeClaims(h, {
      'PG-LIVE': {
        status: 'needs_human',
        slug: 'already-live',
        stage: 'push',
        branch: 'seo/auto/2026-06-21-PG-LIVE',
        error: 'stale push claim',
      },
    });

    const r = runAuto(h, ['--reconcile-published']);

    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /PUBLISHED PG-LIVE already-live/);
    const claims = JSON.parse(readFileSync(h.claimsPath, 'utf8'));
    assert.equal(claims['PG-LIVE'].status, 'done');
    assert.equal(claims['PG-LIVE'].reconciliationNote, 'auto-reconciled from oracle main article registration');
    assert.match(claims['PG-LIVE'].mergedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(
      readFileSync(join(h.tasks, '..', 'seo-autopilot-publish-log.md'), 'utf8'),
      /\| PG-LIVE \| already-live \|/,
      'reconciliation must restore a missing publish-register row',
    );
  } finally {
    h.cleanup();
  }
});
