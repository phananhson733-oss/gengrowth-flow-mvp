#!/bin/bash
# Daily pull + doc sync for all gengrowth repos
LOG="/Users/lynne/Library/Logs/gengrowth-repos-sync.log"

echo "" >> "$LOG"
echo "========================================" >> "$LOG"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Sync started" >> "$LOG"

# ── gengrowth-agents ──────────────────────────────────────
AGENTS_REPO="/Users/lynne/gengrowth-agents"
AGENTS_DEST="/Users/lynne/GenGrowth-wiki/docs/repo/gengrowth-agents"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] [agents] pulling..." >> "$LOG"
cd "$AGENTS_REPO" && git pull >> "$LOG" 2>&1

rsync -a --delete "$AGENTS_REPO/docs/"   "$AGENTS_DEST/docs/"   >> "$LOG" 2>&1
rsync -a --delete "$AGENTS_REPO/tasks/"  "$AGENTS_DEST/tasks/"  >> "$LOG" 2>&1
rsync -a --delete "$AGENTS_REPO/.claude/" "$AGENTS_DEST/.claude/" >> "$LOG" 2>&1
for f in AGENTS.md CLAUDE.md DESIGN.md TODOS.md; do
  [ -f "$AGENTS_REPO/$f" ] && cp "$AGENTS_REPO/$f" "$AGENTS_DEST/$f"
done
echo "[$(date '+%Y-%m-%d %H:%M:%S')] [agents] done" >> "$LOG"

# ── gengrowth-ops ─────────────────────────────────────────
OPS_REPO="/Users/lynne/gengrowth-ops"
OPS_DEST="/Users/lynne/GenGrowth-wiki/docs/repo/gengrowth-ops"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ops] pulling..." >> "$LOG"
cd "$OPS_REPO" && git pull >> "$LOG" 2>&1

rsync -a --delete "$OPS_REPO/inbox/"      "$OPS_DEST/inbox/"      >> "$LOG" 2>&1
rsync -a --delete "$OPS_REPO/onboarding/" "$OPS_DEST/onboarding/" >> "$LOG" 2>&1
echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ops] done" >> "$LOG"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] All syncs complete." >> "$LOG"

# ── 文档健康检查（轻量 shell 扫描）────────────────────────
WIKI="/Users/lynne/GenGrowth-wiki"
DOC_LOG="/Users/lynne/Library/Logs/gengrowth-doc-health.log"

echo "" >> "$DOC_LOG"
echo "========================================" >> "$DOC_LOG"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Doc health check" >> "$DOC_LOG"

# 1. 根目录临时文件（Untitled / test / 未命名）
find "$WIKI" -maxdepth 2 -name "*.md" \
  \( -iname "untitled*" -o -iname "test*" -o -name "未命名*" \) \
  ! -path "*/node_modules/*" >> "$DOC_LOG" 2>&1

# 2. docs/ 下缺少日期前缀的非 README 文件
find "$WIKI/docs" -name "*.md" \
  ! -name "README.md" ! -name "_DIR.md" \
  ! -path "*/records/*" ! -path "*/node_modules/*" \
  | grep -v '/[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}-' >> "$DOC_LOG" 2>&1

# 3. 工作台中存在超过 7 天的文件（可能已成型，该迁移）
find "$WIKI/工作台" -name "*.md" -mtime +7 2>/dev/null >> "$DOC_LOG"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Doc check done. Review: $DOC_LOG" >> "$LOG"

# ── 每周一：文档审计提醒 ───────────────────────────────────
DOW=$(date +%u)  # 1=周一 … 7=周日
if [ "$DOW" = "1" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [audit-reminder] 周一检查..." >> "$LOG"
  python3 "$WIKI/tools/scripts/audit-reminder.py" >> "$LOG" 2>&1
fi
