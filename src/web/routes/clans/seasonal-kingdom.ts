import type { Router } from 'express';
import {
  getClanById,
  setClanSeasonalKingdom,
} from '../../../data/repositories/clan-repo.js';
import { logAction } from '../../../data/repositories/user-repo.js';
import { requireClanAdmin } from '../../middleware/auth.js';
import { createClanSubRouter } from './_shared.js';

export function createSeasonalKingdomRouter(): Router {
  const router = createClanSubRouter();

  /**
   * Mark the clan as playing a Seasonal Kingdom (or not). An SK clan's event
   * windows come from the SK calendar (docs/seasonal-kingdoms.md); turning it
   * on also moves the clan off Tinman weeks, and the response carries the week
   * shape it ended up with so the page can follow. Clan-admin only, like every
   * /api/clans config route.
   */
  router.put('/:clanId/seasonal-kingdom', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    const clan = getClanById(id);
    if (!clan) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }

    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be true or false' });
      return;
    }

    const weekStart = setClanSeasonalKingdom(id, enabled);
    logAction(req.user!.id, 'clan.seasonal_kingdom.update', {
      clanId: id,
      enabled,
      ...(weekStart !== clan.weekStart ? { weekStart } : {}),
    });
    res.json({ ok: true, seasonalKingdom: enabled, weekStart });
  });

  return router;
}
