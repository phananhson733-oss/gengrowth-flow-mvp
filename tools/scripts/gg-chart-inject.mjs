#!/usr/bin/env node
// gg-chart-inject.mjs — 授稿前算**真实星盘数据**注入 brief，让 LLM 只解读真数据、不再凭空编星盘
// （消除 "Horse in Life Palace" 那类幻觉星盘断言）。
//
// 流程：名人实体 → 抓 Wikipedia（确定性提取 bday 生日 + 出生地）→ POST 线上 /api/natal/chart 算真盘
//       → 按 accuracy 格式化 ground-truth 段 → 写 .gg-cache/<pid>/chart-facts.json（供 render 注入 v8 prompt）。
//
// **真实数据原则**：行星座（日期能定）总注入=可信；宫位/上升/精确度数仅 accuracy=exact 才注入
// （无准确出生时间时它们随时间剧变、不可信，明确标未知，强制 LLM 不乱断时间相关）。
//
// 全程 **fail-safe**：非名人星盘文章 / 查不到生日 / API 失败 → 不写文件、exit 0，授稿照常（不阻塞）。
//
// CLI: node gg-chart-inject.mjs --entity "<E>" --keyword "<K>" --page-id <PID> [--product astrologywiki]

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { safeFetch, sanitize } from './lib/gg-shared.mjs';
import { wikipediaUrl } from './lib/entity-passport-sources.mjs';

const CHART_API_BASE = process.env.GG_CHART_API_BASE || 'https://www.astrologywiki.com';
const WIKI_HOSTS = new Set(['en.wikipedia.org']); // safeFetch 的 allowlist 必须是 Set

// 尾部占星后缀（用于从 keyword/entity 剥出实体名）。
const SUFFIX_RE = /\s+(birth chart|natal chart|zodiac sign|star sign|sun sign|horoscope|astrology|birth chart meaning|zodiac)\b.*$/i;
// 非单人星盘的信号（对 / vs / 概念页 / 疑问句 → 不做 chart-inject）。
const NON_PERSON_RE = /\bvs\b|\band\b|world cup|compatibility|synastry|\bhow\b|\bwhat\b|\bwhy\b|guide|meaning of|calculator|生日|运势/i;

// 从 entity(col H) 或 keyword 解析出实体名（人名）。优先干净的 entity。
export function resolvePersonName(entity, keyword) {
  const clean = (s) => String(s || '').replace(SUFFIX_RE, '').replace(/\s+/g, ' ').trim();
  const fromEntity = clean(entity);
  const fromKw = clean(keyword);
  // entity 若是干净的 2-4 词名（无占星词残留）优先；否则用 keyword 剥后。
  const looksName = (s) => s && /^[\p{L}][\p{L}.'’\- ]{1,48}$/u.test(s) && s.split(/\s+/).length <= 4;
  if (looksName(fromEntity)) return fromEntity;
  if (looksName(fromKw)) return fromKw;
  return '';
}

// 是否是"单个名人的 birth chart / zodiac sign"文章（只对这类做 chart-inject）。
export function isPersonBirthChart({ entity, keyword, product }) {
  if (product && product !== 'astrologywiki') return false; // gengrowth 等非占星站不做
  const kw = String(keyword || '');
  if (!/(birth chart|natal chart|zodiac sign|horoscope|star sign|sun sign)/i.test(kw)) return false;
  if (NON_PERSON_RE.test(kw)) return false; // 对/概念/疑问页排除
  return !!resolvePersonName(entity, keyword);
}

// 从 Wikipedia HTML 确定性提取 { date(YYYY-MM-DD), city }。无 bday → null（非真人/消歧页）。
export function extractBirthData(html) {
  const h = String(html || '');
  const bday = (h.match(/<span class="bday">(\d{4}-\d{2}-\d{2})<\/span>/) || [])[1];
  if (!bday) return null;
  let city = null;
  // 格式A：独立 birthplace 单元格（运动员 infobox）
  const m = h.match(/class="[^"]*birthplace[^"]*"[^>]*>(.*?)<\/td>/is);
  if (m) {
    city = m[1].replace(/<sup[^>]*>.*?<\/sup>/gis, '').replace(/<[^>]+>/g, ' ')
      .replace(/&#\d+;|&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
  }
  // 格式B：Born 行 bday 之后的地名链接（人物 infobox）
  if (!city) {
    const i = h.indexOf('bday');
    const chunk = i >= 0 ? h.slice(i, i + 700) : '';
    const links = [...chunk.matchAll(/title="([^"]+)">[^<]+<\/a>/g)].map((x) => x[1])
      .filter((t) => !/birth|age|calendar|century/i.test(t));
    city = links.slice(0, 2).join(', ') || null;
  }
  if (city) city = city.replace(/\s*\(.*?\)\s*/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return { date: bday, city: city || null };
}

// POST 线上 /api/natal/chart 算真盘。失败返回 null（fail-safe）。
export async function fetchNatalChartHeadless({ date, city, accuracy }, deps = {}) {
  const base = deps.apiBase || CHART_API_BASE;
  if (!/^https:\/\//i.test(base)) return null; // https-only（base 是 env 可覆盖，评审 natal-post）
  const fetchImpl = deps.fetch || fetch;
  try {
    const res = await fetchImpl(`${base}/api/natal/chart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, city, accuracy: accuracy || 'time_unknown' }),
      redirect: 'manual', // 不自动跟随跳转(不逐跳重验白名单)→ 3xx 即 !ok → null
      signal: AbortSignal.timeout(deps.timeoutMs || 25000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.chart || data || null;
  } catch { return null; }
}

const SIGN_ZH = { Aries: '白羊', Taurus: '金牛', Gemini: '双子', Cancer: '巨蟹', Leo: '狮子', Virgo: '处女', Libra: '天秤', Scorpio: '天蝎', Sagittarius: '射手', Capricorn: '摩羯', Aquarius: '水瓶', Pisces: '双鱼' };

// 日期能定、与出生时间无关的星体（allowlist，fail-closed）——无准确时间时**只**注入这些；后端返回的
// 其它点(上升/天顶/宫位/East Point 及任何未来新增的角度点)一律不注入（评审 CHART-INJECT-2/FSI-3：
// 旧 ANGLES denylist 是 fail-open，后端改名/新增角度点就会漏进假值）。
const DATE_STABLE_BODIES = new Set(['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto', 'North Node', 'South Node', 'Chiron', 'Ceres', 'Pallas', 'Juno', 'Vesta', 'Lilith', 'Black Moon Lilith']);
// XML 属性转义——city/person/sign 等外部值(Wikipedia 可编辑)直接插入 ground-truth 块，必须转义防属性
// 破出 + 假 placement/指令注入（评审 city-injection）。
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 把真盘格式化成 ground-truth 段（accuracy-aware）。exact 才给宫位/上升/度数/相位。
export function buildChartFactsBlock({ person, birth, facts, sourceUrl }) {
  if (!facts || !Array.isArray(facts.positions) || !facts.positions.length) return '';
  // exact 需**真实出生时间被引擎采用**才生效（评审 F3：API 目前忽略 accuracy、恒用默认时间 → facts.verifiedTime
  // 不存在 → exact 永假 → fail-closed，绝不把默认时间的上升/宫位/度数当 ground-truth）。
  const exact = birth.accuracy === 'exact' && !!facts.verifiedTime;
  const P = esc(person);
  const lines = [];
  lines.push('<chart_facts source="ground-truth ephemeris — AstrologyWiki natal engine">');
  lines.push(`  <!-- 这些是 ${P} 出生盘按出生日期算出的**真实**行星星座（星历引擎，非编造）。撰文只能解读下列真实位置；`);
  lines.push('       严禁虚构未列出的 placement（上升/天顶/宫位/相位）；标 approx 的星体必须留余地、不可当定论。 -->');
  lines.push(`  <subject>${P}</subject>`);
  lines.push(`  <birth date="${esc(birth.date)}"${birth.city ? ` place="${esc(birth.city)}"` : ''} time_accuracy="${esc(birth.accuracy)}"/>`);
  // 无准确时间 → **只**注入日期稳定体（fail-closed allowlist）；上升/天顶/宫位/East Point 及任何角度点一律不注入。
  for (const p of facts.positions) {
    const name = String(p.name || p.planet || '').trim();
    if (!name || !p.sign) continue;
    if (!exact && !DATE_STABLE_BODIES.has(name)) continue;
    const zh = SIGN_ZH[p.sign] || p.sign;
    const deg = exact && (p.degree != null) ? ` degree="${esc(p.degree)}${p.minute != null ? `°${esc(p.minute)}'` : '°'}"` : '';
    const house = exact && p.house ? ` house="${esc(p.house)}"` : '';
    const retro = p.isRetrograde ? ' retrograde="true"' : '';
    // cusp：座内度数 ≤1 或 ≥29 = 近星座边界，无准确时间(默认时间算)其座可能是相邻座（评审 F2：尤其太阳=头条）；
    // 月亮日行 ~13° 亦然。这些标 approx 让 LLM 措辞留余地。
    const degNum = p.degree != null ? Number(p.degree) : null;
    const nearCusp = degNum != null && Number.isFinite(degNum) && (degNum <= 1 || degNum >= 29);
    const approx = !exact && (nearCusp || name === 'Moon') ? ' approx="近星座边界或月亮:无出生时间时座可能是相邻座,须留余地"' : '';
    lines.push(`  <planet name="${esc(name)}" sign="${esc(p.sign)}" sign_zh="${esc(zh)}"${deg}${house}${retro}${approx}/>`);
  }
  if (exact) {
    if (facts.dominance) {
      const e = facts.dominance.elements || {}; const m = facts.dominance.modalities || {};
      lines.push(`  <dominance elements="fire:${esc(e.fire)} earth:${esc(e.earth)} air:${esc(e.air)} water:${esc(e.water)}" modalities="cardinal:${esc(m.cardinal)} fixed:${esc(m.fixed)} mutable:${esc(m.mutable)}"/>`);
    }
    for (const a of (facts.aspects || []).slice(0, 20)) {
      lines.push(`  <aspect between="${esc(a.planet1)}-${esc(a.planet2)}" type="${esc(a.type)}"${a.orb != null ? ` orb="${esc(Number(a.orb).toFixed(1))}"` : ''}/>`);
    }
  } else {
    lines.push('  <unconfirmed reason="birth time not publicly documented">');
    lines.push(`    ${P} 出生时间未公开确认 → **上升(Ascendant)、天顶(MC)、宫位(houses)、时间相关相位一律无法确定，严禁断言**。`);
    lines.push('    行星**星座**通常可靠；但**标 approx 的星体（月亮、近星座边界者）其座可能是相邻座**，撰文须留余地');
    lines.push('    （如"太阳大约在 X 座、若生于当日更早则可能是相邻座"），不可当定论；提及上升/宫位必须写明"需准确出生时间、目前未确认"。');
    lines.push('  </unconfirmed>');
  }
  if (sourceUrl) lines.push(`  <source birth_data="${esc(sourceUrl)}"/>`);
  lines.push('</chart_facts>');
  return lines.join('\n');
}

// Wikipedia summary API 身份校验（评审 F1）：确认非消歧页 + 是真人 bio + 标题含人名的姓，防重名抓错人。
// 拿不到 summary / 不符 → false（保守跳过、不注入）。
export async function verifyIdentity(person, fetchWiki) {
  let summary;
  try { summary = JSON.parse(await fetchWiki(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(person.replace(/\s+/g, '_'))}`)); }
  catch { return false; }
  if (!summary || summary.type === 'disambiguation') return false; // 消歧页 → 跳过
  const desc = String(summary.description || summary.extract || '');
  if (!desc) return false;
  // 像真人 bio：描述含出生年 或 职业/人物词。
  const isPerson = /\b(1[89]\d{2}|20[0-2]\d)\b/.test(desc)
    || /footballer|football|player|actor|actress|singer|musician|rapper|model|athlete|born|director|artist|celebrity|tennis|basketball|politician|author|dancer|presenter|producer|coach|boxer|golfer|swimmer|drummer|guitarist|comedian|host/i.test(desc);
  if (!isPerson) return false;
  // 标题应含人名的姓（最后一词）——重定向到不同主题/消歧时标题不含 → 拒（防抓错人）。
  const title = String(summary.title || '').toLowerCase();
  const lastName = person.toLowerCase().split(/\s+/).pop();
  if (lastName && lastName.length > 2 && !title.includes(lastName)) return false;
  return true;
}

// 编排：解析人名 → 身份校验 → 抓 Wikipedia → 提取生日/地点 → 算真盘 → 返回 { block, meta } 或 null。
export async function computeChartFacts({ entity, keyword, product }, deps = {}) {
  if (!isPersonBirthChart({ entity, keyword, product })) return null;
  const person = resolvePersonName(entity, keyword);
  // 拒单名/裸星座词（评审 F1/FSI-2：重名风险最高，如 "Selena"→Quintanilla 而非 Gomez；"Leo"/"Taurus" 非人）。
  if (!person || person.split(/\s+/).length < 2) return null;
  const fetchWiki = deps.fetchWiki || ((url) => safeFetch(url, WIKI_HOSTS, { timeoutMs: 15000, userAgent: 'gg-chart-inject/1.0 (+https://astrologywiki.com)' }));
  if (!(await verifyIdentity(person, fetchWiki))) return null; // 身份校验（防抓错重名者）
  let html;
  try { html = await fetchWiki(wikipediaUrl(person)); } catch { return null; }
  const birth = extractBirthData(html);
  if (!birth || !birth.date || !birth.city) return null; // 无生日/地点 → 跳过（fail-safe）
  birth.city = sanitize(birth.city); // 中和注入短语/零宽字符（评审 city-injection；XML 转义在 block 内 esc 完成）
  if (!birth.city) return null;
  birth.accuracy = 'time_unknown'; // v1：Wikipedia 罕有准确出生时间 → 保守 time_unknown（座可信、时间相关标未知）
  const facts = await fetchNatalChartHeadless(birth, deps);
  if (!facts) return null;
  const sourceUrl = wikipediaUrl(person);
  const block = buildChartFactsBlock({ person, birth, facts, sourceUrl });
  if (!block) return null;
  return { block, meta: { person, date: birth.date, city: birth.city, accuracy: birth.accuracy, sourceUrl, planets: (block.match(/<planet /g) || []).length } };
}

// ---- CLI ----
async function main() {
  const argv = process.argv.slice(2);
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--entity') o.entity = argv[++i];
    else if (a === '--keyword') o.keyword = argv[++i];
    else if (a === '--page-id') o.pageId = argv[++i];
    else if (a === '--product') o.product = argv[++i];
    else if (a === '--flow-dir') o.flowDir = argv[++i];
  }
  const flowDir = o.flowDir || process.env.GG_FLOW_REPO || process.cwd();
  const pid = o.pageId;
  if (!pid) { console.error('chart-inject: --page-id required'); process.exit(0); } // fail-safe: 不阻塞
  let result = null;
  try { result = await computeChartFacts({ entity: o.entity, keyword: o.keyword, product: o.product || 'astrologywiki' }); }
  catch (e) { console.error(`chart-inject: ${String(e.message || e).slice(0, 120)} — skipping (no injection)`); process.exit(0); }
  if (!result) { console.log(`chart-inject ${pid}: no chart facts (not a person birth-chart, or birth data unavailable) — skipping`); process.exit(0); }
  const dir = join(flowDir, '.gg-cache', pid);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'chart-facts.json'), JSON.stringify(result, null, 2));
    console.log(`chart-inject ${pid}: ✅ ${result.meta.person} ${result.meta.date} (${result.meta.city}, ${result.meta.accuracy}) — ${result.meta.planets} planets injected`);
  } catch (e) { console.error(`chart-inject ${pid}: write failed ${String(e.message).slice(0, 80)} — skipping`); process.exit(0); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
