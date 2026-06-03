#!/bin/bash
# gg-lark-notify.sh — push a Feishu/Lark DM to the operator via lark-cli (HTTPS
# REST, reliable — unlike the WebSocket bridge which can flap on networks that
# throttle WS to Feishu). Used by the SEO autopilot to alert on author/publish
# parks (and milestones) during unattended runs.
#
# Usage: gg-lark-notify.sh "<message text>"
# Target open_id is wzb by default; override with GG_LARK_NOTIFY_OPEN_ID.
# Best-effort: never fails the caller (always exits 0).

export PATH="/opt/homebrew/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
MSG="$1"
[ -z "$MSG" ] && exit 0
OID="${GG_LARK_NOTIFY_OPEN_ID:-ou_180b4310d5dcc8752bcc06115626073d}"

# Build the nested JSON in node so message text is safely escaped (the `content`
# field must itself be a JSON string).
DATA=$(MSG="$MSG" OID="$OID" node -e 'process.stdout.write(JSON.stringify({receive_id:process.env.OID,msg_type:"text",content:JSON.stringify({text:process.env.MSG})}))' 2>/dev/null)
[ -z "$DATA" ] && exit 0

lark-cli api POST /open-apis/im/v1/messages --params '{"receive_id_type":"open_id"}' --data "$DATA" >/dev/null 2>&1
exit 0
