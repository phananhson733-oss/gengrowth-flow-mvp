// lanes-manifest.mjs — 声明式 lane 清单（阶段 5 watchdog 的单一事实源）。
//
// 审计核心病（[[flow-reliability-audit-0703]]）：两条发布 lane 被 launchd 悄悄 disabled 3 天、
// 零 watchdog，无人发现。此清单声明"哪些 lane 应被 launchd 加载 + 按什么 cadence 活动"，
// gg-lane-watchdog.mjs 据此检测「未加载」与「加载但静默死亡」。
//
// 字段：
//   label      launchd label（launchctl list 里的名字，也是 <label>.plist 文件名）
//   heartbeat  心跳键（= tick 里 `gg-notify.mjs heartbeat <key>` 传的名；watchdog 读其 mtime，主信号）
//   logDir     HOME 相对的日志目录（回退信号：cron-sync tick 写 <dir>/YYYY-MM-DD.log，取目录内
//              最新文件 mtime = 上次运行；注意 StandardOut 的 launchd.out.log 常年不更新，不能用它）
//   logFile    HOME 相对的单一日志文件（nightly 用；脚本 `exec >>gg-nightly-seo.log` 每次运行 append
//              → mtime 每次更新。注意不是 StandardOut 的 launchd.out.log——那个被 exec 重定向后永不写）
//   maxGapSec  最长允许"无活动"间隔，超过 → stale 告警。取 cadence × ~2 + 缓冲，防慢/no-op 误报。
export const LANES = [
  { label: 'com.gengrowth.seo-author',        heartbeat: 'com.gengrowth.seo-author',        logDir: 'gengrowth-agents/cron-sync/seo_author',        maxGapSec: 5 * 3600 },
  { label: 'com.gengrowth.gengrowth-author',  heartbeat: 'com.gengrowth.gengrowth-author',  logDir: 'gengrowth-agents/cron-sync/gengrowth_author',  maxGapSec: 5 * 3600 },
  { label: 'com.gengrowth.seo-autopilot',     heartbeat: 'com.gengrowth.seo-autopilot',     logDir: 'gengrowth-agents/cron-sync/seo_autopilot',    maxGapSec: 2 * 3600 },
  { label: 'com.gengrowth.gengrowth-publish', heartbeat: 'com.gengrowth.gengrowth-publish', logDir: 'gengrowth-agents/cron-sync/gengrowth-publish', maxGapSec: 3 * 3600 },
  { label: 'com.gengrowth.ledger-reconcile',  heartbeat: 'com.gengrowth.ledger-reconcile',  logDir: 'gengrowth-agents/cron-sync/ledger_reconcile', maxGapSec: 26 * 3600 },
  { label: 'com.gengrowth.index-monitor',     heartbeat: 'com.gengrowth.index-monitor',     logDir: 'gengrowth-agents/cron-sync/index_monitor',    maxGapSec: 26 * 3600 },
  { label: 'com.gengrowth.seo-nightly',       heartbeat: 'com.gengrowth.seo-nightly',       logFile: 'Library/Logs/gg-nightly-seo.log', maxGapSec: 26 * 3600 },
];
