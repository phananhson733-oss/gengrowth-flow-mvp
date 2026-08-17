#!/usr/bin/env bash
# gg-gengrowth-daily.sh — 把一篇过审的 gengrowth 稿子送上线，一条命令走完 6 步。
#
# 2026-08-13 日历排到 8/30 每天 1 篇。这 6 步 8/17 是手敲的，每一步都有一个当天踩到的坑；
# 固化下来是为了后面 12 篇不用重新推导，也不用重新踩。
#
# 这个脚本**只发布已经过审的稿子**。它不写作、不做事实审 —— 那两步必须有人在环：
# 8/17 两轮对抗审改掉的是文章的框架而不是措辞，结构门一个字都拦不住。
#
# 用法：
#   tools/scripts/gg-gengrowth-daily.sh PG-CMP-007 outrank-alternatives            # dry-run
#   tools/scripts/gg-gengrowth-daily.sh PG-CMP-007 outrank-alternatives --publish  # 真发
#
# 前置（脚本会逐条检查，缺哪个报哪个）：
#   _staging/<PAGE_ID>-en.md        稿子，带 frontmatter
#   _staging/<PAGE_ID>-hero.jpg     1200x675 JPEG
#   选题登记表里有 <PAGE_ID> 这一行
set -euo pipefail

PAGE_ID="${1:-}"
SLUG="${2:-}"
PUBLISH="${3:-}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKTREE="$HOME/.config/superpowers/worktrees/signalframe-mvp-app/main-integration-task4-20260727"

if [ -z "$PAGE_ID" ] || [ -z "$SLUG" ]; then
  echo "用法: $0 <PAGE_ID> <slug> [--publish]" >&2; exit 2
fi

SRC="$REPO/_staging/$PAGE_ID-en.md"
HERO="$REPO/_staging/$PAGE_ID-hero.jpg"
say() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

say "0/6 前置检查"
[ -f "$SRC" ]  || die "缺稿子: $SRC"
[ -f "$HERO" ] || die "缺 hero: $HERO"
# main 被 superpowers worktree 占着，主 checkout 切不过去（fatal: 'main' is already used by worktree）。
[ -d "$WORKTREE" ] || die "worktree 不在: $WORKTREE —— 用 git worktree list 找 main 现在挂在哪"
dims=$(sips -g pixelWidth -g pixelHeight "$HERO" | awk '/pixelWidth|pixelHeight/{printf "%s ", $2}')
[ "$dims" = "1200 675 " ] || die "hero 尺寸是 [$dims]，要 1200x675"
echo "  稿子 / hero / worktree 就位"

say "1/6 phase2 门"
# 只看 OVERALL：字数超上限是 soft warn，不该拦发布。
if ! GG_SITE=gengrowth node "$REPO/tools/scripts/_phase2-validate.mjs" \
      --source "$SRC" --tag manual-v8 --page-id "$PAGE_ID" \
      --entity "$(grep -m1 '^title:' "$SRC" | sed 's/^title: *//')" \
      --target-keyword "$(grep -m1 '^target_keyword:' "$SRC" | sed 's/^target_keyword: *//')" \
      --template Guide --tier T2 --psych-safety N --allow-missing-serp 2>&1 | grep -q 'OVERALL: PASS'; then
  die "phase2 未通过 —— 单独跑一遍看是哪一项"
fi
echo "  OVERALL: PASS"

say "2/6 转换 + 内链解析检查"
CONV=$(mktemp)
GG_SITE=gengrowth node "$REPO/tools/scripts/gg-md-to-gengrowth-blog.mjs" \
  --source "$SRC" --locale en --emit md --dry-run > "$CONV" 2>&1
# 未解析的 [[<TBD-internal-link: X>]] 会**静默**退化成斜体：不报错，链接就是没了。
# 整条内容线的 Pillar<->Series 拓扑就是这么漏掉的，所以这里当硬错误处理。
if grep -q 'TBD-internal-link' "$CONV"; then
  die "有内链没解析（会退化成斜体）—— 往 GENGROWTH_TBD_LINK_RULES 加规则"
fi
echo "  内链全部解析:"
grep -oE '\[[^]]{5,70}\]\(/blog/[a-z0-9-]+\)' "$CONV" | sort -u | sed 's/^/    /'

say "3/6 写入 worktree"
if [ "$PUBLISH" != "--publish" ]; then
  echo "  [DRY-RUN] 加 --publish 才真正写入并推送"
  echo ""
  echo "  将会执行:"
  echo "    md   -> $WORKTREE/apps/marketing/content/blog/en/$SLUG.md"
  echo "    hero -> $WORKTREE/apps/marketing/public/images/blog/$SLUG.jpg"
  echo "    git commit + push origin main"
  echo "    验证 HTTP 200 + sitemap 收录"
  echo "    回填选题登记表 Status/URL"
  exit 0
fi

ALT="$(grep -m1 '^hero_alt:' "$SRC" | sed 's/^hero_alt: *//')"
[ -n "$ALT" ] || die "稿子 frontmatter 缺 hero_alt: —— 别让它落到 og-default 占位图"
# alt 里出现 ": " 会让 frontmatter 变成非法 YAML（值被当成嵌套 key）。
case "$ALT" in *": "*) die "hero_alt 含 \": \"，YAML 会解析错 —— 改写成不带冒号的句子";; esac

GG_SITE=gengrowth node "$REPO/tools/scripts/gg-md-to-gengrowth-blog.mjs" \
  --source "$SRC" --locale en --emit md \
  --hero "/images/blog/$SLUG.jpg" --hero-alt "$ALT" \
  --out "$WORKTREE/apps/marketing/content/blog/en/$SLUG.md" > /dev/null
cp "$HERO" "$WORKTREE/apps/marketing/public/images/blog/$SLUG.jpg"
echo "  已写入"

say "4/6 commit + push"
cd "$WORKTREE"
# rev-list 读的是**本地缓存的 ref**，不 fetch 看不出落后 —— 8/7 因此吃了一次 non-fast-forward。
git fetch origin -q
behind=$(git rev-list --count HEAD..origin/main)
[ "$behind" = "0" ] || { echo "  落后 origin/main $behind 个 commit，先 rebase"; git rebase origin/main; }
git add "apps/marketing/content/blog/en/$SLUG.md" "apps/marketing/public/images/blog/$SLUG.jpg"
git commit -q -m "content(blog): $SLUG

$PAGE_ID, from the 2026-08-13 calendar. Fact-checked before publish."
git push origin main 2>&1 | tail -2
cd "$REPO"

say "5/6 等待部署并验证"
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://gengrowth.ai/blog/$SLUG" || echo 000)
  hero_code=$(curl -s -o /dev/null -w '%{http_code}' "https://gengrowth.ai/images/blog/$SLUG.jpg" || echo 000)
  inmap=$(curl -s "https://gengrowth.ai/sitemap.xml" | grep -c "/blog/$SLUG" || true)
  if [ "$code" = "200" ] && [ "$hero_code" = "200" ] && [ "${inmap:-0}" != "0" ]; then
    echo "  article 200 / hero 200 / sitemap 收录 (第 $i 次检查)"; break
  fi
  [ "$i" = "40" ] && die "部署超时: article=$code hero=$hero_code sitemap_hit=${inmap:-0}"
  sleep 20
done

say "6/6 回填账本"
node "$REPO/tools/scripts/gg-gengrowth-backfill-ledger.mjs" --page "$PAGE_ID" --slug "$PAGE_ID=$SLUG" --write

printf '\n\033[32m✅ %s LIVE: https://gengrowth.ai/blog/%s\033[0m\n' "$PAGE_ID" "$SLUG"
echo "别忘了：把新 slug 加进 GENGROWTH_TBD_LINK_RULES，否则后面的文章链不到这篇。"
