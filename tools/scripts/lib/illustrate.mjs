// illustrate.mjs — autopilot illustration step (cron-integrated).
//
// Called by gg-seo-autopilot.mjs between convert() and buildGate(): generates a
// context-derived atmospheric hero + 0-3 inline infographics for a freshly
// converted article and wires them into its .ts, IN the publish worktree.
//
// Hard design rule: illustration is BEST-EFFORT ENRICHMENT and must NEVER block
// the text publish. Every failure path degrades gracefully —
//   - LLM planner unavailable/invalid  → deterministic template hero, no inline
//   - hero provider dead / hero fails   → publish text (+inline) with NO hero,
//                                          mark needs_hero, set a provider cooldown
//   - hero looks like a diptych         → regenerate once; if still suspect, KEEP
//                                          the hero and log a warn (never auto-strip
//                                          a good central-subject hero)
//   - any unexpected throw              → caught by the caller; text still ships
//
// Decisions recorded in docs/spec/G-GenGrowth-illustration-cron-integration-PROPOSAL-2026-06-10.md.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// KEEP THIS SHORT. FLUX conditions on CLIP (hard 77-token limit) as well as T5, and
// the 2026-07-29 batch showed the old 63-word clause pushing the whole style tail —
// including the no-text rule — past that window: `mflux`/diffusers both logged
// "input was truncated because CLIP can only handle sequences up to 77 tokens", and
// two heroes came back carrying invented watermark signatures despite the clause
// nominally forbidding text. A scene description runs ~35 words, so the style tail
// has roughly 20 to spend. Anything longer only reaches T5 and is silently dropped
// from the stronger conditioning path. Hex codes are especially expensive — each one
// tokenizes character by character — so the palette is named, not spelled out.
const BASE_STYLE = 'painterly editorial illustration, deep indigo and near-black with soft gold accents, wide 16:9, one continuous scene, no text, no watermark';
const ABSTRACT_STYLE = `${BASE_STYLE}, no human faces`;

const IMAGES_SUBDIR = 'public/images/blog';   // single dir for cron-generated assets
const URL_BASE = '/images/blog';
const HERO_OPTIMIZE = { heroWidth: 1200, heroHeight: 675, quality: 82 };
const SEARCH_IMAGE_VARIANTS = [
  { label: 'social og:image', width: 1200, height: 630, path: 'public/og/articles/<slug>.png' },
  { label: 'Article JSON-LD square', width: 1200, height: 1200, path: 'public/og/articles/<slug>.1x1.png' },
  { label: 'Article JSON-LD 4:3', width: 1200, height: 900, path: 'public/og/articles/<slug>.4x3.png' },
];

function geminiSkillPath() {
  // Same skill the manual backfill used; overridable for the keyed fallback.
  return process.env.GG_GEMINI_SKILL
    || join(process.env.HOME, '.openclaw', 'workspace', 'skills', 'baoyu-danger-gemini-web', 'scripts', 'main.ts');
}

export function buildIllustrationRunEnv({ env = process.env, exists = existsSync } = {}) {
  const home = env.HOME || process.env.HOME || '';
  const hermesAgentDir = env.GG_HERMES_AGENT_DIR || (home ? join(home, 'hermes-agent') : 'hermes-agent');
  const hermesVenvPython = join(hermesAgentDir, '.venv', 'bin', 'python');
  return {
    ...env,
    GG_HERO_PROVIDER: env.GG_HERO_PROVIDER || 'hermes-image2',
    GG_HERMES_AGENT_DIR: hermesAgentDir,
    GG_HERMES_PYTHON: env.GG_HERMES_PYTHON || (exists(hermesVenvPython) ? hermesVenvPython : 'python3'),
  };
}

export function classifyHeroTheme({ slug = '', title = '', content = '' } = {}) {
  const text = `${slug} ${title} ${content}`.toLowerCase();

  // Typology crossovers (MBTI / enneagram × sign) have NO person in them, but they
  // do contain "zodiac sign", which the celebrity-portrait catch-all near the bottom
  // used to swallow — so "INTP zodiac sign" was being drawn as a public-figure
  // portrait. The 执行表 v2 calendar has ~40 more of these queued, so they get their
  // own theme rather than a per-article workaround.
  //
  // Matched on slug+title ONLY, never body prose: a typology crossover always names
  // the type up front, while an unrelated article can mention "personality type" once
  // in passing — which is exactly how the Wanda Maximoff page first landed here.
  const heading = `${slug} ${title}`.toLowerCase();
  if (/\b(mbti|myers[- ]briggs|enneagram|cognitive function|personality type)\b/.test(heading)
      || /\b(intj|intp|entj|entp|infj|infp|enfj|enfp|istj|isfj|estj|esfj|istp|isfp|estp|esfp)\b/.test(heading)) {
    return 'typology-concept';
  }

  // A multi-member group roster is neither one portrait nor a couple. Sits above the
  // relationship rule so "BTS compatibility zodiac" reads as a 7-member group, not a
  // two-person romance scene.
  const groupNamed = /\b(bts|blackpink|seventeen|ive|stray kids|aespa|newjeans|twice|itzy|le sserafim|exo|nct|k-pop|kpop)\b/.test(text);
  const rosterShape = /\bmembers['’]?\s*zodiac\b|\bmember zodiac\b|\bgroup (members|roster|lineup)\b|\b(band|group) members\b/.test(text);
  if (groupNamed && (rosterShape || /\bzodiac signs?\b|\bcompatibilit/.test(text))) return 'group-roster';

  const relationship = /\b(wedding|synastry|compatibility|relationship|couple|girlfriend|boyfriend|marriage)\b/.test(text)
    || /-[a-z]+-and-[a-z]+-/.test(`-${slug}-`);
  if (relationship) return 'relationship-scene';

  const sports = /\b(world cup|football|soccer|national team|matchup|fixture|tournament)\b/.test(text)
    || (/\b(vs|versus)\b/.test(text) && /\b(country|nation|team|cup|football|soccer|argentina|brazil|portugal|colombia|jordan|scotland|norway|england|morocco|egypt)\b/.test(text));
  if (sports) return 'sports-matchup';

  // Named fictional/mythological figures are fictional-character-scene, not celebrity
  // portraits. Without these, "Thor zodiac sign" fell through to celebrity-portrait
  // and would have been drawn as a real public figure consulting a natal chart. The
  // named IPs are the ones the 执行表 v2 实验八 calendar actually schedules.
  const fictionalCharacter = /\b(harry potter|hogwarts|wizarding world|fictional characters?|character zodiac|character astrology|novel characters?|film characters?|tv characters?|anime characters?|game characters?)\b/.test(text)
    || /\bmarvel\s+(characters?|comics?|cinematic|universe|heroes)\b|\bmcu\b|\bdc comics\b|\bsuperhero\b|\bavengers\b/.test(text)
    || /\b(wanda maximoff|scarlet witch|tony stark|iron man|spider[- ]man|peter parker|black widow|natasha romanoff|steve rogers|captain america|bruce banner|loki|thor|jon snow|eleven|eren yeager|tanjiro|gojo satoru|naruto uzumaki|deku|severus snape|dumbledore|hermione granger|draco malfoy)\b/.test(text)
    || /\b(stranger things|bridgerton|game of thrones|demon slayer|jujutsu kaisen|attack on titan|my hero academia|naruto|friends characters|disney princess)\b/.test(text);
  if (fictionalCharacter) return 'fictional-character-scene';

  if (/\b(birth chart|birth-chart|zodiac sign|zodiac-sign)\b/.test(text)) return 'celebrity-portrait';
  if (/\b(country|nation|national|pluto return|eclipse|astrology calendar)\b/.test(text)) return 'country-astrology';
  return 'abstract-atmospheric';
}

function isBirthChartTopic({ slug = '', title = '', content = '' } = {}) {
  return /\b(birth chart|birth-chart|natal chart|natal-chart)\b/i.test(`${slug} ${title} ${content}`);
}

export function buildHeroPlanningRules() {
  return [
    `Before writing hero.prompt, classify the article into exactly one hero theme:`,
    `- celebrity-portrait: named-person birth-chart or zodiac-sign articles. Use a stylized editorial portrait or character-study scene with recognizable career/context cues, non-photoreal, and never a literal photo or celebrity likeness. For birth-chart articles, show an original person plus an unlabeled circular natal chart in a physical chart-reading action (holding, comparing, or studying it) inside that career/context setting; it is not a standalone diagram. Do not include "no human faces".`,
    `- relationship-scene: wedding, synastry, compatibility, dating, or named-couple articles. Use two stylized figures and relationship geometry in one continuous scene, not a split-screen comparison.`,
    `- sports-matchup: football/soccer, World Cup, country-vs-country, or national-team matchup articles. Use a stadium or pitch scene with two teams/countries expressed through color, motion, banners without text, and celestial tension.`,
    `- country-astrology: clear country, national event, eclipse, or calendar themes. Use a concrete symbolic national/event scene, not a generic nebula.`,
    `- fictional-character-scene: fictional IP, novel, film, television, anime, comic, or mythological character articles — including named figures such as Thor, Wanda Maximoff, or Severus Snape. Use a non-actor, non-photoreal role-based ensemble in a concrete story setting; express the article's character archetypes without copying actor likenesses or relying on generic celestial scenery.`,
    `- typology-concept: MBTI / Myers-Briggs / enneagram / cognitive-function crossovers with a sign. These have NO person in them — do not draw a portrait. Show the two symbolic systems side by side as complementary diagrams in one composition, no faces, no readable text.`,
    `- group-roster: a named band or idol group's member zodiac signs, or that group's internal compatibility. Draw the whole line-up as distinct original archetypes with different silhouettes and color accents — not one portrait, and not a two-person romance scene.`,
    `- abstract-atmospheric: only use abstract-atmospheric when the article has no concrete person, character/IP, couple, country, event, or matchup.`,
    `For every non-abstract theme, keep the specific subject matter visible. Never collapse a clear subject into a generic celestial landscape.`,
    `Keep celestial motifs only as subordinate texture: a zodiac wheel or star field belongs small and off to one side, never centred and never the largest element in the frame. This rule lives here rather than in the style clause because the style clause has to stay inside the image model's CLIP token budget.`,
    `Never write a member or character COUNT into the prompt and expect it to hold — image models do not count. When an article covers a whole group, prefer a people-free staged still life (one prop per member) over a crowd.`,
    `Before composing a hero prompt, extract four visual facts from the article Brief and converted content: the subject, key relationship, concrete setting, and reader task. Make each visible in the single-scene composition.`,
    `Use the article Brief and converted article content as the source of truth for prompt design; do not reuse a generic abstract prompt when the Brief names a concrete person, character/IP, couple, country, match, event, product, or comparison.`,
    `House style base clause for non-abstract themes: "${BASE_STYLE}"`,
    `House style clause for abstract-atmospheric only: "${ABSTRACT_STYLE}"`,
  ].join('\n');
}

export function buildHeroImageSizingRules() {
  return [
    `Hero image size contract: generate and wire the article hero as ${HERO_OPTIMIZE.heroWidth} x ${HERO_OPTIMIZE.heroHeight} (16:9), JPEG quality ${HERO_OPTIMIZE.quality}.`,
    `Search/social image contract is handled by oracle build: keep og:image wide at ${SEARCH_IMAGE_VARIANTS[0].width} x ${SEARCH_IMAGE_VARIANTS[0].height}, and expose Article JSON-LD image variants at ${SEARCH_IMAGE_VARIANTS[1].width} x ${SEARCH_IMAGE_VARIANTS[1].height} plus ${SEARCH_IMAGE_VARIANTS[2].width} x ${SEARCH_IMAGE_VARIANTS[2].height}.`,
    `Compose hero prompts with square-crop safety: place the main subject inside the central safe area so Google's square preview does not cut away the face, couple, team/matchup, or key symbol.`,
  ].join('\n');
}

export function buildTemplateHeroPrompt({ title, slug = '', content = '' }) {
  const theme = classifyHeroTheme({ slug, title, content });
  if (theme === 'typology-concept') {
    return `Desk scene for "${title}": anonymous hands sort four paired brass markers beside an unlabeled circular zodiac wheel, no faces, ${BASE_STYLE}`;
  }
  if (theme === 'group-roster') {
    // Deliberately PEOPLE-FREE. Three rounds of crowd prompts on 2026-07-29 failed the
    // same way every time: the model cannot hold a member count (six members came back
    // as forty), it defaults to backlit silhouettes seen from behind however explicitly
    // you forbid it, and on the Marvel roster it painted recognizable DC chest emblems
    // straight after being told "no recognizable emblems". A staged still life carries
    // the same "here is a group" reading with none of the count, likeness, or trademark
    // risk — and the first still-life attempt landed the member count correctly, because
    // objects are countable in a way crowds are not.
    return `Empty rehearsal space for "${title}": one prop per member in a row, microphone stands or lit mirrors, a small zodiac wheel to one side, no people, ${BASE_STYLE}`;
  }
  if (theme === 'celebrity-portrait') {
    if (isBirthChartTopic({ title, slug, content })) {
      return `Editorial portrait for "${title}": an original non-photoreal figure in their working setting studies an unlabeled circular natal chart and a plain birth-data card, no celebrity likeness, ${BASE_STYLE}`;
    }
    return `Editorial portrait for "${title}": an original non-photoreal character study, career and era cues in the clothing and setting, no celebrity likeness, ${BASE_STYLE}`;
  }
  if (theme === 'relationship-scene') {
    return `Relationship scene for "${title}": two stylized figures in one shared environment, warm and cool currents meeting between them, ${BASE_STYLE}`;
  }
  if (theme === 'sports-matchup') {
    return `Night stadium scene for "${title}": two teams expressed through opposing colour currents across the pitch, banners without text, ${BASE_STYLE}`;
  }
  if (theme === 'country-astrology') {
    return `Editorial scene for "${title}": a symbolic national or seasonal landscape under a night sky, civic motifs in celestial light, ${BASE_STYLE}`;
  }
  if (theme === 'fictional-character-scene') {
    return `Story scene for "${title}": original non-actor character archetypes in a concrete setting from the narrative, invented costumes only, no real emblems or actor likeness, ${BASE_STYLE}`;
  }
  return `Atmospheric scene for "${title}": a still lake, open plain, or misty horizon under a night sky, the theme suggested in soft glowing forms, ${ABSTRACT_STYLE}`;
}

// ── provider cooldown (avoid burning time re-trying a dead image provider) ──
function cooldownPath(flowDir) { return join(flowDir, '.gg-cache', 'illustrate-cooldown.json'); }
function inCooldown(flowDir, now) {
  try {
    const c = JSON.parse(readFileSync(cooldownPath(flowDir), 'utf8'));
    return c.until && now < c.until;
  } catch { return false; }
}
function setCooldown(flowDir, now, mins = 60) {
  try {
    mkdirSync(join(flowDir, '.gg-cache'), { recursive: true });
    writeFileSync(cooldownPath(flowDir), JSON.stringify({ until: now + mins * 60000, set_at: now }));
  } catch { /* best-effort */ }
}
function clearCooldown(flowDir) { try { rmSync(cooldownPath(flowDir), { force: true }); } catch { /* noop */ } }

// ── planning ────────────────────────────────────────────────────────────────
function planPromptFor(repo, slug) {
  const artRel = `data/articles/${slug}.ts`;
  const planRel = `scripts/plans/auto-${slug}.json`;
  const planAbs = join(repo, planRel);
  return [
    `You are the illustration planner for ONE astrologywiki.com blog article. This is an automated subtask — ignore any repo CLAUDE.md conversation-record/reminder rules; only do what is described here.`,
    ``,
    `Read the article: ${join(repo, artRel)} (it has an En export and maybe a Zh export; the \`content\` field holds markdown). Understand its core concept.`,
    ``,
    `Then WRITE a JSON plan to ${join(repo, planRel)} with EXACTLY this shape:`,
    `{`,
    `  "imagesDir": "${IMAGES_SUBDIR}",`,
    `  "urlBase": "${URL_BASE}",`,
    `  "articlesDir": "data/articles",`,
    `  "geminiSkill": ${JSON.stringify(geminiSkillPath())},`,
    `  "optimize": ${JSON.stringify(HERO_OPTIMIZE)},`,
    `  "articles": { "${slug}": { "hero": {...}, "inline": [...] } }`,
    `}`,
    `The article object holds (EN-only since 2026-07-03 — do NOT emit any *Zh keys):`,
    `- "hero": { "prompt": <topic-specific hero prompt string>, "altEn": <=140 char string }`,
    `- "inline": an array of 0 to 3 objects, ONLY where a data-bearing section warrants it. Each object:`,
    `  - common keys: "kind" (one of "sequence","compare","timeline"), "afterHeadingEn" (verbatim EN "## " H2 heading), "titleEn", "altEn"`,
    `  - kind "sequence": add "items": array of 3-7 objects {"nameEn","subEn"}`,
    `  - kind "compare":  add "columns": array of 2-3 objects {"nameEn","linesEn":[strings]}`,
    `  - kind "timeline": add "items": array of 3-6 objects {"labelEn","titleEn","noteEn"}`,
    ``,
    `STRICT JSON: double-quoted keys/strings, NO comments, NO trailing commas, NO code fences.`,
    ``,
    `HERO PROMPT RULES — the hero must match the article's concrete subject and the site's house style:`,
    buildHeroPlanningRules(),
    buildHeroImageSizingRules(),
    `Derive a UNIQUE visual idea from what THIS article argues. For clear person/couple/matchup/event topics, keep that subject visible in the scene. For a named-person birth-chart article, the person must physically read, hold, or compare an unlabeled circular natal chart within a concrete role-specific setting; it is not a standalone diagram. Never use a centred diagram/emblem or text.`,
    ``,
    `INLINE RULES — include inline ONLY for genuinely data-bearing sections (an enumeration, a comparison, a time-ordered process). Definition/short articles often need 0-1; pillar/guide 2-3. ALL data (names, years, orderings) MUST be faithfully extracted from the article text. afterHeadingEn MUST be a verbatim "## " H2 heading line that exists in the EN content — VERIFY each with: grep -nF '## <heading>' ${join(repo, artRel)}. Drop any anchor you cannot verify.`,
    ``,
    `BEFORE FINISHING (mandatory): run  node -e "JSON.parse(require('fs').readFileSync('${planAbs}','utf8'))"  and if it errors, fix ${planRel} until it parses cleanly. The file MUST be valid JSON.`,
    `Write ONLY the JSON file. Output one final line: DONE.`,
  ].join('\n');
}

function templatePlan(repo, slug) {
  // Deterministic fallback when the LLM planner is unavailable/invalid: a single
  // atmospheric hero derived from the article title, no inline.
  let title = slug.replace(/-/g, ' ');
  let content = '';
  try {
    const ts = readFileSync(join(repo, `data/articles/${slug}.ts`), 'utf8');
    const m = ts.match(/title:\s*['"]([^'"]+)['"]/);
    if (m) title = m[1];
    const cm = ts.match(/content:\s*`([\s\S]*?)`/);
    if (cm) content = cm[1].slice(0, 1200);
  } catch { /* use slug */ }
  return {
    imagesDir: IMAGES_SUBDIR, urlBase: URL_BASE, articlesDir: 'data/articles',
    geminiSkill: geminiSkillPath(), optimize: { ...HERO_OPTIMIZE },
    articles: { [slug]: { hero: {
      prompt: buildTemplateHeroPrompt({ title, slug, content }),
      altEn: `An atmospheric celestial landscape evoking ${title}.`,
    } } },
  };
}

function validatePlan(plan, repo, slug, log) {
  const a = plan?.articles?.[slug];
  if (!a || !a.hero || !a.hero.prompt || a.hero.prompt.length < 60) return false;
  // Drop any inline whose anchor isn't verbatim-present (keeps wiring from throwing).
  if (Array.isArray(a.inline)) {
    let src = '';
    try { src = readFileSync(join(repo, `data/articles/${slug}.ts`), 'utf8'); } catch { return false; }
    const hasZh = /export const \w+Zh\s*:/.test(src);
    a.inline = a.inline.filter((ins) => {
      if (!ins || !['sequence', 'compare', 'timeline'].includes(ins.kind)) return false;
      if (!ins.afterHeadingEn || !src.includes(ins.afterHeadingEn + '\n')) return false;
      if (ins.afterHeadingZh && (!hasZh || !src.includes(ins.afterHeadingZh + '\n'))) delete ins.afterHeadingZh;
      return true;
    }).slice(0, 3);
  } else { a.inline = []; }
  return true;
}

// ── main ──────────────────────────────────────────────────────────────────--
// opts: { repo, slug, flowDir, log, sh, now, dryGen }
// returns { hero: bool, inline: int, needsHero: bool, qaWarn: bool, note: string }
export function illustrate(opts) {
  const { repo, slug, flowDir, log = () => {}, now = Date.now() } = opts;
  const result = { hero: false, inline: 0, needsHero: false, qaWarn: false, note: '' };
  if (process.env.GG_AUTOPILOT_ILLUSTRATE === '0') { result.note = 'disabled'; return result; }

  const run = (cmd, args, o = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: repo, ...o });
  const illustrationEnv = buildIllustrationRunEnv();
  const planAbs = join(repo, `scripts/plans/auto-${slug}.json`);
  const planRel = `scripts/plans/auto-${slug}.json`;
  const ILL = join(repo, 'scripts', 'illustrate-article.mjs');
  const GEN = join(repo, 'scripts', 'gen-infographic.mjs');
  const QA = join(flowDir, 'tools', 'scripts', 'gg-hero-qa.mjs');
  const heroJpg = join(repo, IMAGES_SUBDIR, `${slug}.jpg`);

  try {
    if (!existsSync(ILL)) { result.note = 'illustrate-article.mjs absent in worktree'; return result; }

    // 1. plan — LLM agentic planner, with deterministic template fallback.
    let plan = null;
    const sessionCooled = inCooldown(flowDir, now);
    if (process.env.GG_ILLUSTRATE_LLM_PLAN !== '0') {
      try {
        const model = process.env.GG_ILLUSTRATE_MODEL || 'claude-sonnet-4-6';
        const tmo = parseInt(process.env.GG_ILLUSTRATE_PLAN_TIMEOUT_MS || '600000', 10);
        run('claude', ['-p', planPromptFor(repo, slug), '--model', model,
          '--allowedTools', 'Bash Read Write Grep', '--dangerously-skip-permissions'], { timeout: tmo });
        if (existsSync(planAbs)) plan = parseLoose(readFileSync(planAbs, 'utf8'));
      } catch (e) { log(`illustrate: LLM plan failed (${String(e.message).slice(0, 80)}) → template`); }
    }
    if (!plan || !validatePlan(plan, repo, slug, log)) {
      plan = templatePlan(repo, slug);
      log('illustrate: using template hero (no inline)');
    }
    writeFileSync(planAbs, JSON.stringify(plan, null, 2) + '\n');
    const wantInline = (plan.articles[slug].inline || []).length;

    // 2. inline SVGs (deterministic, no network) — always safe to generate.
    if (wantInline > 0) {
      try { run('node', [GEN, '--plan', planRel, '--slug', slug]); }
      catch (e) { log(`illustrate: gen-infographic failed (${String(e.message).slice(0, 80)})`); }
    }

    // 3. hero + wiring. Skip the hero provider call if we're in a session cooldown — but
    //    STILL wire inline (no network needed) by running with a hero-less plan.
    const attemptHero = !sessionCooled;
    if (!attemptHero) log('illustrate: hero provider in cooldown → inline-only, hero deferred');
    const planForRun = attemptHero ? plan : stripHero(plan, slug);
    if (!attemptHero) writeFileSync(planAbs, JSON.stringify(planForRun, null, 2) + '\n');

    try { run('node', [ILL, '--plan', planRel, '--slug', slug], { env: illustrationEnv }); }
    catch (e) { log(`illustrate: illustrate-article exit nonzero (${String(e.message).slice(0, 80)})`); }

    // did inline wire?
    result.inline = countWiredInline(repo, slug);

    // 4. hero QA + fallback policy
    if (attemptHero) {
      const heroOk = existsSync(heroJpg) && statSync(heroJpg).size > 20000;
      if (!heroOk) {
        // generation failed → no hero, defer, cooldown the session.
        stripHeroFromTs(repo, slug);
        setCooldown(flowDir, now);
        result.needsHero = true;
        result.note = 'hero generation failed → text+inline only, needs_hero, session cooldown';
        log(`illustrate: ${result.note}`);
        return result;
      }
      clearCooldown(flowDir);
      const qa = heroQa(QA, repo, heroJpg, log);
      if (qa.ok) { result.hero = true; }
      else {
        // seam-suspect → regenerate hero ONCE, re-QA. Never auto-strip a hero that
        // exists & is the right size: a persistent "seam" is most likely a central
        // subject (false positive), so keep it and flag for human review.
        log(`illustrate: hero QA flagged (${qa.reason}) → regenerating once`);
        try { run('node', [ILL, '--plan', planRel, '--slug', slug], { env: illustrationEnv }); } catch { /* keep prior */ }
        const qa2 = (existsSync(heroJpg) && statSync(heroJpg).size > 20000) ? heroQa(QA, repo, heroJpg, log) : { ok: false, reason: 'gone' };
        result.hero = existsSync(heroJpg) && statSync(heroJpg).size > 20000;
        result.qaWarn = !qa2.ok;
        result.note = qa2.ok ? 'hero regenerated, QA clean' : `hero kept with QA warn: ${qa2.reason}`;
        log(`illustrate: ${result.note}`);
      }
    } else {
      result.needsHero = true;
      result.note = 'session cooldown — inline only, hero deferred';
    }
    return result;
  } catch (e) {
    // Absolute backstop: never let illustration throw into the publish path.
    result.note = `illustrate caught: ${String(e.message).slice(0, 120)}`;
    log(`illustrate: ${result.note}`);
    return result;
  }
}

// Tolerant parse: strip code fences and trailing commas the LLM sometimes emits,
// then JSON.parse. Returns null if still unparseable (→ template fallback).
function parseLoose(raw) {
  try { return JSON.parse(raw); } catch { /* try to clean */ }
  try {
    let s = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    s = s.replace(/,(\s*[}\]])/g, '$1'); // trailing commas
    return JSON.parse(s);
  } catch { return null; }
}

function stripHero(plan, slug) {
  const p = JSON.parse(JSON.stringify(plan));
  if (p.articles?.[slug]) delete p.articles[slug].hero;
  return p;
}
function stripHeroFromTs(repo, slug) {
  try {
    const f = join(repo, `data/articles/${slug}.ts`);
    let src = readFileSync(f, 'utf8');
    src = src.replace(/\n  image: ['"][^'"]*['"],(\n  image_alt: [^\n]*,)?/g, '');
    writeFileSync(f, src);
  } catch { /* best-effort */ }
}
function countWiredInline(repo, slug) {
  try {
    const src = readFileSync(join(repo, `data/articles/${slug}.ts`), 'utf8');
    const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return (src.match(new RegExp(`${URL_BASE}/${esc}-i\\d+-en\\.svg`, 'g')) || []).length;
  } catch { return 0; }
}
function heroQa(QA, repo, heroJpg, log) {
  try {
    const out = execFileSync('node', [QA, heroJpg, '--json'],
      { encoding: 'utf8', env: { ...process.env, GG_SHARP_BASE: repo }, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out);
  } catch (e) {
    // gg-hero-qa exits 1 on fail with JSON on stdout; execFileSync throws — parse it.
    try { return JSON.parse(e.stdout || '{}'); } catch { log(`illustrate: QA unparseable (${String(e.message).slice(0, 60)})`); return { ok: true, reason: 'qa-skipped' }; }
  }
}
