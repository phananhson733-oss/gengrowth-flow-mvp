import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handoffGengrowthAuthor } from '../gg-gengrowth-author-handoff.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = resolve(TEST_DIR, '..');
const HELPER = join(SCRIPTS_DIR, 'gg-gengrowth-author-handoff.mjs');
const TICK = join(SCRIPTS_DIR, 'gg-gengrowth-author-tick.sh');

function validDraft(slug = 'software-development-services') {
  return `---\nslug: ${slug}\ntitle: Test\n---\n\n# Test\n\n${'valid body '.repeat(50)}\n`;
}

async function handoffFixture(t) {
  const stagingDir = await mkdtemp(join(tmpdir(), 'gg-author-handoff-'));
  t.after(async () => rm(stagingDir, { recursive: true, force: true }));
  const pageId = 'PG-SDS-004';
  const sourceMd = join(stagingDir, `${pageId}-en.md`);
  const sourceManifest = join(stagingDir, `${pageId}-en.manifest.json`);
  await writeFile(sourceMd, validDraft(), 'utf8');
  await writeFile(sourceManifest, `${JSON.stringify({ phase2_checks: { overall: 'pass' } })}\n`, 'utf8');
  return { stagingDir, pageId, sourceMd, sourceManifest };
}

function runHelper(args, stagingDir, winner = 'claude') {
  return spawnSync(process.execPath, [HELPER, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GG_GENGROWTH_STAGING_DIR: stagingDir,
      GG_WINNER_LLM: winner,
    },
  });
}

test('author handoff copies one sane passing PID pair byte-for-byte and emits one JSON result', async (t) => {
  const built = await handoffFixture(t);
  const result = runHelper(['--page-id', built.pageId], built.stagingDir);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const output = JSON.parse(lines[0]);
  assert.deepEqual(output, {
    ok: true,
    handedOff: true,
    pageId: built.pageId,
    winner: 'claude',
    draft: `${built.pageId}-claude-v8.md`,
    manifest: `${built.pageId}-claude-v8.manifest.json`,
  });
  assert.deepEqual(
    await readFile(join(built.stagingDir, `${built.pageId}-claude-v8.md`)),
    await readFile(built.sourceMd),
  );
  assert.deepEqual(
    await readFile(join(built.stagingDir, `${built.pageId}-claude-v8.manifest.json`)),
    await readFile(built.sourceManifest),
  );
});

test('a non-default safe winner remains consumable by the real publisher scanner', async (t) => {
  const built = await handoffFixture(t);
  const result = runHelper(['--page-id', built.pageId], built.stagingDir, 'codex');
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.draft, `${built.pageId}-codex-v8.md`);

  const publisher = spawnSync(process.execPath, [
    join(SCRIPTS_DIR, 'gg-gengrowth-publish.mjs'),
    '--staging-dir', built.stagingDir,
    '--pages', built.pageId,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SB_URL: 'http://127.0.0.1:9',
      SB_KEY: '',
    },
  });
  assert.equal(publisher.status, 0, publisher.stderr);
  assert.match(publisher.stdout, /1 ready draft\(s\)/);
  assert.match(publisher.stdout, new RegExp(`${built.pageId}\\s+software-development-services\\s+PUBLISH\\?`));
});

test('author handoff rejects path-like IDs and refuses bad manifests or truncated drafts', async (t) => {
  const built = await handoffFixture(t);
  const pathResult = runHelper(['--page-id', '../PG-SDS-004'], built.stagingDir);
  assert.notEqual(pathResult.status, 0);
  assert.equal(JSON.parse(pathResult.stdout.trim()).ok, false);

  await writeFile(built.sourceManifest, `${JSON.stringify({ phase2_checks: { overall: 'fail' } })}\n`, 'utf8');
  const badManifest = runHelper(['--page-id', built.pageId], built.stagingDir);
  assert.notEqual(badManifest.status, 0);
  assert.equal(JSON.parse(badManifest.stdout.trim()).reason, 'manifest_not_pass');

  await writeFile(built.sourceManifest, `${JSON.stringify({ phase2_checks: { overall: 'pass' } })}\n`, 'utf8');
  await writeFile(built.sourceMd, '---\nslug: x\n---\nshort\n', 'utf8');
  const truncated = runHelper(['--page-id', built.pageId], built.stagingDir);
  assert.notEqual(truncated.status, 0);
  assert.equal(JSON.parse(truncated.stdout.trim()).reason, 'draft_not_sane');
});

test('author handoff restores an existing ready pair when replacement fails before manifest commit', async (t) => {
  const built = await handoffFixture(t);
  const targetMd = join(built.stagingDir, `${built.pageId}-claude-v8.md`);
  const targetManifest = join(built.stagingDir, `${built.pageId}-claude-v8.manifest.json`);
  const oldDraft = validDraft('old-live-slug');
  const oldManifest = `${JSON.stringify({ phase2_checks: { overall: 'pass' }, version: 'old' })}\n`;
  await writeFile(targetMd, oldDraft, 'utf8');
  await writeFile(targetManifest, oldManifest, 'utf8');

  await assert.rejects(() => handoffGengrowthAuthor({
    pageId: built.pageId,
    stagingDir: built.stagingDir,
    winner: 'claude',
  }, {
    faultInjector: async (point) => {
      if (point === 'after-draft-before-manifest') throw new Error('simulated handoff cut');
    },
  }), /simulated handoff cut/);

  assert.equal(await readFile(targetMd, 'utf8'), oldDraft);
  assert.equal(await readFile(targetManifest, 'utf8'), oldManifest);
  assert.deepEqual(
    (await readdir(built.stagingDir)).filter((name) => name.startsWith('.handoff-')),
    [],
  );

  const output = await handoffGengrowthAuthor({
    pageId: built.pageId,
    stagingDir: built.stagingDir,
    winner: 'claude',
  });
  assert.equal(output.handedOff, true);
  assert.deepEqual(await readFile(targetMd), await readFile(built.sourceMd));
  assert.deepEqual(await readFile(targetManifest), await readFile(built.sourceManifest));
});

test('author handoff preserves rollback backups when restoring the old pair itself fails', async (t) => {
  const built = await handoffFixture(t);
  const targetMd = join(built.stagingDir, `${built.pageId}-claude-v8.md`);
  const targetManifest = join(built.stagingDir, `${built.pageId}-claude-v8.manifest.json`);
  await writeFile(targetMd, validDraft('old-live-slug'), 'utf8');
  await writeFile(targetManifest, `${JSON.stringify({ phase2_checks: { overall: 'pass' }, version: 'old' })}\n`, 'utf8');

  await assert.rejects(() => handoffGengrowthAuthor({
    pageId: built.pageId,
    stagingDir: built.stagingDir,
    winner: 'claude',
  }, {
    faultInjector: async (point) => {
      if (point === 'after-draft-before-manifest') throw new Error('simulated handoff cut');
    },
    renameFile: async (from, to) => {
      if (from.endsWith('.md.bak')) throw new Error('simulated rollback disk failure');
      return rename(from, to);
    },
  }), /handoff recovery failed/i);

  const leftovers = (await readdir(built.stagingDir)).filter((name) => name.startsWith('.handoff-'));
  assert.equal(leftovers.some((name) => name.endsWith('.md.bak')), true);
  assert.equal(leftovers.some((name) => name.endsWith('.manifest.bak')), true);
});

test('author handoff refuses an incomplete pre-existing target pair', async (t) => {
  const built = await handoffFixture(t);
  await writeFile(
    join(built.stagingDir, `${built.pageId}-claude-v8.md`),
    validDraft('orphan-draft'),
    'utf8',
  );
  await assert.rejects(() => handoffGengrowthAuthor({
    pageId: built.pageId,
    stagingDir: built.stagingDir,
    winner: 'claude',
  }), /incomplete existing target/i);
});

test('author tick delegates handoff validation and copying to the shared helper', async () => {
  const source = await readFile(TICK, 'utf8');
  assert.match(source, /gg-gengrowth-author-handoff\.mjs/);
  assert.doesNotMatch(source, /^manifest_pass\(\)/m);
  assert.doesNotMatch(source, /^draft_sane\(\)/m);
  assert.doesNotMatch(source, /cp -f "\$EN_MD"/);
});
