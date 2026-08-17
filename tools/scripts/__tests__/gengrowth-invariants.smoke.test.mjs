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
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  // Strip // comments before splitting on commas. A prose comment inside the array (they
  // carry commas and parentheses) would otherwise be split into fake "prefixes" and joined
  // into DRAFT_RE as extra alternation branches — the real module is unaffected, but the
  // regex under test would stop being byte-for-byte the publisher's, which is the whole point.
  const W25_PREFIXES = arrM[1]
    .replace(/\/\/[^\n]*/g, '')
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
    /node "\$REPAIR_CONTROLLER" import-v1 --site gengrowth/,
    'v2 author failures must enter the shared repair controller through the natural wrapper',
  );
  assert.equal(
    (src.match(/node "\$REPAIR_CONTROLLER" import-v1 --site gengrowth/g) || []).length,
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
    /publish follow-up:[\s\S]*GG_SEO_REPAIR_CONTROLLER_V2_ENABLED:-0\}" != "1"/,
    'publish follow-up failures must retain direct notifications only in legacy mode',
  );
  assert.match(
    src,
    /missing \$PUBLISH_TICK[\s\S]*GG_SEO_REPAIR_CONTROLLER_V2_ENABLED:-0\}" != "1"/,
    'missing publish wrapper must rely on the one finalizer in v2 and notify only in legacy mode',
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

// ── invariant 3: the astrology authority allowlist must never reach a gengrowth prompt ──
//
// authority-allowlist.json is keyed by author_id, and all four personas in it are ASTROLOGY
// personas. gengrowth (B2B SEO) has no persona of its own, so gg-seo-autopilot's author
// routing falls back to marcus-orion — which used to render, into a post about keyword
// research, "仅允许命名以下真实奠基人来锚定权威: Dane Rudhyar, Robert Hand, …".
// Fabricated / mis-attributed sources is what the W25 retro found in 15 of 31 published
// gengrowth articles. gengrowth needs no replacement list: red-lines.gengrowth.checkRL12
// enforces citation integrity via real markdown links instead.
test('invariant 3: authorityAllowlist() is empty for gengrowth, unchanged for oracle', async () => {
  const { authorityAllowlist } = await import(
    pathToFileURL(resolve(REPO, 'tools', 'scripts', 'lib', '_render-aura-shared.mjs')).href
  );
  const cfg = { author_id: 'marcus-orion' };
  const prev = process.env.GG_SITE;
  try {
    // Default (oracle) path must keep naming the astrology lineage.
    process.env.GG_SITE = '';
    const oracle = authorityAllowlist(cfg);
    assert.ok(oracle.length > 0, 'oracle must still receive its authority allowlist block');
    assert.match(oracle, /Rudhyar/, 'oracle allowlist content changed unexpectedly');

    // gengrowth must receive nothing at all.
    process.env.GG_SITE = 'gengrowth';
    const gg = authorityAllowlist(cfg);
    assert.equal(gg, '', 'gengrowth must get an EMPTY authority allowlist block');
    for (const name of ['Rudhyar', 'Liz Greene', 'Robert Hand', 'Stephen Arroyo', 'Tarnas']) {
      assert.doesNotMatch(gg, new RegExp(name, 'i'), `astrology authority "${name}" leaked into a gengrowth prompt`);
    }
  } finally {
    if (prev === undefined) delete process.env.GG_SITE; else process.env.GG_SITE = prev;
  }
});

// ── invariant 4: every gengrowth cluster prefix must be publishable ──
//
// A prefix missing from W25_PREFIXES does not fail loudly: scanReady just never matches the
// draft, and the finished article sits authored-but-unpublished forever. These three were
// added on 2026-08-07 with the keyword_opportunity / search_performance_diagnosis /
// internal_link_architecture clusters.
test('invariant 4: DRAFT_RE accepts the 2026-08-07 cluster prefixes', () => {
  const src = readFileSync(PUBLISH_SRC_PATH, 'utf8');
  const m = src.match(/const W25_PREFIXES = \[([\s\S]*?)\];/);
  assert.ok(m, 'W25_PREFIXES literal not found in gg-gengrowth-publish.mjs');
  // Comments stripped first — see invariant 8 for why a quoted prefix inside a comment
  // must not be read as an array element.
  const prefixes = [...m[1].replace(/\/\/[^\n]*/g, '').matchAll(/'([A-Z0-9]+)'/g)].map((x) => x[1]);
  for (const p of ['KOD', 'SPD', 'ILA']) {
    assert.ok(prefixes.includes(p), `prefix ${p} missing — its articles would never publish`);
  }
  const re = new RegExp(`^(PG-(?:${prefixes.join('|')})-\\d+)-[a-z0-9]+-v8\\.md$`, 'i');
  for (const f of ['PG-KOD-001-claude-v8.md', 'PG-SPD-001-claude-v8.md', 'PG-ILA-001-claude-v8.md']) {
    assert.match(f, re, `${f} must be recognized as a publishable gengrowth draft`);
  }
  // An astrology draft in the same shared _staging/ must still be rejected.
  assert.doesNotMatch('PG-HOUSE-001-claude-v8.md', re, 'astrology draft must not be publishable to gengrowth');
});

// ── invariant 5: gengrowth internal links must actually resolve ──────────────
//
// transformBody() is imported from the ORACLE bridge and its default TBD_LINK_RULES are
// all `/en/wiki/<astrology-slug>`. Before the gengrowth catalog existed, every
// [[<TBD-internal-link: …>]] in every gengrowth draft matched nothing and de-linked to
// italic text — measured on PG-KOD-001: 5 of 5 internal links dropped. The cluster link
// topology in 主题集群表 `internal_link_rule` had therefore never shipped.
test('invariant 5: gengrowth TBD internal links resolve to /blog/ hrefs, not italic', async () => {
  const { transformBody } = await import(
    pathToFileURL(resolve(REPO, 'tools', 'scripts', 'gg-md-to-oracle-ts.mjs')).href
  );
  const src = readFileSync(resolve(REPO, 'tools', 'scripts', 'gg-md-to-gengrowth-blog.mjs'), 'utf8');
  assert.match(src, /GENGROWTH_TBD_LINK_RULES/, 'gengrowth internal-link catalog missing');
  assert.match(
    src,
    /transformBody\(bodyNoH1,\s*slug,\s*GENGROWTH_LINK_OPTS\)/,
    'gengrowth bridge must pass its own link catalog (and selfSlug) to transformBody',
  );
  assert.match(src, /pathPrefix:\s*'\/blog\/'/, "gengrowth links must use /blog/ (the /en/ form 308-redirects)");

  // The oracle default must still behave exactly as before for an astrology description.
  const oracleOut = transformBody('see [[<TBD-internal-link: Rihanna birth chart>]] here');
  assert.match(oracleOut, /\]\(\/en\/wiki\/rihanna-birth-chart\)/, 'oracle default link resolution regressed');
});

// ── invariant 6: no fabricated external citation URLs ────────────────────────
//
// resolveExternalTbdLink must only ever emit a REAL href from a rule. The astrology path
// synthesizes a wikipedia.org URL from the topic; the gengrowth rules carry hard-coded
// official-documentation URLs. An unmatched service must de-link (italic), never guess.
test('invariant 6: an unknown external source de-links instead of inventing a URL', async () => {
  const { resolveExternalTbdLink } = await import(
    pathToFileURL(resolve(REPO, 'tools', 'scripts', 'gg-md-to-oracle-ts.mjs')).href
  );
  const out = resolveExternalTbdLink('Some Analytics Vendor', 'Quarterly Benchmark Report');
  assert.equal(out, '*Quarterly Benchmark Report*', 'unmatched external source must not become a link');
  assert.doesNotMatch(out, /https?:\/\//, 'no URL may be fabricated for an unmatched source');

  // A gengrowth rule must return its own hard-coded href, not one derived from the topic.
  const rules = [{ match: /search[\s-]*console/i, href: 'https://support.google.com/webmasters/answer/7042828', label: 'GSC docs' }];
  const hit = resolveExternalTbdLink('Google Search Central', 'Search Console overview', { externalRules: rules });
  assert.equal(hit, '[GSC docs](https://support.google.com/webmasters/answer/7042828)');
});

// ── invariant 7: a derived excerpt must never end mid-phrase ────────────────
//
// The excerpt becomes the page's meta description and the blog-card subtitle, so a
// truncation that stops on a dash, a comma, or a dangling function word is user-visible.
// Two real defects found on the 2026-08-07 batch: an em dash was not in the trailing-
// punctuation class ("…though published definitions vary —"), and stripping a dangling
// function word EXPOSED a comma that nothing stripped afterwards ("…in Ahrefs, or as"
// → "…in Ahrefs,"). Backticks also survived into the description as literal characters.
test('invariant 7: deriveDescription never ends on dangling punctuation or markup', async () => {
  const { deriveDescription } = await import(
    pathToFileURL(resolve(REPO, 'tools', 'scripts', 'gg-md-to-oracle-ts.mjs')).href
  );
  const bodies = [
    // em dash right at the truncation boundary
    '## H\n\nStriking distance keywords are **queries where your pages already rank close to the top — typically the 5–20 position range, though published definitions vary** — existing pages close enough to the top that targeted on-page changes tend to move them up, rather than requiring new content.',
    // inline code + a comma that only appears after a function word is stripped
    '## H\n\nZero search volume keywords are search queries that keyword tools report as having no measurable monthly searches — typically shown as `0` in Ahrefs, or as `n/a` in Semrush, which applies that label when a keyword falls under 10 average monthly searches.',
    // short body: must pass through untouched
    '## H\n\nA low-hanging fruit keyword is **a search term you can realistically rank for with the authority your site already has**.',
  ];
  for (const body of bodies) {
    const d = deriveDescription(body, 160);
    assert.ok(d.length > 0, 'excerpt must not be empty');
    assert.doesNotMatch(d, /[—–―,，;；:]$/u, `excerpt ends on dangling punctuation: "…${d.slice(-40)}"`);
    assert.doesNotMatch(d, /`/, `excerpt leaked a literal backtick: "…${d.slice(-40)}"`);
    assert.doesNotMatch(d, /\s(of|the|a|an|and|or|to|by|in|on|for|with|at|as)$/i, `excerpt ends on a dangling function word: "…${d.slice(-40)}"`);
  }
});

// ── invariant 8: a new cluster's prefix must be publishable AND unambiguous ──
//
// Same silent-failure class as invariant 4, plus the collision half. `ai_search_visibility`
// (calendar 8/21 `agentic seo` onward) can NOT reuse 'AIS' — that prefix already carries the
// ai_seo_automation cluster (PG-AIS-006/007 are live). Two clusters behind one prefix makes
// page_id → cluster ambiguous for anything mapping backwards from the id, and the breakage
// shows up as mis-clustered internal links, not as an error.
test('invariant 8: ASV is publishable and does not collide with the ai_seo_automation prefix', () => {
  const src = readFileSync(PUBLISH_SRC_PATH, 'utf8');
  const m = src.match(/const W25_PREFIXES = \[([\s\S]*?)\];/);
  assert.ok(m, 'W25_PREFIXES literal not found');
  // Strip // comments BEFORE extracting. A quoted prefix mentioned inside an explanatory
  // comment (e.g. "NOT 'AIS' — that one belongs to ai_seo_automation") is not an array
  // element, and counting it produced a phantom duplicate on the very commit that added it.
  const prefixes = [...m[1].replace(/\/\/[^\n]*/g, '').matchAll(/'([A-Z0-9]+)'/g)].map((x) => x[1]);
  assert.ok(prefixes.includes('ASV'), "prefix ASV missing — ai_search_visibility articles would never publish");
  assert.ok(prefixes.includes('AIS'), 'prefix AIS (ai_seo_automation) must remain');
  assert.equal(new Set(prefixes).size, prefixes.length, 'W25_PREFIXES contains a duplicate prefix');
  const re = new RegExp(`^(PG-(?:${prefixes.join('|')})-\\d+)-[a-z0-9]+-v8\\.md$`, 'i');
  assert.match('PG-ASV-001-claude-v8.md', re, 'ai_search_visibility draft must be publishable');
});

// ── invariant 9: "August 2026" must not be swallowed by the core-update rule ──
//
// GENGROWTH_TBD_LINK_RULES is FIRST-MATCH-WINS and order is load-bearing. The generic
// /traffic[\s-]*drop|core[\s-]*update/ rule points at the July 2026 page; a description like
// "our August 2026 core update check" hits `core update` and would land on July unless the
// August rule precedes it. Nothing errors — readers just get the wrong article. This test
// exists so that reordering the catalog fails loudly instead of silently.
test('invariant 9: August 2026 descriptions resolve to the August post, not July', async () => {
  const { resolveTbdLink } = await import(
    pathToFileURL(resolve(REPO, 'tools', 'scripts', 'gg-md-to-oracle-ts.mjs')).href
  );
  const src = readFileSync(resolve(REPO, 'tools', 'scripts', 'gg-md-to-gengrowth-blog.mjs'), 'utf8');
  const body = src.match(/const GENGROWTH_TBD_LINK_RULES = \[([\s\S]*?)\n\];/);
  assert.ok(body, 'GENGROWTH_TBD_LINK_RULES literal not found');
  const augIdx = body[1].indexOf('google-algorithm-update-august-2026');
  const julIdx = body[1].indexOf('google-july-2026-update');
  assert.ok(augIdx !== -1, 'August 2026 rule missing from the catalog');
  assert.ok(augIdx < julIdx, 'the August rule must precede the July/core-update rules (first match wins)');

  const opts = { rules: eval(`[${body[1]}]`), pathPrefix: '/blog/' };
  for (const [desc, want] of [
    ['our August 2026 core update check', '/blog/google-algorithm-update-august-2026'],
    ['the unconfirmed volatility we tracked', '/blog/google-algorithm-update-august-2026'],
    // A bare "core update" still means July — August 2026 had no confirmed core update.
    ['what to do about a sudden traffic drop', '/blog/google-july-2026-update'],
    // The four anchors the 8/17 brief (B8) specifies VERBATIM. Two of them de-linked when
    // first measured: the rules existed and the slugs were live, but the phrasing the brief
    // actually asks writers to use matched nothing. Asserting on slug presence alone hid it —
    // these assert on the sentence a writer will really type.
    ['the pillar on reading your own Search Console data', '/blog/striking-distance-keywords'],
    ['our earlier walkthrough of the July 2026 change', '/blog/google-july-2026-update'],
    ['how internal link structure moves authority', '/blog/pagerank-sculpting'],
    ['what a zero-volume reading actually means', '/blog/zero-search-volume-keywords'],
    // The seo_tools_comparison Pillar backlink. Every one of the twelve B-line
    // `{competitor} alternatives` articles (8/18–8/30) is a Series that must link back to it.
    // Measured de-linked on PG-CMP-007 before the rule existed — one missing rule would have
    // cost the whole B-line its Pillar<->Series topology, silently.
    ['our guide to cheap SEO tools', '/blog/best-cheap-seo-tools'],
    // `affordable` is a different live page and must not collapse onto the cheap-tools Pillar.
    ['a rundown of affordable SEO tools', '/blog/affordable-seo-tools'],
  ]) {
    const out = resolveTbdLink(desc, '', opts);
    assert.ok(out && out.includes(want), `"${desc}" resolved to ${out} — expected ${want}`);
  }
});

// ── invariant 10: comparison articles must carry the competitor-fact rules ───
//
// gengrowth has no comparison.prompt.md. The router in _render-aura-shared.mjs sends
// everything that is not `Pillar` to guide.prompt.md, so the entire B-line (12 `{competitor}
// alternatives` articles on the 8/18–8/30 calendar) is written by the Guide template. That
// routing is one inline ternary and nothing asserted on it. If someone adds a real
// comparison template or changes the ternary, these rules must move with it — otherwise the
// highest-error-density content type on the calendar silently loses its only guardrails.
test('invariant 10: the Comparison route reaches guide.prompt.md and it carries the competitor-fact rules', () => {
  const shared = readFileSync(resolve(REPO, 'tools', 'scripts', 'lib', '_render-aura-shared.mjs'), 'utf8');
  assert.match(
    shared,
    /_baseTemplate\s*=\s*\/\^pillar\$\/i\.test/,
    'template router changed shape — re-check where Comparison lands',
  );
  assert.match(
    shared,
    /GG_SITE === 'gengrowth' && _baseTemplate === 'definition' \? 'guide'/,
    "gengrowth non-Pillar templates (incl. Comparison) must route to guide.prompt.md",
  );

  const guide = readFileSync(
    resolve(REPO, 'tools', 'scripts', 'lib', 'content-draft-templates', 'guide.prompt.md'),
    'utf8',
  );
  // The directory-site ban is the load-bearing one: measured wrong twice on 2026-08-13
  // (G2 returned Canva/SOCi/Birdeye for `arvow alternatives`).
  for (const [needle, why] of [
    ['竞品事实硬要求', 'competitor-fact section missing'],
    ['Capterra', 'directory-site ban must name the sites — a generic warning does not stick'],
    ['核实日期', 'pricing claims must carry a verification date'],
    ['未列出', 'negative claims must be downgraded to "did not list"'],
  ]) {
    assert.ok(guide.includes(needle), `guide.prompt.md: ${why}`);
  }
});
