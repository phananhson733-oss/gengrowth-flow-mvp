---
title: gengrowth.ai Publish Bridge — Design (flow-mvp draft → live blog_posts row)
date: 2026-06-17
type: design
status: draft
---

# gengrowth.ai Publish Bridge

The missing piece: turn a flow-mvp gengrowth draft (`_staging/<page_id>-<llm>-v8.md`)
into a **live gengrowth.ai blog post**. The astrologywiki analog is
`tools/scripts/gg-md-to-oracle-ts.mjs` (markdown → `oracle/data/articles/<slug>.ts`
→ PR → Vercel). gengrowth.ai is different: its blog renders from a Supabase
`blog_posts` table, so the bridge's output is a **DB row (HTML in `content`)**, not a
committed `.ts` file.

This document is the buildable spec. It is intentionally scoped so the **smallest
shippable slice is publishing ONE post (PG-WLS-001 EN) end-to-end** before
generalizing to batch / bilingual.

---

## 0. Ground truth (verified in this repo + gengrowth-agents-repo)

- `blog_posts` columns (migration `20260305174700_website_tables.sql`):
  `id, slug, title, content, excerpt, category, pillar_slug, locale,
  locale_exclusive, author, published_at, updated_at, reading_time, status,
  created_at`.
- `content` is **plain TEXT holding a raw HTML fragment** (`<h2>/<p>/<ul>/<li>/<a>/<table>/<img>...`),
  rendered via `dangerouslySetInnerHTML` after `sanitize-html` (defaults + `img`).
  NOT markdown, NOT MDX, NOT jsonb.
- `category` is a free-text CHECK enum: `case_study | methodology | weekly_review |
  experiment_log`. NOT an FK; there is no `category_id`. `blog_categories` is a
  decorative lookup, not joined.
- Current unique key: `blog_posts_slug_locale_key UNIQUE(slug, locale)`. The old
  `UNIQUE(slug)` was dropped (`20260327000000`).
- `published_at` is **NOT NULL** (every row, even draft, needs a timestamp).
  `status` defaults `'draft'`; only `status='published'` is visible anywhere.
- `excerpt` is NOT NULL — the bridge must always produce a summary.
- `author` is a plain TEXT name string. No authors table, no FK, no avatar/bio
  column (AuthorBio is static i18n).
- No cover/hero image column, no tags, no SEO meta columns. Hero/inline images go
  **inside** the `content` HTML as `<img>` (only `src/alt/width/height/loading`
  survive sanitization).
- RLS: anon/authenticated can SELECT only `status='published'`. There is NO
  insert/update/delete policy. Writes require the **service_role key** (bypasses
  RLS) OR are applied as a SQL seed/migration by an operator.
- `seed-blog.sql` is the only existing writer. Exact shape:
  `INSERT INTO blog_posts (id, slug, title, content, excerpt, category,
  pillar_slug, locale, locale_exclusive, author, published_at, updated_at,
  reading_time, status, created_at) VALUES (...) ON CONFLICT (slug, locale)
  DO UPDATE SET ...` (idempotent). Applied by hand (SQL Editor / `supabase db
  push`), NOT by CI/deploy.

### Credential reality on THIS machine (awayer_mini)
- `/Users/awayer_mini/gengrowth-agents-repo` exists (remote
  `github.com/xdawayer/gengrowth-agents`, branch `main`), but has **only
  `.env.example`** — `SUPABASE_SERVICE_ROLE_KEY` is empty. The real key lives in
  Vercel / on wzb's box. No supabase CLI installed, no link state.
- → A direct service-role insert from this machine is **not possible today**.

### Draft + tooling reality
- flow-mvp root has **no `package.json`** — scripts run as bare `node *.mjs`.
- Draft contract: `_staging/<page_id>-<llm>-v8.md` = YAML frontmatter
  (`title, slug, date, status, target_keyword, associated_keywords[], page_id,
  template, tier, track, generated_at, content_sha256_short`) + body = 1 H1 + 11 H2.
  **No author field** in gengrowth drafts (byline baked into prose as "GenGrowth
  Team"). `entity` lives in the sibling `.manifest.json`, not the `.md`.
- Internal links are unresolved `[[<TBD-internal-link: noun phrase>]]` (6 in
  PG-WLS-001); external are `[[<TBD-external-link: Source | Page | reason>]]`.
- **Contamination risk:** PG-WLS-001 body line 118 contains a leaked
  `https://astrologywiki.com/en/wiki/...` link. The bridge MUST scrub cross-site
  (astrologywiki/oracle) URLs for the B2B blog.
- No markdown→HTML lib in flow-mvp. **gengrowth-agents-repo already has
  `marked@^17` and `sanitize-html@^2.17`** — the bridge should reuse those exact
  versions/policy so on-disk HTML matches what the render path will (re)sanitize.

---

## 1. The exact `blog_posts` row contract

Every published gengrowth article must produce this row (column → value → rule):

| column | value for PG-WLS-001 (example) | rule |
|---|---|---|
| `id` | deterministic UUIDv5 from `slug + '\|' + locale` | stable across re-publish so SQL diffs are clean; or omit and let `gen_random_uuid()` fill (but then re-runs churn the id — prefer deterministic) |
| `slug` | `white-label-keyword-research` | from frontmatter `slug` (kebab); idempotency anchor |
| `title` | from in-body `# H1` (preferred), fallback frontmatter `title` | mirror oracle `convertOne` |
| `content` | sanitized HTML fragment | markdown→HTML via `marked`, then `sanitize-html` (defaults + img); semantic tags only |
| `excerpt` | first prose paragraph after first `##`, ≤160 chars, sentence-boundary | `deriveDescription()` reuse; NOT NULL |
| `category` | `methodology` | W25 clusters → enum mapping (see §4); must be one of 4 enum strings |
| `pillar_slug` | `white_label_seo` | cluster id preserves topic grouping (free text, no CHECK) |
| `locale` | `en` | `'en'` or `'zh'`; one row per locale |
| `locale_exclusive` | `true` (EN-only phase) | `true` until a zh row exists |
| `author` | `GenGrowth Team` (en) / `GenGrowth 团队` (zh) | fixed string; no FK |
| `published_at` | `2026-06-16T00:00:00Z` (frontmatter `date`) or `now()` | NOT NULL; the go-live timestamp |
| `updated_at` | `= published_at` initially | keep `>= published_at` to avoid spurious "Updated" label |
| `reading_time` | computed int (≈ words / 200, min 1) | stored int, not derived at render |
| `status` | `published` | MUST be `published` to go live |
| `created_at` | `now()` (let default fill) | nullable, default now() |

Notes:
- `category` MUST be the **underscore** enum form (`case_study`, not `case-study`).
- `entity` (from manifest) has no column; if wanted later it belongs in a schema
  extension or inside the HTML — for v1 it is dropped (or kept only in the PR description).
- No image is required; if a hero is added later it is an inline `<img>` in `content`.

---

## 2. Publish mechanism (with credential implication)

Three candidate mechanisms, scored against the no-service-role-key reality:

**(a) Direct service-role insert from this machine** — NOT possible today. Requires
`SUPABASE_SERVICE_ROLE_KEY` + the real prod URL, neither on this box. Even if the
user supplies the key, it puts a prod-wide RLS-bypassing secret on a dev laptop
(blast radius). Use only as an explicit fallback with the user's key.

**(b) Emit a reviewable SQL seed/insert file + PR to gengrowth-agents-repo**
(RECOMMENDED PRIMARY). Matches the existing convention (`seed-blog.sql`), needs
**zero Supabase credentials on this machine** — only git/PR access (already have
the repo + remote). Mirrors the oracle PR→deploy model the user already trusts.
Tradeoff: **CI does NOT auto-apply SQL** (no `db push`/seed step in `ci.yml`), so a
human operator must run the file in the Supabase SQL Editor (or `supabase db push`)
after merge. So the PR alone does not make the post live — an operator step closes
the loop. Idempotency is free via `ON CONFLICT (slug, locale) DO UPDATE`.

**(c) Guarded admin API route in gengrowth-agents-repo** (RECOMMENDED FALLBACK /
v2). New `POST /api/blog/publish` route using `createAdminSupabaseClient()` (the
service-role key already lives server-side in Vercel) behind a shared bearer token
(e.g. `CRON_SECRET`). The bridge POSTs the row; the DB secret never touches this
machine. Cleanest credential isolation and the only mechanism that can be fully
automated end-to-end (no manual SQL Editor step). Cost: a code change + deploy to
the agents repo + provisioning a shared secret before it can be used.

**Recommendation:** Primary = **(b)** to ship the first post this week with the
credentials/tools we have. Fallback / next iteration = **(c)** to remove the manual
operator step once a `CRON_SECRET`-style token is provisioned in Vercel. Do not
choose (a).

The credential implication is the whole reason for this ordering: **(b) is the only
mechanism that is shippable from awayer_mini today**; it trades a manual apply step
for needing no prod secret locally.

---

## 3. The bridge script (mirrors `gg-md-to-oracle-ts.mjs`)

**Name / location:** `tools/scripts/gg-md-to-gengrowth-blog.mjs` (sibling of
`gg-md-to-oracle-ts.mjs`). Shared helpers reused from
`tools/scripts/gg-md-to-oracle-ts.mjs` (export them) and a new
`tools/scripts/lib/gengrowth-blog-links.mjs` for the link map.

**Dependency:** flow-mvp has no `package.json` and no markdown lib. Two options
(see open decisions): vendor `marked` + `sanitize-html` by adding a minimal
`package.json` in flow-mvp pinned to the agents-repo versions (`marked@^17`,
`sanitize-html@^2.17`), OR `import` from the agents-repo `node_modules` via an
absolute path. Recommended: add a tiny `package.json` + `npm i marked
sanitize-html` so the bridge is self-contained and CI-reproducible.

**CLI (symmetric with the oracle bridge):**
```
# Single post → SQL file (PRIMARY mechanism (b))
node tools/scripts/gg-md-to-gengrowth-blog.mjs \
  --source _staging/PG-WLS-001-claude-v8.md \
  --locale en \
  --emit sql \
  --out /Users/awayer_mini/gengrowth-agents-repo/supabase/seed-blog-w25.sql

# Batch (mirror oracle --batch / --winner-llm / --version)
node tools/scripts/gg-md-to-gengrowth-blog.mjs --batch \
  --winner-llm claude --version v8 \
  --pages "PG-WLS-001 PG-ART-001 ..." \
  --locale en --emit sql --out .../seed-blog-w25.sql

# Direct insert (FALLBACK (a)/(c)): --emit insert needs creds in env
node tools/scripts/gg-md-to-gengrowth-blog.mjs --source ... --locale en \
  --emit api --endpoint https://gengrowth.ai/api/blog/publish --token $CRON_SECRET
```
Flags: `--source` / `--batch` (+ `--winner-llm`, `--version`, `--pages`,
`--winner-map`, `--staging-dir`), `--locale en|zh`, `--emit sql|api`, `--out <file>`
(sql), `--endpoint`/`--token` (api), `--dry-run`, `--category <enum override>`,
`--pillar <slug override>`.

**Pipeline (per page):**
1. `parseFrontmatter(md)` — **REUSE** from oracle bridge (L100 regex + hand-rolled
   YAML).
2. Title = in-body `# H1` (prefer) else frontmatter `title` — REUSE oracle logic.
3. `excerpt = deriveDescription(body, 160)` — REUSE.
4. `transformBody(body)` — REUSE the *machinery* (resolve TBD internal/external,
   autolink bare URLs), but with a **new gengrowth link map** (see §3a) and a new
   **cross-site scrub** step that strips/neutralizes `astrologywiki.com` /
   `oracle` links (the PG-WLS-001 leak). Output is resolved markdown.
5. **markdown → HTML** (`marked.parse(resolvedMarkdown)`) — NET-NEW. Do NOT escape
   for a TS template literal (oracle-specific). Render the FAQ bold lines and the
   §5 markdown table into `<table><tr><th>/<td>` (no tbody — render path is fine
   with that).
6. `sanitizeHtml(html, { allowedTags: defaults.concat(['img']), allowedAttributes:
   { ...defaults, img: ['src','alt','width','height','loading'] } })` — match the
   render path EXACTLY so what we store == what gets displayed (no surprise
   stripping). NET-NEW (but reuses the agents-repo policy).
7. Map metadata → row: slug, title, excerpt, `category` (cluster→enum, §4),
   `pillar_slug` (cluster id), `locale`, `locale_exclusive`, `author` (fixed),
   `published_at` (frontmatter `date` → ISO, fallback now()), `updated_at` =
   published_at, `reading_time` = `Math.max(1, round(words/200))`,
   `status='published'`, deterministic `id` (UUIDv5 of `slug|locale`).
8. **Emit:**
   - `--emit sql`: append/replace one `VALUES(...)` block in the target seed file
     using the **exact 15-column order** of `seed-blog.sql` and a single trailing
     `ON CONFLICT (slug, locale) DO UPDATE SET <all content cols> = EXCLUDED.*`.
     Idempotent merge-by-(slug,locale) within the file (mirror oracle
     `mergeIntoSibling`). Use `atomicWrite` (REUSE, L468). Properly SQL-escape
     single quotes in the HTML (`''`).
   - `--emit api`: POST `{ row }` with `Authorization: Bearer <token>` to the
     guarded route.
9. Print a summary: slug, locale, category, pillar, words, reading_time, #links
   resolved vs italic-degraded, #cross-site links scrubbed, output path.

**Idempotency:** anchored on `(slug, locale)` everywhere — re-publishing the same
draft UPDATES rather than duplicates, exactly like `seed-blog.sql`.

### 3a. New gengrowth link map
`tools/scripts/lib/gengrowth-blog-links.mjs` exports `GENGROWTH_TBD_LINK_RULES`
(regex → `/en/blog/<slug>` for B2B SEO topics) seeded from the W25 plan slugs
(e.g. "agency rank tracking" → `/en/blog/agency-rank-tracking`). The oracle's ~170
astrology rules are discarded (they never match). Until the registry is populated,
unmatched TBD internal links **degrade to `*italic*`** (visible, no dead link) —
same interim behavior as oracle. External TBD links: for a B2B blog, resolve only
to safe canonical sources (Schema.org/Wikipedia) or drop; do NOT emit oracle-style
Wikipedia-only resolution blindly.

---

## 4. Author byline + W25-cluster → category mapping

**Author byline:** fixed string, no plumbing.
- `locale='en'` → `author = 'GenGrowth Team'`
- `locale='zh'` → `author = 'GenGrowth 团队'`
The visible AuthorBio box is static i18n regardless, so `author` only affects
card/meta byline. Matches all existing seeded/mock posts.

**Cluster → category mapping.** All 11 W25 clusters are SEO commercial-intent
topics; NONE match the 4 content-type enum values, so each MUST be coerced to a
valid enum or the CHECK rejects the insert. Cluster identity is preserved in
`pillar_slug` (free text).

| W25 cluster (page_id prefix) | `category` (enum) | `pillar_slug` (free text) |
|---|---|---|
| `white_label_seo` (PG-WLS) | `methodology` | `white_label_seo` |
| `agency_rank_tracking` (PG-ART) | `methodology` | `agency_rank_tracking` |
| `seo_for_saas` (PG-SFS) | `methodology` | `seo_for_saas` |
| `ethical_organic_seo` (PG-EOS) | `methodology` | `ethical_organic_seo` |
| `ai_seo_automation` (PG-AIS) | `methodology` | `ai_seo_automation` |
| `technical_seo_audit` (PG-TAS) | `methodology` | `technical_seo_audit` |
| `startup_diy_seo` (PG-SDS) | `methodology` | `startup_diy_seo` |
| `b2b_agency_seo` (PG-B2B) | `methodology` | `b2b_agency_seo` |
| `seo_tools_comparison` (PG-CMP) | `case_study` (comparison = evaluative) OR `methodology` | `seo_tools_comparison` |
| `social_link_building` (PG-SLB) | `methodology` | `social_link_building` |
| `social_media_seo_tools` (PG-SMS) | `methodology` | `social_media_seo_tools` |

Default rule: **all clusters → `methodology`** (they are how-to/framework guides),
with `seo_tools_comparison` optionally `case_study`. This needs ZERO schema change.
The alternative — adding a new enum value like `seo_guide` — is a 5-touchpoint
change (CHECK constraint + `blog_categories` row + `VALID_CATEGORY_SLUGS` +
`categorySlugToDb` + i18n `categoryPages.{slug}`) and is flagged as an open
decision, not done by default.

**Gap handling:** drafts carry no author metadata → byline is hardcoded. Drafts
carry no category → derived from page_id prefix via the table above. Missing
`pillar_slug` UI filtering: `pillar_slug` stores fine even if not in
`VALID_PILLARS`; it just won't surface as a filter until added there (a separate,
optional UI change).

---

## 5. Reuse vs new

**Reused from the oracle path** (export the functions in `gg-md-to-oracle-ts.mjs`):
- `parseFrontmatter` (frontmatter + hand-rolled YAML)
- `deriveDescription` → `excerpt`
- title-from-H1 logic, keywords assembly
- `transformBody` machinery: `resolveTbdLink` / `resolveExternalTbdLink` /
  `autoLinkBareUrls`
- `atomicWrite` and the idempotent merge-by-key pattern (`mergeIntoSibling` →
  merge-by-(slug,locale) in the SQL file)
- batch CLI shape (`--batch`, `--winner-llm`, `--version`, `--pages`,
  `--winner-map`, `hasPassedPhase2`)

**Net-new:**
- markdown → HTML render (`marked`) + `sanitize-html` to the exact render-path
  policy
- emit a `blog_posts` SQL `INSERT ... ON CONFLICT (slug, locale) DO UPDATE` (15-col
  order) instead of a TS `WikiArticle` file
- new `GENGROWTH_TBD_LINK_RULES` B2B link map (oracle's astrology rules discarded)
- cross-site link scrub (strip leaked `astrologywiki.com` / oracle URLs)
- cluster→category + cluster→pillar_slug mapping; fixed "GenGrowth Team" byline
  (no persona/`resolveAuthorMeta`)
- deterministic UUIDv5 id; `reading_time` computation; `published_at`/`updated_at`
  handling
- (mechanism c, later) a guarded `POST /api/blog/publish` route in
  gengrowth-agents-repo

**Explicitly NOT reused:** `emitExportBlock`/`emitTs`/`escapeForTemplate`
(TS-template specific), `resolveAuthorMeta`/`loadPersona` (oracle persona system),
the 170-rule astrology `TBD_LINK_RULES` data.

---

## 6. Open decisions (for the user)

1. **Publish mechanism / credentials.** SQL-seed + PR (operator applies; no key
   needed locally) vs guarded API route (auto, needs a Vercel-side token) vs hand
   over the prod service-role key for a direct insert. **Recommend (b) now, build
   (c) next; do not put the prod key on this laptop.**
2. **Storage = HTML.** Confirm `content` stores sanitized HTML (it does) and that
   the bridge sanitizes to the same policy as the render path. **Recommend: yes,
   sanitize at write-time AND rely on render-time sanitize as defense-in-depth.**
3. **Locale scope.** EN-only first vs bilingual now. **Recommend: EN-only for the
   first slice (`locale='en'`, `locale_exclusive=true`); add zh rows later as a
   second `--locale zh` pass.**
4. **Category strategy.** Collapse all clusters into `methodology` (no schema
   change) vs add a new SEO enum value (5-touchpoint migration). **Recommend:
   collapse to `methodology` now; revisit a dedicated SEO category only if the blog
   IA needs it.**
5. **Markdown lib hosting.** Add a `package.json` + `marked`/`sanitize-html` to
   flow-mvp vs import from agents-repo `node_modules`. **Recommend: add a minimal
   pinned `package.json` to flow-mvp so the bridge is self-contained.**
6. **External TBD links on a B2B blog.** Resolve to canonical sources vs drop.
   **Recommend: resolve to Schema.org/Wikipedia where genuinely cited, else drop;
   always scrub astrologywiki/oracle URLs.**

---

## 7. Step plan (smallest shippable slice first)

1. Export the reusable helpers (`parseFrontmatter`, `deriveDescription`,
   title/keywords, TBD machinery, `atomicWrite`) from `gg-md-to-oracle-ts.mjs`.
2. Add a minimal `package.json` to flow-mvp + `npm i marked sanitize-html` pinned
   to the agents-repo versions.
3. Build `gg-md-to-gengrowth-blog.mjs` single-post path only: parse PG-WLS-001 →
   resolve body (degrade TBD to italic, scrub the astrologywiki link) → marked →
   sanitize → row object → `--emit sql`.
4. Emit `supabase/seed-blog-w25.sql` for **PG-WLS-001 EN** with the exact 15-col
   order + `ON CONFLICT (slug, locale) DO UPDATE` (idempotent). `--dry-run` first.
5. Open a PR to `gengrowth-agents-repo` adding `seed-blog-w25.sql`; have the
   operator run it in the Supabase SQL Editor; verify the row returns from prod
   (not mock) at `/en/blog/white-label-keyword-research` with `status='published'`.
   **This is "done" per the user's definition (live in prod).**
6. Add `--batch` + `--winner-llm/--version/--pages` and the cluster→category/pillar
   map; generalize to the rest of the W25 EN posts.
7. (Next iteration) Build the guarded `POST /api/blog/publish` route in
   gengrowth-agents-repo + `--emit api` so the manual SQL-Editor step disappears.
8. (Later) Add `--locale zh` second pass for bilingual rows, and populate
   `GENGROWTH_TBD_LINK_RULES` from the growing blog index to convert italic
   placeholders into real internal links.

---

_Bridge file (to be created): `tools/scripts/gg-md-to-gengrowth-blog.mjs`.
Model on: `tools/scripts/gg-md-to-oracle-ts.mjs`. Target repo:
`/Users/awayer_mini/gengrowth-agents-repo` (`xdawayer/gengrowth-agents`)._
