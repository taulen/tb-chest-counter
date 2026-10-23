"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createToolsRouter = createToolsRouter;
/**
 * Tools page data. The calculators themselves run in the browser
 * (web/public/lib/ancient-planner.js); the server only supplies what they
 * prefill from.
 *
 * Mounted at /api/tools behind requireAuth + requireClanContext and open to
 * every role: it reads the caller's own clan roster and writes nothing.
 */
const express_1 = require("express");
const ancient_roster_js_1 = require("../../data/ancient-roster.js");
const index_js_1 = require("../../config/index.js");
const game_day_js_1 = require("../../utils/game-day.js");
function createToolsRouter() {
    const router = (0, express_1.Router)();
    /** Members per guards level for the Ancient planner — see data/ancient-roster.ts. */
    router.get('/ancient-roster', (req, res) => {
        const today = (0, game_day_js_1.currentGameDate)((0, index_js_1.loadConfig)().gameDayRolloverUtcHour);
        res.json({ today, ...(0, ancient_roster_js_1.getAncientRoster)(req.clanId, today) });
    });
    return router;
}
//# sourceMappingURL=tools.js.map