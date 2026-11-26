"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDragonCoinReturnsRouter = createDragonCoinReturnsRouter;
const database_js_1 = require("../../../data/database.js");
const clan_repo_js_1 = require("../../../data/repositories/clan-repo.js");
const dragon_coin_return_repo_js_1 = require("../../../data/repositories/dragon-coin-return-repo.js");
const account_invite_repo_js_1 = require("../../../data/repositories/account-invite-repo.js");
const user_repo_js_1 = require("../../../data/repositories/user-repo.js");
const dragon_coin_returns_js_1 = require("../../../game-protocol/dragon-coin-returns.js");
const dragon_coin_returns_js_2 = require("../../../scheduler/dragon-coin-returns.js");
const auth_js_1 = require("../../middleware/auth.js");
const _shared_js_1 = require("./_shared.js");
/**
 * Dragon Coins back to members (docs/dragon-coin-returns.md): the clan's
 * scanner account sends each member the Dragon Coins they brought into the
 * treasury. Off by default; switched by the clan's admins or the superadmin
 * (requireClanAdmin — every send pays out of the clan's treasury).
 */
function createDragonCoinReturnsRouter() {
    const router = (0, _shared_js_1.createClanSubRouter)();
    router.get('/:clanId/dragon-coin-returns', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        if (!(0, clan_repo_js_1.getClanById)(id)) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        const db = (0, database_js_1.getDb)();
        const players = db.prepare('SELECT player_id, name, role, in_clan FROM game_players WHERE clan_id = ?')
            .all(id);
        const byId = new Map(players.map((p) => [p.player_id, p]));
        const memberIds = (0, account_invite_repo_js_1.memberIdsByPlayer)(id);
        const who = (playerId) => ({
            player: byId.get(playerId)?.name ?? null,
            memberId: memberIds.get((0, account_invite_repo_js_1.playerKey)(id, playerId)) ?? null,
        });
        const scannerId = db.prepare('SELECT player_id FROM clan_scan_accounts WHERE clan_id = ?').get(id)?.player_id ?? null;
        const scannerRow = scannerId !== null ? byId.get(scannerId) : undefined;
        const scanner = scannerId !== null
            ? { name: scannerRow?.name ?? null, rank: scannerRow?.in_clan ? scannerRow.role ?? null : null }
            : null;
        const settings = (0, dragon_coin_return_repo_js_1.getDragonCoinReturnSettings)(id);
        const now = Date.now();
        // What the next scan would send (the same plan the scan makes, from the stored ledger).
        const plan = settings.enabled && settings.enabledAt !== null
            ? (0, dragon_coin_returns_js_1.planDragonCoinReturns)({
                enabledAt: settings.enabledAt,
                entries: (0, dragon_coin_return_repo_js_1.dragonCoinEntries)(id, settings.enabledAt),
                returns: (0, dragon_coin_return_repo_js_1.listDragonCoinReturns)(id),
                now,
                onRoster: (playerId) => byId.get(playerId)?.in_clan === 1,
            })
            : null;
        res.json({
            settings,
            sendingDisabled: (0, dragon_coin_returns_js_2.dragonCoinReturnsDisabled)(),
            scanner,
            rankOk: scanner?.rank != null && dragon_coin_returns_js_2.TREASURY_RANKS.has(scanner.rank),
            waiting: (plan?.sends ?? []).map((s) => ({ ...who(s.playerId), amount: s.amount, entries: s.donationEntryIds.length, since: s.since * 1000 })),
            held: (plan?.held ?? []).slice(-25).reverse().map((h) => ({ ...who(h.playerId), amount: h.amount, at: h.occurredAt * 1000, reason: h.reason })),
            recent: (0, dragon_coin_return_repo_js_1.recentDragonCoinReturns)(id, 25).map((r) => ({
                ...who(r.playerId), amount: r.amount, at: r.createdAt, status: r.status, confirmed: r.ledgerEntryId !== null, reason: r.reason,
            })),
            sentLastWeek: (0, dragon_coin_return_repo_js_1.dragonCoinsSentSince)(id, now - 7 * 24 * 3600_000),
            limits: { perRun: dragon_coin_returns_js_2.SENDS_PER_RUN, maxAttempts: dragon_coin_returns_js_1.MAX_ATTEMPTS, unconfirmedMinutes: Math.round(dragon_coin_returns_js_1.UNCONFIRMED_AFTER_MS / 60_000) },
        });
    });
    router.put('/:clanId/dragon-coin-returns', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        if (!(0, clan_repo_js_1.getClanById)(id)) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        const { enabled } = req.body ?? {};
        if (typeof enabled !== 'boolean') {
            res.status(400).json({ error: 'enabled must be true or false' });
            return;
        }
        const settings = (0, dragon_coin_return_repo_js_1.setDragonCoinReturnsEnabled)(id, enabled);
        (0, user_repo_js_1.logAction)(req.user.id, 'clan.dragon_coin_returns.update', { clanId: id, enabled: settings.enabled });
        res.json({ ok: true, settings });
    });
    return router;
}
//# sourceMappingURL=dragon-coin-returns.js.map