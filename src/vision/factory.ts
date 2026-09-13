/**
 * Vision-provider factory. The scanner uses PaddleOCR (PP-OCRv6_small via
 * onnxruntime-node) for all OCR. Kept as a single construction point so it's
 * easy to find (and to swap) if another engine is ever added.
 */
import type { VisionProvider } from './provider.js';
import { PaddleOcrProvider } from './paddle-provider.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('vision-factory');

export function createVisionProvider(): VisionProvider {
  log.info('Vision engine: PaddleOCR (PP-OCRv6_small, ONNX)');
  return new PaddleOcrProvider();
}
