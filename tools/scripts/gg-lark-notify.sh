#!/bin/bash
# gg-lark-notify.sh — back-compat 壳：把一条文本推送到「SEO技术」飞书群（Hermes bot 身份）。
#
# 阶段 1（通知统一，2026-07-03）：本脚本瘦身为兼容壳。真正的传输（tenant_access_token、
# fail-closed 判定、重试、outbox、audit）在 tools/scripts/lib/lark-send.mjs，事件模板在
# lib/gg-notify.mjs。旧调用方（含外部仓库 gengrowth-outreach）的接口完全不变：
#   gg-lark-notify.sh "<msg>"
#   env flags：GG_LARK_NOTIFY_AT_PM=1      → @王志彪（PM）
#              GG_LARK_NOTIFY_AT_OPERATOR=1 → AT_PM 的历史别名
#              GG_LARK_NOTIFY_AT_OPS=1     → @马博洋（Ops，SEO 运营）
#              GG_LARK_NOTIFY_SILENCE=1    → 只写 audit 不发送（批次静默逐篇）
#              GG_LARK_NOTIFY_CHAT_ID      → 覆盖默认群
#   永远 exit 0（best-effort，绝不搞垮调用方）。
#
# 历史背景（保留自旧版，2026-06-23 用户决定）：通知必须以 HERMES BOT 的身份、用中文发出，
# 不能用王志彪个人账号（旧版走 lark-cli 用户 token，看起来像王志彪自己发的还 @ 自己）。
# 现在用 ~/.hermes/.env（env HERMES_ENV 可覆盖）的 FEISHU_APP_ID/FEISHU_APP_SECRET 认证为
# Hermes 应用（cli_a909cb3dacf89cb3）→ tenant_access_token → im/v1/messages。
#
# 默认目标 = 「SEO技术」群（王志彪 PM + 马博洋 Ops + 王玲 CEO）。chat_id 是租户全局的，
# 跨应用可用；open_id 是按应用隔离的（per-app），所以 @ 用的 open_id 是 HERMES 应用视角
# 从群里查到的，不是 lark-cli 的。@ 策略（角色）：王志彪=PM，马博洋=Ops（SEO 运营），
# 王玲=CEO 永不 @。open_id 常量已收敛到 lib/lark-send.mjs。
#
# 翻译管道（2026-07-03 反转为【默认关闭】）：仅 GG_LARK_NOTIFY_TRANSLATE=1 且未设
# GG_LARK_NOTIFY_NO_TRANSLATE=1 时启用 claude 中文整理；启用时对 claude 输出做确定性校验
# （含 CJK 字符、长度为原文 0.3–3.0 倍、不匹配 error/quota/login/credit），任一不过→回退原文。

# PATH 补全放在末尾（append 而非 prepend）：launchd 环境 PATH 极简，需要能找到 node／claude；
# append 保证调用方（含测试）显式放在 PATH 前面的二进制优先，不被本脚本抢占。
# ${PATH:+…} 防 PATH 为空时产生前导空段（空段＝把 cwd 加入搜索路径＝命令劫持面）。
export PATH="${PATH:+$PATH:}/opt/homebrew/bin:$HOME/.local/bin:$HOME/.npm-global/bin"

MSG="$1"
[ -z "$MSG" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0   # 没有 node 就无能为力（best-effort no-op）

# —— 可选翻译（默认关；只在文本含 ≥4 个连续英文单词、即真有英文句子时才值得跑） ——
if [ "$GG_LARK_NOTIFY_TRANSLATE" = "1" ] && [ "$GG_LARK_NOTIFY_NO_TRANSLATE" != "1" ] \
   && printf '%s' "$MSG" | grep -qE '[A-Za-z]+ [A-Za-z]+ [A-Za-z]+ [A-Za-z]+' \
   && command -v claude >/dev/null 2>&1; then
  TIMEOUT_CMD=""
  command -v timeout >/dev/null 2>&1 && TIMEOUT_CMD="timeout 45"
  ZH=$(printf '%s' "把下面这条 SEO 运维通知整理为简洁、完整的中文（已是中文的保留；绝不翻译 URL、slug、分支名 seo/auto/…、PR 号、PG-* 等技术标识；只输出整理后的文本，不要任何解释或前后缀）：

$MSG" | $TIMEOUT_CMD claude -p 2>/dev/null)
  if [ -n "$ZH" ]; then
    # 确定性校验（契约）：含 CJK、长度为原文 0.3–3.0 倍、不含 error/quota/login/credit，
    # 任一不过 → 回退原文。校验放 node 里做（macOS grep 对 Unicode 范围不可靠）。
    OK=$(ORIG="$MSG" CAND="$ZH" node -e '
const o = process.env.ORIG || "";
const c = process.env.CAND || "";
const cjk = /[一-鿿]/.test(c);
const ratio = o.length ? c.length / o.length : 0;
const bad = /error|quota|login|credit/i.test(c);
process.stdout.write(cjk && ratio >= 0.3 && ratio <= 3.0 && !bad ? "1" : "0");
' 2>/dev/null)
    [ "$OK" = "1" ] && MSG="$ZH"
  fi
fi

# @ flags／SILENCE／CHAT_ID 通过 env 原样传给 gg-notify（raw 事件按 env 决定 @）。
# stdout/stderr 静默：旧壳就是 fire-and-forget，结果留痕在 audit log 与 outbox。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# 不用 exec：gg-notify 的 import 链若加载即抛（部分部署/文件缺失），exec 会把非零码直传
# 调用方，破坏「永远 exit 0」契约；这里显式吞掉后 exit 0。
node "$SCRIPT_DIR/gg-notify.mjs" raw --text "$MSG" >/dev/null 2>&1 || true
exit 0
