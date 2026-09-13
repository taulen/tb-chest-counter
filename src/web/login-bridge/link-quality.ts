// Picks the screencast profile for the admin's browser.
//
// The bridge streams a continuously-animating WebGL game as JPEG frames, so
// quality/framerate is a direct bandwidth dial. A fixed profile tuned for the
// worst case (someone driving the bridge over the internet) makes the common
// case — admin on the same LAN as the container — needlessly choppy.
//
// The decision is driven by MEASURED round-trip time, not by the client's IP.
// Address-based classification was tried and is fundamentally broken:
//
//   - IPv6 has no NAT. An ISP delegates a globally-routable prefix to the home
//     router, so a laptop on the same LAN as the server holds a PUBLIC address
//     like 2a0d:9c42:9:8::… . There is no "private range" to test for, and
//     treating global-unicast as remote misclassifies every IPv6 LAN client.
//   - Comparing the client against our own interface subnets doesn't help
//     either: we run in Docker, so our interfaces are the bridge network
//     (172.x), never the operator's LAN.
//
// An address can still prove a link is local (loopback, RFC1918, ULA), so that
// stays as a fast path. What it can never do is prove the opposite — so
// anything else defers to the measurement.

export type LinkKind = 'local' | 'remote';

export interface ScreencastProfile {
  /** JPEG quality, 0-100. */
  quality: number;
  /** Forward only every Nth rendered frame. 1 = full framerate. */
  everyNthFrame: number;
  /** Short human label for the status line. */
  label: string;
}

/** Inputs to the STARTING choice. Both are optional; both may be unknown. */
export interface LinkObservation {
  /** Resolved client address, if known. */
  address?: string;
  /** Measured median round-trip in ms, or null if it couldn't be measured. */
  rttMs?: number | null;
}

/**
 * Quality ladder, best first. The bridge starts somewhere on this ladder and
 * then moves along it based on whether the socket can actually drain the
 * frames — see LoginBridge's adaptive loop.
 *
 * Note `everyNthFrame: 1` is not reckless: Chromium won't capture another
 * frame until the previous one is acked, so the stream is already
 * flow-controlled by the round trip, and sendFrame() drops frames whenever the
 * socket is behind. Those are two real limiters; a fixed divider on top just
 * throws away framerate we already paid to render.
 */
export const STREAM_LADDER: readonly ScreencastProfile[] = [
  { quality: 80, everyNthFrame: 1, label: 'full framerate, high quality' },
  { quality: 72, everyNthFrame: 2, label: 'half framerate, high quality' },
  { quality: 55, everyNthFrame: 3, label: 'reduced framerate, medium quality' },
  { quality: 45, everyNthFrame: 5, label: 'low framerate, low quality' },
];

/** Index of the frugal rung used when we know nothing about the link. */
export const CONSERVATIVE_STEP = 2;

/**
 * RTT boundaries for the STARTING rung, in ms. These are deliberately loose,
 * because RTT is only a proxy for the thing that matters (can the link carry
 * the bitrate) and the adaptive loop measures that directly. The job here is
 * just to avoid opening a satellite link at full framerate.
 *
 * Calibration note: a client reaching us through Cloudflare measures ~12 ms
 * even from the same LAN, because the packets hairpin out and back. That is a
 * fast link with plenty of bandwidth, so the top rung has to extend well past
 * true-LAN numbers — an earlier 10 ms cutoff misclassified exactly that case.
 */
const RTT_STEP_BOUNDARIES_MS = [30, 80, 200];

/**
 * Normalize an address for prefix matching: strip a bracketed port form, an
 * IPv6 zone id, and unwrap the IPv4-mapped form Node reports for v4 clients
 * on a dual-stack listener (`::ffff:192.168.1.5`).
 */
function normalizeAddress(raw: string): string {
  let addr = raw.trim().toLowerCase();
  if (addr.startsWith('[')) {
    const close = addr.indexOf(']');
    if (close > 0) addr = addr.slice(1, close);
  }
  const zone = addr.indexOf('%');
  if (zone > 0) addr = addr.slice(0, zone);
  if (addr.startsWith('::ffff:')) addr = addr.slice('::ffff:'.length);
  return addr;
}

/**
 * True when the address ITSELF proves the client is local: loopback, RFC1918
 * private v4, v4 link-local, IPv6 unique-local (fc00::/7) or v6 link-local.
 *
 * A false result means "not provable from the address" — NOT "remote". Global
 * IPv6 is the normal case for a LAN client, and CGNAT/Tailscale space
 * (100.64/10) can be either. Both fall through to the RTT measurement.
 */
export function isDefinitelyLocalAddress(raw: string | undefined | null): boolean {
  if (!raw) return false;
  const addr = normalizeAddress(raw);
  if (!addr) return false;

  if (addr === '::1' || addr === '::') return true;
  if (addr.startsWith('fe80:')) return true; // v6 link-local
  if (/^f[cd][0-9a-f]{0,2}:/.test(addr)) return true; // fc00::/7 unique-local

  const v4 = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 127) return true;               // loopback
  if (a === 10) return true;                // 10/8
  if (a === 192 && b === 168) return true;  // 192.168/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 169 && b === 254) return true;  // link-local
  return false;
}

/**
 * Work out which address to classify. Behind a reverse proxy the socket peer
 * is the proxy itself (always local), so an X-Forwarded-For chain takes
 * precedence and we use its leftmost entry — the original client.
 */
export function clientAddressFor(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
): string | undefined {
  const xff = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  if (typeof xff === 'string' && xff.trim()) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return remoteAddress;
}

/**
 * Operator override (env LOGIN_BRIDGE_STREAM_PROFILE): 'local' or 'remote'
 * forces a profile, anything else (including unset) means measure.
 */
function profileOverride(): LinkKind | null {
  const v = (process.env.LOGIN_BRIDGE_STREAM_PROFILE ?? '').trim().toLowerCase();
  if (v === 'local' || v === 'high') return 'local';
  if (v === 'remote' || v === 'low') return 'remote';
  return null;
}

/** Whether the operator pinned the ladder, disabling adaptation. */
export function isStreamProfileForced(): boolean {
  return profileOverride() !== null;
}

export interface StartingStep {
  /** Index into STREAM_LADDER. */
  step: number;
  /** Why that rung, for the log line and the client status. */
  reason: string;
}

/**
 * Pick the rung to START on.
 *
 * Order: an explicit override, then an address that proves the link is local,
 * then the measured RTT, then a conservative default. Being wrong here is
 * cheap — the adaptive loop corrects within a couple of seconds — so this errs
 * toward giving a good link the benefit of the doubt.
 */
export function initialStreamStep(obs: LinkObservation = {}): StartingStep {
  const forced = profileOverride();
  if (forced) {
    return {
      step: forced === 'local' ? 0 : CONSERVATIVE_STEP,
      reason: 'pinned by LOGIN_BRIDGE_STREAM_PROFILE',
    };
  }

  if (isDefinitelyLocalAddress(obs.address)) {
    return { step: 0, reason: 'private address' };
  }

  const rtt = obs.rttMs;
  if (typeof rtt === 'number' && Number.isFinite(rtt)) {
    const rounded = Math.round(rtt * 10) / 10;
    const step = RTT_STEP_BOUNDARIES_MS.findIndex((limit) => rtt <= limit);
    return {
      step: step === -1 ? STREAM_LADDER.length - 1 : step,
      reason: `${rounded} ms round-trip`,
    };
  }

  return { step: CONSERVATIVE_STEP, reason: 'round-trip could not be measured' };
}

/** Clamp an arbitrary index onto the ladder. */
export function ladderStep(index: number): ScreencastProfile {
  const i = Math.min(STREAM_LADDER.length - 1, Math.max(0, index));
  return STREAM_LADDER[i];
}
