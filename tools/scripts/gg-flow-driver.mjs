#!/usr/bin/env node
// gg-flow-driver.mjs — overlay driver（P1 dry-run）：读 ledger，把每个 needs_human park 分诊成动作
// (fix/retry/archive) 并打印计划 + 汇总。**P1 只规划不执行**——先落地验证分诊对不对（如 WC-045→archive），
// 再在后续 plan 里接侧效。fail-safe：任何错都 exit 0，绝不阻塞。--apply 预留(P1 空操作)。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { planDriverActions } from './lib/flow-driver.mjs';

const argv = process.argv.slice(2);
const getArg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : ''; };
const DEFAULT_LEDGER = join(homedir(), 'gengrowth-ops/inbox/06-tasks/tasks/.autopilot-claims.json');
const ledgerPath = getArg('--ledger') || DEFAULT_LEDGER;

function main() {
  let claims = {};
  try { claims = JSON.parse(readFileSync(ledgerPath, 'utf8')); }
  catch (e) { console.error(`flow-driver: 读 ledger 失败 ${String(e.message).slice(0, 80)} — 无可规划`); process.exit(0); }
  const plan = planDriverActions(claims);
  for (const a of plan) {
    console.log(`  ${a.pid} [${a.stage}] → ${a.action}\t${a.slug}\t${a.reason}`);
  }
  const n = (act) => plan.filter((a) => a.action === act).length;
  console.log(`flow-driver: parks=${plan.length} fix=${n('fix')} retry=${n('retry')} archive=${n('archive')} mode=dry-run`);
  process.exit(0);
}
main();
