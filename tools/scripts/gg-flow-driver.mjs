#!/usr/bin/env node
// gg-flow-driver.mjs — overlay driver：读 ledger，把每个 needs_human park 分诊成动作 (fix/retry/archive)。
// 无 --apply = dry-run(只打印计划,P1 行为不变)。--apply = 接侧效执行(P1.5)：archive→一条 parked 通知 +
// 保持 needs_human(移出活跃队列) / fix→重过门(门内建 codex 事实核=保证,PASS 才 merge) / retry→交现有
// auto-retry lane。fail-safe：任何错都 exit 0，绝不阻塞。有界：GG_FLOW_DRIVER_MAX_FIX(默认1)/MAX_ARCHIVE(默认5)。
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { planDriverActions } from './lib/flow-driver.mjs';
import { driveApply } from './lib/flow-driver-apply.mjs';

const argv = process.argv.slice(2);
const getArg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : ''; };
// ledger 路径走 GG_OPS_DIR 单一事实源（与 gg-seo-autopilot / gg-ledger-reconcile 一致），
// 别自己复制 homedir 路径——否则 GG_OPS_DIR 沙箱下 autopilot 写 A 处、driver 读 B 处。
const OPS_DIR = process.env.GG_OPS_DIR || join(homedir(), 'gengrowth-ops');
const DEFAULT_LEDGER = join(OPS_DIR, 'inbox/06-tasks/tasks/.autopilot-claims.json');
const ledgerPath = getArg('--ledger') || DEFAULT_LEDGER;
const APPLY = argv.includes('--apply');
const REPO = process.env.GG_FLOW_DRIVER_REPO || 'xdawayer/oracle';
const SITE = process.env.GG_FLOW_DRIVER_SITE || 'astrologywiki';
const MAX_FIX = Number(process.env.GG_FLOW_DRIVER_MAX_FIX || 1);
const MAX_ARCHIVE = Number(process.env.GG_FLOW_DRIVER_MAX_ARCHIVE || 5);

async function main() {
  let claims = {};
  try { claims = JSON.parse(readFileSync(ledgerPath, 'utf8')); }
  catch (e) { console.error(`flow-driver: 读 ledger 失败 ${String(e.message).slice(0, 80)} — 无可规划`); process.exit(0); }
  const plan = planDriverActions(claims);
  for (const p of plan) { const c = claims[p.pid] || {}; p.branch = c.branch || ''; } // 补 branch(fix 要用)
  for (const a of plan) {
    console.log(`  ${a.pid} [${a.stage}] → ${a.action}\t${a.slug}\t${a.reason}`);
  }
  const n = (act) => plan.filter((a) => a.action === act).length;

  if (!APPLY) {
    console.log(`flow-driver: parks=${plan.length} fix=${n('fix')} retry=${n('retry')} archive=${n('archive')} mode=dry-run`);
    process.exit(0);
  }

  // --apply：接真 deps。fix 重过门→PASS 才 merge(门做保证);archive 发一条 parked 通知。
  const deps = {
    run: async (cmd) => { const r = spawnSync('node', [cmd.bin, ...cmd.args], { stdio: 'inherit' }); return { ok: r.status === 0, code: r.status }; },
    log: (m) => console.log(`  · ${m}`),
    cfg: { repo: REPO, site: SITE },
    maxFix: MAX_FIX, maxArchive: MAX_ARCHIVE,
  };
  const s = await driveApply(plan, deps);
  console.log(`flow-driver: parks=${plan.length} fixed=${s.fixed} fixFailed=${s.fixFailed} archived=${s.archived} retryDeferred=${s.retryDeferred} fixSkipped=${s.fixSkipped} capped=${s.capped} mode=apply`);
  process.exit(0);
}

// 结构化兜底：头注承诺"任何错都 exit 0，绝不阻塞"——不靠恰好不抛的巧合。
main().catch((e) => { console.error(`flow-driver: 未预期错误 ${String((e && e.message) || e).slice(0, 80)} — 兜底 exit 0`); process.exit(0); });
