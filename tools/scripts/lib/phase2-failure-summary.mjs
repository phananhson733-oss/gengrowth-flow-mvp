export function summarizePhase2Failure(error, { limit = 8 } = {}) {
  const stdout = String(error?.stdout || '');
  const stderr = String(error?.stderr || '');
  const combined = `${stdout}\n${stderr}`;
  const failures = [];
  const seen = new Set();

  for (const match of combined.matchAll(/✗\s*(?:FAIL\s*)?([^\n]+)/g)) {
    const detail = String(match[1] || '').trim();
    if (!detail || seen.has(detail)) continue;
    seen.add(detail);
    failures.push(`- ${detail}`);
    if (failures.length >= limit) break;
  }
  if (failures.length) return failures.join('\n');

  const diagnostic = combined
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\[phase2\]\s+loaded fixture:/i.test(line))
    .filter((line) => !/^phase2 failed$/i.test(line))
    .slice(-3)
    .join(' | ');

  return diagnostic
    ? `- phase2 exited non-zero: ${diagnostic}`
    : '- phase2 exited non-zero without an actionable failure detail';
}
