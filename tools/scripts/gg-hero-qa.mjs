#!/usr/bin/env node
// gg-hero-qa.mjs — cheap deterministic quality gate for an autopilot-generated
// hero JPEG. It is a BACKSTOP, not a replacement for human eyes: it catches the
// two failure modes that recur with diffusion heroes and are detectable without
// a vision model —
//   (1) wrong dimensions / empty-ish file (gen returned nothing usable)
//   (2) a hard vertical "diptych" seam down the centre (the model split the
//       canvas into two half-images, the single most common defect observed
//       across the 2026-06-10 backfill of 89 heroes).
// Subtle compositional issues are NOT caught here — the generation prompt's
// "one continuous scene, no split" clause is the first line of defence; this
// gate is the automated second line for unattended cron runs.
//
// Usage: node gg-hero-qa.mjs <hero.jpg> [--json]
// Exit 0 = pass, 1 = fail (reason on stderr / in JSON).

import sharp from 'sharp';

const file = process.argv[2];
const asJson = process.argv.includes('--json');
if (!file) { console.error('usage: gg-hero-qa.mjs <hero.jpg> [--json]'); process.exit(2); }

const EXPECT_W = 1200, EXPECT_H = 675;        // the optimize() target ratio
const MIN_BYTES = 20_000;                     // below this, generation effectively failed

function out(ok, reason, extra = {}) {
  const r = { ok, reason, ...extra };
  if (asJson) console.log(JSON.stringify(r));
  else console.error(`${ok ? 'PASS' : 'FAIL'}: ${reason}`);
  process.exit(ok ? 0 : 1);
}

try {
  const fs = await import('node:fs');
  const bytes = fs.statSync(file).size;
  if (bytes < MIN_BYTES) out(false, `file too small (${bytes}B) — generation likely empty`, { bytes });

  const meta = await sharp(file).metadata();
  if (meta.width !== EXPECT_W || meta.height !== EXPECT_H) {
    out(false, `unexpected dimensions ${meta.width}x${meta.height} (want ${EXPECT_W}x${EXPECT_H})`, { width: meta.width, height: meta.height });
  }

  // Downscale to a small grayscale buffer for a fast seam analysis.
  const W = 240, H = 135;
  const raw = await sharp(file).resize(W, H, { fit: 'fill' }).grayscale().raw().toBuffer();
  const at = (x, y) => raw[y * W + x];

  // For each column, mean absolute horizontal gradient |col[x+1]-col[x-1]| over rows.
  const colGrad = new Array(W).fill(0);
  for (let x = 1; x < W - 1; x++) {
    let s = 0;
    for (let y = 0; y < H; y++) s += Math.abs(at(x + 1, y) - at(x - 1, y));
    colGrad[x] = s / H;
  }
  // Robust baseline = median of interior column gradients.
  const interior = colGrad.slice(4, W - 4).slice().sort((a, b) => a - b);
  const median = interior[Math.floor(interior.length / 2)] || 1;

  // A diptych seam is a TALL, NARROW vertical discontinuity near the centre.
  // Scan a small band around x=W/2 for the strongest column, and measure both its
  // prominence over the median AND how consistently the seam runs top-to-bottom.
  const cx = Math.floor(W / 2);
  let seamX = cx, seamVal = 0;
  for (let x = cx - 6; x <= cx + 6; x++) { if (colGrad[x] > seamVal) { seamVal = colGrad[x]; seamX = x; } }
  // Fraction of rows where the centre column transition is a sharp local edge.
  let sharpRows = 0;
  for (let y = 0; y < H; y++) {
    const g = Math.abs(at(seamX + 1, y) - at(seamX - 1, y));
    if (g > 28) sharpRows++;          // ~11% luminance step
  }
  const seamRowFrac = sharpRows / H;
  const prominence = seamVal / median;

  // Flag only when BOTH: the centre band is a strong outlier vs the picture's
  // texture AND the seam runs down most of the frame (a real split, not just a
  // central subject like a moon).
  const isSeam = prominence >= 3.0 && seamRowFrac >= 0.55;
  if (isSeam) {
    out(false, `likely centre diptych seam at x≈${Math.round((seamX / W) * EXPECT_W)} (prominence ${prominence.toFixed(1)}×, ${Math.round(seamRowFrac * 100)}% of rows)`,
      { seamProminence: +prominence.toFixed(2), seamRowFrac: +seamRowFrac.toFixed(2) });
  }
  out(true, `ok (${meta.width}x${meta.height}, ${Math.round(bytes / 1024)}KB, seam ${prominence.toFixed(1)}×/${Math.round(seamRowFrac * 100)}%)`,
    { bytes, seamProminence: +prominence.toFixed(2), seamRowFrac: +seamRowFrac.toFixed(2) });
} catch (e) {
  out(false, `qa error: ${e.message}`);
}
