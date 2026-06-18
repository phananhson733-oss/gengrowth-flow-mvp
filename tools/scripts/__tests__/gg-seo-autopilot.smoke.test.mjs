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
import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'gg-seo-autopilot.mjs');

function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), 'gg-seo-autopilot-'));
  const ops = join(root, 'ops');
  const tasks = join(ops, 'inbox', '06-tasks', 'tasks');
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
      GG_AUTOPILOT_NO_NOTIFY: '1', // never send a real Feishu push from tests
      ...extraEnv,
    },
  });
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

function writeStubAuthorBackfillFlow(h) {
  const flow = join(h.root, 'flow-author');
  const scripts = join(flow, 'tools', 'scripts');
  const staging = join(flow, '_staging');
  const prompts = join(flow, '.gg-cache', 'prompts');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(staging, 'zh-demo'), { recursive: true });
  mkdirSync(prompts, { recursive: true });
  writeFileSync(join(staging, 'PG-TEST-001-en.md'), '---\nslug: test-slug\nauthor_id: test-author\n---\n# Test\n\nBody.\n');
  writeFileSync(join(staging, 'PG-TEST-001-en.manifest.json'), JSON.stringify({ phase2_checks: { overall: 'pass' } }));

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
    search_volume: '100',
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
    search_volume: '100',
    content_angle: 'angle',
    cta_text: '工具页',
    cta_target_url: '工具页',
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
import { mkdirSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const isZh = args.includes('--language') && args[args.indexOf('--language') + 1] === 'zh';
mkdirSync('.gg-cache/prompts', { recursive: true });
const suffix = isZh ? '.zh' : '';
writeFileSync('.gg-cache/prompts/PG-TEST-001.v8' + suffix + '-prompt.md', '# prompt\\n\\nbody');
writeFileSync('.gg-cache/prompts/PG-TEST-001.v8' + suffix + '-fixture.json', JSON.stringify({ language: isZh ? 'zh' : 'en' }));
`);

  writeFileSync(join(scripts, 'gg-llm-orchestrator.mjs'), `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const outDir = args[args.indexOf('--out-dir') + 1];
const pageId = args[args.indexOf('--page-id') + 1];
mkdirSync(outDir, { recursive: true });
writeFileSync(outDir + '/' + pageId + '-claude-v8.md', '# 中文稿\\n\\n这里是中文正文。');
`);

  writeFileSync(join(scripts, '_phase2-validate.mjs'), `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const pageId = args[args.indexOf('--page-id') + 1];
const tag = args[args.indexOf('--tag') + 1];
const lang = args.includes('--language') ? args[args.indexOf('--language') + 1] : 'en';
const dir = lang === 'zh' ? '_staging/zh-demo' : '_staging';
mkdirSync(dir, { recursive: true });
writeFileSync(dir + '/' + pageId + '-' + tag + '.md', '---\\nslug: test-slug\\nauthor_id: test-author\\n---\\n# 成稿\\n\\n正文。\\n');
writeFileSync(dir + '/' + pageId + '-' + tag + '.manifest.json', JSON.stringify({ phase2_checks: { overall: 'pass' } }));
`);

  writeFileSync(join(scripts, 'gg-author-review.mjs'), 'process.exit(0);\n');
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

test('--mark-verified records preview evidence and allows the subsequent merge command to reach gh', () => {
  const h = makeHarness();
  try {
    const marker = join(h.root, 'gh-called');
    writeFileSync(join(h.bin, 'gh'), `#!/bin/sh\ntouch "${marker}"\nexit 0\n`, { mode: 0o755 });
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
    ]);
    assert.equal(marked.status, 0, `${marked.stdout}${marked.stderr}`);
    const claims = JSON.parse(readFileSync(h.claimsPath, 'utf8'));
    assert.equal(claims['PG-TEST-001'].status, 'verified-preview');
    assert.equal(claims['PG-TEST-001'].previewUrl, 'https://example-preview.vercel.app');
    assert.match(claims['PG-TEST-001'].verifiedAt, /^\d{4}-\d{2}-\d{2}T/);

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
    writeFileSync(join(h.bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
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
  } finally {
    h.cleanup();
  }
});

test('--scan can backfill zh for a checked done task and promote the slug from EN-only to bilingual SEO generation', () => {
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
    const claims = JSON.parse(readFileSync(h.claimsPath, 'utf8'));
    const claim = claims['PG-TEST-001'];
    assert.equal(claim.status, 'pushed-preview');
    assert.equal(claim.zh, true);
    const seo = git(h.oracle, ['show', `${claim.branch}:scripts/generate-seo-pages.mjs`]);
    assert.match(seo, /const ARTICLE_SLUGS = \[\n  'test-slug',/);
    assert.doesNotMatch(seo, /ARTICLE_SLUGS_EN_ONLY = \[[\s\S]*'test-slug'/);
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

test('--author can generate the missing zh source draft for a checked done task before scan picks it up', () => {
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
    assert.equal(existsSync(join(flow, '_staging', 'zh-demo', 'PG-TEST-001-zh.md')), true, `${r.stdout}${r.stderr}`);
    assert.equal(existsSync(join(flow, '.gg-cache', 'prompts', 'PG-TEST-001.v8.zh-prompt.md')), true);
    assert.match(`${r.stdout}${r.stderr}`, /AUTHORED ZH PG-TEST-001/);
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
