import { describe, expect, it, vi } from 'vitest';
import { startScreencast } from '../../../src/web/login-bridge/screencast.js';

/**
 * The screencast module's job is small but its ordering is load-bearing:
 * Chromium will not capture another frame until the current one is acked,
 * so the ack must not queue behind our own frame handling — that cost comes
 * straight off the framerate.
 */
type Handler = (event: { data: string; metadata: unknown; sessionId: number }) => void;

function makeCdpStub() {
  let handler: Handler | null = null;
  const stub = {
    on: vi.fn((event: string, fn: Handler) => {
      if (event === 'Page.screencastFrame') handler = fn;
    }),
    send: vi.fn<(method: string, params?: unknown) => Promise<void>>(async () => undefined),
    emitFrame(data: string, sessionId = 1) {
      if (!handler) throw new Error('no frame handler registered');
      handler({ data, metadata: {}, sessionId });
    },
  };
  return stub;
}

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03]);

describe('startScreencast', () => {
  it('applies the caller-supplied quality and frame skipping', async () => {
    const cdp = makeCdpStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startScreencast(cdp as any, {
      width: 1280, height: 800, quality: 80, everyNthFrame: 1, onFrame: () => {},
    });
    const args = cdp.send.mock.calls.find((c) => c[0] === 'Page.startScreencast')?.[1] as {
      quality: number; everyNthFrame: number; maxWidth: number; maxHeight: number;
    };
    expect(args.quality).toBe(80);
    expect(args.everyNthFrame).toBe(1);
    expect(args.maxWidth).toBe(1280);
    expect(args.maxHeight).toBe(800);
  });

  it('falls back to the frugal defaults when not told otherwise', async () => {
    const cdp = makeCdpStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startScreencast(cdp as any, { width: 640, height: 480, onFrame: () => {} });
    const args = cdp.send.mock.calls.find((c) => c[0] === 'Page.startScreencast')?.[1] as {
      quality: number; everyNthFrame: number;
    };
    expect(args.quality).toBe(50);
    expect(args.everyNthFrame).toBe(3);
  });

  it('hands the frame on as decoded JPEG bytes, not base64', async () => {
    const cdp = makeCdpStub();
    const onFrame = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startScreencast(cdp as any, { width: 1, height: 1, onFrame });

    cdp.emitFrame(jpeg.toString('base64'));
    expect(onFrame).toHaveBeenCalledTimes(1);
    const received = onFrame.mock.calls[0][0] as Buffer;
    expect(Buffer.isBuffer(received)).toBe(true);
    expect(received.equals(jpeg)).toBe(true);
  });

  it('acks before delivering the frame, so our handling is off the framerate path', async () => {
    const cdp = makeCdpStub();
    const order: string[] = [];
    cdp.send.mockImplementation(async (method: string) => {
      if (method === 'Page.screencastFrameAck') order.push('ack');
      return undefined;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startScreencast(cdp as any, {
      width: 1, height: 1, onFrame: () => order.push('deliver'),
    });

    cdp.emitFrame(jpeg.toString('base64'));
    expect(order).toEqual(['ack', 'deliver']);
  });

  it('acks every frame so the stream keeps flowing', async () => {
    const cdp = makeCdpStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startScreencast(cdp as any, { width: 1, height: 1, onFrame: () => {} });

    cdp.emitFrame(jpeg.toString('base64'), 7);
    cdp.emitFrame(jpeg.toString('base64'), 8);
    const acks = cdp.send.mock.calls.filter((c) => c[0] === 'Page.screencastFrameAck');
    expect(acks).toHaveLength(2);
    expect(acks[0][1]).toEqual({ sessionId: 7 });
    expect(acks[1][1]).toEqual({ sessionId: 8 });
  });

  it('a throwing onFrame does not break the ack loop', async () => {
    const cdp = makeCdpStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startScreencast(cdp as any, {
      width: 1, height: 1,
      onFrame: () => { throw new Error('client send blew up'); },
    });

    expect(() => cdp.emitFrame(jpeg.toString('base64'))).not.toThrow();
    expect(cdp.send.mock.calls.some((c) => c[0] === 'Page.screencastFrameAck')).toBe(true);
  });

  it('setProfile re-issues startScreencast so quality can change mid-session', async () => {
    // Re-issuing Page.startScreencast updates a live stream in place. That's
    // what lets the bridge move along the quality ladder instead of guessing
    // once at connect time and living with it.
    const cdp = makeCdpStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cast = await startScreencast(cdp as any, {
      width: 1280, height: 800, quality: 80, everyNthFrame: 1, onFrame: () => {},
    });

    await cast.setProfile(55, 3);

    const starts = cdp.send.mock.calls.filter((c) => c[0] === 'Page.startScreencast');
    expect(starts).toHaveLength(2);
    const latest = starts[1][1] as { quality: number; everyNthFrame: number; maxWidth: number };
    expect(latest.quality).toBe(55);
    expect(latest.everyNthFrame).toBe(3);
    // Dimensions must survive a retune — only quality/framerate move.
    expect(latest.maxWidth).toBe(1280);
  });

  it('setProfile on a dead session does not throw', async () => {
    const cdp = makeCdpStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cast = await startScreencast(cdp as any, { width: 1, height: 1, onFrame: () => {} });
    cdp.send.mockImplementation(async () => { throw new Error('Target closed'); });
    await expect(cast.setProfile(45, 5)).resolves.toBeUndefined();
  });

  it('a failing ack is swallowed rather than becoming an unhandled rejection', async () => {
    const cdp = makeCdpStub();
    cdp.send.mockImplementation(async (method: string) => {
      if (method === 'Page.screencastFrameAck') throw new Error('Target closed');
      return undefined;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startScreencast(cdp as any, { width: 1, height: 1, onFrame: () => {} });

    expect(() => cdp.emitFrame(jpeg.toString('base64'))).not.toThrow();
    // Let the rejected ack promise settle; an unhandled rejection here
    // would surface as a test-run failure.
    await new Promise((r) => setImmediate(r));
  });
});
