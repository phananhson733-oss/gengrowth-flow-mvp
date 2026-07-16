#!/usr/bin/env node
// Run: node --test tools/scripts/__tests__/gg-topic-register.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  associatedKeywordsForPage,
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
  titleCase,
  valuesBatchForPageRow,
} from '../gg-topic-register.mjs';
import { renderPreprocessorPrompt } from '../lib/preprocessor-prompt.mjs';

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

test('planRows automatically repairs a complete unpublished row whose existing cluster is semantically unrelated', () => {
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
    activePageIds: new Set(['PG-WDIF-002']),
  });

  assert.equal(plan.selectionMode, 'semantic_repair');
  assert.deepEqual(plan.updates.map((item) => item.pageId), ['PG-WDIF-002']);
  assert.equal(plan.updates[0].cluster.cluster_id, 'love_relationships');
  assert.equal(plan.updates[0].fields.cluster_id, 'love_relationships');
  assert.equal(plan.updates[0].fields.Entity, 'My Love Language');
  assert.match(plan.updates[0].fields.Logic, /Relationship Patterns/);
  assert.doesNotMatch(plan.updates[0].fields.Logic, /Career/);

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
  assert.ok(writtenColumns.has(String.fromCharCode(65 + clusterColumn)), 'cluster_id must be overwritten');
  assert.ok(writtenColumns.has(String.fromCharCode(65 + logicColumn)), 'Logic must be overwritten');
  assert.ok(writtenColumns.has(String.fromCharCode(65 + entityColumn)), 'Entity must be normalized');
  assert.equal(plan.taskLines.length, 0, 'semantic repair must preserve the existing page id and task line');
});

test('planRows creates a singleton cluster only for a zero-score deterministic scaffold with no relevant existing cluster', () => {
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
        cluster_id: 'why_do_i_feel_stuck_in_my_career',
        cluster_name: 'Why Do I Feel Stuck in My Career',
        primary_entity: 'Career Stagnation',
        jtbd: 'Understand career stagnation',
        content_angle: 'Career reflection',
        keywords_included: 'career stagnation, feeling stuck at work',
      }),
    ],
    limit: 10,
    activePageIds: new Set(['PG-WDIF-002']),
  });

  assert.equal(plan.selectionMode, 'semantic_repair');
  assert.equal(plan.newClusters.length, 1);
  assert.equal(plan.updates[0].pageId, 'PG-WDIF-002');
  assert.equal(plan.updates[0].clusterDecision.kind, 'semantic-repair-new');
  assert.equal(plan.updates[0].clusterDecision.previous_cluster_id, 'why_do_i_feel_stuck_in_my_career');
  assert.equal(plan.updates[0].fields.cluster_id, 'what_is_my_love_language');
  assert.equal(plan.updates[0].fields.Entity, 'My Love Language');
  assert.doesNotMatch(plan.updates[0].fields.Logic, /Career/);
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
