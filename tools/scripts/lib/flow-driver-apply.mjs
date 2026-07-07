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
