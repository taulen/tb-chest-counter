/**
 * What the clan's opened chests paid out — Resources → Chest rewards.
 *
 * Every claim request the protocol scan sends is a game_claims row (v103,
 * v109): its rewards are the game's own reply, `{itemId: amountOrCount}`
 * SUMMED over the request, and batch_size is how many chests of one type
 * (gift_type) the request opened. So a chest type's average per chest is
 * SUM(rewards) / SUM(batch_size), never an average of row averages.
 *
 * A reward id is a T8 item. names.json (NAMES_FORMAT 10) says what each one
 * is worth (game-protocol/static-data.ts GameItem):
 *
 *   - a base resource (Gold 1, Silver 2, Tar 13, Dragon Coins 30, Sacred
 *     Potion 35 …: ids below 100 without a quality grade) is an AMOUNT;
 *   - a fixed resource pack ("Silver" 1123 = 250,000 Silver) is that amount of
 *     its resource, counted with the resource and kept apart as `fromPacks`;
 *   - a speedup (Speedup, Clan Speedup) or VIP status is TIME: its count ×
 *     its duration, one total per kind;
 *   - anything else (a booster, a forge material, a March Speedup) is a COUNT
 *     of that item — never a guessed amount.
 *
 * Units never mix: each total is one resource, one kind of time or one item.
 * Days are game days (17:00 UTC rollover, utils/game-day.ts), never calendar
 * days. Pure apart from loadChestClaims / loadSessionClaims; tested in
 * tests/data/chest-rewards.test.ts.
 *
 * Scan History reads the same rows by session_id (sumRewards): what each scan
 * gathered — its resources in the list, everything it paid out on the scan's
 * own page.
 */
import { getDb } from './database.js';
import { gameDateFor } from '../utils/game-day.js';
import { BASE_RESOURCE_MAX_ID, type GameItem } from '../game-protocol/static-data.js';

export type RewardUnit = 'amount' | 'time' | 'count';

/** One claim request. */
export interface ClaimRow {
  giftType: number;
  /** 1 Gifts, 2 Triumphal. */
  tab: number;
  /** Item id → amount or count, summed over the request's chests. */
  rewards: Record<string, number>;
  /** ISO timestamp. */
  claimedAt: string;
  /** Chests the request opened (1 for a single chest). */
  batchSize: number;
}

/** A reward item after its pack or duration is resolved: what it counts toward. */
export interface RewardPart {
  /** `r<resource id>` amount, `t<item kind>` time, `i<item id>` count. */
  key: string;
  unit: RewardUnit;
  /** The resource (amount), or the item itself (time, count). */
  itemId: number;
  /** Amount, seconds or count. */
  value: number;
  /** True when it came as a resource pack. */
  fromPack: boolean;
}

export interface RewardTotal {
  key: string;
  unit: RewardUnit;
  /** What to show it as: the resource, the item, or the most common item of a time kind. */
  itemId: number;
  /** Amount, seconds or count. */
  total: number;
  /** The part of an amount that came as packs (0 otherwise). */
  fromPacks: number;
  /** Item id → how many of it went into the total (packs and speedups by size). */
  items: Record<string, number>;
}

export interface ChestRewardStat extends RewardTotal {
  /** total / chests opened. */
  perChest: number;
  /**
   * Share of single-chest claims of this type that held it (0–1): how often
   * one chest gives it. Null when the type was only ever opened in stacks — a
   * stack's rewards are summed, so per-chest odds cannot be read from it.
   */
  dropRate: number | null;
}

export interface ChestTypeStats {
  giftType: number;
  tab: number;
  chests: number;
  requests: number;
  /** Requests that opened exactly one chest (what dropRate is read from). */
  singles: number;
  rewards: ChestRewardStat[];
}

export interface IncomeDay {
  /** Game day YYYY-MM-DD. */
  day: string;
  chests: number;
  /** Amount and time totals by key (counts are left out of the trend). */
  values: Record<string, number>;
}

export interface ChestIncome {
  chests: number;
  requests: number;
  chestTypes: number;
  totals: RewardTotal[];
  /** Every game day of the trend window, empty days included. */
  days: IncomeDay[];
}

const UNIT_ORDER: Record<RewardUnit, number> = { amount: 0, time: 1, count: 2 };

/** One reward of a claim → what it counts toward. Unknown items are counts. */
export function expandReward(itemId: number, n: number, items: Record<string, GameItem>): RewardPart[] {
  if (!Number.isFinite(n) || n <= 0) return [];
  const it = items[String(itemId)];
  if (it?.grants) {
    return Object.entries(it.grants).map(([rid, amount]) => ({
      key: `r${rid}`, unit: 'amount' as const, itemId: Number(rid), value: n * amount, fromPack: true,
    }));
  }
  if (itemId > 0 && itemId < BASE_RESOURCE_MAX_ID && !it?.quality) {
    return [{ key: `r${itemId}`, unit: 'amount', itemId, value: n, fromPack: false }];
  }
  if (it?.seconds) {
    return [{ key: `t${it.kind}`, unit: 'time', itemId, value: n * it.seconds, fromPack: false }];
  }
  return [{ key: `i${itemId}`, unit: 'count', itemId, value: n, fromPack: false }];
}

/** Running totals keyed like RewardPart.key. */
class Tally {
  readonly byKey = new Map<string, RewardTotal>();

  add(itemId: number, n: number, items: Record<string, GameItem>): Set<string> {
    const keys = new Set<string>();
    for (const p of expandReward(itemId, n, items)) {
      let tot = this.byKey.get(p.key);
      if (!tot) {
        tot = { key: p.key, unit: p.unit, itemId: p.itemId, total: 0, fromPacks: 0, items: {} };
        this.byKey.set(p.key, tot);
      }
      tot.total += p.value;
      if (p.fromPack) tot.fromPacks += p.value;
      tot.items[String(itemId)] = (tot.items[String(itemId)] ?? 0) + n;
      keys.add(p.key);
    }
    return keys;
  }

  /**
   * Sorted amount → time → count. Resources keep the game's own order (their
   * ids: Gold, Silver, Lumber, Iron, Stone, Food, Tar …) — their totals are in
   * different units, so "biggest first" would mean nothing; time and counts
   * go biggest first. A time kind shows as its most common item.
   */
  list(): RewardTotal[] {
    const out = [...this.byKey.values()].map((tot) => {
      if (tot.unit !== 'time') return tot;
      const [top] = Object.entries(tot.items).sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]));
      return top ? { ...tot, itemId: Number(top[0]) } : tot;
    });
    return out.sort((a, b) => UNIT_ORDER[a.unit] - UNIT_ORDER[b.unit]
      || (a.unit === 'amount' ? a.itemId - b.itemId : b.total - a.total || a.itemId - b.itemId));
  }
}

const eachReward = (row: ClaimRow, fn: (itemId: number, n: number) => void): void => {
  for (const [id, n] of Object.entries(row.rewards)) {
    const itemId = Number(id);
    if (Number.isInteger(itemId) && typeof n === 'number') fn(itemId, n);
  }
};

/** Game days from the one holding `fromIso` through the one holding the instant before `toIso`. */
export function gameDaysBetween(fromIso: string, toIso: string, rolloverUtcHour: number): string[] {
  const first = gameDateFor(Date.parse(fromIso), rolloverUtcHour);
  const last = gameDateFor(Date.parse(toIso) - 1, rolloverUtcHour);
  const out: string[] = [];
  for (let d = Date.parse(`${first}T00:00:00Z`), end = Date.parse(`${last}T00:00:00Z`); d <= end && out.length < 400; d += 86_400_000) {
    out.push(new Date(d).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * The clan's income over [from, to): totals per reward, and a per-game-day
 * series over [trendFrom, to) (a Daily view's trend reaches back further than
 * its one day). `rows` may hold the whole trend window.
 */
export function buildIncome(
  rows: ClaimRow[],
  items: Record<string, GameItem>,
  opts: { from: string; to: string; trendFrom: string; rolloverUtcHour: number },
): ChestIncome {
  const tally = new Tally();
  const days = new Map(gameDaysBetween(opts.trendFrom, opts.to, opts.rolloverUtcHour)
    .map((day): [string, IncomeDay] => [day, { day, chests: 0, values: {} }]));
  let chests = 0;
  let requests = 0;
  const types = new Set<number>();
  for (const row of rows) {
    if (row.claimedAt < opts.trendFrom || row.claimedAt >= opts.to) continue;
    const day = days.get(gameDateFor(Date.parse(row.claimedAt), opts.rolloverUtcHour));
    if (day) {
      day.chests += row.batchSize;
      eachReward(row, (itemId, n) => {
        for (const p of expandReward(itemId, n, items)) {
          if (p.unit !== 'count') day.values[p.key] = (day.values[p.key] ?? 0) + p.value;
        }
      });
    }
    if (row.claimedAt < opts.from) continue;
    chests += row.batchSize;
    requests += 1;
    types.add(row.giftType);
    eachReward(row, (itemId, n) => { tally.add(itemId, n, items); });
  }
  return { chests, requests, chestTypes: types.size, totals: tally.list(), days: [...days.values()] };
}

/** Per chest type (gift_type): chests opened, and what one chest gives on average and how often. */
export function buildByChest(rows: ClaimRow[], items: Record<string, GameItem>): ChestTypeStats[] {
  const byType = new Map<number, { stats: ChestTypeStats; tally: Tally; hits: Map<string, number> }>();
  for (const row of rows) {
    let e = byType.get(row.giftType);
    if (!e) {
      e = {
        stats: { giftType: row.giftType, tab: row.tab, chests: 0, requests: 0, singles: 0, rewards: [] },
        tally: new Tally(),
        hits: new Map(),
      };
      byType.set(row.giftType, e);
    }
    const { stats, tally, hits } = e;
    stats.chests += row.batchSize;
    stats.requests += 1;
    const single = row.batchSize === 1;
    if (single) stats.singles += 1;
    const keys = new Set<string>();
    eachReward(row, (itemId, n) => { for (const k of tally.add(itemId, n, items)) keys.add(k); });
    if (single) for (const k of keys) hits.set(k, (hits.get(k) ?? 0) + 1);
  }
  return [...byType.values()]
    .map(({ stats, tally, hits }) => ({
      ...stats,
      rewards: tally.list().map((tot) => ({
        ...tot,
        perChest: stats.chests ? tot.total / stats.chests : 0,
        dropRate: stats.singles ? (hits.get(tot.key) ?? 0) / stats.singles : null,
      })),
    }))
    .sort((a, b) => b.chests - a.chests || a.giftType - b.giftType);
}

/** What a set of claims paid out — one scan's, for Scan History: chests opened, requests, totals. */
export interface RewardSum {
  chests: number;
  requests: number;
  totals: RewardTotal[];
}

/** Sum claims with no window: every row counts (one scan session's claims). */
export function sumRewards(rows: ClaimRow[], items: Record<string, GameItem>): RewardSum {
  const tally = new Tally();
  let chests = 0;
  for (const row of rows) {
    chests += row.batchSize;
    eachReward(row, (itemId, n) => { tally.add(itemId, n, items); });
  }
  return { chests, requests: rows.length, totals: tally.list() };
}

/** Every item id a total shows or is made of (the icons and names a page needs). */
export function rewardItemIds(totals: RewardTotal[]): number[] {
  const ids = new Set<number>();
  for (const tot of totals) {
    ids.add(tot.itemId);
    for (const id of Object.keys(tot.items)) ids.add(Number(id));
  }
  return [...ids];
}

type ClaimDbRow = { session_id?: number; gift_type: number; tab: number; rewards: string; claimed_at: string; batch_size: number };

function toClaimRow(r: ClaimDbRow): ClaimRow {
  let rewards: Record<string, number> = {};
  try {
    const parsed = JSON.parse(r.rewards) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rewards = parsed as Record<string, number>;
  } catch {
    // an unreadable row still counts its chests
  }
  return { giftType: r.gift_type, tab: r.tab, rewards, claimedAt: r.claimed_at, batchSize: Math.max(1, r.batch_size || 1) };
}

/** A clan's claim requests in [from, to) (ISO timestamps; claimed_at is ISO too, so text order is time order). */
export function loadChestClaims(clanId: number, from: string, to: string): ClaimRow[] {
  const rows = getDb().prepare(
    `SELECT gift_type, tab, rewards, claimed_at, batch_size FROM game_claims
      WHERE clan_id = ? AND claimed_at >= ? AND claimed_at < ?
      ORDER BY claimed_at`,
  ).all(clanId, from, to) as ClaimDbRow[];
  return rows.map(toClaimRow);
}

/**
 * The claim requests of these scan sessions, by session. A claim is sent
 * during its scan, so none is older than the oldest session's start:
 * `sinceIso` (that start) bounds the read to idx_game_claims_clan instead of
 * every claim the clan ever made.
 */
export function loadSessionClaims(clanId: number, sessionIds: readonly number[], sinceIso: string): Map<number, ClaimRow[]> {
  const out = new Map<number, ClaimRow[]>();
  if (!sessionIds.length) return out;
  const wanted = new Set(sessionIds);
  const rows = getDb().prepare(
    `SELECT session_id, gift_type, tab, rewards, claimed_at, batch_size FROM game_claims
      WHERE clan_id = ? AND claimed_at >= ?
      ORDER BY claimed_at`,
  ).all(clanId, sinceIso) as ClaimDbRow[];
  for (const r of rows) {
    const sid = Number(r.session_id);
    if (!wanted.has(sid)) continue;
    let list = out.get(sid);
    if (!list) { list = []; out.set(sid, list); }
    list.push(toClaimRow(r));
  }
  return out;
}
