#!/usr/bin/env node

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../gg-gate-repair.mjs', import.meta.url));
const TMP = join(tmpdir(), `gg-gate-repair-test-${process.pid}`);
mkdirSync(TMP, { recursive: true });

test('astrology repair prompt aligns placement mismatches to the source draft unless ephemeris evidence is supplied', () => {
  const article = join(TMP, 'article.ts');
  const draft = join(TMP, 'draft.md');
  const capture = join(TMP, 'prompt.txt');
  const fake = join(TMP, 'fake-claude');
  writeFileSync(article, 'export const article = "Mars in Pisces";\n');
  writeFileSync(draft, '# Source draft\n\nMars in Aries.\n');
  writeFileSync(fake, `#!/bin/sh\ncat > '${capture}'\nprintf '%s' '{"edits":[],"note":"cannot-repair: test"}'\n`);
  chmodSync(fake, 0o755);

  const r = spawnSync(process.execPath, [
    SCRIPT,
    '--article', article,
    '--draft', draft,
    '--dimension', 'astrology',
    '--reason', 'article and draft disagree on the Mars sign',
  ], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      GG_GATE_REPAIR_BIN: fake,
    },
  });

  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const prompt = readFileSync(capture, 'utf8');
  assert.match(prompt, /source draft.*only allowed correction baseline/i);
  assert.match(prompt, /never replace.*model memory/i);
  assert.match(prompt, /deterministic ephemeris evidence/i);
});

test('cleanup', () => {
  rmSync(TMP, { recursive: true, force: true });
});
