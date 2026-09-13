import type { CDPSession, Page } from 'playwright';
import { childLogger } from '../../utils/logger.js';
import { createCoalescedWarner } from '../../utils/log-throttle.js';

const log = childLogger('login-bridge-relay');

// Input relay warnings are coalesced: a dead or wedged browser fails EVERY
// forwarded event with the same error, and mousemove alone can produce
// dozens per second. Without this, one bad second floods the 20-entry
// System warning buffer and evicts everything else.
const warner = createCoalescedWarner((msg) => log.warn(msg));

/** Emit any pending "repeated N×" summaries. Call on session teardown. */
export function flushRelayWarnings(): void {
  warner.flush();
}

/** Test seam — drop suppression state without emitting summaries. */
export function resetRelayWarnings(): void {
  warner.reset();
}

/**
 * Wire-format message types the admin browser sends over the WebSocket.
 * Kept in their own module so the dispatcher and any future test suite
 * import the same shapes.
 */
export interface ClientMouseEvent {
  type: 'mousemove' | 'mousedown' | 'mouseup' | 'wheel';
  x: number;
  y: number;
  button?: 'left' | 'right' | 'middle';
  buttons?: number;
  modifiers?: number;
  deltaX?: number;
  deltaY?: number;
  clickCount?: number;
}

export interface ClientKeyEvent {
  type: 'keydown' | 'keyup' | 'char';
  key?: string;
  code?: string;
  text?: string;
  /** `KeyboardEvent.keyCode` — legacy in the DOM, but it IS the Windows VK code. */
  keyCode?: number;
  /** `KeyboardEvent.location` — 3 means numpad. */
  location?: number;
  /** `KeyboardEvent.repeat` — a held-down key. */
  repeat?: boolean;
  modifiers?: number;
}

/**
 * Windows virtual key codes for the keys that do nothing without one.
 *
 * Chromium does not act on the `key` string: every editing and navigation
 * key is dispatched by the renderer from `windowsVirtualKeyCode` (VKEY_BACK
 * → delete-backward, and so on). Omit it and the keydown arrives, fires no
 * command, and the keystroke is silently swallowed — which is exactly how
 * Backspace and Delete came to be dead in the bridge while typing worked
 * fine, since a printable key carries `text` and needs no command.
 *
 * The client sends `KeyboardEvent.keyCode`, which already is this number;
 * this table is the fallback for a browser that reports 0 (some IMEs, and
 * synthetic events). Only keys whose whole purpose is a command are listed —
 * a missing printable key still types, because its `text` does the work.
 */
const NAMED_KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Meta: 91,
  CapsLock: 20,
};

function resolveVirtualKeyCode(msg: ClientKeyEvent): number {
  if (typeof msg.keyCode === 'number' && msg.keyCode > 0) return msg.keyCode;
  if (msg.key && NAMED_KEY_CODES[msg.key] !== undefined) return NAMED_KEY_CODES[msg.key];
  // A single printable character's VK code is its uppercased code point for
  // letters and digits, which covers the rest of what a keyboard sends.
  if (msg.key && msg.key.length === 1) return msg.key.toUpperCase().charCodeAt(0);
  return 0;
}

export type ClientMessage =
  | ({ kind: 'mouse' } & ClientMouseEvent)
  | ({ kind: 'key' } & ClientKeyEvent)
  | { kind: 'reload' }
  | { kind: 'navigate'; url: string };

/**
 * Outcome of one dispatch attempt.
 *
 *   'ok'            — forwarded (or safely ignored, e.g. a rejected URL).
 *   'failed'        — transient failure; the browser is still there.
 *   'target-closed' — the page/context/browser is GONE. Terminal for the
 *                     session: every later event would fail identically,
 *                     so the caller should tear the bridge down rather
 *                     than keep relaying into a corpse.
 */
export type DispatchResult = 'ok' | 'failed' | 'target-closed';

// Substrings Playwright/CDP use when the far end no longer exists. Matched
// case-insensitively against the error message.
const TARGET_GONE_PATTERNS = [
  'target page, context or browser has been closed',
  'target closed',
  'browser has been closed',
  'browser has disconnected',
  'session closed',
  'page crashed',
  'target crashed',
  'connection closed',
  'websocket is not open',
];

/**
 * True when the error means the remote browser is gone for good, as
 * opposed to one event failing. Used to decide "tear down" vs "warn".
 */
export function isTargetGoneError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return TARGET_GONE_PATTERNS.some((p) => msg.includes(p));
}

/** Error text without Playwright's multi-line call-log tail. */
function shortError(err: unknown): string {
  const raw = String(err instanceof Error ? err.message : err);
  return raw.split('\n')[0].trim();
}

/**
 * Forward one parsed client message to the underlying browser via CDP /
 * Playwright Page. Pure dispatcher — no LoginBridge state, takes its
 * collaborators by argument so tests can stub them.
 *
 * Never throws: the caller doesn't await each event (they're
 * fire-and-forget input), so an exception bubbling out would crash the
 * WebSocket handler for no benefit. Failures come back as a
 * DispatchResult instead, and repeated identical failures are coalesced
 * into one log line per window.
 */
export async function dispatchClientMessage(
  cdp: CDPSession,
  page: Page,
  msg: ClientMessage,
): Promise<DispatchResult> {
  try {
    switch (msg.kind) {
      case 'mouse': {
        if (msg.type === 'wheel') {
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: msg.x,
            y: msg.y,
            deltaX: msg.deltaX ?? 0,
            deltaY: msg.deltaY ?? 0,
            modifiers: msg.modifiers ?? 0,
          });
          return 'ok';
        }
        const cdpType =
          msg.type === 'mousedown' ? 'mousePressed'
          : msg.type === 'mouseup' ? 'mouseReleased'
          : 'mouseMoved';
        await cdp.send('Input.dispatchMouseEvent', {
          type: cdpType,
          x: msg.x,
          y: msg.y,
          button: msg.button ?? 'left',
          buttons: msg.buttons ?? 0,
          clickCount: msg.clickCount ?? (cdpType === 'mouseMoved' ? 0 : 1),
          modifiers: msg.modifiers ?? 0,
        });
        return 'ok';
      }
      case 'key': {
        if (msg.type === 'char') {
          await cdp.send('Input.dispatchKeyEvent', {
            type: 'char',
            text: msg.text ?? '',
            modifiers: msg.modifiers ?? 0,
          });
          return 'ok';
        }
        // Enter inserts a carriage return; the client can't know that from
        // `ev.key` alone, which is the string 'Enter'.
        const text = msg.text ?? (msg.key === 'Enter' ? '\r' : undefined);
        await cdp.send('Input.dispatchKeyEvent', {
          // 'keyDown' promises a character will follow it. A key that
          // produces no text must go as 'rawKeyDown' or the renderer waits
          // for a char event that never arrives instead of running the
          // key's command.
          type: msg.type === 'keyup' ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown',
          key: msg.key,
          code: msg.code,
          text,
          unmodifiedText: text,
          windowsVirtualKeyCode: resolveVirtualKeyCode(msg),
          nativeVirtualKeyCode: resolveVirtualKeyCode(msg),
          location: msg.location ?? 0,
          isKeypad: msg.location === 3,
          autoRepeat: msg.repeat ?? false,
          modifiers: msg.modifiers ?? 0,
        });
        return 'ok';
      }
      case 'reload': {
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        return 'ok';
      }
      case 'navigate': {
        if (typeof msg.url === 'string' && msg.url.startsWith('http')) {
          await page.goto(msg.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
        }
        return 'ok';
      }
    }
    return 'ok';
  } catch (err) {
    const detail = shortError(err);
    if (isTargetGoneError(err)) {
      // One line for the whole session, not one per queued event — the
      // caller tears the bridge down on this result.
      warner.warn('target-gone', `Remote browser is gone; dropping relayed input (${msg.kind}): ${detail}`);
      return 'target-closed';
    }
    // Keyed on the error text as well as the kind so a genuinely new
    // failure still gets logged immediately instead of hiding behind an
    // unrelated one's suppression window.
    warner.warn(`fail:${msg.kind}:${detail}`, `Failed to dispatch client event (${msg.kind}): ${detail}`);
    return 'failed';
  }
}

/**
 * Parse a raw WebSocket payload into a ClientMessage, returning null on
 * unparseable input. Extracted from the dispatcher so the WebSocket
 * handler in LoginBridge can stay a one-liner.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    return JSON.parse(raw) as ClientMessage;
  } catch {
    return null;
  }
}
