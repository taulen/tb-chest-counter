"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.POLL_ACTIVE_MS = exports.POLL_IDLE_MS = exports.POLL_TICK_MS = void 0;
exports.pollDue = pollDue;
exports.keepGameSession = keepGameSession;
exports.dropGameSession = dropGameSession;
exports.dropAllGameSessions = dropAllGameSessions;
exports.keptSessionClans = keptSessionClans;
exports.startEventPoller = startEventPoller;
exports.stopEventPoller = stopEventPoller;
exports.setPollGateForTest = setPollGateForTest;
exports.pollTick = pollTick;
const ancients_js_1 = require("../game-protocol/ancients.js");
const game_event_repo_js_1 = require("../data/repositories/game-event-repo.js");
const summon_windows_js_1 = require("../data/summon-windows.js");
const ancients_game_js_1 = require("../data/ancients-game.js");
const event_read_js_1 = require("./event-read.js");
const game_day_js_1 = require("../utils/game-day.js");
const request_gap_js_1 = require("../utils/request-gap.js");
const logger_js_1 = require("../utils/logger.js");
const log_throttle_js_1 = require("../utils/log-throttle.js");
const log = (0, logger_js_1.childLogger)('event-poll');
const warner = (0, log_throttle_js_1.createCoalescedWarner)((m) => log.warn({ noAlert: true }, m), 60 * 60_000);
/** How often the poller looks (it reads only when a clan is due). */
exports.POLL_TICK_MS = 60_000;
/** Reads at most this far apart while the event runs. */
exports.POLL_IDLE_MS = 10 * 60_000;
/** … and this far apart while a summon is scoring. */
exports.POLL_ACTIVE_MS = 5 * 60_000;
/**
 * Whether a clan's next read is due, checked once per tick: a read is made on
 * the last tick before the gap would pass the interval, so with ticks every
 * POLL_TICK_MS two reads are never more than the interval apart. A clan with
 * no read yet is due at once.
 */
function pollDue(nowMs, lastReadMs, summonLive) {
    if (lastReadMs === null)
        return true;
    const interval = summonLive ? exports.POLL_ACTIVE_MS : exports.POLL_IDLE_MS;
    return nowMs - lastReadMs + exports.POLL_TICK_MS > interval;
}
const kept = new Map();
let gate = null;
let timer = null;
let ticking = false;
/** After a clan's scan: its game session, for reads until the next scan. */
function keepGameSession(clanId, client) {
    kept.set(clanId, { client, keptAt: Date.now() });
}
/** Forget a clan's session (only that client's, when given: a newer scan's stays). */
function dropGameSession(clanId, client) {
    const k = kept.get(clanId);
    if (k && (!client || k.client === client))
        kept.delete(clanId);
}
/** Forget every session (the login bridge opened: its login supersedes them all). */
function dropAllGameSessions() {
    kept.clear();
}
/** Clans with a session kept. */
function keptSessionClans() {
    return [...kept.keys()];
}
function startEventPoller(g) {
    gate = g;
    if (timer)
        return;
    timer = setInterval(() => { void pollTick(); }, exports.POLL_TICK_MS);
    timer.unref?.();
}
function stopEventPoller() {
    if (timer)
        clearInterval(timer);
    timer = null;
    gate = null;
    kept.clear();
}
/** For tests: install a gate without a timer. */
function setPollGateForTest(g) {
    gate = g;
}
/**
 * One look at every kept clan: read the ones whose running Rise of the
 * Ancients is due. Returns how many were read. Never throws.
 */
async function pollTick(nowMs = Date.now()) {
    const g = gate;
    if (!g || ticking)
        return 0;
    if (g.paused()) {
        kept.clear();
        return 0;
    }
    ticking = true;
    let done = 0;
    try {
        for (const [clanId, k] of [...kept]) {
            try {
                const run = (0, game_event_repo_js_1.liveEventRun)(clanId, ancients_js_1.ANCIENTS_EVENT_TYPE, Math.floor(nowMs / 1000));
                if (!run || g.laneBusy(clanId))
                    continue;
                const key = { eventType: run.eventType, run: run.run, occurrence: run.occurrence };
                const reads = (0, ancients_game_js_1.toSummonReads)((0, game_event_repo_js_1.listEventReads)(clanId, key));
                const split = (0, summon_windows_js_1.splitSummons)(reads, { now: nowMs, running: true });
                const live = split.groups[split.groups.length - 1]?.live ?? false;
                if (!pollDue(nowMs, reads.length ? reads[reads.length - 1].at : null, live))
                    continue;
                const got = await g.runOnLane(clanId, async () => {
                    // Re-checked on the lane: the bridge may have opened, or a scan kept a newer session.
                    if (g.paused() || kept.get(clanId)?.client !== k.client)
                        return undefined;
                    const now = new Date().toISOString();
                    return (0, event_read_js_1.readEventStandings)(clanId, k.client, key, {
                        now,
                        gameDate: (0, game_day_js_1.gameDateFor)(Date.parse(now), g.rolloverUtcHour()),
                        source: 'poll',
                        pause: () => (0, request_gap_js_1.requestGap)(request_gap_js_1.READ_GAP[0], request_gap_js_1.READ_GAP[1]),
                    });
                });
                if (got === undefined)
                    continue;
                if (got === null) {
                    // An empty reply on a live run: treat the session as gone.
                    dropGameSession(clanId, k.client);
                    warner.warn(`empty:${clanId}`, `Clan #${clanId}: Tin Man standings came back empty between scans — waiting for the next scan`);
                    continue;
                }
                done++;
                log.debug(`Clan #${clanId} Tin Man read between scans: ${got.rows} members, ${got.changed} moved, summons left ${got.summonsLeft ?? '?'}`);
            }
            catch (err) {
                dropGameSession(clanId, k.client);
                warner.warn(`fail:${clanId}`, `Clan #${clanId}: Tin Man reads between scans paused until its next scan: ${String(err)}`);
            }
        }
    }
    finally {
        ticking = false;
    }
    return done;
}
//# sourceMappingURL=event-poller.js.map