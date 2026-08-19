#!/usr/bin/env node
/**
 * gg-gengrowth-cron-tick.mjs — 每日博客发布定时器的**判定层**。
 *
 * 2026-08-13 日历排到 8/30 每天 1 篇。gg-gengrowth-daily.sh 已经把"发一篇"固化成一条命令，
 * 但还是要人每天记得跑、记得跑哪一篇。这个 tick 负责回答"今天该发哪一篇"，然后调那条命令。
 *
 * ── 这个脚本明确**不做**什么（边界就是它的安全性所在） ──
 * 不写作、不做事实审、不改稿、不生成 hero。它只发布**人已经备好并过审**的稿子。
 * 8/17–8/20 四篇的对抗审改掉的都是文章框架和事实（"drop"其实是涨、竞品功能描述失实），
 * 结构门一个字都拦不住 —— 所以事实审必须留在人手里，定时器只做搬运。
 *
 * ── 选稿规则 ──
 *   1. 只看 _staging/PG-<前缀>-NNN-en.md，前缀取自 gg-gengrowth-publish.mjs 的 W25_PREFIXES。
 *      那份白名单是防污染闸门（挡住共用 _staging/ 里的占星稿），这里 import 而不是复制一份。
 *   2. frontmatter 的 `date:` 就是排定的发布日。**date > 今天的一律不碰** —— 用户硬约束：
 *      不提前发未到期文章（竞品定价会变，"checked <日期>"提前太久就是陈旧的）。
 *   3. 已经在线上 sitemap 里的排除（幂等：重跑不会重发）。
 *   4. 剩下的按 date 升序取**第一篇**。这样错过一天之后会自动补，但每天仍然只发一篇。
 *      补发窗口有界（CATCHUP_DAYS=7）：_staging/ 里躺着 6–7 月四篇从没配过 hero、也从没进过
 *      日历的废稿（serankings / free-seo-consultation / free-white-label-seo /
 *      meta-business-agent）。"最早的到期未发"如果不设下界，第一次 tick 就会去捞 6/23 的
 *      废稿而不是今天的文章。逾期 7 天以上的当作废弃，只记日志不报警不发布。
 *      （frontmatter 的 `status:` 帮不上忙 —— 废稿和成稿写的都是 ready-to-review。）
 *   5. 当天已经发过（state 文件记录）就直接退出 —— 否则积压时一小时一次的 tick 会把
 *      backlog 一次性全推上去，等于放弃了"每天 1 篇"。
 *
 * ── 失败一律吵闹 ──
 * 到期了但 hero 缺失/尺寸不对 → 报警退出，不静默跳过。今天根本没有稿子 → 报警。
 * 这条内容线反复吃的亏都是"不报错，只是悄悄产出坏结果"，所以这里全部 fail-loud。
 *
 * 用法：
 *   node tools/scripts/gg-gengrowth-cron-tick.mjs              # dry-run，只打印决定
 *   node tools/scripts/gg-gengrowth-cron-tick.mjs --publish    # 真发（plist 用这个）
 *   GG_GENGROWTH_TODAY=2026-08-19 …                            # 测试用，覆盖"今天"
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './gg-md-to-oracle-ts.mjs';
import { W25_PREFIXES } from './gg-gengrowth-publish.mjs';
import { stateDir } from './lib/flow-state.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const STAGING = join(REPO, '_staging');
const SITEMAP = 'https://gengrowth.ai/sitemap.xml';

// `-en.md` 是人手写的稿子命名（gg-gengrowth-publish.mjs 的 DRAFT_RE 匹配的是自动线的
// `-<tag>-v8.md`，两条线命名不同，所以正则不能共用 —— 但前缀列表必须共用）。
export const DRAFT_RE = new RegExp(`^(PG-(?:${W25_PREFIXES.join('|')})-\\d+)-en\\.md$`, 'i');

const today = () => process.env.GG_GENGROWTH_TODAY || new Date().toISOString().slice(0, 10);

// 补发窗口：漏发一天是运维故障，要补；漏发两个月的是废稿，不该被定时器捞起来发布。
export const CATCHUP_DAYS = 7;
const daysBefore = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) - n * 86400_000).toISOString().slice(0, 10);

/**
 * 选稿的**全部**判定逻辑，纯函数，便于测试。
 * 这是整个定时器唯一会"悄悄发错文章"的地方：选错了不会报错，只会有一篇不该上线的文章上线。
 *
 * @param drafts 已按 date 升序排好的 {pageId, slug, date}
 * @param live   线上已收录的 slug 集合
 * @param today  YYYY-MM-DD
 */
export function partitionDrafts(drafts, live, today) {
  const floor = daysBefore(today, CATCHUP_DAYS);
  const unpublished = drafts.filter((d) => !live.has(d.slug));
  return {
    floor,
    unpublished,
    due: unpublished.filter((d) => d.date <= today && d.date >= floor),
    upcoming: unpublished.filter((d) => d.date > today),
    abandoned: unpublished.filter((d) => d.date < floor),
  };
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * 发飞书。best-effort：通知挂了不能搞垮发布判定。
 * dry-run 下只打印不发送 —— 否则每次演练都会往「SEO技术」群里推一条假告警。
 */
function alert(msg, { atPm = false, atOps = false, dedupeKey = null } = {}) {
  log(`NOTIFY: ${msg}`);
  if (!process.argv.includes('--publish')) {
    log('  (dry-run，未实际发送)');
    return;
  }
  // plist 一天触发多次（重试用）。没有去重的话，"今天没稿子"这种告警会一天刷 3 遍群。
  if (dedupeKey) {
    const s = readState();
    const stamp = `${today()}:${dedupeKey}`;
    if (s.last_alert === stamp) {
      log('  (今天已发过同类告警，跳过)');
      return;
    }
    writeState({ ...s, last_alert: stamp });
  }
  try {
    execFileSync(join(__dirname, 'gg-lark-notify.sh'), [msg], {
      env: {
        ...process.env,
        ...(atPm ? { GG_LARK_NOTIFY_AT_PM: '1' } : {}),
        ...(atOps ? { GG_LARK_NOTIFY_AT_OPS: '1' } : {}),
      },
      timeout: 60_000,
      stdio: 'ignore',
    });
  } catch {
    /* best-effort */
  }
}

/** 线上 sitemap 里已有的 /blog/<slug>。拉不到就返回 null（宁可不发，也不要误判成没发过而重发）。 */
function liveSlugs() {
  try {
    const xml = execFileSync('curl', ['-sS', '--max-time', '30', SITEMAP], {
      encoding: 'utf8',
      timeout: 45_000,
    });
    const found = new Set();
    for (const m of xml.matchAll(/\/blog\/([a-z0-9-]+)/g)) found.add(m[1]);
    // 一个正常的 sitemap 至少有几十条。拿到个位数说明是错误页/被截断，当作拉取失败。
    return found.size >= 10 ? found : null;
  } catch {
    return null;
  }
}

/** 扫 _staging，返回所有 gengrowth 待发稿子。 */
export function scanDrafts() {
  const out = [];
  for (const f of readdirSync(STAGING)) {
    const m = f.match(DRAFT_RE);
    if (!m) continue;
    let fm;
    try {
      ({ frontmatter: fm } = parseFrontmatter(readFileSync(join(STAGING, f), 'utf8')));
    } catch {
      continue; // 没有合法 frontmatter 的不是成稿
    }
    const date = String(fm.date || '').trim();
    const slug = String(fm.slug || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !slug) continue;
    out.push({ pageId: m[1].toUpperCase(), slug, date, file: f });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** hero 就位且是 1200x675。返回 null 表示 OK，否则返回问题描述。 */
function heroProblem(pageId) {
  const hero = join(STAGING, `${pageId}-hero.jpg`);
  if (!existsSync(hero)) return `缺 hero: _staging/${pageId}-hero.jpg`;
  try {
    const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', hero], {
      encoding: 'utf8',
    });
    const w = out.match(/pixelWidth:\s*(\d+)/)?.[1];
    const h = out.match(/pixelHeight:\s*(\d+)/)?.[1];
    if (w !== '1200' || h !== '675') return `hero 尺寸是 ${w}x${h}，要 1200x675`;
  } catch (e) {
    return `hero 读不出尺寸: ${e.message}`;
  }
  return null;
}

/**
 * 每上线一篇，都要往 GENGROWTH_TBD_LINK_RULES 加一条规则，后面的文章才链得到它 ——
 * 少了规则不会报错，锚文本会**静默退化成斜体**，链接就是没了。
 * gg-gengrowth-daily.sh 结尾会打一行提醒，但定时器跑起来之后没人看 launchd 日志，
 * 所以这里实测规则在不在，缺了才把提醒带进飞书（在的话一个字都不说，避免变成背景噪音）。
 * 返回空串表示规则已就位。
 */
export function linkRuleReminder(slug) {
  try {
    const src = readFileSync(join(__dirname, 'gg-md-to-gengrowth-blog.mjs'), 'utf8');
    if (src.includes(`/blog/${slug}'`) || src.includes(`/blog/${slug}"`)) return '';
  } catch {
    return ''; // 读不到就别乱报警
  }
  return ` ⚠️ 还要往 flow-mvp 的 GENGROWTH_TBD_LINK_RULES 加 ${slug} 的内链规则，否则后面的文章链不到这篇（锚文本会静默变斜体）。`;
}

const STATE_FILE = () => {
  const dir = stateDir();
  return dir ? join(dir, 'gengrowth-blog-daily.json') : null;
};

function readState() {
  const p = STATE_FILE();
  if (!p || !existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(s) {
  const p = STATE_FILE();
  if (!p) return;
  try {
    writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
  } catch {
    /* best-effort */
  }
}

function main() {
  const publish = process.argv.includes('--publish');
  const TODAY = today();
  log(`tick 开始 (today=${TODAY}, mode=${publish ? 'publish' : 'dry-run'})`);

  const live = liveSlugs();
  if (!live) {
    // 拉不到 sitemap 就无法判断哪些已发。此时发布是"可能重发"，不发是"可能漏一天"。
    // 漏一天可以补，重发会在 main 上产生一个空 commit 并让账本回填看起来像新事件 —— 选不发。
    alert('gengrowth 每日发布：拉不到 sitemap.xml，本次 tick 跳过（无法判断哪些已发布）', {
      atPm: true,
      dedupeKey: 'sitemap-unreachable',
    });
    process.exit(1);
  }

  const drafts = scanDrafts();
  const { floor, unpublished, due, upcoming, abandoned } = partitionDrafts(drafts, live, TODAY);

  log(
    `扫到 ${drafts.length} 篇 gengrowth 稿 / 未发 ${unpublished.length} / 到期可补 ${due.length} / 未来备着 ${upcoming.length} / 超窗废稿 ${abandoned.length}`,
  );
  if (abandoned.length) {
    log(`  超窗（早于 ${floor}，不发布也不报警）: ${abandoned.map((d) => `${d.slug}@${d.date}`).join(', ')}`);
  }

  const state = readState();
  if (state.last_publish_date === TODAY) {
    log(`今天已经发过 ${state.last_slug}，退出（每天只发一篇）`);
    return;
  }

  if (due.length === 0) {
    const todayDraft = drafts.find((d) => d.date === TODAY);
    if (todayDraft) {
      log(`今天的 ${todayDraft.slug} 已在线上，无事可做`);
    } else {
      alert(
        `gengrowth 每日发布：${TODAY} 没有到期稿子。日历排的是每天 1 篇，` +
          `当天这一篇还没备到 _staging/（需要人写稿 + 事实审，定时器只负责发）。` +
          `目前未来还备着 ${upcoming.length} 篇。`,
        { atPm: true, atOps: true, dedupeKey: 'no-draft-due' },
      );
      process.exit(1);
    }
    return;
  }

  const pick = due[0];
  const overdue = due.length > 1 ? `（另有 ${due.length - 1} 篇逾期未发，明天继续补）` : '';
  log(`选中 ${pick.pageId} ${pick.slug} (排期 ${pick.date})${overdue}`);

  const problem = heroProblem(pick.pageId);
  if (problem) {
    alert(
      `gengrowth 每日发布：${pick.pageId} (${pick.slug}) 到期但发不出去 —— ${problem}`,
      { atPm: true, atOps: true, dedupeKey: `hero-missing:${pick.pageId}` },
    );
    process.exit(1);
  }

  if (!publish) {
    log(`[DRY-RUN] 将执行: gg-gengrowth-daily.sh ${pick.pageId} ${pick.slug} --publish`);
    if (upcoming.length < 2) {
      log(`[DRY-RUN] 缓冲只剩 ${upcoming.length} 篇，会告警`);
    }
    return;
  }

  try {
    execFileSync(
      join(__dirname, 'gg-gengrowth-daily.sh'),
      [pick.pageId, pick.slug, '--publish'],
      { stdio: 'inherit', timeout: 30 * 60_000 },
    );
  } catch (e) {
    alert(
      `gengrowth 每日发布失败：${pick.pageId} (${pick.slug}) —— ${e.message}。` +
        `日志在 ~/gengrowth-agents/cron-sync/gengrowth-blog-daily/。`,
      { atPm: true, atOps: true, dedupeKey: `publish-failed:${pick.pageId}` },
    );
    process.exit(1);
  }

  writeState({ ...state, last_publish_date: TODAY, last_slug: pick.slug, last_page_id: pick.pageId });

  // 缓冲深度是这条线唯一的真实约束：定时器只能发人备好的稿子，备完了它就停。
  const bufferWarn =
    upcoming.length < 2
      ? `⚠️ 缓冲只剩 ${upcoming.length} 篇，再不补稿明天就断档。`
      : `缓冲还有 ${upcoming.length} 篇。`;
  alert(
    `gengrowth 每日发布：${pick.slug} 已上线 https://gengrowth.ai/blog/${pick.slug}${overdue}。` +
      `${bufferWarn}${linkRuleReminder(pick.slug)}`,
    { atOps: true, atPm: upcoming.length < 2 || Boolean(linkRuleReminder(pick.slug)) },
  );
  log('完成');
}

// 只有直接跑才执行；import 进测试时不能触发一次真实发布。
if (import.meta.url === `file://${process.argv[1]}`) main();
