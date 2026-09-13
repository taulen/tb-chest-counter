import fs from 'fs';
import type { Router } from 'express';
import { requireClanAdmin } from '../../middleware/auth.js';
import { getClanById } from '../../../data/repositories/clan-repo.js';
import { clanStorageStatePath, clanBrowserProfileDir } from '../../../config/clan-paths.js';
import { launchBrowser, closeBrowser } from '../../../browser/launcher.js';
import { ScanLoop } from '../../../scheduler/loop.js';
import { createVisionProvider } from '../../../vision/factory.js';
import { getMemberCount } from '../../../data/repositories/member-repo.js';
import { needsMemberCapture } from '../../../browser/member-capture.js';
import { isFullyCalibrated } from '../../../config/calibration.js';
import { loadConfig } from '../../../config/index.js';
import { childLogger } from '../../../utils/logger.js';
import { createClanSubRouter } from './_shared.js';

const log = childLogger('clans-route');

export type OnboardStatus =
  | 'idle'
  | 'capturing-members'
  | 'awaiting-review'
  | 'first-scan'
  | 'done'
  | 'failed';

export interface OnboardProgress {
  status: OnboardStatus;
  message: string;
  error: string | null;
  chestsFound: number | null;
  membersCaptured: number | null;
  updatedAt: string;
}

/**
 * Per-clan progress tracker shared across the crud router (which needs
 * to drop entries when a clan is deleted) and the onboard router (which
 * reads/writes them as the flow runs). Hidden behind an interface so
 * tests / future call sites can't reach into the underlying Map and
 * forget to prune.
 */
export interface OnboardState {
  clear(clanId: number): void;
  get(clanId: number): OnboardProgress | undefined;
  set(clanId: number, patch: Partial<OnboardProgress>): void;
}

// Terminal entries (done / failed / idle) age out after 24h so the Map
// doesn't grow unbounded over the life of the process. Active flows
// never expire — the frontend polls them so they get touched
// continuously while in progress.
const ONBOARD_TTL_MS = 24 * 60 * 60 * 1000;

export function createOnboardState(): OnboardState {
  const map = new Map<number, OnboardProgress>();

  function prune(): void {
    const cutoff = Date.now() - ONBOARD_TTL_MS;
    for (const [clanId, entry] of map) {
      if (entry.status !== 'done' && entry.status !== 'failed' && entry.status !== 'idle') continue;
      if (Date.parse(entry.updatedAt) < cutoff) {
        map.delete(clanId);
      }
    }
  }

  return {
    clear(clanId) {
      map.delete(clanId);
    },
    get(clanId) {
      return map.get(clanId);
    },
    set(clanId, patch) {
      prune();
      const prev: OnboardProgress = map.get(clanId) ?? {
        status: 'idle',
        message: '',
        error: null,
        chestsFound: null,
        membersCaptured: null,
        updatedAt: new Date().toISOString(),
      };
      map.set(clanId, { ...prev, ...patch, updatedAt: new Date().toISOString() });
    },
  };
}

/**
 * Add-Clan onboarding routes. Mirrors the per-clan steps in the initial
 * setup wizard: after a superadmin signs in to a new clan via the login
 * bridge and saves calibration, the frontend kicks off member capture
 * and the first scan via these endpoints. Progress is tracked per-clan
 * and polled.
 */
export function createOnboardRouter(state: OnboardState): Router {
  const router = createClanSubRouter();

  router.get('/:clanId/onboard/status', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    const status = state.get(id) ?? {
      status: 'idle' as OnboardStatus,
      message: '',
      error: null,
      chestsFound: null,
      membersCaptured: null,
      updatedAt: new Date().toISOString(),
    };
    res.json(status);
  });

  /**
   * Run member capture for a clan. Launches a one-off headless browser
   * with that clan's storage state, walks Members tab, OCRs the names,
   * inserts into members table. Returns immediately; the frontend
   * polls /onboard/status. Refuses if no auth has been saved yet.
   */
  router.post('/:clanId/onboard/capture-members', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    const clan = getClanById(id);
    if (!clan) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }
    const storageState = clanStorageStatePath(id);
    if (!fs.existsSync(storageState)) {
      res.status(409).json({ error: 'Sign in to this clan via the login bridge before capturing members.' });
      return;
    }
    // Calibration must come first — member capture clicks the Clan
    // button, the Members sidebar entry, and uses the names-column
    // crop. All three are stage-1/2/3 wizard outputs and the OCR path
    // throws CalibrationMissingError if any are still 0.
    if (!isFullyCalibrated()) {
      res.status(409).json({
        error: 'Calibrate the scanner before capturing members. Open Admin → Scanner Mode → Calibrate and complete every stage.',
        nextStep: 'calibrate',
      });
      return;
    }
    const current = state.get(id);
    if (current && (current.status === 'capturing-members' || current.status === 'first-scan')) {
      res.status(409).json({ error: 'Onboarding is already running for this clan.' });
      return;
    }

    state.set(id, { status: 'capturing-members', message: 'Capturing member list...', error: null });

    void (async () => {
      try {
        const config = loadConfig();
        const session = await launchBrowser({ ...config, headless: true }, {
          storageStatePath: storageState,
          userDataDir: clanBrowserProfileDir(id),
        });
        const vision = createVisionProvider();
        await vision.initialize(config);
        const scanLoop = new ScanLoop(config, session, vision, undefined, {
          pauseAfterMemberCapture: false,
          stopAfterMemberCapture: true,
          onProgress: (update) => {
            if (update.phase === 'member-capture') {
              state.set(id, { message: update.message });
            }
          },
        });
        scanLoop.setActiveClan(id);
        await scanLoop.triggerManualScan();
        await closeBrowser(session);
        const membersCaptured = getMemberCount(id);
        state.set(id, {
          status: 'awaiting-review',
          message: `Captured ${membersCaptured} member(s). Review names and continue.`,
          membersCaptured,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, clanId: id }, 'Member capture failed for clan');
        state.set(id, { status: 'failed', error: message, message: 'Member capture failed.' });
      }
    })();

    res.json({ ok: true, started: true });
  });

  /**
   * Run the first chest scan for a newly-onboarded clan. Called after
   * the superadmin has reviewed the captured member list. Returns
   * immediately; the frontend polls /onboard/status.
   */
  router.post('/:clanId/onboard/first-scan', requireClanAdmin, (req, res) => {
    const id = req.parsedClanId!;
    if (!getClanById(id)) {
      res.status(404).json({ error: 'Clan not found' });
      return;
    }
    const storageState = clanStorageStatePath(id);
    if (!fs.existsSync(storageState)) {
      res.status(409).json({ error: 'Sign in to this clan via the login bridge first.' });
      return;
    }
    if (!isFullyCalibrated()) {
      res.status(409).json({
        error: 'Calibrate the scanner before running the first scan. Open Admin → Scanner Mode → Calibrate.',
        nextStep: 'calibrate',
      });
      return;
    }
    if (needsMemberCapture(id)) {
      res.status(409).json({
        error: 'Capture the clan member list before running a scan.',
        nextStep: 'capture-members',
      });
      return;
    }
    const current = state.get(id);
    if (current?.status === 'first-scan' || current?.status === 'capturing-members') {
      res.status(409).json({ error: 'Onboarding is already running for this clan.' });
      return;
    }

    state.set(id, { status: 'first-scan', message: 'Running first chest scan...', error: null });

    void (async () => {
      try {
        const config = loadConfig();
        const session = await launchBrowser({ ...config, headless: true }, {
          storageStatePath: storageState,
          userDataDir: clanBrowserProfileDir(id),
        });
        const vision = createVisionProvider();
        await vision.initialize(config);
        const scanLoop = new ScanLoop(config, session, vision, undefined, {
          pauseAfterMemberCapture: false,
          skipMemberCapture: true,
          onProgress: (update) => {
            state.set(id, { message: update.message });
          },
        });
        scanLoop.setActiveClan(id);
        const result = await scanLoop.triggerManualScan();
        await closeBrowser(session);
        state.set(id, {
          status: 'done',
          message: `First scan complete. Recorded ${result.newChests} chest(s).`,
          chestsFound: result.newChests,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, clanId: id }, 'First scan failed for clan');
        state.set(id, { status: 'failed', error: message, message: 'First scan failed.' });
      }
    })();

    res.json({ ok: true, started: true });
  });

  return router;
}
