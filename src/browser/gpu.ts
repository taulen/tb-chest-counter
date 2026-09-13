// Shared iGPU offload recipe for every Chromium this app launches.
//
// Extracted from launcher.ts because the scanner was not the only browser
// rendering the game's WebGL canvas: the admin login bridge launches its
// own Chromium and was getting no GPU flags at all, so it software-rendered
// (SwiftShader) the same heavy canvas the scanner needed the iGPU for. That
// is a framerate ceiling the screencast tuning downstream cannot lift.
//
// Keeping the flag set, the env toggle and the verification probe in one
// module means the two launch sites cannot drift apart again.

import type { Page } from 'playwright';
import type pino from 'pino';

/**
 * Whether GPU-accelerated rendering is requested (env SCANNER_GPU).
 * Read directly from the env — it's an infra toggle set in docker-compose,
 * mirroring the ONNX_INTRA_OP_THREADS pattern in vision/paddle-service.ts.
 *
 * The name stays SCANNER_GPU for compatibility with existing deployments
 * even though it now governs the login bridge as well.
 */
export function isGpuEnabled(): boolean {
  const v = (process.env.SCANNER_GPU ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Flags that put WebGL on a passed-through Intel iGPU. Recipe validated on
 * the target host (Intel UHD 770):
 *  - ANGLE's VULKAN backend is the one that reaches the iGPU headlessly: it
 *    talks to /dev/dri/renderD128 directly, whereas the GL/EGL backends need
 *    an X server and fail in a headless container ("Could not open the
 *    default X display").
 *  - --no-sandbox/--disable-gpu-sandbox: the full Chromium runs as root and
 *    its GPU-process sandbox otherwise blocks the render node.
 * Device access is via the render node's 0666 mode; no lxc.idmap needed.
 * See docs/igpu-passthrough.md.
 */
export const GPU_ARGS: readonly string[] = [
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--ignore-gpu-blocklist',
  '--use-gl=angle',
  '--use-angle=vulkan',
  '--enable-features=Vulkan',
];

/**
 * Whether the LOGIN BRIDGE should apply the GPU recipe.
 *
 * Explicit LOGIN_BRIDGE_GPU wins in either direction; unset means follow
 * SCANNER_GPU. Inheriting is right now that the bridge runs in the same
 * new-headless mode the recipe was validated in — a hardware-backed surface
 * comes from the GPU render node, not from a window, so there is no longer a
 * reason for the two browsers to disagree.
 *
 * It stays separately overridable because the failure mode is nasty when the
 * GPU path is broken: WebGL context creation doesn't error, it never
 * completes. logWebglRenderer() detects that ('stalled') so the caller can
 * fall back to software, and LOGIN_BRIDGE_GPU=0 skips the detour entirely.
 */
export function isBridgeGpuEnabled(): boolean {
  const v = (process.env.LOGIN_BRIDGE_GPU ?? '').trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return isGpuEnabled();
}

/**
 * Playwright `channel` to launch with. `'chromium'` selects the full
 * Chromium build; the default headless-shell binary has NO GPU support at
 * all, so it is mandatory whenever we want the iGPU. Returns undefined when
 * GPU is off, keeping the lighter default path.
 */
export function gpuChannel(): 'chromium' | undefined {
  return isGpuEnabled() ? 'chromium' : undefined;
}

// Hard cap on the renderer probe. page.evaluate() has NO default timeout in
// Playwright, and this particular script creates a WebGL context — if the
// renderer's main thread is busy or a context creation stalls (exactly the
// situation on a misconfigured GPU, which is when we most want to run it),
// an unbounded await here wedges whatever is waiting on it. A diagnostic
// must never be able to block the thing it is diagnosing.
const RENDERER_PROBE_TIMEOUT_MS = 8_000;

/**
 * Outcome of the renderer probe.
 *
 *   'hardware' — WebGL is on the GPU. What we wanted.
 *   'software' — WebGL works but on SwiftShader/llvmpipe. Slow, still usable.
 *   'stalled'  — creating a WebGL context did not complete in time. The GPU
 *                path is BROKEN, not merely absent: anything that needs a
 *                context (i.e. the game) will hang the same way, so the
 *                caller should abandon the GPU attempt entirely.
 *   'unknown'  — the probe itself failed; draw no conclusion.
 */
export type RendererStatus = 'hardware' | 'software' | 'stalled' | 'unknown';

/**
 * Query the live WebGL renderer and report whether we are on the iGPU or
 * silently fell back to software. Uses WEBGL_debug_renderer_info's
 * UNMASKED_RENDERER_WEBGL — the exact string that tells hardware
 * ("ANGLE (Intel, Vulkan … UHD Graphics 770 …)") from software
 * ("… SwiftShader …" / "llvmpipe") or a failed context.
 *
 * Best-effort and time-boxed: any failure or a probe that takes too long is
 * logged, never thrown. Prefer calling this on a blank page BEFORE
 * navigating somewhere heavy — creating a second WebGL context on a page
 * that already holds one is markedly slower and can hit the context limit.
 *
 * `log` is passed in so the message is attributed to the caller's module
 * (scanner vs bridge).
 */
export async function logWebglRenderer(page: Page, log: pino.Logger): Promise<RendererStatus> {
  try {
    const probe = page.evaluate(() => {
      try {
        const canvas = document.createElement('canvas');
        const gl = (canvas.getContext('webgl') ||
          canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
        if (!gl) return 'no-webgl-context';
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        return dbg
          ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
          : String(gl.getParameter(gl.VERSION)) + ' (no debug_renderer_info)';
      } catch (e) {
        return 'webgl-check-failed: ' + String(e);
      }
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const renderer = await Promise.race([
      probe,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), RENDERER_PROBE_TIMEOUT_MS);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
    clearTimeout(timer);
    // Don't leave the losing promise as an unhandled rejection if the page
    // is torn down while the probe is still running.
    void Promise.resolve(probe).catch(() => {});

    if (renderer === null) {
      log.warn(
        `WebGL renderer probe timed out after ${RENDERER_PROBE_TIMEOUT_MS} ms. ` +
          'Creating a WebGL context is not completing at all, so the GPU path is ' +
          'broken rather than merely unavailable — anything needing a context ' +
          '(i.e. the game itself) would hang the same way.',
      );
      return 'stalled';
    }
    if (/swiftshader|llvmpipe|software|no-webgl/i.test(renderer)) {
      log.warn(
        `GPU mode ON but WebGL is NOT on the iGPU: "${renderer}". ` +
          'Check /dev/dri passthrough and the mesa/vulkan drivers. See docs/igpu-passthrough.md.',
      );
      return 'software';
    }
    log.info(`GPU mode ON — WebGL renderer: "${renderer}"`);
    return 'hardware';
  } catch (err) {
    log.warn('Could not query WebGL renderer for GPU verification: ' + String(err));
    return 'unknown';
  }
}
