import type { Router } from 'express';
import {
  getClanById,
  setClanWeekStart,
} from '../../../data/repositories/clan-repo.js';
import { logAction } from '../../../data/repositories/user-repo.js';
import { isWeekStart, WEEK_STARTS } from '../../../utils/game-day.js';
import { requireClanAdmin } from '../../middleware/auth.js';
import { createClanSubRouter } from './_shared.js';

export function createWeekStartRouter(): Router {
  const router = createClanSubRouter();

  /**
   * Set how this clan cuts its week: 'sunday' (Sunday → Sunday) or 'ancients'
   * (Tinman to Tinman, 6 days). Every Weekly view the clan sees follows it.
   * Clan-admin only, per the same ownership rule every /api/clans config route
   * follows.
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
    // Tinman weeks are cut on the normal kingdom's fixed 6-day Ancients
    // cadence; a Seasonal Kingdom runs Ancients on its own schedule.
    if (weekStart === 'ancients' && clan.seasonalKingdom) {
      res.status(400).json({ error: 'Tinman weeks are not available in a Seasonal Kingdom.' });
      return;
    }

    setClanWeekStart(id, weekStart);
    logAction(req.user!.id, 'clan.week_start.update', { clanId: id, weekStart });
    res.json({ ok: true, weekStart });
  });

  return router;
}
