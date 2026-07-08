# Flow Driver P3 — GSC browser-use spike（可行性 + 脚手架）

- **日期**：2026-07-08
- **状态**：spike 完成（可行性已评估、脚手架已建、运行 gated on 3 个人工前提）
- **主题**：spec §4.4 —— 把最后手动的 GSC「网址检查→请求编入索引」用 browser-use 自动化。这是整条 overlay **最脆的一环**（真浏览器 + 登录态 + 配额 + UI 漂移），故 spec 定"**spike 先验证可行再接入**"。本 spike 就是那个先验。

## 一句话结论
browser-use **装成功、Python API 全匹配脚手架**；但**跑起来需 3 个当前都缺的人工前提**（LLM key / CDP 可达的已登录 GSC 浏览器 / browser-use 浏览器后端）。鉴于 GSC 提交**量很小**（账号级 ~10-12/天、且今天已手动提完 9 条）+ 自动化**脆**，**推荐 v1（driver 填队列+报数、浏览器那一下人工经 Chrome MCP）继续作为默认**；v2 全自动 browser-use **脚手架已就位、gated on 你提供前提**，值得时再启。

## 已验证 ✓
- `uv venv` + `uv pip install browser-use` **装成功**（机器本地 venv `~/gengrowth-agents/.venvs/gg-browser-use`，不进 repo，类比 node_modules）。
- browser-use Python API **与脚手架逐一匹配**：`from browser_use import Agent, BrowserSession, BrowserProfile` ✓、`from browser_use.llm import ChatAnthropic` ✓。
- GSC SOP（reminders.md）**已编码进 spike 的 task prompt**：结果复盘表底部往上、先查未收录才提、配额停、搜索框聚焦不稳的自适应处理、每 URL 一行 `GSC_RESULT` 供 stamp。

## 3 个硬前提（spike 侦查确认当前都缺，需人工配）
1. **LLM API key** —— browser-use 的 agent 用 LLM 决策浏览器动作，要 `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY`。**你的 Claude 是 OAuth 订阅、不是 API key，用不了**。_gg.env/env 均无。→ 需你放一个 API key（会走 API 计费）。
2. **可达的、已登录 GSC 的浏览器** —— GSC 认证在你的 Chrome Default profile（登录 xdawayer@gmail.com，拥有两站 sc-domain）。但**你的 Chrome 正跑 → Default profile 被锁**，且**无 CDP**（9222 未监听）。两条路：
   - (a) **CDP**：`--remote-debugging-port=9222` 重启 Chrome，然后 `GG_GSC_CDP_URL=http://localhost:9222`。browser-use 连你已登录的 Chrome。
   - (b) **独立 profile**：给 automation 一个单独的、已登录 GSC 的 Chrome profile 路径，`GG_GSC_CHROME_PROFILE=...`。
3. **browser-use 浏览器后端** —— 本版 browser-use 自管浏览器（"daemon 自启并连 running browser"），不用独立 `playwright` 包。启用时按装好版本的文档确认浏览器怎么连（大概率就是前提 2 的 CDP）。

## 脚手架（本 spike 产出，已就位）
- `tools/scripts/gg-gsc-submit-spike.py` —— browser-use GSC task。`--check-only` **默认只读**（只查 index 状态、不提交、不耗配额）；`--submit` 才真请求编入索引（`GG_GSC_MAX_SUBMIT` 配额上限，撞"超出配额"停）。worklist 从 stdin（每行一个 URL）。输出 `GSC_RESULT <url> <status>`。缺 key/浏览器时**明确报 BLOCKER 并 exit 3**，不瞎跑。
- `tools/scripts/gg-gsc-submit.sh` —— wrapper，经 venv 跑 spike；venv 缺失时报安装命令。
- （回填沿用 SOP：提交成功后 import `gg-index-monitor.mjs` 的 `readTrackingRows/updateTrackingRow`+`readRecapRows/updateRecapRow`，set `resubmitted_at`+`fix_status=已重新提交` / 结果复盘表「申请时间」+「索引修复状态」。）

## 启用路径（你要跑 v2 时）
```bash
# 1) 放一个 LLM API key(会 API 计费)
export ANTHROPIC_API_KEY=sk-ant-...
# 2) 让 browser-use 拿到 GSC 登录态——CDP 连你已登录的 Chrome：
#    完全退出 Chrome,再:  open -a "Google Chrome" --args --remote-debugging-port=9222
export GG_GSC_CDP_URL=http://localhost:9222
# 3) 先 --check-only 验一个 URL(只读、不耗配额),确认 browser-use 能导航 GSC + 读到收录状态：
printf '%s\n' "https://www.astrologywiki.com/en/wiki/some-slug" | bash tools/scripts/gg-gsc-submit.sh --check-only
# 4) 读到状态没问题,再小批 --submit(GG_GSC_MAX_SUBMIT=3 先试),撞配额就停,提完 stamp 回填 + 飞书报数。
```

## 推荐 & 接入决策
- **默认走 v1**：driver 的 P2 回填已经把 GSC **request-queue 填好**（`--sync-request-queue`），driver 汇总可报"N 条待提"。真正的浏览器那一下**人工经 Chrome MCP**（你今天就是这么做的、9 条无耗尽）。低量 + 人在场判断"未收录才提"最稳。
- **v2 全自动 gated on 前提**：脚手架就位；等你愿意放 API key + 常备一个 CDP/独立 GSC 浏览器时，先 `--check-only` 验一轮，稳了再接进一个**限流 Chrome 子 lane**（配额节流 + stamp 回填 + 一条飞书汇总），并像 flow-driver lane 一样 **RunAtLoad false + 人工灰度**。
- **不建议现在硬上 v2**：量小（~10/天）、GSC UI 会漂、API 计费、profile 锁——投入产出比不划算,除非量涨上来。

## Deferred（v2 接入时做）
- driver 里 wire 一个 `gg-gsc-submit-tick.sh` 限流子 lane（默认 dry/check-only,`GG_GSC_SUBMIT_APPLY=1` 才 --submit）。
- worklist 自动从结果复盘表底部往上取 + 提完 stamp 回填 + index-tracking 移出 request-queue。
- sitemap 漏收 `-birth-chart` slug 的排查（reminders 记的 GSC"无法识别此网址"，与 P3 正交但相关）。
