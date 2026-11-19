"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordAndClaim = recordAndClaim;
/**
 * The protocol scan: a clan's chests recorded from the game's own gift list
 * and opened with the game's own claim request (docs/game-protocol.md). Runs
 * on the session and data that runGameProtocolCapture just read.
 *
 * Order, chosen so tracking can never be lost:
 *   1. Every gift on both tabs is RECORDED first, keyed by game_gift_id. A gift
 *      a member sent is earned whether or not we open it, and a gift already
 *      recorded (a re-run after a crash, a claim that failed) is never recorded
 *      twice: only `count − rows already carrying its id` rows are added.
 *   2. Then the gifts are claimed (15013) — single Gifts-tab chests a chest
 *      type per request, Triumphal chests and bundles one chest per request —
 *      and each request's rewards are kept in game_claims. A failed claim
 *      leaves the gift in the game; the next cycle records nothing new for it
 *      and claims it again.
 *   3. The Clan Capital ledger becomes resource_transactions rows (one per entry,
 *      game_entry_id unique), from the day after the newest row the retired
 *      screenshot reader captured, so the switch-over never double-counts a day.
 *
 * Names: the game's names are exact, so no correction runs. Each resolves to
 * the spelling already stored for it when one normalises the same (rows the
 * retired screenshot reader wrote say "Lvl 25-29 Vault of the Ancients" where
 * the game says "Level 25–29 …"), so points, merge rules and history keep
 * keying on the names they always had; the clan's chest/source merge rules
 * then apply as they always did.
 */
const database_js_1 = require("../data/database.js");
const chestRepo = __importStar(require("../data/repositories/chest-repo.js"));
const triumphalChestRepo = __importStar(require("../data/repositories/triumphal-chest-repo.js"));
const merge_repo_js_1 = require("../data/repositories/merge-repo.js");
const source_points_repo_js_1 = require("../data/repositories/source-points-repo.js");
const resource_repo_js_1 = require("../data/repositories/resource-repo.js");
const chest_names_js_1 = require("../data/chest-names.js");
const gift_text_js_1 = require("../game-protocol/gift-text.js");
const messages_js_1 = require("../game-protocol/messages.js");
const ledger_rows_js_1 = require("../game-protocol/ledger-rows.js");
const member_sync_js_1 = require("../game-protocol/member-sync.js");
const logger_js_1 = require("../utils/logger.js");
const request_gap_js_1 = require("../utils/request-gap.js");
const claim_plan_js_1 = require("../game-protocol/claim-plan.js");
const log = (0, logger_js_1.childLogger)('protocol-scan');
/** Most gifts in one claim request (the game's own "Claim chests" sends the whole tab). */
const CLAIM_BATCH_MAX = 100;
/** Chests per claim request: a bigger stack is split across requests (claim-plan.ts). */
const CLAIM_CHESTS_MAX = 100;
/** Sender name used when the game gave us neither a member link nor a name. */
const UNKNOWN_SENDER = '[Unknown]';
/** Ledger items already reported as untracked in this process (one System note each). */
const reportedUnmapped = new Set();
/** Stored spelling for each normalised name, oldest row first. */
function storedNames(sql) {
    const out = new Map();
    for (const r of (0, database_js_1.getDb)().prepare(sql).all()) {
        const k = (0, gift_text_js_1.normalizeGiftText)(r.v);
        if (!out.has(k))
            out.set(k, r.v);
    }
    return out;
}
async function recordAndClaim(ctx, d) {
    const { clanId, sessionId } = ctx;
    const tally = { gifts: [], triumphal: [], alreadyRecorded: 0, claimed: 0, claimFailures: 0, resourceRows: 0, warnings: [] };
    const memberFor = (0, member_sync_js_1.makeMemberResolver)(clanId, d.memberIds);
    const chestMerge = (0, merge_repo_js_1.loadMergeRules)('chest', clanId);
    const sourceMerge = (0, merge_repo_js_1.loadMergeRules)('source', clanId);
    const schedule = (0, source_points_repo_js_1.loadPointSchedule)(clanId);
    const chestNames = storedNames('SELECT name AS v FROM chests ORDER BY id');
    const sourceNames = storedNames('SELECT source AS v FROM chest_sources ORDER BY id');
    const stored = (names, name) => names.get((0, gift_text_js_1.normalizeGiftText)(name)) ?? name;
    const countGift = {
        1: (0, database_js_1.getDb)().prepare('SELECT COUNT(*) AS n FROM chest_records WHERE clan_id = ? AND game_gift_id = ?'),
        2: (0, database_js_1.getDb)().prepare('SELECT COUNT(*) AS n FROM triumphal_chest_records WHERE clan_id = ? AND game_gift_id = ?'),
    };
    // 1. Record, oldest first so captured_at follows arrival.
    ctx.reportProgress(`Recording ${d.gifts.reduce((n, g) => n + g.count, 0)} chests…`);
    const unnamed = new Set();
    for (const g of [...d.gifts].sort((a, b) => a.arrivedAt - b.arrivedAt)) {
        const tab = g.tab === 2 ? 2 : 1;
        const have = countGift[tab].get(clanId, g.giftId).n;
        tally.alreadyRecorded += Math.min(have, g.count);
        const missing = g.count - have;
        if (missing <= 0)
            continue;
        if (!g.chestName)
            unnamed.add(g.giftType);
        const chestName = (0, merge_repo_js_1.applyMergeRulesCached)(chestMerge, stored(chestNames, g.chestName || `Unknown gift ${g.giftType}`));
        const source = (0, merge_repo_js_1.applyMergeRulesCached)(sourceMerge, stored(sourceNames, g.sourceName));
        const chestType = (0, chest_names_js_1.chestTypeFor)(chestName);
        const senderName = g.senderName || d.byId.get(g.senderId)?.name || '';
        const memberId = memberFor(g.senderId, senderName) ?? memberFor(0, UNKNOWN_SENDER);
        if (memberId === null) {
            tally.warnings.push(`gift ${g.giftId}: no member for sender ${g.senderId}`);
            continue;
        }
        const earnedAt = g.arrivedAt * 1000;
        // Triumphals are bookkeeping only — never points. Everything else scores
        // the values in force on the game day it was earned.
        const pointValue = tab === 2 ? 0 : (0, source_points_repo_js_1.getPointsForSourceAt)(schedule, source, chestName, earnedAt);
        for (let i = 0; i < missing; i++) {
            const row = {
                sessionId,
                clanId,
                playerName: senderName || UNKNOWN_SENDER,
                memberId,
                chestName,
                chestType,
                chestSource: source,
                pointValue,
                capturedAt: ctx.nextCapturedAt(),
                earnedAt,
                gameGiftId: g.giftId,
            };
            const inserted = tab === 2 ? triumphalChestRepo.insertChest(row) : chestRepo.insertChest(row);
            if (!inserted)
                continue;
            const entry = {
                playerName: row.playerName, chestName, chestType, source, timeLeft: '',
                giftTab: tab === 2 ? 'triumphal' : 'gifts', quantity: 1,
            };
            if (tab === 2) {
                tally.triumphal.push(entry);
            }
            else {
                tally.gifts.push(entry);
                ctx.incrementLiveChestCount();
            }
        }
    }
    if (unnamed.size) {
        tally.warnings.push(`gift types without a name in the game data: ${[...unnamed].join(', ')}`);
    }
    // 2. Claim. Gifts-tab chests go a chest TYPE at a time: one request holding
    //    every entry of that type, each asked for with its chest count — the way
    //    the game's own "Claim chests" asks for the whole tab — capped at
    //    CLAIM_BATCH_MAX entries / CLAIM_CHESTS_MAX chests (claim-plan.ts). A
    //    summon's 293-chest stack is three requests, not 293. Rewards stay known
    //    per type (the game sums a request's rewards; batch_size = chests). A
    //    refused request is retried a chest at a time, so one bad gift never
    //    holds the rest. Triumphal chests go exactly as the game's Open button
    //    does: one chest per request, a 3× bundle three requests.
    const saveClaim = (0, database_js_1.getDb)().prepare(`INSERT INTO game_claims (clan_id, session_id, gift_id, gift_type, tab, rewards, claimed_at, batch_size, gift_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // A varied gap between claims, quicker than a player clicks Open by hand.
    const gap = () => (0, request_gap_js_1.requestGap)(request_gap_js_1.CLAIM_GAP[0], request_gap_js_1.CLAIM_GAP[1]);
    let warned = false;
    const failed = new Set();
    const claimFailed = (giftId, err) => {
        failed.add(giftId);
        if (!warned)
            log.warn({ noAlert: true }, `Clan #${clanId}: claiming gift ${giftId} failed (recorded; retried next cycle): ${String(err)}`);
        warned = true;
    };
    // Progress in CHESTS, not gift entries: a bundle or a summon's drop is one
    // entry holding many chests. Counting entries showed SIK's 473 chests as
    // "Opening chests (11/44)…" for a minute and a half, which looked stuck.
    const totalChests = d.gifts.reduce((n, g) => n + g.count, 0);
    let openedChests = 0;
    let shownAt = -Infinity;
    const progress = (force = false) => {
        if (!force && openedChests - shownAt < 10 && openedChests < totalChests)
            return;
        shownAt = openedChests;
        ctx.reportProgress(`Opening chests (${openedChests}/${totalChests})…`);
    };
    /** `n` chests of one gift, one chest per request; stops at the first refusal. */
    const claimChests = async (g, n) => {
        for (let i = 0; i < n; i++) {
            try {
                const rewards = (0, messages_js_1.parseClaimRewards)(await d.client.claim({ [g.giftId]: 1 }));
                saveClaim.run(clanId, sessionId, g.giftId, g.giftType, g.tab, JSON.stringify(rewards), new Date().toISOString(), 1, null);
            }
            catch (err) {
                claimFailed(g.giftId, err);
                openedChests += n - i; // skipped: recorded, the next scan opens them
                progress();
                return;
            }
            openedChests++;
            progress();
            await gap();
        }
    };
    progress(true);
    for (const req of (0, claim_plan_js_1.planGiftClaims)(d.gifts.filter((g) => g.tab === 1), CLAIM_BATCH_MAX, CLAIM_CHESTS_MAX)) {
        try {
            const ask = {};
            for (const p of req.parts)
                ask[p.gift.giftId] = p.n;
            const rewards = (0, messages_js_1.parseClaimRewards)(await d.client.claim(ask));
            saveClaim.run(clanId, sessionId, req.parts[0].gift.giftId, req.giftType, 1, JSON.stringify(rewards), new Date().toISOString(), req.chests, req.parts.length > 1 ? JSON.stringify(req.parts.map((p) => p.gift.giftId)) : null);
            openedChests += req.chests;
            progress(true);
            await gap();
        }
        catch {
            await gap();
            for (const p of req.parts)
                await claimChests(p.gift, p.n);
        }
    }
    for (const g of d.gifts.filter((x) => x.tab !== 1))
        await claimChests(g, g.count);
    tally.claimFailures = failed.size;
    tally.claimed = d.gifts.length - failed.size;
    if (tally.claimFailures) {
        tally.warnings.push(`${tally.claimFailures} of ${d.gifts.length} gift entries could not be opened in full; their chests are recorded and the next scan opens them`);
    }
    // 3. Ledger → resource rows.
    try {
        tally.resourceRows = importLedger(clanId, sessionId, d, memberFor, ctx.rolloverUtcHour);
    }
    catch (err) {
        tally.warnings.push(`Clan Capital ledger import failed: ${String(err)}`);
    }
    log.info(`Clan #${clanId} protocol scan: recorded ${tally.gifts.length} chests + ${tally.triumphal.length} triumphal ` +
        `(${tally.alreadyRecorded} already recorded), opened ${tally.claimed}/${d.gifts.length} gift entries, ` +
        `${tally.resourceRows} resource rows`);
    return tally;
}
/**
 * Ledger entries newer than the clan's screenshot-read rows → resource_transactions,
 * in a batch tagged with this scan's session (Scan History counts them). Returns rows written.
 */
function importLedger(clanId, sessionId, d, memberFor, rolloverUtcHour) {
    if (!d.ledger.length)
        return 0;
    const db = (0, database_js_1.getDb)();
    const afterDate = db.prepare('SELECT MAX(transaction_date) AS d FROM resource_transactions WHERE clan_id = ? AND game_entry_id IS NULL').get(clanId).d ?? '';
    const minEntry = Math.min(...d.ledger.map((e) => e.entryId));
    const have = new Set(db.prepare('SELECT game_entry_id AS id FROM resource_transactions WHERE clan_id = ? AND game_entry_id >= ?').all(clanId, minEntry).map((r) => r.id));
    const { rows, skipped } = (0, ledger_rows_js_1.ledgerToRows)(d.ledger, d.names, (0, resource_repo_js_1.listResourceTypes)(), {
        afterDate,
        rolloverUtcHour,
        untrackedSlugs: resource_repo_js_1.UNTRACKED_RESOURCE_SLUGS,
    });
    const fresh = rows.filter((r) => !have.has(r.entryId));
    const unexpected = Object.entries(skipped).filter(([why]) => /unmapped|several|kind /.test(why));
    if (unexpected.length) {
        log.info(`Clan #${clanId} ledger: left out ${unexpected.map(([why, n]) => `${n}× ${why}`).join(', ')}`);
    }
    // A resource the game added that we don't track yet: just information, once
    // per item per process, on the System page (no alert dot). It needs a
    // resource type + icon (docs/game-protocol.md, "Adding a resource type").
    // Replaces the OCR-era "unresolved resources" review, retired Nov 2026.
    for (const [why, n] of Object.entries(skipped)) {
        if (!why.startsWith('unmapped item ') || reportedUnmapped.has(why))
            continue;
        reportedUnmapped.add(why);
        log.warn({ noAlert: true }, `The Clan Capital ledger has a resource we don't track yet (${why.slice('unmapped '.length)}, ${n}× in clan #${clanId}'s read) — its rows are left out until it is added as a resource type.`);
    }
    if (!fresh.length)
        return 0;
    const resolved = fresh
        .map((r) => {
        const name = d.byId.get(r.playerId)?.name ?? '';
        return { r, name, memberId: memberFor(r.playerId, name) };
    })
        .filter((x) => x.memberId !== null);
    if (!resolved.length)
        return 0;
    const batch = (0, resource_repo_js_1.createBatch)({
        clanId,
        uploadedBy: null,
        uploadDate: resolved[resolved.length - 1].r.transactionDate,
        fileCount: 1,
        rowCount: resolved.length,
        errorCount: fresh.length - resolved.length,
        notes: 'Clan Capital ledger (read from the game)',
        source: 'scan',
        sessionId,
    });
    (0, resource_repo_js_1.insertTransactions)(resolved.map(({ r, name, memberId }) => ({
        clanId,
        batchId: batch.id,
        memberId,
        resourceTypeId: r.resourceTypeId,
        direction: r.direction,
        amount: r.amount,
        transactionDate: r.transactionDate,
        rawPlayerName: name,
        gameEntryId: r.entryId,
    })));
    return resolved.length;
}
//# sourceMappingURL=protocol-scan.js.map