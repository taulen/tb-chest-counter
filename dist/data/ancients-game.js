"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toSummonReads = toSummonReads;
exports.tinmanDayOfRun = tinmanDayOfRun;
exports.ancientsRunForDay = ancientsRunForDay;
exports.buildGameTinman = buildGameTinman;
/**
 * The Tin Man per-summon table built from the game (Events → Ancients): the
 * same rows the hand-pasted view shows (routes/tinman.ts, v80) — points per
 * summon, total, rank — from every read of the run's standings.
 *
 * Summons are windows found by data/summon-windows.ts; a member's points in a
 * summon (or in a "Summons 2–3" group the reads can't split) = their points at
 * its end read − at its start read, each the member's newest standing-history
 * row at or before that read. Total and rank are the game's own.
 */
const game_day_js_1 = require("../utils/game-day.js");
const ancients_js_1 = require("../game-protocol/ancients.js");
const game_event_repo_js_1 = require("./repositories/game-event-repo.js");
const summon_windows_js_1 = require("./summon-windows.js");
const game_player_names_js_1 = require("./game-player-names.js");
/** The read rows a split works on. */
function toSummonReads(reads) {
    return reads.map((r) => ({
        at: Date.parse(r.readAt), left: r.summonsLeft, max: r.summonsMax, changed: r.changed, total: r.totalPoints,
    }));
}
/** A game run's Tinman day: the game day holding its last moment, as the site keys its runs (api.ts `tinmanDate`). */
function tinmanDayOfRun(run, rolloverUtcHour) {
    if (run.endsAt !== null)
        return (0, game_day_js_1.gameDateFor)(run.endsAt * 1000 - 1, rolloverUtcHour);
    if (run.startsAt !== null)
        return (0, game_day_js_1.gameDateFor)(run.startsAt * 1000, rolloverUtcHour);
    return null;
}
/** The clan's Rise of the Ancients run of one Tinman day, or null. */
function ancientsRunForDay(clanId, date, rolloverUtcHour) {
    return (0, game_event_repo_js_1.listRunsOfType)(clanId, ancients_js_1.ANCIENTS_EVENT_TYPE).find((r) => tinmanDayOfRun(r, rolloverUtcHour) === date) ?? null;
}
const iso = (sec) => (sec === null ? null : new Date(sec * 1000).toISOString());
function buildGameTinman(clanId, run, nowMs = Date.now()) {
    const key = { eventType: run.eventType, run: run.run, occurrence: run.occurrence };
    const standings = (0, game_event_repo_js_1.getEventStandings)(clanId, key);
    if (!standings.length)
        return null;
    const reads = (0, game_event_repo_js_1.listEventReads)(clanId, key);
    const nowSec = nowMs / 1000;
    const live = (run.startsAt ?? 0) <= nowSec && (run.endsAt === null || run.endsAt > nowSec);
    const split = (0, summon_windows_js_1.splitSummons)(toSummonReads(reads), { now: nowMs, running: live });
    const history = (0, game_event_repo_js_1.listStandingHistory)(clanId, key);
    const readTimes = reads.map((r) => r.readAt);
    const names = (0, game_player_names_js_1.gamePlayerNames)(clanId, standings.map((s) => s.playerId));
    const players = standings.map((s) => {
        const h = history.get(s.playerId) ?? [];
        const pointsAt = (i) => {
            let v = 0;
            for (const x of h) {
                if (x.at > readTimes[i])
                    break;
                v = x.points;
            }
            return v;
        };
        const per = (0, summon_windows_js_1.pointsPerGroup)(split.groups, pointsAt);
        const perSummon = {};
        let played = 0;
        split.groups.forEach((g, i) => {
            perSummon[g.first] = per[i];
            if (per[i] > 0)
                played++;
        });
        const n = names.get(s.playerId);
        const name = n?.name || `#${s.playerId}`;
        return {
            memberId: n?.memberId ?? null, name, rawName: name, matchKind: 'game',
            cumulative: {}, perSummon, total: s.points, played, rank: s.rank,
        };
    });
    players.sort((a, b) => b.total - a.total || a.rank - b.rank || a.name.localeCompare(b.name));
    const newest = reads.length ? reads[reads.length - 1].readAt
        : standings.reduce((m, s) => (s.updatedAt > m ? s.updatedAt : m), standings[0].updatedAt);
    return {
        run: { ...key, title: run.title },
        live,
        startsAt: iso(run.startsAt),
        endsAt: iso(run.endsAt),
        readAt: newest,
        reads: reads.filter((r) => r.summonsLeft !== null).length,
        summonsLeft: split.left,
        summonsMax: split.max,
        summonsUsed: split.used,
        columns: split.groups.map((g) => ({ first: g.first, last: g.last, live: g.live })),
        players,
    };
}
//# sourceMappingURL=ancients-game.js.map