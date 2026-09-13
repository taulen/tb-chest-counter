import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchClientMessage,
  isTargetGoneError,
  parseClientMessage,
  resetRelayWarnings,
  type ClientMessage,
} from '../../../src/web/login-bridge/relay.js';

/**
 * `dispatchClientMessage` and `parseClientMessage` are the input-relay
 * core of the in-app login bridge. Pure dispatchers — they take a CDP
 * session and a Page by argument, so we can stub both with `vi.fn()`
 * objects and assert the right CDP method was called with the right
 * arguments.
 */

function makeCdpStub() {
  // Typed mock: signature `(method: string, params?: unknown) => Promise<void>`
  // so `mock.calls[i][0]` and `[1]` are introspectable from tests without
  // TS losing the parameter shape.
  return {
    send: vi.fn<(method: string, params?: unknown) => Promise<void>>(async () => undefined),
  };
}

function makePageStub() {
  return {
    reload: vi.fn<(opts?: unknown) => Promise<void>>(async () => undefined),
    goto: vi.fn<(url: string, opts?: unknown) => Promise<void>>(async () => undefined),
  };
}

describe('parseClientMessage', () => {
  it('parses a valid JSON message', () => {
    const m = parseClientMessage(JSON.stringify({ kind: 'reload' }));
    expect(m).toEqual({ kind: 'reload' });
  });

  it('returns null for malformed JSON', () => {
    expect(parseClientMessage('not json')).toBeNull();
    expect(parseClientMessage('')).toBeNull();
  });
});

describe('dispatchClientMessage — mouse events', () => {
  it('dispatches mousedown as Input.dispatchMouseEvent type=mousePressed', async () => {
    const cdp = makeCdpStub();
    const page = makePageStub();
    const msg: ClientMessage = { kind: 'mouse', type: 'mousedown', x: 10, y: 20, button: 'left' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatchClientMessage(cdp as any, page as any, msg);

    expect(cdp.send).toHaveBeenCalledTimes(1);
    expect(cdp.send.mock.calls[0][0]).toBe('Input.dispatchMouseEvent');
    const args = cdp.send.mock.calls[0][1] as { type: string; x: number; y: number };
    expect(args.type).toBe('mousePressed');
    expect(args.x).toBe(10);
    expect(args.y).toBe(20);
  });

  it('dispatches mouseup as type=mouseReleased', async () => {
    const cdp = makeCdpStub();
    const page = makePageStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatchClientMessage(cdp as any, page as any, {
      kind: 'mouse', type: 'mouseup', x: 1, y: 2,
    });
    const args = cdp.send.mock.calls[0][1] as { type: string };
    expect(args.type).toBe('mouseReleased');
  });

  it('dispatches mousemove as type=mouseMoved with clickCount 0', async () => {
    const cdp = makeCdpStub();
    const page = makePageStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatchClientMessage(cdp as any, page as any, {
      kind: 'mouse', type: 'mousemove', x: 5, y: 5,
    });
    const args = cdp.send.mock.calls[0][1] as { type: string; clickCount: number };
    expect(args.type).toBe('mouseMoved');
    expect(args.clickCount).toBe(0);
  });

  it('dispatches wheel as type=mouseWheel with deltaX/deltaY', async () => {
    const cdp = makeCdpStub();
    const page = makePageStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatchClientMessage(cdp as any, page as any, {
      kind: 'mouse', type: 'wheel', x: 0, y: 0, deltaX: 0, deltaY: -100,
    });
    const args = cdp.send.mock.calls[0][1] as { type: string; deltaY: number };
    expect(args.type).toBe('mouseWheel');
    expect(args.deltaY).toBe(-100);
  });
});

describe('dispatchClientMessage — keyboard events', () => {
  it('dispatches keydown as type=keyDown', async () => {
    const cdp = makeCdpStub();
    const page = makePageStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatchClientMessage(cdp as any, page as any, {
      kind: 'key', type: 'keydown', key: 'Enter', code: 'Enter',
    });
    const args = cdp.send.mock.calls[0][1] as { type: string; key?: string };
    expect(args.type).toBe('keyDown');
    expect(args.key).toBe('Enter');
  });

  it('dispatches keyup as type=keyUp', async () => {
    const cdp = makeCdpStub();
    const page = makePageStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatchClientMessage(cdp as any, page as any, {
      kind: 'key', type: 'keyup', key: 'a',
    });
    const args = cdp.send.mock.calls[0][1] as { type: string };
    expect(args.type).toBe('keyUp');
  });

  it('dispatches char as type=char with text', async () => {
    const cdp = makeCdpStub();
    const page = makePageStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatchClientMessage(cdp as any, page as any, {
      kind: 'key', type: 'char', text: 'x',
    });
    const args = cdp.send.mock.calls[0][1] as { type: string; text: string };
    expect(args.type).toBe('char');
    expect(args.text).toBe('x');
  });
});

describe('dispatchClientMessage — page navigation', () => {
  it('reload calls page.reload', async () => {
    const cdp = makeCdpStub();
    const page = makePageStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatchClientMessage(cdp as any, page as any, { kind: 'reload' });
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it('navigate to http URL calls page.goto', async () => {
    const cdp = makeCdpStub();
    const page = makePageStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatchClientMessage(cdp as any, page as any, {
      kind: 'navigate', url: 'https://example.com',
    });
    expect(page.goto).toHaveBeenCalledWith('https://example.com', expect.any(Object));
  });

  it('rejects non-http URLs (no goto call)', async () => {
    const cdp = makeCdpStub();
    const page = makePageStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatchClientMessage(cdp as any, page as any, {
      kind: 'navigate', url: 'javascript:alert(1)',
    });
    expect(page.goto).not.toHaveBeenCalled();
  });
});

describe('isTargetGoneError', () => {
  it('recognises the Playwright closed-target message', () => {
    expect(isTargetGoneError(
      new Error('cdpSession.send: Target page, context or browser has been closed'),
    )).toBe(true);
  });

  it('recognises a crashed renderer and a closed session', () => {
    expect(isTargetGoneError(new Error('Page crashed'))).toBe(true);
    expect(isTargetGoneError(new Error('Protocol error: Session closed.'))).toBe(true);
  });

  it('does NOT treat a transient protocol error as the target being gone', () => {
    // This one showed up alongside the closed-target errors in production
    // but is recoverable — the page is still there, one event lost.
    expect(isTargetGoneError(
      new Error('cdpSession.send: Protocol error (Input.dispatchMouseEvent): Internal error'),
    )).toBe(false);
  });

  it('handles non-Error values without throwing', () => {
    expect(isTargetGoneError('target closed')).toBe(true);
    expect(isTargetGoneError(undefined)).toBe(false);
  });
});

describe('dispatchClientMessage — error handling', () => {
  beforeEach(() => {
    // Warnings are coalesced per key in module state; clear it between
    // cases so one test's suppression window can't swallow the next.
    resetRelayWarnings();
  });

  it('reports ok on success', async () => {
    const cdp = makeCdpStub();
    const page = makePageStub();
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dispatchClientMessage(cdp as any, page as any, { kind: 'mouse', type: 'mousemove', x: 1, y: 1 }),
    ).resolves.toBe('ok');
  });

  it('catches errors thrown by cdp.send and reports failed (does not throw)', async () => {
    const cdp = { send: vi.fn(async () => { throw new Error('Protocol error: Internal error'); }) };
    const page = makePageStub();
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dispatchClientMessage(cdp as any, page as any, { kind: 'mouse', type: 'mousemove', x: 0, y: 0 }),
    ).resolves.toBe('failed');
  });

  it('reports target-closed when the browser is gone, so the caller can tear down', async () => {
    const cdp = {
      send: vi.fn(async () => {
        throw new Error('cdpSession.send: Target page, context or browser has been closed');
      }),
    };
    const page = makePageStub();
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dispatchClientMessage(cdp as any, page as any, { kind: 'mouse', type: 'mousemove', x: 0, y: 0 }),
    ).resolves.toBe('target-closed');
  });

  it('keeps reporting target-closed for a flood of events (no per-event throw)', async () => {
    const cdp = {
      send: vi.fn(async () => { throw new Error('Target closed'); }),
    };
    const page = makePageStub();
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dispatchClientMessage(cdp as any, page as any, { kind: 'mouse', type: 'mousemove', x: 0, y: 0 })),
    );
    expect(results.every((r) => r === 'target-closed')).toBe(true);
  });
});
