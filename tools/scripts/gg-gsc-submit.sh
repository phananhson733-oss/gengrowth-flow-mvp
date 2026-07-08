#!/bin/bash
# gg-gsc-submit.sh — P3 GSC 提交 spike 的 wrapper。经机器本地 venv 跑 browser-use spike。
# 用法：结果复盘表底部往上的 URL 从 stdin 喂(每行一个);默认 --check-only(只查不提交、不耗配额);
#       加 --submit 才真请求编入索引。
#   printf '%s\n' url1 url2 | GG_GSC_CDP_URL=http://localhost:9222 ANTHROPIC_API_KEY=... \
#     bash gg-gsc-submit.sh --check-only
# 前提(见 docs 的 P3 feasibility)：① ANTHROPIC_API_KEY 或 OPENAI_API_KEY ② GG_GSC_CDP_URL(--remote-
#   debugging-port=9222 重启 Chrome)或 GG_GSC_CHROME_PROFILE(已登录 GSC 的 profile)。
set -euo pipefail
VENV="${GG_GSC_VENV:-$HOME/gengrowth-agents/.venvs/gg-browser-use}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -x "$VENV/bin/python" ]; then
  echo "gg-gsc-submit: venv 缺失 $VENV — 先装:uv venv \"\$VENV\"; uv pip install --python \"\$VENV/bin/python\" browser-use; \"\$VENV/bin/python\" -m playwright install chromium" >&2
  exit 3
fi
exec "$VENV/bin/python" "$SCRIPT_DIR/gg-gsc-submit-spike.py" "$@"
