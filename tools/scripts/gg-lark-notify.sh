#!/bin/bash
# gg-lark-notify.sh — push a Feishu/Lark message to the "SEO技术" group AS THE HERMES BOT.
#
# CHANGED 2026-06-23 (user decision): notifications must come FROM THE HERMES BOT in CHINESE,
# NOT from 王志彪's personal account. Previously this shelled out to lark-cli using 王志彪's user
# token, so every alert appeared as if 王志彪 sent it (and @'d himself). Now it authenticates as
# the Hermes Feishu app (cli_a909cb3dacf89cb3) using FEISHU_APP_ID/FEISHU_APP_SECRET from
# ~/.hermes/.env → tenant_access_token → im/v1/messages, so messages render as the Hermes bot
# (the same bot already in the group).
#
# DEFAULT TARGET = the "SEO技术" GROUP chat (王志彪 PM + 马博洋 Ops + 王玲 CEO). chat_id is
# tenant-global so it works across apps; open_id is per-app, so the @-mention open_ids below are
# the HERMES app's open_ids (queried from the group), NOT lark-cli's.
#
# @-mention policy (roles): 王志彪=PM, 马博洋=Ops(SEO运营), 王玲=CEO (NEVER @'d). Flags:
#   GG_LARK_NOTIFY_AT_PM=1   → @王志彪 (PM)   — action-needed alerts: park / gate-fail
#   GG_LARK_NOTIFY_AT_OPS=1  → @马博洋 (Ops)  — SEO 运营; park alerts + day-complete
#   (back-compat: GG_LARK_NOTIFY_AT_OPERATOR=1 is an alias of AT_PM)
# Routine "已发布" notices set none → plain text, no @.
#
# CHINESE: messages should read as Chinese. Callers' templates are already Chinese; the only
# English is the dynamic gate FAIL reason (from the LLM review workers). When the message
# contains an English sentence (≥4 consecutive English words) it is best-effort translated to
# Chinese via `claude -p` (technical tokens — slug/branch/PR/URL/PG-* — preserved), falling back
# to the original on any failure. Disable with GG_LARK_NOTIFY_NO_TRANSLATE=1.
#
# Targeting: GG_LARK_NOTIFY_CHAT_ID overrides the default group.
# Best-effort: never fails the caller (always exits 0).

export PATH="/opt/homebrew/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
MSG="$1"
[ -z "$MSG" ] && exit 0

HERMES_ENV="$HOME/.hermes/.env"
[ -f "$HERMES_ENV" ] || exit 0   # no Hermes creds → no-op (best-effort)

# SEO技术 group + Hermes-app open_ids (per-app; 王玲 CEO ou_4894… intentionally never @'d).
DEFAULT_CHAT="oc_5489e578113e804b80b3e556ce09fdb0"
PM_OID="ou_3ce0dce02872c344a4e244a1837ebced"   # 王志彪 (PM)
OPS_OID="ou_96d93c73b1bf79deae92ef94e58b37f6"  # 马博洋 (Ops, SEO 运营)
RID="${GG_LARK_NOTIFY_CHAT_ID:-$DEFAULT_CHAT}"

# Best-effort Chinese: only translate when the text has an English sentence (≥4 English words in
# a row), so already-Chinese notices (e.g. "✅ …已发布上线") are sent as-is with zero latency.
if [ "$GG_LARK_NOTIFY_NO_TRANSLATE" != "1" ] \
   && printf '%s' "$MSG" | grep -qE '[A-Za-z]+ [A-Za-z]+ [A-Za-z]+ [A-Za-z]+' \
   && command -v claude >/dev/null 2>&1; then
  ZH=$(printf '%s' "把下面这条 SEO 运维通知整理为简洁、完整的中文（已是中文的保留；绝不翻译 URL、slug、分支名 seo/auto/…、PR 号、PG-* 等技术标识；只输出整理后的文本，不要任何解释或前后缀）：

$MSG" | timeout 45 claude -p 2>/dev/null)
  # only adopt if non-empty and not obviously an error
  [ -n "$ZH" ] && MSG="$ZH"
fi

# Prepend REAL @ mentions (Hermes-app open_ids) AFTER translation so the <at> tags stay intact.
AT=""
if [ "$GG_LARK_NOTIFY_AT_PM" = "1" ] || [ "$GG_LARK_NOTIFY_AT_OPERATOR" = "1" ]; then
  AT="${AT}<at user_id=\"$PM_OID\"></at> "
fi
[ "$GG_LARK_NOTIFY_AT_OPS" = "1" ] && AT="${AT}<at user_id=\"$OPS_OID\"></at> "

# Authenticate as the Hermes bot and send. All escaping/JSON handled in node.
MSG="$AT$MSG" RID="$RID" HERMES_ENV="$HERMES_ENV" node -e '
const https=require("https"),fs=require("fs");
const env=fs.readFileSync(process.env.HERMES_ENV,"utf8");
const g=(k)=>((env.match(new RegExp("^"+k+"=(.*)$","m"))||[])[1]||"").trim().replace(/^["\x27]|["\x27]$/g,"");
const APP=g("FEISHU_APP_ID"),SEC=g("FEISHU_APP_SECRET");
if(!APP||!SEC)process.exit(0);
function post(p,b,h){return new Promise((res)=>{const d=JSON.stringify(b);const q=https.request("https://open.feishu.cn"+p,{method:"POST",headers:{"Content-Type":"application/json; charset=utf-8","Content-Length":Buffer.byteLength(d),...(h||{})}},x=>{let s="";x.on("data",c=>s+=c);x.on("end",()=>{try{res(JSON.parse(s||"{}"))}catch{res({})}});});q.on("error",()=>res({}));q.write(d);q.end();});}
(async()=>{
  try{
    const t=(await post("/open-apis/auth/v3/tenant_access_token/internal",{app_id:APP,app_secret:SEC})).tenant_access_token;
    if(!t)return;
    await post("/open-apis/im/v1/messages?receive_id_type=chat_id",{receive_id:process.env.RID,msg_type:"text",content:JSON.stringify({text:process.env.MSG})},{Authorization:"Bearer "+t});
  }catch{/* best-effort */}
})();
' 2>/dev/null
exit 0
