/**
 * Creates 48×48 transparent placeholder PNG files in data/resource-icons/
 * for each of the 15 hardcoded resource types.
 *
 * These placeholders let the codebase run without calibration. Since the
 * NCC similarity of a transparent image vs a real icon is ~0, template
 * matching will return null and transactions will be stored with
 * resource_type_id = NULL — which is the correct "not yet calibrated"
 * state. Admins can replace individual icons via the Resource Tracking
 * settings in the Clans page.
 *
 * To run: node scripts/generate-placeholder-icons.mjs
 */

import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '../assets/resource-icons');
fs.mkdirSync(outDir, { recursive: true });

const slugs = [
  'food',
  'silver',
  'lumber',
  'dragon-coins',
  'iron',
  'scientific-tractates',
  'clan-speedup',
  'stone',
  'omen-essence',
  'boards',
  'cement',
  'chronoglyph-clan-fragment',
  'seal-of-suppression',
  'steel',
  'hermes-loyalty-level',
];

// 48×48 fully-transparent PNG.
const blank = await sharp({
  create: { width: 48, height: 48, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
}).png().toBuffer();

for (const slug of slugs) {
  const outPath = path.join(outDir, `${slug}.png`);
  if (!fs.existsSync(outPath)) {
    fs.writeFileSync(outPath, blank);
    console.log(`Created placeholder: ${slug}.png`);
  } else {
    console.log(`Skipped (already exists): ${slug}.png`);
  }
}

console.log(`Done. Replace these placeholders with real icon crops via the Clans → Resource Tracking settings.`);
