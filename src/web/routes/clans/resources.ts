import type { Router } from 'express';
import { getClanById, setClanResourcesEnabled } from '../../../data/repositories/clan-repo.js';
import { logAction } from '../../../data/repositories/user-repo.js';
import { requireClanAdmin } from '../../middleware/auth.js';
import { createClanSubRouter } from './_shared.js';

/** Per-clan resource routes, keyed on an explicit :clanId. */
export function createResourcesRouter(): Router {
  const router = createClanSubRouter();

  /** Toggle the resource tracking feature on/off for this clan.
   *  Admin/superadmin only (a clan-wide feature flag, not a per-member
   *  setting) — requireClanAdmin enforces clan ownership AND admin role. */
  router.put('/:clanId/resources', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    if (!getClanById(id)) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }
    const enabled = !!req.body?.enabled;
    setClanResourcesEnabled(id, enabled);
    logAction(req.user!.id, 'clan.resources.toggle', { clanId: id, enabled });
    res.json({ ok: true, enabled });
  });

  return router;
}
