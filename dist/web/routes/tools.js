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
 * Citadel presets belong to the signed-in ACCOUNT (req.user.id), any role, and
 * are never visible to anyone else.
 */
const express_1 = require("express");
const ancient_roster_js_1 = require("../../data/ancient-roster.js");
const clan_repo_js_1 = require("../../data/repositories/clan-repo.js");
const citadel_preset_repo_js_1 = require("../../data/repositories/citadel-preset-repo.js");
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
    return router;
}
//# sourceMappingURL=tools.js.map