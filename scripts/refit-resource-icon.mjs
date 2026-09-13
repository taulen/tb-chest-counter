/**
 * Re-extracts a single resource icon template with correct framing.
 *
 * Why this exists: NCC template matching (src/vision/resource-ocr.ts) compares a
 * *square* crop of the history row against a 48×48 template. It tolerates scale
 * and brightness differences, but not aspect distortion — the matcher only ever
 * varies the crop's side length, so a template whose icon has been squashed into
 * a square can never align with a real row. `boards.png` was exactly that: a
 * 64×50 icon (1.28:1) stretched to fill 48×48, which capped its score at ~0.83
 * against a 0.68 threshold while every other resource scored 1.0–1.25.
 *
 * The fix is to crop a SQUARE region around the icon, sized so the icon fills
 * ~92 % of the width — the fill fraction measured on real production crops — and
 * let the aspect ratio survive the resize to 48×48.
 *
 * Usage:
 *   node scripts/refit-resource-icon.mjs <slug> <source.jpg> <x0> <y0> <x1> <y1>
 *
 *   x0..y1 bound a search window that contains the icon and nothing else
 *   (no label text, no slot placeholder circle). The icon footprint is detected
 *   inside it by colour distance from the window's background corner.
 *
 * Example (Boards, from the "Select a resource" modal):
 *   node scripts/refit-resource-icon.mjs boards data/screenshots/IMG_7640_preview.jpeg 265 1625 365 1720
 */

import sharp from 'sharp';
import path from 'path';
import fs from 'fs';

const WIDTH_FILL = 0.92;  // icon width / crop side, measured on production crops
const OUT_SIZE = 48;
const BG_DISTANCE = 50;   // colour distance from background that counts as icon

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const [slug, source, ...box] = argv.filter((a) => !a.startsWith('--'));
if (!slug || !source || box.length !== 4) {
  console.error('usage: node scripts/refit-resource-icon.mjs [--dry-run] <slug> <source> <x0> <y0> <x1> <y1>');
  process.exit(1);
}
const [wx0, wy0, wx1, wy1] = box.map(Number);
const W = wx1 - wx0;
const H = wy1 - wy0;

const { data } = await sharp(source)
  .extract({ left: wx0, top: wy0, width: W, height: H })
  .removeAlpha().raw().toBuffer({ resolveWithObject: true });

const at = (x, y) => [data[(y * W + x) * 3], data[(y * W + x) * 3 + 1], data[(y * W + x) * 3 + 2]];
const bg = at(1, 1);

let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const c = at(x, y);
    if (Math.hypot(c[0] - bg[0], c[1] - bg[1], c[2] - bg[2]) > BG_DISTANCE) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
}
if (x1 < 0) { console.error('no icon found in the search window'); process.exit(1); }

const iconW = x1 - x0 + 1;
const iconH = y1 - y0 + 1;
if (x0 === 0 || y0 === 0 || x1 === W - 1 || y1 === H - 1) {
  console.warn(`⚠ icon footprint touches the search-window edge (${iconW}×${iconH}) — ` +
               'the window probably clips the icon or includes neighbouring content');
}

const cx = wx0 + x0 + iconW / 2;
const cy = wy0 + y0 + iconH / 2;
const side = Math.round(iconW / WIDTH_FILL);
const left = Math.round(cx - side / 2);
const top = Math.round(cy - side / 2);

console.log(`icon footprint  ${iconW}×${iconH}  (aspect ${(iconW / iconH).toFixed(2)}) at ${wx0 + x0},${wy0 + y0}`);
console.log(`square crop     ${side}×${side} at ${left},${top}`);

const outFile = path.resolve(
  dryRun ? path.join('data', 'icon-diagnostic') : path.join('assets', 'resource-icons'),
  `${slug}.png`,
);
if (dryRun) fs.mkdirSync(path.dirname(outFile), { recursive: true });

await sharp(source)
  .extract({ left, top, width: side, height: side })
  .resize(OUT_SIZE, OUT_SIZE, { fit: 'fill', kernel: 'lanczos3' })
  .png()
  .toFile(outFile);

console.log(`wrote           ${path.relative(process.cwd(), outFile)}${dryRun ? '  (dry run)' : ''}`);

// Deliberately does NOT touch assets/resource-icons-reference/. That directory is
// the backup that makes a bad extraction run recoverable (`cp
// assets/resource-icons-reference/*.png assets/resource-icons/`) — if this script
// mirrored into it, the safety net would be gone. Promote a validated set by hand.
