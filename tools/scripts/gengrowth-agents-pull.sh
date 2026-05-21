#!/bin/bash
# Daily git pull + doc sync for gengrowth-agents
REPO="/Users/lynne/gengrowth-agents"
WIKI_DEST="/Users/lynne/GenGrowth-wiki/docs/repo/gengrowth-agents"
LOG="/Users/lynne/Library/Logs/gengrowth-agents-pull.log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting pull..." >> "$LOG"
cd "$REPO" && git pull >> "$LOG" 2>&1
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Pull done (exit $?). Syncing docs..." >> "$LOG"

# 同步 docs/
rsync -av --delete \
  "$REPO/docs/" \
  "$WIKI_DEST/docs/" >> "$LOG" 2>&1

# 同步 tasks/
rsync -av --delete \
  "$REPO/tasks/" \
  "$WIKI_DEST/tasks/" >> "$LOG" 2>&1

# 同步 .claude/ (agents / commands / skills)
rsync -av --delete \
  "$REPO/.claude/" \
  "$WIKI_DEST/.claude/" >> "$LOG" 2>&1

# 同步根目录 md 文件
for f in AGENTS.md CLAUDE.md DESIGN.md TODOS.md; do
  [ -f "$REPO/$f" ] && cp "$REPO/$f" "$WIKI_DEST/$f"
done

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Sync done." >> "$LOG"
