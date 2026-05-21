#!/usr/bin/env node
// Smoke test for gg-obsidian-rag.mjs
// Node built-in `assert` only — no vitest, no npm deps.
//
// Run:  node tools/scripts/__tests__/gg-obsidian-rag.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  PAGE_ID_REGEX,
  validatePageId,
  tokenize,
  parseFrontmatter,
  extractSections,
  extractWikilinks,
  scoreNote,
  countAdjacentHits,
  truncateAtSentence,
  jaccard,
  dedupSnippets,
  buildIndex,
  rankNotes,
  buildSnippets,
  buildOutput,
  walkMarkdown,
  pathPreferenceMultiplier,
} from '../gg-obsidian-rag.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCRIPT = join(__dirname, '..', 'gg-obsidian-rag.mjs');
const VAULT = join(REPO_ROOT, 'wzb-obsidian', 'LLM-Wiki');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  OK  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL ${name}\n     ${e.message}`);
    failed++;
  }
}

console.log('gg-obsidian-rag.mjs smoke tests');
console.log('--------------------------------');

// =====================================================================
// page_id validation (same regex as sibling tools)
// =====================================================================
console.log('\npage_id validation:');

test('validatePageId accepts good slug', () => {
  assert.equal(validatePageId('page_saturn_return'), 'page_saturn_return');
  assert.equal(validatePageId('p1'), 'p1');
});

test('validatePageId rejects path traversal', () => {
  assert.throws(() => validatePageId('../../etc/passwd'));
});

test('validatePageId rejects empty', () => {
  assert.throws(() => validatePageId(''));
  assert.throws(() => validatePageId(null));
});

test('validatePageId rejects path separator', () => {
  assert.throws(() => validatePageId('foo/bar'));
  assert.throws(() => validatePageId('foo\\bar'));
});

test('PAGE_ID_REGEX caps length at 64', () => {
  const tooLong = 'a'.repeat(65);
  assert.throws(() => validatePageId(tooLong));
  const ok = 'a'.repeat(64);
  assert.equal(validatePageId(ok), ok);
});

// =====================================================================
// tokenizer
// =====================================================================
console.log('\ntokenizer:');

test('tokenize lowercases + strips stopwords', () => {
  const toks = tokenize('The Saturn Return is a Big Deal');
  // 'a' and 'is' are stopwords, 'the' is stopword
  assert.deepEqual(toks.sort(), ['big', 'deal', 'return', 'saturn'].sort());
});

test('tokenize handles empty / null', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
});

test('tokenize strips short tokens', () => {
  const toks = tokenize('a b c d e');
  // single-char dropped
  assert.deepEqual(toks, []);
});

// =====================================================================
// frontmatter parser
// =====================================================================
console.log('\nfrontmatter parser:');

test('parseFrontmatter handles missing fm', () => {
  const out = parseFrontmatter('# Just a heading\n\nBody');
  assert.equal(out._present, false);
});

test('parseFrontmatter handles inline kv', () => {
  const text = '---\ntitle: Hello World\ntype: note\n---\nbody';
  const out = parseFrontmatter(text);
  assert.equal(out._present, true);
  assert.equal(out.title, 'Hello World');
  assert.equal(out.type, 'note');
});

test('parseFrontmatter handles list aliases + tags', () => {
  const text = '---\ntitle: Saturn\naliases:\n  - cronus\n  - kronos\ntags:\n  - astrology\n  - planet\n---\nbody';
  const out = parseFrontmatter(text);
  assert.deepEqual(out.aliases, ['cronus', 'kronos']);
  assert.deepEqual(out.tags, ['astrology', 'planet']);
});

test('parseFrontmatter handles inline array', () => {
  const text = '---\ntags: [astro, planet]\n---\nbody';
  const out = parseFrontmatter(text);
  assert.deepEqual(out.tags, ['astro', 'planet']);
});

test('parseFrontmatter strips quotes', () => {
  const text = '---\ntitle: "Quoted Title"\n---\nbody';
  const out = parseFrontmatter(text);
  assert.equal(out.title, 'Quoted Title');
});

// =====================================================================
// sections + wikilinks
// =====================================================================
console.log('\nsections + wikilinks:');

test('extractSections splits by H1/H2/H3', () => {
  const body = '# H1 Title\nbody1\n## H2 Section\nbody2 line\nbody2 more\n### H3 Sub\nbody3';
  const secs = extractSections(body);
  assert.equal(secs.length, 3);
  assert.equal(secs[0].heading, 'H1 Title');
  assert.equal(secs[1].heading, 'H2 Section');
  assert.equal(secs[2].heading, 'H3 Sub');
  assert.ok(secs[1].body.includes('body2'));
});

test('extractWikilinks finds [[targets]]', () => {
  const text = 'see [[Note A]] and [[Note B|display]] for more, also [[Note A]] again';
  const links = extractWikilinks(text);
  assert.deepEqual(links.sort(), ['Note A', 'Note B']);
});

test('extractWikilinks handles section-anchored links [[Note#Section]]', () => {
  const links = extractWikilinks('see [[My Note#Some Heading]]');
  assert.deepEqual(links, ['My Note']);
});

// =====================================================================
// score / matcher
// =====================================================================
console.log('\nscore / matcher:');

test('scoreNote T1 — title contains all entity tokens', () => {
  const note = {
    titleTokens: ['saturn', 'return'],
    headingTokens: [],
    aliasTexts: [],
  };
  const res = scoreNote(note, ['saturn', 'return'], '');
  assert.equal(res.tier, 'T1');
  assert.equal(res.score, 1.0);
});

test('scoreNote T2 — frontmatter aliases', () => {
  const note = {
    titleTokens: ['foo'],
    headingTokens: [],
    aliasTexts: ['saturn return aliased name'],
  };
  const res = scoreNote(note, ['saturn', 'return'], '');
  assert.equal(res.tier, 'T2');
});

test('scoreNote T3 — heading contains entity', () => {
  const note = {
    titleTokens: ['saturn'],
    headingTokens: ['saturn', 'return'],
    aliasTexts: [],
  };
  const res = scoreNote(note, ['saturn', 'return'], '');
  assert.equal(res.tier, 'T3');
  assert.equal(res.score, 0.7);
});

test('scoreNote T5 — body adjacency triggers fallback', () => {
  const note = {
    titleTokens: ['nope'],
    headingTokens: ['nope'],
    aliasTexts: [],
  };
  const body = 'the saturn return is a big psychological threshold around age 29';
  const res = scoreNote(note, ['saturn', 'return'], body);
  assert.equal(res.tier, 'T5');
  assert.ok(res.score > 0.3);
});

test('scoreNote returns 0 when no match', () => {
  const note = {
    titleTokens: ['venus'],
    headingTokens: ['mars'],
    aliasTexts: [],
  };
  const res = scoreNote(note, ['saturn', 'return'], 'no relevant content here');
  assert.equal(res.score, 0);
});

// =====================================================================
// adjacency hit counter
// =====================================================================
console.log('\nadjacency:');

test('countAdjacentHits — single-token entity counts substring', () => {
  const n = countAdjacentHits('saturn saturn saturn', ['saturn']);
  assert.equal(n, 3);
});

test('countAdjacentHits — multi-token requires adjacency', () => {
  // 'blue' and 'aura' >100 chars apart → 0 hits
  const text = 'blue is one color and many other words go here ' +
    'and then much later in a different paragraph the word aura appears'.repeat(2);
  const n = countAdjacentHits(text, ['blue', 'aura'], 30);
  assert.equal(n, 0);
});

test('countAdjacentHits — adjacent tokens within window count', () => {
  const text = 'the saturn return is approaching, and the saturn return brings change';
  const n = countAdjacentHits(text, ['saturn', 'return'], 60);
  assert.equal(n, 2);
});

// =====================================================================
// truncate / dedup
// =====================================================================
console.log('\ntruncate + dedup:');

test('truncateAtSentence honors sentence boundary', () => {
  const text = 'First sentence here. Second sentence here. Third one continues for a while.';
  const out = truncateAtSentence(text, 50);
  assert.ok(out.length <= 50);
  assert.ok(out.endsWith('.'), `should end with .  but got: ${out}`);
});

test('truncateAtSentence does not cut mid-word', () => {
  const text = 'word1 word2 word3 averyLongCompoundWordThatExceedsTheLimit and more';
  const out = truncateAtSentence(text, 20);
  // must not end mid-word
  assert.ok(!out.match(/[a-z]$/) || out.endsWith('...'));
});

test('jaccard identical strings = 1', () => {
  assert.equal(jaccard('saturn return is big', 'saturn return is big'), 1);
});

test('jaccard disjoint strings = 0', () => {
  assert.equal(jaccard('venus mars mercury', 'saturn jupiter pluto'), 0);
});

test('dedupSnippets removes high-similarity duplicates', () => {
  const snips = [
    { text: 'the saturn return brings change around age twenty-nine.' },
    { text: 'the saturn return brings change around age twenty-nine.' }, // exact dup
    { text: 'venus in scorpio is intense and probing.' },
  ];
  const out = dedupSnippets(snips);
  assert.equal(out.length, 2);
});

// =====================================================================
// path preference multiplier
// =====================================================================
console.log('\npath preference:');

test('pathPreferenceMultiplier — Notes/Books gets 1.4', () => {
  // Note: the function uses sep (platform-specific) so we test on POSIX.
  const p = '/repo/wzb-obsidian/LLM-Wiki/Notes/Books/foo.md';
  assert.equal(pathPreferenceMultiplier(p), 1.4);
});

test('pathPreferenceMultiplier — Tech/ gets 0.6 (demoted)', () => {
  const p = '/repo/wzb-obsidian/LLM-Wiki/Tech/spec.md';
  assert.equal(pathPreferenceMultiplier(p), 0.6);
});

test('pathPreferenceMultiplier — Knowledge/ gets 1.1 (boosted)', () => {
  const p = '/repo/wzb-obsidian/LLM-Wiki/Knowledge/foo.md';
  assert.equal(pathPreferenceMultiplier(p), 1.1);
});

test('pathPreferenceMultiplier — neutral default = 1.0', () => {
  const p = '/repo/random/path.md';
  assert.equal(pathPreferenceMultiplier(p), 1.0);
});

// =====================================================================
// end-to-end on tiny fixture vault
// =====================================================================
console.log('\nfixture vault e2e:');

function makeFixtureVault() {
  const root = join(tmpdir(), `gg-obs-fix-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, 'Notes', 'Books'), { recursive: true });
  mkdirSync(join(root, 'Tech'), { recursive: true });

  writeFileSync(
    join(root, 'Notes', 'Books', 'Saturn-Notes.md'),
    `---
title: Saturn Return Deep Notes
aliases:
  - second saturn
tags:
  - astrology
---

# Saturn Return Deep Notes

## The Saturn Return

The saturn return is the period when transiting Saturn returns to natal position. It is a thirty year threshold that asks whether the life you built is your own. Around age twenty-nine, Saturn returns and the compensatory structures of one's twenties are tested. The book describes this as a developmental crisis that, when navigated, produces real maturity. The saturn return is not punishment — it is a chance to consolidate authentic structure.

## Other Topics

Some other stuff that should not match. This section is about Venus and Mars and does not mention the search term.
`,
  );

  writeFileSync(
    join(root, 'Notes', 'Books', 'Cycles-Book.md'),
    `---
title: Cycles of Becoming
tags:
  - astrology
---

# Cycles of Becoming

## Life Phases

The saturn return at twenty-nine is one of three major life thresholds. The saturn return follows the Uranus opposition. The saturn return is the demarcation between youth and adulthood according to the framework. The saturn return forces consolidation of the work done in the twenties.
`,
  );

  writeFileSync(
    join(root, 'Tech', 'spec.md'),
    `---
title: Project Spec
---

# Project Spec

## Example

For an example entity like "saturn return", we use it as test data. This is not actually content about saturn return.
`,
  );

  return root;
}

test('(a) indexer parses frontmatter + headings + wikilinks', () => {
  const root = makeFixtureVault();
  try {
    const idx = buildIndex(root);
    const paths = Object.keys(idx.noteByPath);
    assert.equal(paths.length, 3);
    const saturnNote = idx.noteByPath[join(root, 'Notes', 'Books', 'Saturn-Notes.md')];
    assert.equal(saturnNote.title, 'Saturn Return Deep Notes');
    assert.ok(saturnNote.aliasTexts.includes('second saturn'));
    assert.ok(saturnNote.sections.some((s) => s.heading === 'The Saturn Return'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(b) matcher: "saturn return" finds the saturn book notes', () => {
  const root = makeFixtureVault();
  try {
    const out = buildOutput({
      pageId: 'page_saturn_return',
      entity: 'saturn return',
      targetKeyword: 'saturn return',
      vaultRoot: root,
    });
    assert.ok(out.snippets.length >= 2, `expected ≥ 2 snippets, got ${out.snippets.length}`);
    const titles = new Set(out.snippets.map((s) => s.note_title));
    // Should find both Saturn book notes (Saturn-Notes + Cycles-Book) and NOT the spec.
    assert.ok(titles.has('Saturn Return Deep Notes'),
      `expected Saturn book in titles; got: ${[...titles].join('|')}`);
    // Spec doc should be filtered out due to low score × 0.6 Tech penalty < MIN_FINAL_SCORE.
    for (const s of out.snippets) {
      assert.notEqual(s.note_title, 'Project Spec',
        'project spec should be filtered by min-score floor');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(c) matcher: gap entity returns snippets:[] + gap_note', () => {
  const root = makeFixtureVault();
  try {
    const out = buildOutput({
      pageId: 'page_blue_aura_meaning',
      entity: 'blue aura',
      targetKeyword: 'blue aura',
      vaultRoot: root,
    });
    assert.equal(out.snippets.length, 0);
    assert.ok(out.gap_note, 'gap_note should be set when 0 matches');
    assert.ok(out.gap_note.includes('blue'), `gap_note mentions tokens: ${out.gap_note}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(d) section extractor truncates at sentence boundary', () => {
  const root = makeFixtureVault();
  try {
    const out = buildOutput({
      pageId: 'p1',
      entity: 'saturn return',
      targetKeyword: 'saturn return',
      vaultRoot: root,
    });
    for (const s of out.snippets) {
      assert.ok(s.text.length <= 600,
        `snippet text > 600 chars: ${s.text.length}`);
      // Last char should be . ! ? or … or end-of-section (not mid-word).
      // Allow trailing ellipsis (...) too.
      const last = s.text.slice(-3);
      const looksTerminated = /[.!?。…]$/.test(s.text) || last === '...';
      assert.ok(looksTerminated, `snippet should end at sentence: ${s.text.slice(-50)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// =====================================================================
// CLI: page_id validation + cache mismatch
// =====================================================================
console.log('\nCLI integration:');

test('(e) CLI rejects path traversal in --page-id', () => {
  const res = spawnSync('node', [SCRIPT, '--page-id', '../../etc/passwd',
    '--entity', 'saturn return', '--vault-dir', VAULT], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}`);
  assert.ok(/page-id|PAGE_ID/i.test(res.stderr + res.stdout));
});

test('(e) CLI rejects empty entity', () => {
  const res = spawnSync('node', [SCRIPT, '--page-id', 'page_x',
    '--entity', '', '--vault-dir', VAULT], { encoding: 'utf8' });
  assert.equal(res.status, 2);
});

test('CLI real-data: saturn return finds ≥ 3 book notes', function () {
  // Slowest test (~500ms) — skip if env says so.
  if (process.env.SKIP_SLOW === '1') return;
  if (!existsSync(VAULT)) return; // skip if no vault (CI without submodule)
  const tmpCache = join(tmpdir(), `gg-obs-cli-${Date.now()}`);
  mkdirSync(tmpCache, { recursive: true });
  try {
    const res = spawnSync('node', [SCRIPT,
      '--page-id', 'page_saturn_return',
      '--entity', 'saturn return',
      '--target-keyword', 'saturn return meaning',
      '--vault-dir', VAULT,
      '--cache-dir', tmpCache,
    ], { encoding: 'utf8' });
    assert.equal(res.status, 0, `exit non-zero: ${res.status}\n${res.stdout}\n${res.stderr}`);
    const outPath = join(tmpCache, 'page_saturn_return', 'obsidian-rag.json');
    assert.ok(existsSync(outPath));
    const out = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.ok(out.snippets.length >= 5,
      `expected ≥5 snippets for saturn return, got ${out.snippets.length}`);
    const uniqueNotes = new Set(out.snippets.map((s) => s.note_title));
    assert.ok(uniqueNotes.size >= 3,
      `expected ≥3 unique book notes, got ${uniqueNotes.size}: ${[...uniqueNotes].join('|')}`);
  } finally {
    rmSync(tmpCache, { recursive: true, force: true });
  }
});

console.log('\n--------------------------------');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
