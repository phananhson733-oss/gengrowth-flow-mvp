# Flow Driver Overlay — 设计 spec

- **日期**：2026-07-07
- **作者**：wzb + Claude（brainstorming）
- **状态**：设计已定，待写实现计划
- **主题**：给 gengrowth SEO blog 自动化流程加一个 `/goal` 驱动的 agentic overlay lane，真正做到"无人接管"

---

## 一、问题：cron 为什么没做到"无人接管"

现有 flow 已有一条**确定性 happy path**（作者 lane → 发布 lane gate → merge → 每日对账），本 session 已自主发布数十篇。但两个**seam 是坏的**，导致从来没做到端到端无人接管：

1. **失败恢复缺失**：文章过不了门（评审/codex/chrome FAIL）就 park 在 `needs_human`，**永远坐着等人工**。没有任何东西去读懂失败原因、修好、重过门。本 session 的 WC-045 就是活例：需要人（我）分别处理 RL4 系统 bug、Jupiter 事实错、stale 选题判断。
2. **回填不完整**：publish 后的后续（结果复盘表 seed、GSC request-queue、主题集群 page_assets）会滞后，没有"跑到完整为止"的闭环。本 session 是我手动一项项补的。

**根因性质**：这两处需要**判断**（读懂失败、决定修/弃、核对完整性），而确定性脚本给不了判断——它只能 park-and-wait。

## 二、目标与成功标准

**目标**：到点或手动触发后，一个 agentic loop 自动把当批文章推到终态（上线，或带原因归档），并回填到完整，全程无需人工介入；只在真正需要人看时发一条终态汇总。

**成功标准（一次 driver 运行结束时）**：
- 当批每一篇文章都在**终态**：`已上线` / `已归档(带原因)` / `park(N 次自修后仍不过，已发通知)`——**没有一篇卡在中间态**。
- 所有已上线文章的后续回填**核对为全绿**（sheet 状态 / plan / url-inventory / index-tracking / 结果复盘表 / 主题集群 / GSC 提交）。
- 一篇文章失败**绝不停整个 loop**。
- 飞书**只收到一条终态汇总**（沿用已 land 的降噪策略）。

**非目标（YAGNI）**：不重写能跑的 happy path；不让 LLM 驱动 happy path 的控制流；不追求单 tick 内处理无上限（有预算天花板）。

## 三、总纲对齐（最重要的约束）

wzb 总纲：**"用 workflow 来保证，而不是靠约定和 llm"**。本设计的两条铁律：

- **LLM 只做候选生成器，门做保证**：agentic 自修的输出**必须重过同一道确定性 + codex 事实门**才算数（和新文章同标准）。门是保证，不是 LLM。
- **判断永远被重验或被看见**：修 → 被门重验；归档 stale → 发一条通知给人看。LLM 的判断从不无监督地直接定论。
- **控制流保持确定性**：happy path（作者/发布/对账）继续是确定性脚本；LLM/`/goal` 只在**异常处理 + 回填**这两个坏 seam 上工作，干净隔离。这比让 `/goal` 驱动一切**更**符合总纲。

## 四、方案：agentic exception-handler overlay（Approach B）

保留确定性 cron happy path，新增**一条 overlay lane**，专做 happy path 做不了的两件事：分诊自修 park + loop-until-clean 回填。

### 4.1 架构 & `/goal` 怎么跑（第 1 节）

- **新 lane**：`com.gengrowth.flow-driver`，与现有 author/publish/reconcile lane 分开。author + publish 跑过一轮、沉淀后才启动。
- **触发**：到点（定时 / 挂 nightly 后）**或**手动 `launchctl kickstart`。
- **`/goal` 的稳健形态 = 无头 goal-agent**（不是交互式 `/goal`，也不是持久会话）：每个 tick 起一个 `claude -p`，带：
  - **goal 作 prompt**：「把当批每篇卡住/未完成的文章推到终态（上线或带原因归档），再跑完整回填直到无遗漏」
  - **flow 脚本作工具**（author/gate/publish/reconcile/index-monitor 等）
  - **`operating-gengrowth-flow` skill**（2026-06-22 已建）作操作手册（编码了已验证的坑）
  - 驱动到完成 → 发一条汇总 → **退出**。**每 tick 无状态**。
- **崩溃安全的底座**：持久状态活在 **ledger/sheet（workflow）**，绝不在 agent 记忆里。tick 死了下个 tick 从 ledger 精确续跑。
- **单独 lane 的理由**：publish lane 保持又笨又确定又快（workflow 保证的 happy path）；driver 是**唯一**装 LLM 判断的地方；关掉 driver，happy path 照样发（kill switch）。

### 4.2 Triage + 自修 loop（第 2 节，driver 核心）

driver 扫每一篇 park 文章，分诊成三类：

**① 瞬时（工具没跑成）**——codex 退出码非 0 / chrome verify 超时 / preview 时延 / 配额 / 网络。
→ **直接重试**（现有 `park-classify.mjs` 已判这类）。
→ **固化教训**：判 codex 类问题**必须用门的确切命令复现（带 `--pr`），不猜配额**。（本 session 栽点：把门里 "codex could not complete" 当配额傻等，实际用 `gg-codex-pr-review --repo <r> --pr <claim.pr> --branch <b>` 一测，codex 有额度且返回了真 VERDICT。）

**② 可修内容（真 FAIL，LLM 能照 FAIL 原因改对）**——核心。
→ 关键洞察：**codex FAIL 原因既是诊断又是修复指南**（如 WC-045 那条明确给出 *"Jupiter … transits Cancer then Leo"*）。
→ 扩展现有 `gg-gate-repair.mjs`（text-only claude -p 结构化 old/new patch），**把 codex FAIL 原因当修复指令**喂入 → 改稿 → **重过同一道门** → codex 重核 → 过了才发。
→ **有界**：每篇最多 N 次自修（每次都重过门），仍不过 → 转 park（发通知）。RL4 漂移、缺关键词、schema 等机械 FAIL 也走这条。

**③ 不可修 / 判断类（改稿救不了）**——stale 选题（比赛已踢）、前提根本错、争议无解。
→ driver 的 LLM 从 FAIL 原因识别（"already played" / "event passed" / "premise false"）→ **带原因归档**（标 won't-publish、移出活跃队列、发一条通知）→ **绝不空烧 N 次自修**。

**整个 loop**：`扫 park → 逐篇分诊 → 修/重试/归档 → 重过门 → 下一篇`，一篇失败绝不停整个 loop。

### 4.3 回填 + 完整性检查（第 3 节，治"publish 后不管"）

一批全终态后进第二阶段。**关键不是"跑一次回填"，而是"回填直到完整性检查全绿"（loop-until-clean）**。

自动跑全套（都是脚本、无浏览器）：
- `gg-ledger-reconcile`——sheet 状态→已发布 + plan 勾选 + vault 归档（drain WAL）
- `gg-index-monitor --sync-published`——url-inventory + index-tracking
- `gg-index-monitor --sync-recap`——结果复盘表 seed
- `gg-index-monitor --sync-request-queue`——GSC 提交队列
- `gg-cluster-page-assets-sync --apply`——主题集群表 page_assets

**完整性 verifier（治本点）**：对**每篇已上线文章**核对后续清单是否齐（sheet 状态？plan 勾了？在 url-inventory / index-tracking / recap / cluster？）→ 缺哪补哪 → **补完复查，全绿才算这批 done**。driver 不核完不退出。

### 4.4 GSC 限流 Chrome lane（第 4 节 + browser-use）

GSC 提交索引是唯一需要浏览器的一步（Chrome 开 GSC UI 逐条"网址检查→请求编入索引"，账号 xdawayer@gmail.com，站级配额 ~10-12/天）。wzb 定：**Chrome 全自动（v2）**。

- **浏览器驱动 = `browser-use`（github.com/browser-use/browser-use，候选，实现时先验证）**：Playwright 底座、LLM 驱动浏览器 agent，给它任务它自己看 UI 点填，比写死选择器更抗 GSC UI 漂移。
- **需要**：持久的、已认证 xdawayer@gmail.com 的 Chromium profile（登录态）；配额节流（撞"超出配额"停）；提完 **stamp 回** 结果复盘表（申请时间 + 索引修复状态）+ index-tracking（`resubmitted_at` / `fix_status`）。
- **SOP**：从结果复盘表**底部往上**（底=最新），逐条**先查"未收录"才提**（省配额）。
- **⚠️ 最脆一环，隔离处理**：做成**独立子 lane**，其脆弱性（浏览器/登录态/配额/UI 漂移）不污染无头 driver。**实现时先做 standalone spike 单独验证**（跑通 查未收录→提交→stamp→配额停），稳了再接进 driver；不稳回退 Chrome MCP，或退回 v1（driver 填队列+报数、浏览器人工）。

### 4.5 边界、防撞、可观测（第 4 节）

- **预算/成本**：每 tick 设**预算 + 最多篇数 + 时间上限**。停止 = 「当批全终态 + 回填全绿」**或**预算到**或**篇数到。loop-until-clean 但有天花板。
- **防撞 cron**：driver 复用现有 `withClaimsLock`，只碰**已 park/终态**文章（不碰 author/publish 正在处理的在途件）；时序挂在 author+publish 之后。
- **崩溃安全 / 幂等**：每 tick 无状态，状态全在 ledger/sheet；tick 死了下 tick 续；每个动作幂等（已做过再跑=空操作）。
- **可观测（沿用已 land 降噪）**：driver 每次运行**只发一条汇总**——终态计数：自修上线 N、归档 stale N、park N、回填补 N、GSC 提交 N。只发终态。
- **Kill switch**：关掉 driver lane，happy path 照样发。

## 五、组件（可独立理解/测试的单元）

| 单元 | 职责 | 依赖 |
|---|---|---|
| `flow-driver` lane（plist + tick.sh） | overlay 触发器，起无头 goal-agent | launchd |
| driver agent（`claude -p` + goal prompt） | 分诊、编排自修/重试/归档、驱动回填 loop | flow 脚本 + operating-gengrowth-flow skill |
| triage 分类器（扩展 `park-classify.mjs`） | 瞬时 / 可修内容 / 不可修-stale 三分 | codex FAIL 原因 + 确定性模式 |
| 自修（扩展 `gg-gate-repair.mjs`） | 把 codex FAIL 原因当指令改稿 → 重过门 | claude -p text-only patch |
| 完整性 verifier（新） | 逐篇核后续清单 + 缺项 re-run，loop-until-clean | reconcile + index-monitor + cluster-sync |
| GSC Chrome lane（新，browser-use） | 限流浏览器提交 + stamp 回 | browser-use + 认证 Chromium profile |
| driver 汇总/notify | 一条终态汇总 | 已 land 的 gg-notify 降噪 |

## 六、测试策略

- **triage 分类器**：单测覆盖三类（瞬时/可修/不可修）关键 FAIL 字符串；stale 模式（"already played"）→ 不可修；codex 退出码 → 瞬时。
- **自修**：给定 codex FAIL 原因 + 草稿 → 产出 patch → 断言重过门通过（用 mock 门）；有界 N 次后转 park。
- **完整性 verifier**：构造"缺 recap / 缺 cluster"的状态 → 断言识别缺项 + re-run → 复查全绿。
- **幂等**：driver 连跑两次 → 第二次空操作。
- **GSC spike**：standalone 手验（非单测）——跑通一条真实 GSC 提交 + stamp + 配额停。
- **防撞**：driver 与 cron 并发时不双写同一 claim（claims-lock 覆盖）。

## 七、分期 / 风险 / 未决

**分期建议**（降风险，逐步启用）：
1. **P1 无头 driver 骨架 + triage + 自修**（复用 gate-repair/park-classify），先只做失败恢复，回填仍走每日对账。默认 dry-run/off。
2. **P2 完整性 verifier + loop-until-clean 回填**。
3. **P3 GSC browser-use spike**（standalone 先验），验证后接进 driver。
4. 全程默认 off，逐 lane 灰度启用；每步过全量测试 + 对抗评审再 land。

**风险**：
- GSC browser-use = 最脆（登录态/配额/UI 漂移）→ spike 先验 + 可回退。
- agentic 自修可能把可疑内容改到"骗过门" → 门（尤其 codex 事实核）是唯一保证；若门本身漏，自修会放大——需要 codex 门足够强（现状够用，持续关注）。
- driver token 成本 → 预算天花板 + 只在异常触发。
- 与 cron 竞态 → claims-lock + 时序隔离。

**未决（实现时定）**：N（自修上限）具体值；driver tick 的具体 cadence；预算天花板具体数；operating-gengrowth-flow skill 是否需为无头场景补内容。

## 八、纪律（不变）

- 只在 macmini 改 flow 代码；vault 外 worktree 开发 + 原子 mv land。
- 全量测试 `node --test 'tools/scripts/__tests__/*.test.mjs'`（基线 ~1509/1507，2 fail = pre-existing codex 超时）。
- 每步 land 前过对抗评审（多镜头 find → verify）。
- cron 全自动跑着，别打断作者 lane。
