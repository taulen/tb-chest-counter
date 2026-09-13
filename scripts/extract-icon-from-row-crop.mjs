/**
 * Cuts a resource-icon template out of an UNRESOLVED ROW CROP.
 *
 * Companion to refit-resource-icon.mjs, for the case that script cannot serve: a
 * resource the game has only just added. There is no "Select a resource" modal
 * screenshot for it — the ones in data/screenshots predate it — so the only image
 * of the icon that exists anywhere is the evidence crop the importer wrote when it
 * failed to match the row (data/exports/resource_unresolved/*.png). That is how
 * Religious Tractates was added, and how the next one will be.
 *
 *   node scripts/extract-icon-from-row-crop.mjs [--dry-run] <slug> <row-crop.png>
 *
 * The crop is BETTER provenance than the modal, not worse. It is a slice of the
 * exact canonical 1000px-wide buffer the matcher scores against, so the icon is
 * already at production scale and needs no guessing — which is the failure the
 * torch-of-olympus template documents at length (loadTemplates in
 * src/vision/resource-ocr.ts): a template cut from artwork sat at half the linear
 * size of a real row and silently lost every row to a look-alike.
 *
 * Two things about a row crop have to be handled, and both are why this isn't just
 * refit-resource-icon.mjs with a different window:
 *
 *   • The orange highlight. saveUnresolvedRowCrop draws a #e8562a rectangle over
 *     the crop to tell the admin which row is the subject. Its top and bottom
 *     strokes run straight through the padding either side of the icon — inside
 *     the square this needs to cut. They are repainted with the row background
 *     before measuring, which is faithful: what they cover is flat background, and
 *     a flat surround is what every other template has.
 *
 *   • The neighbours. The crop pads by CROP_PAD_RATIO, so slivers of the rows above
 *     and below are visible at the same x as the icon. The search is therefore
 *     bounded vertically to the highlighted row and horizontally to the icon column,
 *     stopping short of the panel border/scrollbar at x >= 0.965 * width.
 *
 * Everything after that is refit-resource-icon.mjs's rule, for the same reason:
 * a SQUARE crop sized so the icon fills ~92% of the width, so the icon's real
 * aspect survives the resize to 48x48. The matcher only ever varies a crop's side
 * length, so an icon squashed to fill a square can never align with a real row.
 * Religious Tractates measures 45x35 — 1.29 — and a naive 48x48 fit would have
 * cost it a quarter of its width.
 *
 * Prints the footprint and aspect it measured. Sanity-check those against the row
 * before shipping: an aspect near 1.0 on an obviously oblong icon means the window
 * caught a neighbour.
 */

import sharp from 'sharp';
import path from 'path';
import fs from 'fs';

const WIDTH_FILL = 0.92;   // icon width / crop side, measured on production crops
const OUT_SIZE = 48;
const BG_DISTANCE = 45;    // colour distance from background that counts as icon
const OVERLAY = [0xe8, 0x56, 0x2a];  // saveUnresolvedRowCrop's highlight stroke
const OVERLAY_DISTANCE = 110;

// The icon column, as a fraction of the crop's width. Left bound clears the
// right-aligned amount text; right bound stops before the panel border and the
// scrollbar, matching ICON_COLUMN_RIGHT in resource-ocr.ts.
const COL_LEFT = 0.900;
const COL_RIGHT = 0.965;

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const [slug, source] = argv.filter((a) => !a.startsWith('--'));
if (!slug || !source) {
  console.error('usage: node scripts/extract-icon-from-row-crop.mjs [--dry-run] <slug> <row-crop.png>');
  process.exit(1);
}

const { data, info } = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H } = info;
const px = Buffer.from(data);
const at = (x, y) => [px[(y * W + x) * 3], px[(y * W + x) * 3 + 1], px[(y * W + x) * 3 + 2]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const xLeft = Math.round(W * COL_LEFT);
const xRight = Math.round(W * COL_RIGHT);

// Background as the per-channel MEDIAN of the icon column, not a sampled pixel.
// A fixed sample point is not safe here: the amount is right-aligned, so how far
// left of the icon the background starts depends on how many digits the amount
// has, and a ten-digit one puts dark text under any point picked with margin.
//
// Dropping everything near the stroke colour first is what keeps background in
// the majority — stroke plus icon plus the neighbouring rows' slivers can reach
// ~40% of this column on their own. Over-excluding is free here (this is only an
// estimate of the background) which is exactly why the same test must NOT be
// reused to decide what gets repainted — see below.
const bg = (() => {
  const chans = [[], [], []];
  for (let y = 0; y < H; y++) {
    for (let x = xLeft; x < xRight; x++) {
      const c = at(x, y);
      if (dist(c, OVERLAY) < OVERLAY_DISTANCE) continue;  // the highlight, not content
      for (let k = 0; k < 3; k++) chans[k].push(c[k]);
    }
  }
  return chans.map((v) => v.sort((a, b) => a - b)[v.length >> 1]);
})();

// ── Repaint the highlight, and use it to find the row it marks ────────────────
// The strokes are the one thing in the crop that reliably says where the subject
// row is, so measure them before painting them out.
//
// The test is how WIDE a row's ink reaches, not whether it is orange. Colour
// cannot do this job: the stroke is antialiased into the background over 2-3px,
// and a 40%-blended fringe pixel is 64 from the background — past any threshold
// that still admits the icon, whose own dark outline is further from the stroke
// colour (146) than that fringe is (96). Every threshold either keeps the fringe
// or eats the icon.
//
// Geometry separates them cleanly instead. The highlight stroke, its fringe and
// the list's own row separators all run edge to edge; an icon cannot, because
// real icon contours measure 37-46px of this 65px column (MIN_ICON_CONTOUR_W and
// the note above it in resource-ocr.ts). So a row whose ink reaches wider than
// MAX_ICON_INK is chrome, whatever colour it is.
const MAX_ICON_INK = 55;
const inkExtent = (y) => {
  let lo = -1, hi = -1;
  for (let x = xLeft; x < xRight; x++) {
    if (dist(at(x, y), bg) > BG_DISTANCE) { if (lo < 0) lo = x; hi = x; }
  }
  return lo < 0 ? 0 : hi - lo + 1;
};

// Only whole chrome ROWS are repainted. Repainting individual stroke-coloured
// pixels as well is the obvious extra safety net and it is destructive: warm
// icons live close to #e8562a in RGB, so the test cannot tell them from the
// stroke. Religious Tractates has 601 body pixels within 110 of it, its nearest
// only 65 away, and a per-pixel pass at that threshold rewrote 1,256 of the 2,304
// pixels in its 48x48 template. Nothing is lost by dropping it: inside the icon
// column the rectangle is only ever its two horizontal edges — the vertical ones
// and the rounded corners sit at x~2 and x~996, hundreds of pixels left of here —
// and a horizontal edge spans the column, so the row test already takes all of it.
let strokeTop = -1;
let strokeBottom = -1;
let painted = 0;
for (let y = 0; y < H; y++) {
  if (inkExtent(y) <= MAX_ICON_INK) continue;
  for (let x = xLeft; x < xRight; x++) {
    const i = (y * W + x) * 3;
    px[i] = bg[0]; px[i + 1] = bg[1]; px[i + 2] = bg[2];
    painted++;
  }
  if (y < H / 2) strokeTop = y;                  // last chrome row above the middle
  else if (strokeBottom < 0) strokeBottom = y;   // first one below it
}

// Search band: between the strokes when both were found, else the middle half of
// the crop, which the subject row always spans.
const yTop = strokeTop >= 0 ? strokeTop + 1 : Math.round(H * 0.25);
const yBottom = strokeBottom >= 0 ? strokeBottom - 1 : Math.round(H * 0.75);
console.log(`crop ${W}x${H}  bg ${bg.join(',')}  overlay px ${painted}`);
console.log(`search band  x ${xLeft}..${xRight}  y ${yTop}..${yBottom}`);

// Horizontally the icon is the LARGEST CONTIGUOUS run of inked columns, not the
// min/max of every inked pixel — the same choice findIconContour makes, for the
// same reason. Amounts are right-aligned, so a long one ends only a pixel or two
// short of the icon column and a plain bounding box would stretch left to swallow
// its last digit, biasing the centre and the size the crop is built from. A 2px
// gap tolerance keeps an icon's own antialiased waist from splitting the run.
const inked = [];
for (let x = xLeft; x < xRight; x++) {
  let n = 0;
  for (let y = yTop; y <= yBottom; y++) if (dist(at(x, y), bg) > BG_DISTANCE) n++;
  inked[x] = n > 0;
}
const runs = [];
for (let x = xLeft; x < xRight; x++) {
  if (!inked[x]) continue;
  const last = runs[runs.length - 1];
  if (last && x - last.end <= 3) last.end = x;   // bridge a 1-2px waist
  else runs.push({ start: x, end: x });
}
if (!runs.length) { console.error('no icon found in the icon column'); process.exit(1); }
const run = runs.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
const x0 = run.start;
const x1 = run.end;

// Vertically, likewise the largest run — but STRICTLY adjacent rows, no bridging.
// The list draws a pale highlight line above each row band and its lower edge
// fades out a couple of pixels into the icon's own space, leaving a handful of
// stray pixels one clear scanline above the icon. Bridging even a single gap
// would annex them and drag the measured centre upward; an icon, by contrast,
// has no empty scanline through its middle to lose.
const yRuns = [];
for (let y = yTop; y <= yBottom; y++) {
  let ink = false;
  for (let x = x0; x <= x1 && !ink; x++) ink = dist(at(x, y), bg) > BG_DISTANCE;
  if (!ink) continue;
  const last = yRuns[yRuns.length - 1];
  if (last && y - last.end === 1) last.end = y;
  else yRuns.push({ start: y, end: y });
}
if (!yRuns.length) { console.error('no icon rows in the search band'); process.exit(1); }
const yRun = yRuns.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
const y0 = yRun.start;
const y1 = yRun.end;

const iconW = x1 - x0 + 1;
const iconH = y1 - y0 + 1;
if (x0 <= xLeft || x1 >= xRight || y0 <= yTop || y1 >= yBottom) {
  console.warn(`⚠ footprint touches the search band edge (${iconW}x${iconH}) — it probably ` +
               'includes a neighbouring row or the panel border; check the output by eye');
}

const side = Math.round(iconW / WIDTH_FILL);
const left = Math.round(x0 + iconW / 2 - side / 2);
const top = Math.round(y0 + iconH / 2 - side / 2);
console.log(`icon footprint  ${iconW}x${iconH}  (aspect ${(iconW / iconH).toFixed(2)}) at ${x0},${y0}`);
console.log(`square crop     ${side}x${side} at ${left},${top}`);
if (top < 0 || left < 0 || top + side > H || left + side > W) {
  console.error('square crop falls outside the row crop — the icon sits too close to an edge');
  process.exit(1);
}

const outFile = path.resolve(
  dryRun ? path.join('data', 'icon-diagnostic') : path.join('assets', 'resource-icons'),
  `${slug}.png`,
);
if (dryRun) fs.mkdirSync(path.dirname(outFile), { recursive: true });

await sharp(px, { raw: { width: W, height: H, channels: 3 } })
  .extract({ left, top, width: side, height: side })
  .resize(OUT_SIZE, OUT_SIZE, { fit: 'fill', kernel: 'lanczos3' })
  .png()
  .toFile(outFile);

console.log(`wrote           ${path.relative(process.cwd(), outFile)}${dryRun ? '  (dry run)' : ''}`);

// Same reasoning as refit-resource-icon.mjs: assets/resource-icons-reference/ is
// the backup that makes a bad run recoverable, so nothing automated writes to it.
