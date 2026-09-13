import type { Router } from 'express';
import {
  getClanById,
  setClanInactivitySettings,
} from '../../../data/repositories/clan-repo.js';
import { logAction } from '../../../data/repositories/user-repo.js';
import { requireClanAdmin } from '../../middleware/auth.js';
import { createClanSubRouter } from './_shared.js';

export function createInactivityRouter(): Router {
  const router = createClanSubRouter();

  /** Set this clan's member-inactivity-sweep settings. `enabled` toggles the
   *  sweep on/off; `inactivityDays` is the threshold (days a member can go
   *  unseen before being soft-removed) — null/'' inherits the global
   *  MEMBER_INACTIVITY_DAYS default, a positive integer is a custom cutoff.
   *  Clan-admin only. */
  router.put('/:clanId/inactivity', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    if (!getClanById(id)) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }

    const enabled = !!req.body?.enabled;

    const raw = req.body?.inactivityDays;
    const days = raw === null || raw === undefined || raw === '' ? null : Number(raw);
    if (days !== null && (!Number.isInteger(days) || days < 1)) {
      res.status(400).json({ error: 'inactivityDays must be blank or a positive whole number' });
      return;
    }

    setClanInactivitySettings(id, { enabled, days });
    logAction(req.user!.id, 'clan.inactivity.update', { clanId: id, enabled, inactivityDays: days });
    res.json({ ok: true, enabled, inactivityDays: days });
  });

  return router;
}
