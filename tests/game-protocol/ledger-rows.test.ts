/**
 * Ledger → resource_transactions mapping. Every expectation here is a real case
 * checked against the OCR rows on prod (clan 3, Nov 2026).
 */
import { describe, expect, it } from 'vitest';
import { ledgerToRows } from '../../src/game-protocol/ledger-rows.js';
import type { LedgerEntry } from '../../src/game-protocol/messages.js';

const types = [
  { id: 1, name: 'Food', slug: 'food' },
  { id: 2, name: 'Silver', slug: 'silver' },
  { id: 4, name: 'Dragon Coins', slug: 'dragon-coins' },
  { id: 6, name: 'Scientific Tractates', slug: 'scientific-tractates' },
  { id: 7, name: 'Clan Speedup', slug: 'clan-speedup' },
  { id: 13, name: 'Seal of Suppression', slug: 'seal-of-suppression' },
];
const names = {
  gifts: {
    2: { chest: 'Silver', source: '' },
    6: { chest: 'Food', source: '' },
    20: { chest: 'Scientific Tractates', source: '' },
    31: { chest: 'Dragon Coins', source: '' },
    703022: { chest: 'Seal of Suppression', source: '' },
  },
};
const opts = { afterDate: '', rolloverUtcHour: 17, untrackedSlugs: new Set(['seal-of-suppression']) };
const entry = (entryId: number, kind: number, amounts: Record<string, number>, iso: string): LedgerEntry => ({
  entryId, playerId: 100 + entryId, kind, resource: Number(Object.keys(amounts)[0] ?? 0), occurredAt: Date.parse(iso) / 1000, amounts,
});

describe('ledgerToRows', () => {
  it('maps donations by resource name, on the 17:00-UTC game day', () => {
    const { rows } = ledgerToRows([
      entry(1, 3, { 6: 226200000 }, '2026-11-15T13:17:23Z'), // before the rollover → the 14th
      entry(2, 3, { 2: 12566757 }, '2026-11-14T22:43:39Z'),   // after it → the 14th
      entry(3, 4, { 20: 4200000 }, '2026-11-06T10:00:00Z'),
    ], names, types, opts);
    expect(rows).toEqual([
      { entryId: 1, playerId: 101, resourceTypeId: 1, direction: 1, amount: 226200000, transactionDate: '2026-11-14' },
      { entryId: 2, playerId: 102, resourceTypeId: 2, direction: 1, amount: 12566757, transactionDate: '2026-11-14' },
      { entryId: 3, playerId: 103, resourceTypeId: 6, direction: 1, amount: 4200000, transactionDate: '2026-11-05' },
    ]);
  });

  it('counts Clan Speedup donations in hours', () => {
    const { rows } = ledgerToRows([
      entry(1, 2, { 2051: 2, 2054: 2 }, '2026-11-10T01:26:52Z'),
      entry(2, 2, { 2052: 4, 2053: 2 }, '2026-11-13T16:54:52Z'),
      entry(3, 2, { 2051: 9, 2052: 4 }, '2026-11-15T10:04:49Z'),
    ], names, types, opts);
    expect(rows.map((r) => [r.resourceTypeId, r.amount])).toEqual([[7, 54], [7, 62], [7, 59]]);
  });

  it('books clan payouts (kind 1) as received, and leaves out kind 8 and untracked resources', () => {
    const { rows, skipped } = ledgerToRows([
      entry(1, 1, { 31: 540000 }, '2026-11-10T12:00:00Z'),
      entry(2, 8, { 20: 440000000 }, '2026-11-06T18:00:19Z'),
      entry(3, 1, { 703022: 6 }, '2026-11-16T19:20:27Z'),
    ], names, types, opts);
    expect(rows).toEqual([
      { entryId: 1, playerId: 101, resourceTypeId: 4, direction: -1, amount: 540000, transactionDate: '2026-11-09' },
    ]);
    expect(skipped).toEqual({ 'kind 8': 1, 'untracked seal-of-suppression': 1 });
  });

  it('never re-imports a day the OCR capture already covered', () => {
    const { rows, skipped } = ledgerToRows([
      entry(1, 3, { 6: 1 }, '2026-11-15T13:17:23Z'), // game day 14th
      entry(2, 3, { 6: 2 }, '2026-11-15T18:00:00Z'), // game day 15th
      entry(3, 3, { 6: 3 }, '2026-11-16T18:00:00Z'), // game day 16th
    ], names, types, { ...opts, afterDate: '2026-11-15' });
    expect(rows.map((r) => r.entryId)).toEqual([3]);
    expect(skipped['covered by OCR rows']).toBe(2);
  });

  it('reports an item it cannot name instead of guessing', () => {
    const { rows, skipped } = ledgerToRows([entry(1, 4, { 999999: 5 }, '2026-11-10T12:00:00Z')], names, types, opts);
    expect(rows).toEqual([]);
    expect(skipped).toEqual({ 'unmapped item 999999': 1 });
  });
});
