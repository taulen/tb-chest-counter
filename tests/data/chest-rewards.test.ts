/**
 * Resources → Chest rewards (data/chest-rewards.ts): a claim request's rewards
 * are summed over its chests, so averages are SUM(rewards) / SUM(batch_size);
 * packs count as the resource they hold, speedups as time, the rest as counts;
 * days are game days (17:00 UTC rollover); drop rates come from single-chest
 * claims only. Item facts are names.json's (NAMES_FORMAT 10), modelled on the
 * real T8 rows.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildByChest,
  buildIncome,
  expandReward,
  gameDaysBetween,
  loadChestClaims,
  loadSessionClaims,
  rewardItemIds,
  sumRewards,
  type ClaimRow,
} from '../../src/data/chest-rewards.js';
import type { GameItem } from '../../src/game-protocol/static-data.js';
import { getDb } from '../../src/data/database.js';
import { makeTestDb } from '../helpers/test-db.js';

const ITEMS: Record<string, GameItem> = {
  1: { kind: 1 }, // Gold
  2: { kind: 1 }, // Silver
  80: { kind: 1, quality: 3 }, // Dragon Key: id < 100 but graded — an item, not a resource
  1123: { kind: 2, grants: { 2: 250000 } }, // "Silver" pack
  74009: { kind: 2, grants: { 3: 250000, 4: 250000 } }, // building resources
  2006: { kind: 3, seconds: 10800 }, // Speedup 3 h
  2007: { kind: 3, seconds: 28800 }, // Speedup 8 h
  2053: { kind: 11, seconds: 54000 }, // Clan Speedup 15 h
  535: { kind: 7, quality: 2 }, // Cerberus Fang
  1139: { kind: 2 }, // Army strength booster
};

const claim = (giftType: number, rewards: Record<string, number>, claimedAt: string, batchSize = 1, tab = 1): ClaimRow =>
  ({ giftType, tab, rewards, claimedAt, batchSize });

describe('expandReward', () => {
  it('a base resource is an amount; a pack is its resource; a speedup is time; anything else a count', () => {
    expect(expandReward(2, 5000, ITEMS)).toEqual([{ key: 'r2', unit: 'amount', itemId: 2, value: 5000, fromPack: false }]);
    expect(expandReward(1123, 3, ITEMS)).toEqual([{ key: 'r2', unit: 'amount', itemId: 2, value: 750000, fromPack: true }]);
    expect(expandReward(74009, 2, ITEMS).map((p) => [p.key, p.value])).toEqual([['r3', 500000], ['r4', 500000]]);
    expect(expandReward(2007, 2, ITEMS)).toEqual([{ key: 't3', unit: 'time', itemId: 2007, value: 57600, fromPack: false }]);
    expect(expandReward(2053, 1, ITEMS)[0]).toMatchObject({ key: 't11', unit: 'time', value: 54000 });
    expect(expandReward(535, 4, ITEMS)).toEqual([{ key: 'i535', unit: 'count', itemId: 535, value: 4, fromPack: false }]);
    expect(expandReward(80, 1, ITEMS)[0]).toMatchObject({ key: 'i80', unit: 'count' });
    expect(expandReward(1139, 1, ITEMS)[0]).toMatchObject({ key: 'i1139', unit: 'count' });
  });

  it('never guesses: an item names.json does not know is a count of that item', () => {
    expect(expandReward(999999, 2, ITEMS)).toEqual([{ key: 'i999999', unit: 'count', itemId: 999999, value: 2, fromPack: false }]);
    // Without names at all, the base resources still read as amounts.
    expect(expandReward(1, 100, {})[0]).toMatchObject({ key: 'r1', unit: 'amount' });
    expect(expandReward(1123, 1, {})[0]).toMatchObject({ key: 'i1123', unit: 'count' });
    expect(expandReward(2, 0, ITEMS)).toEqual([]);
  });
});

describe('game days', () => {
  it('cut at 17:00 UTC, not at midnight', () => {
    // Game day 2026-11-17 runs [11-17 17:00, 11-18 17:00).
    expect(gameDaysBetween('2026-11-17T17:00:00.000Z', '2026-11-18T17:00:00.000Z', 17)).toEqual(['2026-11-17']);
    expect(gameDaysBetween('2026-11-15T17:00:00.000Z', '2026-11-18T17:00:00.000Z', 17))
      .toEqual(['2026-11-15', '2026-11-16', '2026-11-17']);
  });

  it('buckets each claim into its game day; the trend keeps empty days', () => {
    const rows = [
      claim(5512, { 2: 1000 }, '2026-11-17T16:59:59.000Z'), // still game day 11-16
      claim(5512, { 2: 2000 }, '2026-11-17T17:00:00.000Z'), // game day 11-17
      claim(5512, { 2: 4000, 2007: 1 }, '2026-11-18T03:00:00.000Z', 3), // game day 11-17, a 3-chest stack
    ];
    const inc = buildIncome(rows, ITEMS, {
      from: '2026-11-14T17:00:00.000Z', to: '2026-11-18T17:00:00.000Z', trendFrom: '2026-11-14T17:00:00.000Z', rolloverUtcHour: 17,
    });
    expect(inc.days.map((d) => [d.day, d.chests, d.values.r2 ?? 0, d.values.t3 ?? 0])).toEqual([
      ['2026-11-14', 0, 0, 0],
      ['2026-11-15', 0, 0, 0],
      ['2026-11-16', 1, 1000, 0],
      ['2026-11-17', 4, 6000, 28800],
    ]);
    expect(inc.chests).toBe(5);
    expect(inc.requests).toBe(3);
  });
});

describe('income', () => {
  const rows = [
    claim(5512, { 2: 10000, 1123: 1 }, '2026-11-18T01:00:00.000Z'),
    claim(5512, { 2: 30000, 2006: 2, 2007: 1, 535: 1 }, '2026-11-18T02:00:00.000Z', 4),
    claim(6702, { 1: 100, 2053: 1, 1139: 2 }, '2026-11-18T03:00:00.000Z', 1, 2),
    // Before `from`: in the trend only.
    claim(6702, { 1: 999 }, '2026-11-16T03:00:00.000Z'),
  ];
  const inc = buildIncome(rows, ITEMS, {
    from: '2026-11-17T17:00:00.000Z', to: '2026-11-18T17:00:00.000Z', trendFrom: '2026-11-14T17:00:00.000Z', rolloverUtcHour: 17,
  });

  it('sums every reward of the window in its own unit, packs into their resource', () => {
    const byKey = Object.fromEntries(inc.totals.map((tot) => [tot.key, tot]));
    expect(byKey.r2).toMatchObject({ unit: 'amount', itemId: 2, total: 290000, fromPacks: 250000, items: { 2: 40000, 1123: 1 } });
    expect(byKey.r1).toMatchObject({ unit: 'amount', total: 100, fromPacks: 0 });
    // Speedups of every size add up as one time total; the most common size shows it.
    expect(byKey.t3).toMatchObject({ unit: 'time', total: 2 * 10800 + 28800, items: { 2006: 2, 2007: 1 }, itemId: 2006 });
    expect(byKey.t11).toMatchObject({ unit: 'time', total: 54000 });
    expect(byKey.i535).toMatchObject({ unit: 'count', total: 1 });
    expect(byKey.i1139).toMatchObject({ unit: 'count', total: 2 });
    expect(inc.chests).toBe(6);
    expect(inc.requests).toBe(3);
    expect(inc.chestTypes).toBe(2);
  });

  it('orders amounts in the game\'s resource order, then time and counts biggest first', () => {
    // Gold (1) before Silver (2) though Silver's total is bigger: different units.
    expect(inc.totals.map((tot) => tot.key)).toEqual(['r1', 'r2', 't11', 't3', 'i1139', 'i535']);
  });

  it('a claim before the window shows in the trend, not in the totals', () => {
    expect(inc.days.find((d) => d.day === '2026-11-15')?.values.r1).toBe(999);
    expect(inc.totals.find((tot) => tot.key === 'r1')?.total).toBe(100);
  });
});

describe('by chest', () => {
  it('averages per CHEST: a stack of n chests counts n in the divisor', () => {
    const [stat] = buildByChest([
      claim(5512, { 2: 10000 }, '2026-11-18T01:00:00.000Z'),
      claim(5512, { 2: 50000, 2007: 2 }, '2026-11-18T02:00:00.000Z', 4),
    ], ITEMS);
    expect(stat).toMatchObject({ giftType: 5512, chests: 5, requests: 2, singles: 1 });
    const silver = stat.rewards.find((r) => r.key === 'r2')!;
    expect(silver.total).toBe(60000);
    expect(silver.perChest).toBe(12000); // 60,000 / 5 chests — not the mean of 10,000 and 12,500
    const speedup = stat.rewards.find((r) => r.key === 't3')!;
    expect(speedup.perChest).toBe((2 * 28800) / 5);
  });

  it('reads drop rates from single-chest claims only, and has none for a type only opened in stacks', () => {
    const stats = buildByChest([
      claim(5512, { 2: 1000, 535: 1 }, '2026-11-18T01:00:00.000Z'),
      claim(5512, { 2: 1000 }, '2026-11-18T01:01:00.000Z'),
      claim(5512, { 2: 1000 }, '2026-11-18T01:02:00.000Z'),
      claim(5512, { 2: 1000, 1123: 1 }, '2026-11-18T01:03:00.000Z'),
      // A stack always holds everything: it must not lift the odds.
      claim(5512, { 2: 50000, 535: 6 }, '2026-11-18T02:00:00.000Z', 50),
      claim(6311, { 1: 500 }, '2026-11-18T03:00:00.000Z', 10),
    ], ITEMS);
    const crypt = stats.find((s) => s.giftType === 5512)!;
    const rate = (key: string) => crypt.rewards.find((r) => r.key === key)!.dropRate;
    expect(rate('r2')).toBe(1);
    expect(rate('i535')).toBe(0.25);
    expect(crypt.chests).toBe(54);
    expect(crypt.rewards.find((r) => r.key === 'i535')!.perChest).toBeCloseTo(7 / 54);
    const stacked = stats.find((s) => s.giftType === 6311)!;
    expect(stacked.singles).toBe(0);
    expect(stacked.rewards[0].dropRate).toBeNull();
    // Most chests first.
    expect(stats.map((s) => s.giftType)).toEqual([5512, 6311]);
  });

  it('keeps the tab of a Triumphal chest', () => {
    const [stat] = buildByChest([claim(1157, { 1: 100 }, '2026-11-18T01:00:00.000Z', 1, 2)], ITEMS);
    expect(stat.tab).toBe(2);
  });
});

describe('loadChestClaims', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; });

  it('reads one clan\'s claims in [from, to), tolerating an unreadable rewards cell', () => {
    ({ cleanup } = makeTestDb());
    const db = getDb();
    db.prepare(`INSERT OR IGNORE INTO clans (id, name, slug, game_url, is_active, created_at) VALUES (2, 'B', 'b', 'x', 1, ?)`)
      .run(new Date().toISOString());
    const ins = db.prepare(
      `INSERT INTO game_claims (clan_id, session_id, gift_id, gift_type, tab, rewards, claimed_at, batch_size, gift_ids)
       VALUES (?, 1, ?, ?, 1, ?, ?, ?, NULL)`,
    );
    ins.run(1, 1, 5512, '{"2":1000,"2007":1}', '2026-11-18T01:00:00.000Z', 1);
    ins.run(1, 2, 5512, 'not json', '2026-11-18T02:00:00.000Z', 3);
    ins.run(1, 3, 5512, '{"2":1}', '2026-11-18T17:00:00.000Z', 1); // = to: excluded
    ins.run(2, 4, 5512, '{"2":1}', '2026-11-18T03:00:00.000Z', 1); // another clan
    const rows = loadChestClaims(1, '2026-11-17T17:00:00.000Z', '2026-11-18T17:00:00.000Z');
    expect(rows).toEqual([
      { giftType: 5512, tab: 1, rewards: { 2: 1000, 2007: 1 }, claimedAt: '2026-11-18T01:00:00.000Z', batchSize: 1 },
      { giftType: 5512, tab: 1, rewards: {}, claimedAt: '2026-11-18T02:00:00.000Z', batchSize: 3 },
    ]);
  });
});

describe('sumRewards (one scan, Scan History)', () => {
  it('counts every claim, chests by batch size, totals in their own units', () => {
    const sum = sumRewards([
      claim(5512, { 2: 40000, 1123: 1, 2006: 2 }, '2026-11-18T01:00:00.000Z', 3),
      claim(1157, { 1: 100, 535: 2 }, '2026-11-18T01:00:01.000Z', 1, 2),
    ], ITEMS);
    expect(sum.chests).toBe(4);
    expect(sum.requests).toBe(2);
    expect(sum.totals.map((tot) => tot.key)).toEqual(['r1', 'r2', 't3', 'i535']);
    expect(sum.totals.find((tot) => tot.key === 'r2')).toMatchObject({ unit: 'amount', total: 290000, fromPacks: 250000 });
    expect(rewardItemIds(sum.totals).sort((a, b) => a - b)).toEqual([1, 2, 535, 1123, 2006]);
  });

  it('is empty for no claims', () => {
    expect(sumRewards([], ITEMS)).toEqual({ chests: 0, requests: 0, totals: [] });
  });
});

describe('loadSessionClaims', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; });

  it('groups one clan\'s claims by the sessions asked for, from the oldest start on', () => {
    ({ cleanup } = makeTestDb());
    const db = getDb();
    db.prepare(`INSERT OR IGNORE INTO clans (id, name, slug, game_url, is_active, created_at) VALUES (2, 'B', 'b', 'x', 1, ?)`)
      .run(new Date().toISOString());
    const ins = db.prepare(
      `INSERT INTO game_claims (clan_id, session_id, gift_id, gift_type, tab, rewards, claimed_at, batch_size, gift_ids)
       VALUES (?, ?, ?, 5512, 1, ?, ?, ?, NULL)`,
    );
    ins.run(1, 10, 1, '{"2":1000}', '2026-11-18T01:00:00.000Z', 1);
    ins.run(1, 10, 2, '{"2":2000}', '2026-11-18T01:00:05.000Z', 2);
    ins.run(1, 11, 3, '{"1":5}', '2026-11-18T03:00:00.000Z', 1);
    ins.run(1, 12, 4, '{"1":9}', '2026-11-18T04:00:00.000Z', 1); // not asked for
    ins.run(2, 10, 5, '{"2":1}', '2026-11-18T01:00:00.000Z', 1); // another clan's session 10
    ins.run(1, 9, 6, '{"2":1}', '2026-11-17T01:00:00.000Z', 1); // before the oldest start

    const byId = loadSessionClaims(1, [10, 11, 9], '2026-11-18T00:59:00.000Z');
    expect([...byId.keys()].sort()).toEqual([10, 11]);
    expect(byId.get(10)!.map((r) => r.batchSize)).toEqual([1, 2]);
    expect(byId.get(11)![0].rewards).toEqual({ 1: 5 });
    expect(loadSessionClaims(1, [], '').size).toBe(0);
  });
});
