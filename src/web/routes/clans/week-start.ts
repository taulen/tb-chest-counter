import type { Router } from 'express';
import {
  getClanById,
  setClanWeekStart,
  weekStartAllowed,
} from '../../../data/repositories/clan-repo.js';
import { logAction } from '../../../data/repositories/user-repo.js';
import { isWeekStart, WEEK_STARTS } from '../../../utils/game-day.js';
import { requireClanAdmin } from '../../middleware/auth.js';
import { createClanSubRouter } from './_shared.js';

export function createWeekStartRouter(): Router {
  const router = createClanSubRouter();

  /**
   * Set how this clan cuts its week: 'sunday' (Sunday → Sunday), 'ancients'
   * (Tinman to Tinman, 6 days) or, in a Seasonal Kingdom, 'ancients-sk'
   * (Tinman to Tinman on the SK cadence). Every Weekly view the clan sees
   * follows it. Clan-admin only, per the same ownership rule every /api/clans
   * config route follows.
   */
  router.put('/:clanId/week-start', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    const clan = getClanById(id);
    if (!clan) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }

    const weekStart = req.body?.weekStart;
    if (!isWeekStart(weekStart)) {
      res.status(400).json({ error: `weekStart must be one of: ${WEEK_STARTS.join(', ')}` });
      return;
    }
    // Each kingdom cuts Tinman weeks on its own Ancients cadence.
    if (!weekStartAllowed(clan, weekStart)) {
      res.status(400).json({
        error: clan.seasonalKingdom
          ? 'This clan plays a Seasonal Kingdom: its Tinman weeks are ancients-sk.'
          : 'ancients-sk is for Seasonal Kingdom clans: use ancients for Tinman weeks.',
      });
      return;
    }

    setClanWeekStart(id, weekStart);
    logAction(req.user!.id, 'clan.week_start.update', { clanId: id, weekStart });
    res.json({ ok: true, weekStart });
  });

  return router;
}
