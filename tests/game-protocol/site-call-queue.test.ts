/**
 * Sign-ins and session checks present a clan's site cookies one at a time,
 * with a settle between (client.ts oneSiteCallAtATime): SK7's login flipped to
 * SIK's account whenever both signed in at once (Nov 17 2026).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { oneSiteCallAtATime } from '../../src/game-protocol/client.js';

afterEach(() => { vi.useRealTimers(); });

describe('one site call at a time', () => {
  it('starts the next call only after the previous one ended and settled', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const call = (name: string, ms: number) => oneSiteCallAtATime(async () => {
      log.push(`${name} start`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${name} end`);
      return name;
    });
    const a = call('SIK', 1000);
    const b = call('SK7', 10);
    await vi.advanceTimersByTimeAsync(1000);
    expect(log).toEqual(['SIK start', 'SIK end']);
    await vi.advanceTimersByTimeAsync(2900);
    expect(log).toEqual(['SIK start', 'SIK end']);
    await vi.advanceTimersByTimeAsync(200);
    expect(log).toEqual(['SIK start', 'SIK end', 'SK7 start', 'SK7 end']);
    await expect(a).resolves.toBe('SIK');
    await expect(b).resolves.toBe('SK7');
    await vi.advanceTimersByTimeAsync(3100); // the queue is process-wide: let the last settle end
  });

  it('lets the next call through after one that failed', async () => {
    vi.useFakeTimers();
    const failed = oneSiteCallAtATime(async () => { throw new Error('site down'); });
    const next = oneSiteCallAtATime(async () => 'ok');
    const failedCheck = expect(failed).rejects.toThrow('site down');
    await vi.advanceTimersByTimeAsync(3100);
    await failedCheck;
    await vi.advanceTimersByTimeAsync(3100);
    await expect(next).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(3100);
  });
});
