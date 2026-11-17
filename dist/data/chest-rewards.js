"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.expandReward = expandReward;
exports.gameDaysBetween = gameDaysBetween;
exports.buildIncome = buildIncome;
exports.buildByChest = buildByChest;
exports.loadChestClaims = loadChestClaims;
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
 * days. Pure apart from loadChestClaims; tested in tests/data/chest-rewards.test.ts.
 */
const database_js_1 = require("./database.js");
const game_day_js_1 = require("../utils/game-day.js");
const static_data_js_1 = require("../game-protocol/static-data.js");
const UNIT_ORDER = { amount: 0, time: 1, count: 2 };
/** One reward of a claim → what it counts toward. Unknown items are counts. */
function expandReward(itemId, n, items) {
    if (!Number.isFinite(n) || n <= 0)
        return [];
    const it = items[String(itemId)];
    if (it?.grants) {
        return Object.entries(it.grants).map(([rid, amount]) => ({
            key: `r${rid}`, unit: 'amount', itemId: Number(rid), value: n * amount, fromPack: true,
        }));
    }
    if (itemId > 0 && itemId < static_data_js_1.BASE_RESOURCE_MAX_ID && !it?.quality) {
        return [{ key: `r${itemId}`, unit: 'amount', itemId, value: n, fromPack: false }];
    }
    if (it?.seconds) {
        return [{ key: `t${it.kind}`, unit: 'time', itemId, value: n * it.seconds, fromPack: false }];
    }
    return [{ key: `i${itemId}`, unit: 'count', itemId, value: n, fromPack: false }];
}
/** Running totals keyed like RewardPart.key. */
class Tally {
    byKey = new Map();
    add(itemId, n, items) {
        const keys = new Set();
        for (const p of expandReward(itemId, n, items)) {
            let tot = this.byKey.get(p.key);
            if (!tot) {
                tot = { key: p.key, unit: p.unit, itemId: p.itemId, total: 0, fromPacks: 0, items: {} };
                this.byKey.set(p.key, tot);
            }
            tot.total += p.value;
            if (p.fromPack)
                tot.fromPacks += p.value;
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
    list() {
        const out = [...this.byKey.values()].map((tot) => {
            if (tot.unit !== 'time')
                return tot;
            const [top] = Object.entries(tot.items).sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]));
            return top ? { ...tot, itemId: Number(top[0]) } : tot;
        });
        return out.sort((a, b) => UNIT_ORDER[a.unit] - UNIT_ORDER[b.unit]
            || (a.unit === 'amount' ? a.itemId - b.itemId : b.total - a.total || a.itemId - b.itemId));
    }
}
const eachReward = (row, fn) => {
    for (const [id, n] of Object.entries(row.rewards)) {
        const itemId = Number(id);
        if (Number.isInteger(itemId) && typeof n === 'number')
            fn(itemId, n);
    }
};
/** Game days from the one holding `fromIso` through the one holding the instant before `toIso`. */
function gameDaysBetween(fromIso, toIso, rolloverUtcHour) {
    const first = (0, game_day_js_1.gameDateFor)(Date.parse(fromIso), rolloverUtcHour);
    const last = (0, game_day_js_1.gameDateFor)(Date.parse(toIso) - 1, rolloverUtcHour);
    const out = [];
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
function buildIncome(rows, items, opts) {
    const tally = new Tally();
    const days = new Map(gameDaysBetween(opts.trendFrom, opts.to, opts.rolloverUtcHour)
        .map((day) => [day, { day, chests: 0, values: {} }]));
    let chests = 0;
    let requests = 0;
    const types = new Set();
    for (const row of rows) {
        if (row.claimedAt < opts.trendFrom || row.claimedAt >= opts.to)
            continue;
        const day = days.get((0, game_day_js_1.gameDateFor)(Date.parse(row.claimedAt), opts.rolloverUtcHour));
        if (day) {
            day.chests += row.batchSize;
            eachReward(row, (itemId, n) => {
                for (const p of expandReward(itemId, n, items)) {
                    if (p.unit !== 'count')
                        day.values[p.key] = (day.values[p.key] ?? 0) + p.value;
                }
            });
        }
        if (row.claimedAt < opts.from)
            continue;
        chests += row.batchSize;
        requests += 1;
        types.add(row.giftType);
        eachReward(row, (itemId, n) => { tally.add(itemId, n, items); });
    }
    return { chests, requests, chestTypes: types.size, totals: tally.list(), days: [...days.values()] };
}
/** Per chest type (gift_type): chests opened, and what one chest gives on average and how often. */
function buildByChest(rows, items) {
    const byType = new Map();
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
        if (single)
            stats.singles += 1;
        const keys = new Set();
        eachReward(row, (itemId, n) => { for (const k of tally.add(itemId, n, items))
            keys.add(k); });
        if (single)
            for (const k of keys)
                hits.set(k, (hits.get(k) ?? 0) + 1);
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
/** A clan's claim requests in [from, to) (ISO timestamps; claimed_at is ISO too, so text order is time order). */
function loadChestClaims(clanId, from, to) {
    const rows = (0, database_js_1.getDb)().prepare(`SELECT gift_type, tab, rewards, claimed_at, batch_size FROM game_claims
      WHERE clan_id = ? AND claimed_at >= ? AND claimed_at < ?
      ORDER BY claimed_at`).all(clanId, from, to);
    const out = [];
    for (const r of rows) {
        let rewards = {};
        try {
            const parsed = JSON.parse(r.rewards);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                rewards = parsed;
        }
        catch {
            // an unreadable row still counts its chests
        }
        out.push({ giftType: r.gift_type, tab: r.tab, rewards, claimedAt: r.claimed_at, batchSize: Math.max(1, r.batch_size || 1) });
    }
    return out;
}
//# sourceMappingURL=chest-rewards.js.map