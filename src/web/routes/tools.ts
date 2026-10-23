/**
 * Tools page data. The calculators themselves run in the browser
 * (web/public/lib/ancient-planner.js); the server only supplies what they
 * prefill from.
 *
 * Mounted at /api/tools behind requireAuth + requireClanContext and open to
 * every role: it reads the caller's own clan roster and writes nothing.
 */
import { Router } from 'express';
import { getAncientRoster } from '../../data/ancient-roster.js';
import { loadConfig } from '../../config/index.js';
import { currentGameDate } from '../../utils/game-day.js';

export function createToolsRouter(): Router {
  const router = Router();

  /** Members per guards level for the Ancient planner — see data/ancient-roster.ts. */
  router.get('/ancient-roster', (req, res) => {
    const today = currentGameDate(loadConfig().gameDayRolloverUtcHour);
    res.json({ today, ...getAncientRoster(req.clanId!, today) });
  });

  return router;
}
