#!/usr/bin/env node
// gg-ledger-reconcile.mjs — 每日账本对账（阶段 4 · 杀"账本漂移"）。
//
// 不变量：ledger = 唯一权威。此脚本把四处账本拉到"落后 ≤24h"，把过去靠"某个会话记得
// 手动跑 reconcile / 补勾 / 补归档"的收尾动作下沉成一个每日确定性任务：
//   1. drainPending —— 重试 pending-writeback 队列（发布时 verify-live 未过 / 回填某步失败的补写）。
//   2. reconcile-published —— ledger ↔ GitHub/live 对齐（复用 gg-seo-autopilot，CLAIMS_LOCK 安全）。
//   3. reconcile-status —— 选题登记表 status ↔ sitemap 广扫补 flip（两站，幂等、不降级 closed）。
//   4. plan 勾选补扫 —— ledger 中 done 但 plan box 仍 [ ] 的补勾（清"已上线未勾选"）。
//   5. 汇总 —— 有漂移才推一条飞书（batch_summary，零@），无漂移静默。
//
// 幂等、只读优先、best-effort：任一子步失败不搞垮其余，全部计入汇总。
//
// usage:
//   node tools/scripts/gg-ledger-reconcile.mjs            # apply（默认；每日 cron 用）
//   node tools/scripts/gg-ledger-reconcile.mjs --dry      # 只读：列 WAL + reconcile-status --dry，不写

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadEnv, getAccessToken, gFetch } from './lib/gg-shared.mjs';
import { drainPending, listWriteback } from './lib/backfill-tx.mjs';
import { notify } from './lib/gg-notify.mjs';
import { PRODUCTS, PAGES_TAB, PUBLISHED, workbookId } from './gg-reconcile-status.mjs';

loadEnv();
const HOME = homedir();
const FLOW = process.env.GG_FLOW_REPO || join(HOME, 'gengrowth-flow-mvp');
const OPS = process.env.GG_OPS_DIR || join(HOME, 'gengrowth-ops');
const PLAN_DIR = process.env.GG_PLAN_DIR || join(OPS, 'inbox', '06-tasks', 'tasks');
const CLAIMS_PATH = join(PLAN_DIR, '.autopilot-claims.json');
const SCRIPTS = join(FLOW, 'tools', 'scripts');
const AUTOPILOT = join(SCRIPTS, 'gg-seo-autopilot.mjs');
const RECONCILE_STATUS = join(SCRIPTS, 'gg-reconcile-status.mjs');

const DRY = process.argv.slice(2).includes('--dry');
const APPLY = !DRY;

function loadClaims() {
  try { return JSON.parse(readFileSync(CLAIMS_PATH, 'utf8')); } catch { return {}; }
}

// node <bin> <args> 子进程；捕获 stdout+stderr（autopilot 的 log() 写 stderr，必须捕获才能
// 数出 reconcile 修正数）。超时/非零不抛（best-effort，计入汇总）。
function runNode(bin, argv, timeoutMs = 300000) {
  const r = spawnSync('node', [bin, ...argv], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  const ok = !r.error && r.status === 0;
  return {
    ok,
    out: `${r.stdout || ''}`,
    errOut: `${r.stderr || ''}`,
    err: ok ? null : String((r.error && r.error.message) || `exit ${r.status}`).slice(0, 200),
  };
}

// plan 勾选补扫：done claim 的 plan box 若仍 `- [ ]` → 勾成 `- [x]`。返回勾选数。幂等。
function sweepPlanBoxes(claims) {
  let checked = 0;
  const byPlan = new Map();
  for (const [pid, c] of Object.entries(claims)) {
    if (!c || c.status !== 'done' || !c.plan) continue;
    const list = byPlan.get(c.plan) || [];
    list.push(pid);
    byPlan.set(c.plan, list);
  }
  for (const [planName, pids] of byPlan) {
    const p = planName.includes('/') ? planName : join(PLAN_DIR, planName);
    if (!existsSync(p)) continue;
    let src = readFileSync(p, 'utf8');
    let changed = false;
    for (const pid of pids) {
      const out = src.replace(new RegExp(`(^\\s*-\\s*\\[) (\\]\\s*\`?${pid}\`?)`, 'm'), '$1x$2');
      if (out !== src) { src = out; changed = true; checked++; }
    }
    if (changed && APPLY) writeFileSync(p, src);
  }
  return checked;
}

// sheet 驱动的 plan 补勾（阶段 4 缺口修复）：sweepPlanBoxes 只扫 done claim，漏了「已上线但无 claim」
// 的文章（如经非-claim 路径 merge 的，如 WC-042/044）——它们 plan box 永不被勾。这里按 sheet「已发布」
// page_id 补勾任意 plan 里仍未勾的 box。sheet 状态是权威 live 信号（reconcile-status 已同步）。返回补勾数。
async function sweepPlanBoxesBySheet(token) {
  let checked = 0;
  let planFiles;
  try { planFiles = readdirSync(PLAN_DIR).filter((f) => /blog-output-plan.*\.md$/.test(f)).map((f) => join(PLAN_DIR, f)); }
  catch { return 0; }
  if (!planFiles.length) return checked;
  for (const key of Object.keys(PRODUCTS)) {
    let pids;
    try {
      const wb = workbookId(PRODUCTS[key]);
      const got = await gFetch(`https://sheets.googleapis.com/v4/spreadsheets/${wb}/values/${encodeURIComponent(PAGES_TAB + '!A1:AZ')}?majorDimension=ROWS`, token);
      const rows = got.values || [];
      const h = rows[0] || [];
      const iStatus = h.findIndex((c) => /^Status$/i.test((c || '').trim()));
      const iPage = h.findIndex((c) => /page_id/i.test((c || '').trim()));
      if (iStatus < 0 || iPage < 0) continue;
      pids = rows.slice(1).filter((r) => (r[iStatus] || '').trim() === PUBLISHED).map((r) => (r[iPage] || '').trim()).filter(Boolean);
    } catch { continue; } // 缺 workbook env / 网络 → 跳过该产品，不搞垮对账
    for (const pid of pids) {
      for (const p of planFiles) {
        let src;
        try { src = readFileSync(p, 'utf8'); } catch { continue; }
        const out = src.replace(new RegExp(`(^\\s*-\\s*\\[) (\\]\\s*\`?${pid}\`?)`, 'm'), '$1x$2');
        if (out !== src) { if (APPLY) writeFileSync(p, out); checked++; break; }
      }
    }
  }
  return checked;
}

async function main() {
  const t0 = Date.now();
  const summary = [];
  console.log(`=== gg-ledger-reconcile [${APPLY ? 'APPLY' : 'DRY'}] ===`);

  // 1. drainPending WAL
  let drain = { retried: 0, resolved: 0, stillPending: 0, dropped: [] };
  if (APPLY) {
    try { drain = await drainPending(); } catch (e) { drain.err = String(e.message).slice(0, 200); }
  } else {
    drain.stillPending = listWriteback().length; // dry：只报队列深度，不动
  }
  console.log(`1. drainPending: retried=${drain.retried} resolved=${drain.resolved} stillPending=${drain.stillPending} dropped=${drain.dropped?.length || 0}`);
  if (drain.resolved) summary.push(`回填补写 ${drain.resolved} 篇`);
  if (drain.dropped?.length) summary.push(`⚠️回填淘汰 ${drain.dropped.length} 篇(超限,移入 dropped/ 待人工)：${drain.dropped.map((d) => `${d.pageId}[${(d.stuck || []).join('/')}]`).join('、')}`);

  // 2. reconcile-published（ledger ↔ GitHub/live；autopilot 内部持 CLAIMS_LOCK）。仅 APPLY。
  // autopilot 每笔对账 emit `[autopilot] PUBLISHED <pgId> <slug>` 到 stderr → 数它得修正数。
  if (APPLY) {
    const r = runNode(AUTOPILOT, ['--reconcile-published']);
    const reconciled = (`${r.out}\n${r.errOut}`.match(/^\[autopilot\] PUBLISHED PG-/gim) || []).length;
    console.log(`2. reconcile-published: ${r.ok ? 'ok' : 'ERR ' + r.err} reconciled=${reconciled}`);
    if (reconciled) summary.push(`ledger 对账修正 ${reconciled} 项`);
    if (!r.ok) summary.push(`⚠️reconcile-published 失败：${r.err}`);
  } else {
    console.log('2. reconcile-published: skipped (--dry)');
  }

  // 3. reconcile-status（选题登记表 ↔ sitemap，两站）
  const rs = runNode(RECONCILE_STATUS, ['--product', 'astrologywiki,gengrowth', APPLY ? '--apply' : '--dry']);
  const flips = (rs.out.match(/^\s*FLIP\s+/gim) || []).length;
  console.log(`3. reconcile-status: ${rs.ok ? `ok flips=${flips}` : 'ERR ' + rs.err}`);
  if (flips) summary.push(`选题登记表补 flip ${flips} 行`);
  if (!rs.ok) summary.push(`⚠️reconcile-status 失败：${rs.err}`);

  // 4. plan 勾选补扫
  const claims = loadClaims();
  let planChecked = 0;
  try { planChecked = sweepPlanBoxes(claims); } catch (e) { summary.push(`⚠️plan 补扫失败：${String(e.message).slice(0, 120)}`); }
  console.log(`4. plan-sweep: checked=${planChecked}${APPLY ? '' : ' (dry, not written)'}`);
  if (planChecked && APPLY) summary.push(`plan 补勾 ${planChecked} 项`);

  // 4b. sheet 驱动补勾——catch「已上线但无 claim」的文章（阶段4 缺口，如 WC-042/044）。仅 APPLY、只读 scope。
  let planCheckedSheet = 0;
  if (APPLY) {
    try {
      const SA = process.env.GG_WRITER_SA_JSON || join(HOME, '.config', 'gg', 'gg-writer-sa.json');
      const { token } = await getAccessToken(SA, ['https://www.googleapis.com/auth/spreadsheets.readonly']);
      planCheckedSheet = await sweepPlanBoxesBySheet(token);
    } catch (e) { summary.push(`⚠️sheet-plan 补扫失败：${String(e.message).slice(0, 100)}`); }
  }
  console.log(`4b. plan-sweep(sheet-driven, 无claim): checked=${planCheckedSheet}`);
  if (planCheckedSheet) summary.push(`plan 补勾(无claim已上线) ${planCheckedSheet} 项`);

  // ledger 观测（不写，仅报）：needs_human 常驻数
  const needsHuman = Object.entries(claims).filter(([, c]) => c && c.status === 'needs_human').map(([k]) => k);
  console.log(`ledger: total=${Object.keys(claims).length} needs_human=${needsHuman.length}${needsHuman.length ? ' [' + needsHuman.join(',') + ']' : ''}`);

  // 5. 汇总通知（有漂移才推；无漂移静默——不刷屏）
  const dur = Math.round((Date.now() - t0) / 1000);
  console.log(`=== done in ${dur}s — ${summary.length ? summary.join('；') : '无漂移'} ===`);
  if (APPLY && summary.length) {
    const text = `🧾 每日账本对账：${summary.join('；')}` + (needsHuman.length ? `；needs_human ${needsHuman.length}` : '');
    try { await notify('batch_summary', { text, partial: false }); } catch { /* notify 永不搞垮对账 */ }
  }
}

main().catch((e) => { process.stderr.write(`gg-ledger-reconcile: ${e.stack || e.message}\n`); process.exit(1); });
