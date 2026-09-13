import type { Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { childLogger } from '../utils/logger.js';
import { resizeForVision } from '../utils/image.js';
import { getConfig } from '../config/index.js';
import { RETAINED_CROP_DIRS } from '../utils/crop-dirs.js';

const log = childLogger('screenshot');

function isDebugMode(): boolean {
  try {
    return getConfig().logLevel === 'debug' || getConfig().logLevel === 'trace';
  } catch {
    return false;
  }
}

export async function captureFullPage(page: Page): Promise<Buffer> {
  const buffer = await page.screenshot({ type: 'png', fullPage: false });
  log.debug('Full page screenshot captured');
  return buffer;
}

export async function captureRegion(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
): Promise<Buffer> {
  const buffer = await page.screenshot({ type: 'png', clip });
  log.debug(`Region screenshot captured: ${clip.width}x${clip.height} at (${clip.x},${clip.y})`);
  return buffer;
}

export async function captureForVision(page: Page): Promise<Buffer> {
  const raw = await captureFullPage(page);
  return resizeForVision(raw);
}

export async function saveScreenshot(
  buffer: Buffer,
  screenshotDir: string,
  label: string = 'capture',
  options: { force?: boolean } = {},
): Promise<string> {
  // Skip writing debug screenshots in production unless `force: true` is
  // passed. Only the OCR vision pipeline (captureForVision) holds
  // screenshots in memory; saveScreenshot writes them to disk for
  // debugging. The pipelined scanner uses force=true for its
  // first-N-iterations debug PNGs because those need to land on disk
  // regardless of log level — they're a deliberate operator-facing
  // debugging feature, not log-level-gated noise.
  if (!options.force && !isDebugMode()) {
    return '';
  }

  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${label}_${timestamp}.png`;
  const filepath = path.join(screenshotDir, filename);

  fs.writeFileSync(filepath, buffer);
  log.debug(`Screenshot saved: ${filepath}`);
  return filepath;
}

export async function cleanOldScreenshots(
  screenshotDir: string,
  retentionDays: number,
): Promise<void> {
  if (!fs.existsSync(screenshotDir) || retentionDays <= 0) return;

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filepath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Review-evidence crops (unresolved resource rows, new-member rows from a
        // might capture) are referenced by a DB column and live as long as that
        // row does. Ageing them out here would leave rows pointing at files that
        // no longer exist, so the admin hover would break on anything older than
        // the retention window — and review items can sit far longer than that.
        if (RETAINED_CROP_DIRS.some((d) => path.resolve(filepath) === d)) continue;
        walk(filepath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(filepath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filepath);
        cleaned++;
      }
    }
  };

  walk(screenshotDir);

  if (cleaned > 0) {
    log.debug(`Cleaned ${cleaned} old screenshots`);
  }
}
