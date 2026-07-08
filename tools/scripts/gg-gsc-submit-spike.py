#!/usr/bin/env python3
# gg-gsc-submit-spike.py — P3 spike：用 browser-use(LLM 驱动浏览器)自动化 GSC「网址检查→请求编入索引」。
# spec §4.4 的最脆一环,故先 spike 验证可行再接入 driver。GSC 搜索框聚焦不稳(reminders 记 ~半数失败)——
# browser-use 的自适应(看页面重试)正好治这个,比写死 selector 稳。
#
# **两个硬前提(spike 侦查已确认当前都缺,需人工配)**：
#   1. LLM API key —— browser-use 的 agent 要一个:ANTHROPIC_API_KEY 或 OPENAI_API_KEY(Claude Code 的
#      OAuth 订阅不是 API key,用不了)。
#   2. 可达的、已登录 GSC(xdawayer@gmail.com,拥有两站 sc-domain)的浏览器 —— 用户 Chrome 正跑+Default
#      profile 被锁+无 CDP。两条路:(a) 用 --remote-debugging-port=9222 重启 Chrome 后 CDP 连(GG_GSC_CDP_URL);
#      (b) 给 automation 单独一个已登录 GSC 的 Chrome profile(GG_GSC_CHROME_PROFILE)。
#
# 安全:--check-only 默认(只查 index 状态、不提交、不耗配额);--submit 才真请求编入索引(账号级 ~10-12/天
# 配额,撞"超出配额"停)。worklist 从 stdin(每行一个 URL,production 由 driver 从结果复盘表底部往上喂)。
# 输出:每 URL 一行 `GSC_RESULT <url> <indexed|not-indexed|submitted|quota-exceeded|error>` 供 stamp 回填。
import asyncio
import os
import sys

CHECK_ONLY = "--submit" not in sys.argv
MAX_SUBMIT = int(os.environ.get("GG_GSC_MAX_SUBMIT", "10"))  # 单次上限(配额保护)
CDP_URL = os.environ.get("GG_GSC_CDP_URL", "")               # 例 http://localhost:9222
CHROME_PROFILE = os.environ.get("GG_GSC_CHROME_PROFILE", "") # 已登录 GSC 的 user-data-dir

def build_task(urls, check_only):
    action = (
        "只检查是否已收录,**绝不点任何提交/请求按钮**" if check_only else
        "若显示未收录(如'网址不在 Google 索引中'/'URL is not on Google'),才点『请求编入索引』/'Request indexing';"
        "已收录的跳过;若出现'超出了配额'/'quota exceeded'立即停止后续、汇报 quota-exceeded"
    )
    lines = "\n".join(f"- {u}" for u in urls)
    return (
        "你在 Google Search Console(已登录 xdawayer@gmail.com)。对下面每个 URL,在顶部『网址检查/URL "
        "inspection』搜索框输入该 URL 回车,等结果加载,判断收录状态。"
        f"{action}。\n"
        "GSC 搜索框聚焦不稳:输入后先确认文字确实进了框再回车;提交后等 toast 消失别马上再输入。\n"
        "每处理完一个 URL,用一行输出 `GSC_RESULT <url> <status>`,status∈"
        "{indexed, not-indexed, submitted, quota-exceeded, error}。\n"
        f"URL 列表:\n{lines}"
    )

async def main():
    urls = [ln.strip() for ln in sys.stdin if ln.strip()]
    if not urls:
        print("GSC_SPIKE: 无 URL 输入(stdin 每行一个)", file=sys.stderr)
        return 0

    # --- LLM(browser-use agent 决策)---
    try:
        if os.environ.get("ANTHROPIC_API_KEY"):
            from browser_use.llm import ChatAnthropic
            llm = ChatAnthropic(model="claude-sonnet-5")
        elif os.environ.get("OPENAI_API_KEY"):
            from browser_use.llm import ChatOpenAI
            llm = ChatOpenAI(model="gpt-4o")
        else:
            print("GSC_SPIKE: BLOCKER — 无 ANTHROPIC_API_KEY / OPENAI_API_KEY,browser-use agent 跑不了。"
                  "设一个再跑。", file=sys.stderr)
            return 3
    except Exception as e:  # noqa: BLE001
        print(f"GSC_SPIKE: LLM 初始化失败(browser-use 版本 API 可能不同,按装好的版本调) — {e}", file=sys.stderr)
        return 3

    # --- 浏览器(要 GSC 登录态)---
    from browser_use import Agent, BrowserProfile, BrowserSession
    if CDP_URL:
        session = BrowserSession(cdp_url=CDP_URL)               # 连已登录的 Chrome
    elif CHROME_PROFILE:
        session = BrowserSession(browser_profile=BrowserProfile(user_data_dir=CHROME_PROFILE, headless=False))
    else:
        print("GSC_SPIKE: BLOCKER — 无 GG_GSC_CDP_URL / GG_GSC_CHROME_PROFILE,拿不到 GSC 登录态。"
              "① --remote-debugging-port=9222 重启 Chrome 后设 GG_GSC_CDP_URL=http://localhost:9222,或"
              "② 给一个已登录 GSC 的 profile 路径。", file=sys.stderr)
        return 3

    work = urls[: (999 if CHECK_ONLY else MAX_SUBMIT)]
    agent = Agent(task=build_task(work, CHECK_ONLY), llm=llm, browser_session=session)
    print(f"GSC_SPIKE: mode={'check-only' if CHECK_ONLY else 'submit'} urls={len(work)} "
          f"browser={'cdp' if CDP_URL else 'profile'}", file=sys.stderr)
    await agent.run(max_steps=6 * len(work) + 10)
    return 0

if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
