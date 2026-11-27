"use strict";
/**
 * What the CLAN won in an event run (Olympus, Dark Omens, the Seasonal
 * Kingdom's Ragnarök), as the Clan Capital ledger shows it: kind 5/8 entries
 * credited to the Leader at the run's reset, never shown in the in-game
 * history ([game-protocol.md](../../docs/game-protocol.md#messages), ledger
 * kinds). Tools → Rewards fills its pots from it: the Dragon Coins and the
 * clan fragment the clan then shares out by score.
 *
 * Matched by time, because nothing in an entry names the event. Every entry of
 * one win lands within the same minute of the game's reset (CWB's Olympus,
 * Nov 6 2026: 525,000 Dragon Coins, 27.5M Scientific Tractates and 700 Torch of
 * Olympus Clan Fragment, all at 18:00:19). The run's end the page knows comes
 * from the event calendar, which can be an hour off the game (Olympus ends at
 * 17:00 in the feed, 18:00 in the game), so entries are looked for from
 * WINNINGS_BEFORE_MS before it to WINNINGS_AFTER_MS after, and the credit
 * nearest to it wins.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WINNINGS_AFTER_MS = exports.WINNINGS_BEFORE_MS = void 0;
exports.pickClanWinnings = pickClanWinnings;
const dragon_coin_returns_js_1 = require("../game-protocol/dragon-coin-returns.js");
exports.WINNINGS_BEFORE_MS = 2 * 3_600_000;
exports.WINNINGS_AFTER_MS = 4 * 3_600_000;
/** Entries this close together (seconds) are one credit. */
const ONE_CREDIT_S = 300;
/** The game's clan fragments all end so: "Torch of Olympus Clan Fragment", "Chronoglyph Clan Fragment". */
const FRAGMENT_NAME = /\bClan Fragment$/i;
/**
 * The credit nearest to `resetMs` among `entries` (already limited to the
 * clan-won kinds and the window around it), summed per item; null when there
 * is none.
 */
function pickClanWinnings(entries, resetMs, itemName) {
    const sorted = [...entries].sort((a, b) => a.occurredAt - b.occurredAt);
    const credits = [];
    for (const e of sorted) {
        const last = credits[credits.length - 1];
        if (last && e.occurredAt - last[0].occurredAt <= ONE_CREDIT_S)
            last.push(e);
        else
            credits.push([e]);
    }
    let best = null;
    for (const c of credits) {
        if (!best || Math.abs(c[0].occurredAt * 1000 - resetMs) < Math.abs(best[0].occurredAt * 1000 - resetMs))
            best = c;
    }
    if (!best)
        return null;
    const totals = new Map();
    for (const e of best) {
        for (const [item, amount] of Object.entries(e.amounts)) {
            const n = Number(amount);
            if (Number.isFinite(n) && n > 0)
                totals.set(item, (totals.get(item) ?? 0) + n);
        }
    }
    const fragments = [];
    for (const [item, amount] of totals) {
        const name = itemName(item);
        if (FRAGMENT_NAME.test(name))
            fragments.push({ itemId: Number(item), name, amount });
    }
    return {
        creditedAt: new Date(best[0].occurredAt * 1000).toISOString(),
        coins: totals.get(String(dragon_coin_returns_js_1.CLAN_DRAGON_COINS)) ?? 0,
        fragments: fragments.sort((a, b) => b.amount - a.amount),
    };
}
//# sourceMappingURL=clan-winnings.js.map