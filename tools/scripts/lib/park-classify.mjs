// lib/park-classify.mjs — 把 needs_human park 分为 transient(工具没跑成，可自动重试) vs
// permanent(判决/结构问题，需人工)。阶段 6：只对 transient 自动重试，让 LLM 用量窗口造成的
// 临时失败自愈，而绝不重试"评审/codex 跑完并判坏"的稿（否则 fluke-PASS 会把事实错内容发上线）。
//
// 核心原则（评审 BLOCKING 修正）：按"**判决 vs 工具没跑成**"分——
//   · FAIL 判决(review[..]/codex/phase2 完成并判坏) → permanent（工具跑了、说内容不行）。
//   · exit/SKIPPED/could-not-complete/no-output/timeout/quota/network → transient（工具根本没跑成）。
// permanent-first 顺序：判决/结构问题优先，压过 reason 自由文本里同现的任何工具子串。
// 只用无歧义的工具/配额信号做 transient——绝不含裸数字/泛用词（50x/overloaded/tim…out 会误撞内容 prose）。
// 未知/无 error 一律 permanent（宁可漏自愈，不可误重试）。

// permanent：判决类失败(用流水线真实字符串正向匹配) + 事实/合规 + 结构/登记问题。
const PERMANENT_RE = new RegExp([
  'review\\[[^\\]]*\\]\\s*FAIL',        // review[astrology] FAIL: …  (gg-preview-gate 真实评审判错格式)
  'codex[^\\n]*\\bFAIL\\b',             // codex completed with codex FAIL — …
  'codex completed with',
  'VERDICT:\\s*FAIL',
  'phase2 FAIL',                        // phase2 判决(含 no-H1)：安全起见判永久，不自动重试判过的稿
  'reviewer\\s+FAIL', 'factual\\s+FAIL',
  'protected fact', '广告法', '违禁词',
  // 结构/登记问题——**锚定到判决上下文**（评审：裸 `schema` 会撞 `review[schema]` 维度标签本身、
  // 撞 Zod/Ajv 崩溃栈里的 "schema"，把真 transient 工具崩(review[schema] SKIPPED)冻成 permanent；
  // 裸 `no row` 会撞 "no rows (ETIMEDOUT)" 的读表抖动。真 schema 判错=review[schema] FAIL 已被上面覆盖）。
  '选题登记表', 'missing pillars?', 'not found in plan', 'schema\\s+(?:FAIL|invalid|validation)', 'assoc_keywords', '需(?:人工|登记)',
  'no rows?\\b[^\\n]*选题登记表',
].join('|'), 'i');

// transient：工具"没跑成"——退出码 / SKIPPED / 无法完成 / 无产出 / 超时 / 配额 / 网络。
// 只认无歧义信号；HTTP 50x 锚定 HTTP，超时用完整 timed out/timeout(不用会撞 "runtime out" 的分裂形)。
const TRANSIENT_RE = new RegExp([
  'codex exited \\d',                   // 工具退出码(非 "codex FAIL" 判决)
  'codex[^\\n]*could not complete',
  '(?:session|usage)\\s*limit', 'hit your (?:usage|session)',
  'SKIPPED:\\s*tooling', 'worker exited \\d',
  'produced no draft',                  // 编排器无产出(非对稿判错)
  // CTA Map 重复键在 bridge 中有 first-row-wins 契约；不涉及内容事实，交给有上限的重试。
  'CTA Map has \\d+ duplicate \\(page_role, track\\) pairs[^\\n]*first row wins',
  '\\bdeadlock\\b', 'no CPU/output progress',
  '\\btimed out\\b', '\\btimeout\\b', 'ETIMEDOUT', 'preview-wait[^\\n]*timeout',
  '\\bquota\\b', 'rate.?limit', 'HTTP\\s*50[234]\\b', 'ECONNRESET', 'ENETUNREACH', 'socket hang up',
].join('|'), 'i');

// 返回 'transient' | 'permanent'。入参可为 claim 对象或 error 字符串。
export function classifyPark(claimOrError) {
  const err = typeof claimOrError === 'string'
    ? claimOrError
    : String((claimOrError && claimOrError.error) || '');
  if (!err.trim()) return 'permanent';          // 无错误信息 → 保守人工
  if (PERMANENT_RE.test(err)) return 'permanent'; // 判决/结构问题优先（压过同现工具子串）
  if (TRANSIENT_RE.test(err)) return 'transient';
  return 'permanent';                            // 未知 → 保守人工，绝不自动重试
}

export const isTransientPark = (claimOrError) => classifyPark(claimOrError) === 'transient';

// unfixable：改稿救不了的死选题。**只认评审/codex 明确写下的"这个选题不该发"的元判决**——
// 绝不认对事件状态的描述（already played / event passed / match is over / no longer upcoming / event
// date passed …）。因为对抗评审证实：那些与"你把事件的时态/日期写错了"式**可改稿** FAIL 用正则无法
// 区分（"you say the match already occurred June 3, but it's July 20 — fix the tense" 会被误判 archive
// →P2 接侧效后静默丢掉一篇只需改个日期的可发稿）。
// 安全方向：默认一律 fixable（误修不可修稿 = 空跑几次门后 park 交人工；误 archive 可修稿 = 静默丢稿，更坏）。
// 非显式标记的真 stale（如 "match played July 6, before-kickoff false" 无 "stale topic" 字样）会落到
// fixable → 送回门自修。**当前(P1.5)对这类的 staleness 兜底 = 门里的 codex 事实核**（codex 会抓出
// 时态/日期过期并 FAIL，稿不会 merge）；代价 = 空跑一轮门(~10min)。**LLM stale 预判(自修前拦截、省这轮门)
// 是 P1.6 的增强，尚未实现**（spec §4.2：正则只做显式快路径,深判交 LLM——P1.6 落地）。
// WC-045 真 error 含 "stale topic" + "prediction expired" + "DO NOT PUBLISH" → 三重命中，稳判 archive。
export const UNFIXABLE_RE = new RegExp([
  '\\bstale topic\\b', 'topic (?:is )?(?:stale|expired|dead)',
  'do not publish', "don['’]?t publish", 'must not (?:be )?publish', '(?:not|no longer) worth publishing',
  '(?:prediction|forecast|preview|selection) (?:is |has )?expired', 'expired (?:prediction|forecast|preview)',
  'already published (?:elsewhere|before)',
].join('|'), 'i');

// 三分诊（driver 用）：transient(工具没跑成→retry) / unfixable(时效死→archive) / fixable(可改稿→自修)。
// 顺序：先 transient(工具层)，再 unfixable(内容死)，其余判决类 FAIL 归 fixable。无 error → unfixable(交人工)。
export function triagePark(claimOrError) {
  const err = typeof claimOrError === 'string'
    ? claimOrError
    : String((claimOrError && claimOrError.error) || '');
  if (!err.trim()) return 'unfixable';
  if (classifyPark(err) === 'transient') return 'transient';
  if (UNFIXABLE_RE.test(err)) return 'unfixable';
  return 'fixable';
}
