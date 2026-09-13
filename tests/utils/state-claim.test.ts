import { describe, expect, it } from 'vitest';
import { StateClaim } from '../../src/utils/state-claim.js';

describe('StateClaim', () => {
  it('grants the claim to the first caller', () => {
    const c = new StateClaim();
    expect(c.tryClaim()).toBe(true);
  });

  it('refuses subsequent callers until release', () => {
    const c = new StateClaim();
    c.tryClaim();
    expect(c.tryClaim()).toBe(false);
    expect(c.tryClaim()).toBe(false);
  });

  it('grants the claim again after release', () => {
    const c = new StateClaim();
    c.tryClaim();
    c.release();
    expect(c.tryClaim()).toBe(true);
  });

  it('isClaimed reflects current state without taking the claim', () => {
    const c = new StateClaim();
    expect(c.isClaimed()).toBe(false);
    c.tryClaim();
    expect(c.isClaimed()).toBe(true);
    expect(c.tryClaim()).toBe(false);
    c.release();
    expect(c.isClaimed()).toBe(false);
  });

  it('survives the concurrent-tryClaim race (synchronous JS)', () => {
    // The whole point of the helper: even if a hundred call sites all
    // call tryClaim() in the same JS tick, exactly one wins. Real
    // concurrency in Node only happens at await boundaries, so this is
    // sufficient as long as nobody splits the check-then-set across an
    // await. The class encapsulates the pattern so they can't.
    const c = new StateClaim();
    const results = Array.from({ length: 100 }, () => c.tryClaim());
    const wins = results.filter(Boolean).length;
    expect(wins).toBe(1);
  });

  it('release is idempotent', () => {
    const c = new StateClaim();
    c.release(); // not currently claimed; should not throw
    c.tryClaim();
    c.release();
    c.release();
    expect(c.isClaimed()).toBe(false);
  });
});
