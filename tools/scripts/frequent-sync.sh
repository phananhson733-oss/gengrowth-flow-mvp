#!/bin/bash
# 高频同步：每 5 分钟拉取 wzb-obsidian 和 docs/repo 的最新内容
# 仅在活跃时段运行（ACTIVE_START ~ ACTIVE_END），其他时段静默退出
# 由 launchd com.gengrowth.frequent-sync 每 300 秒触发

WIKI="/Users/lynne/GenGrowth-wiki"
LOG="/Users/lynne/Library/Logs/gengrowth-frequent-sync.log"

# 日志轮转：超过 2000 行时只保留最后 1000 行
if [ "$(wc -l < "$LOG" 2>/dev/null)" -gt 2000 ]; then
  tail -1000 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
fi

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"; }

# git 锁检测：避免与 vault backup 并发冲突
if [ -f "$WIKI/.git/index.lock" ]; then
  log "[skip] git index.lock 存在，本次跳过"
  exit 0
fi

log "--- frequent sync start ---"

# ── 1. wzb-obsidian：拉取主 wiki 仓库 ────────────────────────
cd "$WIKI" || exit 1
RESULT=$(git pull 2>&1)
if echo "$RESULT" | grep -q "Already up to date"; then
  : # 无更新，静默
else
  log "[wiki] $RESULT"
fi

# ── 2. docs/repo/gengrowth-agents ────────────────────────────
AGENTS_REPO="/Users/lynne/gengrowth-agents"
AGENTS_DEST="$WIKI/docs/repo/gengrowth-agents"

if [ -d "$AGENTS_REPO" ]; then
  cd "$AGENTS_REPO" || exit 1
  RESULT=$(git pull 2>&1)
  if ! echo "$RESULT" | grep -q "Already up to date"; then
    log "[agents] $RESULT"
    rsync -a --delete "$AGENTS_REPO/docs/"    "$AGENTS_DEST/docs/"    2>> "$LOG"
    rsync -a --delete "$AGENTS_REPO/tasks/"   "$AGENTS_DEST/tasks/"   2>> "$LOG"
    rsync -a --delete "$AGENTS_REPO/.claude/" "$AGENTS_DEST/.claude/" 2>> "$LOG"
    for f in AGENTS.md CLAUDE.md DESIGN.md TODOS.md; do
      [ -f "$AGENTS_REPO/$f" ] && cp "$AGENTS_REPO/$f" "$AGENTS_DEST/$f"
    done
    log "[agents] rsync done"
  fi
fi

# ── 3. docs/repo/gengrowth-ops ───────────────────────────────
OPS_REPO="/Users/lynne/gengrowth-ops"
OPS_DEST="$WIKI/docs/repo/gengrowth-ops"

if [ -d "$OPS_REPO" ]; then
  cd "$OPS_REPO" || exit 1
  RESULT=$(git pull 2>&1)
  if ! echo "$RESULT" | grep -q "Already up to date"; then
    log "[ops] $RESULT"
    rsync -a --delete "$OPS_REPO/inbox/"      "$OPS_DEST/inbox/"      2>> "$LOG"
    rsync -a --delete "$OPS_REPO/onboarding/" "$OPS_DEST/onboarding/" 2>> "$LOG"
    log "[ops] rsync done"
  fi
fi

log "--- done ---"
