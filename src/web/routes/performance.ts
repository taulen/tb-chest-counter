/**
 * The Performance page (admins only): every active member scored against the
 * clan's weekly goal, their Tin Man target and event participation, over a
 * timeframe. See data/performance.ts; the scoring tunables are in
 * config/performance-scoring.ts.
 *
 * Mounted at /api/performance behind requireAuth + requireClanContext, so
 * `req.clanId` is the caller's active clan — and admin of THAT clan is what
 * requireAdmin checks, since req.user.role is the active clan's role.
 */
import { Router } from 'express';
import { getClanById } from '../../data/repositories/clan-repo.js';
import { getPerformanceReport } from '../../data/performance.js';
import { resolvePerformanceConfig } from '../../config/performance-scoring.js';
import { loadConfig } from '../../config/index.js';
import { requireAdmin } from '../middleware/auth.js';
import { resolveWeeklyGoalPoints } from './leaderboard-handler.js';

export function createPerformanceRouter(): Router {
  const router = Router();

  router.get('/', requireAdmin, async (req, res, next) => {
    try {
      const clanId = req.clanId!;
      const clan = getClanById(clanId);
      if (!clan) {
        res.status(404).json({ error: 'Clan not found' });
        return;
      }
      const config = resolvePerformanceConfig(clanId);
      const raw = typeof req.query.timeframe === 'string' ? req.query.timeframe : '';
      const timeframe = config.timeframes.some((t) => t.key === raw) ? raw : config.defaultTimeframe;
      const report = await getPerformanceReport({
        clanId,
        timeframe,
        weeklyGoal: resolveWeeklyGoalPoints(clan),
        goalAmberPct: clan.leaderboardGoalAmberPct,
        weekStart: clan.weekStart,
        rolloverUtcHour: loadConfig().gameDayRolloverUtcHour,
      });
      res.json(report);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
