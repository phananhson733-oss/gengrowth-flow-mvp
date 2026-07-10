// illustrate.mjs — autopilot illustration step (cron-integrated).
//
// Called by gg-seo-autopilot.mjs between convert() and buildGate(): generates a
// context-derived atmospheric hero + 0-3 inline infographics for a freshly
// converted article and wires them into its .ts, IN the publish worktree.
//
// Hard design rule: illustration is BEST-EFFORT ENRICHMENT and must NEVER block
// the text publish. Every failure path degrades gracefully —
//   - LLM planner unavailable/invalid  → deterministic template hero, no inline
//   - gemini session dead / hero fails  → publish text (+inline) with NO hero,
//                                          mark needs_hero, set a session cooldown
//   - hero looks like a diptych         → regenerate once; if still suspect, KEEP
//                                          the hero and log a warn (never auto-strip
//                                          a good central-subject hero)
//   - any unexpected throw              → caught by the caller; text still ships
//
// Decisions recorded in docs/spec/G-GenGrowth-illustration-cron-integration-PROPOSAL-2026-06-10.md.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const BASE_STYLE = 'deep indigo-to-near-black palette (#16112c fading to #0b0a1b), soft gold accents (#d4af6a), teal-and-gold nebula wash, painterly editorial illustration, full-bleed wide 16:9 composition that fills the entire frame, ONE single continuous scene, no split screen, no diptych, no two panels, no diagram, no chart wheel, no central framed card, no text or letters or numerals';
const ABSTRACT_STYLE = `${BASE_STYLE}, no human faces`;

const IMAGES_SUBDIR = 'public/images/blog';   // single dir for cron-generated assets
const URL_BASE = '/images/blog';

function geminiSkillPath() {
  // Same skill the manual backfill used; overridable for the keyed fallback.
  return process.env.GG_GEMINI_SKILL
    || join(process.env.HOME, '.openclaw', 'workspace', 'skills', 'baoyu-danger-gemini-web', 'scripts', 'main.ts');
}

export function classifyHeroTheme({ slug = '', title = '', content = '' } = {}) {
  const text = `${slug} ${title} ${content}`.toLowerCase();
  const relationship = /\b(wedding|synastry|compatibility|relationship|couple|girlfriend|boyfriend|marriage)\b/.test(text)
    || /-[a-z]+-and-[a-z]+-/.test(`-${slug}-`);
  if (relationship) return 'relationship-scene';

  const sports = /\b(world cup|football|soccer|national team|matchup|fixture|tournament)\b/.test(text)
    || (/\b(vs|versus)\b/.test(text) && /\b(country|nation|team|cup|football|soccer|argentina|brazil|portugal|colombia|jordan|scotland|norway|england|morocco|egypt)\b/.test(text));
  if (sports) return 'sports-matchup';

  if (/\b(birth chart|birth-chart|zodiac sign|zodiac-sign)\b/.test(text)) return 'celebrity-portrait';
  if (/\b(country|nation|national|pluto return|eclipse|astrology calendar)\b/.test(text)) return 'country-astrology';
  return 'abstract-atmospheric';
}

export function buildHeroPlanningRules() {
  return [
    `Before writing hero.prompt, classify the article into exactly one hero theme:`,
    `- celebrity-portrait: named-person birth chart or zodiac-sign articles. Use a stylized editorial portrait or character-study scene inspired by the public figure, with recognizable career/context cues, non-photoreal, not a literal photo. Do not include "no human faces".`,
    `- relationship-scene: wedding, synastry, compatibility, dating, or named-couple articles. Use two stylized figures and relationship geometry in one continuous scene, not a split-screen comparison.`,
    `- sports-matchup: football/soccer, World Cup, country-vs-country, or national-team matchup articles. Use a stadium or pitch scene with two teams/countries expressed through color, motion, banners without text, and celestial tension.`,
    `- country-astrology: clear country, national event, eclipse, or calendar themes. Use a concrete symbolic national/event scene, not a generic nebula.`,
    `- abstract-atmospheric: only use abstract-atmospheric when the article has no concrete person, couple, country, event, or matchup.`,
    `For every non-abstract theme, keep the specific subject matter visible. Never collapse a clear subject into a generic celestial landscape.`,
    `House style base clause for non-abstract themes: "${BASE_STYLE}"`,
    `House style clause for abstract-atmospheric only: "${ABSTRACT_STYLE}"`,
  ].join('\n');
}

export function buildTemplateHeroPrompt({ title, slug = '', content = '' }) {
  const theme = classifyHeroTheme({ slug, title, content });
  if (theme === 'celebrity-portrait') {
    return `A stylized editorial portrait inspired by "${title}": a public figure rendered as an elegant non-photoreal character study, subtle career and era cues woven into clothing, posture, and background symbols, soft celestial light shaping the face and shoulders without imitating a photograph, ${BASE_STYLE}`;
  }
  if (theme === 'relationship-scene') {
    return `A cinematic relationship astrology scene evoking "${title}": two stylized figures sharing one continuous environment, warm and cool celestial currents meeting between them, subtle wedding or compatibility symbolism integrated into the landscape, ${BASE_STYLE}`;
  }
  if (theme === 'sports-matchup') {
    return `A cinematic football astrology scene evoking "${title}": a night stadium and pitch under a charged sky, two countries or teams expressed through opposing color currents and motion, distant athletic silhouettes and banners without readable text, ${BASE_STYLE}`;
  }
  if (theme === 'country-astrology') {
    return `A concrete editorial astrology scene evoking "${title}": a symbolic national or event landscape under a vast night sky, recognizable civic or seasonal motifs transformed into celestial light, ${BASE_STYLE}`;
  }
  return `An atmospheric painterly editorial scene evoking the theme of "${title}": a serene natural landscape — a still lake, open plain, or misty horizon — under a vast night sky, the subject suggested through soft glowing celestial forms woven into the scene, ${ABSTRACT_STYLE}`;
}

// ── session cooldown (avoid burning ~90s/tick re-trying a dead Google session) ──
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
    `  "optimize": { "heroWidth": 1200, "heroHeight": 675, "quality": 82 },`,
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
    `Derive a UNIQUE visual idea from what THIS article argues. For clear person/couple/matchup/event topics, keep that subject visible in the scene. Never a chart wheel, never a centred diagram/emblem, never text.`,
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
    geminiSkill: geminiSkillPath(), optimize: { heroWidth: 1200, heroHeight: 675, quality: 82 },
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

    // 3. hero + wiring. Skip the gemini call if we're in a session cooldown — but
    //    STILL wire inline (no network needed) by running with a hero-less plan.
    const attemptHero = !sessionCooled;
    if (!attemptHero) log('illustrate: gemini session in cooldown → inline-only, hero deferred');
    const planForRun = attemptHero ? plan : stripHero(plan, slug);
    if (!attemptHero) writeFileSync(planAbs, JSON.stringify(planForRun, null, 2) + '\n');

    try { run('node', [ILL, '--plan', planRel, '--slug', slug]); }
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
        try { run('node', [ILL, '--plan', planRel, '--slug', slug]); } catch { /* keep prior */ }
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
