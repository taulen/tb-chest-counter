"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readEventStandings = readEventStandings;
exports.overlayRanking = overlayRanking;
const messages_js_1 = require("../game-protocol/messages.js");
const ancients_js_1 = require("../game-protocol/ancients.js");
const olympus_js_1 = require("../game-protocol/olympus.js");
const game_event_repo_js_1 = require("../data/repositories/game-event-repo.js");
const game_protocol_repo_js_1 = require("../data/repositories/game-protocol-repo.js");
async function readEventStandings(clanId, client, key, opts) {
    const ref = key.eventType * 1000 + key.run;
    let progress = null;
    if (key.eventType === ancients_js_1.ANCIENTS_EVENT_TYPE) {
        try {
            const head = await client.eventProgress(key.eventType, key.run);
            progress = (0, messages_js_1.parseEventProgress)(head);
            (0, game_protocol_repo_js_1.saveRawSnapshot)(clanId, 'event_progress', ref, opts.gameDate, head.body, opts.now);
        }
        catch {
            // The standings still count; the read just has no summon tag.
        }
        // A header from another occurrence (the run rolled over) says nothing about this one.
        if (progress?.occurrence !== null && progress?.occurrence !== undefined && progress.occurrence !== key.occurrence)
            progress = null;
        await opts.pause?.();
    }
    // Trials of Olympus answers 38003 with every member at 0: its Clan members
    // tab is 82003 (game-protocol/olympus.ts).
    const olympus = key.eventType === olympus_js_1.OLYMPUS_EVENT_TYPE;
    const frame = olympus ? await client.olympusMembers(key.eventType, key.run) : await client.eventStandings(key.eventType, key.run);
    let standings = olympus ? (0, messages_js_1.parseOlympusMembers)(frame) : (0, messages_js_1.parseEventStandings)(frame);
    if (!standings.length)
        return null;
    if (opts.ranking) {
        await opts.pause?.();
        const r = opts.ranking;
        const ranked = await client.eventRanking(key.eventType, key.run, r.scope, r.group, r.gameClanId);
        (0, game_protocol_repo_js_1.saveRawSnapshot)(clanId, 'event_ranking', ref, opts.gameDate, ranked.body, opts.now);
        standings = overlayRanking(standings, (0, messages_js_1.parseEventRanking)(ranked).rows);
    }
    if (opts.entry)
        (0, game_event_repo_js_1.saveEventRun)(clanId, opts.entry.e, { code: opts.entry.code, title: opts.entry.title }, opts.now);
    else
        (0, game_event_repo_js_1.touchEventRun)(clanId, key, opts.now);
    const saved = (0, game_event_repo_js_1.saveEventStandings)(clanId, key, standings, opts.now);
    const summonsLeft = progress?.summonsLeft ?? null;
    const figurine = (0, ancients_js_1.figurineSummons)(progress);
    (0, game_event_repo_js_1.saveEventRead)(clanId, key, {
        readAt: opts.now,
        source: opts.source,
        members: standings.length,
        totalPoints: standings.reduce((s, r) => s + r.points, 0),
        changed: saved.changed,
        summonsLeft,
        summonsMax: figurine,
        summonsUsed: summonsLeft === null ? null : Math.max(figurine ?? 0, summonsLeft) - summonsLeft,
        bossId: progress?.bossId ?? null,
    });
    (0, game_protocol_repo_js_1.saveRawSnapshot)(clanId, 'event', ref, opts.gameDate, frame.body, opts.now);
    return { rows: standings.length, moved: saved.moved, changed: saved.changed, summonsLeft, summonsMax: figurine };
}
/**
 * A matchup-ranked run's standings: the clan's members as its Clan members tab
 * lists them, each with their place and points in the game's Ranking tab
 * (players of every clan of the matchup; only ours are kept). A member who
 * isn't in it — the tab shows the top 100 — has rank 0, "no rank", and 0
 * points.
 */
function overlayRanking(members, ranking) {
    const placed = new Map(ranking.map((r) => [r.playerId, r]));
    return members.map((m) => placed.get(m.playerId) ?? { playerId: m.playerId, points: 0, rank: 0 });
}
//# sourceMappingURL=event-read.js.map