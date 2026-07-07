// lib/flow-driver-apply.mjs — P1.5 接侧效。buildActionCommands: park+action→确切命令(纯,可测);
// driveApply: 编排(deps 注入,side-effect 在边界)。总纲:控制流确定性,门做保证,子进程只在边界。
import { join } from 'node:path';

const SCRIPTS = new URL('.', import.meta.url).pathname.replace(/\/lib\/$/, '');
const AUTOPILOT = join(SCRIPTS, 'gg-seo-autopilot.mjs');
const PREVIEW_GATE = join(SCRIPTS, 'gg-preview-gate.mjs');

// gate 阶段(有 PR/branch,可重过门自修) vs authoring 阶段(无门)。
const GATE_STAGES = new Set(['pushed-preview', 'verified-preview']);

export function buildActionCommands(park, cfg) {
  const { pid, action, slug = '', stage = '', branch = '', reason = '' } = park;
  if (action === 'retry') {
    return { kind: 'retry-skip', commands: [], skipReason: 'transient — 现有 --auto-retry-parks lane owns' };
  }
  if (action === 'archive') {
    // sidecar-only：不再 per-park 派 gg-notify(避免刷屏)——archive 只记 sidecar,终态进每轮一条汇总。
    return { kind: 'archive', commands: [] };
  }
  if (action === 'fix') {
    if (!branch || !GATE_STAGES.has(stage)) {
      return { kind: 'fix-skip', commands: [], skipReason: `fixable 但 ${stage || 'no'} 阶段无 branch/门可重跑(authoring→交现有 re-author)` };
    }
    return {
      kind: 'fix',
      commands: [
        { bin: AUTOPILOT, args: ['--retry-failed', '--branch', branch] },
        { bin: PREVIEW_GATE, args: ['--branch', branch, '--repo', cfg.repo] },
      ],
    };
  }
  return { kind: 'unknown', commands: [], skipReason: `未知 action ${action}` };
}

// 有界编排：逐 park 派动作,side-effect 走 deps.run(cmd)→{ok,code}。maxFix/maxArchive 限爆炸半径。
// deps = { run(cmd)->Promise<{ok,code}>, log(msg), cfg:{repo,site}, maxFix, maxArchive }。
export async function driveApply(plan, deps) {
  const s = { fixed: 0, fixFailed: 0, archived: 0, archiveSkipped: 0, retryDeferred: 0, fixSkipped: 0, capped: 0, archivedSlugs: [], fixedSlugs: [], fixFailedSlugs: [] };
  let fixCount = 0, archiveCount = 0;
  for (const park of plan || []) {
    const built = buildActionCommands(park, deps.cfg);
    if (built.kind === 'retry-skip') { s.retryDeferred++; deps.log(`${park.pid} retry → 交现有 auto-retry lane`); continue; }
    if (built.kind === 'fix-skip') { s.fixSkipped++; deps.log(`${park.pid} fix-skip: ${built.skipReason}`); continue; }
    if (built.kind === 'archive') {
      // 幂等：已归档过的 park 不重复通知(否则每次 --apply 都重挑同一 needs_human→飞书刷屏、死选题永不退休)。
      if (deps.isArchived && deps.isArchived(park.pid)) { s.archiveSkipped++; deps.log(`${park.pid} 已归档过 → 跳过(幂等)`); continue; }
      if (archiveCount >= deps.maxArchive) { s.capped++; deps.log(`${park.pid} archive capped(>${deps.maxArchive})`); continue; }
      archiveCount++;
      // sidecar-only：不 spawn 通知,只记 sidecar(退出 driver 队列)+进本轮汇总。
      if (deps.markArchived) deps.markArchived(park.pid);
      s.archived++; s.archivedSlugs.push(park.slug || park.pid);
      deps.log(`${park.pid} archived(记 sidecar,退出队列)`);
      continue;
    }
    if (built.kind === 'fix') {
      if (fixCount >= deps.maxFix) { s.capped++; deps.log(`${park.pid} fix capped(>${deps.maxFix},下轮再处理)`); continue; }
      fixCount++;
      let ok = true;
      for (const cmd of built.commands) { const r = await deps.run(cmd); if (!r.ok) { ok = false; break; } }
      if (ok) { s.fixed++; s.fixedSlugs.push(park.slug || park.pid); deps.log(`${park.pid} fix → 重过门(门做保证,PASS 才 merge)`); }
      else { s.fixFailed++; s.fixFailedSlugs.push(park.slug || park.pid); deps.log(`${park.pid} fix 失败(门未过或工具错)——留 needs_human`); }
      continue;
    }
  }
  return s;
}

// 每轮一条终态汇总(仅有 fixed/archived/fixFailed 时);无终态→空串(tick 据此决定发不发)。
export function buildSummaryMessage(s, site) {
  if (!(s.fixed || s.archived || s.fixFailed)) return '';
  const parts = [`flow-driver [${site}]`];
  if (s.fixed) parts.push(`自修上线 ${s.fixed}(${s.fixedSlugs.join(', ')})`);
  if (s.archived) parts.push(`归档 ${s.archived}(${s.archivedSlugs.join(', ')})`);
  if (s.fixFailed) parts.push(`修失败留 needs_human ${s.fixFailed}(${s.fixFailedSlugs.join(', ')})`);
  return parts.join('；');
}
