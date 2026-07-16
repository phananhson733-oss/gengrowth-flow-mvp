import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function runHelper(args, stagingDir) {
  return spawnSync(process.execPath, [HELPER, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GG_GENGROWTH_STAGING_DIR: stagingDir,
      GG_WINNER_LLM: 'claude',
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

test('author tick delegates handoff validation and copying to the shared helper', async () => {
  const source = await readFile(TICK, 'utf8');
  assert.match(source, /gg-gengrowth-author-handoff\.mjs/);
  assert.doesNotMatch(source, /^manifest_pass\(\)/m);
  assert.doesNotMatch(source, /^draft_sane\(\)/m);
  assert.doesNotMatch(source, /cp -f "\$EN_MD"/);
});
