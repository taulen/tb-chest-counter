import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clientAddressFor,
  CONSERVATIVE_STEP,
  initialStreamStep,
  isDefinitelyLocalAddress,
  isStreamProfileForced,
  ladderStep,
  STREAM_LADDER,
} from '../../../src/web/login-bridge/link-quality.js';

const ENV_KEY = 'LOGIN_BRIDGE_STREAM_PROFILE';
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

describe('isDefinitelyLocalAddress', () => {
  it('accepts loopback', () => {
    expect(isDefinitelyLocalAddress('127.0.0.1')).toBe(true);
    expect(isDefinitelyLocalAddress('::1')).toBe(true);
  });

  it('accepts RFC1918 ranges', () => {
    expect(isDefinitelyLocalAddress('10.0.0.5')).toBe(true);
    expect(isDefinitelyLocalAddress('192.168.1.20')).toBe(true);
    expect(isDefinitelyLocalAddress('172.16.0.1')).toBe(true);
    expect(isDefinitelyLocalAddress('172.31.255.254')).toBe(true);
  });

  it('rejects the near-misses around 172.16/12', () => {
    expect(isDefinitelyLocalAddress('172.15.0.1')).toBe(false);
    expect(isDefinitelyLocalAddress('172.32.0.1')).toBe(false);
  });

  it('accepts link-local and IPv6 unique-local', () => {
    expect(isDefinitelyLocalAddress('169.254.10.10')).toBe(true);
    expect(isDefinitelyLocalAddress('fe80::1')).toBe(true);
    expect(isDefinitelyLocalAddress('fd00::abcd')).toBe(true);
  });

  it('unwraps the IPv4-mapped form Node reports on a dual-stack listener', () => {
    expect(isDefinitelyLocalAddress('::ffff:192.168.1.5')).toBe(true);
  });

  it('strips brackets, ports and IPv6 zone ids', () => {
    expect(isDefinitelyLocalAddress('[::1]:54321')).toBe(true);
    expect(isDefinitelyLocalAddress('fe80::1%eth0')).toBe(true);
  });

  it('returns false for global addresses — meaning "unprovable", not "remote"', () => {
    // The bug this replaced: a real LAN client on IPv6 has a globally
    // routable address because IPv6 has no NAT, so this must NOT be the
    // signal that decides the profile. See the initialStreamStep tests.
    expect(isDefinitelyLocalAddress('2a0d:9c42:9:8:bdea:e1a8:3101:6762')).toBe(false);
    expect(isDefinitelyLocalAddress('8.8.8.8')).toBe(false);
    expect(isDefinitelyLocalAddress('100.64.0.1')).toBe(false);
  });

  it('rejects missing or junk input', () => {
    expect(isDefinitelyLocalAddress(undefined)).toBe(false);
    expect(isDefinitelyLocalAddress(null)).toBe(false);
    expect(isDefinitelyLocalAddress('')).toBe(false);
    expect(isDefinitelyLocalAddress('not-an-address')).toBe(false);
  });
});

describe('clientAddressFor', () => {
  it('prefers the leftmost X-Forwarded-For entry over the socket peer', () => {
    // Behind a reverse proxy the socket peer is always local.
    expect(clientAddressFor('127.0.0.1', '203.0.113.9, 10.0.0.2')).toBe('203.0.113.9');
  });

  it('falls back to the socket peer when there is no forwarding header', () => {
    expect(clientAddressFor('192.168.1.4', undefined)).toBe('192.168.1.4');
    expect(clientAddressFor('192.168.1.4', '')).toBe('192.168.1.4');
    expect(clientAddressFor('192.168.1.4', '   ')).toBe('192.168.1.4');
  });

  it('handles the array header form Node can produce', () => {
    expect(clientAddressFor('127.0.0.1', ['203.0.113.9'])).toBe('203.0.113.9');
  });

  it('returns undefined when nothing is known', () => {
    expect(clientAddressFor(undefined, undefined)).toBeUndefined();
  });
});

describe('initialStreamStep', () => {
  it('starts a fast link at the top of the ladder', () => {
    const s = initialStreamStep({ address: '203.0.113.9', rttMs: 1.2 });
    expect(s.step).toBe(0);
    expect(ladderStep(s.step).everyNthFrame).toBe(1);
    expect(ladderStep(s.step).quality).toBeGreaterThan(70);
  });

  it('starts an IPv6 LAN client at the top, from RTT rather than its address', () => {
    // The reported bug: 2a0d:... is global-unicast IPv6, which is what every
    // LAN client looks like once the ISP delegates a prefix.
    const s = initialStreamStep({ address: '2a0d:9c42:9:8:bdea:e1a8:3101:6762', rttMs: 0.8 });
    expect(s.step).toBe(0);
  });

  it('still starts at the top through a CDN hairpin (~12ms)', () => {
    // Reaching us via Cloudflare measures ~12ms even from the same LAN. An
    // earlier 10ms cutoff misclassified exactly this and served a frugal
    // stream to a link with plenty of bandwidth.
    expect(initialStreamStep({ rttMs: 12.6 }).step).toBe(0);
  });

  it('steps the starting rung down as RTT grows', () => {
    const steps = [12, 60, 150, 400].map((rttMs) => initialStreamStep({ rttMs }).step);
    expect(steps).toEqual([0, 1, 2, 3]);
    // Monotonic: a worse link never starts better.
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThanOrEqual(steps[i - 1]);
  });

  it('never returns a step outside the ladder', () => {
    for (const rttMs of [0, 0.001, 9_999, 1e9]) {
      const { step } = initialStreamStep({ rttMs });
      expect(step).toBeGreaterThanOrEqual(0);
      expect(step).toBeLessThan(STREAM_LADDER.length);
    }
  });

  it('treats a private address as fast even without a measurement', () => {
    const s = initialStreamStep({ address: '192.168.1.10', rttMs: null });
    expect(s.step).toBe(0);
    expect(s.reason).toContain('private address');
  });

  it('is conservative when nothing can be determined', () => {
    const s = initialStreamStep({});
    expect(s.step).toBe(CONSERVATIVE_STEP);
    expect(s.reason).toContain('could not be measured');
  });

  it('reports the measured RTT so a frugal stream is explainable', () => {
    expect(initialStreamStep({ rttMs: 42.37 }).reason).toContain('42.4 ms');
  });

  it('honours a pinned local override even on a slow link', () => {
    process.env[ENV_KEY] = 'local';
    const s = initialStreamStep({ address: '8.8.8.8', rttMs: 500 });
    expect(s.step).toBe(0);
    expect(s.reason).toContain('pinned');
    expect(isStreamProfileForced()).toBe(true);
  });

  it('honours a pinned remote override even on loopback', () => {
    process.env[ENV_KEY] = 'remote';
    expect(initialStreamStep({ address: '127.0.0.1', rttMs: 0.1 }).step).toBe(CONSERVATIVE_STEP);
  });

  it("ignores 'auto' and anything unrecognised, falling back to measurement", () => {
    process.env[ENV_KEY] = 'auto';
    expect(initialStreamStep({ rttMs: 0.5 }).step).toBe(0);
    expect(isStreamProfileForced()).toBe(false);
    process.env[ENV_KEY] = 'nonsense';
    expect(initialStreamStep({ rttMs: 900 }).step).toBe(STREAM_LADDER.length - 1);
  });
});

describe('STREAM_LADDER', () => {
  it('degrades monotonically from best to worst', () => {
    for (let i = 1; i < STREAM_LADDER.length; i++) {
      expect(STREAM_LADDER[i].quality).toBeLessThanOrEqual(STREAM_LADDER[i - 1].quality);
      expect(STREAM_LADDER[i].everyNthFrame).toBeGreaterThanOrEqual(
        STREAM_LADDER[i - 1].everyNthFrame,
      );
    }
  });

  it('clamps out-of-range indices instead of returning undefined', () => {
    expect(ladderStep(-5)).toEqual(STREAM_LADDER[0]);
    expect(ladderStep(99)).toEqual(STREAM_LADDER[STREAM_LADDER.length - 1]);
  });
});
