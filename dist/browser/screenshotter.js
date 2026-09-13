"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.captureFullPage = captureFullPage;
exports.captureRegion = captureRegion;
exports.captureForVision = captureForVision;
exports.saveScreenshot = saveScreenshot;
exports.cleanOldScreenshots = cleanOldScreenshots;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const logger_js_1 = require("../utils/logger.js");
const image_js_1 = require("../utils/image.js");
const index_js_1 = require("../config/index.js");
const crop_dirs_js_1 = require("../utils/crop-dirs.js");
const log = (0, logger_js_1.childLogger)('screenshot');
function isDebugMode() {
    try {
        return (0, index_js_1.getConfig)().logLevel === 'debug' || (0, index_js_1.getConfig)().logLevel === 'trace';
    }
    catch {
        return false;
    }
}
async function captureFullPage(page) {
    const buffer = await page.screenshot({ type: 'png', fullPage: false });
    log.debug('Full page screenshot captured');
    return buffer;
}
async function captureRegion(page, clip) {
    const buffer = await page.screenshot({ type: 'png', clip });
    log.debug(`Region screenshot captured: ${clip.width}x${clip.height} at (${clip.x},${clip.y})`);
    return buffer;
}
async function captureForVision(page) {
    const raw = await captureFullPage(page);
    return (0, image_js_1.resizeForVision)(raw);
}
async function saveScreenshot(buffer, screenshotDir, label = 'capture', options = {}) {
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
    if (!fs_1.default.existsSync(screenshotDir)) {
        fs_1.default.mkdirSync(screenshotDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${label}_${timestamp}.png`;
    const filepath = path_1.default.join(screenshotDir, filename);
    fs_1.default.writeFileSync(filepath, buffer);
    log.debug(`Screenshot saved: ${filepath}`);
    return filepath;
}
async function cleanOldScreenshots(screenshotDir, retentionDays) {
    if (!fs_1.default.existsSync(screenshotDir) || retentionDays <= 0)
        return;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let cleaned = 0;
    const walk = (dir) => {
        for (const entry of fs_1.default.readdirSync(dir, { withFileTypes: true })) {
            const filepath = path_1.default.join(dir, entry.name);
            if (entry.isDirectory()) {
                // Review-evidence crops (unresolved resource rows, new-member rows from a
                // might capture) are referenced by a DB column and live as long as that
                // row does. Ageing them out here would leave rows pointing at files that
                // no longer exist, so the admin hover would break on anything older than
                // the retention window — and review items can sit far longer than that.
                if (crop_dirs_js_1.RETAINED_CROP_DIRS.some((d) => path_1.default.resolve(filepath) === d))
                    continue;
                walk(filepath);
                continue;
            }
            if (!entry.isFile())
                continue;
            const stat = fs_1.default.statSync(filepath);
            if (stat.mtimeMs < cutoff) {
                fs_1.default.unlinkSync(filepath);
                cleaned++;
            }
        }
    };
    walk(screenshotDir);
    if (cleaned > 0) {
        log.debug(`Cleaned ${cleaned} old screenshots`);
    }
}
//# sourceMappingURL=screenshotter.js.map