// tools/scripts/lib/merge-union.mjs — deterministic union-resolution of the two ADDITIVE
// registration files during an oracle publish merge (阶段 3 · 串行发布强制).
//
// Why this exists (审计根因 = LLM_CONVENTION):
//   oracle 发布 merge 已被 CLAIMS_LOCK 串行化（gg-seo-autopilot.mjs doMerge），但一个从较旧
//   origin/main 切出的分支，若期间另一次 merge 追加了同样的两个注册文件
//   （data/articles/index.ts + scripts/generate-seo-pages.mjs 的 ARTICLE_SLUGS_EN_ONLY），
//   `gh pr merge` 会在这两个 additive 追加点上冲突 → 历史上 park 成 needs_human，靠人手动
//   `git merge origin/main` + `git merge-file --union` 清（见 memory "Merge-conflict cascade"）。
//   本模块把那套手动修复编码成确定性代码，让"已串行的 merge"自愈——workflow 保证，不靠人记得。
//
// 安全边界（绝不 ship 未评审内容）：
//   只有这两个 additive 注册文件允许 union-merge。任何其它文件冲突都意味着 main 改动了
//   被评审文章依赖的东西 → 调用方必须 abort + park。union 之后调用方还要断言文章自身字节
//   与 reviewed head 一致，并跑 build gate，才允许 push+merge。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 发布 merge 唯一允许 union 的两个 additive 注册文件（相对 repo 根）。 */
export const ORACLE_ADDITIVE_FILES = Object.freeze([
  'data/articles/index.ts',
  'scripts/generate-seo-pages.mjs',
]);

/**
 * 判断一次 `gh pr merge` 失败文本是否像"不可合并 / 冲突"（而非 auth/网络/head 漂移）。
 * 仅当像冲突时才触发 union 自愈；其它错误原样抛出，让 claim park 出真实原因。
 */
export function looksLikeMergeConflict(errText) {
  const s = String(errText || '').toLowerCase();
  return /not mergeable|is not mergeable|not in a mergeable state|merge conflict|conflict with the base|failed to merge|merge commit cannot be cleanly created|pull request is not mergeable/.test(s);
}

/** 文本是否仍残留 git 冲突标记。 */
export function hasConflictMarkers(text) {
  return /^(<{7}|={7}|>{7}|\|{7})/m.test(String(text || ''));
}

/**
 * union-resolve 单个冲突文件文本（以 merge.conflictStyle=merge 的 2-way 标记产生）：
 *   <<<<<<< ours … ======= … >>>>>>> theirs  →  两侧都保留，只删标记行。
 * 同时容忍 diff3（|||||||）：丢弃 base 段，union 只保留 ours+theirs。
 * 返回已解析文本；若仍残留标记则抛错（防御，正常不该发生）。
 */
export function unionResolveConflictedText(text) {
  const lines = String(text).split('\n');
  const out = [];
  let section = 'keep'; // keep | ours | base | theirs
  for (const ln of lines) {
    if (/^<{7}(\s|$)/.test(ln)) { section = 'ours'; continue; }
    if (/^\|{7}(\s|$)/.test(ln)) { section = 'base'; continue; }
    if (/^={7}(\s|$)/.test(ln)) { section = 'theirs'; continue; }
    if (/^>{7}(\s|$)/.test(ln)) { section = 'keep'; continue; }
    if (section === 'base') continue; // 丢弃 base 段——union 只留 ours+theirs
    out.push(ln);
  }
  const resolved = out.join('\n');
  if (hasConflictMarkers(resolved)) throw new Error('union-resolve left conflict markers');
  return resolved;
}

/**
 * 把一组冲突路径分类：仅当每个冲突路径都属于 additive 文件时 ok。
 * 返回 { ok, offending }。offending 非空 = 有不允许 union 的文件冲突。
 */
export function classifyConflicts(conflictedPaths, additiveFiles = ORACLE_ADDITIVE_FILES) {
  const set = new Set(additiveFiles);
  const offending = (conflictedPaths || []).filter((p) => !set.has(p));
  return { ok: offending.length === 0, offending };
}

function defaultGit(wt, args) {
  return execFileSync('git', ['-C', wt, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * 在已 checkout 到 reviewed 分支 tip 的 worktree `wt` 里，把 `ontoRef`（如 'origin/main'）merge 进来，
 * 冲突时只对 additive 文件做 union-resolve。返回：
 *   { merged:true,  conflicted:[]  } — 干净 auto-merge（生成 merge commit）
 *   { merged:true,  conflicted:[…] } — additive-only 冲突：union+add+commit（生成 merge commit）
 *   { merged:false, conflicted:[]  } — ontoRef 已是祖先，无需 merge（无新 commit）
 * 非 additive 冲突 → `git merge --abort` + 抛错（调用方 park）。
 * 强制 merge.conflictStyle=merge，使 union 解析与用户 git 配置无关、确定。
 * git 命令可注入（测试用）；默认走 execFileSync。
 */
export function unionMergeIntoWorktree(wt, ontoRef, { additiveFiles = ORACLE_ADDITIVE_FILES, git = defaultGit } = {}) {
  const before = git(wt, ['rev-parse', 'HEAD']).trim();
  const onto = git(wt, ['rev-parse', ontoRef]).trim();
  try {
    git(wt, ['merge-base', '--is-ancestor', onto, before]);
    return { merged: false, conflicted: [] }; // onto 已是祖先 → 分支已含 main
  } catch { /* 不是祖先 → 需要 merge */ }

  try {
    git(wt, ['-c', 'merge.conflictStyle=merge', 'merge', '--no-edit', '--no-ff', ontoRef]);
    return { merged: true, conflicted: [] };
  } catch {
    const conflicted = git(wt, ['diff', '--name-only', '--diff-filter=U'])
      .split('\n').map((s) => s.trim()).filter(Boolean);
    const { ok, offending } = classifyConflicts(conflicted, additiveFiles);
    if (conflicted.length === 0 || !ok) {
      try { git(wt, ['merge', '--abort']); } catch { /* best-effort */ }
      throw new Error(
        conflicted.length === 0
          ? `merge of ${ontoRef} failed with no conflicted paths (unexpected)`
          : `refusing union-merge: non-additive conflict in ${offending.join(', ')} (only ${additiveFiles.join('/')} may union-merge)`,
      );
    }
    for (const f of conflicted) {
      const abs = join(wt, f);
      writeFileSync(abs, unionResolveConflictedText(readFileSync(abs, 'utf8')));
      git(wt, ['add', f]);
    }
    git(wt, ['commit', '--no-edit']);
    return { merged: true, conflicted };
  }
}
