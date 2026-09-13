"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createClansRouter = createClansRouter;
const express_1 = require("express");
const crud_js_1 = require("./clans/crud.js");
const discord_js_1 = require("./clans/discord.js");
const chesttracker_js_1 = require("./clans/chesttracker.js");
const onboard_js_1 = require("./clans/onboard.js");
const resources_js_1 = require("./clans/resources.js");
const inactivity_js_1 = require("./clans/inactivity.js");
const leaderboard_goal_js_1 = require("./clans/leaderboard-goal.js");
/**
 * `/api/clans` is split into sub-routers, composed here. Each
 * sub-router owns its own concerns and installs its own `:clanId`
 * param handler — Express doesn't propagate router.param() to mounted
 * sub-routers, so it has to be set up at the level where the routes
 * live.
 *
 * The OnboardState is created once per composer call (so tests build
 * a fresh state per test, prod gets one for the life of the process)
 * and shared between the crud router (which clears entries on clan
 * delete) and the onboard router (which reads/writes them).
 */
function createClansRouter(scanLoop) {
    const router = (0, express_1.Router)();
    const onboardState = (0, onboard_js_1.createOnboardState)();
    router.use((0, crud_js_1.createCrudRouter)(onboardState));
    router.use((0, discord_js_1.createDiscordRouter)());
    router.use((0, chesttracker_js_1.createChestTrackerRouter)());
    router.use((0, onboard_js_1.createOnboardRouter)(onboardState));
    router.use((0, resources_js_1.createResourcesRouter)(scanLoop));
    router.use((0, inactivity_js_1.createInactivityRouter)());
    router.use((0, leaderboard_goal_js_1.createLeaderboardGoalRouter)());
    return router;
}
//# sourceMappingURL=clans.js.map