#!/usr/bin/env python3
"""
每周一检查文档审计是否在过去7天内执行过。
- 未执行 → 在 reminders.md 中写入提醒（去重）
- 已执行 → 静默退出
由 gengrowth-repos-sync.sh 在每周一调用。
"""
import os
import time
import sys

WIKI = "/Users/lynne/GenGrowth-wiki"
STAMP = f"{WIKI}/ai-profile/audit-last-run.txt"
REMINDERS = f"{WIKI}/ai-profile/reminders.md"
REMINDER_MARKER = "文档审计提醒"
REMINDER_LINE = '- [ ] 文档审计提醒：距上次审计已超过 7 天，请在对话中说"审计文档"触发\n'


def audit_ran_recently(days=7):
    if not os.path.exists(STAMP):
        return False
    age_days = (time.time() - os.path.getmtime(STAMP)) / 86400
    return age_days <= days


def reminder_already_exists():
    if not os.path.exists(REMINDERS):
        return False
    with open(REMINDERS, "r", encoding="utf-8") as f:
        return REMINDER_MARKER in f.read()


def add_reminder():
    with open(REMINDERS, "r", encoding="utf-8") as f:
        content = f.read()

    if "<!-- 暂无待办事项 -->" in content:
        content = content.replace("<!-- 暂无待办事项 -->", REMINDER_LINE.strip())
    elif "## 待完成\n" in content:
        content = content.replace("## 待完成\n", f"## 待完成\n\n{REMINDER_LINE}")
    else:
        content += f"\n{REMINDER_LINE}"

    with open(REMINDERS, "w", encoding="utf-8") as f:
        f.write(content)
    print("[audit-reminder] 已添加审计提醒到 reminders.md")


def main():
    if audit_ran_recently():
        print("[audit-reminder] 7天内已执行审计，跳过提醒")
        sys.exit(0)

    if reminder_already_exists():
        print("[audit-reminder] 提醒已存在，跳过写入")
        sys.exit(0)

    add_reminder()


if __name__ == "__main__":
    main()
