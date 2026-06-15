#!/bin/bash
# gg-lark-notify.sh — push a Feishu/Lark message via lark-cli (HTTPS REST, reliable —
# unlike the WebSocket bridge which can flap on networks that throttle WS to Feishu).
# Used by the SEO autopilot to alert on author/publish parks (and milestones).
#
# DEFAULT TARGET = the "SEO技术" GROUP chat (王志彪 PM + 马博洋 Ops + 王玲 CEO), so SEO
# publish/park notices go to the team group instead of DM'ing one person
# (user decision 2026-06-08). Sent via lark-cli (王志彪's token), so messages appear
# as from 王志彪.
#
# Usage: gg-lark-notify.sh "<message text>"
# Targeting (precedence):
#   GG_LARK_NOTIFY_OPEN_ID set  → DM that open_id (receive_id_type=open_id)
#   else GG_LARK_NOTIFY_CHAT_ID  → that group (default: SEO技术 group below)
# @-mention policy. Roles (corrected 2026-06-15): 王志彪=PM, 马博洋=Ops(SEO运营), 王玲=CEO.
# A plain "@名字" in text does NOT ping — Feishu needs the <at user_id="..."> tag, which
# this adds. 王玲 (CEO) is NEVER @'d. Flags:
#   GG_LARK_NOTIFY_AT_PM=1   → @王志彪 (PM)   — action-needed alerts: park / gate-fail
#   GG_LARK_NOTIFY_AT_OPS=1  → @马博洋 (Ops)  — SEO 运营; park alerts + day-complete
#   (back-compat: GG_LARK_NOTIFY_AT_OPERATOR=1 is still honored as an alias of AT_PM)
# Routine "已发布" notices set none → plain text, no @.
# Best-effort: never fails the caller (always exits 0).

export PATH="/opt/homebrew/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
MSG="$1"
[ -z "$MSG" ] && exit 0

# SEO技术 group: 王志彪 PM(ou_180b4310…) + 马博洋 Ops(ou_c2eb2502…) + 王玲 CEO(ou_0c080154…)
DEFAULT_CHAT="oc_5489e578113e804b80b3e556ce09fdb0"
PM_OID="ou_180b4310d5dcc8752bcc06115626073d"   # 王志彪 (PM) — @'d on action-needed alerts
OPS_OID="ou_c2eb25026dd20d6e9fbf404a1aa49c39"  # 马博洋 (Ops, SEO 运营) — @'d on alerts + day-complete
# (王玲 CEO ou_0c080154… is intentionally never @'d)

if [ -n "$GG_LARK_NOTIFY_OPEN_ID" ]; then
  RID="$GG_LARK_NOTIFY_OPEN_ID"; RTYPE="open_id"
else
  RID="${GG_LARK_NOTIFY_CHAT_ID:-$DEFAULT_CHAT}"; RTYPE="chat_id"
fi

# Prepend REAL @ mentions per the caller's flags.
# AT_PM → 王志彪 (PM); AT_OPERATOR kept as a back-compat alias for AT_PM.
AT=""
if [ "$GG_LARK_NOTIFY_AT_PM" = "1" ] || [ "$GG_LARK_NOTIFY_AT_OPERATOR" = "1" ]; then
  AT="${AT}<at user_id=\"$PM_OID\"></at> "
fi
[ "$GG_LARK_NOTIFY_AT_OPS" = "1" ] && AT="${AT}<at user_id=\"$OPS_OID\"></at> "

# Build the nested JSON in node so message text is safely escaped (the `content`
# field must itself be a JSON string).
DATA=$(MSG="$AT$MSG" RID="$RID" node -e 'process.stdout.write(JSON.stringify({receive_id:process.env.RID,msg_type:"text",content:JSON.stringify({text:process.env.MSG})}))' 2>/dev/null)
[ -z "$DATA" ] && exit 0

lark-cli api POST /open-apis/im/v1/messages --params "{\"receive_id_type\":\"$RTYPE\"}" --data "$DATA" >/dev/null 2>&1
exit 0
