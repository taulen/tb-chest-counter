import { describe, expect, it, vi } from 'vitest';
import { hostOf, installNavigationGuard, isAllowedTopLevelUrl } from '../../../src/web/login-bridge/nav-guard.js';

/**
 * The bridge browser holds the shared game account's session, so the page
 * the admins drive must not follow the game's outbound links. The guard
 * refuses those at the browser; these pin both the rule and the one detail
 * that keeps the game alive — a refusal is failed as Aborted, never as an
 * error that Chromium would answer with an error page in the game's place.
 */

const MAIN = 'MAIN-FRAME';

type Paused = { requestId: string; frameId: string; request: { url: string } };

function makeCdpStub() {
  let handler: ((event: Paused) => void) | null = null;
  const stub = {
    on: vi.fn((event: string, fn: (event: Paused) => void) => {
      if (event === 'Fetch.requestPaused') handler = fn;
    }),
    send: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async (method) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: MAIN } } };
      return undefined;
    }),
    pause(url: string, frameId = MAIN, requestId = 'r1') {
      if (!handler) throw new Error('no requestPaused handler registered');
      handler({ requestId, frameId, request: { url } });
    },
    callsTo(method: string) {
      return stub.send.mock.calls.filter((c) => c[0] === method).map((c) => c[1]);
    },
  };
  return stub;
}

describe('isAllowedTopLevelUrl', () => {
  it.each([
    'https://totalbattle.com',
    'https://totalbattle.com/?present=dragonroulette100',
    'https://www.totalbattle.com/en/',
    'http://totalbattle.com/',
    'https://TotalBattle.com/',
  ])('allows %s', (url) => {
    expect(isAllowedTopLevelUrl(url)).toBe(true);
  });

  it.each([
    'https://www.youtube.com/watch?v=abc',
    'https://discord.gg/xyz',
    'https://totalbattle.com.evil.example/',
    'https://totalbattle.com@evil.example/',
    'https://evil.example/?next=https://totalbattle.com',
    'https://nottotalbattle.com/',
    'not a url',
  ])('refuses %s', (url) => {
    expect(isAllowedTopLevelUrl(url)).toBe(false);
  });

  it('leaves non-web schemes alone — there is no other site behind them', () => {
    expect(isAllowedTopLevelUrl('about:blank')).toBe(true);
    expect(isAllowedTopLevelUrl('chrome-error://chromewebdata/')).toBe(true);
  });
});

describe('installNavigationGuard', () => {
  it('intercepts documents only, so the game\'s assets never pause', async () => {
    const cdp = makeCdpStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await installNavigationGuard(cdp as any, () => {});
    const [enable] = cdp.callsTo('Fetch.enable') as Array<{ patterns: Array<{ resourceType?: string }> }>;
    expect(enable.patterns).toHaveLength(1);
    expect(enable.patterns[0].resourceType).toBe('Document');
  });

  it('listens before enabling, so no paused request can go unanswered', async () => {
    const cdp = makeCdpStub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await installNavigationGuard(cdp as any, () => {});
    const listenedAt = cdp.on.mock.invocationCallOrder[0];
    const enableIdx = cdp.send.mock.calls.findIndex((c) => c[0] === 'Fetch.enable');
    expect(listenedAt).toBeLessThan(cdp.send.mock.invocationCallOrder[enableIdx]);
  });

  it('lets a totalbattle.com navigation through', async () => {
    const cdp = makeCdpStub();
    const onBlocked = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await installNavigationGuard(cdp as any, onBlocked);
    cdp.pause('https://totalbattle.com/?present=abc');
    expect(cdp.callsTo('Fetch.continueRequest')).toEqual([{ requestId: 'r1' }]);
    expect(cdp.callsTo('Fetch.failRequest')).toEqual([]);
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it('aborts a main-frame navigation off the domain, without an error page', async () => {
    const cdp = makeCdpStub();
    const onBlocked = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await installNavigationGuard(cdp as any, onBlocked);
    cdp.pause('https://www.youtube.com/watch?v=abc');
    expect(cdp.callsTo('Fetch.failRequest')).toEqual([{ requestId: 'r1', errorReason: 'Aborted' }]);
    expect(cdp.callsTo('Fetch.continueRequest')).toEqual([]);
    expect(onBlocked).toHaveBeenCalledWith('https://www.youtube.com/watch?v=abc');
  });

  it('leaves iframes the game embeds alone, wherever they load from', async () => {
    const cdp = makeCdpStub();
    const onBlocked = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await installNavigationGuard(cdp as any, onBlocked);
    cdp.pause('https://www.youtube.com/embed/abc', 'SOME-IFRAME');
    expect(cdp.callsTo('Fetch.continueRequest')).toEqual([{ requestId: 'r1' }]);
    expect(onBlocked).not.toHaveBeenCalled();
  });
});

describe('hostOf', () => {
  it('names the host, and falls back to the raw text', () => {
    expect(hostOf('https://www.youtube.com/watch?v=abc')).toBe('www.youtube.com');
    expect(hostOf('garbage')).toBe('garbage');
  });
});
