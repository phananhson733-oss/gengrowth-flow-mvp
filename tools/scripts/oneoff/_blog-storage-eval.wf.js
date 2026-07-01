export const meta = {
  name: 'gengrowth-blog-storage-eval',
  description: 'Evaluate gengrowth.ai blog content storage: keep Supabase vs file-based MDX vs hybrid git-source (multi-lens judge panel + synthesis)',
  phases: [
    { title: 'Lenses', detail: '4 independent lenses each score 3 options, grounded in the real codebases' },
    { title: 'Synthesis', detail: 'one agent synthesizes a scored recommendation + migration path' },
  ],
}

const FACTS = `GROUND TRUTH (verified this session — do not re-derive, but you MAY read the cited files for depth):

gengrowth.ai = gengrowth-agents repo, Next.js 16.1.6 + React 19, app router.
- Blog renders SERVER-SIDE: src/app/[locale]/blog/[slug]/page.tsx (no generateStaticParams / no export const revalidate -> dynamic SSR per request). Has generateMetadata + JSON-LD server-rendered, so SEO HTML is fully present at response time.
- Data layer src/lib/blog.ts queries Supabase table blog_posts: select all, eq status published, eq locale, order published_at. UNIQUE(slug,locale). Has a mock-data fallback.
- CONTENT IS STORED AS SANITIZED HTML in the DB row. Pipeline: flow-mvp produces phase2-validated markdown (_staging/<pid>-<tag>.md, transient/gitignored) -> scripts/import-flow-md-to-blog.ts does marked.parse -> sanitizeHtml -> INSERT/PATCH via PostgREST with service_role. ~21 posts live.
- The markdown SOURCE does NOT live in the gengrowth-agents git repo — only the rendered HTML in Supabase. Editing a published post = a DB UPDATE (--update-published flag), not a git commit. No git diff/blame/PR-review/rollback of content.

astrologywiki.com = oracle repo, React + Vite SPA (NOT Next.js).
- Content = git-tracked TypeScript: data/articles/<slug>.ts (WikiArticle objects, EN+ZH dual-export). 145 .ts files tracked.
- SEO via BUILD-TIME static stub generation: scripts/generate-seo-pages.mjs iterates a HARDCODED ARTICLE_SLUGS array -> writes public/{en,zh}/wiki/<slug>/index.html (205 committed stubs) + sitemap.xml. Deploy = git push origin main -> Vercel build regenerates stubs.
- KEY: this stub-generation + .ts-in-git is PARTLY A WORKAROUND for being a SPA — a SPA cannot server-render, so it must pre-bake static HTML for crawlers. Next.js does NOT have this constraint (it SSRs/SSGs natively). So astrologywiki model is not automatically better; some of it is SPA-specific scaffolding.

BOTH sites content come from the SAME flow-mvp markdown pipeline (phase2-validated .md). The user finds the gengrowth Supabase-HTML model weird and asks whether to adopt the astrologywiki model.

THE THREE OPTIONS TO SCORE (1-10 each, 10=best for your lens):
A. KEEP SUPABASE — DB stays both source-of-truth and serving layer (status quo).
B. FULL FILE-BASED — markdown/MDX files committed in the repo (or a content repo), rendered via Next.js native MDX/SSG (contentlayer / next-mdx-remote / app-router fs), drop Supabase for the blog. (Next-native analogue of astrologywiki, NOT the SPA stub hack.)
C. HYBRID — git-tracked markdown is the source-of-truth (flow-mvp commits the validated .md into the repo, like a content/ dir), synced to Supabase on publish; Next keeps SSR-from-DB serving. Git gives review/version/rollback; DB keeps no-redeploy publishing.`

const LENS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['lens', 'scores', 'topPick', 'keyRisks', 'verdict'],
  properties: {
    lens: { type: 'string' },
    scores: {
      type: 'object', additionalProperties: false,
      required: ['A_keepSupabase', 'B_fileBasedMdx', 'C_hybridGitSource'],
      properties: {
        A_keepSupabase: { type: 'number' },
        B_fileBasedMdx: { type: 'number' },
        C_hybridGitSource: { type: 'number' },
      },
    },
    topPick: { type: 'string', enum: ['A', 'B', 'C'] },
    keyRisks: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', description: '3-5 sentences: the decisive consideration for this lens + why the top pick wins it' },
  },
}

const LENSES = [
  { key: 'seo-geo-perf', prompt: 'LENS: SEO + GEO + performance/Core Web Vitals. Does serving Supabase-HTML via Next SSR vs file-based SSG actually change rankings, crawlability, indexation latency, CWV, or GEO (LLM-citation) outcomes? Consider: is SSR HTML equivalent to SSG HTML for crawlers? caching/CDN; build-time vs request-time; the astrologywiki stub-staggering indexing trick; whether DB-down equals blog-down. Be concrete about what actually moves the SEO needle vs what is neutral.' },
  { key: 'content-ops', prompt: 'LENS: content operations + editorial workflow. Weigh reviewability (PR diff of an article), version history / blame / rollback, bulk find-and-fix across many posts (recall the unindexed-audit bulk content fixes), the flow-mvp pipeline fit (it emits markdown either way), non-developer editing, and audit trail. Which option best supports an AI-generated SEO content operation that periodically does mass corrections?' },
  { key: 'eng-cost-risk', prompt: 'LENS: engineering cost, migration risk, maintainability, two-site consistency. The system WORKS today (21 posts live). Score the one-time migration cost + ongoing maintenance + blast radius of each option. Weigh the value of unifying the mental model across the two sites vs the cost/risk of changing a working system. Call out the cheapest path that captures most of the benefit.' },
  { key: 'next-idiomatic', prompt: 'LENS: Next.js 16 idiomatic / industry best practice for a B2B marketing blog. What do strong Next.js marketing sites actually do — headless CMS (DB/Sanity/Contentful) vs MDX-in-repo (contentlayer/fumadocs/next-mdx-remote)? Is sanitized-HTML-in-a-DB-row rendered via dangerouslySetInnerHTML a normal pattern or an anti-pattern? What is the idiomatic source-of-truth for code-adjacent, AI-generated, low-edit-frequency SEO content?' },
]

const lensResults = await parallel(LENSES.map((l) => () =>
  agent(FACTS + '\n\n' + l.prompt + '\n\nYou may read files in /Users/wzb/Code/gengrowth-agents (blog page, src/lib/blog.ts, scripts/import-flow-md-to-blog.ts) and /Users/wzb/Code/oracle (scripts/generate-seo-pages.mjs, a data/articles sample .ts) to ground your scoring. Score all three options for YOUR lens only. Be decisive and honest — do not hedge all three to similar scores.',
    { label: 'lens:' + l.key, phase: 'Lenses', schema: LENS_SCHEMA, effort: 'high' })))

const lenses = lensResults.filter(Boolean)

const SYNTH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['recommendation', 'oneLineAnswer', 'rationale', 'migrationPath', 'doNot', 'confidence'],
  properties: {
    recommendation: { type: 'string', enum: ['A', 'B', 'C', 'A-then-C', 'other'] },
    oneLineAnswer: { type: 'string', description: 'direct answer to whether gengrowth should copy the astrologywiki model' },
    rationale: { type: 'string', description: 'why, weighing the 4 lenses; name the decisive factors and the strongest counter-argument' },
    migrationPath: { type: 'array', items: { type: 'string' }, description: 'concrete ordered steps IF a change is recommended (empty if status quo)' },
    doNot: { type: 'array', items: { type: 'string' }, description: 'cargo-cult traps to avoid (e.g. copying the SPA stub mechanism into Next)' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
}

const synthesis = await agent(
  FACTS + '\n\nFour independent lenses scored the three options. Synthesize ONE recommendation. Lens results JSON:\n' + JSON.stringify(lenses, null, 2) + '\n\nWeigh the lenses honestly (SEO is likely near-neutral between SSR and SSG; the real axis is content source-of-truth + ops + cost). Give a decisive recommendation, the decisive factors, the strongest counter-argument, and — if you recommend any change — a concrete, minimal, ordered migration path that reuses the existing flow-mvp markdown output. Explicitly list cargo-cult traps to avoid.',
  { label: 'synthesis', phase: 'Synthesis', schema: SYNTH_SCHEMA, effort: 'high' })

return { lenses, synthesis }
