"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dayEventGameRunDates = dayEventGameRunDates;
exports.buildGameDayEvent = buildGameDayEvent;
/**
 * Ragnarök and Dark Omens per-day tables built from the game (Events →
 * Ragnarok / Dark Omens, Tools → Rewards): points per day, total and rank,
 * read every scan the way every event is (game_event_runs / _standings /
 * _standing_history) instead of pasted.
 *
 * A run's ranking is cumulative, so a day's points are the step between a
 * member's points at the day's 17:00 UTC end and at the previous day's — a
 * member's points at a moment are their newest standing-history row at or
 * before it, as Olympus' are (olympus-game.ts). The last day keeps every read
 * until the run closes, so its cumulative points are the final ones. A
 * one-day run (Seasonal Kingdom Ragnarök, Nov 2026) is one column; a two-day
 * run two.
 *
 * Runs are found by title (event-mapping's catalogKeyForEventTitle) and keyed
 * like the pasted ones and the Events page's runs, by the game day they start
 * on. Dark Omens had no run read when this was written (Nov 25 2026): which
 * of its rankings the game answers for the event — Spoils of Dread damage,
 * shown on its tab and split by in Rewards — is to be checked on its first run.
 */
const game_day_js_1 = require("../utils/game-day.js");
const event_mapping_js_1 = require("../game-protocol/event-mapping.js");
const game_event_repo_js_1 = require("./repositories/game-event-repo.js");
const game_player_names_js_1 = require("./game-player-names.js");
const DAY_MS = 86_400_000;
/** When game day `date` starts (its rollover), epoch ms. */
function dayStartMs(date, rolloverUtcHour) {
    return Date.parse(`${date}T00:00:00Z`) + rolloverUtcHour * 3_600_000;
}
/** The game day a run starts on (or, with no start, the day holding its last moment). */
function runStartDay(run, rolloverUtcHour) {
    if (run.startsAt !== null)
        return (0, game_day_js_1.gameDateFor)(run.startsAt * 1000, rolloverUtcHour);
    if (run.endsAt !== null)
        return (0, game_day_js_1.gameDateFor)(run.endsAt * 1000 - 1, rolloverUtcHour);
    return null;
}
/** The clan's runs of the event that have standings, newest first, each with its start day. */
function eventRuns(clanId, key, rolloverUtcHour) {
    const out = [];
    for (const run of (0, game_event_repo_js_1.listEventRuns)(clanId)) {
        if ((0, event_mapping_js_1.catalogKeyForEventTitle)(run.title) !== key)
            continue;
        const date = runStartDay(run, rolloverUtcHour);
        if (date)
            out.push({ date, run });
    }
    return out;
}
/** Start days of the runs the game has standings for, newest first. */
function dayEventGameRunDates(clanId, key, rolloverUtcHour) {
    return [...new Set(eventRuns(clanId, key, rolloverUtcHour).map((r) => r.date))].sort().reverse();
}
/**
 * The run that started on game day `date`, or null when the game has no
 * standings for one. Two runs on one start day (can't happen with one run per
 * day) keep the one read last.
 */
function buildGameDayEvent(clanId, key, date, rolloverUtcHour, nowMs = Date.now()) {
    let run = null;
    for (const r of eventRuns(clanId, key, rolloverUtcHour)) {
        if (r.date === date && (!run || r.run.lastRead > run.lastRead))
            run = r.run;
    }
    if (!run)
        return null;
    const standings = (0, game_event_repo_js_1.getEventStandings)(clanId, run);
    if (!standings.length)
        return null;
    const start = dayStartMs(date, rolloverUtcHour);
    const endMs = run.endsAt !== null ? run.endsAt * 1000 : null;
    // Days the run spans (by its own end), else days begun by now; at least one.
    const span = endMs !== null ? Math.ceil((endMs - start) / DAY_MS) : Math.floor((nowMs - start) / DAY_MS) + 1;
    const runDays = Math.max(1, span);
    const begun = Math.min(runDays, Math.max(1, Math.floor((nowMs - start) / DAY_MS) + 1));
    const days = Array.from({ length: begun }, (_, i) => i + 1);
    const nowSec = nowMs / 1000;
    const live = (run.startsAt ?? 0) <= nowSec && (run.endsAt === null || run.endsAt > nowSec);
    const dayLive = (d) => live && nowMs >= start + (d - 1) * DAY_MS && nowMs < start + d * DAY_MS;
    const history = (0, game_event_repo_js_1.listStandingHistory)(clanId, run);
    const names = (0, game_player_names_js_1.gamePlayerNames)(clanId, standings.map((s) => s.playerId));
    const players = standings.map((s) => {
        const h = history.get(s.playerId) ?? [];
        const pointsAt = (ms) => {
            const iso = new Date(ms).toISOString();
            let v = 0;
            for (const x of h) {
                if (x.at > iso)
                    break;
                v = x.points;
            }
            return v;
        };
        const cumulative = {};
        const perSummon = {};
        let prev = 0;
        for (const d of days) {
            // The run's last day has no next day: it keeps every read until the run
            // closes, so its total is the final standing.
            const cum = d === runDays ? s.points : Math.min(pointsAt(Math.min(start + d * DAY_MS, nowMs)), s.points);
            cumulative[d] = cum;
            perSummon[d] = cum - prev;
            prev = cum;
        }
        const n = names.get(s.playerId);
        const name = n?.name || `#${s.playerId}`;
        return {
            memberId: n?.memberId ?? null, name, rawName: name, matchKind: 'game',
            cumulative, perSummon, total: s.points,
            played: Object.values(perSummon).filter((v) => v > 0).length,
            rank: s.rank,
        };
    });
    players.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    return {
        live,
        readAt: run.lastRead,
        columns: days.map((d) => ({ first: d, last: d, live: dayLive(d) })),
        days,
        players,
    };
}
//# sourceMappingURL=day-event-game.js.map