"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.encodePng = encodePng;
exports.decodePng = decodePng;
const sharp_1 = __importDefault(require("sharp"));
function fullyOpaque(img) {
    for (let i = 3; i < img.data.length; i += 4)
        if (img.data[i] !== 255)
            return false;
    return true;
}
/** RGBA (top-down) → PNG. Opaque images are written as RGB, which is smaller. */
async function encodePng(img) {
    let pipeline = (0, sharp_1.default)(img.data, { raw: { width: img.width, height: img.height, channels: 4 } });
    if (fullyOpaque(img))
        pipeline = pipeline.removeAlpha();
    return pipeline.png({ compressionLevel: 9 }).toBuffer();
}
/** PNG → RGBA (top-down); for tests and checks. */
async function decodePng(png) {
    const { data, info } = await (0, sharp_1.default)(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data };
}
//# sourceMappingURL=png.js.map