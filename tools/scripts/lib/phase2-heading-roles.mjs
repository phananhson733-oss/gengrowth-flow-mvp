export function hasEnComparisonHeading(draft) {
  const headings = String(draft || '').match(/^##\s+[^\n]+$/gm) || [];
  return headings.some((heading) => {
    if (/\bAdjacent Concepts\b/i.test(heading)) return false;
    return /\b(vs\.?|versus)\b/i.test(heading)
      || /^##\s+How\s+[^\n]*\bDiffers?\b/i.test(heading);
  });
}
