#!/usr/bin/env node
// Run: node --test tools/scripts/__tests__/gg-topic-register.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  associatedKeywordsForPage,
  buildSemanticRepairProof,
  buildTrendEvidenceCache,
  CLUSTER_FIELDS,
  chooseClusterForKeyword,
  createRunBudget,
  deterministicFrictionForPage,
  inferNextPageId,
  notifyTopicRegistered,
  PAGE_REQUIRED_FIELDS,
  planRows,
  PRODUCT_PROFILES,
  runPreprocessorForPlan,
  scoreClusterKeyword,
  selectCandidateRowsForPlan,
  semanticRepairRequestFromArgs,
  titleCase,
  valuesBatchForPageRow,
} from '../gg-topic-register.mjs';
import { renderPreprocessorPrompt } from '../lib/preprocessor-prompt.mjs';
import * as topicRegister from '../gg-topic-register.mjs';

const topicRegisterCli = new URL('../gg-topic-register.mjs', import.meta.url).pathname;

const clusters = [
  {
    cluster_id: 'vedic_astrology_basics',
    cluster_name: 'Vedic Astrology Basics',
    primary_entity: 'Vedic Astrology',
    jtbd: 'Understand Indian astrology basics',
    content_angle: 'Introduction to Jyotish and Vedic birth chart basics',
    keywords_included: 'vedic astrology, vedic birth chart, jyotish birth chart',
  },
  {
    cluster_id: 'worldcup2026_astro',
    cluster_name: 'World Cup 2026 Astrology Trends',
    primary_entity: 'World Cup 2026',
    jtbd: 'Discover astrological insights about World Cup 2026 players and teams via birth charts and national chart analysis',
    content_angle: 'Player birth charts + team national charts + zodiac-based team picks + Jupiter in Gemini 2026 transit',
    keywords_included: 'world cup 2026 astrology, football astrology, country vs country astrology, player birth charts',
  },
  {
    cluster_id: 'celebrity_zodiac_trending',
    cluster_name: 'Celebrity Zodiac Trending',
    primary_entity: 'Celebrity Zodiac Profiles',
    jtbd: 'Explain trending celebrity zodiac signs, celebrity birth charts, compatibility, and pop-culture astrology',
    content_angle: 'Celebrity zodiac profiles and birth chart breakdowns with symbolic entertainment framing',
    keywords_included: 'celebrity zodiac sign, celebrity birth chart, pop culture astrology, athlete zodiac sign, athlete birth chart',
  },
];

const SEMANTIC_REPAIR_PROOF_KEYS = [
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
].sort();

test('celebrity and non-football athlete birth-chart topics route to celebrity_zodiac_trending', () => {
  for (const keyword of [
    'serena williams birth chart',
    'teyana taylor birth chart',
    'jannik sinner zodiac sign',
    'ben shelton zodiac sign',
  ]) {
    const decision = chooseClusterForKeyword(keyword, clusters);
    assert.equal(decision.kind, 'existing', keyword);
    assert.equal(decision.cluster_id, 'celebrity_zodiac_trending', keyword);
    assert.ok(
      scoreClusterKeyword(keyword, clusters[2]) > scoreClusterKeyword(keyword, clusters[0]),
      `${keyword} should outrank Vedic basics`,
    );
  }
});

test('explicit World Cup country/team topics still route to worldcup2026_astro', () => {
  const decision = chooseClusterForKeyword('morocco world cup 2026 astrology', clusters);
  assert.equal(decision.kind, 'existing');
  assert.equal(decision.cluster_id, 'worldcup2026_astro');
});

test('celebrity-routed pages reuse the CELEB page_id prefix when existing pages use it', () => {
  const pageId = inferNextPageId({
    clusterId: 'celebrity_zodiac_trending',
    pages: [
      { page_id: 'PG-CELEB-001', cluster_id: 'celebrity_zodiac_trending' },
      { page_id: 'PG-CELEB-008', cluster_id: 'celebrity_zodiac_trending' },
      { page_id: 'PG-WC-041', cluster_id: 'worldcup2026_astro' },
    ],
  });
  assert.equal(pageId, 'PG-CELEB-009');
});

test('titleCase preserves names and only uppercases real acronyms', () => {
  assert.equal(titleCase('ben shelton zodiac sign'), 'Ben Shelton Zodiac Sign');
  assert.equal(titleCase('morocco world cup 2026 astrology'), 'Morocco World Cup 2026 Astrology');
  assert.equal(titleCase('seo ai gsc keyword'), 'SEO AI GSC Keyword');
});

test('deterministic fallback friction does not invent SERP evidence', () => {
  const friction = deterministicFrictionForPage({
    targetKeyword: 'jannik sinner zodiac sign',
    entity: 'Jannik Sinner Zodiac Sign',
  });

  assert.match(friction, /zodiac sign/i);
  assert.doesNotMatch(friction, /SERP titles mix/i);
  assert.doesNotMatch(friction, /definitions, tools, and broad advice/i);
});

test('evidence cache accepts three relevant distinct SERP titles', () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'gg-topic-register-evidence-'));
  try {
    const built = buildTrendEvidenceCache({
      cacheRoot,
      pageId: 'PG-TEST-003',
      targetKeyword: 'jannik sinner zodiac sign',
      query: 'jannik sinner zodiac sign astrology',
      source: 'test',
      organic: [
        {
          title: 'Jannik Sinner Zodiac Sign and Birth Chart',
          url: 'https://example.com/one',
          domain: 'example.com',
          snippet: 'Jannik Sinner zodiac sign details for astrology readers.',
        },
        {
          title: 'What Is Jannik Sinner Zodiac Sign?',
          url: 'https://example.net/two',
          domain: 'example.net',
          snippet: 'Jannik Sinner zodiac sign context and public persona.',
        },
        {
          title: 'Jannik Sinner Zodiac Sign Astrology Profile',
          url: 'https://example.org/three',
          domain: 'example.org',
          snippet: 'Jannik Sinner zodiac sign profile with astrology framing.',
        },
      ],
    });

    assert.equal(built.ok, true);
    assert.equal(built.distinctTitles, 3);
    assert.equal(existsSync(join(cacheRoot, 'serp', 'PG-TEST-003.json')), true);
    assert.equal(existsSync(join(cacheRoot, 'PG-TEST-003', 'friction-mine.rag.json')), true);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('preprocessor prompt uses the relaxed three-title evidence floor', () => {
  const prompt = renderPreprocessorPrompt({ targetKeyword: 'jannik sinner zodiac sign' });

  assert.match(prompt, /fewer than 3 distinct titles/i);
  assert.doesNotMatch(prompt, /fewer than 5 distinct titles/i);
  assert.doesNotMatch(prompt, /SERP < 5/i);
});

test('default candidate selection audits incomplete existing rows before generating new rows', () => {
  const header = [
    'Target Keyword',
    'Associated Keywords',
    'Intent',
    'Tier',
    'Template',
    'Entity',
    'Friction',
    'Logic',
    'page_id',
    'cluster_id',
    'page_role',
    'content_angle',
    'psych_safety_flag',
  ];
  const existingIncomplete = [
    'jannik sinner zodiac sign',
    'jannik sinner zodiac sign meaning',
    'Info',
    'T2',
    'Case Study',
    '',
    '',
    '',
    'PG-CELEB-010',
    'celebrity_zodiac_trending',
    'Series',
    '',
    'N',
  ];
  const newBlank = ['new celebrity astrology topic'];
  const selected = selectCandidateRowsForPlan([
    header,
    existingIncomplete,
    newBlank,
  ]);

  assert.equal(selected.mode, 'audit_repair');
  assert.deepEqual(selected.candidates.map((row) => row.target_keyword), ['jannik sinner zodiac sign']);
  assert.ok(selected.candidates[0].missing.includes('Entity'));
  assert.equal(selected.audit_incomplete, 1);

  const completedExisting = [
    'jannik sinner zodiac sign',
    'jannik sinner zodiac sign meaning',
    'Info',
    'T2',
    'Case Study',
    'Jannik Sinner Zodiac Sign',
    'Readers need a direct sign answer.',
    'Logic paragraph.',
    'PG-CELEB-010',
    'celebrity_zodiac_trending',
    'Series',
    'Angle.',
    'N',
  ];
  const generated = selectCandidateRowsForPlan([
    header,
    completedExisting,
    newBlank,
  ]);

  assert.equal(generated.mode, 'generate');
  assert.deepEqual(generated.candidates.map((row) => row.target_keyword), ['new celebrity astrology topic']);
  assert.equal(generated.audit_incomplete, 0);
});

test('planRows preserves an OPS-assigned Cluster ID even when a semantic matcher prefers another Cluster', () => {
  const pageHeader = ['Target Keyword', ...PAGE_REQUIRED_FIELDS, 'CTA', 'Status'];
  const completeWrongRow = [
    'what is my love language',
    'what is my love language meaning',
    'Info',
    'T2',
    'Definition',
    'What Is My Love Language',
    'Readers need a direct explanation.',
    'What Is My Love Language ↔ Why Do I Feel Stuck in My Career ↔ practical interpretation.',
    'PG-WDIF-002',
    'why_do_i_feel_stuck_in_my_career',
    'Wiki',
    'Frame career stagnation as a symbolic guide.',
    'N',
    '星盘页',
    '待写',
  ];
  const blankNewRow = ['new blank topic', ...Array(PAGE_REQUIRED_FIELDS.length + 2).fill('')];
  const cluster = (overrides) => CLUSTER_FIELDS.map((field) => overrides[field] || '');
  const clustersRaw = [
    CLUSTER_FIELDS,
    cluster({
      cluster_id: 'why_do_i_feel_stuck_in_my_career',
      cluster_name: 'Why Do I Feel Stuck in My Career',
      primary_entity: 'Career Stagnation',
      jtbd: 'Understand career stagnation',
      content_angle: 'Career reflection',
      keywords_included: 'career stagnation, feeling stuck at work',
    }),
    cluster({
      cluster_id: 'love_relationships',
      cluster_name: 'Love and Relationships',
      primary_entity: 'Relationship Patterns',
      jtbd: 'Understand love languages and relationship patterns',
      content_angle: 'Explain love language patterns with clear boundaries',
      keywords_included: 'love language, relationship compatibility, attachment patterns',
      cta_primary: '星盘页',
    }),
  ];

  const plan = planRows({
    profile: PRODUCT_PROFILES.astrologywiki,
    pagesRaw: [pageHeader, completeWrongRow, blankNewRow],
    clustersRaw,
    limit: 10,
    repairPageIds: new Set(['PG-WDIF-002']),
    activePageIds: new Set(['PG-WDIF-002']),
  });

  assert.equal(plan.selectionMode, 'explicit_repair');
  assert.deepEqual(plan.updates.map((item) => item.pageId), ['PG-WDIF-002']);
  assert.equal(plan.updates[0].cluster.cluster_id, 'why_do_i_feel_stuck_in_my_career');
  assert.equal(plan.updates[0].fields.cluster_id, 'why_do_i_feel_stuck_in_my_career');
  assert.equal(plan.updates[0].fields.Entity, 'My Love Language');
  assert.match(plan.updates[0].fields.Logic, /Career Stagnation/);

  const writes = valuesBatchForPageRow({
    tab: '选题登记表',
    rowNumber: plan.updates[0].row,
    header: pageHeader,
    fields: plan.updates[0].fields,
    existingValues: plan.updates[0].existingValues,
    forceOverwriteFields: plan.updates[0].forceOverwriteFields,
  });
  const writtenColumns = new Set(writes.map((item) => item.range.match(/!([A-Z]+)/)?.[1]));
  const clusterColumn = pageHeader.indexOf('cluster_id');
  const logicColumn = pageHeader.indexOf('Logic');
  const entityColumn = pageHeader.indexOf('Entity');
  assert.equal(writtenColumns.has(String.fromCharCode(65 + clusterColumn)), false, 'cluster_id must never be overwritten');
  assert.equal(writtenColumns.has(String.fromCharCode(65 + logicColumn)), false, 'manual Logic must not be overwritten');
  assert.equal(writtenColumns.has(String.fromCharCode(65 + entityColumn)), false, 'manual Entity must not be overwritten');
  assert.equal(plan.taskLines.length, 0, 'existing page id must preserve the task line');
});

test('planRows blocks an unregistered Cluster ID instead of creating a singleton cluster', () => {
  const pageHeader = ['Target Keyword', ...PAGE_REQUIRED_FIELDS, 'CTA', 'Status'];
  const row = [
    'what is my love language',
    'what is my love language meaning',
    'Info',
    'T2',
    'Definition',
    'What Is My Love Language',
    'Readers need What Is My Love Language explained with clear interpretive boundaries instead of broad claims.',
    'What Is My Love Language ↔ Why Do I Feel Stuck in My Career ↔ practical interpretation. Treat What Is My Love Language as an interpretive framework rather than a deterministic claim.',
    'PG-WDIF-002',
    'why_do_i_feel_stuck_in_my_career',
    'Wiki',
    'Frame Why Do I Feel Stuck in My Career as a symbolic, interpretive guide.',
    'N',
    '星盘页',
    '待写',
  ];
  const cluster = (overrides) => CLUSTER_FIELDS.map((field) => overrides[field] || '');
  const plan = planRows({
    profile: PRODUCT_PROFILES.astrologywiki,
    pagesRaw: [pageHeader, row],
    clustersRaw: [
      CLUSTER_FIELDS,
      cluster({
        cluster_id: 'some_other_registered_cluster',
        cluster_name: 'Why Do I Feel Stuck in My Career',
        primary_entity: 'Career Stagnation',
        jtbd: 'Understand career stagnation',
        content_angle: 'Career reflection',
        keywords_included: 'career stagnation, feeling stuck at work',
      }),
    ],
    limit: 10,
    repairPageIds: new Set(['PG-WDIF-002']),
    activePageIds: new Set(['PG-WDIF-002']),
  });

  assert.equal(plan.selectionMode, 'explicit_repair');
  assert.deepEqual(plan.newClusters, []);
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.opsBlocked, [{
    page_id: 'PG-WDIF-002',
    target_keyword: 'what is my love language',
    reason: 'unknown_cluster_id',
    cluster_id: 'why_do_i_feel_stuck_in_my_career',
  }]);
});

function semanticRepairApplyFixture({ correct = false, newCluster = false } = {}) {
  const pageHeader = [
    'Target Keyword',
    ...PAGE_REQUIRED_FIELDS,
    'CTA',
    'Status',
    'journal_prompts',
    'target_keyword_zh',
  ];
  const keyword = 'what is my love language';
  const oldClusterId = 'why_do_i_feel_stuck_in_my_career';
  const targetClusterId = 'love_relationships';
  const page = {
    'Target Keyword': keyword,
    'Associated Keywords': 'what is my love language meaning',
    Intent: 'Info',
    Tier: 'T2',
    Template: 'Definition',
    Entity: 'What Is My Love Language',
    Friction: newCluster
      ? 'Readers need What Is My Love Language explained with clear interpretive boundaries instead of broad claims.'
      : 'This manually reviewed brief explains the relationship query.',
    Logic: newCluster
      ? 'What Is My Love Language ↔ Why Do I Feel Stuck in My Career ↔ practical interpretation. Treat What Is My Love Language as an interpretive framework rather than a deterministic claim.'
      : 'This manually reviewed relationship logic must replace unrelated career taxonomy.',
    page_id: 'PG-WDIF-002',
    cluster_id: correct ? targetClusterId : oldClusterId,
    page_role: 'Wiki',
    content_angle: 'Explain love language patterns with clear boundaries.',
    psych_safety_flag: 'N',
    CTA: '星盘页',
    Status: '',
    journal_prompts: '',
    target_keyword_zh: '',
  };
  const cluster = (overrides) => CLUSTER_FIELDS.map((field) => overrides[field] || '');
  const careerCluster = cluster({
    cluster_id: oldClusterId,
    cluster_name: 'Why Do I Feel Stuck in My Career',
    primary_entity: 'Career Stagnation',
    jtbd: 'Understand career stagnation',
    content_angle: 'Career reflection',
    keywords_included: 'career stagnation, feeling stuck at work',
  });
  const clusterRows = [CLUSTER_FIELDS, careerCluster];
  if (!newCluster) {
    clusterRows.push(cluster({
      cluster_id: targetClusterId,
      cluster_name: 'Love and Relationships',
      primary_entity: 'Relationship Patterns',
      jtbd: 'Understand love languages and relationship patterns',
      content_angle: 'Explain love language patterns with clear boundaries',
      keywords_included: 'love language, relationship compatibility, attachment patterns',
      cta_primary: '星盘页',
    }));
  }
  const plan = planRows({
    profile: PRODUCT_PROFILES.astrologywiki,
    pagesRaw: [pageHeader, pageHeader.map((field) => page[field] || '')],
    clustersRaw: clusterRows,
    limit: 1,
    repairPageIds: new Set(['PG-WDIF-002']),
    activePageIds: new Set(['PG-WDIF-002']),
    semanticRepairOnly: true,
  });
  return { plan, pageHeader, page };
}

function completeSemanticBatchResponse(data) {
  return {
    totalUpdatedCells: data.length,
    responses: data.map(({ range }) => ({
      updatedRange: range,
      updatedRows: 1,
      updatedColumns: 1,
      updatedCells: 1,
    })),
  };
}

function completeSemanticAppendResponse(rows, { range = null } = {}) {
  const endRow = rows.length + 1;
  return {
    updates: {
      updatedRange: range || `主题集群表!A2:S${endRow}`,
      updatedRows: rows.length,
      updatedColumns: CLUSTER_FIELDS.length,
      updatedCells: rows.length * CLUSTER_FIELDS.length,
    },
  };
}

function verifiedSemanticEvidence({ changedPageIds = [], newClusterIds = [] } = {}) {
  return {
    verified: true,
    changed_page_ids: [...changedPageIds],
    page_write_counts: changedPageIds.map((page_id) => ({ page_id, count: 1 })),
    page_write_count: changedPageIds.length,
    new_cluster_ids: [...newClusterIds],
    new_cluster_count: newClusterIds.length,
    cluster_cell_write_count: newClusterIds.length * CLUSTER_FIELDS.length,
  };
}

test.skip('obsolete semantic apply writes are disabled because OPS owns Cluster IDs', async () => {
  assert.equal(typeof topicRegister.applySemanticRepairWrites, 'function');
  const { plan, pageHeader } = semanticRepairApplyFixture();
  const calls = [];
  const evidence = await topicRegister.applySemanticRepairWrites({
    workbookId: 'fake-workbook',
    token: 'fake-token',
    plan,
    deps: {
      appendRows: async (...args) => {
        calls.push({ kind: 'append', args });
        return completeSemanticAppendResponse(args[2]);
      },
      batchUpdateValues: async (...args) => {
        calls.push({ kind: 'batch', args });
        return completeSemanticBatchResponse(args[1]);
      },
    },
  });

  assert.deepEqual(calls.map((call) => call.kind), ['batch']);
  const requested = calls[0].args[1];
  const fieldByColumn = new Map(pageHeader.map((field, index) => [topicRegister.colLetter(index), field]));
  const requestedFields = requested.map(({ range }) => fieldByColumn.get(range.match(/!([A-Z]+)\d+$/)?.[1]));
  const expectedFields = [...plan.updates[0].forceOverwriteFields]
    .filter((field) => String(plan.updates[0].fields[field] ?? '') !== String(plan.updates[0].existingValues[field] ?? ''));
  assert.deepEqual(requestedFields.sort(), expectedFields.sort());
  assert.equal(requestedFields.includes('Status'), false);
  assert.equal(requestedFields.includes('journal_prompts'), false);
  assert.equal(requestedFields.includes('target_keyword_zh'), false);
  assert.equal(requested.every(({ values }) => String(values[0][0]).trim().length > 0), true);
  assert.deepEqual(evidence.changed_page_ids, ['PG-WDIF-002']);
  assert.equal(evidence.page_write_count, requested.length);
  assert.equal(evidence.new_cluster_count, 0);
});

test.skip('obsolete semantic apply no-op is disabled because OPS owns Cluster IDs', async () => {
  assert.equal(typeof topicRegister.applySemanticRepairWrites, 'function');
  const { plan } = semanticRepairApplyFixture({ correct: true });
  const evidence = await topicRegister.applySemanticRepairWrites({
    workbookId: 'fake-workbook',
    token: 'fake-token',
    plan,
    deps: {
      appendRows: async () => assert.fail('no-op must not append'),
      batchUpdateValues: async () => assert.fail('no-op must not batch update'),
    },
  });
  assert.deepEqual(evidence.changed_page_ids, []);
  assert.equal(evidence.page_write_count, 0);
  assert.equal(evidence.new_cluster_count, 0);
});

test.skip('obsolete semantic Cluster creation is disabled because OPS owns Cluster IDs', async () => {
  assert.equal(typeof topicRegister.applySemanticRepairWrites, 'function');
  const { plan } = semanticRepairApplyFixture({ newCluster: true });
  const calls = [];
  const evidence = await topicRegister.applySemanticRepairWrites({
    workbookId: 'fake-workbook',
    token: 'fake-token',
    plan,
    deps: {
      appendRows: async (...args) => {
        calls.push({ kind: 'append', args });
        return completeSemanticAppendResponse(args[2]);
      },
      batchUpdateValues: async (...args) => {
        calls.push({ kind: 'batch', args });
        return completeSemanticBatchResponse(args[1]);
      },
    },
  });

  assert.deepEqual(calls.map((call) => call.kind), ['append', 'batch']);
  assert.equal(calls[0].args[1], '主题集群表!A:S');
  assert.deepEqual(
    calls[0].args[2],
    plan.newClusters.map((row) => CLUSTER_FIELDS.map((field) => String(row[field] ?? ''))),
  );
  assert.deepEqual(evidence.new_cluster_ids, [plan.newClusters[0].cluster_id]);
  assert.equal(evidence.new_cluster_count, 1);

  const expanded = structuredClone(plan);
  expanded.newClusters.push({ ...plan.newClusters[0], cluster_id: 'unproven-extra-cluster' });
  await assert.rejects(() => topicRegister.applySemanticRepairWrites({
    workbookId: 'fake-workbook',
    token: 'fake-token',
    plan: expanded,
    deps: {
      appendRows: async () => assert.fail('invalid write plan must fail before append'),
      batchUpdateValues: async () => assert.fail('invalid write plan must fail before batch update'),
    },
  }), /semantic-repair-only.*cluster/i);
});

test.skip('obsolete semantic batch response validation is disabled with semantic writes', async () => {
  assert.equal(typeof topicRegister.applySemanticRepairWrites, 'function');
  const { plan } = semanticRepairApplyFixture();
  const validData = [];
  const capture = async (_workbookId, data) => {
    validData.splice(0, validData.length, ...data);
    return completeSemanticBatchResponse(data);
  };
  await topicRegister.applySemanticRepairWrites({
    workbookId: 'fake-workbook', token: 'fake-token', plan,
    deps: { appendRows: async () => assert.fail('no append'), batchUpdateValues: capture },
  });
  const complete = completeSemanticBatchResponse(validData);
  const cases = [
    { label: 'incomplete', response: { totalUpdatedCells: validData.length } },
    { label: 'extra', response: { ...complete, responses: [...complete.responses, complete.responses[0]] } },
    { label: 'wrong range', response: { ...complete, responses: [{ ...complete.responses[0], updatedRange: '选题登记表!A999' }, ...complete.responses.slice(1)] } },
    { label: 'wrong response cells', response: { ...complete, responses: [{ ...complete.responses[0], updatedCells: 2 }, ...complete.responses.slice(1)] } },
    { label: 'wrong total cells', response: { ...complete, totalUpdatedCells: validData.length + 1 } },
  ];
  for (const { label, response } of cases) {
    await assert.rejects(() => topicRegister.applySemanticRepairWrites({
      workbookId: 'fake-workbook', token: 'fake-token', plan,
      deps: {
        appendRows: async () => assert.fail('no append'),
        batchUpdateValues: async () => response,
      },
    }), /semantic-repair-only.*(?:response|range|cell)/i, label);
  }
});

test.skip('obsolete semantic append response validation is disabled with semantic writes', async () => {
  assert.equal(typeof topicRegister.applySemanticRepairWrites, 'function');
  const { plan } = semanticRepairApplyFixture({ newCluster: true });
  const rows = plan.newClusters.map((row) => CLUSTER_FIELDS.map((field) => String(row[field] ?? '')));
  const complete = completeSemanticAppendResponse(rows);
  const cases = [
    { label: 'incomplete', response: {} },
    { label: 'wrong range', response: completeSemanticAppendResponse(rows, { range: '主题集群表!A2:R2' }) },
    { label: 'wrong rows', response: { updates: { ...complete.updates, updatedRows: rows.length + 1 } } },
    { label: 'wrong cells', response: { updates: { ...complete.updates, updatedCells: complete.updates.updatedCells + 1 } } },
  ];
  for (const { label, response } of cases) {
    await assert.rejects(() => topicRegister.applySemanticRepairWrites({
      workbookId: 'fake-workbook', token: 'fake-token', plan,
      deps: {
        appendRows: async () => response,
        batchUpdateValues: async () => assert.fail('invalid append proof must stop before batch update'),
      },
    }), /semantic-repair-only.*(?:append|range|cell|row)/i, label);
  }
});

test('semantic-repair-only is rejected because OPS owns Cluster ID assignment', () => {
  assert.throws(() => semanticRepairRequestFromArgs({
    semantic_repair_only: true,
    product: 'astrologywiki',
    apply: true,
    no_notify: true,
    limit: '2',
    repair_page_ids: 'PG-WDIF-002,PG-WDIN-001',
  }), /disabled.*OPS.*cluster_id/i);
});

test('semantic-repair-only rejects empty target sets too', () => {
  assert.throws(() => semanticRepairRequestFromArgs({
    semantic_repair_only: true,
    product: 'astrologywiki',
    apply: true,
    no_notify: true,
    limit: '0',
  }), /disabled.*OPS.*cluster_id/i);
});

test('help does not advertise the retired semantic Cluster repair flag', () => {
  const run = spawnSync('node', [topicRegisterCli, '--help'], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.doesNotMatch(run.stdout, /--semantic-repair-only/);
});

test.skip('obsolete semantic candidate selection is disabled because OPS owns Cluster IDs', () => {
  const pageHeader = ['Target Keyword', ...PAGE_REQUIRED_FIELDS, 'CTA', 'Status'];
  const cluster = (overrides) => CLUSTER_FIELDS.map((field) => overrides[field] || '');
  const careerClusterRow = cluster({
    cluster_id: 'why_do_i_feel_stuck_in_my_career',
    cluster_name: 'Why Do I Feel Stuck in My Career',
    primary_entity: 'Career Stagnation',
    jtbd: 'Understand career stagnation',
    content_angle: 'Career reflection',
    keywords_included: 'career stagnation, feeling stuck at work',
  });
  const loveLanguageClusterRow = cluster({
    cluster_id: 'love_relationships',
    cluster_name: 'Love and Relationships',
    primary_entity: 'Relationship Patterns',
    jtbd: 'Understand love languages and relationship patterns',
    content_angle: 'Explain love language patterns with clear boundaries',
    keywords_included: 'love language, relationship compatibility, attachment patterns',
    cta_primary: '星盘页',
  });
  const completeRow = ({ clusterId, friction, logic }) => [
    'what is my love language',
    'what is my love language meaning',
    'Info',
    'T2',
    'Definition',
    'What Is My Love Language',
    friction,
    logic,
    'PG-WDIF-002',
    clusterId,
    'Wiki',
    'Explain love language patterns with clear boundaries.',
    'N',
    '星盘页',
    '待写',
  ];
  const correctLoveLanguageRow = completeRow({
    clusterId: 'love_relationships',
    friction: 'Readers need a direct explanation with clear interpretive boundaries.',
    logic: 'Love language patterns connect to relationship patterns without deterministic claims.',
  });
  const repairableWrongRow = completeRow({
    clusterId: 'why_do_i_feel_stuck_in_my_career',
    friction: 'This manually reviewed brief explains the relationship query.',
    logic: 'This manually reviewed relationship logic must replace unrelated career taxonomy.',
  });
  const unsafeWrongRow = completeRow({
    clusterId: 'why_do_i_feel_stuck_in_my_career',
    friction: 'This manually researched friction is intentionally not a deterministic scaffold.',
    logic: 'This manually researched logic is intentionally unrelated to scaffold syntax.',
  });

  const correctPlan = planRows({
    profile: PRODUCT_PROFILES.astrologywiki,
    pagesRaw: [pageHeader, correctLoveLanguageRow],
    clustersRaw: [CLUSTER_FIELDS, loveLanguageClusterRow],
    limit: 1,
    repairPageIds: new Set(['PG-WDIF-002']),
    activePageIds: new Set(['PG-WDIF-002']),
    semanticRepairOnly: true,
  });
  assert.equal(correctPlan.selectionMode, 'semantic_repair_only');
  assert.deepEqual(correctPlan.updates, []);
  assert.deepEqual(correctPlan.promptWrites, []);

  const repairPlan = planRows({
    profile: PRODUCT_PROFILES.astrologywiki,
    pagesRaw: [pageHeader, repairableWrongRow],
    clustersRaw: [CLUSTER_FIELDS, careerClusterRow, loveLanguageClusterRow],
    limit: 1,
    repairPageIds: new Set(['PG-WDIF-002']),
    activePageIds: new Set(['PG-WDIF-002']),
    semanticRepairOnly: true,
  });
  assert.equal(repairPlan.selectionMode, 'semantic_repair_only');
  assert.deepEqual(repairPlan.updates.map((item) => item.pageId), ['PG-WDIF-002']);
  assert.equal(repairPlan.updates[0].fields.cluster_id, 'love_relationships');
  assert.deepEqual(repairPlan.promptWrites, []);
  assert.deepEqual(repairPlan.taskLines, []);

  assert.throws(() => planRows({
    profile: PRODUCT_PROFILES.astrologywiki,
    pagesRaw: [pageHeader, unsafeWrongRow],
    clustersRaw: [CLUSTER_FIELDS, careerClusterRow],
    limit: 1,
    repairPageIds: new Set(['PG-WDIF-002']),
    activePageIds: new Set(['PG-WDIF-002']),
    semanticRepairOnly: true,
  }), /unsafe semantic mismatch.*PG-WDIF-002/i);

  assert.throws(() => planRows({
    profile: PRODUCT_PROFILES.astrologywiki,
    pagesRaw: [pageHeader, correctLoveLanguageRow],
    clustersRaw: [CLUSTER_FIELDS, loveLanguageClusterRow],
    limit: 1,
    repairPageIds: new Set(['PG-UNKNOWN-999']),
    activePageIds: new Set(['PG-UNKNOWN-999']),
    semanticRepairOnly: true,
  }), /missing existing page id.*PG-UNKNOWN-999/i);

  assert.throws(() => planRows({
    profile: PRODUCT_PROFILES.astrologywiki,
    pagesRaw: [pageHeader, correctLoveLanguageRow],
    clustersRaw: [CLUSTER_FIELDS, loveLanguageClusterRow],
    limit: 1,
    repairPageIds: new Set(['PG-WDIF-002']),
    activePageIds: new Set(),
    semanticRepairOnly: true,
  }), /inactive existing page id.*PG-WDIF-002/i);

  assert.throws(() => planRows({
    profile: PRODUCT_PROFILES.gengrowth,
    pagesRaw: [pageHeader, correctLoveLanguageRow],
    clustersRaw: [CLUSTER_FIELDS, loveLanguageClusterRow],
    limit: 1,
    repairPageIds: new Set(['PG-WDIF-002']),
    activePageIds: new Set(['PG-WDIF-002']),
    semanticRepairOnly: true,
  }), /semantic-repair-only requires astrologywiki/i);
});

test('semantic proof proves only requested existing repairs', () => {
  const proof = buildSemanticRepairProof({
    requestedPageIds: ['PG-WDIF-002', 'PG-WDIN-001'],
    summary: {
      applied: true,
      page_ids: ['PG-WDIF-002'],
      new_clusters: 1,
      cluster_repairs: [{
        page_id: 'PG-WDIF-002',
        from: 'why_do_i_feel_stuck_in_my_career',
        to: 'what_is_my_love_language',
        score: 0,
        provenance: 'semantic-repair-new',
      }],
      semantic_write_evidence: verifiedSemanticEvidence({
        changedPageIds: ['PG-WDIF-002'],
        newClusterIds: ['what_is_my_love_language'],
      }),
    },
  });
  assert.equal(proof.status, 'applied');
  assert.deepEqual(Object.keys(proof).sort(), SEMANTIC_REPAIR_PROOF_KEYS);
  assert.deepEqual(proof.changed_page_ids, ['PG-WDIF-002']);
  assert.equal(proof.created_page_id_count, 0);
  assert.equal(proof.cross_product_write_count, 0);

  const sharedClusterProof = buildSemanticRepairProof({
    requestedPageIds: ['PG-WDIF-002', 'PG-WDIN-001'],
    summary: {
      applied: true,
      page_ids: ['PG-WDIF-002', 'PG-WDIN-001'],
      new_clusters: 1,
      cluster_repairs: [
        { page_id: 'PG-WDIF-002', from: 'old-a', to: 'shared-new', score: 0, provenance: 'semantic-repair-new' },
        { page_id: 'PG-WDIN-001', from: 'old-b', to: 'shared-new', score: 0, provenance: 'semantic-repair-new' },
      ],
      semantic_write_evidence: verifiedSemanticEvidence({
        changedPageIds: ['PG-WDIF-002', 'PG-WDIN-001'],
        newClusterIds: ['shared-new'],
      }),
    },
  });
  assert.equal(sharedClusterProof.new_cluster_count, 1);
});

test('semantic proof rejects expanded or unproven writes', () => {
  assert.throws(() => buildSemanticRepairProof({
    requestedPageIds: ['PG-WDIF-002'],
    summary: { applied: true, page_ids: ['PG-OTHER-001'], new_clusters: 0, cluster_repairs: [] },
  }), /outside request/);
  assert.throws(() => buildSemanticRepairProof({
    requestedPageIds: ['PG-WDIF-002'],
    summary: {
      applied: true,
      page_ids: ['PG-WDIF-002'],
      new_clusters: 1,
      cluster_repairs: [{ page_id: 'PG-WDIF-002', from: 'old', to: 'new', score: 0, provenance: 'semantic-repair' }],
    },
  }), /new cluster provenance mismatch/);
});

test('semantic proof rejects changed rows without verified Sheets write evidence', () => {
  assert.throws(() => buildSemanticRepairProof({
    requestedPageIds: ['PG-WDIF-002'],
    summary: {
      applied: true,
      page_ids: ['PG-WDIF-002'],
      new_clusters: 0,
      cluster_repairs: [{
        page_id: 'PG-WDIF-002',
        from: 'old-cluster',
        to: 'existing-cluster',
        score: 0.8,
        provenance: 'semantic-repair',
      }],
    },
  }), /semantic-repair-only.*verified.*write evidence/i);
});

test('semantic proof rejects changed-id page-count or new-cluster count drift from verified writes', () => {
  const baseSummary = {
    applied: true,
    page_ids: ['PG-WDIF-002'],
    new_clusters: 1,
    cluster_repairs: [{
      page_id: 'PG-WDIF-002',
      from: 'old-cluster',
      to: 'new-cluster',
      score: 0,
      provenance: 'semantic-repair-new',
    }],
    semantic_write_evidence: verifiedSemanticEvidence({
      changedPageIds: ['PG-WDIF-002'],
      newClusterIds: ['new-cluster'],
    }),
  };
  const evidenceCases = [
    {
      ...baseSummary.semantic_write_evidence,
      changed_page_ids: ['PG-WDIF-002', 'PG-OTHER-001'],
    },
    {
      ...baseSummary.semantic_write_evidence,
      page_write_count: 2,
    },
    {
      ...baseSummary.semantic_write_evidence,
      new_cluster_count: 2,
    },
    {
      ...baseSummary.semantic_write_evidence,
      cluster_cell_write_count: 0,
    },
  ];
  for (const semantic_write_evidence of evidenceCases) {
    assert.throws(() => buildSemanticRepairProof({
      requestedPageIds: ['PG-WDIF-002'],
      summary: { ...baseSummary, semantic_write_evidence },
    }), /semantic-repair-only.*verified write evidence mismatch/i);
  }
});

test('semantic proof rejects non-empty skipped or budget-exhausted runs but preserves legal noops', () => {
  const repairSummary = {
    applied: false,
    page_ids: ['PG-WDIF-002'],
    new_clusters: 0,
    cluster_repairs: [{
      page_id: 'PG-WDIF-002',
      from: 'old-cluster',
      to: 'existing-cluster',
      score: 0.8,
      provenance: 'semantic-repair',
    }],
  };
  for (const summary of [
    { ...repairSummary, applied: true, skipped_apply: true },
    { ...repairSummary, applied: true, budget_exhausted: true },
    repairSummary,
  ]) {
    assert.throws(
      () => buildSemanticRepairProof({ requestedPageIds: ['PG-WDIF-002'], summary }),
      /semantic-repair-only.*(?:apply|skipped|budget)/i,
    );
  }

  const appliedNoop = buildSemanticRepairProof({
    requestedPageIds: ['PG-WDIF-002'],
    summary: {
      applied: true,
      page_ids: [],
      new_clusters: 0,
      cluster_repairs: [],
      semantic_write_evidence: verifiedSemanticEvidence(),
    },
  });
  assert.equal(appliedNoop.status, 'noop');

  const emptyTargetNoop = buildSemanticRepairProof({
    requestedPageIds: [],
    summary: { applied: false, page_ids: [], new_clusters: 0, cluster_repairs: [] },
  });
  assert.equal(emptyTargetNoop.status, 'noop');
});

test('semantic proof rejects malformed or non-bijective repair evidence', () => {
  const validRepair = {
    page_id: 'PG-WDIF-002',
    from: 'old-cluster',
    to: 'existing-cluster',
    score: 0.8,
    provenance: 'semantic-repair',
  };
  const cases = [
    {
      label: 'duplicate selected and repair ids',
      summary: {
        applied: true,
        page_ids: ['PG-WDIF-002', 'PG-WDIF-002'],
        new_clusters: 0,
        cluster_repairs: [validRepair, { ...validRepair }],
      },
    },
    {
      label: 'repair id does not match selected id',
      summary: {
        applied: true,
        page_ids: ['PG-WDIF-002'],
        new_clusters: 0,
        cluster_repairs: [{ ...validRepair, page_id: 'PG-WDIN-001' }],
      },
    },
    {
      label: 'invalid provenance',
      summary: {
        applied: true,
        page_ids: ['PG-WDIF-002'],
        new_clusters: 0,
        cluster_repairs: [{ ...validRepair, provenance: 'manual-repair' }],
      },
    },
    ...['page_id', 'from', 'to'].map((field) => ({
      label: `empty ${field}`,
      summary: {
        applied: true,
        page_ids: ['PG-WDIF-002'],
        new_clusters: 0,
        cluster_repairs: [{ ...validRepair, [field]: '' }],
      },
    })),
    {
      label: 'non-finite score',
      summary: {
        applied: true,
        page_ids: ['PG-WDIF-002'],
        new_clusters: 0,
        cluster_repairs: [{ ...validRepair, score: Number.NaN }],
      },
    },
    {
      label: 'non-number score',
      summary: {
        applied: true,
        page_ids: ['PG-WDIF-002'],
        new_clusters: 0,
        cluster_repairs: [{ ...validRepair, score: '0.8' }],
      },
    },
  ];

  for (const { label, summary } of cases) {
    assert.throws(
      () => buildSemanticRepairProof({
        requestedPageIds: ['PG-WDIF-002', 'PG-WDIN-001'],
        summary,
      }),
      /semantic-repair-only.*repair evidence/i,
      label,
    );
  }
});

test('runPreprocessorForPlan skips LLM work with budget_exhausted status when run budget is spent', async () => {
  const budget = createRunBudget({ budgetMs: 1, startedAtMs: 1000, now: () => 1000 });
  const plan = {
    updates: [
      { pageId: 'PG-TEST-001', fields: { Entity: 'Existing Entity' } },
      { pageId: 'PG-TEST-002', fields: { Entity: 'Second Entity' } },
    ],
    promptWrites: [
      { pageId: 'PG-TEST-001', prompt: 'prompt 1' },
      { pageId: 'PG-TEST-002', prompt: 'prompt 2' },
    ],
  };
  let calls = 0;

  await runPreprocessorForPlan(plan, {
    llm: 'claude',
    budget,
    callLLM: async () => {
      calls += 1;
      return { stdout: 'SHOULD_NOT_RUN' };
    },
  });

  assert.equal(calls, 0);
  assert.deepEqual(plan.updates.map((u) => u.preprocessor?.status), ['budget_exhausted', 'budget_exhausted']);
  assert.equal(plan.updates[0].fields.Entity, 'Existing Entity');
});

test('runPreprocessorForPlan falls back to v1 fields when v2 returns placeholders', async () => {
  const plan = {
    updates: [
      {
        pageId: 'PG-TEST-PLACEHOLDER',
        fields: {
          Entity: 'Deterministic Entity',
          Friction: 'Deterministic friction.',
          Logic: 'Deterministic logic.',
          content_angle: 'Deterministic angle.',
        },
      },
    ],
    promptWrites: [
      { pageId: 'PG-TEST-PLACEHOLDER', prompt: 'prompt' },
    ],
  };
  const prompts = [];
  const llms = [];

  await runPreprocessorForPlan(plan, {
    llm: 'claude',
    allowFallback: true,
    callLLM: async ({ llm, prompt }) => {
      llms.push(llm);
      prompts.push(prompt);
      if (prompts.length === 1) {
        return {
          model: 'claude-opus-4-7',
          stdout: [
            'SHEET_FIELDS',
            'Entity: — (not synthesized; insufficient input)',
            'Friction: — (not synthesized; insufficient input)',
            'Logic: — (not synthesized; insufficient input)',
            'Content_Angle: — (not synthesized; insufficient input)',
          ].join('\n'),
        };
      }
      return {
        model: 'claude',
        stdout: [
          'Friction: Searchers conflate the topic with broad celebrity astrology because results blur sign lookup and full-chart context.',
          'Content_Angle: Start with the quick sign answer, then narrow the article around what the query can and cannot support.',
        ].join('\n'),
      };
    },
  });

  assert.equal(prompts.length, 2);
  assert.deepEqual(llms, ['claude', 'claude']);
  assert.match(prompts[1], /SEO Content Variable Pre-processor \(v1\.0 fallback\)/);
  assert.equal(plan.updates[0].preprocessor?.status, 'v1_fallback');
  assert.equal(plan.updates[0].fields.Entity, 'Deterministic Entity');
  assert.equal(plan.updates[0].fields.Friction, 'Searchers conflate the topic with broad celebrity astrology because results blur sign lookup and full-chart context.');
  assert.equal(plan.updates[0].fields.Logic, 'Deterministic logic.');
  assert.equal(plan.updates[0].fields.content_angle, 'Start with the quick sign answer, then narrow the article around what the query can and cannot support.');
});

// ── 通知统一（阶段 1）：--apply 通知走统一事件层 topic_registered，不再裸拼字符串 ──

test('notifyTopicRegistered 走统一事件层：topic_registered 模板文案 + 不@（本地 mock 飞书，绝不碰真网络）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-topic-register-notify-'));
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch { /* body 不合法就记空对象 */ }
      requests.push({ url: req.url, body });
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        res.end(JSON.stringify({ code: 0, tenant_access_token: 't-test' }));
        return;
      }
      res.end(JSON.stringify({ code: 0, data: { message_id: 'om_test' } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const envKeys = [
    'HERMES_ENV', 'GG_LARK_API_BASE', 'GG_FLOW_STATE_DIR', 'GG_LARK_AUDIT_LOG',
    'GG_LARK_SEND_RETRIES', 'GG_LARK_RETRY_BASE_MS', 'GG_LARK_NOTIFY_CHAT_ID',
    'GG_LARK_NOTIFY_SILENCE', 'GG_LARK_NOTIFY_AT_PM', 'GG_LARK_NOTIFY_AT_OPERATOR', 'GG_LARK_NOTIFY_AT_OPS',
  ];
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  try {
    const hermes = join(dir, 'hermes.env');
    writeFileSync(hermes, 'FEISHU_APP_ID=cli_test\nFEISHU_APP_SECRET=sec_test\n');
    process.env.HERMES_ENV = hermes;
    process.env.GG_LARK_API_BASE = `http://127.0.0.1:${server.address().port}`;
    process.env.GG_FLOW_STATE_DIR = join(dir, 'state');
    process.env.GG_LARK_AUDIT_LOG = join(dir, 'audit.log');
    process.env.GG_LARK_SEND_RETRIES = '0';
    process.env.GG_LARK_RETRY_BASE_MS = '1';
    process.env.GG_LARK_NOTIFY_CHAT_ID = 'oc_test_chat';
    // 宿主 shell 可能残留的通知开关一律清掉，事件层语义从干净状态出发。
    delete process.env.GG_LARK_NOTIFY_SILENCE;
    delete process.env.GG_LARK_NOTIFY_AT_PM;
    delete process.env.GG_LARK_NOTIFY_AT_OPERATOR;
    delete process.env.GG_LARK_NOTIFY_AT_OPS;

    const r = await notifyTopicRegistered({
      profile: { key: 'astrologywiki', label: 'astrologywiki.com' },
      plan: {
        updates: [{ pageId: 'PG-CELEB-011' }, { pageId: 'PG-CELEB-012' }],
        newClusters: [{ cluster_id: 'celebrity_zodiac_trending' }],
      },
    });
    assert.equal(r.ok, true);

    const texts = requests
      .filter((q) => q.url.startsWith('/open-apis/im/v1/messages'))
      .map((q) => JSON.parse(q.body.content).text);
    assert.equal(texts.length, 1, '应恰好发出一条消息');
    assert.equal(
      texts[0],
      '📋 [astrologywiki] 选题登记自动补齐：astrologywiki.com\n补齐 2 行；新增 cluster 1 个。\npage_id: PG-CELEB-011, PG-CELEB-012',
    );
    assert.ok(!texts[0].includes('<at '), 'topic_registered 事件按契约不 @ 任何人');
  } finally {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gg-topic-register 源码不再引用 gg-lark-notify.sh 裸字符串通道', () => {
  const src = readFileSync(new URL('../gg-topic-register.mjs', import.meta.url), 'utf8');
  assert.ok(!src.includes('gg-lark-notify.sh'), '调用点应已迁移到 lib/gg-notify.mjs 事件层');
  assert.ok(!src.includes('execFileSync'), '旧 execFileSync 通知通道应已删除');
  assert.match(src, /notify\('topic_registered'/, '应通过统一事件层发 topic_registered');
});

// 根因回归：associatedKeywordsForPage 绝不把 cluster 里别的实体的关键词塞进本文章
// （cluster.keywords_included 累积了全簇实体词，含 "emma watson zodiac sign" 这类脏词）。
test('associatedKeywordsForPage 不泄漏 cluster 里其它实体的关键词（emma-watson 根因）', () => {
  const cluster = { keywords_included: 'emma watson zodiac sign, cole palmer birth chart, jannik sinner zodiac sign, celebrity astrology' };
  for (const tk of ['Cole Palmer birth chart', 'Achraf Hakimi birth chart', 'Rayan Cherki Birth Chart']) {
    const kw = associatedKeywordsForPage({ targetKeyword: tk, cluster, product: 'astrologywiki' });
    assert.ok(!/emma watson/i.test(kw), `${tk} 泄漏了 emma watson: ${kw}`);
    assert.ok(!/jannik sinner/i.test(kw), `${tk} 泄漏了 jannik sinner: ${kw}`);
    // 仍保留本实体的关键词
    const ent = tk.split(' ')[0].toLowerCase();
    assert.ok(new RegExp(ent, 'i').test(kw), `${tk} 丢了自己的实体词: ${kw}`);
  }
});

test('associatedKeywordsForPage：种子词与 target 共享实体 token 时仍保留（不误杀相关词）', () => {
  // target 自身的簇种子（jannik sinner）应因共享实体 token 被保留（这里通过 country-vs 场景验证非本实体不加）
  const kwOwn = associatedKeywordsForPage({ targetKeyword: 'Jannik Sinner zodiac sign', cluster: { keywords_included: 'jannik sinner grand slam, emma watson zodiac sign' }, product: 'astrologywiki' });
  assert.ok(/jannik sinner grand slam/i.test(kwOwn), `共享实体 token 的相关种子应保留: ${kwOwn}`);
  assert.ok(!/emma watson/i.test(kwOwn), `无关实体种子应被过滤: ${kwOwn}`);
});
