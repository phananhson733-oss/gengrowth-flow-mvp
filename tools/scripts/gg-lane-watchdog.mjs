#!/usr/bin/env node
// gg-lane-watchdog.mjs — lane 保活 watchdog（阶段 5 · 杀"静默死亡"）。
//
// 审计根因之一：两条发布 lane 被 launchd 悄悄 disabled 3 天、零 watchdog，无人发现。
// 本 watchdog（每 30min 跑）对 lanes-manifest 里每条 lane 检查两件事：
//   1. 是否仍被 launchd 加载（launchctl list）—— 未加载=最严重（就是那 3 天的病）。
//   2. 最后活动时间（心跳 mtime，回退 launchd 日志 mtime）是否超 maxGap —— 加载了但不干活。
// 违规 → lane_stale 通知（**去重**：同一 lane 只在"新变坏"时告警，不每 30min 刷屏；恢复发 recovered）。
// 只读诊断；GG_WATCHDOG_AUTOHEAL=1 时对"未加载"的 lane 尝试 re-bootstrap（默认关，仅告警）。
//
// usage: node tools/scripts/gg-lane-watchdog.mjs [--json]

import { statSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadEnv } from './lib/gg-shared.mjs';
import { stateDir } from './lib/flow-state.mjs';
import { notify } from './lib/gg-notify.mjs';
import { LANES } from './lib/lanes-manifest.mjs';

loadEnv();
// 基础设施告警绝不该被批次静默吞掉（评审 WD-2；同 gg-batch-summary 的处理）：清掉可能从
// _gg.env / 批处理 shell 继承来的 SILENCE，否则 lane_stale 被静默丢弃却仍记进去重集 → 永久漏报。
delete process.env.GG_LARK_NOTIFY_SILENCE;
const HOME = homedir();
const AUTOHEAL = process.env.GG_WATCHDOG_AUTOHEAL === '1';
const LA_DIR = join(HOME, 'Library', 'LaunchAgents');

// ── 纯判定核（可单测）：给定 lanes + now + 注入的 loaded/lastActivity → 每 lane 判定。
// isLoaded(label)->bool；lastActivitySec(lane)->epochSec（0=无任何活动信号→age=Infinity）。
export function evaluateLanes(lanes, nowSec, isLoaded, lastActivitySec) {
  return lanes.map((l) => {
    const loaded = !!isLoaded(l.label);
    const last = lastActivitySec(l) || 0;
    const ageSec = last ? Math.max(0, nowSec - last) : Infinity;
    let status = 'ok';
    if (!loaded) status = 'not-loaded';               // 最严重：应加载却没加载
    else if (ageSec > l.maxGapSec) status = 'stale';  // 加载了但超期没活动
    return { label: l.label, loaded, status, ageSec, maxGapSec: l.maxGapSec };
  });
}

export const isViolation = (r) => r.status !== 'ok';

// launchctl list 一次拿全部已加载的 com.gengrowth.* label。查询失败(throw/超时)返回 **null**
// （评审 WD-1：绝不能把"查不到"当成"全未加载"→否则 launchctl 一次抖动=7 条假"未加载"告警风暴）。
function loadedLabels() {
  try {
    const out = execFileSync('launchctl', ['list'], { encoding: 'utf8', timeout: 15000 });
    const set = new Set();
    for (const line of out.split('\n')) {
      const label = line.trim().split(/\s+/).pop();
      if (label && label.startsWith('com.gengrowth.')) set.add(label);
    }
    return set;
  } catch { return null; }
}

// loaded 集解析为 isLoaded 判定函数：null(查询失败)→全视为 loaded(unknown，本轮不判 not-loaded，
// 仅靠 staleness 兜底)；否则按集合成员判定。（可单测）
export function isLoadedResolver(loaded) {
  return loaded === null ? () => true : (label) => loaded.has(label);
}

const mtimeSec = (p) => { try { return Math.floor(statSync(p).mtimeMs / 1000); } catch { return 0; } };

// 目录内最新文件的 mtime（cron-sync tick 写 dated 日志，最新文件 mtime = 上次运行）。
function newestMtimeInDir(dir) {
  try {
    let max = 0;
    for (const f of readdirSync(dir)) { const m = mtimeSec(join(dir, f)); if (m > max) max = m; }
    return max;
  } catch { return 0; }
}

// 最后活动 = max(心跳 mtime, 日志 mtime)。**取较新**（评审 HB-1/F1/F2）：心跳只在 tick 走到底
// 才 touch，空闲早退(计划写完/无待写/auth 缺失 exit)与长跑(单 fire 数小时、re-fire 命中锁 skip)路径
// 心跳会冻结；而 dated 日志每次 fire(含空闲/skip)都刷新——两者取较新，健康但心跳冻结的 lane 靠新鲜
// 日志救回，避免假 stale；真死(既不心跳也不写日志)时二者皆旧→仍报 stale。皆无→0→age=∞。
function lastActivitySecFor(lane) {
  const base = stateDir();
  const hbKey = String(lane.heartbeat || '').replace(/[^A-Za-z0-9._-]/g, '-');
  const hb = base && hbKey ? mtimeSec(join(base, 'heartbeats', hbKey)) : 0;
  const log = lane.logDir ? newestMtimeInDir(join(HOME, lane.logDir))
    : (lane.logFile ? mtimeSec(join(HOME, lane.logFile)) : 0);
  return Math.max(hb, log);
}

// 去重状态：<state>/watchdog-alerted.json = 当前已告警的 label 列表。
function alertedPath() { const d = stateDir(); return d ? join(d, 'watchdog-alerted.json') : null; }
function loadAlerted() {
  const p = alertedPath(); if (!p) return new Set();
  try { return new Set(JSON.parse(readFileSync(p, 'utf8'))); } catch { return new Set(); }
}
function saveAlerted(set) {
  const p = alertedPath(); if (!p) return;
  try { writeFileSync(p, JSON.stringify([...set], null, 0)); } catch { /* 状态层不搞垮 watchdog */ }
}

const shortName = (label) => label.replace('com.gengrowth.', '');
const ageHours = (s) => (s === Infinity ? '很久' : (s / 3600).toFixed(1));

async function main() {
  const json = process.argv.includes('--json');
  const nowSec = Math.floor(Date.now() / 1000);
  const loaded = loadedLabels();
  if (loaded === null) {
    // launchctl 查询失败（评审 WD-1）：本轮把加载态视为 unknown（isLoadedResolver→全 true），
    // 只靠 staleness 兜底，绝不把"查不到"升级成 7 条假"未加载"。落一条诊断。
    console.error(`lane-watchdog: launchctl list unavailable @ ${new Date().toISOString()} — skipping not-loaded verdicts this round (staleness still checked)`);
  }
  const results = evaluateLanes(LANES, nowSec, isLoadedResolver(loaded), lastActivitySecFor);
  const violations = results.filter(isViolation);

  // autoheal（默认关）：对 not-loaded 的 lane 尝试 re-bootstrap（先 enable 再 bootstrap——否则对已
  // launchd-disabled 的 label bootstrap 会失败，治不了审计"被 disabled"的正牌场景，评审
  // autoheal-bootstrap-only）。成功则本轮不告警，但**留痕通知**（评审 F3：自愈不能静默，否则
  // 反复掉载→自动重载→零告警=重造静默死亡）。
  if (AUTOHEAL) {
    for (const v of violations.filter((r) => r.status === 'not-loaded')) {
      const plist = join(LA_DIR, `${v.label}.plist`);
      if (!existsSync(plist)) { v.healError = 'plist missing'; continue; }
      try {
        try { execFileSync('launchctl', ['enable', `gui/${process.getuid()}/${v.label}`], { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { /* enable 幂等，失败不阻断 bootstrap */ }
        execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist], { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
        v.healed = true;
      } catch (e) { v.healError = String(e.message || e).slice(0, 100); }
    }
    const healed = violations.filter((v) => v.healed).map((v) => shortName(v.label));
    if (healed.length) await notify('batch_summary', { text: `🔧 [flow] watchdog 自动重载掉载的 lane：${healed.join('、')}（已恢复运行，请查为何掉载）`, partial: true });
  }

  // 去重告警：只对"新违规"发 lane_stale；已恢复的发 recovered。healed 的不算当前违规。
  const prev = loadAlerted();
  const nowViol = new Set(violations.filter((v) => !v.healed).map((v) => v.label));
  const newlyBad = [...nowViol].filter((l) => !prev.has(l));
  const recovered = [...prev].filter((l) => !nowViol.has(l));

  for (const label of newlyBad) {
    const r = results.find((x) => x.label === label);
    // hours 传数值即可（评审 F4）：模板尾句已含"launchd 可能未加载或被禁用"，not-loaded 与 stale
    // 都渲染为"已 Nh 小时未运行（…）"，通顺且带信息量，不再把状态字塞进时长槽。
    await notify('lane_stale', { lane: shortName(label), hours: ageHours(r.ageSec) });
  }
  if (recovered.length) {
    await notify('batch_summary', { text: `✅ [flow] lane 恢复正常：${recovered.map(shortName).join('、')}`, partial: false });
  }
  saveAlerted(nowViol);

  const summary = {
    checkedAt: new Date().toISOString(),
    total: LANES.length,
    violating: violations.length,
    results: results.map((r) => ({ label: r.label, status: r.status, ageH: r.ageSec === Infinity ? null : +(r.ageSec / 3600).toFixed(1), healed: !!r.healed })),
    newlyBad, recovered,
  };
  if (json) { process.stdout.write(JSON.stringify(summary, null, 2) + '\n'); return; }
  console.log(`=== lane-watchdog ${summary.checkedAt} — ${violations.length}/${LANES.length} violating ===`);
  for (const r of results) {
    const tag = isViolation(r) ? '⚠️' : '✓';
    const extra = isViolation(r) ? ` ${r.status} age=${ageHours(r.ageSec)}h${r.healed ? ' [HEALED]' : ''}` : '';
    console.log(`  ${tag} ${shortName(r.label).padEnd(20)}${extra}`);
  }
  if (newlyBad.length) console.log(`  → 新告警: ${newlyBad.map(shortName).join(', ')}`);
  if (recovered.length) console.log(`  → 已恢复: ${recovered.map(shortName).join(', ')}`);
}

// CLI 入口守卫：仅直接执行时跑 main()；被 import（单测复用 evaluateLanes/isViolation）时不触发。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { process.stderr.write(`gg-lane-watchdog: ${e.stack || e.message}\n`); process.exit(1); });
}
