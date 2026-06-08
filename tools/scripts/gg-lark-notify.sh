#!/bin/bash
# gg-lark-notify.sh — push a Feishu/Lark message via lark-cli (HTTPS REST, reliable —
# unlike the WebSocket bridge which can flap on networks that throttle WS to Feishu).
# Used by the SEO autopilot to alert on author/publish parks (and milestones).
#
# DEFAULT TARGET = the "SEO技术" GROUP chat (王志彪 + 马博洋 PM + 王玲 ops), so SEO
# publish/park notices go to the team group instead of DM'ing one operator
# (user decision 2026-06-08). Sent via lark-cli (王志彪's token), so messages appear
# as from 王志彪.
#
# Usage: gg-lark-notify.sh "<message text>"
# Targeting (precedence):
#   GG_LARK_NOTIFY_OPEN_ID set  → DM that open_id (receive_id_type=open_id)
#   else GG_LARK_NOTIFY_CHAT_ID  → that group (default: SEO技术 group below)
# @-mention (user decision 2026-06-08 — ONLY on action-needed alerts, ONLY 王志彪;
# never 马博洋/王玲): set GG_LARK_NOTIFY_AT_OPERATOR=1 to prepend a REAL <at> mention
# of the operator (王志彪). A plain "@名字" in text does NOT ping — Feishu needs the
# <at user_id="..."> tag, which this adds. Routine notices leave it unset → no @.
# Best-effort: never fails the caller (always exits 0).

export PATH="/opt/homebrew/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
MSG="$1"
[ -z "$MSG" ] && exit 0

# SEO技术 group: 王志彪(ou_180b4310…) + 马博洋 PM(ou_c2eb2502…) + 王玲 ops(ou_0c080154…)
DEFAULT_CHAT="oc_5489e578113e804b80b3e556ce09fdb0"
OPERATOR_OID="ou_180b4310d5dcc8752bcc06115626073d"  # 王志彪 — the only one ever @'d

if [ -n "$GG_LARK_NOTIFY_OPEN_ID" ]; then
  RID="$GG_LARK_NOTIFY_OPEN_ID"; RTYPE="open_id"
else
  RID="${GG_LARK_NOTIFY_CHAT_ID:-$DEFAULT_CHAT}"; RTYPE="chat_id"
fi

# Prepend a REAL @王志彪 mention only when the caller flags an action-needed alert.
AT=""
[ "$GG_LARK_NOTIFY_AT_OPERATOR" = "1" ] && AT="<at user_id=\"$OPERATOR_OID\"></at> "

# Build the nested JSON in node so message text is safely escaped (the `content`
# field must itself be a JSON string).
DATA=$(MSG="$AT$MSG" RID="$RID" node -e 'process.stdout.write(JSON.stringify({receive_id:process.env.RID,msg_type:"text",content:JSON.stringify({text:process.env.MSG})}))' 2>/dev/null)
[ -z "$DATA" ] && exit 0

lark-cli api POST /open-apis/im/v1/messages --params "{\"receive_id_type\":\"$RTYPE\"}" --data "$DATA" >/dev/null 2>&1
exit 0
