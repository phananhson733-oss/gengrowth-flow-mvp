#!/usr/bin/env node

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_ORACLE_GITHUB_REPO,
  resolveOracleGithubRepo,
} from '../lib/github-repo-config.mjs';

test('Oracle GitHub repository defaults to the replacement account', () => {
  assert.equal(DEFAULT_ORACLE_GITHUB_REPO, 'phananhson733-oss/oracle');
  assert.equal(resolveOracleGithubRepo({}), 'phananhson733-oss/oracle');
});

test('Oracle GitHub repository can be overridden without editing scripts', () => {
  assert.equal(
    resolveOracleGithubRepo({ GG_ORACLE_GITHUB_REPO: 'example/oracle-fork' }),
    'example/oracle-fork',
  );
});

test('production scripts no longer target the suspended GitHub owner', () => {
  const scriptsDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const legacyRepo = ['xdawayer', 'oracle'].join('/');
  const hits = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (readFileSync(path, 'utf8').includes(legacyRepo)) hits.push(path);
    }
  };
  visit(scriptsDir);
  assert.deepEqual(hits, []);
});
