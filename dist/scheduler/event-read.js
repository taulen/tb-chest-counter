"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readEventStandings = readEventStandings;
const messages_js_1 = require("../game-protocol/messages.js");
const ancients_js_1 = require("../game-protocol/ancients.js");
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
    const frame = await client.eventStandings(key.eventType, key.run);
    const standings = (0, messages_js_1.parseEventStandings)(frame);
    if (!standings.length)
        return null;
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
//# sourceMappingURL=event-read.js.map