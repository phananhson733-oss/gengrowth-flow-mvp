// gengrowth-cron-tick.test.mjs — 每日发布定时器的选稿不变量。
//
// 这个定时器无人值守地往生产站推文章。它选错稿子**不会报错** —— 只会有一篇不该上线的
// 文章上线，而且是在没人看着的时候。所以选稿逻辑的每条边界都在这里钉死。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { partitionDrafts, CATCHUP_DAYS, DRAFT_RE } from '../gg-gengrowth-cron-tick.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..');

const d = (date, slug, pageId = 'PG-CMP-001') => ({ date, slug, pageId });
const pick = (drafts, live, today) => partitionDrafts(drafts, new Set(live), today).due[0] ?? null;

// ── 用户硬约束：不提前发未到期文章 ──
// 竞品定价会变，稿子里写的是 "checked <日期>"；提前发出去等于把一份已经陈旧的核实日期
// 印在生产页面上。8/17–8/20 四篇全是竞品对比，这条约束对它们尤其要紧。
test('永不选取排期在未来的稿子', () => {
  const drafts = [d('2026-08-19', 'tomorrow'), d('2026-08-25', 'next-week')];
  assert.equal(pick(drafts, [], '2026-08-18'), null);

  const { upcoming, due } = partitionDrafts(drafts, new Set(), '2026-08-18');
  assert.equal(due.length, 0);
  assert.equal(upcoming.length, 2);
});

test('到期当天可以发，边界是含当天', () => {
  const drafts = [d('2026-08-18', 'today')];
  assert.equal(pick(drafts, [], '2026-08-18').slug, 'today');
});

// ── 补发窗口有界 ──
// _staging/ 是两条内容线共用的历史堆积区，里面躺着 6–7 月四篇从没配过 hero、也从没进过
// 日历的废稿。不设下界的话，第一次 tick 会去捞 6/23 的 serankings 而不是当天的文章。
test('逾期超过补发窗口的按废稿处理，不发布', () => {
  const drafts = [d('2026-06-23', 'serankings'), d('2026-08-18', 'today')];
  const { due, abandoned } = partitionDrafts(drafts, new Set(), '2026-08-18');
  assert.deepEqual(due.map((x) => x.slug), ['today']);
  assert.deepEqual(abandoned.map((x) => x.slug), ['serankings']);
});

test('补发窗口边界：正好 CATCHUP_DAYS 天前算可补，再早一天算废稿', () => {
  const today = '2026-08-18';
  const onEdge = '2026-08-11'; // 7 天前
  const past = '2026-08-10'; // 8 天前
  assert.equal(CATCHUP_DAYS, 7);

  assert.equal(pick([d(onEdge, 'edge')], [], today).slug, 'edge');
  assert.equal(pick([d(past, 'too-old')], [], today), null);
});

// ── 每天只发一篇 ──
// 积压时一次把 backlog 全推上去，等于放弃了用户要的"每天 1 篇"节奏，而且会在同一天
// 给站点灌进多篇新页面。due 是按日期升序的，取 [0] 就是最早那篇。
test('积压时按日期升序只取最早一篇', () => {
  const drafts = [d('2026-08-19', 'first'), d('2026-08-20', 'second')];
  const { due } = partitionDrafts(drafts, new Set(), '2026-08-22');
  assert.equal(due.length, 2, '两篇都逾期，都在候选里');
  assert.equal(due[0].slug, 'first', '但 main() 只取 [0]');
});

// ── 幂等 ──
test('线上已收录的 slug 不会被再发一次', () => {
  const drafts = [d('2026-08-18', 'already-live')];
  assert.equal(pick(drafts, ['already-live'], '2026-08-18'), null);
});

// ── 防污染：共用 _staging/ 里的占星稿绝不能被选中 ──
// 前缀白名单是这条防线，而它的失效方式是静默的：前缀不在表里，正则就是不匹配，
// 文件被当作不存在。所以两个方向都要测。
test('DRAFT_RE 只匹配 gengrowth 前缀的 -en.md', () => {
  assert.ok(DRAFT_RE.test('PG-CMP-007-en.md'));
  assert.ok(DRAFT_RE.test('PG-SPD-002-en.md'));
  assert.ok(DRAFT_RE.test('PG-ASV-001-en.md'));

  // 占星线的稿子（PG-CELEB / PG-KB / PG-WC 等前缀不在 gengrowth 白名单里）
  assert.ok(!DRAFT_RE.test('PG-CELEB-065-en.md'));
  assert.ok(!DRAFT_RE.test('PG-KB-001-en.md'));
  assert.ok(!DRAFT_RE.test('PG-WC-020-en.md'));
  // 完全不带 page_id 的占星稿
  assert.ok(!DRAFT_RE.test('june-2026-transits-en.md'));
  assert.ok(!DRAFT_RE.test('page_orange_aura_meaning-en.md'));
  // 自动线的 -v8 命名不归这个定时器管（那条线走 gg-gengrowth-publish.mjs）
  assert.ok(!DRAFT_RE.test('PG-CMP-007-manual-v8.md'));
});

// ── 白名单单一事实源 ──
// 复制一份白名单，就等于给"某个 cluster 加了前缀但只改了一处"留了口子，
// 而后果是一篇稿子永远发不出去（静默）或一篇占星稿发到 gengrowth.ai（更糟）。
test('tick 从 gg-gengrowth-publish.mjs import 前缀表，不自带一份', () => {
  const src = readFileSync(join(SCRIPTS, 'gg-gengrowth-cron-tick.mjs'), 'utf8');
  assert.match(
    src,
    /import\s*\{\s*W25_PREFIXES\s*\}\s*from\s*'\.\/gg-gengrowth-publish\.mjs'/,
    'tick 必须 import W25_PREFIXES',
  );
  assert.doesNotMatch(src, /const\s+W25_PREFIXES\s*=\s*\[/, 'tick 里不能有第二份前缀表');
});

// ── plist 与脚本必须对得上 ──
// launchd 找不到二进制或路径写错时是**静默不跑**，不会报错也不会有日志行。
// 这类错误只能靠"下周发现一篇都没发"来发现，所以在这里静态钉住。
test('plist 指向的脚本路径和参数与实际脚本一致', () => {
  const plist = readFileSync(join(SCRIPTS, 'com.gengrowth.blog-daily.plist'), 'utf8');
  assert.match(plist, /gg-gengrowth-cron-tick\.mjs/, 'plist 要指向 tick 脚本');
  assert.match(plist, /<string>--publish<\/string>/, '不带 --publish 就是空跑，永远不会发布');
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/, '装定时器本身不该触发一次发布');
  // PATH 必须覆盖 node/git/curl/sips —— gg-gengrowth-daily.sh 四个都要用
  assert.match(plist, /<key>PATH<\/key>/, 'launchd 的 PATH 极简，必须显式给');
});

// ── 上线后必须补的那条内链规则 ──
// 少了规则不报错，锚文本静默退化成斜体 —— 链接就是没了。定时器跑起来之后没人看 launchd
// 日志，所以提醒必须进飞书；但已经加过的不能再提，否则变成每天都有的背景噪音，就等于没提。
test('内链规则已存在时不提醒，缺失时提醒', async () => {
  const { linkRuleReminder } = await import('../gg-gengrowth-cron-tick.mjs');
  // 8/17-8/19 三篇已上线且规则已补
  assert.equal(linkRuleReminder('outrank-alternatives'), '');
  assert.equal(linkRuleReminder('autoblogging-ai-alternatives'), '');
  // 编造一个绝不会存在的 slug
  assert.match(linkRuleReminder('a-slug-that-will-never-exist'), /GENGROWTH_TBD_LINK_RULES/);
});
