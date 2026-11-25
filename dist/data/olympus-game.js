"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.olympusGameRunDates = olympusGameRunDates;
exports.buildGameOlympus = buildGameOlympus;
/**
 * The Olympus per-day table built from the game (Events → Olympus): the same
 * rows the hand-pasted view shows (routes/tinman.ts, `olympus`) — points per
 * day, total, rank — read every scan instead of pasted
 * (game-protocol/olympus.ts). Two measures, both per day:
 *
 *   - Olympus points: the umbrella event's Ranking → Clan members (82003),
 *     the ranking admins used to paste and the clan's score is the sum of.
 *     Cumulative over the run, so a day's points are the step between the
 *     reads either side of the day's 17:00 UTC end: a member's points at a
 *     moment are their newest standing-history row at or before it. Points
 *     scored between a day's last read and its end land on the next day —
 *     except on day 5, which keeps every read until the event closes.
 *   - Stage points: the day's stage's own Clan members ranking (day 1 Trial
 *     of the Chimera … day 5 Trial of Briareus), which starts from zero.
 *
 * Runs are keyed like the pasted ones, by their first game day: stage n read
 * on game day d belongs to the run that started on d − (n − 1); the umbrella
 * run is the one running on that first day.
 *
 * Side events: a run ranked across the whole matchup (Sealed in Flame, on
 * Lava Fountain day) sits between the days as "day n.5" — n the day it ran
 * on. Its own ranking, with the game's places; never part of a total.
 */
const game_day_js_1 = require("../utils/game-day.js");
const olympus_js_1 = require("../game-protocol/olympus.js");
const event_mapping_js_1 = require("../game-protocol/event-mapping.js");
const game_event_repo_js_1 = require("./repositories/game-event-repo.js");
const game_player_names_js_1 = require("./game-player-names.js");
const game_clan_repo_js_1 = require("./repositories/game-clan-repo.js");
const DAY_MS = 86_400_000;
const RUN_DAYS = olympus_js_1.OLYMPUS_STAGES.length;
function addDays(date, n) {
    return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}
/** When game day `date` starts (its rollover), epoch ms. */
function dayStartMs(date, rolloverUtcHour) {
    return Date.parse(`${date}T00:00:00Z`) + rolloverUtcHour * 3_600_000;
}
/** The game day a run was on: the day it started (or, with no start, the day holding its last moment). */
function runGameDay(run, rolloverUtcHour) {
    if (run.startsAt !== null)
        return (0, game_day_js_1.gameDateFor)(run.startsAt * 1000, rolloverUtcHour);
    if (run.endsAt !== null)
        return (0, game_day_js_1.gameDateFor)(run.endsAt * 1000 - 1, rolloverUtcHour);
    return null;
}
/** Every Olympus stage the clan has standings for, newest first. */
function stageRuns(clanId, rolloverUtcHour) {
    const out = [];
    for (const run of (0, game_event_repo_js_1.listEventRuns)(clanId)) {
        const day = (0, event_mapping_js_1.olympusStageDay)(run.title);
        const gameDay = day === null ? null : runGameDay(run, rolloverUtcHour);
        if (day === null || gameDay === null)
            continue;
        out.push({ day, runDate: addDays(gameDay, -(day - 1)), run });
    }
    return out;
}
/**
 * The run's side events (isMatchupRankedRun), keyed by "day n.5": n is the day
 * of the run it started on. Two of one day keep the one read last.
 */
function sideRuns(clanId, date, rolloverUtcHour) {
    const out = new Map();
    for (const run of (0, game_event_repo_js_1.listEventRuns)(clanId)) {
        if (!(0, olympus_js_1.isMatchupRankedRun)(run))
            continue;
        const gameDay = runGameDay(run, rolloverUtcHour);
        if (gameDay === null)
            continue;
        const n = Math.round((Date.parse(`${gameDay}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY_MS) + 1;
        if (n < 1 || n > RUN_DAYS)
            continue;
        const day = n + 0.5;
        const had = out.get(day);
        if (!had || run.lastRead > had.lastRead)
            out.set(day, run);
    }
    return out;
}
/** The umbrella run (TRIALS OF OLYMPUS) on during the run's first game day — it opens an hour or so before day 1. */
function umbrellaRun(clanId, date, rolloverUtcHour) {
    const from = dayStartMs(date, rolloverUtcHour) / 1000;
    const to = from + DAY_MS / 1000;
    return (0, game_event_repo_js_1.listRunsOfType)(clanId, olympus_js_1.OLYMPUS_EVENT_TYPE)
        .find((r) => (r.startsAt ?? 0) < to && (r.endsAt === null || r.endsAt > from)) ?? null;
}
/** The run's matchup with the clan itself marked. */
function matchupWithOwn(clanId, umbrella) {
    const m = umbrella ? (0, game_event_repo_js_1.getMatchup)(clanId, umbrella) : null;
    if (!m)
        return null;
    const ownId = (0, game_clan_repo_js_1.getClanInfo)(clanId)?.gameClanId ?? null;
    return { ...m, clans: m.clans.map((c) => ({ ...c, own: c.gameClanId === ownId })) };
}
/** First game days of the Olympus runs the game has stages for, newest first. */
function olympusGameRunDates(clanId, rolloverUtcHour) {
    return [...new Set(stageRuns(clanId, rolloverUtcHour).map((s) => s.runDate))].sort().reverse();
}
/**
 * The run that started on game day `date`; null when the game gave neither a
 * stage nor Olympus points of it. Two reads of one day's stage (can't happen
 * with one variant per kingdom) keep the one read last.
 */
function buildGameOlympus(clanId, date, rolloverUtcHour, nowMs = Date.now()) {
    const byDay = new Map();
    for (const s of stageRuns(clanId, rolloverUtcHour)) {
        if (s.runDate !== date)
            continue;
        const had = byDay.get(s.day);
        if (!had || s.run.lastRead > had.lastRead)
            byDay.set(s.day, s.run);
    }
    const umbrella = umbrellaRun(clanId, date, rolloverUtcHour);
    const olympus = umbrella ? (0, game_event_repo_js_1.getEventStandings)(clanId, umbrella) : [];
    const sides = [...sideRuns(clanId, date, rolloverUtcHour)].sort((a, b) => a[0] - b[0]);
    const olympusPoints = olympus.some((s) => s.points > 0);
    if (!byDay.size && !olympusPoints)
        return null;
    const nowSec = nowMs / 1000;
    const isLive = (r) => (r.startsAt ?? 0) <= nowSec && (r.endsAt === null || r.endsAt > nowSec);
    const start = dayStartMs(date, rolloverUtcHour);
    // Days begun by now (the run's own clock), plus any stage read.
    const begun = Math.min(RUN_DAYS, Math.max(0, Math.floor((nowMs - start) / DAY_MS) + 1));
    const days = [...new Set([...Array.from({ length: begun }, (_, i) => i + 1), ...byDay.keys()])].sort((a, b) => a - b);
    const dayLive = (d) => nowMs >= start + (d - 1) * DAY_MS && nowMs < start + d * DAY_MS;
    const stageRows = new Map([...byDay].map(([d, r]) => [d, new Map((0, game_event_repo_js_1.getEventStandings)(clanId, r).map((s) => [s.playerId, s]))]));
    const olympusRows = new Map(olympus.map((s) => [s.playerId, s]));
    const sideRows = sides.map(([d, r]) => [d, new Map((0, game_event_repo_js_1.getEventStandings)(clanId, r).map((s) => [s.playerId, s]))]);
    const history = umbrella && olympusPoints ? (0, game_event_repo_js_1.listStandingHistory)(clanId, umbrella) : new Map();
    const ids = new Set(olympusRows.keys());
    for (const rows of stageRows.values())
        for (const id of rows.keys())
            ids.add(id);
    for (const [, rows] of sideRows)
        for (const s of rows.values())
            if (s.rank > 0)
                ids.add(s.playerId);
    const names = (0, game_player_names_js_1.gamePlayerNames)(clanId, [...ids]);
    const players = [...ids].map((playerId) => {
        const stagePoints = {};
        let stageTotal = 0;
        for (const [d, rows] of stageRows) {
            const row = rows.get(playerId);
            if (!row)
                continue;
            stagePoints[d] = row.points;
            stageTotal += row.points;
        }
        const cumulative = {};
        const perDay = {};
        if (olympusPoints) {
            const h = history.get(playerId) ?? [];
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
            let prev = 0;
            for (const d of days) {
                // The last day has no next day: it keeps every read until the event
                // closes (an hour after its 17:00 end), so its total is the final one.
                const cum = d === RUN_DAYS ? (h.length ? h[h.length - 1].points : 0) : pointsAt(Math.min(start + d * DAY_MS, nowMs));
                cumulative[d] = cum;
                perDay[d] = cum - prev;
                prev = cum;
            }
        }
        const per = olympusPoints ? perDay : stagePoints;
        const side = {};
        for (const [d, rows] of sideRows) {
            const row = rows.get(playerId);
            if (row)
                side[d] = { points: row.points, rank: row.rank };
        }
        const n = names.get(playerId);
        const name = n?.name || `#${playerId}`;
        return {
            memberId: n?.memberId ?? null, name, rawName: name, matchKind: 'game',
            cumulative, perSummon: per,
            total: olympusPoints ? olympusRows.get(playerId)?.points ?? 0 : stageTotal,
            stagePoints, stageTotal,
            played: Object.values(per).filter((v) => v > 0).length,
            rank: olympusRows.get(playerId)?.rank ?? 0,
            side,
        };
    });
    players.sort((a, b) => b.total - a.total || b.stageTotal - a.stageTotal || a.name.localeCompare(b.name));
    if (!olympusPoints)
        players.forEach((p, i) => { p.rank = i + 1; });
    const today = (0, game_day_js_1.gameDateFor)(nowMs, rolloverUtcHour);
    const runs = [...byDay.values(), ...sides.map(([, r]) => r), ...(umbrella ? [umbrella] : [])];
    return {
        live: days.some(dayLive) && (umbrella ? isLive(umbrella) : [...byDay.values()].some(isLive)),
        readAt: runs.reduce((m, r) => (r.lastRead > m ? r.lastRead : m), runs[0].lastRead),
        columns: days.map((d) => ({ first: d, last: d, live: dayLive(d), title: olympus_js_1.OLYMPUS_STAGES[d - 1].title })),
        stages: olympus_js_1.OLYMPUS_STAGES.map((s) => {
            const r = byDay.get(s.day);
            return {
                day: s.day,
                title: s.title,
                state: r ? 'read' : addDays(date, s.day - 1) > today ? 'upcoming' : 'unread',
                live: dayLive(s.day),
            };
        }),
        side: sides.map(([d, r]) => ({ day: d, title: r.title, live: isLive(r) })),
        olympusPoints,
        days: olympusPoints ? days : [],
        matchup: matchupWithOwn(clanId, umbrella),
        players,
    };
}
//# sourceMappingURL=olympus-game.js.map