"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resizeForVision = resizeForVision;
exports.cropRegion = cropRegion;
exports.annotateScreenshot = annotateScreenshot;
exports.toBase64 = toBase64;
exports.toGrayscale = toGrayscale;
exports.isOCRBufferUsable = isOCRBufferUsable;
exports.preprocessForOCR = preprocessForOCR;
exports.preprocessSmallTextRows = preprocessSmallTextRows;
exports.cropPanelHeaderRegion = cropPanelHeaderRegion;
const sharp_1 = __importDefault(require("sharp"));
const viewport_js_1 = require("../config/viewport.js");
const MAX_DIMENSION = 1568;
async function resizeForVision(buffer) {
    const metadata = await (0, sharp_1.default)(buffer).metadata();
    const width = metadata.width ?? viewport_js_1.DEFAULT_VIEWPORT_WIDTH;
    const height = metadata.height ?? viewport_js_1.DEFAULT_VIEWPORT_HEIGHT;
    if (width <= MAX_DIMENSION && height <= MAX_DIMENSION) {
        return buffer;
    }
    const scale = MAX_DIMENSION / Math.max(width, height);
    return (0, sharp_1.default)(buffer)
        .resize(Math.round(width * scale), Math.round(height * scale))
        .png()
        .toBuffer();
}
async function cropRegion(buffer, region) {
    return (0, sharp_1.default)(buffer)
        .extract(region)
        .png()
        .toBuffer();
}
/**
 * Annotate a screenshot with debug overlays. Used by:
 *   - the calibration script (overlays on a static screenshot)
 *   - the pipelined scanner (overlays on every live capture iter
 *     while scanDebugFirstN is non-zero)
 *
 * Returns a new PNG with the overlays composited on top via sharp.
 * The overlays use SVG (sharp's idiomatic composite source) so they
 * stay crisp at any resolution.
 *
 * - cropRegion → red rectangle outlining where the OCR will read from
 * - clickPoint → green crosshair + circle at the click target
 * - label → big yellow text at the top of the image (e.g. "iter 5")
 * - ocrResult → small cyan text under the crosshair (e.g. the parsed
 *   "Player | Chest" string from a probe iteration)
 */
async function annotateScreenshot(buffer, options = {}) {
    const meta = await (0, sharp_1.default)(buffer).metadata();
    const width = meta.width ?? viewport_js_1.DEFAULT_VIEWPORT_WIDTH;
    const height = meta.height ?? viewport_js_1.DEFAULT_VIEWPORT_HEIGHT;
    // Build SVG markup for whichever overlays were requested. Empty
    // strings concatenate cleanly so callers can omit any single field.
    const cropRect = options.cropRegion
        ? `<rect x="${options.cropRegion.left}" y="${options.cropRegion.top}"
            width="${options.cropRegion.width}" height="${options.cropRegion.height}"
            fill="none" stroke="#ff3030" stroke-width="4" />`
        : '';
    // Crosshair: a circle plus two short lines through the center.
    // 18px arms are visible at any reasonable canvas size.
    const click = options.clickPoint;
    const crosshair = click
        ? `<circle cx="${click.x}" cy="${click.y}" r="14"
              fill="none" stroke="#30ff60" stroke-width="3" />
       <line x1="${click.x - 18}" y1="${click.y}" x2="${click.x + 18}" y2="${click.y}"
             stroke="#30ff60" stroke-width="2" />
       <line x1="${click.x}" y1="${click.y - 18}" x2="${click.x}" y2="${click.y + 18}"
             stroke="#30ff60" stroke-width="2" />`
        : '';
    // Label sits in a yellow strip at the top-left so it's always visible
    // regardless of where the click target ends up.
    const labelMarkup = options.label
        ? `<rect x="12" y="12" width="${Math.min(width - 24, 24 + options.label.length * 11)}" height="32"
            fill="#000000" fill-opacity="0.65" stroke="#ffd000" stroke-width="2" rx="4" />
       <text x="22" y="34" fill="#ffd000" font-size="18"
             font-family="monospace" font-weight="bold">${escapeXml(options.label)}</text>`
        : '';
    // OCR result text sits below the crosshair when both are present.
    // Falls back to top-right when there's no clickPoint to anchor to.
    const ocrText = options.ocrResult
        ? (click
            ? `<rect x="${click.x + 22}" y="${click.y - 14}"
                width="${Math.min(width - click.x - 30, 16 + options.ocrResult.length * 9)}" height="26"
                fill="#000000" fill-opacity="0.65" stroke="#30c0ff" stroke-width="1" rx="3" />
           <text x="${click.x + 30}" y="${click.y + 4}" fill="#30c0ff" font-size="14"
                 font-family="monospace">${escapeXml(options.ocrResult)}</text>`
            : `<rect x="${width - 16 - 12 * options.ocrResult.length}" y="14"
                width="${12 * options.ocrResult.length}" height="22"
                fill="#000000" fill-opacity="0.65" stroke="#30c0ff" stroke-width="1" rx="3" />
           <text x="${width - 8 - 12 * options.ocrResult.length}" y="30" fill="#30c0ff" font-size="14"
                 font-family="monospace">${escapeXml(options.ocrResult)}</text>`)
        : '';
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    ${cropRect}
    ${crosshair}
    ${labelMarkup}
    ${ocrText}
  </svg>`;
    return (0, sharp_1.default)(buffer)
        .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
        .png()
        .toBuffer();
}
/**
 * Minimal XML/SVG escaping. SVG text nodes only need these five
 * characters escaped — no full HTML escaping needed since this is
 * embedded in a generated SVG document, not an HTML page.
 */
function escapeXml(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
function toBase64(buffer) {
    return buffer.toString('base64');
}
async function toGrayscale(buffer) {
    return (0, sharp_1.default)(buffer)
        .grayscale()
        .normalize()
        .sharpen()
        .png()
        .toBuffer();
}
/**
 * Decide whether an image is large enough to be worth OCRing. Tesseract
 * emits warnings and produces meaningless output on crops that are too tiny,
 * so we should reject them before the OCR worker sees them.
 */
async function isOCRBufferUsable(buffer) {
    const meta = await (0, sharp_1.default)(buffer).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    return width >= 80 && height >= 40;
}
/**
 * Preprocessing for OCR on noisy gift-card crops: 4× upscale, grayscale,
 * median denoise, aggressive linear contrast stretch, normalize. Kept
 * grayscale (no threshold) — the Tesseract LSTM reads LSTM-grade grayscale
 * far better than a hard B&W, and the ornamental parchment dividers
 * disappear into the background instead of producing garbage tokens.
 *
 * Benchmarked against the gift-list crop: conf 95 / 12 of 12 expected
 * strings / zero garbage lines, vs conf 90 / 11 of 12 / 3 garbage lines
 * for the previous threshold-based pipeline.
 *
 * For clean small-text rows (member list), see `preprocessSmallTextRows`
 * below — different content type, different recipe. `scripts/bench-memberlist-ocr.ts`
 * is the A/B harness for picking between the two.
 */
async function preprocessForOCR(buffer) {
    const meta = await (0, sharp_1.default)(buffer).metadata();
    const width = meta.width ?? 0;
    return (0, sharp_1.default)(buffer)
        .resize({ width: width * 4, kernel: 'lanczos3' })
        .grayscale()
        .median(1)
        .linear(1.8, -80)
        .normalize()
        .png()
        .toBuffer();
}
/**
 * Preprocessing tuned for the member-list names column: clean small text
 * rows on a flat background, no parchment ornaments to denoise. Lighter
 * than `preprocessForOCR`: 2× upscale, grayscale, normalize, mild sharpen.
 *
 * If `scripts/bench-memberlist-ocr.ts` shows `preprocessForOCR` (the chest
 * recipe) outperforms this on real memberlist crops, switch member-capture
 * to call that instead and delete this helper. Today the chest recipe's
 * aggressive contrast stretch + median denoise hasn't been benchmarked
 * against memberlist content, so we keep both recipes co-located here.
 */
async function preprocessSmallTextRows(buffer) {
    const meta = await (0, sharp_1.default)(buffer).metadata();
    const width = meta.width ?? 0;
    return (0, sharp_1.default)(buffer)
        .grayscale()
        .normalize()
        .sharpen({ sigma: 1.5 })
        .resize({ width: width * 2, kernel: 'lanczos3' })
        .png()
        .toBuffer();
}
/**
 * Crop to the panel header region where "Gifts" / "Triumphal Gifts" tabs appear.
 * Used for screen state verification — much more reliable than full-page OCR
 * on a game canvas where Tesseract reads mostly garbage.
 * Also captures the "My Clan" header text and "No gifts" message area.
 */
async function cropPanelHeaderRegion(buffer) {
    const meta = await (0, sharp_1.default)(buffer).metadata();
    const w = meta.width ?? viewport_js_1.DEFAULT_VIEWPORT_WIDTH;
    const h = meta.height ?? viewport_js_1.DEFAULT_VIEWPORT_HEIGHT;
    // Panel header sits roughly at 20-45% x, 20-40% y of the viewport.
    // This captures "My Clan", "Gifts", "Triumphal Gifts", and first gift entry.
    return (0, sharp_1.default)(buffer)
        .extract({
        left: Math.round(w * 0.25),
        top: Math.round(h * 0.18),
        width: Math.round(w * 0.45),
        height: Math.round(h * 0.25),
    })
        .png()
        .toBuffer();
}
//# sourceMappingURL=image.js.map