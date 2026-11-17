"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runGameProtocolCapture = runGameProtocolCapture;
exports.compareScanWithGameCapture = compareScanWithGameCapture;
/**
 * Game protocol capture — the parallel run.
 *
 * Before each clan's OCR scan, read what the game server itself reports for
 * that clan and store it (migration v102):
 *
 *   - the clan record: members (role, joined) and BOTH gift tabs, read before
 *     the scan claims anything, so each scan can be compared gift by gift;
 *   - every member's player record: name, might, hero level, city level, VIP,
 *     Gold Pass, current hero;
 *   - the Clan Capital ledger (~two weeks, stored by entry id).
 *
 * Contract, same as the post-scan phases: this never throws out of its call
 * site, never touches the OCR tables or the scan state, and never decides a
 * clan needs re-authentication — the scan that follows is the authority on
 * that. A failure is a logged, recorded no-op and the next cycle tries again.
 *
 * It runs BEFORE the clan's browser is launched: a direct login takes over the
 * account's game session, and the scan's own fresh navigation then takes it
 * back. See docs/game-protocol.md.
 */
const path_1 = __importDefault(require("path"));
const logger_js_1 = require("../utils/logger.js");
const clan_paths_js_1 = require("../config/clan-paths.js");
const client_js_1 = require("../game-protocol/client.js");
const session_health_js_1 = require("./session-health.js");
const static_data_js_1 = require("../game-protocol/static-data.js");
const messages_js_1 = require("../game-protocol/messages.js");
const game_protocol_repo_js_1 = require("../data/repositories/game-protocol-repo.js");
const compare_js_1 = require("../game-protocol/compare.js");
const member_sync_js_1 = require("../game-protocol/member-sync.js");
const game_day_js_1 = require("../utils/game-day.js");
const log = (0, logger_js_1.childLogger)('game-protocol');
/** Player lookups per request; the game client itself asks for ~90 at a time. */
const PLAYER_BATCH = 100;
async function runGameProtocolCapture(clanId, opts) {
    const started = Date.now();
    const runId = (0, game_protocol_repo_js_1.startCaptureRun)(clanId);
    try {
        const names = await (0, static_data_js_1.loadGameNames)();
        const client = await client_js_1.GameClient.connect({
            storageStatePath: (0, clan_paths_js_1.clanStorageStatePath)(clanId),
            deviceFile: path_1.default.join((0, clan_paths_js_1.clanDataDir)(clanId), 'game-device.json'),
        });
        (0, session_health_js_1.noteSessionHealthy)(clanId, 'the game capture signed in with the saved session');
        const clanFrame = await client.clanRecord();
        const record = (0, messages_js_1.parseClanRecord)(clanFrame);
        if (!record || !record.members.length) {
            throw new Error(`the game returned no member list for clan ${client.clanId} — is the account still in the clan?`);
        }
        const players = [];
        const ids = record.members.map((m) => m.playerId);
        for (let i = 0; i < ids.length; i += PLAYER_BATCH) {
            players.push(...(0, messages_js_1.parsePlayers)(await client.players(ids.slice(i, i + PLAYER_BATCH))));
        }
        const byId = new Map(players.map((p) => [p.playerId, p]));
        // Senders outside the member list (left since sending) still need a name.
        const strangers = [...new Set(record.gifts.map((g) => g.senderId).filter((id) => !byId.has(id)))];
        for (let i = 0; i < strangers.length; i += PLAYER_BATCH) {
            for (const p of (0, messages_js_1.parsePlayers)(await client.players(strangers.slice(i, i + PLAYER_BATCH))))
                byId.set(p.playerId, p);
        }
        const gifts = record.gifts.map((g) => ({
            giftId: g.giftId,
            senderId: g.senderId,
            senderName: byId.get(g.senderId)?.name ?? '',
            giftType: g.giftType,
            chestName: names.gifts[g.giftType]?.chest ?? '',
            sourceName: names.gifts[g.giftType]?.source ?? '',
            count: g.count,
            tab: g.tab,
            arrivedAt: g.arrivedAt,
            expiresAt: g.expiresAt,
        }));
        const ledger = (0, messages_js_1.parseLedger)(await client.ledger(record.clanId));
        (0, game_protocol_repo_js_1.savePlayers)(clanId, record.members, players);
        const newGifts = (0, game_protocol_repo_js_1.saveGifts)(clanId, gifts);
        const ledgerNew = (0, game_protocol_repo_js_1.saveLedger)(clanId, ledger);
        const unnamed = gifts.filter((g) => !g.chestName).length;
        const gameDate = (0, game_day_js_1.currentGameDate)(opts.rolloverUtcHour);
        // Members: link to game ids, exact names, roles, seen, might/hero snapshot, departures.
        let memberIds = new Map();
        let syncNote = '';
        try {
            const sync = (0, member_sync_js_1.syncMembersFromGame)(clanId, record.members, players, gameDate);
            memberIds = sync.memberIds;
            syncNote = `members linked ${sync.linked} (+${sync.newlyLinked} matched, +${sync.created} new, ` +
                `${sync.renamed} renamed, ${sync.departed} left${sync.mergedByRule ? `, ${sync.mergedByRule} alts by merge rule` : ''})`;
        }
        catch (err) {
            log.warn({ noAlert: true }, `Clan #${clanId} member sync failed (capture data kept): ${String(err)}`);
        }
        const data = { client, names, record, byId, gifts, ledger, gameDate, memberIds };
        const extras = await collectExtras(clanId, data, clanFrame);
        const outcome = {
            ok: true,
            members: record.members.length,
            giftEntries: gifts.length,
            newGifts,
            ledgerNew,
        };
        (0, game_protocol_repo_js_1.finishCaptureRun)(runId, { ...outcome, gameClanId: record.clanId, namesVersion: names.version, durationMs: Date.now() - started });
        log.info(`Clan #${clanId} game capture: ${record.members.length} members, ${gifts.length} gift entries ` +
            `(${newGifts} new${unnamed ? `, ${unnamed} with no name yet` : ''}), ${ledgerNew} new ledger entries; ` +
            `${syncNote}; ${extras} — in ${Date.now() - started} ms`);
        return { ...outcome, data };
    }
    catch (err) {
        const error = String(err instanceof Error ? err.message : err);
        (0, game_protocol_repo_js_1.finishCaptureRun)(runId, { ok: false, error, durationMs: Date.now() - started });
        if (err instanceof client_js_1.SessionLoggedOutError) {
            // A definite logout is the same signal the scan's auth check acts on.
            (0, session_health_js_1.noteSessionLoggedOut)(clanId, 'saved Total Battle session is logged out (seen by the game capture)');
        }
        else {
            log.warn({ noAlert: true }, `Clan #${clanId} game capture failed (the scan is unaffected): ${error}`);
        }
        return { ok: false, error };
    }
}
/** Cities per cycle: a big clan's daily research pass spreads over a couple of cycles. */
const MAX_CITIES_PER_CYCLE = 120;
/** Map tiles per cycle (members' city tiles + their neighbours). */
const MAX_TILES_PER_CYCLE = 60;
const TILE_BATCH = 9;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Collect what we don't display yet but want history of — each part isolated,
 * so one failing never costs the others or the capture:
 *   - daily: every member's city (research + hero talents, buildings, hero),
 *     the raw clan record, and every clan-owned object (Clan Capital) raw;
 *   - every cycle: vaults and member-owned map objects around members' cities.
 * Returns a short summary for the log line.
 */
async function collectExtras(clanId, d, clanFrame) {
    const parts = [];
    const now = new Date().toISOString();
    try {
        if (!(0, game_protocol_repo_js_1.hasRawSnapshot)(clanId, 'clan_record', 0, d.gameDate)) {
            (0, game_protocol_repo_js_1.saveRawSnapshot)(clanId, 'clan_record', 0, d.gameDate, clanFrame.body, now);
            let objects = 0;
            for (const id of d.record.objects) {
                if ((0, game_protocol_repo_js_1.hasRawSnapshot)(clanId, 'clan_object', id, d.gameDate))
                    continue;
                (0, game_protocol_repo_js_1.saveRawSnapshot)(clanId, 'clan_object', id, d.gameDate, (await d.client.city(id)).body, now);
                objects++;
                await pause(100);
            }
            parts.push(`clan record + ${objects} clan objects archived`);
        }
    }
    catch (err) {
        parts.push(`clan archive failed: ${String(err)}`);
    }
    try {
        const done = (0, game_protocol_repo_js_1.citySnapshotPlayers)(clanId, d.gameDate);
        const todo = d.record.members
            .map((m) => d.byId.get(m.playerId))
            .filter((p) => !!p && p.cityId !== null && !done.has(p.playerId))
            .slice(0, MAX_CITIES_PER_CYCLE);
        let changed = 0;
        for (const p of todo) {
            try {
                const city = (0, messages_js_1.parseCityRecord)(await d.client.city(p.cityId));
                if (city) {
                    changed += (0, game_protocol_repo_js_1.saveTechs)(clanId, p.playerId, city.techs, now);
                    (0, game_protocol_repo_js_1.saveCitySnapshot)(clanId, p.playerId, d.gameDate, { techCount: Object.keys(city.techs).length, buildings: city.buildings, hero: city.hero }, now);
                }
            }
            catch {
                // One unreadable city never stops the rest; it is retried next cycle.
            }
            await pause(100);
        }
        if (todo.length)
            parts.push(`${todo.length} cities read (${changed} research/talent changes)`);
    }
    catch (err) {
        parts.push(`city pass failed: ${String(err)}`);
    }
    try {
        const tiles = new Set();
        for (const m of d.record.members) {
            const pos = d.byId.get(m.playerId)?.position;
            if (!pos || pos[0] !== d.client.realmId)
                continue;
            for (const dx of [-20, 0, 20])
                for (const dy of [-20, 0, 20])
                    tiles.add((0, messages_js_1.tileOf)(pos[1] + dx, pos[2] + dy));
        }
        const list = [...tiles].filter((t) => t >= 0).slice(0, MAX_TILES_PER_CYCLE);
        const memberIds = new Set(d.record.members.map((m) => m.playerId));
        const rows = [];
        for (let i = 0; i < list.length; i += TILE_BATCH) {
            for (const o of (0, messages_js_1.parseMapObjects)(await d.client.mapTiles(list.slice(i, i + TILE_BATCH)))) {
                const name = d.names.objects[String(o.type)] ?? '';
                if (!/vault/i.test(name) && !(o.ownerId !== null && memberIds.has(o.ownerId)))
                    continue;
                rows.push({ objectId: o.objectId, type: o.type, name, level: o.level, realm: o.realm, x: o.x, y: o.y, ownerId: o.ownerId, expiresAt: o.expiresAt });
            }
            await pause(100);
        }
        const fresh = (0, game_protocol_repo_js_1.saveMapObjects)(clanId, rows, now);
        parts.push(`${rows.length} vaults/member objects on ${list.length} tiles (${fresh} new)`);
    }
    catch (err) {
        parts.push(`map pass failed: ${String(err)}`);
    }
    return parts.join('; ');
}
/**
 * After a scan: compare its OCR rows with the gift list the game reported just
 * before it, per tab, store the result and log one `[game-vs-ocr]` line.
 * Read-only towards the OCR tables; never throws.
 */
function compareScanWithGameCapture(clanId, sessionId) {
    try {
        const inputs = (0, game_protocol_repo_js_1.loadScanComparisonInputs)(clanId, sessionId);
        if (!inputs)
            return;
        const expand = (rows, tab) => rows.filter((g) => g.tab === tab).flatMap((g) => Array.from({ length: g.count }, () => g));
        const parts = [];
        for (const [tab, label, ocr] of [[1, 'gifts', inputs.chestRows], [2, 'triumphal', inputs.triumphalRows]]) {
            const c = (0, compare_js_1.compareGifts)(expand(inputs.gifts, tab), ocr, inputs.captureEpoch);
            (0, game_protocol_repo_js_1.saveScanComparison)(clanId, sessionId, inputs.runId, tab, c);
            parts.push(`${label}: game ${c.game} · OCR ${c.ocr} · matched ${c.matched} · misreads ${c.misreads} · ` +
                `OCR-only ${c.ocrOnly} (+${c.ocrLate} late) · game-only ${c.gameOnly}`);
        }
        log.info(`[game-vs-ocr] clan #${clanId} session ${sessionId} — ${parts.join(' | ')}`);
    }
    catch (err) {
        log.warn({ noAlert: true }, `[game-vs-ocr] comparison failed for clan #${clanId} session ${sessionId}: ${String(err)}`);
    }
}
//# sourceMappingURL=game-protocol-phase.js.map