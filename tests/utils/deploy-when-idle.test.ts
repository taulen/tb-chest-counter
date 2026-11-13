/**
 * scripts/deploy-when-idle.mjs decides when prod may be redeployed. A wrong
 * "yes" restarts the container mid-scan and loses the cycle (Nov 13 2026), so
 * the verdict is pinned here: it must fail closed on anything it can't read.
 */
import { describe, it, expect } from 'vitest';
// Plain ESM; main() only runs when the script is executed directly.
import { deployVerdict, NEXT_SCAN_MARGIN_MS } from '../../scripts/deploy-when-idle.mjs';

const NOW = Date.UTC(2026, 10, 13, 23, 0, 0);
const health = (scanner: unknown) => ({ ok: true, builtAt: 'x', fingerprint: 'y', scanner });

describe('deployVerdict', () => {
  it('says go only when idle and the next cycle is well off', () => {
    expect(deployVerdict(health({ busy: false, nextScanAt: NOW + 60 * 60_000 }), NOW).ok).toBe(true);
    expect(deployVerdict(health({ busy: false, nextScanAt: null }), NOW).ok).toBe(true);
  });

  it('waits while a scan cycle runs, including the gap between two clans', () => {
    // The loop reports busy for the whole cycle; that gap is where the
    // Nov 13 deploy landed.
    const v = deployVerdict(health({ busy: true, nextScanAt: null }), NOW);
    expect(v).toMatchObject({ ok: false, final: false });
  });

  it('waits when the next cycle would start during the rebuild', () => {
    const soon = deployVerdict(health({ busy: false, nextScanAt: NOW + NEXT_SCAN_MARGIN_MS - 1000 }), NOW);
    expect(soon).toMatchObject({ ok: false, final: false });
    const overdue = deployVerdict(health({ busy: false, nextScanAt: NOW - 1000 }), NOW);
    expect(overdue.ok).toBe(false);
  });

  it('refuses for good when prod does not report scanner state', () => {
    for (const body of [null, undefined, 'oops', { ok: true }, health(null), health({ nextScanAt: null }), health({ busy: 'no' })]) {
      expect(deployVerdict(body, NOW), JSON.stringify(body)).toMatchObject({ ok: false, final: true });
    }
  });
});
