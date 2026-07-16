// Regression tests locking the two cross-site non-negotiables for gengrowth.ai (Lane A).
//
// These guard LITERALS that live in two different shared files:
//   1) tools/scripts/gg-gengrowth-publish.mjs  — DRAFT_RE (the staging-filename contract)
//   2) tools/scripts/gg-seo-autopilot.mjs       — latestPlan() gengrowth exclusion filter
//
// Neither literal is exported, so this test is deliberately black-box / source-assertion:
// it reads the real repo source, asserts the canonical literals are still present verbatim,
// reconstructs the real regex from those same literals, and asserts behavior. If a future
// edit mangles either literal, one of these assertions fails loudly.
//
// Why source-assertion instead of import: importing gg-gengrowth-publish.mjs / gg-seo-autopilot.mjs
// would execute their top-level side effects (path resolution, arg parsing) and would couple this
// guard to unrelated runtime. We only need to prove the two literals are intact and self-consistent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve the real repo root. This test lives in /tmp/gg-landing-staging/__tests__ during
// authoring, but is written to land under tools/scripts/__tests__ later. Probe both: the
// real checkout under the user's home, then a relative climb (works once landed in-repo).
function findRepoRoot() {
  const candidates = [
    // landed location: tools/scripts/__tests__/<this> -> repo root is ../../..
    resolve(__dirname, '..', '..', '..'),
    // authoring location: explicit known checkout on this machine
    resolve(process.env.HOME || '', 'gengrowth-flow-mvp'),
    resolve(process.env.HOME || '', 'oracle'),
  ];
  for (const root of candidates) {
    if (existsSync(resolve(root, 'tools', 'scripts', 'gg-gengrowth-publish.mjs'))) return root;
  }
  // Allow explicit override for hermetic CI.
  if (process.env.GG_REPO_ROOT && existsSync(resolve(process.env.GG_REPO_ROOT, 'tools', 'scripts', 'gg-gengrowth-publish.mjs'))) {
    return process.env.GG_REPO_ROOT;
  }
  return null;
}

const REPO = findRepoRoot();
const PUBLISH_SRC_PATH = REPO && resolve(REPO, 'tools', 'scripts', 'gg-gengrowth-publish.mjs');
const AUTOPILOT_SRC_PATH = REPO && resolve(REPO, 'tools', 'scripts', 'gg-seo-autopilot.mjs');
const AUTHOR_TICK_SRC_PATH = REPO && resolve(REPO, 'tools', 'scripts', 'gg-gengrowth-author-tick.sh');

// ── Canonical fixtures ───────────────────────────────────────────────────────
// A canonical staging filename that MUST match DRAFT_RE: <pageId>-<model>-v8.md where
// pageId = PG-<W25prefix>-NNN. WLS is the first registered W25 prefix.
const CANONICAL_NAME = 'PG-WLS-001-claude-v8.md';
// A mangled name (missing the -v8 suffix) that MUST NOT match.
const MANGLED_NAME = 'PG-WLS-001-claude.md';

// ── Reconstruct the real DRAFT_RE from the live source literals ──────────────
// We extract the exact W25_PREFIXES array and the exact RegExp template from source,
// so the regex under test is byte-for-byte the publisher's, not a hand-copy.
function loadRealDraftRe(src) {
  const arrM = src.match(/const W25_PREFIXES = \[([^\]]*)\];/);
  assert.ok(arrM, 'W25_PREFIXES array literal must still be present in gg-gengrowth-publish.mjs');
  const W25_PREFIXES = arrM[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);

  // Assert the exact RegExp construction line is still present (guards the literal).
  // Use a verbatim substring match — robust against regex over-escaping; this is the
  // literal source line from gg-gengrowth-publish.mjs.
  const DRAFT_RE_LITERAL =
    "const DRAFT_RE = new RegExp(`^(PG-(?:${W25_PREFIXES.join('|')})-\\\\d+)-[a-z0-9]+-v8\\\\.md$`, 'i');";
  assert.ok(
    src.includes(DRAFT_RE_LITERAL),
    'DRAFT_RE construction literal in gg-gengrowth-publish.mjs changed — the staging-filename contract is load-bearing and shared with the autopilot <pageId>-<model>-v8.md convention',
  );

  // Rebuild the identical regex from the extracted prefixes.
  return new RegExp(`^(PG-(?:${W25_PREFIXES.join('|')})-\\d+)-[a-z0-9]+-v8\\.md$`, 'i');
}

// The autopilot's own pgId / task convention (parseTasks) — the <pageId> half of
// <pageId>-<model>-v8.md. Loaded below from the gg-seo-autopilot.mjs parseTasks literal.
function loadRealAutopilotPgIdRe(src) {
  const literal = '`?(PG-[A-Z0-9]+-\\d+)`?';
  assert.ok(
    src.includes(literal),
    'gg-seo-autopilot.mjs parseTasks must allow numeric characters in W25 prefixes',
  );
  return /(PG-[A-Z0-9]+-\d+)/;
}

// ─────────────────────────────────────────────────────────────────────────────

test('repo root + shared source files are discoverable', () => {
  assert.ok(REPO, 'could not locate repo root (set GG_REPO_ROOT to the checkout for hermetic runs)');
  assert.ok(existsSync(PUBLISH_SRC_PATH), `missing ${PUBLISH_SRC_PATH}`);
  assert.ok(existsSync(AUTOPILOT_SRC_PATH), `missing ${AUTOPILOT_SRC_PATH}`);
  assert.ok(existsSync(AUTHOR_TICK_SRC_PATH), `missing ${AUTHOR_TICK_SRC_PATH}`);
});

test('invariant 1: canonical staging filename matches the real gengrowth DRAFT_RE', () => {
  const src = readFileSync(PUBLISH_SRC_PATH, 'utf8');
  const DRAFT_RE = loadRealDraftRe(src);

  assert.ok(
    DRAFT_RE.test(CANONICAL_NAME),
    `${CANONICAL_NAME} must match the gengrowth publisher DRAFT_RE`,
  );

  // The captured group must be exactly the pageId — i.e. DRAFT_RE and the autopilot's
  // <pageId>-<model>-v8.md naming agree on the pageId boundary.
  const m = CANONICAL_NAME.match(DRAFT_RE);
  assert.equal(m[1], 'PG-WLS-001', 'DRAFT_RE capture group must isolate the pageId');
});

test('invariant 1: all current W25 gengrowth plan prefixes match the publisher DRAFT_RE', () => {
  const src = readFileSync(PUBLISH_SRC_PATH, 'utf8');
  const DRAFT_RE = loadRealDraftRe(src);
  const names = [
    'PG-WLS-006-claude-v8.md',
    'PG-GJ2U-001-claude-v8.md',
    'PG-AIS-005-claude-v8.md',
    'PG-WHS-001-claude-v8.md',
  ];
  for (const name of names) {
    assert.ok(DRAFT_RE.test(name), `${name} must be publishable by the gengrowth publisher`);
  }
});

test('invariant 1: author tick plan parser recognizes alphanumeric W25 prefixes', () => {
  const src = readFileSync(AUTHOR_TICK_SRC_PATH, 'utf8');
  const literalMatches = src.match(/PG-\[A-Z0-9\]\+-\[0-9\]\+/g) ?? [];
  assert.ok(
    literalMatches.length >= 2,
    'gg-gengrowth-author-tick.sh must allow numeric characters in W25 prefixes while grepping and extracting unchecked plan items',
  );

  const line = '- [ ] `PG-GJ2U-001` google july 2026 update';
  const m = line.match(/^- \[ \] *`?(PG-[A-Z0-9]+-[0-9]+)`? *(.*)$/);
  assert.ok(m, 'PG-GJ2U-001 must parse from a normal unchecked W25 plan row');
  assert.equal(m[1], 'PG-GJ2U-001');
});

test('invariant 1: author tick immediately runs gengrowth publish follow-up after handoff', () => {
  const src = readFileSync(AUTHOR_TICK_SRC_PATH, 'utf8');

  assert.match(
    src,
    /PUBLISH_TICK=.*gg-gengrowth-publish-tick\.sh/,
    'gg-gengrowth-author-tick.sh must know the deterministic publish wrapper path',
  );
  assert.match(
    src,
    /GG_GENGROWTH_AUTHOR_AUTOPUBLISH/,
    'author tick must expose an opt-out knob while defaulting to publish follow-up',
  );
  assert.match(
    src,
    /HANDOFFS=\$\(\(HANDOFFS \+ 1\)\)/,
    'author tick must count successful handoffs so publish follow-up only runs after authored drafts',
  );
  assert.match(
    src,
    /bash "\$PUBLISH_TICK"/,
    'author tick must run the existing publish tick wrapper instead of bypassing it',
  );
  assert.match(
    src,
    /gg-seo-repair-controller\.mjs" import-v1 --site gengrowth/,
    'v2 author failures must enter the shared repair controller through the natural wrapper',
  );
  assert.equal(
    (src.match(/gg-seo-repair-controller\.mjs" import-v1 --site gengrowth/g) || []).length,
    1,
    'author tick must have exactly one compatibility import call',
  );
  assert.doesNotMatch(
    src,
    /--log-offset 0/,
    'author tick must never import the whole cumulative log',
  );
  assert.match(
    src,
    /--log-offset "\$LOG_OFFSET_START"/,
    'author tick must import only the fire-local log window',
  );
  assert.match(
    src,
    /--run-id "\$RUN_ID"/,
    'author tick must pass one explicit run id to import-v1',
  );
  assert.match(
    src,
    /GG_SEO_REPAIR_BUDGET_SECONDS:-1500/,
    'author tick default repair budget must be 25 minutes',
  );
  assert.match(
    src,
    /trap ['"]?on_exit['"]? EXIT/,
    'all normal and explicit exits must converge through one EXIT finalizer',
  );
  assert.doesNotMatch(
    src,
    /if \[ "\$\{GG_SEO_REPAIR_CONTROLLER_V2_ENABLED:-0\}" = "1" \]; then run_repair_controller/,
    'per-error compatibility imports must be removed',
  );
  assert.match(
    src,
    /publish follow-up:[\s\S]*GG_SEO_REPAIR_CONTROLLER_V2_ENABLED[\s\S]*run_repair_controller "\$rc"/,
    'v2 publish follow-up failures must call the repair controller instead of notifying people directly',
  );
  assert.match(
    src,
    /missing \$PUBLISH_TICK[\s\S]*GG_SEO_REPAIR_CONTROLLER_V2_ENABLED[\s\S]*run_repair_controller 2/,
    'v2 missing publish wrapper must enter the repair controller instead of notifying people directly',
  );
});

test('invariant 1: the autopilot <pageId>-<model>-v8.md convention agrees on the same pageId', () => {
  const src = readFileSync(AUTOPILOT_SRC_PATH, 'utf8');
  const AUTOPILOT_PGID_RE = loadRealAutopilotPgIdRe(src);

  // The autopilot's parseTasks extracts PG-<PREFIX>-NNN; the worker output is named
  // <pageId>-<model>-v8.md. Assert the canonical filename decomposes consistently:
  // pageId (autopilot side) + '-' + model + '-v8.md' (publisher side).
  const pgM = CANONICAL_NAME.match(AUTOPILOT_PGID_RE);
  assert.ok(pgM, 'autopilot pgId regex must extract the pageId from the canonical name');
  const pageId = pgM[1];
  assert.equal(pageId, 'PG-WLS-001');

  // Reconstruct <pageId>-<model>-v8.md and confirm it is exactly the canonical name.
  const model = 'claude';
  assert.equal(`${pageId}-${model}-v8.md`, CANONICAL_NAME, 'naming convention drift between the two files');

  const alphanumericM = '- [ ] `PG-GJ2U-001` google july 2026 update'.match(AUTOPILOT_PGID_RE);
  assert.ok(alphanumericM, 'autopilot parseTasks must recognize PG-GJ2U-001');
  assert.equal(alphanumericM[1], 'PG-GJ2U-001');
});

test('invariant 1: a mangled filename (missing -v8) does NOT match DRAFT_RE', () => {
  const src = readFileSync(PUBLISH_SRC_PATH, 'utf8');
  const DRAFT_RE = loadRealDraftRe(src);
  assert.equal(
    DRAFT_RE.test(MANGLED_NAME),
    false,
    `${MANGLED_NAME} must NOT match DRAFT_RE — the -v8 suffix is part of the contract`,
  );
});

test('invariant 2: the autopilot latestPlan() exclusion filter /gengrowth/i is present', () => {
  const src = readFileSync(AUTOPILOT_SRC_PATH, 'utf8');
  // Guard the literal filter line. If this regex disappears, the astrologywiki/oracle
  // autopilot could claim/author gengrowth.ai (Lane A) tasks — cross-site contamination.
  assert.match(
    src,
    /\.filter\(\(f\) => !\/gengrowth\/i\.test\(f\)\)/,
    'latestPlan() gengrowth exclusion filter changed/removed in gg-seo-autopilot.mjs — cross-site contamination guard',
  );
});

test('invariant 2: a gengrowth plan filename would be filtered out by the real predicate', () => {
  // Replicate the exact predicate used inside latestPlan().
  const exclude = (f) => !/gengrowth/i.test(f);

  const gengrowthPlans = [
    '2026-06-16-W25-gengrowth-blog-output-plan.md',
    '2026-06-17-Gengrowth-blog-output-plan.md', // case-insensitive
    'gengrowth-blog-output-plan.md',
  ];
  for (const f of gengrowthPlans) {
    assert.equal(exclude(f), false, `${f} must be EXCLUDED by the gengrowth filter`);
  }

  // A normal (non-gengrowth) plan must survive the filter.
  const keep = '2026-06-08-W24-blog-output-plan.md';
  assert.equal(exclude(keep), true, `${keep} must NOT be excluded`);

  // And it must still pass the discovery glob the filter is chained onto.
  assert.match(keep, /blog-output-plan.*\.md$/, 'non-gengrowth plan must match the discovery glob');
});
