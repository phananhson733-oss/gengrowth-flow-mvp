import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  activePageIdsFromPlan,
  validateSemanticRepairProof,
} from '../gg-seo-brief-preflight.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const flow = resolve(here, '../../..');
const preflight = resolve(flow, 'tools/scripts/gg-seo-brief-preflight.mjs');
const fixedWrapper = resolve(flow, 'tools/scripts/gg-topic-register-tick.sh');

const PROOF_KEYS = [
  'mode',
  'status',
  'product',
  'requested_page_ids',
  'selected_page_ids',
  'changed_page_ids',
  'cluster_repairs',
  'new_cluster_count',
  'created_page_id_count',
  'cross_product_write_count',
];

const REPAIR_KEYS = ['page_id', 'from', 'to', 'score', 'provenance'];

function repair(pageId, overrides = {}) {
  return {
    page_id: pageId,
    from: `old-${pageId.toLowerCase()}`,
    to: `existing-${pageId.toLowerCase()}`,
    score: 0.75,
    provenance: 'semantic-repair',
    ...overrides,
  };
}

function validResult({
  requested = ['PG-WDIF-002', 'PG-WDIN-001'],
  changed = ['PG-WDIF-002'],
  repairs = changed.map((pageId) => repair(pageId)),
  status = changed.length ? 'applied' : 'noop',
} = {}) {
  const newClusterCount = new Set(
    repairs
      .filter((row) => row.provenance === 'semantic-repair-new')
      .map((row) => row.to),
  ).size;
  return {
    ok: true,
    dry_run: false,
    budget_exhausted: false,
    proof: {
      mode: 'semantic-repair-only',
      status,
      product: 'astrologywiki',
      requested_page_ids: requested,
      selected_page_ids: changed,
      changed_page_ids: changed,
      cluster_repairs: repairs,
      new_cluster_count: newClusterCount,
      created_page_id_count: 0,
      cross_product_write_count: 0,
    },
    summaries: [],
  };
}

function fakeWrapper(path) {
  writeFileSync(path, [
    '#!/bin/bash',
    'set -eu',
    'node -e \'const fs = require("node:fs"); fs.writeFileSync(process.env.GG_TEST_ENV_FILE, JSON.stringify({',
    '  products: process.env.GG_TOPIC_REGISTER_PRODUCTS || null,',
    '  limit: process.env.GG_TOPIC_REGISTER_LIMIT || null,',
    '  llm: process.env.GG_TOPIC_REGISTER_LLM || null,',
    '  discover: process.env.GG_TOPIC_REGISTER_DISCOVER_EVIDENCE || null,',
    '  apply: process.env.GG_TOPIC_REGISTER_APPLY || null,',
    '  noNotify: process.env.GG_TOPIC_REGISTER_NO_NOTIFY || null,',
    '  targets: process.env.GG_TOPIC_REGISTER_REPAIR_PAGE_IDS ?? null,',
    '  semantic: process.env.GG_TOPIC_REGISTER_SEMANTIC_REPAIR_ONLY || null,',
    '  requireRun: process.env.GG_TOPIC_REGISTER_REQUIRE_RUN || null,',
    '  includeIncomplete: process.env.GG_TOPIC_REGISTER_INCLUDE_INCOMPLETE || null,',
    '  overwrite: process.env.GG_TOPIC_REGISTER_OVERWRITE || null,',
    '  taxonomyOnly: process.env.GG_TOPIC_REGISTER_TAXONOMY_ONLY || null,',
    '  repairKeywords: process.env.GG_TOPIC_REGISTER_REPAIR_KEYWORDS ?? null,',
    '  reassignExisting: process.env.GG_TOPIC_REGISTER_REASSIGN_EXISTING || null,',
    '}));\'',
    'if [ "${GG_TEST_WRITE_RESULT:-1}" = "1" ]; then',
    '  printf \'%s\' "$GG_TEST_RESULT_JSON" > "$GG_TOPIC_REGISTER_RESULT_FILE"',
    'fi',
    'if [ -n "${GG_TEST_WRAPPER_STDOUT:-}" ]; then printf \'%s\n\' "$GG_TEST_WRAPPER_STDOUT"; fi',
    'if [ -n "${GG_TEST_WRAPPER_STDERR:-}" ]; then printf \'%s\n\' "$GG_TEST_WRAPPER_STDERR" >&2; fi',
    'exit "${GG_TEST_WRAPPER_RC:-0}"',
    '',
  ].join('\n'));
  chmodSync(path, 0o755);
}

function harness({
  plan = '- [ ] `PG-WDIF-002` love language\n- [x] `PG-DONE-001` done\n- [ ] `PG-WDIN-001` intuition\n',
  result = validResult(),
  mutate = null,
  wrapperRc = 0,
  writeResult = true,
  wrapperStdout = '',
  wrapperStderr = '',
  inherited = {},
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gg-seo-brief-preflight-test-'));
  const planPath = join(root, 'plan.md');
  const wrapperPath = join(root, 'topic-register-wrapper.sh');
  const envFile = join(root, 'wrapper-env.json');
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, plan);
  fakeWrapper(wrapperPath);
  const mutated = mutate ? mutate(structuredClone(result)) : result;
  const encoded = typeof mutated === 'string' ? mutated : JSON.stringify(mutated);
  const run = () => spawnSync('node', [
    preflight,
    '--plan', planPath,
    '--topic-register-wrapper', wrapperPath,
    '--json',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GG_TEST_ENV_FILE: envFile,
      GG_TEST_RESULT_JSON: encoded,
      GG_TEST_WRAPPER_RC: String(wrapperRc),
      GG_TEST_WRITE_RESULT: writeResult ? '1' : '0',
      GG_TEST_WRAPPER_STDOUT: wrapperStdout,
      GG_TEST_WRAPPER_STDERR: wrapperStderr,
      ...inherited,
    },
  });
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return {
    run,
    cleanup,
    env: () => JSON.parse(readFileSync(envFile, 'utf8')),
    planPath,
    wrapperPath,
  };
}

function withHarness(options, check) {
  const h = harness(options);
  try {
    return check(h);
  } finally {
    h.cleanup();
  }
}

test('active page parser returns one sorted unique id set and ignores completed rows', () => {
  assert.deepEqual(activePageIdsFromPlan([
    '- [ ] `PG-WDIN-001` intuition',
    '- [x] `PG-DONE-001` done',
    '- [ ] PG-WDIF-002 love language',
    '',
  ].join('\n')), ['PG-WDIF-002', 'PG-WDIN-001']);
});

test('active page parser fails closed on duplicate or malformed unchecked ownership', () => {
  assert.throws(
    () => activePageIdsFromPlan('- [ ] `PG-WDIF-002` one\n- [ ] `PG-WDIF-002` two\n'),
    /duplicate active page ids/i,
  );
  assert.throws(
    () => activePageIdsFromPlan('- [ ] not-a-page-row\n'),
    /cannot parse active page id/i,
  );
  assert.throws(
    () => activePageIdsFromPlan('- [ ] `PG-WDIF-002` conflicts with `PG-WDIN-001`\n'),
    /exactly one active page id/i,
  );
});

test('preflight derives active ids and calls the fixed wrapper with zero-touch bounds', () => {
  withHarness({}, (h) => {
    const run = h.run();
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.deepEqual(JSON.parse(run.stdout).changed_page_ids, ['PG-WDIF-002']);
    assert.equal(run.stderr, '');
    assert.deepEqual(h.env(), {
      products: 'astrologywiki',
      limit: '2',
      llm: 'none',
      discover: '0',
      apply: '1',
      noNotify: '1',
      targets: 'PG-WDIF-002,PG-WDIN-001',
      semantic: '1',
      requireRun: '1',
      includeIncomplete: '0',
      overwrite: '0',
      taxonomyOnly: '0',
      repairKeywords: '',
      reassignExisting: '0',
    });
  });
});

test('preflight strict overrides cannot be weakened by inherited topic-register settings', () => {
  withHarness({
    inherited: {
      GG_TOPIC_REGISTER_PRODUCTS: 'all',
      GG_TOPIC_REGISTER_LLM: 'claude',
      GG_TOPIC_REGISTER_DISCOVER_EVIDENCE: '1',
      GG_TOPIC_REGISTER_APPLY: '0',
      GG_TOPIC_REGISTER_NO_NOTIFY: '0',
      GG_TOPIC_REGISTER_INCLUDE_INCOMPLETE: '1',
      GG_TOPIC_REGISTER_OVERWRITE: '1',
      GG_TOPIC_REGISTER_TAXONOMY_ONLY: '1',
      GG_TOPIC_REGISTER_REPAIR_KEYWORDS: 'outside',
      GG_TOPIC_REGISTER_REASSIGN_EXISTING: '1',
    },
  }, (h) => {
    const run = h.run();
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.deepEqual(h.env(), {
      products: 'astrologywiki',
      limit: '2',
      llm: 'none',
      discover: '0',
      apply: '1',
      noNotify: '1',
      targets: 'PG-WDIF-002,PG-WDIN-001',
      semantic: '1',
      requireRun: '1',
      includeIncomplete: '0',
      overwrite: '0',
      taxonomyOnly: '0',
      repairKeywords: '',
      reassignExisting: '0',
    });
  });
});

for (const [name, mutate] of [
  ['malformed JSON', () => '{'],
  ['wrong mode', (value) => ({ ...value, proof: { ...value.proof, mode: 'generate' } })],
  ['wrong product', (value) => ({ ...value, proof: { ...value.proof, product: 'gengrowth' } })],
  ['request mismatch', (value) => ({ ...value, proof: { ...value.proof, requested_page_ids: ['PG-OTHER-001'] } })],
  ['selected outside active set', (value) => ({ ...value, proof: { ...value.proof, selected_page_ids: ['PG-OTHER-001'] } })],
  ['created page id', (value) => ({ ...value, proof: { ...value.proof, created_page_id_count: 1 } })],
  ['cross-product write', (value) => ({ ...value, proof: { ...value.proof, cross_product_write_count: 1 } })],
  ['skipped run', (value) => ({ ...value, proof: { ...value.proof, status: 'skipped' } })],
  ['dry run', (value) => ({ ...value, dry_run: true })],
  ['budget exhaustion', (value) => ({ ...value, budget_exhausted: true })],
  ['unsuccessful result', (value) => ({ ...value, ok: false })],
  ['missing summaries array', (value) => ({ ...value, summaries: null })],
  ['unexpected root state', (value) => ({ ...value, skipped: true })],
]) {
  test(`preflight rejects ${name}`, () => {
    withHarness({ mutate }, (h) => {
      const run = h.run();
      assert.equal(run.status, 1, `${name}: ${run.stdout}${run.stderr}`);
      assert.equal(run.stdout, '');
      assert.match(run.stderr, /^active brief preflight failed: .+\n$/);
    });
  });
}

test('preflight rejects lock-busy rc 75, arbitrary wrapper failure, and missing result', () => {
  for (const options of [
    { wrapperRc: 75 },
    { wrapperRc: 9 },
    { writeResult: false },
  ]) {
    withHarness(options, (h) => {
      const run = h.run();
      assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
      assert.equal(run.stdout, '');
      assert.match(run.stderr, /^active brief preflight failed: .+\n$/);
    });
  }
});

test('preflight suppresses wrapper output and inherited sensitive sentinel values', () => {
  const sentinel = 'SENSITIVE-DATA-SHOULD-NOT-LEAK';
  withHarness({
    wrapperRc: 9,
    wrapperStdout: sentinel,
    wrapperStderr: sentinel,
    inherited: { GG_FAKE_SENSITIVE_SENTINEL: sentinel },
  }, (h) => {
    const run = h.run();
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.doesNotMatch(run.stderr, new RegExp(sentinel));
  });
});

test('proof schema and every repair row require exact keys', () => {
  const extraProof = validResult();
  extraProof.proof.extra = true;
  assert.throws(
    () => validateSemanticRepairProof(extraProof, ['PG-WDIF-002', 'PG-WDIN-001']),
    /proof schema/i,
  );

  for (const row of [
    { ...repair('PG-WDIF-002'), extra: true },
    Object.fromEntries(Object.entries(repair('PG-WDIF-002')).filter(([key]) => key !== 'score')),
  ]) {
    const value = validResult({ repairs: [row] });
    assert.throws(
      () => validateSemanticRepairProof(value, ['PG-WDIF-002', 'PG-WDIN-001']),
      /repair row schema/i,
    );
  }
  assert.deepEqual(Object.keys(validResult().proof), PROOF_KEYS);
  assert.deepEqual(Object.keys(repair('PG-WDIF-002')), REPAIR_KEYS);
});

test('proof rejects malformed, duplicate, or unsorted id arrays', () => {
  const cases = [
    (value) => { value.proof.requested_page_ids = ['PG-WDIN-001', 'PG-WDIF-002']; },
    (value) => { value.proof.selected_page_ids = ['PG-WDIF-002', 'PG-WDIF-002']; },
    (value) => { value.proof.changed_page_ids = ['PG-WDIF-002', 'PG-WDIF-002']; },
    (value) => { value.proof.changed_page_ids = [42]; },
    (value) => { value.proof.selected_page_ids = ['pg-wdif-002']; },
  ];
  for (const mutate of cases) {
    const value = validResult();
    mutate(value);
    assert.throws(
      () => validateSemanticRepairProof(value, ['PG-WDIF-002', 'PG-WDIN-001']),
      /page ids|selected and changed/i,
    );
  }
});

test('proof requires selected, changed, and repair ids to form an exact unique bijection', () => {
  for (const value of [
    validResult({
      changed: ['PG-WDIF-002'],
      repairs: [repair('PG-WDIN-001')],
    }),
    validResult({
      changed: ['PG-WDIF-002'],
      repairs: [repair('PG-WDIF-002'), repair('PG-WDIF-002')],
    }),
  ]) {
    assert.throws(
      () => validateSemanticRepairProof(value, ['PG-WDIF-002', 'PG-WDIN-001']),
      /repair provenance|bijection/i,
    );
  }
});

test('proof rejects invalid repair values and provenance', () => {
  const invalidRows = [
    repair('PG-WDIF-002', { page_id: '' }),
    repair('PG-WDIF-002', { from: '' }),
    repair('PG-WDIF-002', { to: '   ' }),
    repair('PG-WDIF-002', { score: '0.75' }),
    repair('PG-WDIF-002', { score: null }),
    repair('PG-WDIF-002', { score: Number.NaN }),
    repair('PG-WDIF-002', { score: Number.POSITIVE_INFINITY }),
    repair('PG-WDIF-002', { provenance: 'manual-repair' }),
  ];
  for (const row of invalidRows) {
    const value = validResult({ repairs: [row] });
    assert.throws(
      () => validateSemanticRepairProof(value, ['PG-WDIF-002', 'PG-WDIN-001']),
      /repair row|provenance/i,
    );
  }
});

test('proof counts unique semantic-repair-new target clusters exactly', () => {
  const changed = ['PG-WDIF-002', 'PG-WDIN-001'];
  const repairs = changed.map((pageId) => repair(pageId, {
    to: 'shared-new-cluster',
    provenance: 'semantic-repair-new',
  }));
  const valid = validResult({ changed, repairs });
  assert.equal(validateSemanticRepairProof(valid, changed).new_cluster_count, 1);

  for (const count of [0, 2, -1, 1.5, '1']) {
    const value = structuredClone(valid);
    value.proof.new_cluster_count = count;
    assert.throws(
      () => validateSemanticRepairProof(value, changed),
      /new cluster/i,
    );
  }
});

test('proof status is applied exactly for changes and noop exactly without changes', () => {
  const appliedWithoutChanges = validResult({ changed: [], status: 'applied' });
  const noopWithChanges = validResult({ status: 'noop' });
  assert.throws(
    () => validateSemanticRepairProof(appliedWithoutChanges, ['PG-WDIF-002', 'PG-WDIN-001']),
    /status/i,
  );
  assert.throws(
    () => validateSemanticRepairProof(noopWithChanges, ['PG-WDIF-002', 'PG-WDIN-001']),
    /status/i,
  );
});

test('empty plan invokes strict zero-target wrapper and accepts a legal no-op', () => {
  withHarness({
    plan: '- [x] `PG-DONE-001` done\n',
    result: validResult({ requested: [], changed: [] }),
  }, (h) => {
    const run = h.run();
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.equal(JSON.parse(run.stdout).status, 'noop');
    assert.equal(h.env().limit, '0');
    assert.equal(h.env().targets, '');
  });
});

test('empty plan works through the real fixed wrapper without a writer identity file', () => {
  const root = mkdtempSync(join(tmpdir(), 'gg-seo-brief-empty-real-wrapper-'));
  try {
    const planPath = join(root, 'plan.md');
    writeFileSync(planPath, '- [x] `PG-DONE-001` done\n');
    const run = spawnSync('node', [
      preflight,
      '--plan', planPath,
      '--topic-register-wrapper', fixedWrapper,
      '--json',
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: root,
        GG_TOPIC_REGISTER_ENV_FILE: '/dev/null',
        GG_TOPIC_REGISTER_LOG_DIR: join(root, 'logs'),
        GG_TOPIC_REGISTER_LOCK: join(root, 'topic-register.lock'),
        GG_WRITER_SA_JSON: join(root, 'missing-writer-sa.json'),
      },
    });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    const proof = JSON.parse(run.stdout);
    assert.equal(proof.status, 'noop');
    assert.deepEqual(proof.requested_page_ids, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI requires absolute plan and wrapper paths plus --json', () => {
  for (const args of [
    [],
    ['--plan', 'relative.md', '--topic-register-wrapper', fixedWrapper, '--json'],
    ['--plan', '/tmp/plan.md', '--topic-register-wrapper', 'relative.sh', '--json'],
    ['--plan', '/tmp/plan.md', '--topic-register-wrapper', fixedWrapper],
  ]) {
    const run = spawnSync('node', [preflight, ...args], { encoding: 'utf8' });
    assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /^active brief preflight failed: .+\n$/);
  }
});
