import type { Router } from 'express';
import {
  getClanById,
  setClanChestTrackerSettings,
} from '../../../data/repositories/clan-repo.js';
import { logAction } from '../../../data/repositories/user-repo.js';
import { requireClanAdmin } from '../../middleware/auth.js';
import { childLogger } from '../../../utils/logger.js';
import { createClanSubRouter } from './_shared.js';

const log = childLogger('clans-route');

/**
 * Per-clan ChestTracker integration. Superadmin/admin via
 * requireClanAdmin (clan ownership AND admin role — a plain member must
 * not be able to repoint or disable the clan's ingestion source). An
 * empty shareCode disables the poller for this
 * clan; switching share codes hot-reloads the per-clan poller via the
 * web server's externalLoop singleton (held in app.locals).
 */
export function createChestTrackerRouter(): Router {
  const router = createClanSubRouter();

  router.put('/:clanId/chesttracker', requireClanAdmin, async (req, res) => {
    const id = req.parsedClanId!;
    const existing = getClanById(id);
    if (!existing) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }
    const body = req.body ?? {};
    setClanChestTrackerSettings(id, {
      shareCode: typeof body.shareCode === 'string' ? body.shareCode.trim() : existing.ctShareCode,
      pollIntervalHours: body.pollIntervalHours === null || body.pollIntervalHours === undefined
        ? existing.ctPollIntervalHours
        : Number(body.pollIntervalHours),
      backfillWeeks: body.backfillWeeks === null || body.backfillWeeks === undefined
        ? existing.ctBackfillWeeks
        : Number(body.backfillWeeks),
    });
    logAction(req.user!.id, 'clan.chesttracker.update', { clanId: id });

    // Hot-reload this clan's poller. The MultiClanExternalLoop singleton
    // is held by the running web server; the easiest hook is via app
    // locals. We re-import lazily so the route module doesn't pull a
    // circular dep on the scheduler.
    try {
      const { MultiClanExternalLoop } = await import('../../../scheduler/external-loop.js');
      const loop = (req.app.get('externalLoop') as InstanceType<typeof MultiClanExternalLoop> | undefined);
      loop?.restartClan(id);
    } catch (err) {
      log.warn({ err, clanId: id }, 'Could not hot-reload ChestTracker poller for clan');
    }

    res.json({ ok: true });
  });

  return router;
}
