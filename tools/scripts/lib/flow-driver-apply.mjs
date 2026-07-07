// lib/flow-driver-apply.mjs — P1.5 接侧效。buildActionCommands: park+action→确切命令(纯,可测);
// driveApply: 编排(deps 注入,side-effect 在边界)。总纲:控制流确定性,门做保证,子进程只在边界。
import { join } from 'node:path';

const SCRIPTS = new URL('.', import.meta.url).pathname.replace(/\/lib\/$/, '');
const AUTOPILOT = join(SCRIPTS, 'gg-seo-autopilot.mjs');
const PREVIEW_GATE = join(SCRIPTS, 'gg-preview-gate.mjs');
const NOTIFY = join(SCRIPTS, 'gg-notify.mjs');

// gate 阶段(有 PR/branch,可重过门自修) vs authoring 阶段(无门)。
const GATE_STAGES = new Set(['pushed-preview', 'verified-preview']);

export function buildActionCommands(park, cfg) {
  const { pid, action, slug = '', stage = '', branch = '', reason = '' } = park;
  if (action === 'retry') {
    return { kind: 'retry-skip', commands: [], skipReason: 'transient — 现有 --auto-retry-parks lane owns' };
  }
  if (action === 'archive') {
    return {
      kind: 'archive',
      commands: [{ bin: NOTIFY, args: ['parked', '--site', cfg.site, '--pid', pid, '--slug', slug, '--reason', reason || 'archived: unfixable(时效死/不该发)'] }],
    };
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
  const s = { fixed: 0, fixFailed: 0, archived: 0, retryDeferred: 0, fixSkipped: 0, capped: 0 };
  let fixCount = 0, archiveCount = 0;
  for (const park of plan || []) {
    const built = buildActionCommands(park, deps.cfg);
    if (built.kind === 'retry-skip') { s.retryDeferred++; deps.log(`${park.pid} retry → 交现有 auto-retry lane`); continue; }
    if (built.kind === 'fix-skip') { s.fixSkipped++; deps.log(`${park.pid} fix-skip: ${built.skipReason}`); continue; }
    if (built.kind === 'archive') {
      if (archiveCount >= deps.maxArchive) { s.capped++; deps.log(`${park.pid} archive capped(>${deps.maxArchive})`); continue; }
      archiveCount++;
      const r = await deps.run(built.commands[0]);
      if (r.ok) s.archived++; else deps.log(`${park.pid} archive notify 失败 code=${r.code}`);
      continue;
    }
    if (built.kind === 'fix') {
      if (fixCount >= deps.maxFix) { s.capped++; deps.log(`${park.pid} fix capped(>${deps.maxFix},下轮再处理)`); continue; }
      fixCount++;
      let ok = true;
      for (const cmd of built.commands) { const r = await deps.run(cmd); if (!r.ok) { ok = false; break; } }
      if (ok) { s.fixed++; deps.log(`${park.pid} fix → 重过门(门做保证,PASS 才 merge)`); }
      else { s.fixFailed++; deps.log(`${park.pid} fix 失败(门未过或工具错)——留 needs_human`); }
      continue;
    }
  }
  return s;
}
