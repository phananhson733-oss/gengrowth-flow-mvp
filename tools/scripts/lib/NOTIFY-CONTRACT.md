# 通知事件层契约（阶段 1 · 单一事实源）

> 本文件是 gg-notify 事件层的规范。所有模板文案、@ 策略、事件字段以此为准。
> 实现文件：`lib/flow-state.mjs`（运行时状态）、`lib/lark-send.mjs`（传输）、`lib/gg-notify.mjs`（事件+模板）、`gg-notify.mjs`（CLI）、`gg-lark-notify.sh`（back-compat 壳）、`gg-batch-summary.mjs`（批次汇总）。

## 设计原则
1. 调用点只传**结构化字段**，禁止裸字符串拼消息。模板集中在 `lib/gg-notify.mjs`。
2. @ 策略由**事件决定**，不再由调用点散装 env 决定。
3. 站点是**字段**（`[astrologywiki]` / `[gengrowth]` / `[flow]` 标签），不是品牌前缀分叉。
4. 传输 fail-closed：飞书返回 `code===0` 且有 `message_id` 才算送达；失败重试；最终失败入 outbox 待重放。对 caller 永远 exit 0。
5. 运行时状态（outbox）放 vault 外：`~/gengrowth-agents/flow-state/`（env `GG_FLOW_STATE_DIR` 可覆盖，测试用）。

## 消息头格式

统一头：`{emoji} [{siteTag}] {正文}`。
- siteTag：`astrologywiki` | `gengrowth` | `flow`（跨站/基础设施事件）
- emoji 语义（沿用现有约定）：`✅` 成功 · `⚠️` 告警/待人工 · `✍️` 写好一篇 · `🔍` 索引诊断 · `📋` 登记/清单
- **废弃 `✖`**（原 Lane A 异常字形，统一为 `⚠️`）。

## 事件表（enum → 模板 → @ 策略）

@ 策略：`PM` = @王志彪，`OPS` = @马博洋，`-` = 不@。CEO 永不@。

| event | 字段 | 模板（中文，`{}` 为字段） | @ |
|---|---|---|---|
| `published` | site, title, url, extra? | `✅ [{site}] 已发布上线：{title}\n{url}\n（{extra}）`（extra 缺省省略括号行） | - |
| `authored` | site, detail | `✍️ [{site}] 写好一篇：{detail}` | - |
| `parked` | site, pid, slug, reason | `⚠️ [{site}] 暂停待人工（needs_human）：{pid}（{slug}）— {reason}` | PM+OPS |
| `park_rollup` | site, count, rest | `⚠️ [{site}] 本轮共暂停 {count} 篇（needs_human）。首篇已单独通报，其余合并：\n{rest}` | PM+OPS |
| `gate_fail` | site, slug, branch, reason | `⚠️ [{site}] 发布 gate 未过：{slug}（{branch}）：{reason} — PR 待人工` | PM+OPS |
| `fact_gate_fail` | site, pid, slug, reason | `⚠️ [{site}] 事实门未过（needs_human）：{pid}（{slug}）— {reason}。已跳过发布，待人工核对。` | PM+OPS |
| `publish_fail` | site, pid, slug, msg | `⚠️ [{site}] 发布失败：{pid}（{slug}）— {msg}` | OPS |
| `ticker_error` | site, msg | `⚠️ [{site}] 发布 ticker 异常：{msg}` | OPS |
| `preflight_fail` | lane, log | `⚠️ [flow] {lane} preflight 失败（env 异常，见 {log}），本轮跳过。` | OPS |
| `lane_timeout` | lane, seconds | `⚠️ [flow] {lane} 撰写超 {seconds}s 被硬杀，本轮放弃（草稿可能半成品，未上报）。` | OPS |
| `lane_stale` | lane, hours | `⚠️ [flow] {lane} 已 {hours} 小时未运行（launchd 可能未加载或被禁用）。` | OPS |
| `auth_missing` | site, what, hint | `⚠️ [{site}] 凭据缺失：{what}，本轮跳过。恢复：{hint}` | OPS |
| `day_complete` | site, date, publishedTotal | `✅ [{site}] {date}：本批计划内容已全部写完并上线（发布登记表累计 {publishedTotal} 篇），队列已清空。` | OPS |
| `batch_summary` | 见 gg-batch-summary | 固定模板，见下 | 完成:- / 部分:OPS |
| `topic_registered` | site, label, filled, clusters, pageIds | `📋 [{site}] 选题登记自动补齐：{label}\n补齐 {filled} 行；新增 cluster {clusters} 个。\npage_id: {pageIds}` | - |
| `index_diagnosis` | site, body | `🔍 [{site}] 索引诊断报告\n{body}` | PM+OPS |
| `index_queue` | site, body | `⚠️ [{site}] Request Indexing 候选队列已更新：{body}` | PM+OPS |
| `index_resubmit_ok` | site, count, body | `✅ [{site}] 已重新提交修复 URL：{count} 条\n{body}` | PM+OPS |
| `index_sitemap_ok` | site, url | `✅ [{site}] sitemap 已刷新：{url}` | PM+OPS |
| `index_sitemap_fail` | site, url, err | `⚠️ [{site}] sitemap 刷新失败：{url}（{err}）` | PM+OPS |
| `index_tick_fail` | site, rc, log, hint? | `⚠️ [{site}] 索引监控运行失败（rc={rc}）。请查看 {log}。{hint}` | OPS |
| `raw` | text | 原样发送（back-compat 通道，供 gg-lark-notify.sh 壳与外部仓库调用） | 按 env |

`batch_summary` 模板（由 gg-batch-summary.mjs 渲染，LLM 不参与）：
```
全部核实通过：
✅ [flow] 批次汇总 {date}：上线 {n} 篇（已逐篇线上核实）
[astrologywiki] {slug1}、{slug2}…
[gengrowth] {slug3}…
暂停待人工 {k} 篇：{pid（原因）…}     ← k=0 时省略此行

部分完成：
⚠️ [flow] 批次汇总 {date}：{m}/{n} 篇已上线核实，以下未核实到线上：
{site}/{slug}（HTTP {code}）…
暂停待人工 {k} 篇：{…}
```

## lib/flow-state.mjs
- `stateDir()` → `process.env.GG_FLOW_STATE_DIR || ~/gengrowth-agents/flow-state`；确保存在。
- `outboxDir()` → `<state>/notify-outbox/`
- `outboxWrite(payload)` → 写 `<ts>-<pid>-<seq>.json`；payload = `{text, atPm, atOps, chatId, createdAt, attempts, lastError}`。
- `outboxList()` / `outboxRemove(name)`。
- `heartbeat(lane)` → touch `<state>/heartbeats/<lane>`（阶段 5 用，本阶段先提供）。
- 全部同步 API（脚本场景），任何失败不抛（返回 null/false）——状态层永不搞垮业务。

## lib/lark-send.mjs（传输，fail-closed）
- `sendLark(text, {atPm, atOps, chatId, _noOutbox}) → {ok, messageId, error}`
- 凭据：`HERMES_ENV`（默认 `~/.hermes/.env`）读 `FEISHU_APP_ID/SECRET`；缺失 → `{ok:false,error:'no-creds'}` + 入 outbox。
- API base：`GG_LARK_API_BASE`（默认 `https://open.feishu.cn`，测试指向本地 mock）。
- 目标：`chatId` 参数 > `GG_LARK_NOTIFY_CHAT_ID` > 默认 `oc_5489e578113e804b80b3e556ce09fdb0`。
- @：atPm → `<at user_id="ou_3ce0dce02872c344a4e244a1837ebced"></at> `，atOps → `<at user_id="ou_96d93c73b1bf79deae92ef94e58b37f6"></at> `，前置于正文。
- 成功判定：tenant_access_token 取到 → `POST /open-apis/im/v1/messages?receive_id_type=chat_id` 响应 `code===0` 且 `data.message_id` 存在。
- 重试：总尝试 `1 + GG_LARK_SEND_RETRIES`（默认 2 次重试），指数退避 `GG_LARK_RETRY_BASE_MS`（默认 500ms）× 2^n。
- **write-ahead（防 SIGTERM 丢失）**：第一次网络尝试前先落一条「已认领」记录（`.json.sending`，对 replay 不可见）；成功 → commit 删除；最终失败 → 释放回 `.json`（含 lastError）供重放。进程发送中被杀 → 残留 `.sending` 由重放的陈旧回收捡回（`GG_LARK_STALE_CLAIM_MS`，默认 10 分钟）。任何时刻消息都不会既没发出也不在盘上。
- audit log：沿用 `~/Library/Logs/gg-lark-notify.log`（`GG_LARK_AUDIT_LOG` 可覆盖），行格式：
  `{date}\tchat={id}\t{SENT|SEND_FAILED code=X|SILENCED|OUTBOX_REPLAYED|OUTBOX_COMMIT_FAILED}\t{text 单行}`
- `replayOutbox()`：先回收陈旧 `.sending`，再逐条「原子 rename 认领 → 重发」（多个重放进程并发时同一条只有一个赢家，**绝不重复发送**；`_noOutbox:true` 防递归入箱；失败释放回 `.json`、attempts+1）。成功 commit 后才 audit `OUTBOX_REPLAYED`；commit 失败 audit `OUTBOX_COMMIT_FAILED` 不计成功。
- **uuid 幂等键**：同一逻辑消息的全部重试／重放共用一个 `uuid`（存 outbox payload `msgUuid`），飞书按 uuid 去重——消灭「已受理但响应超时→重发」与「commit 前被杀→回收重放」两个重复窗口。整体投递语义 = at-least-once + 服务端去重。
- **outbox 卫生淘汰**（replay 时执行）：损坏/空文本 → 丢弃（audit `OUTBOX_DROPPED code=invalid`）；超龄 `GG_LARK_OUTBOX_TTL_MS`（默认 48h）→ 丢弃（audit `OUTBOX_EXPIRED`）；attempts ≥ `GG_LARK_OUTBOX_MAX_ATTEMPTS`（默认 20）→ 丢弃（audit `OUTBOX_DROPPED code=attempts`）。
- **重放接线**：`replay-outbox` 已接进全部通知 lane 的 tick 开头（seo-autopilot / seo-author / gengrowth-publish / index-monitor / nightly）——入箱消息最迟在下一次任意 lane 运行时补发。
- 永不 throw。

## lib/gg-notify.mjs（事件层）
- `notify(event, fields) → Promise<{ok,...}>`：查表渲染模板 → 事件表决定 atPm/atOps → `sendLark`。
- `GG_LARK_NOTIFY_SILENCE=1`：只写 audit（`SILENCED`）不发送（沿用现语义，批次静默逐篇、由汇总统一发）。
- 未知 event → **自描述兜底**：正文＝`⚠️ [flow] 未知通知事件（{event}），原始字段：{JSON}`，@OPS（让拼写错误被人看见），并 audit `WARN unknown-event`。绝不落到 raw 的空 text。
- 渲染结果为空文本 → 拒发 + 不入箱 + audit `WARN empty-text`（空文本飞书必拒，入箱只会变成永远重放失败的毒条目）。传输层同样有 `SEND_FAILED code=empty-text` 防线。
- 导出 `renderTemplate(event, fields)` 供测试断言纯文本。

## tools/scripts/gg-notify.mjs（CLI，shell 调用点用）
```
node tools/scripts/gg-notify.mjs <event> --site astrologywiki --pid PG-X --slug foo --reason "..."
node tools/scripts/gg-notify.mjs raw --text "任意文本"        # back-compat
node tools/scripts/gg-notify.mjs replay-outbox
```
- `--k v` 全部收进 fields。exit 永远 0（stderr 打印失败原因）。

## gg-lark-notify.sh（back-compat 壳，接口不变）
- 调用契约不变：`gg-lark-notify.sh "<msg>"` + env `GG_LARK_NOTIFY_AT_PM/AT_OPERATOR/AT_OPS/SILENCE/CHAT_ID`（外部仓库如 gengrowth-outreach 仍在用）。
- 内部改为：flags 映射后调用 `node gg-notify.mjs raw --text "$1"`（非 exec，见下）。
- **翻译管道默认关闭**（反转）：仅 `GG_LARK_NOTIFY_TRANSLATE=1` 且未设 `GG_LARK_NOTIFY_NO_TRANSLATE=1` 时启用；启用时对 claude 输出做确定性校验：含 CJK 字符、长度为原文 0.3–3.0 倍、不匹配 `/error|quota|login|credit/i`，任一不过→回退原文。
- 保持 exit 0：结尾不用 `exec`（import 链加载失败时 exec 会把非零码直传调用方），显式 `|| true; exit 0`。

## gg-batch-summary.mjs
```
node tools/scripts/gg-batch-summary.mjs --since <ISO> [--site both] [--urls url1,url2] [--parked "PID:原因,…"] [--date YYYY-MM-DD] [--dry-run]
```
- oracle 侧：读 claims ledger（`GG_OPS_DIR` 定位），取 `status=done` 且完成时间戳 ≥ since 的条目 → slug → `https://www.astrologywiki.com/en/wiki/<slug>`（canonical 切 blog 后改一处常量）；`needs_human` 且 failedAt ≥ since 计入 parked。
- gengrowth 侧：无 ledger，靠 `--urls` 显式传入（调用方=发布器/会话收尾）。
- 逐 URL `HEAD/GET`（10s 超时，失败重试 1 次）判 200。
- 全 200 → `batch_summary` 完成模板；否则部分完成模板（列 HTTP code）。`--dry-run` 只打印不发送。
- **退出码**：0=已送达或已入 gg-notify 的 outbox；2=窗口内无任何条目（不发送）；1=用法错误；3=notify 调用本身失败（ENOENT/超时/崩溃）——渲染文本已由本层直接写入 outbox 兜底，绝不静默丢。

## 迁移映射（27 个调用点 → 事件）

| 原调用点 | event |
|---|---|
| gg-seo-autopilot.mjs:1501 | `published`(site=astrologywiki, extra=`作者 {author}，已登记到 ops`) |
| autopilot-tick.sh:89 | `preflight_fail`(lane=seo-autopilot) |
| autopilot-tick.sh:187 | `parked`（字段从 $PARK 解析或整段作 reason） |
| autopilot-tick.sh:193 | `authored`(site=astrologywiki, detail=`{…}— 立即发布中`) |
| autopilot-tick.sh:236 | `day_complete`(site=astrologywiki) |
| autopilot-tick.sh:253 | `park_rollup` |
| author-tick.sh:94 | `preflight_fail`(lane=seo-author) |
| author-tick.sh:123 | `lane_timeout`(lane=seo-author) |
| author-tick.sh:130 | `parked` |
| author-tick.sh:133 | `authored`(detail=`{…}— 待 publish lane 发布`) |
| gengrowth-publish.mjs:325 | `published`(site=gengrowth, extra=`gengrowth.ai 博客`) |
| gengrowth-publish.mjs:299 | `fact_gate_fail`(site=gengrowth) ← @ 策略变更：原不@，统一后 PM+OPS |
| gengrowth-publish.mjs:329 | `publish_fail` |
| gengrowth-publish.mjs:337 | `ticker_error` |
| gengrowth-publish.mjs:252 | `auth_missing`(what=SB_KEY, hint=`supabase login`) |
| gengrowth-publish-tick.sh:43 | `auth_missing`(what=service_role) |
| preview-gate.mjs:533 | `gate_fail`（`GG_GATE_NOTIFY_ON_PARK` 门保持原位原语义） |
| index-monitor.mjs 6 处 | `index_*` 对应事件（body 保持原领域内容） |
| index-monitor-tick.sh:107/111 | `index_tick_fail` |
| index-repair-resubmit-tick.sh:102 | `index_tick_fail`(hint=修复重提) |
| topic-register.mjs:2072 | `topic_registered` |
| seo-autopilot-tick.prompt.md L8/L47 | 更新为 CLI 调用示例（`gg-notify.mjs parked/gate_fail …`） |

行为变化点（有意为之，需在 PR 说明）：Lane A 事实门/发布失败原本零 @，统一后按事件表 @（fact_gate_fail→PM+OPS，publish_fail/ticker_error→OPS）；Lane A `✖` 改 `⚠️`；翻译默认关。其余触发条件、门控（GG_GATE_NOTIFY_ON_PARK、SILENCE）语义不变。
评审后追加的行为变化：nightly 末尾新增批次汇总（同批＝逐篇 published + 一条经 HTTP 核实的汇总）；全部通知 lane tick 开头新增 outbox 重放；投递语义 at-least-once + 飞书 uuid 去重；壳的 HERMES_ENV 尊重外部 env 覆盖（旧壳硬编码）、PATH 补全 prepend→append——均为有意漂移。

## 测试要求（node:test + spawnSync 黑盒风格，同 __tests__ 现有约定）
- lark-send：本地 http mock（GG_LARK_API_BASE 指过去）——code=0 成功记 SENT；code!=0 重试 N 次后入 outbox + SEND_FAILED；replayOutbox 成功清箱。
- gg-notify：renderTemplate 逐事件断言文案与 @ 前缀；SILENCE 只 audit 不打 API（mock 收不到请求）。
- gg-lark-notify.sh：壳兼容（AT_PM env → @ 出现）；默认不调 claude（PATH 里放假 claude，断言未被触发）；TRANSLATE=1 时坏输出（含 "quota"）回退原文。
- gg-batch-summary：mock http 站点，2 篇 200 → 完成模板；1 篇 404 → 部分完成模板 + exit 0；空窗口 exit 2。
