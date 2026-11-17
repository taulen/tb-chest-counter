"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.overridePointsOf = overridePointsOf;
exports.ingestSnapshot = ingestSnapshot;
const logger_js_1 = require("../utils/logger.js");
const chesttracker_client_js_1 = require("./chesttracker-client.js");
const external_repo_js_1 = require("../data/repositories/external-repo.js");
const index_js_1 = require("../config/index.js");
const log = (0, logger_js_1.childLogger)('external-ingest');
// These top-level keys on a player row are totals / metadata, not chest
// category buckets. Anything else in the object with a numeric .chests
// field is treated as a category (e.g. "common crypt", "ancients",
// "epic squad", …).
const PLAYER_META_KEYS = new Set(['name', 'guardsLevel', 'points', 'chests']);
function extractCategories(p) {
    const out = {};
    for (const [key, val] of Object.entries(p)) {
        if (PLAYER_META_KEYS.has(key))
            continue;
        if (val && typeof val === 'object' && 'chests' in val) {
            const c = val.chests;
            if (typeof c === 'number' && c > 0) {
                out[key] = c;
            }
        }
    }
    return out;
}
/** A definition's override as a number: `{ points }` (current API) or a
 *  bare number (older payloads); null when unset or not numeric. */
function overridePointsOf(override) {
    const raw = override !== null && typeof override === 'object' ? override.points : override;
    if (raw === null || raw === undefined || raw === '')
        return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}
function normalizePayload(payload) {
    const [rawPlayers, rawDefs] = payload;
    const mappedPlayers = rawPlayers.map((p) => ({
        name: String(p.name ?? ''),
        guardsLevel: Number(p.guardsLevel ?? 0),
        points: Number(p.points ?? 0),
        chests: Number(p.chests ?? 0),
        categories: extractCategories(p),
    }));
    const players = mappedPlayers.filter((p) => p.name.length > 0);
    const droppedEmptyName = mappedPlayers.length - players.length;
    if (droppedEmptyName > 0) {
        log.warn(`Ingest dropped ${droppedEmptyName} chesttracker player row(s) with empty/missing name field — upstream returned ${mappedPlayers.length}, normalised ${players.length}`);
    }
    const definitions = rawDefs.map((d) => ({
        type: String(d.type ?? ''),
        name: String(d.name ?? ''),
        source: String(d.source ?? ''),
        points: Number(d.points ?? 0),
        overridePoints: overridePointsOf(d.override),
    }));
    return { players, definitions };
}
/**
 * Fetch one snapshot from the chesttracker API and persist it. Returns a
 * summary for the caller (scheduler or HTTP route). Does not throw on a
 * 304 response — caller sees status='not_modified' and snapshotId=null.
 * Does throw on HTTP errors / malformed payloads so the scheduler can
 * log + retry.
 */
async function ingestSnapshot(opts) {
    const window = opts.start && opts.end
        ? { start: opts.start, end: opts.end, durationDays: opts.durationDays ?? 7 }
        : (0, chesttracker_client_js_1.computeCurrentWeekWindow)((0, index_js_1.loadConfig)().gameDayRolloverUtcHour);
    const useEtag = opts.useEtag ?? true;
    const priorEtag = useEtag
        ? (0, external_repo_js_1.getSnapshotEtagForWindow)(opts.clanId, opts.shareCode, window.start, window.end)
        : null;
    const polledAt = new Date().toISOString();
    let res;
    try {
        res = await (0, chesttracker_client_js_1.fetchCounts)({
            shareCode: opts.shareCode,
            start: window.start,
            end: window.end,
            durationDays: window.durationDays,
            etag: priorEtag,
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        (0, external_repo_js_1.recordPollOutcome)({
            clanId: opts.clanId,
            polledAt,
            shareCode: opts.shareCode,
            windowStart: window.start,
            windowEnd: window.end,
            trigger: opts.trigger,
            status: 0,
            etagChanged: false,
            priorEtag,
            newEtag: null,
            errorMessage: msg,
        });
        throw err;
    }
    // Persist every poll outcome (200 + 304) to chesttracker.db so the
    // upstream update cadence is recoverable later — docker stdout rotates
    // but the mounted volume survives.
    const etagChanged = res.etag != null && priorEtag != null && res.etag !== priorEtag;
    (0, external_repo_js_1.recordPollOutcome)({
        clanId: opts.clanId ?? 1,
        polledAt,
        shareCode: opts.shareCode,
        windowStart: window.start,
        windowEnd: window.end,
        trigger: opts.trigger,
        status: res.status,
        etagChanged,
        priorEtag,
        newEtag: res.etag,
        errorMessage: null,
    });
    if (res.status === 304 || !res.body) {
        return {
            status: 'not_modified',
            snapshotId: null,
            windowStart: window.start,
            windowEnd: window.end,
            playerCount: 0,
            totalChests: 0,
            totalPoints: 0,
        };
    }
    const { players, definitions } = normalizePayload(res.body);
    if (players.length === 0) {
        log.info('Chesttracker payload had zero players — inserting empty snapshot for visibility');
    }
    const totalChests = players.reduce((s, p) => s + p.chests, 0);
    const totalPoints = players.reduce((s, p) => s + p.points, 0);
    // The clan's settings (targets + schedule) ride along in the counts
    // response, so the UI can render green/yellow/red status cells against
    // each player row. A response without them (legacy tuple) still inserts
    // — just without the requirement data.
    const settingsJson = res.clan ? JSON.stringify(res.clan) : null;
    const snapshotId = (0, external_repo_js_1.insertSnapshot)({
        clanId: opts.clanId,
        fetchedAt: new Date().toISOString(),
        shareCode: opts.shareCode,
        windowStart: window.start,
        windowEnd: window.end,
        durationDays: window.durationDays,
        trigger: opts.trigger,
        etag: res.etag,
        settingsJson,
        players,
        definitions,
    });
    return {
        status: 'inserted',
        snapshotId,
        windowStart: window.start,
        windowEnd: window.end,
        playerCount: players.length,
        totalChests,
        totalPoints,
    };
}
//# sourceMappingURL=ingest.js.map