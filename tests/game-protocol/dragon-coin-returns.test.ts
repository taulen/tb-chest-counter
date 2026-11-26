/**
 * Dragon Coins back to members — the planner (game-protocol/dragon-coin-returns.ts):
 * which coins are owed, which of our sends the ledger confirms, what is left
 * alone. Entry shapes are prod's (CWB's Nov 4–6 2026 ledger).
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS,
  UNCONFIRMED_AFTER_MS,
  isSendAccepted,
  planDragonCoinReturns,
  type CoinEntry,
  type CoinReturn,
} from '../../src/game-protocol/dragon-coin-returns.js';

const ON = Date.parse('2026-11-04T12:00:00Z');
const s = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
const donation = (entryId: number, playerId: number, amount: number, iso: string): CoinEntry =>
  ({ entryId, playerId, kind: 4, amount, occurredAt: s(iso) });
const payout = (entryId: number, playerId: number, amount: number, iso: string): CoinEntry =>
  ({ entryId, playerId, kind: 1, amount, occurredAt: s(iso) });
const ret = (id: number, playerId: number, amount: number, ids: number[], status: CoinReturn['status'], iso: string, ledgerEntryId: number | null = null): CoinReturn =>
  ({ id, playerId, amount, donationEntryIds: ids, status, createdAt: Date.parse(iso), ledgerEntryId });

const plan = (entries: CoinEntry[], returns: CoinReturn[] = [], opts: { now?: string; gone?: number[]; enabledAt?: number } = {}) =>
  planDragonCoinReturns({
    enabledAt: opts.enabledAt ?? ON,
    entries,
    returns,
    now: Date.parse(opts.now ?? '2026-11-06T12:00:00Z'),
    onRoster: (id) => !(opts.gone ?? []).includes(id),
  });

describe('planDragonCoinReturns', () => {
  it('sends each member what they brought in, one send per member', () => {
    const p = plan([
      donation(24426, 1297080171719, 62000, '2026-11-04T17:10:28Z'),
      donation(24427, 4376571678254, 42000, '2026-11-04T17:10:30Z'),
      donation(24480, 1297080171719, 21000, '2026-11-04T22:30:01Z'),
    ]);
    expect(p.sends).toEqual([
      { playerId: 1297080171719, amount: 83000, donationEntryIds: [24426, 24480], since: s('2026-11-04T17:10:28Z') },
      { playerId: 4376571678254, amount: 42000, donationEntryIds: [24427], since: s('2026-11-04T17:10:30Z') },
    ]);
    expect(p.held).toEqual([]);
  });

  it('never sends what the clan won (kinds 5 and 8, credited to the Leader at the reset)', () => {
    // CWB, Nov 6 2026 18:00: the clan's event reward, under Princess Hulsa (then Leader).
    const clanReward: CoinEntry = { entryId: 24612, playerId: 4501125731481, kind: 8, amount: 525000, occurredAt: s('2026-11-06T18:00:19Z') };
    // SIN CITY, Nov 25 2026 17:01: the Seasonal Kingdom's, under Queen of Mean.
    const skReward: CoinEntry = { entryId: 11682, playerId: 4599909974273, kind: 5, amount: 262500, occurredAt: s('2026-11-25T17:01:11Z') };
    const p = plan([clanReward, skReward], [], { now: '2026-11-26T00:00:00Z' });
    expect(p.sends).toEqual([]);
    expect(p.held).toEqual([]);
  });

  it('leaves coins that arrived before the switch went on', () => {
    const p = plan([
      donation(1, 10, 21000, '2026-11-04T11:59:59Z'),
      donation(2, 10, 42000, '2026-11-04T12:00:00Z'),
    ]);
    expect(p.sends).toEqual([{ playerId: 10, amount: 42000, donationEntryIds: [2], since: s('2026-11-04T12:00:00Z') }]);
  });

  it('never sends coins a send already covers (sent, sending, or without a clear answer yet)', () => {
    const entries = [donation(1, 10, 1000, '2026-11-04T13:00:00Z'), donation(2, 11, 2000, '2026-11-04T13:00:00Z'), donation(3, 12, 3000, '2026-11-04T13:00:00Z')];
    const p = plan(entries, [
      ret(1, 10, 1000, [1], 'sent', '2026-11-06T11:58:00Z'),
      ret(2, 11, 2000, [2], 'sending', '2026-11-06T11:58:00Z'),
      ret(3, 12, 3000, [3], 'unknown', '2026-11-06T11:58:00Z'),
    ]);
    expect(p.sends).toEqual([]);
    expect(p.notSent).toEqual([]);
  });

  it('confirms our sends against the payouts the ledger shows', () => {
    const p = plan([
      donation(1, 10, 1000, '2026-11-04T13:00:00Z'),
      payout(9, 10, 1000, '2026-11-06T11:00:02Z'),
    ], [ret(5, 10, 1000, [1], 'unknown', '2026-11-06T11:00:00Z')]);
    expect(p.confirmed).toEqual([{ returnId: 5, entryId: 9 }]);
    expect(p.notSent).toEqual([]);
    expect(p.sends).toEqual([]);
    // A payout from before we sent can't be ours.
    const early = plan([donation(1, 10, 1000, '2026-11-04T13:00:00Z'), payout(9, 10, 1000, '2026-11-06T10:00:00Z')],
      [ret(5, 10, 1000, [1], 'sent', '2026-11-06T11:00:00Z')]);
    expect(early.confirmed).toEqual([]);
  });

  it('a send the ledger never shows counts as not sent once the wait is over, and is tried again', () => {
    const entries = [donation(1, 10, 1000, '2026-11-04T13:00:00Z')];
    const sentAt = '2026-11-06T11:00:00Z';
    const soon = plan(entries, [ret(5, 10, 1000, [1], 'unknown', sentAt)], { now: new Date(Date.parse(sentAt) + UNCONFIRMED_AFTER_MS - 1000).toISOString() });
    expect(soon.notSent).toEqual([]);
    expect(soon.sends).toEqual([]);
    const later = plan(entries, [ret(5, 10, 1000, [1], 'unknown', sentAt)], { now: new Date(Date.parse(sentAt) + UNCONFIRMED_AFTER_MS + 1000).toISOString() });
    expect(later.notSent).toEqual([5]);
    expect(later.sends.map((x) => x.donationEntryIds)).toEqual([[1]]);
  });

  it(`gives up after ${MAX_ATTEMPTS} failed sends`, () => {
    const entries = [donation(1, 10, 1000, '2026-11-04T13:00:00Z')];
    const failed = Array.from({ length: MAX_ATTEMPTS }, (_, i) => ret(i + 1, 10, 1000, [1], 'failed', `2026-11-05T0${i}:00:00Z`));
    const p = plan(entries, failed);
    expect(p.sends).toEqual([]);
    expect(p.held).toEqual([{ entryId: 1, playerId: 10, amount: 1000, occurredAt: s('2026-11-04T13:00:00Z'), reason: 'gave-up' }]);
    expect(plan(entries, failed.slice(1)).sends).toHaveLength(1);
  });

  it('a failed send the ledger shows after all counts as sent', () => {
    const p = plan([donation(1, 10, 1000, '2026-11-04T13:00:00Z'), payout(9, 10, 1000, '2026-11-05T00:00:05Z')],
      [ret(5, 10, 1000, [1], 'failed', '2026-11-05T00:00:00Z')]);
    expect(p.confirmed).toEqual([{ returnId: 5, entryId: 9 }]);
    expect(p.sends).toEqual([]);
  });

  it('does not send again what a Leader paid back by hand', () => {
    const p = plan([
      donation(1, 10, 52000, '2026-11-04T13:00:00Z'),
      donation(2, 11, 21000, '2026-11-04T13:00:00Z'),
      donation(3, 11, 42000, '2026-11-04T14:00:00Z'),
      payout(8, 10, 52000, '2026-11-05T09:00:00Z'), // exactly that amount
      payout(9, 11, 63000, '2026-11-05T09:00:00Z'), // everything they had waiting
    ]);
    expect(p.sends).toEqual([]);
    expect(p.held.map((h) => [h.entryId, h.reason])).toEqual([[1, 'paid-by-hand'], [2, 'paid-by-hand'], [3, 'paid-by-hand']]);
  });

  it('still sends when a payout by hand is for something else', () => {
    const p = plan([
      donation(1, 10, 52000, '2026-11-04T13:00:00Z'),
      payout(7, 10, 52000, '2026-11-04T11:00:00Z'), // before the switch: older coins
      payout(8, 10, 750000, '2026-11-05T09:00:00Z'), // a share of a clan reward
      payout(9, 10, 52000, '2026-11-04T12:30:00Z'), // before these coins arrived
    ]);
    expect(p.sends.map((x) => [x.playerId, x.amount])).toEqual([[10, 52000]]);
  });

  it('leaves the coins of a member who left the clan', () => {
    const p = plan([donation(1, 10, 1000, '2026-11-04T13:00:00Z'), donation(2, 11, 2000, '2026-11-04T13:00:00Z')], [], { gone: [10] });
    expect(p.sends.map((x) => x.playerId)).toEqual([11]);
    expect(p.held.map((h) => [h.entryId, h.reason])).toEqual([[1, 'left-clan']]);
  });
});

describe('isSendAccepted', () => {
  it('is the recorded success reply [[]] and nothing else', () => {
    expect(isSendAccepted([[]])).toBe(true);
    expect(isSendAccepted([])).toBe(false);
    expect(isSendAccepted([[1]])).toBe(false);
    expect(isSendAccepted([[], []])).toBe(false);
    expect(isSendAccepted(null)).toBe(false);
  });
});
