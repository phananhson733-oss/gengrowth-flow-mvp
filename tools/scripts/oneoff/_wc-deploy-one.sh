#!/usr/bin/env bash
# Deploy ONE WC-016~020 article to astrologywiki.com (oracle worktree).
# Self-contained per-article commit: convert EN+ZH -> register -> add to
# ARTICLE_SLUGS -> inline SVGs + hero -> build gate -> selective commit.
# Does NOT push (caller pushes + verifies, so the staggered cadence stays manual).
# Usage: bash _wc-deploy-one.sh <PID> <slug>
set -euo pipefail

PID="${1:?need PID e.g. PG-WC-017}"
SLUG="${2:?need slug e.g. erling-haaland-birth-chart}"
FLOW=/Users/wzb/gengrowth-flow-mvp
WT=/Users/wzb/Code/oracle-wc-deploy
SKILL=/Users/wzb/.claude/skills/baoyu-danger-gemini-web/scripts/main.ts
export GG_GEMINI_SKILL="$SKILL"
export PATH="/Users/wzb/.npm-global/bin:$PATH"

echo "==== deploy $PID ($SLUG) ===="

# 0. clean any prior build churn so git ops are clean (keep node_modules + committed files)
cd "$WT"
git checkout -- . 2>/dev/null || true
git clean -fdq -e node_modules -e scripts/plans
git fetch origin --quiet
git reset --hard origin/main --quiet
echo "[0] worktree synced to origin/main: $(git rev-parse --short HEAD)"

# 1. convert EN (frontmatter source = phase2 -en.md) + ZH (merge into sibling .ts)
node "$FLOW/tools/scripts/gg-md-to-oracle-ts.mjs" --source "$FLOW/_staging/${PID}-en.md" --slug "$SLUG" --out "$WT/data/articles/${SLUG}.ts" >/dev/null
node "$FLOW/tools/scripts/gg-md-to-oracle-ts.mjs" --source "$FLOW/_staging/zh-demo/${PID}-zh.md" --slug "$SLUG" --language zh --out "$WT/data/articles/${SLUG}.zh.ts" >/dev/null
test -f "$WT/data/articles/${SLUG}.zh.ts" && { echo "ERROR: stale standalone .zh.ts (merge failed)"; exit 3; }
grep -q "export const .*Zh: WikiArticle" "$WT/data/articles/${SLUG}.ts" || { echo "ERROR: ZH export missing in .ts"; exit 3; }
echo "[1] converted EN+ZH -> data/articles/${SLUG}.ts (dual export)"

# 2. register both langs in index.ts
node "$FLOW/tools/scripts/gg-oracle-register-index.mjs" --oracle-articles-dir "$WT/data/articles" --slug "$SLUG" --lang en >/dev/null
node "$FLOW/tools/scripts/gg-oracle-register-index.mjs" --oracle-articles-dir "$WT/data/articles" --slug "$SLUG" --lang zh >/dev/null
echo "[2] registered EN+ZH in index.ts"

# 3. add slug to ARTICLE_SLUGS (idempotent) right after the WC cluster comment
node -e '
const fs=require("fs"); const f=process.argv[1]; const slug=process.argv[2];
let s=fs.readFileSync(f,"utf8");
if(s.includes(`'"'"'${slug}'"'"'`)){ console.log("[3] slug already in ARTICLE_SLUGS"); process.exit(0); }
const anchor="// 6/18 WC player + Cancer-cluster (PG-WC-016~020), staggered ~20-25min apart\n";
const i=s.indexOf(anchor);
if(i<0){ console.error("ERROR: ARTICLE_SLUGS WC anchor comment not found"); process.exit(4); }
const at=i+anchor.length;
s=s.slice(0,at)+`  '"'"'${slug}'"'"',\n`+s.slice(at);
fs.writeFileSync(f,s);
console.log("[3] added "+slug+" to ARTICLE_SLUGS");
' "$WT/scripts/generate-seo-pages.mjs" "$SLUG"

# 4. images: inline SVGs (deterministic) + hero (gemini-web) + wire into .ts
rm -f "$FLOW/.gg-cache/illustrate-cooldown.json"
node scripts/gen-infographic.mjs --plan "scripts/plans/auto-${SLUG}.json" --slug "$SLUG" >/dev/null
echo "[4a] inline SVGs generated"
timeout 240 node scripts/illustrate-article.mjs --plan "scripts/plans/auto-${SLUG}.json" --slug "$SLUG" 2>&1 | grep -E "hero|inline|done" | sed 's/^/      /'
if [ -f "public/images/blog/${SLUG}.jpg" ]; then echo "[4b] hero OK"; else echo "[4b] WARN: no hero (gemini cooldown) -> text+inline, needs_hero"; fi

# 5. build gate
echo "[5] building (gate)…"
timeout 420 npm run build >/tmp/wc-build-${PID}.log 2>&1 && echo "[5] build PASS" || { echo "[5] build FAIL — see /tmp/wc-build-${PID}.log"; tail -15 /tmp/wc-build-${PID}.log; exit 5; }

# 6. selective commit (only this article's files + the 3 shared registry/source edits)
git add "data/articles/${SLUG}.ts" data/articles/index.ts scripts/generate-seo-pages.mjs \
        "scripts/plans/auto-${SLUG}.json" \
        "public/en/wiki/${SLUG}/" "public/zh/wiki/${SLUG}/" \
        "public/images/blog/${SLUG}.jpg" "public/images/blog/${SLUG}"-i*.svg \
        "public/og/articles/${SLUG}.png" 2>/dev/null || true
echo "[6] staged:"; git diff --cached --name-only | sed 's/^/      /'
git commit -q -m "content(seo): ${PID} ${SLUG} EN+ZH + hero/inline"
echo "[6] committed: $(git rev-parse --short HEAD)"
echo "==== $PID ready to push (git push origin wc016-deploy:main) ===="
