/**
 * Extracts the 15 resource type icons from the "Select a resource" modal
 * screenshots and saves them as 48×48 PNGs in assets/resource-icons/.
 *
 * Screenshots used: IMG_7639_preview.jpeg, IMG_7640_preview.jpeg, IMG_7641_preview.jpeg
 * All are 1284×2778 iPhone screenshots.
 *
 * The modal is fixed on-screen; only the scroll position changes between
 * screenshots. Slot positions within the visible modal area:
 *   Slot 0: y≈969, Slot 1: y≈1146, …, Slot 7: y≈2208 (row height ≈177px)
 * Icon x-center: ≈294px from left edge.
 */

import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const screenshotDir = path.resolve(__dirname, '../data/screenshots');
const outDir = path.resolve(__dirname, '../assets/resource-icons');

// Slot y-centers within the fixed modal area (actual pixels in 1284×2778 image).
// All screenshots show the modal at the same on-screen position;
// slot 0 is the topmost visible row.
const SLOTS = [969, 1146, 1323, 1500, 1677, 1854, 2031, 2208];

// Horizontal center of the resource icon within each row.
const ICON_X = 294;
const CROP = 150; // square crop side length (icon will be centred within this)

/**
 * Crop a 150×150 region centred on (cx, cy) from `file`, resize to 48×48,
 * and save to assets/resource-icons/<slug>.png.
 */
async function extractIcon(file, cx, cy, slug) {
  const left = Math.round(cx - CROP / 2);
  const top  = Math.round(cy - CROP / 2);
  await sharp(path.join(screenshotDir, file))
    .extract({ left, top, width: CROP, height: CROP })
    .resize(48, 48, { fit: 'cover', kernel: 'lanczos3' })
    .png()
    .toFile(path.join(outDir, `${slug}.png`));
  console.log(`  ✓ ${slug}.png  (from ${file} @ ${left},${top})`);
}

// ─── IMG_7639: scroll position 0 — items visible in slots 0-7 ────────────────
// Slot 0 = All resources (skip), slots 1-7 = Food … Clan Speedup
const img7639 = 'IMG_7639_preview.jpeg';

// ─── IMG_7640: scrolled so Scientific Tractates is at slot 0 (partial) ───────
// Slots 1-7 = Clan Speedup … Chronoglyph Clan Fragment
const img7640 = 'IMG_7640_preview.jpeg';

// ─── IMG_7641: scrolled so Stone is at slot 0 (partial) ──────────────────────
// Slots 1-7 = Omen Essence … Hermes' Loyalty Level
const img7641 = 'IMG_7641_preview.jpeg';

const icons = [
  // From IMG_7639 (slot 1-6; Clan Speedup at slot 7 is partially clipped, use 7640)
  { slug: 'food',                    file: img7639, slot: 1 },
  { slug: 'silver',                  file: img7639, slot: 2 },
  { slug: 'lumber',                  file: img7639, slot: 3 },
  { slug: 'dragon-coins',            file: img7639, slot: 4 },
  { slug: 'iron',                    file: img7639, slot: 5 },
  { slug: 'scientific-tractates',    file: img7639, slot: 6 },

  // From IMG_7640 (slots 1-6; slot 7 = Chronoglyph, also available)
  { slug: 'clan-speedup',            file: img7640, slot: 1 },
  { slug: 'stone',                   file: img7640, slot: 2 },
  { slug: 'omen-essence',            file: img7640, slot: 3 },
  { slug: 'boards',                  file: img7640, slot: 4 },
  { slug: 'cement',                  file: img7640, slot: 5 },
  { slug: 'chronoglyph-clan-fragment', file: img7640, slot: 6 },

  // From IMG_7641 (slots 5-7 for Seal, Steel, Hermes)
  { slug: 'seal-of-suppression',     file: img7641, slot: 5 },
  { slug: 'steel',                   file: img7641, slot: 6 },
  { slug: 'hermes-loyalty-level',    file: img7641, slot: 7 },
];

console.log('Extracting resource icons…');
for (const { slug, file, slot } of icons) {
  await extractIcon(file, ICON_X, SLOTS[slot], slug);
}

// ─── Diagnostic: stitch all 15 extracted icons into a single preview PNG ────
console.log('\nGenerating diagnostic strip…');
const ICON_SIZE = 48;
const COLS = 5;
const ROWS = Math.ceil(icons.length / COLS);
const LABEL_H = 0; // skip text labels — just show icons in a grid

const composites = icons.map(({ slug }, i) => ({
  input: path.join(outDir, `${slug}.png`),
  left: (i % COLS) * ICON_SIZE,
  top: Math.floor(i / COLS) * ICON_SIZE,
}));

await sharp({
  create: {
    width: COLS * ICON_SIZE,
    height: ROWS * ICON_SIZE,
    channels: 4,
    background: { r: 30, g: 25, b: 20, alpha: 255 },
  },
})
  .composite(composites)
  .png()
  .toFile(path.join(outDir, '_diagnostic.png'));

console.log('Done. Check assets/resource-icons/_diagnostic.png to verify icon quality.');
