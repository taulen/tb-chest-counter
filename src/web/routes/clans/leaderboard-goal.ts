import type { Router } from 'express';
import {
  getClanById,
  listGoalHistory,
  setClanLeaderboardGoal,
} from '../../../data/repositories/clan-repo.js';
import { weekFirstDay } from '../../../data/goal-history.js';
import { loadConfig } from '../../../config/index.js';
import { invalidate } from '../../../utils/ttl-cache.js';
import { logAction } from '../../../data/repositories/user-repo.js';
import { requireClanAdmin } from '../../middleware/auth.js';
import { createClanSubRouter } from './_shared.js';

/**
 * Upper bound on the weekly target. Not a game rule — a guard so a mistyped
 * figure can't be stored as something no member could ever approach, which
 * would paint every row red and look like the feature is broken rather than
 * like a typo. Well clear of any real clan's weekly total.
 */
const MAX_WEEKLY_GOAL_POINTS = 100_000_000;

export function createLeaderboardGoalRouter(): Router {
  const router = createClanSubRouter();

  /**
   * Set this clan's leaderboard points goal. `enabled` turns the per-row
   * green/amber/red colouring on; `weeklyPoints` is the WEEKLY target — the one
   * number every other timeframe is derived from (daily = /7, monthly = /7*30,
   * yearly = /7*365, done client-side in lib/leaderboard-render.js).
   *
   * Blank/null clears the target while leaving the flag alone, so an admin can
   * switch the colouring off and back on without retyping it. Clan-admin only,
   * per the same ownership rule every /api/clans config route follows.
   */
  router.put('/:clanId/leaderboard-goal', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    const clan = getClanById(id);
    if (!clan) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }

    const enabled = !!req.body?.enabled;

    const raw = req.body?.weeklyPoints;
    const weeklyPoints = raw === null || raw === undefined || raw === '' ? null : Number(raw);
    if (weeklyPoints !== null
      && (!Number.isInteger(weeklyPoints) || weeklyPoints < 1 || weeklyPoints > MAX_WEEKLY_GOAL_POINTS)) {
      res.status(400).json({
        error: `weeklyPoints must be blank or a whole number between 1 and ${MAX_WEEKLY_GOAL_POINTS.toLocaleString('en-US')}`,
      });
      return;
    }

    // Where amber starts, in whole percent of the goal. Blank is the default
    // (66%); a request without the field keeps whatever the clan has, so a
    // caller that only knows about the goal can't reset it by accident.
    const rawAmber = req.body?.amberPct;
    const amberPct = rawAmber === undefined
      ? clan.leaderboardGoalAmberPct
      : rawAmber === null || rawAmber === '' ? null : Number(rawAmber);
    if (amberPct !== null && (!Number.isInteger(amberPct) || amberPct < 1 || amberPct > 99)) {
      res.status(400).json({ error: 'amberPct must be blank or a whole number between 1 and 99' });
      return;
    }

    // The new numbers cover the week in progress and every week after it;
    // finished weeks keep the goal they were played under (clan_goal_history).
    const rollover = loadConfig().gameDayRolloverUtcHour;
    const effectiveFrom = weekFirstDay(Date.now(), rollover, clan.weekStart);
    setClanLeaderboardGoal(id, { enabled, weeklyPoints, amberPct }, effectiveFrom);
    // The Performance page judges every closed week against this history.
    invalidate(`performance:${id}:`);
    logAction(req.user!.id, 'clan.leaderboard_goal.update', { clanId: id, enabled, weeklyPoints, amberPct });
    res.json({ ok: true, enabled, weeklyPoints, amberPct, effectiveFrom, history: listGoalHistory(id) });
  });

  return router;
}
