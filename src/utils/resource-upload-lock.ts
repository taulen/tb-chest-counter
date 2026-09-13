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

let activeUploads = 0;

export function acquireUploadSlot(): void {
  activeUploads++;
}

export function releaseUploadSlot(): void {
  if (activeUploads > 0) activeUploads--;
}

export function isResourceUploadActive(): boolean {
  return activeUploads > 0;
}
