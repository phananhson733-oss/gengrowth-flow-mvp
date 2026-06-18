// worker-cwd.mjs — a clean working directory for headless LLM author/repair workers, OUTSIDE any repo.
//
// WHY: a worker spawned with cwd INSIDE the repo inherits the project CLAUDE.md / AGENTS.md / GEMINI.md.
// The repo's interactive rules (对话记录维护规则 / 会话提醒规则 / skill routing) leaked into `claude -p`
// and made it intermittently emit meta-commentary ("文章已输出，对话记录已静默追加…" + a fix-summary
// list) INSTEAD of the article — a no-H1 garbage draft that phase2 aborts on ("draft has no H1"). The
// author/repair worker is TEXT-ONLY (prompt on stdin, article on stdout) so it needs no repo cwd; running
// it from an empty dir outside the repo means the CLI discovers no project instruction file. Resolve +
// ensure the dir once at import. (A user-level ~/.claude/CLAUDE.md, if present, still loads — keep that
// file free of authoring-time directives.)

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const WORKER_CWD = join(tmpdir(), 'gg-llm-worker-cwd');
try { mkdirSync(WORKER_CWD, { recursive: true }); } catch { /* best-effort; an ENOENT cwd just fails the spawn → retry/park */ }

export default WORKER_CWD;
