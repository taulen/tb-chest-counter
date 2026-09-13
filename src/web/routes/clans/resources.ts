import type { Router } from 'express';
import fs from 'fs';
import path from 'path';
import {
  getClanById,
  setClanResourcesEnabled,
  setClanResourceAutoCapture,
} from '../../../data/repositories/clan-repo.js';
import { logAction } from '../../../data/repositories/user-repo.js';
import { childLogger } from '../../../utils/logger.js';
import {
  isResourceHistoryCalibrated,
  missingResourceHistoryTargets,
} from '../../../config/calibration.js';
import { requireClanAdmin } from '../../middleware/auth.js';
import { createClanSubRouter } from './_shared.js';
import type { ScanLoop } from '../../../scheduler/loop.js';

const log = childLogger('clan-resources-route');

/**
 * Filenames the debug-screenshot routes will list and serve.
 *
 * Matches what resource-history-capture.ts writes inside a run directory:
 * p001-crop_…, p010-full_…, blank-p055_…, final-page_…, nav-fail_….
 *
 * A whitelist, not a sanitiser: this and DEBUG_RUN_DIR both arrive as URL
 * parameters and are used to read from disk, so it must be structurally impossible
 * for a crafted value to escape. Neither admits a separator or a dot beyond the
 * extension, which achieves that without relying on stripping being exhaustive.
 * Confinement to one run directory is also what keeps this from becoming a general
 * listing of data/screenshots, which holds unrelated scan debris.
 */
const DEBUG_SHOT_NAME = /^[A-Za-z0-9_-]+\.png$/;

/** Per-run debug directory name, as written by resource-history-capture.ts. */
const DEBUG_RUN_DIR = /^run_[A-Za-z0-9_-]+$/;

/** Root of the per-run debug directories. */
function debugRunsRoot(): string {
  return path.resolve('data', 'screenshots', 'resource-debug');
}



/**
 * In-flight state for the manual "Collect resources now" run.
 *
 * A capture drives a browser through a scroll sweep and routinely runs for
 * minutes — a full 14-day backfill much longer. It CANNOT be an ordinary blocking
 * request: this deployment is fronted by Cloudflare, whose proxy gives up at about
 * 100 seconds and hands the client a 504 while the work carries on happily
 * server-side. The result was the worst of both worlds — a scary error in the UI
 * and a capture the operator couldn't see the outcome of.
 *
 * So the route starts the work and returns immediately, and the client polls. Same
 * shape as the calibration screenshot job in routes/api.ts, for the same reason,
 * and it has the same bonus property: the outcome survives a page reload or
 * navigating away mid-capture, which a streamed response would not.
 *
 * A singleton is enough — collectResourcesNow takes the scan lock, so only one can
 * ever be in flight.
 */
type ResourceCollectJob = {
  status: 'running' | 'done' | 'error';
  clanId: number;
  startedAt: number;
  finishedAt: number | null;
  fullBackfill: boolean;
  dryRun: boolean;
  outcome: unknown | null;
  error: string | null;
};
let resourceCollectJob: ResourceCollectJob | null = null;


/**
 * Per-clan resource routes.
 *
 * The manual collect and diagnostic endpoints live HERE, keyed on an explicit
 * :clanId, rather than on the session-scoped /api/resources router where they
 * started. That move closes a real hazard: the session router resolves the clan from
 * whichever one the operator has active, so a "Collect now" button rendered beside
 * clan #3 on the Clans page would have driven a capture against clan #2 without
 * saying so. An action that opens a browser and writes rows should take the clan it
 * acts on as an argument, not inherit it from elsewhere.
 */
export function createResourcesRouter(scanLoop?: ScanLoop): Router {
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
    // Absent means "leave it alone" so an older client can't silently reset it.
    const autoCapture = req.body?.autoCapture;
    if (autoCapture !== undefined) setClanResourceAutoCapture(id, !!autoCapture);
    logAction(req.user!.id, 'clan.resources.toggle', { clanId: id, enabled, autoCapture });
    res.json({ ok: true, enabled, autoCapture: getClanById(id)?.resourceAutoCapture ?? true });
  });

  /**
   * GET /:clanId/resources/debug-shots — list the debug PNGs the last capture left behind.
   *
   * Exists so the frames can be looked at in the browser instead of being
   * extracted from the container by hand. That is not just convenience: pulling a
   * binary out of a container is exactly where a file gets mangled by a text-mode
   * copy or opened in something that renders it as hex, and then it is impossible
   * to tell a corrupt capture from a viewing problem. Served straight from disk,
   * the browser either renders it or it doesn't, which answers that.
   *
   * Newest first, and only the resource-capture files — this is not a general
   * directory listing of data/screenshots.
   */
  router.get('/:clanId/resources/debug-shots', requireClanAdmin, (req, res) => {
    const root = debugRunsRoot();
    try {
      if (!fs.existsSync(root)) {
        res.json({ runs: [], run: null, shots: [] });
        return;
      }
      // Newest run first. The directory name is the ISO start time with separators
      // swapped, so a plain string sort is chronological.
      const runs = fs.readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && DEBUG_RUN_DIR.test(e.name))
        .map((e) => e.name)
        .sort()
        .reverse();

      const requested = typeof req.query.run === 'string' ? req.query.run : '';
      const run = runs.includes(requested) ? requested : (runs[0] ?? null);
      if (!run) {
        res.json({ runs, run: null, shots: [] });
        return;
      }

      // Sorted by NAME, not mtime: the names carry the page order (p001, p002, …)
      // which is the order they need to be read in, and several frames from one
      // page share a timestamp to the second.
      const shots = fs.readdirSync(path.join(root, run))
        .filter((name) => DEBUG_SHOT_NAME.test(name))
        .sort()
        .map((name) => {
          const stat = fs.statSync(path.join(root, run, name));
          return { name, bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
        });
      res.json({ runs, run, shots, scpPath: `data/screenshots/resource-debug/${run}` });
    } catch (err) {
      res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  /** GET /:clanId/resources/debug-shots/:run/:name — stream one debug PNG. */
  router.get('/:clanId/resources/debug-shots/:run/:name', requireClanAdmin, (req, res) => {
    const run = String(req.params.run);
    const name = String(req.params.name);
    // Both segments are whitelisted by shape rather than sanitised: they are user
    // input used to read from disk, and neither pattern admits a dot (beyond the
    // extension) or a separator, so a crafted value cannot escape the run directory.
    if (!DEBUG_RUN_DIR.test(run) || !DEBUG_SHOT_NAME.test(name)) {
      res.status(400).json({ error: 'Not a resource-capture debug screenshot path' });
      return;
    }
    const filePath = path.join(debugRunsRoot(), run, name);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'That screenshot is no longer on disk' });
      return;
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(filePath).pipe(res);
  });


  /**
   * POST /:clanId/resources/collect — read this clan's Clan Capital history right now.
   *
   * The debugging entry point for automated collection, and the thing an operator
   * uses to prove a clan out before enabling the scheduled run. Superadmin-only:
   * it drives the shared browser session and hot-swaps it to this clan, which is
   * instance-wide behaviour rather than clan configuration.
   *
   * Deliberately bypasses the global feature flag and the once-a-day gate — see
   * ScanLoop.collectResourcesNow. Repeatable by design: the cursor makes a second
   * run inside the same minute a no-op rather than a duplicate.
   *
   * Body: { fullBackfill?: boolean, maxPages?: number }
   */
  router.post('/:clanId/resources/collect', requireClanAdmin, async (req, res) => {
    const clanId = req.parsedClanId!;
    if (!scanLoop) {
      res.status(503).json({ error: 'Scanner not available' });
      return;
    }
    if (!isResourceHistoryCalibrated()) {
      res.status(400).json({
        error: 'Automated collection is not calibrated yet. Outstanding: '
          + `${missingResourceHistoryTargets().join('; ')}. Open System → Scanner Calibration and `
          + 'complete Stages 5 and 6 (and the MAP button in Stage 1).',
      });
      return;
    }
    if (!getClanById(clanId)?.resourcesEnabled) {
      res.status(400).json({
        error: 'Resource tracking is turned off for this clan. Turn it on in the clan settings first.',
      });
      return;
    }

    const body = req.body ?? {};
    const fullBackfill = body.fullBackfill === true;
    const dryRun = body.dryRun === true;
    const rawMaxPages = Number(body.maxPages);
    const maxPages = Number.isFinite(rawMaxPages) && rawMaxPages > 0
      ? Math.min(150, Math.floor(rawMaxPages))
      : undefined;

    if (resourceCollectJob?.status === 'running') {
      res.status(409).json({
        error: 'A collection is already running. Watch its progress on this page, or wait for it '
          + 'to finish before starting another.',
      });
      return;
    }

    logAction(req.user!.id, 'resources.collect', { clanId, fullBackfill, dryRun, maxPages });

    resourceCollectJob = {
      status: 'running',
      clanId,
      startedAt: Date.now(),
      finishedAt: null,
      fullBackfill,
      dryRun,
      outcome: null,
      error: null,
    };

    // Deliberately not awaited: the response goes out now and the client polls
    // /collect/status. See the ResourceCollectJob comment for why a blocking
    // request cannot work here.
    void scanLoop.collectResourcesNow({ targetClanId: clanId, fullBackfill, dryRun, maxPages })
      .then((outcome) => {
        resourceCollectJob = {
          ...resourceCollectJob!,
          status: 'done',
          finishedAt: Date.now(),
          outcome,
        };
      })
      .catch((err) => {
        const message = String(err instanceof Error ? err.message : err);
        log.warn({ err }, 'resources-route: manual resource collection failed');
        resourceCollectJob = {
          ...resourceCollectJob!,
          status: 'error',
          finishedAt: Date.now(),
          error: message,
        };
      });

    res.json({ started: true, clanId, fullBackfill, dryRun });
  });

  /**
   * GET /:clanId/resources/collect/status — poll the manual collection started above.
   *
   * Reports the live progress line straight off the ScanLoop (the same text the
   * scan header shows) so the operator can watch pages being read rather than
   * staring at a spinner for several minutes.
   *
   * Clan-scoped: a job started for another clan is reported as idle here, so the
   * Resources page of clan A never shows clan B's capture.
   */
  router.get('/:clanId/resources/collect/status', requireClanAdmin, (req, res) => {
    const clanId = req.parsedClanId!;
    if (!resourceCollectJob || resourceCollectJob.clanId !== clanId) {
      res.json({ status: 'idle' });
      return;
    }
    const job = resourceCollectJob;
    const elapsedMs = (job.finishedAt ?? Date.now()) - job.startedAt;
    res.json({
      status: job.status,
      elapsedMs,
      fullBackfill: job.fullBackfill,
      dryRun: job.dryRun,
      progress: job.status === 'running' ? (scanLoop?.getProgressMessage() || '') : '',
      outcome: job.outcome,
      error: job.error,
    });
  });


  return router;
}
