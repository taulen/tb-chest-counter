"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createClansRouter = createClansRouter;
const express_1 = require("express");
const crud_js_1 = require("./clans/crud.js");
const discord_js_1 = require("./clans/discord.js");
const chesttracker_js_1 = require("./clans/chesttracker.js");
const resources_js_1 = require("./clans/resources.js");
const inactivity_js_1 = require("./clans/inactivity.js");
const leaderboard_goal_js_1 = require("./clans/leaderboard-goal.js");
const week_start_js_1 = require("./clans/week-start.js");
const seasonal_kingdom_js_1 = require("./clans/seasonal-kingdom.js");
/**
 * `/api/clans` is split into sub-routers, composed here. Each
 * sub-router owns its own concerns and installs its own `:clanId`
 * param handler — Express doesn't propagate router.param() to mounted
 * sub-routers, so it has to be set up at the level where the routes
 * live.
 */
function createClansRouter() {
    const router = (0, express_1.Router)();
    router.use((0, crud_js_1.createCrudRouter)());
    router.use((0, discord_js_1.createDiscordRouter)());
    router.use((0, chesttracker_js_1.createChestTrackerRouter)());
    router.use((0, resources_js_1.createResourcesRouter)());
    router.use((0, inactivity_js_1.createInactivityRouter)());
    router.use((0, leaderboard_goal_js_1.createLeaderboardGoalRouter)());
    router.use((0, week_start_js_1.createWeekStartRouter)());
    router.use((0, seasonal_kingdom_js_1.createSeasonalKingdomRouter)());
    return router;
}
//# sourceMappingURL=clans.js.map