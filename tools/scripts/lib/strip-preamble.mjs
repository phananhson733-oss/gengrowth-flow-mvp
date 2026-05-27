// strip-preamble.mjs — drop any chatbot preamble before the first H1.
//
// A generation sub-CLI (e.g. `claude -p`) spawned inside an interactive session
// can inherit UserPromptSubmit hooks (skill-injection etc.) and emit a few lines
// of meta-commentary BEFORE the article's `# H1` (observed: "Looking at this,
// the message is a fully-rendered prompt... Here is the article:"). That text is
// not article content: it inflates word counts and slips past the anti-fluff
// check (which only scans BETWEEN H1 and the first H2). We normalize by dropping
// everything before the first H1 line.
//
// Pure Node — no deps.

// First H1 = a line `# <content>` (single leading hash + space + non-space).
// `## ` (H2) does not match because the char after the first `#` is `#`, not space.
const H1_LINE_REGEX = /^#[ \t]+\S/;

// Returns md unchanged when it already starts at the H1 (idx 0) or has no H1 at
// all (let the structure check own the "no H1" failure). Otherwise returns the
// slice from the first H1 line onward.
export function stripPreH1(md) {
  if (typeof md !== 'string' || !md) return md;
  const lines = md.split('\n');
  const idx = lines.findIndex((l) => H1_LINE_REGEX.test(l));
  if (idx <= 0) return md;
  return lines.slice(idx).join('\n');
}
