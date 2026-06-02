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
  writeFileSync(join(h.oracle, 'README.md'), 'clean\n');
  writeFileSync(join(h.oracle, 'data', 'articles', 'index.ts'), 'const ARTICLES_EN: WikiArticle[] = [\n];\nconst ARTICLES_ZH: WikiArticle[] = [\n];\n');
  writeFileSync(join(h.oracle, 'data', 'authors', 'index.ts'), 'export const authors = [{ id: "test-author" }];\n');
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

function writeStubFlow(h, slug = 'test-slug') {
  const flow = join(h.root, 'flow');
  const scripts = join(flow, 'tools', 'scripts');
  const staging = join(flow, '_staging');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, 'PG-TEST-001-en.md'), `---\nslug: ${slug}\nauthor_id: test-author\n---\n# Test\n\nBody.\n`);
  writeFileSync(join(staging, 'PG-TEST-001-en.manifest.json'), JSON.stringify({ phase2_checks: { overall: 'pass' } }));
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
    assert.ok(claim.worktree && claim.worktree.startsWith(worktreeRoot), `unexpected worktree: ${claim.worktree}`);
    assert.notEqual(claim.worktree, h.oracle);
    assert.match(git(h.oracle, ['show', `${claim.branch}:data/articles/test-slug.ts`]), /authorId: "test-author"/);
  } finally {
    h.cleanup();
  }
});
