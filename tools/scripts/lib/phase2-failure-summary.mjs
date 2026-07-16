export function summarizePhase2Failure(error, { limit = 8 } = {}) {
  const stdout = String(error?.stdout || '');
  const stderr = String(error?.stderr || '');
  const combined = `${stdout}\n${stderr}`;
  const failures = [];
  const seen = new Set();

  const pushFailure = (raw) => {
    const detail = String(raw || '').trim().replace(/^-\s+/, '');
    if (!detail || seen.has(detail)) return;
    seen.add(detail);
    failures.push(`- ${detail}`);
  };

  let inFailBlock = false;
  for (const line of combined.split('\n')) {
    const failStart = line.match(/^\s*✗\s*(?:FAIL\b\s*)?(.*)$/);
    if (failStart) {
      inFailBlock = true;
      pushFailure(failStart[1]);
    } else if (inFailBlock) {
      const bullet = line.match(/^\s*-\s+(.+)$/);
      if (bullet) pushFailure(bullet[1]);
      else if (/^\s*(?:▸|[✓⚠ⓘ✗]|━)/.test(line)) inFailBlock = false;
    }
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
