/**
 * Shared PaddleOCR service loader.
 *
 * Both the resource-screenshot flow (resource-ocr.ts) and the normal game
 * scan (paddle-provider.ts) run the same PP-OCRv6_small det+rec models. This
 * module owns the single lazily-initialised service so we load one copy of the
 * ~30 MB model set into memory, not two. Callers share the same in-flight init
 * promise, so concurrent first-calls don't race two loads.
 *
 * The models live in assets/paddle-models/ (det.onnx, rec.onnx,
 * ppocrv6_dict.txt) and are copied into the Docker image via the Dockerfile
 * `COPY assets/`.
 */
import * as ort from 'onnxruntime-node';
import { PaddleOcrService, normalizeInputToRgb } from 'paddleocr';
import type { OrtModule } from 'paddleocr';
import { readFileSync } from 'fs';
import path from 'path';
import { childLogger } from '../utils/logger.js';

const log = childLogger('paddle-service');

/**
 * ONNX Runtime spins up an intra-op thread pool sized to the host core count
 * and tries to pin each thread to a core with pthread_setaffinity_np — which
 * fails inside Docker (no CAP_SYS_NICE / a restricted cpuset), spamming
 * "pthread_setaffinity_np failed … error code 22" on every session load.
 * (OMP_NUM_THREADS only bounds OpenMP, not ORT's own pool, so it doesn't help.)
 * ORT's own guidance: "specify the number of threads explicitly so the affinity
 * is not set." paddleocr.js's session constructor doesn't forward SessionOptions,
 * so we wrap the ort module we hand it and inject the options on create().
 * The thread counts are explicit (which is what silences the affinity attempt);
 * the intra-op count is tunable via ONNX_INTRA_OP_THREADS (default 4). OCR runs
 * while Chromium is idle between screenshots, so a few threads speed each scan
 * batch with little contention; drop it toward 1 if CPU pressure ever hurts the
 * browser. Any value ≥ 1 keeps the affinity error suppressed.
 */
function envThreads(name: string, def: number): number {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v >= 1 && v <= 64 ? v : def;
}
/**
 * Whether to leave ONNX Runtime's CPU memory arena on. Default OFF.
 *
 * The arena is a caching allocator: it reserves blocks sized to the tensors it
 * has seen and reuses them, growing on the next-power-of-two strategy and never
 * returning anything to the OS. That's a good trade for a server doing constant
 * inference on uniform inputs. It is a bad one here on both counts. Our inputs
 * are the opposite of uniform — recognition runs on per-text-line crops of
 * whatever width the line happens to be, so nearly every call is a new shape
 * that claims a new block — and inference is bursty, minutes of OCR every couple
 * of hours, so the arena spends almost all of its life holding memory nothing
 * is about to use. In a container sharing a 5 GB ceiling with Chromium's GPU
 * process that reservation is what runs out.
 *
 * Turning it off means malloc/free per tensor: measurably slower per call, but
 * scans are infrequent and a slower scan is a trade this deployment already
 * makes elsewhere (see the CPU cap in docker-compose.yml). Set
 * ONNX_CPU_MEM_ARENA=1 to restore the default if OCR time ever matters more
 * than resident memory.
 */
function arenaEnabled(): boolean {
  const v = (process.env.ONNX_CPU_MEM_ARENA ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

const SESSION_OPTIONS = {
  intraOpNumThreads: envThreads('ONNX_INTRA_OP_THREADS', 4),
  interOpNumThreads: 1,
  executionMode: 'sequential' as const,
  enableCpuMemArena: arenaEnabled(),
};

/** Minimal view of what we hand back to paddleocr.js, plus the release hook
 *  onnxruntime-common exposes so we can actually free a session. */
type ManagedSession = { release?: () => Promise<void> };

/**
 * Every ORT session this process has created, keyed by model identity.
 *
 * Two jobs, both about memory.
 *
 * DEDUPE. paddleocr.js takes model *buffers* and builds its own sessions, so
 * each PaddleOcrService instance gets a full det+rec pair. We create three
 * services — the main PP-OCRv6_small one plus a per-language service for
 * Cyrillic and Arabic name recovery (paddle-lang.ts) — and all three pass the
 * SAME det.onnx. That was three copies of the detection model resident, each
 * with its own ONNX Runtime arena, and detection is the widest tensor in the
 * pipeline (it runs on 1000px-wide canonical images). Since this wrapper IS the
 * session factory, keying on the model bytes collapses them to one. ORT
 * sessions are safe to share — run() is re-entrant and our OCR is sequential.
 *
 * RELEASE. PaddleOcrService has no dispose method, so without holding the
 * handles ourselves there was no way to free any of this: the models loaded
 * once into module singletons and stayed for the life of the process, which is
 * why PaddleOcrProvider.teardown() had to be a no-op and the scheduler's
 * periodic recycle reclaimed nothing. Owning the handles makes a real teardown
 * possible (releaseAllOrtSessions).
 */
const _sessions = new Map<string, Promise<ManagedSession>>();

/**
 * Identity for a model buffer. Length alone would be a reckless key for
 * arbitrary input, but here the inputs are four fixed files shipped in the
 * image whose sizes differ by megabytes (det 9.9 MB, rec 21 MB, arabic 8 MB,
 * eslav 7.9 MB), and a wrong hit would mean OCR decoding through the wrong
 * model — loudly wrong, not subtly. Sample a few bytes anyway so a future
 * same-size model can't collide silently.
 */
function modelKey(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  const at = (i: number) => (i < view.length ? view[i] : 0);
  const mid = Math.floor(view.length / 2);
  return `${view.length}:${at(0)},${at(1)},${at(mid)},${at(view.length - 1)}`;
}

export const ortRuntime = {
  Tensor: (ort as unknown as { Tensor: unknown }).Tensor,
  InferenceSession: {
    create: (modelBuffer: ArrayBuffer) => {
      const key = modelKey(modelBuffer);
      const existing = _sessions.get(key);
      if (existing) {
        log.debug(`reusing ORT session for model ${key} instead of loading a second copy`);
        return existing;
      }
      const created = (
        (ort as unknown as { InferenceSession: { create: (b: ArrayBuffer, o: unknown) => Promise<ManagedSession> } })
          .InferenceSession.create(modelBuffer, SESSION_OPTIONS)
      ).catch((err: unknown) => {
        _sessions.delete(key); // let a transient load failure retry
        throw err;
      });
      _sessions.set(key, created);
      return created;
    },
  },
} as unknown as OrtModule;

/**
 * Free every loaded model and forget the cached services.
 *
 * Called from PaddleOcrProvider.teardown() so the scheduler's periodic recycle
 * genuinely returns memory: ONNX Runtime arenas grow with the input shapes
 * they've seen and never shrink, so over a long uptime releasing the sessions
 * is the only way to give that back. The next getPaddleOcr() reloads from
 * disk — a few seconds, paid once per recycle, off the scan path.
 *
 * Best-effort: a session that refuses to release is logged and dropped rather
 * than blocking the rest.
 */
export async function releaseAllOrtSessions(): Promise<number> {
  const pending = [..._sessions.values()];
  _sessions.clear();
  _service = null;
  _init = null;

  let released = 0;
  for (const p of pending) {
    try {
      const session = await p;
      await session.release?.();
      released++;
    } catch (err) {
      log.warn('Could not release an ORT session (dropping the handle anyway): ' + String(err));
    }
  }
  if (released > 0) log.info(`Released ${released} ORT session(s); models will reload on next use.`);
  return released;
}

let _service: PaddleOcrService | null = null;
let _init: Promise<PaddleOcrService> | null = null;

/**
 * Get the shared PP-OCRv6_small OCR service, loading the models on first call.
 * Safe to call concurrently and repeatedly.
 */
export function getPaddleOcr(): Promise<PaddleOcrService> {
  if (_service) return Promise.resolve(_service);
  if (!_init) {
    _init = (async () => {
      const modelDir = path.resolve('assets', 'paddle-models');
      const detBuf = readFileSync(path.join(modelDir, 'det.onnx'));
      const recBuf = readFileSync(path.join(modelDir, 'rec.onnx'));
      // PP-OCRv6 is trained with use_space_char: its CTC head has a dedicated
      // space class in the final slot, so the dictionary must end with a real
      // ' ' there. (The CTC blank is handled internally by the runtime.)
      // Appending '' instead — as this did originally — maps the model's
      // predicted spaces to nothing, which is why OCR output arrived with all
      // inter-word spaces stripped ("Runic Chest" → "RunicChest"). A single
      // space restores them across gift cards, member names, and resources.
      const dictLines = readFileSync(path.join(modelDir, 'ppocrv6_dict.txt'), 'utf-8')
        .trimEnd().split(/\r?\n/).concat([' ']);

      log.info(
        `loading PaddleOCR models (PP-OCRv6_small), cpu mem arena ${arenaEnabled() ? 'ON' : 'OFF'}...`,
      );
      const svc = await PaddleOcrService.createInstance({
        ort: ortRuntime,
        modelPreset: 'PP-OCRv6_small',
        detection: {
          modelBuffer: detBuf.buffer.slice(detBuf.byteOffset, detBuf.byteOffset + detBuf.byteLength),
        },
        recognition: {
          modelBuffer: recBuf.buffer.slice(recBuf.byteOffset, recBuf.byteOffset + recBuf.byteLength),
          charactersDictionary: dictLines,
        },
      });
      _service = svc;
      log.info('PaddleOCR models ready');
      return svc;
    })().catch((err) => {
      // Clear the slot so a transient failure doesn't permanently poison it.
      _init = null;
      throw err;
    });
  }
  return _init;
}

/** True once the models are loaded (no async needed). */
export function isPaddleOcrReady(): boolean {
  return _service !== null;
}

export { normalizeInputToRgb };
