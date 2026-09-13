"use strict";
/**
 * Simple in-memory counter for active resource screenshot uploads.
 *
 * The scan loop checks this before starting a scan cycle so that
 * OCR-heavy uploads and the scanner never run simultaneously — both
 * are CPU/memory intensive (Tesseract WASM workers) and would degrade
 * each other's throughput if allowed to overlap.
 *
 * acquireUploadSlot / releaseUploadSlot are called in resource upload
 * route (try/finally so a crash never leaks the counter).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.acquireUploadSlot = acquireUploadSlot;
exports.releaseUploadSlot = releaseUploadSlot;
exports.isResourceUploadActive = isResourceUploadActive;
let activeUploads = 0;
function acquireUploadSlot() {
    activeUploads++;
}
function releaseUploadSlot() {
    if (activeUploads > 0)
        activeUploads--;
}
function isResourceUploadActive() {
    return activeUploads > 0;
}
//# sourceMappingURL=resource-upload-lock.js.map