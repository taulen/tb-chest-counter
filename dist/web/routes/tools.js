"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createToolsRouter = createToolsRouter;
/**
 * Tools page data. The calculators themselves run in the browser
 * (web/public/lib/ancient-planner.js); the server supplies what they prefill
 * from and keeps each clan's starting values.
 *
 * Mounted at /api/tools behind requireAuth + requireClanContext. Reads are open
 * to every role; saving the clan's defaults is admin-only and lands on the
 * caller's active clan (req.clanId), so an admin can only ever set their own.
 * Citadel and stack presets belong to the signed-in ACCOUNT (req.user.id), any
 * role, and are never visible to anyone else. GET /report-armies lists the
 * armies of shared battle reports: the account's own players' from every
 * clan's chats, anyone else's only as shared in the active clan.
 */
const express_1 = require("express");
const report_armies_js_1 = require("../../data/report-armies.js");
const battle_data_js_1 = require("../../data/battle-data.js");
const player_economy_js_1 = require("../../data/player-economy.js");
const game_protocol_repo_js_1 = require("../../data/repositories/game-protocol-repo.js");
const static_data_js_1 = require("../../game-protocol/static-data.js");
const battle_report_repo_js_1 = require("../../data/repositories/battle-report-repo.js");
const account_invite_repo_js_1 = require("../../data/repositories/account-invite-repo.js");
const ancient_roster_js_1 = require("../../data/ancient-roster.js");
const clan_repo_js_1 = require("../../data/repositories/clan-repo.js");
const citadel_preset_repo_js_1 = require("../../data/repositories/citadel-preset-repo.js");
const stack_preset_repo_js_1 = require("../../data/repositories/stack-preset-repo.js");
const user_repo_js_1 = require("../../data/repositories/user-repo.js");
const ancient_planner_defaults_js_1 = require("../../config/ancient-planner-defaults.js");
const auth_js_1 = require("../middleware/auth.js");
const index_js_1 = require("../../config/index.js");
const game_day_js_1 = require("../../utils/game-day.js");
function ancientDefaults(clanId) {
    const saved = (0, clan_repo_js_1.getClanAncientDefaults)(clanId);
    return saved
        ? { source: 'clan', ...saved }
        : { source: 'built-in', settings: { ...ancient_planner_defaults_js_1.BUILT_IN_ANCIENT_DEFAULTS }, savedAt: null, savedBy: null };
}
function createToolsRouter() {
    const router = (0, express_1.Router)();
    /**
     * Members per guards level for the Ancient planner (see data/ancient-roster.ts),
     * plus the values the page opens on.
     */
    router.get('/ancient-roster', (req, res) => {
        const clanId = req.clanId;
        const today = (0, game_day_js_1.currentGameDate)((0, index_js_1.loadConfig)().gameDayRolloverUtcHour);
        res.json({ today, ...(0, ancient_roster_js_1.getAncientRoster)(clanId, today), defaults: ancientDefaults(clanId) });
    });
    /** Save the current planner settings as this clan's starting values. */
    router.put('/ancient-defaults', auth_js_1.requireAdmin, (req, res) => {
        const clanId = req.clanId;
        const parsed = (0, ancient_planner_defaults_js_1.parseAncientSettings)(req.body?.settings);
        if (!parsed.ok) {
            res.status(400).json({ error: parsed.errors.join('; ') });
            return;
        }
        (0, clan_repo_js_1.setClanAncientDefaults)(clanId, {
            settings: parsed.settings,
            savedAt: new Date().toISOString(),
            savedBy: req.user.username,
        });
        (0, user_repo_js_1.logAction)(req.user.id, 'ancient_defaults_save', { clanId, ...parsed.settings });
        res.json({ ok: true, defaults: ancientDefaults(clanId) });
    });
    /**
     * Battle-report armies for "fill in from a battle report" (Citadel, Stacks),
     * the last REPORT_WINDOW_DAYS only: the players to pick from — the
     * account's own (every clan's shares) and anyone who fought or posted a
     * readable battle in the active clan — and the battles. By default the
     * account's own players' together (`player` = their id when there's one,
     * 'own' for several, null for none); `?player=<id>` one player's — another
     * player's only as shared in the active clan. `?only=citadels`: citadel
     * battles only (Tools → Citadel).
     */
    router.get('/report-armies', async (req, res) => {
        const clanId = req.clanId;
        const links = (0, account_invite_repo_js_1.linksForUser)(req.user.id);
        const own = [...new Set(links.map((l) => l.playerId))];
        const citadels = req.query.only === 'citadels' ? await (0, report_armies_js_1.loadCitadels)() : null;
        const filter = { targets: citadels ? Object.keys(citadels).map(Number) : null };
        const players = (0, report_armies_js_1.reportPlayers)(clanId, own, filter);
        // An own player the scans haven't named yet takes the name its link was made with.
        for (const p of players) {
            if (!p.name && p.own)
                p.name = links.find((l) => l.playerId === p.playerId && l.playerName)?.playerName ?? '';
        }
        const mine = players.filter((p) => p.own).map((p) => p.playerId);
        const picked = players.find((p) => String(p.playerId) === String(req.query.player ?? '')) ?? null;
        const ids = picked ? [picked.playerId] : mine;
        const player = picked ? picked.playerId : mine.length > 1 ? 'own' : mine[0] ?? null;
        const reports = ids.length
            ? await (0, report_armies_js_1.reportArmiesFor)(ids, { clanId: picked && !picked.own ? clanId : null, namesClanId: clanId, ...filter })
            : [];
        res.json({
            linked: own.length > 0, players, player, reports, waiting: (0, battle_report_repo_js_1.waitingReportCount)(),
            windowDays: report_armies_js_1.REPORT_WINDOW_DAYS, only: citadels ? 'citadels' : null,
        });
    });
    /**
     * What losses cost the viewer's own linked players (data/player-economy.ts):
     * per player, the training discounts per troop kind, the Temple's level and
     * the strength bonus against epic monsters, from their newest city read.
     * Only the account's own players: Citadel and Monsters plan for them.
     */
    router.get('/player-economy', (req, res) => {
        const links = (0, account_invite_repo_js_1.linksForUser)(req.user.id);
        const own = [...new Map(links.map((l) => [l.playerId, l])).values()];
        const reads = new Map((0, game_protocol_repo_js_1.latestCityReads)(own.map((l) => l.playerId)).map((r) => [r.playerId, r]));
        const templeType = (0, battle_data_js_1.loadBattleData)()?.temple?.type ?? null;
        res.json({
            players: own.map((l) => {
                const r = reads.get(l.playerId);
                return {
                    playerId: l.playerId,
                    name: l.playerName,
                    day: r?.gameDate ?? null,
                    ...(0, player_economy_js_1.playerEconomy)(r?.stats ?? null, r?.buildings ?? null, templeType),
                };
            }),
        });
    });
    /**
     * Tools → Monsters' game data (data/battle-data.ts): every unit's numbers and
     * every monster target's army, from the game's own files, rebuilt each patch.
     * The browser keeps it ten minutes, then revalidates by ETag.
     */
    router.get('/battle-data', (req, res) => {
        const data = (0, battle_data_js_1.battleDataResponse)();
        if (!data) {
            // Start the names build (it writes battle-data.json; one build at a time).
            (0, static_data_js_1.loadGameNames)().catch(() => { });
            res.setHeader('Cache-Control', 'no-store');
            res.status(503).json({ error: 'The game data is not built yet. Try again in a few minutes.' });
            return;
        }
        res.setHeader('Cache-Control', 'private, max-age=600');
        res.setHeader('ETag', data.etag);
        res.setHeader('Vary', 'Accept-Encoding');
        if (req.fresh) {
            res.status(304).end();
            return;
        }
        res.type('application/json');
        if (req.acceptsEncodings('gzip')) {
            res.setHeader('Content-Encoding', 'gzip');
            res.send(data.gzip);
        }
        else {
            res.send(data.body);
        }
    });
    /** The signed-in account's saved citadel armies. */
    router.get('/citadel-presets', (req, res) => {
        res.json({ presets: (0, citadel_preset_repo_js_1.listCitadelPresets)(req.user.id) });
    });
    /** Save the current army under a name (the same name overwrites). */
    router.put('/citadel-presets', (req, res) => {
        const parsed = (0, citadel_preset_repo_js_1.parseCitadelPreset)(req.body);
        if (!parsed.ok) {
            res.status(400).json({ error: parsed.errors.join('; ') });
            return;
        }
        const preset = (0, citadel_preset_repo_js_1.saveCitadelPreset)(req.user.id, parsed.value.name, parsed.value.data);
        if (!preset) {
            res.status(409).json({ error: `You can keep at most ${citadel_preset_repo_js_1.MAX_PRESETS_PER_USER} saved armies. Delete one first.` });
            return;
        }
        res.json({ ok: true, preset, presets: (0, citadel_preset_repo_js_1.listCitadelPresets)(req.user.id) });
    });
    router.delete('/citadel-presets/:id', (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0 || !(0, citadel_preset_repo_js_1.deleteCitadelPreset)(req.user.id, id)) {
            res.status(404).json({ error: 'No such saved army.' });
            return;
        }
        res.json({ ok: true, presets: (0, citadel_preset_repo_js_1.listCitadelPresets)(req.user.id) });
    });
    /** The caller's unlocked troop tiers (per account; null = any). */
    router.get('/citadel-levels', (req, res) => {
        res.json({ levels: (0, citadel_preset_repo_js_1.getCitadelLevels)(req.user.id) });
    });
    router.put('/citadel-levels', (req, res) => {
        const parsed = (0, citadel_preset_repo_js_1.parseCitadelLevels)(req.body);
        if (!parsed.ok) {
            res.status(400).json({ error: parsed.errors.join('; ') });
            return;
        }
        res.json({ ok: true, levels: (0, citadel_preset_repo_js_1.saveCitadelLevels)(req.user.id, parsed.value) });
    });
    /** The signed-in account's saved stack-calculator armies. */
    router.get('/stack-presets', (req, res) => {
        res.json({ presets: (0, stack_preset_repo_js_1.listStackPresets)(req.user.id) });
    });
    /** Save the current troops and settings under a name (the same name overwrites). */
    router.put('/stack-presets', (req, res) => {
        const parsed = (0, stack_preset_repo_js_1.parseStackPreset)(req.body);
        if (!parsed.ok) {
            res.status(400).json({ error: parsed.errors.join('; ') });
            return;
        }
        const preset = (0, stack_preset_repo_js_1.saveStackPreset)(req.user.id, parsed.value.name, parsed.value.data);
        if (!preset) {
            res.status(409).json({ error: `You can keep at most ${citadel_preset_repo_js_1.MAX_PRESETS_PER_USER} saved armies. Delete one first.` });
            return;
        }
        res.json({ ok: true, preset, presets: (0, stack_preset_repo_js_1.listStackPresets)(req.user.id) });
    });
    router.delete('/stack-presets/:id', (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0 || !(0, stack_preset_repo_js_1.deleteStackPreset)(req.user.id, id)) {
            res.status(404).json({ error: 'No such saved army.' });
            return;
        }
        res.json({ ok: true, presets: (0, stack_preset_repo_js_1.listStackPresets)(req.user.id) });
    });
    return router;
}
//# sourceMappingURL=tools.js.map