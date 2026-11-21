"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createClansRouter = createClansRouter;
const express_1 = require("express");
const crud_js_1 = require("./clans/crud.js");
const discord_js_1 = require("./clans/discord.js");
const chesttracker_js_1 = require("./clans/chesttracker.js");
const leaderboard_goal_js_1 = require("./clans/leaderboard-goal.js");
const week_start_js_1 = require("./clans/week-start.js");
const seasonal_kingdom_js_1 = require("./clans/seasonal-kingdom.js");
const chat_digest_js_1 = require("./clans/chat-digest.js");
const account_invites_js_1 = require("./clans/account-invites.js");
const chat_commands_js_1 = require("./clans/chat-commands.js");
/**
 * `/api/clans` is split into sub-routers, composed here. Each
 * sub-router owns its own concerns and installs its own `:clanId`
 * param handler — Express doesn't propagate router.param() to mounted
 * sub-routers, so it has to be set up at the level where the routes
 * live.
 */
function createClansRouter(scanLoop) {
    const router = (0, express_1.Router)();
    router.use((0, crud_js_1.createCrudRouter)(scanLoop));
    router.use((0, discord_js_1.createDiscordRouter)());
    router.use((0, chesttracker_js_1.createChestTrackerRouter)());
    router.use((0, leaderboard_goal_js_1.createLeaderboardGoalRouter)());
    router.use((0, week_start_js_1.createWeekStartRouter)());
    router.use((0, seasonal_kingdom_js_1.createSeasonalKingdomRouter)());
    router.use((0, chat_digest_js_1.createChatDigestRouter)());
    router.use((0, account_invites_js_1.createAccountInvitesRouter)());
    router.use((0, chat_commands_js_1.createChatCommandsRouter)());
    return router;
}
//# sourceMappingURL=clans.js.map