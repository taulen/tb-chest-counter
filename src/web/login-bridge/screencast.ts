import type { CDPSession } from 'playwright';
import { childLogger } from '../../utils/logger.js';
import { createCoalescedWarner } from '../../utils/log-throttle.js';
import { isTargetGoneError } from './relay.js';

const log = childLogger('login-bridge-screencast');

// Frame acks run at the streaming framerate, so a wedged CDP session can
// throw many times per second. Coalesce like the input relay does.
const warner = createCoalescedWarner((msg) => log.warn(msg));

/** Emit any pending "repeated N×" summaries. Call on session teardown. */
export function flushScreencastWarnings(): void {
  warner.flush();
}

const SCREENCAST_FORMAT = 'jpeg' as const;
// The bridge streams a live WebGL game, which animates continuously — at
// `everyNthFrame: 1` Chrome pushes a JPEG for every rendered frame
// (30–60 fps), which is megabytes/second of pure egress. Quality and frame
// skipping are therefore the bandwidth dial; the caller picks values from
// the client's link (see link-quality.ts) rather than always paying the
// worst-case-network price. These are the fallbacks if it doesn't.
const DEFAULT_QUALITY = 50;
const DEFAULT_EVERY_NTH_FRAME = 3;

export interface ScreencastFrame {
  data: string;
  metadata: unknown;
  sessionId: number;
}

export interface ScreencastOptions {
  width: number;
  height: number;
  /** JPEG quality 0-100. Defaults to the frugal remote-network value. */
  quality?: number;
  /** Forward only every Nth rendered frame. 1 = full framerate. */
  everyNthFrame?: number;
  /** Called for every frame with the decoded JPEG bytes. The handler should
   *  NOT throw — exceptions here would crash the screencast loop. */
  onFrame: (jpeg: Buffer) => void;
}

/**
 * Start a Chromium screencast on the given CDP session and forward every
 * frame to `onFrame`. Returns a `stop()` callback for teardown.
 *
 * Chromium will not capture the next frame until the current one is
 * acknowledged — that ack loop IS the flow control, which means the
 * achievable framerate is 1 / (per-frame round trip). So the ack goes out
 * FIRST, before we spend anything delivering the frame: previously the
 * delivery (a JSON.stringify of the base64 payload) sat between the frame
 * arriving and Chromium being told it could produce another, so our own
 * encoding cost was subtracted from the framerate on every single frame.
 *
 * A detached/closed CDP session during teardown surfaces as "detached" /
 * closed-target errors, which we swallow silently — anything else is logged
 * (coalesced, since these arrive at the streaming framerate).
 */
export async function startScreencast(
  cdp: CDPSession,
  opts: ScreencastOptions,
): Promise<{
  stop: () => Promise<void>;
  /** Change quality/framerate on a running stream. */
  setProfile: (quality: number, everyNthFrame: number) => Promise<void>;
}> {
  cdp.on('Page.screencastFrame', (event) => {
    // Ack first, and deliberately do not await it — nothing below depends
    // on the result, and awaiting would put a CDP round trip in front of
    // the frame the user is waiting to see.
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch((err) => {
      const msg = String(err instanceof Error ? err.message : err).split('\n')[0];
      // Teardown races (detached session) and a dead browser are expected
      // ways for an ack to fail — the bridge learns about those from the
      // input relay and its page/context listeners, so don't log them.
      if (!msg.includes('detached') && !isTargetGoneError(err)) {
        warner.warn(`ack:${msg}`, 'Frame ack failed: ' + msg);
      }
    });

    try {
      // CDP hands us base64. Decode once here (native, ~0.07 ms for a
      // 180 KB frame) and hand on raw bytes, so the frame can go out as a
      // binary WebSocket message: no re-encoding, no multi-hundred-KB
      // JSON string per frame, and 25% less on the wire than base64.
      opts.onFrame(Buffer.from(event.data, 'base64'));
    } catch (err) {
      warner.warn('onFrame', 'screencast onFrame threw: ' + String(err));
    }
  });

  // Re-issuing Page.startScreencast on a live session updates its parameters
  // in place — that's what lets the bridge move along the quality ladder
  // mid-session instead of guessing once at connect time and living with it.
  const apply = (quality: number, everyNthFrame: number) =>
    cdp.send('Page.startScreencast', {
      format: SCREENCAST_FORMAT,
      quality,
      maxWidth: opts.width,
      maxHeight: opts.height,
      everyNthFrame,
    });

  await apply(opts.quality ?? DEFAULT_QUALITY, opts.everyNthFrame ?? DEFAULT_EVERY_NTH_FRAME);

  return {
    stop: async () => {
      try {
        await cdp.send('Page.stopScreencast').catch(() => {});
      } catch {
        // Ignore — already detached.
      }
    },
    setProfile: async (quality: number, everyNthFrame: number) => {
      try {
        await apply(quality, everyNthFrame);
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err).split('\n')[0];
        if (!msg.includes('detached') && !isTargetGoneError(err)) {
          warner.warn(`setProfile:${msg}`, 'Could not update screencast profile: ' + msg);
        }
      }
    },
  };
}
