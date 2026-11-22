"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.triumphalCycle = triumphalCycle;
exports.goldPassHoldersNow = goldPassHoldersNow;
exports.goldPassForWindow = goldPassForWindow;
exports.getGoldPassStatuses = getGoldPassStatuses;
/**
 * Who holds a Gold Pass — the paid track of the Triumphal event — as the game
 * reports it: the flag on each player's record (message 402 field 22,
 * game_players.gold_pass), read every scan, with a game_player_history row
 * whenever it changes.
 *
 * "This cycle" is the flag right now. Any other window — the Events →
 * Triumphal tab's cycles, "last cycle" — counts a member when a scan inside it
 * saw their flag on (goldPassForWindow: the game resets every pass when a cycle
 * ends, so the flag from before a window says nothing about it), which is only
 * known from when the clan's game history starts. A window wholly before that
 * has no answer and says so (`basis`).
 *
 * Until Nov 2026 holders were inferred from a Union Chest plus the exact 250k
 * Scientific Tractates line it donates; that inference is retired
 * (docs/guards-and-gold-pass.md).
 */
const database_js_1 = require("../database.js");
const ttl_cache_js_1 = require("../../utils/ttl-cache.js");
const event_catalog_js_1 = require("../../config/event-catalog.js");
const game_day_js_1 = require("../../utils/game-day.js");
const DAY_MS = 86_400_000;
const CACHE_TTL_MS = 60_000;
const TRIUMPHAL_EVENT_KEY = 'triumphal';
/** The Triumphal cycle `offset` cycles before the one holding `nowMs` (0 = current). */
function triumphalCycle(nowMs, rolloverUtcHour, offset = 0) {
    const cycle = (0, event_catalog_js_1.getEventDef)(TRIUMPHAL_EVENT_KEY)?.cycle;
    if (!cycle)
        return null;
    const anchorMs = Date.parse(cycle.anchor);
    const lenMs = cycle.days * DAY_MS;
    if (!Number.isFinite(anchorMs) || lenMs <= 0)
        return null;
    const index = Math.floor((nowMs - anchorMs) / lenMs) - offset;
    const fromMs = anchorMs + index * lenMs;
    const toMs = fromMs + lenMs;
    return {
        index,
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
        firstDay: (0, game_day_js_1.gameDateFor)(fromMs, rolloverUtcHour),
        lastDay: (0, game_day_js_1.gameDateFor)(toMs - 1, rolloverUtcHour),
    };
}
/** Members whose game record has the Gold Pass now. */
function goldPassHoldersNow(clanId) {
    return (0, ttl_cache_js_1.cached)(`goldpass:${clanId}:now`, CACHE_TTL_MS, () => new Set((0, database_js_1.getDb)().prepare(`
      SELECT m.id AS memberId
        FROM members m
        JOIN game_players g ON g.clan_id = m.clan_id AND g.player_id = m.game_player_id
       WHERE m.clan_id = ? AND g.gold_pass = 1
    `).all(clanId).map((r) => r.memberId)));
}
/** When the clan's game history starts (ISO), or null before its first scan. */
function historyStart(clanId) {
    const row = (0, database_js_1.getDb)().prepare('SELECT MIN(captured_at) AS first FROM game_player_history WHERE clan_id = ?')
        .get(clanId);
    return row?.first ?? null;
}
/**
 * Gold Pass holders over [fromIso, toIso): every member a scan INSIDE the window
 * saw with the flag on. A history row is written only when a player's record
 * changes, so that is either
 *   - a history row inside the window with the flag on, or
 *   - no row inside it at all, the flag on in the newest row before it, and the
 *     player read again since the window opened (game_players.last_seen) — the
 *     scans in between saw it unchanged.
 * The flag carried in from before the window is never enough on its own. The
 * game switches every pass off at the Triumphal reset, so on Nov 21 2026 the
 * old rule counted last cycle's holders who never bought again (the first scan
 * after the reset writes their "off" row inside the window), and players who
 * had left the clan before the window opened (no read since): 105 holders
 * against the game's 92. Returns a SHARED cached object.
 */
function goldPassForWindow(clanId, fromIso, toIso) {
    return (0, ttl_cache_js_1.cached)(`goldpass:${clanId}:${fromIso}:${toIso}`, CACHE_TTL_MS, () => {
        const first = historyStart(clanId);
        if (!first || first >= toIso)
            return { basis: 'none', memberIds: new Set() };
        const rows = (0, database_js_1.getDb)().prepare(`
      WITH inside AS (
        SELECT player_id, MAX(gold_pass) AS gold_pass
          FROM game_player_history
         WHERE clan_id = @clanId AND captured_at >= @from AND captured_at < @to
         GROUP BY player_id
      ),
      held AS (
        SELECT player_id FROM inside WHERE gold_pass = 1
        UNION
        SELECT g.player_id
          FROM game_players g
         WHERE g.clan_id = @clanId AND g.last_seen >= @from
           AND g.player_id NOT IN (SELECT player_id FROM inside)
           AND (SELECT h.gold_pass FROM game_player_history h
                 WHERE h.clan_id = g.clan_id AND h.player_id = g.player_id AND h.captured_at < @from
                 ORDER BY h.captured_at DESC LIMIT 1) = 1
      )
      SELECT DISTINCT m.id AS memberId
        FROM held
        JOIN members m ON m.clan_id = @clanId AND m.game_player_id = held.player_id
    `).all({ clanId, from: fromIso, to: toIso });
        return {
            basis: first <= fromIso ? 'game' : 'partial',
            memberIds: new Set(rows.map((r) => r.memberId)),
        };
    });
}
/**
 * memberId → 'current' for a member whose game record has the Gold Pass now,
 * 'previous' for one who had it at some point last Triumphal cycle (as far as
 * the game history reaches back) and does not now. Members with neither are
 * absent.
 */
function getGoldPassStatuses(clanId, nowMs, rolloverUtcHour) {
    const out = new Map();
    const previous = triumphalCycle(nowMs, rolloverUtcHour, 1);
    if (previous) {
        for (const id of goldPassForWindow(clanId, previous.from, previous.to).memberIds)
            out.set(id, 'previous');
    }
    for (const id of goldPassHoldersNow(clanId))
        out.set(id, 'current');
    return out;
}
//# sourceMappingURL=gold-pass-repo.js.map