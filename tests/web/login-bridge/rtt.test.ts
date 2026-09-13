import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { measureSocketRtt } from '../../../src/web/login-bridge/rtt.js';

/**
 * measureSocketRtt replaced IP-address guessing, which cannot classify an
 * IPv6 client (no NAT — a LAN machine has a globally routable address) or a
 * containerised server (our own interfaces are the Docker bridge, not the
 * operator's LAN). These tests pin the behaviour that matters: it returns a
 * usable number, it never hangs, and it degrades to null.
 */
class FakeSocket extends EventEmitter {
  readyState = 1;
  ping = vi.fn();
  // `off` comes from EventEmitter; ws exposes the same name.
}

function socketThatPongs(delaysMs: number[]): FakeSocket {
  const ws = new FakeSocket();
  let call = 0;
  ws.ping.mockImplementation(() => {
    const delay = delaysMs[Math.min(call, delaysMs.length - 1)];
    call++;
    setTimeout(() => ws.emit('pong'), delay);
  });
  return ws;
}

describe('measureSocketRtt', () => {
  it('returns a measured round-trip for a responsive socket', async () => {
    const ws = socketThatPongs([0, 0, 0]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rtt = await measureSocketRtt(ws as any, 3, 500);
    expect(rtt).not.toBeNull();
    expect(rtt as number).toBeGreaterThanOrEqual(0);
    expect(rtt as number).toBeLessThan(500);
    expect(ws.ping).toHaveBeenCalledTimes(3);
  });

  it('takes the median, so one slow sample cannot skew the class', async () => {
    // Two fast, one very slow. The median must stay near the fast ones.
    const ws = socketThatPongs([0, 0, 120]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rtt = await measureSocketRtt(ws as any, 3, 500);
    expect(rtt as number).toBeLessThan(100);
  });

  it('returns null when no pong ever arrives, without hanging', async () => {
    const ws = new FakeSocket(); // ping does nothing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rtt = await measureSocketRtt(ws as any, 2, 20);
    expect(rtt).toBeNull();
  });

  it('ignores samples that time out but keeps the ones that answered', async () => {
    const ws = new FakeSocket();
    let call = 0;
    ws.ping.mockImplementation(() => {
      // First ping never answers; the rest pong SYNCHRONOUSLY.
      //
      // This used to schedule the pong on setTimeout(..., 0) against a 30ms
      // timeout, which made the test a race between the event loop and the
      // very timeout it is exercising: under a loaded suite a 0ms timer can
      // land past 30ms, the answered samples time out too, and the assertion
      // fails with rtt === null. It was reliable alone and failed in the full
      // run, which is the worst shape a test can have.
      //
      // pingOnce registers its 'pong' listener BEFORE calling ping(), so a
      // synchronous emit exercises exactly the same path with no timer in it.
      // The 30ms budget now only has to cover the sample that is SUPPOSED to
      // expire, and a timeout firing late is harmless. The sibling tests keep
      // real delays, because their claims are about timing.
      if (call++ > 0) ws.emit('pong');
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rtt = await measureSocketRtt(ws as any, 3, 30);
    expect(rtt).not.toBeNull();
    expect(rtt as number).toBeLessThan(30);
  });

  it('stops early if the socket is not open', async () => {
    const ws = socketThatPongs([0]);
    ws.readyState = 3; // CLOSED
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rtt = await measureSocketRtt(ws as any, 3, 100);
    expect(rtt).toBeNull();
    expect(ws.ping).not.toHaveBeenCalled();
  });

  it('survives ping() throwing on a dead socket', async () => {
    const ws = new FakeSocket();
    ws.ping.mockImplementation(() => { throw new Error('socket gone'); });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rtt = await measureSocketRtt(ws as any, 2, 20);
    expect(rtt).toBeNull();
  });

  it('leaves no pong listeners behind', async () => {
    const ws = socketThatPongs([0, 0, 0]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await measureSocketRtt(ws as any, 3, 200);
    expect(ws.listenerCount('pong')).toBe(0);
  });
});
