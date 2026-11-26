import { Router } from 'express';
import type { ScanLoop } from '../../scheduler/loop.js';
import { createCrudRouter } from './clans/crud.js';
import { createDiscordRouter } from './clans/discord.js';
import { createChestTrackerRouter } from './clans/chesttracker.js';
import { createLeaderboardGoalRouter } from './clans/leaderboard-goal.js';
import { createWeekStartRouter } from './clans/week-start.js';
import { createSeasonalKingdomRouter } from './clans/seasonal-kingdom.js';
import { createChatDigestRouter } from './clans/chat-digest.js';
import { createAccountInvitesRouter } from './clans/account-invites.js';
import { createChatCommandsRouter } from './clans/chat-commands.js';
import { createDragonCoinReturnsRouter } from './clans/dragon-coin-returns.js';

/**
 * `/api/clans` is split into sub-routers, composed here. Each
 * sub-router owns its own concerns and installs its own `:clanId`
 * param handler — Express doesn't propagate router.param() to mounted
 * sub-routers, so it has to be set up at the level where the routes
 * live.
 */
export function createClansRouter(scanLoop?: ScanLoop): Router {
  const router = Router();

  router.use(createCrudRouter(scanLoop));
  router.use(createDiscordRouter());
  router.use(createChestTrackerRouter());
  router.use(createLeaderboardGoalRouter());
  router.use(createWeekStartRouter());
  router.use(createSeasonalKingdomRouter());
  router.use(createChatDigestRouter());
  router.use(createAccountInvitesRouter());
  router.use(createChatCommandsRouter());
  router.use(createDragonCoinReturnsRouter());

  return router;
}
