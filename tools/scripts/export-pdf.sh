#!/bin/bash
# Wiki PDF 导出工具
# 用法：./export-pdf.sh <文件.md> [输出.pdf]
#
# 标准预处理流程：
#   1. 剥离 YAML frontmatter
#   2. 将 --- 分隔线转为空行（Obsidian 风格分隔符不渲染成横线）
#   3. 调用 make-pdf 生成带封面和目录的 PDF
#
# 输出路径默认与源文件同目录，文件名与源文件相同（扩展名改为 .pdf）

set -e

if [ -z "$1" ]; then
  echo "用法：$0 <文件.md> [输出.pdf]"
  exit 1
fi

INPUT="$1"
if [[ "$INPUT" != /* ]]; then
  INPUT="$(pwd)/$INPUT"
fi

if [ ! -f "$INPUT" ]; then
  echo "❌ 文件不存在：$INPUT"
  exit 1
fi

if [ -n "$2" ]; then
  OUTPUT="$2"
  if [[ "$OUTPUT" != /* ]]; then
    OUTPUT="$(pwd)/$OUTPUT"
  fi
else
  BASENAME=$(basename "$INPUT" .md)
  OUTPUT="$(dirname "$INPUT")/${BASENAME}.pdf"
fi

# 定位 make-pdf 二进制
PDF_BIN=""
REPO_ROOT=$(git -C "$(dirname "$INPUT")" rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$REPO_ROOT" ] && [ -x "$REPO_ROOT/.claude/skills/gstack/make-pdf/dist/pdf" ] && PDF_BIN="$REPO_ROOT/.claude/skills/gstack/make-pdf/dist/pdf"
[ -z "$PDF_BIN" ] && [ -x "$HOME/.claude/skills/gstack/make-pdf/dist/pdf" ] && PDF_BIN="$HOME/.claude/skills/gstack/make-pdf/dist/pdf"

if [ -z "$PDF_BIN" ]; then
  echo "❌ 未找到 make-pdf，请运行 ./setup 构建"
  exit 1
fi

# 预处理：去 frontmatter + --- 转空行
CLEAN=$(mktemp /tmp/wiki-pdf-XXXXXX.md)
trap "rm -f $CLEAN" EXIT

awk '
  NR==1 && /^---$/ { in_yaml=1; next }
  in_yaml && /^---$/ { in_yaml=0; next }
  in_yaml { next }
  /^---$/ { print ""; next }
  { print }
' "$INPUT" > "$CLEAN"

# 生成 PDF
"$PDF_BIN" generate "$CLEAN" "$OUTPUT" --cover --toc

echo "✅ PDF 已生成：$OUTPUT"
