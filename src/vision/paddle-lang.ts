/**
 * Non-Latin recognition fallback for player/member names.
 *
 * The primary PP-OCRv6_small rec model reads Latin + CJK only, so Cyrillic and
 * Arabic names come back empty/garbled. This module loads dedicated PP-OCRv5
 * language recognition models (bundled under assets/paddle-lang-models/) and
 * re-OCRs a name crop that the primary pass couldn't read.
 *
 * The models are the PP-OCRv5 ONNX conversions from
 * huggingface.co/xberg-io/paddleocr-onnx-models. Each rec model shares the
 * same tensor contract as our v6 rec (input [N,3,48,W], opset 14, CTC), so it
 * loads through the normal paddleocr.js preset by swapping the rec buffer +
 * dict — see docs/refactor-plans/scan-ocr-tesseract-to-paddleocr.md, Risk #1.
 *
 * ── CTC dict alignment ──
 * paddleocr.js expects `charactersDictionary.length === modelOutputClasses − 1`
 * (the CTC blank occupies the remaining slot). The bundled dicts don't share
 * one padding convention, so each needs a per-model transform, derived
 * empirically by rendering the real roster names and sweeping alignments
 * until the decode was exact:
 *   - eslav dict carries a leading placeholder line → drop the first entry.
 *   - arabic dict is bare → append one trailing entry.
 * Getting this wrong shifts every decoded character by one. If you swap the
 * bundled models, re-derive the transform (render a known word, sweep
 * slice(1) / concat(['']) / as-is until the output matches).
 */
import { PaddleOcrService } from 'paddleocr';
import sharp from 'sharp';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { normalizeInputToRgb, ortRuntime } from './paddle-service.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('paddle-lang');

const CYRILLIC_RE = /[Ѐ-ӿ]/;
const ARABIC_RE = /[؀-ۿ]/;

interface LangSpec {
  slug: string;
  /** Align the raw dict lines to the model's CTC output (see file header). */
  transform: (chars: string[]) => string[];
  /** Regex matching the script this model recognises. */
  scriptRe: RegExp;
  /** Right-to-left scripts (Arabic) decode in visual order; reverse to logical. */
  rtl: boolean;
}

const LANGS: LangSpec[] = [
  { slug: 'eslav', transform: (c) => c.slice(1), scriptRe: CYRILLIC_RE, rtl: false },
  { slug: 'arabic', transform: (c) => c.concat(['']), scriptRe: ARABIC_RE, rtl: true },
];

const LANG_DIR = path.resolve('assets', 'paddle-lang-models');
const DET_PATH = path.resolve('assets', 'paddle-models', 'det.onnx');

const _services = new Map<string, Promise<PaddleOcrService>>();

function toAB(b: Buffer): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** True when the bundled language models are present on disk. */
export function isLangFallbackAvailable(): boolean {
  return LANGS.every((l) => existsSync(path.join(LANG_DIR, l.slug, 'rec.onnx')));
}

/**
 * Kick off loading the language models in the background (fire-and-forget) so
 * the first non-Latin recovery during a scan doesn't stall ~6s on the model
 * load mid-scan. Idempotent — the per-slug singleton dedupes repeat calls.
 * No-op when the models aren't bundled.
 */
export function prewarmLangModels(): void {
  if (!isLangFallbackAvailable()) return;
  for (const spec of LANGS) {
    getLangService(spec).catch(() => { /* failure already logged in getLangService */ });
  }
}

/**
 * Forget the cached per-language services.
 *
 * Must be called BEFORE releaseAllOrtSessions(), which frees the underlying
 * ORT sessions: a cached PaddleOcrService here would otherwise keep wrapping
 * released handles and throw on its next recognise. Kept as a separate export
 * rather than called from paddle-service because the dependency runs this way
 * (this module imports that one) — PaddleOcrProvider.teardown() sequences both.
 */
export function resetLangServices(): void {
  _services.clear();
}

function getLangService(spec: LangSpec): Promise<PaddleOcrService> {
  const cached = _services.get(spec.slug);
  if (cached) return cached;
  const p = (async () => {
    const det = readFileSync(DET_PATH);
    const rec = readFileSync(path.join(LANG_DIR, spec.slug, 'rec.onnx'));
    const rawDict = readFileSync(path.join(LANG_DIR, spec.slug, 'dict.txt'), 'utf-8')
      .replace(/\n$/, '').split(/\r?\n/);
    const dict = spec.transform(rawDict);
    log.info(`loading language model "${spec.slug}" (${dict.length} dict entries)`);
    return PaddleOcrService.createInstance({
      ort: ortRuntime,
      modelPreset: 'PP-OCRv6_small',
      detection: { modelBuffer: toAB(det) },
      recognition: { modelBuffer: toAB(rec), charactersDictionary: dict },
    });
  })().catch((err) => {
    _services.delete(spec.slug); // let a transient failure retry
    throw err;
  });
  _services.set(spec.slug, p);
  return p;
}

async function recognizeWith(spec: LangSpec, rgb: { width: number; height: number; data: Uint8Array }): Promise<string> {
  const svc = await getLangService(spec);
  const regions = (await svc.recognize({ ...rgb, data: new Uint8Array(rgb.data) })) as Array<{ text: string; box: { x: number } }>;
  if (!regions.length) return '';
  // Join left-to-right in visual order. RTL reversal is applied later, after
  // Latin contamination is stripped, so it operates only on the script content.
  return [...regions].sort((a, b) => a.box.x - b.box.x).map((r) => r.text).join(' ').trim();
}

/** Count characters of a script in a string. */
function scriptCount(s: string, re: RegExp): number {
  let n = 0;
  for (const ch of s) if (re.test(ch)) n++;
  return n;
}

/**
 * Re-OCR a name crop with the non-Latin language models and return the best
 * result, or '' if none produced ≥2 characters of their script. Runs each
 * bundled model; picks the candidate with the most script-specific letters so
 * a Cyrillic name lights up eslav and an Arabic name lights up arabic without
 * cross-contamination.
 */
export async function recognizeNonLatinName(cropBuffer: Buffer): Promise<string> {
  // Upscale small name crops so the height-48 rec model gets clean input.
  let rgb: { width: number; height: number; data: Uint8Array };
  try {
    const { data, info } = await sharp(cropBuffer)
      .resize({ height: 64, withoutEnlargement: false })
      .raw()
      .toBuffer({ resolveWithObject: true });
    normalizeInputToRgb({ width: info.width, height: info.height, data: new Uint8Array(data) });
    rgb = { width: info.width, height: info.height, data: new Uint8Array(data) };
  } catch (err) {
    log.debug('recognizeNonLatinName: preprocess failed: ' + String(err));
    return '';
  }

  let best = '';
  let bestScore = 1; // require ≥2 script letters to accept
  let bestSpec: LangSpec | null = null;
  for (const spec of LANGS) {
    try {
      const text = await recognizeWith(spec, rgb);
      const score = scriptCount(text, spec.scriptRe);
      if (score > bestScore) {
        bestScore = score;
        best = text;
        bestSpec = spec;
      }
    } catch (err) {
      log.debug(`recognizeNonLatinName: ${spec.slug} failed: ` + String(err));
    }
  }
  if (!bestSpec) return '';
  // Keep only characters of the winning script (plus spaces). The name crop
  // often includes a Latin label (a gift card's "From:", a member row's level
  // badge), which the model transcribes as Latin — stripping to the target
  // script removes that contamination. Reverse RTL scripts (Arabic) AFTER
  // stripping so the reversal operates only on the script run, giving logical
  // order even when the crop was mixed Latin+Arabic. Residual same-script noise
  // is harmless; the non-Latin fuzzy matcher resolves it to the roster.
  let cleaned = '';
  for (const ch of best) if (bestSpec.scriptRe.test(ch) || /\s/.test(ch)) cleaned += ch;
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (bestSpec.rtl) cleaned = [...cleaned].reverse().join('');
  return cleaned;
}
