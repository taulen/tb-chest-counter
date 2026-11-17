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
const static_data_js_1 = require("../game-protocol/static-data.js");
const messages_js_1 = require("../game-protocol/messages.js");
const game_protocol_repo_js_1 = require("../data/repositories/game-protocol-repo.js");
const compare_js_1 = require("../game-protocol/compare.js");
const log = (0, logger_js_1.childLogger)('game-protocol');
/** Player lookups per request; the game client itself asks for ~90 at a time. */
const PLAYER_BATCH = 100;
async function runGameProtocolCapture(clanId) {
    const started = Date.now();
    const runId = (0, game_protocol_repo_js_1.startCaptureRun)(clanId);
    try {
        const names = await (0, static_data_js_1.loadGameNames)();
        const client = await client_js_1.GameClient.connect({
            storageStatePath: (0, clan_paths_js_1.clanStorageStatePath)(clanId),
            deviceFile: path_1.default.join((0, clan_paths_js_1.clanDataDir)(clanId), 'game-device.json'),
        });
        const record = (0, messages_js_1.parseClanRecord)(await client.clanRecord());
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
        const outcome = {
            ok: true,
            members: record.members.length,
            giftEntries: gifts.length,
            newGifts,
            ledgerNew,
        };
        (0, game_protocol_repo_js_1.finishCaptureRun)(runId, { ...outcome, gameClanId: record.clanId, namesVersion: names.version, durationMs: Date.now() - started });
        log.info(`Clan #${clanId} game capture: ${record.members.length} members, ${gifts.length} gift entries ` +
            `(${newGifts} new${unnamed ? `, ${unnamed} with no name yet` : ''}), ${ledgerNew} new ledger entries ` +
            `in ${Date.now() - started} ms`);
        return outcome;
    }
    catch (err) {
        const error = String(err instanceof Error ? err.message : err);
        (0, game_protocol_repo_js_1.finishCaptureRun)(runId, { ok: false, error, durationMs: Date.now() - started });
        log.warn({ noAlert: true }, `Clan #${clanId} game capture failed (the scan is unaffected): ${error}`);
        return { ok: false, error };
    }
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