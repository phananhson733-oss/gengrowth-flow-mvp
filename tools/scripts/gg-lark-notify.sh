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
# Best-effort: never fails the caller (always exits 0).

export PATH="/opt/homebrew/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
MSG="$1"
[ -z "$MSG" ] && exit 0

# SEO技术 group: 王志彪(ou_180b4310…) + 马博洋 PM(ou_c2eb2502…) + 王玲 ops(ou_0c080154…)
DEFAULT_CHAT="oc_5489e578113e804b80b3e556ce09fdb0"

if [ -n "$GG_LARK_NOTIFY_OPEN_ID" ]; then
  RID="$GG_LARK_NOTIFY_OPEN_ID"; RTYPE="open_id"
else
  RID="${GG_LARK_NOTIFY_CHAT_ID:-$DEFAULT_CHAT}"; RTYPE="chat_id"
fi

# Build the nested JSON in node so message text is safely escaped (the `content`
# field must itself be a JSON string).
DATA=$(MSG="$MSG" RID="$RID" node -e 'process.stdout.write(JSON.stringify({receive_id:process.env.RID,msg_type:"text",content:JSON.stringify({text:process.env.MSG})}))' 2>/dev/null)
[ -z "$DATA" ] && exit 0

lark-cli api POST /open-apis/im/v1/messages --params "{\"receive_id_type\":\"$RTYPE\"}" --data "$DATA" >/dev/null 2>&1
exit 0
