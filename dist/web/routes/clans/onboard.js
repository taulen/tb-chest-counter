"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOnboardState = createOnboardState;
exports.createOnboardRouter = createOnboardRouter;
const fs_1 = __importDefault(require("fs"));
const auth_js_1 = require("../../middleware/auth.js");
const clan_repo_js_1 = require("../../../data/repositories/clan-repo.js");
const clan_paths_js_1 = require("../../../config/clan-paths.js");
const launcher_js_1 = require("../../../browser/launcher.js");
const loop_js_1 = require("../../../scheduler/loop.js");
const factory_js_1 = require("../../../vision/factory.js");
const member_repo_js_1 = require("../../../data/repositories/member-repo.js");
const member_capture_js_1 = require("../../../browser/member-capture.js");
const calibration_js_1 = require("../../../config/calibration.js");
const index_js_1 = require("../../../config/index.js");
const logger_js_1 = require("../../../utils/logger.js");
const _shared_js_1 = require("./_shared.js");
const log = (0, logger_js_1.childLogger)('clans-route');
// Terminal entries (done / failed / idle) age out after 24h so the Map
// doesn't grow unbounded over the life of the process. Active flows
// never expire — the frontend polls them so they get touched
// continuously while in progress.
const ONBOARD_TTL_MS = 24 * 60 * 60 * 1000;
function createOnboardState() {
    const map = new Map();
    function prune() {
        const cutoff = Date.now() - ONBOARD_TTL_MS;
        for (const [clanId, entry] of map) {
            if (entry.status !== 'done' && entry.status !== 'failed' && entry.status !== 'idle')
                continue;
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
            const prev = map.get(clanId) ?? {
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
function createOnboardRouter(state) {
    const router = (0, _shared_js_1.createClanSubRouter)();
    router.get('/:clanId/onboard/status', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        const status = state.get(id) ?? {
            status: 'idle',
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
    router.post('/:clanId/onboard/capture-members', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        const clan = (0, clan_repo_js_1.getClanById)(id);
        if (!clan) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        const storageState = (0, clan_paths_js_1.clanStorageStatePath)(id);
        if (!fs_1.default.existsSync(storageState)) {
            res.status(409).json({ error: 'Sign in to this clan via the login bridge before capturing members.' });
            return;
        }
        // Calibration must come first — member capture clicks the Clan
        // button, the Members sidebar entry, and uses the names-column
        // crop. All three are stage-1/2/3 wizard outputs and the OCR path
        // throws CalibrationMissingError if any are still 0.
        if (!(0, calibration_js_1.isFullyCalibrated)()) {
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
                const config = (0, index_js_1.loadConfig)();
                const session = await (0, launcher_js_1.launchBrowser)({ ...config, headless: true }, {
                    storageStatePath: storageState,
                    userDataDir: (0, clan_paths_js_1.clanBrowserProfileDir)(id),
                });
                const vision = (0, factory_js_1.createVisionProvider)();
                await vision.initialize(config);
                const scanLoop = new loop_js_1.ScanLoop(config, session, vision, undefined, {
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
                await (0, launcher_js_1.closeBrowser)(session);
                const membersCaptured = (0, member_repo_js_1.getMemberCount)(id);
                state.set(id, {
                    status: 'awaiting-review',
                    message: `Captured ${membersCaptured} member(s). Review names and continue.`,
                    membersCaptured,
                });
            }
            catch (err) {
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
    router.post('/:clanId/onboard/first-scan', auth_js_1.requireClanAdmin, (req, res) => {
        const id = req.parsedClanId;
        if (!(0, clan_repo_js_1.getClanById)(id)) {
            res.status(404).json({ error: 'Clan not found' });
            return;
        }
        const storageState = (0, clan_paths_js_1.clanStorageStatePath)(id);
        if (!fs_1.default.existsSync(storageState)) {
            res.status(409).json({ error: 'Sign in to this clan via the login bridge first.' });
            return;
        }
        if (!(0, calibration_js_1.isFullyCalibrated)()) {
            res.status(409).json({
                error: 'Calibrate the scanner before running the first scan. Open Admin → Scanner Mode → Calibrate.',
                nextStep: 'calibrate',
            });
            return;
        }
        if ((0, member_capture_js_1.needsMemberCapture)(id)) {
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
                const config = (0, index_js_1.loadConfig)();
                const session = await (0, launcher_js_1.launchBrowser)({ ...config, headless: true }, {
                    storageStatePath: storageState,
                    userDataDir: (0, clan_paths_js_1.clanBrowserProfileDir)(id),
                });
                const vision = (0, factory_js_1.createVisionProvider)();
                await vision.initialize(config);
                const scanLoop = new loop_js_1.ScanLoop(config, session, vision, undefined, {
                    pauseAfterMemberCapture: false,
                    skipMemberCapture: true,
                    onProgress: (update) => {
                        state.set(id, { message: update.message });
                    },
                });
                scanLoop.setActiveClan(id);
                const result = await scanLoop.triggerManualScan();
                await (0, launcher_js_1.closeBrowser)(session);
                state.set(id, {
                    status: 'done',
                    message: `First scan complete. Recorded ${result.newChests} chest(s).`,
                    chestsFound: result.newChests,
                });
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                log.error({ err, clanId: id }, 'First scan failed for clan');
                state.set(id, { status: 'failed', error: message, message: 'First scan failed.' });
            }
        })();
        res.json({ ok: true, started: true });
    });
    return router;
}
//# sourceMappingURL=onboard.js.map