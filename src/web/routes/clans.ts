import { Router } from 'express';
import { createCrudRouter } from './clans/crud.js';
import { createDiscordRouter } from './clans/discord.js';
import { createChestTrackerRouter } from './clans/chesttracker.js';
import { createOnboardRouter, createOnboardState } from './clans/onboard.js';
import { createResourcesRouter } from './clans/resources.js';
import type { ScanLoop } from '../../scheduler/loop.js';
import { createInactivityRouter } from './clans/inactivity.js';
import { createLeaderboardGoalRouter } from './clans/leaderboard-goal.js';

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
export function createClansRouter(scanLoop?: ScanLoop): Router {
  const router = Router();

  const onboardState = createOnboardState();

  router.use(createCrudRouter(onboardState));
  router.use(createDiscordRouter());
  router.use(createChestTrackerRouter());
  router.use(createOnboardRouter(onboardState));
  router.use(createResourcesRouter(scanLoop));
  router.use(createInactivityRouter());
  router.use(createLeaderboardGoalRouter());

  return router;
}
