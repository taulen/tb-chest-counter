"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.waitForSetupComplete = waitForSetupComplete;
exports.isSetupFlowActive = isSetupFlowActive;
exports.createSetupRouter = createSetupRouter;
const express_1 = require("express");
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const setup_wizard_js_1 = require("../../setup-wizard.js");
const index_js_1 = require("../../config/index.js");
const user_repo_js_1 = require("../../data/repositories/user-repo.js");
const parse_int_js_1 = require("../../utils/parse-int.js");
const auth_js_1 = require("../middleware/auth.js");
const backup_upload_js_1 = require("../backup-upload.js");
let setupCompletedInProcess = false;
let authSavedInProcess = false;
let _setupDoneResolve = null;
let _setupDoneReject = null;
/** Resolves once the operator has both completed the form AND saved a
 *  Total Battle session via the embedded login bridge. The boot-time
 *  awaiter in src/index.ts hangs on this promise; resolving it lets the
 *  process tear down the setup-mode server and start the normal one.
 *
 *  Calibration and member capture are deliberately NOT part of setup —
 *  they're guarded server-side everywhere a scan can be triggered, and
 *  the dashboard surfaces the next required step to the operator. */
function waitForSetupComplete() {
    return new Promise((resolve, reject) => {
        _setupDoneResolve = resolve;
        _setupDoneReject = reject;
    });
}
function hasAuthInStorageState(storageStatePath) {
    if (!fs_1.default.existsSync(storageStatePath))
        return false;
    const raw = fs_1.default.readFileSync(storageStatePath, 'utf8');
    if (!raw.trim())
        return false;
    const parsed = JSON.parse(raw);
    const cookies = parsed.cookies ?? [];
    const origins = parsed.origins ?? [];
    const hasTbCookie = cookies.some((c) => (c.domain ?? '').includes('totalbattle'));
    const hasTbOriginData = origins.some((o) => (o.origin ?? '').includes('totalbattle'));
    return hasTbCookie || hasTbOriginData;
}
function isGameAuthenticated() {
    try {
        // Setup operates on clan #1 (the seeded clan). The login bridge
        // writes here when the operator finishes the in-app sign-in.
        const targetPath = path_1.default.resolve('data', 'clans', '1', 'storage-state.json');
        return hasAuthInStorageState(targetPath);
    }
    catch {
        return false;
    }
}
/** True while the wizard owns the routing surface. The setup-mode
 *  server's middleware uses this to redirect random URLs back to
 *  /setup until the operator has both filled in the form and signed
 *  in to Total Battle. Once both are done, isSetupFlowActive() flips
 *  false and the main app takes over (with its own onboarding
 *  banners for calibrate / capture-members). */
function isSetupFlowActive() {
    if ((0, setup_wizard_js_1.needsSetup)())
        return true;
    if (!setupCompletedInProcess)
        return false;
    if (!isGameAuthenticated())
        return true;
    if (!authSavedInProcess)
        return true;
    return false;
}
function createSetupRouter() {
    const router = (0, express_1.Router)();
    router.get('/defaults', (_req, res) => {
        if (!(0, setup_wizard_js_1.needsSetup)() || setupCompletedInProcess) {
            return res.status(409).json({ error: 'Setup is already complete.' });
        }
        return res.json({
            defaults: {
                scanIntervalMinutes: setup_wizard_js_1.SETUP_DEFAULTS.scanInterval,
                webPort: setup_wizard_js_1.SETUP_DEFAULTS.webPort,
                dbPath: setup_wizard_js_1.SETUP_DEFAULTS.dbPath,
            },
        });
    });
    router.post('/complete', (req, res) => {
        if (!(0, setup_wizard_js_1.needsSetup)() || setupCompletedInProcess) {
            return res.status(409).json({ error: 'Setup is already complete.' });
        }
        try {
            const body = (req.body ?? {});
            const result = (0, setup_wizard_js_1.applySetupFromInput)({
                adminUsername: String(body.adminUsername ?? ''),
                adminPassword: String(body.adminPassword ?? ''),
                scanInterval: (0, parse_int_js_1.parseBoundedInt)(body.scanIntervalMinutes, setup_wizard_js_1.SETUP_DEFAULTS.scanInterval, { min: 1, max: 1440 }),
                webPort: (0, parse_int_js_1.parseBoundedInt)(body.webPort, setup_wizard_js_1.SETUP_DEFAULTS.webPort, { min: 1, max: 65535 }),
                dbPath: String(body.dbPath ?? setup_wizard_js_1.SETUP_DEFAULTS.dbPath),
            });
            // Reset config cache so next load reads the fresh .env file
            (0, index_js_1.resetConfig)();
            setupCompletedInProcess = true;
            authSavedInProcess = false;
            // Auto-issue a session cookie for the freshly-created superadmin so
            // the embedded login bridge on the next setup screen can hit the
            // admin login-session endpoints without forcing a separate sign-in.
            const token = (0, user_repo_js_1.createSession)(result.user.id);
            res.cookie(auth_js_1.SESSION_COOKIE_NAME, token, (0, auth_js_1.sessionCookieOptions)(req));
            return res.json({
                ok: true,
                adminUsername: result.adminUsername,
                envPath: result.envPath,
            });
        }
        catch (err) {
            return res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
        }
    });
    // Restore uploads stage in their own folder under the OS temp dir, not under
    // data/: on a first run the data volume may not exist yet, and the uploader
    // sweeps stale `restore-*` entries of whatever folder it is given.
    const setupUploadDir = path_1.default.join(os_1.default.tmpdir(), 'tb-setup-restore');
    const SETUP_UPLOAD_OWNER = 'setup';
    const setupClosed = () => !(0, setup_wizard_js_1.needsSetup)() || setupCompletedInProcess;
    /**
     * POST /restore-backup/start { fileName }  → { uploadId, chunkBytes }
     * PUT  /restore-backup/:uploadId/:index     raw bytes, in order
     * POST /restore-backup { uploadId }
     *
     * The other way to finish setup: adopt an existing deployment's database
     * instead of creating a superadmin. Every account, clan, chest record and
     * admin-tuned setting comes back with it, which is the whole reason an
     * operator would pick this path over the form.
     *
     * Unauthenticated, like the rest of the setup router — and that is not a new
     * hole: the form beside it already mints a superadmin on an install that has
     * none. Both are gated by needsSetup(), so the window closes for good the
     * moment either one finishes. What it must NOT do is issue a session: the
     * accounts arrive from the backup, so the operator signs in at /login with
     * the credentials they already had.
     *
     * The file arrives in raw slices, through the same uploader as the in-app
     * restore (see backup-upload.ts), so a backup this flow accepts is one the
     * running app's restore accepts too — otherwise an operator could seed an
     * install they can never re-restore.
     *
     * Validation order matters. Everything that can reject the upload happens
     * against a temp file, before anything touches the destination — a restore
     * that fails must leave a first-run install still able to run setup.
     */
    router.post('/restore-backup/start', (req, res) => {
        if (setupClosed())
            return res.status(409).json({ error: 'Setup is already complete.' });
        try {
            return res.json((0, backup_upload_js_1.startBackupUpload)(String(req.body?.fileName ?? ''), SETUP_UPLOAD_OWNER, setupUploadDir));
        }
        catch (err) {
            return (0, backup_upload_js_1.sendBackupUploadError)(res, err);
        }
    });
    router.put('/restore-backup/:uploadId/:index', async (req, res) => {
        if (setupClosed())
            return res.status(409).json({ error: 'Setup is already complete.' });
        try {
            const bytes = await (0, backup_upload_js_1.appendBackupChunk)(String(req.params.uploadId), SETUP_UPLOAD_OWNER, Number(req.params.index), req);
            return res.json({ ok: true, bytes });
        }
        catch (err) {
            return (0, backup_upload_js_1.sendBackupUploadError)(res, err);
        }
    });
    router.post('/restore-backup', async (req, res) => {
        if (setupClosed())
            return res.status(409).json({ error: 'Setup is already complete.' });
        let staged;
        try {
            staged = await (0, backup_upload_js_1.finishBackupUpload)(String(req.body?.uploadId ?? ''), SETUP_UPLOAD_OWNER);
        }
        catch (err) {
            return (0, backup_upload_js_1.sendBackupUploadError)(res, err);
        }
        try {
            // The upload is async; another request may have finished setup meanwhile.
            if (setupClosed())
                return res.status(409).json({ error: 'Setup is already complete.' });
            const tempPath = staged.dbPath;
            // Read the accounts BEFORE adopting the file. A backup with no
            // superadmin produces an install nobody can administer, and by then the
            // setup window has closed — the operator would have to delete the volume
            // and start over. Cheaper to refuse it here while they still have the
            // form.
            const probe = new better_sqlite3_1.default(tempPath, { readonly: true, fileMustExist: true });
            let superadmins = 0;
            try {
                probe.prepare('PRAGMA schema_version').get();
                const hasUsers = probe
                    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'")
                    .get();
                if (!hasUsers) {
                    return res.status(400).json({
                        error: 'That SQLite file has no users table — it does not look like a TB Chest Counter backup.',
                    });
                }
                const row = probe
                    .prepare("SELECT COUNT(*) as c FROM users WHERE role = 'superadmin'")
                    .get();
                superadmins = row.c;
            }
            finally {
                probe.close();
            }
            if (superadmins === 0) {
                return res.status(400).json({
                    error: 'That backup has no superadmin account, so nobody could sign in to the restored install.',
                });
            }
            const result = (0, setup_wizard_js_1.applyRestoredDatabase)({ sourceDbPath: tempPath });
            // Config cache still holds the pre-setup view; the env file just landed.
            (0, index_js_1.resetConfig)();
            // Setup is over. Unlike the form path this does NOT set
            // setupCompletedInProcess: with app.env written, needsSetup() is false
            // and isSetupFlowActive() already reports false, so leaving the flag
            // alone keeps the Total Battle step (which needs an admin session we
            // deliberately did not issue) out of the way. The operator signs in and
            // runs the bridge per clan from the Clans page.
            _setupDoneResolve?.();
            _setupDoneResolve = null;
            _setupDoneReject = null;
            return res.json({
                ok: true,
                restoredFrom: staged.fileName,
                bytes: staged.bytes,
                users: result.users,
                superadmins: result.superadmins,
            });
        }
        catch (err) {
            return res.status(400).json({ error: `Restore failed: ${String(err instanceof Error ? err.message : err)}` });
        }
        finally {
            try {
                staged.cleanup();
            }
            catch { /* temp dir cleanup is best effort */ }
        }
    });
    router.get('/auth-status', (_req, res) => {
        if (setupCompletedInProcess) {
            const authenticated = isGameAuthenticated();
            return res.json({ authenticated });
        }
        return res.status(409).json({ error: 'Setup flow not active.' });
    });
    /**
     * Mark the auth step done after the login bridge has saved the
     * storage state. The setup page calls this once it sees the bridge
     * write succeed; with that, setup is over — the awaiter in
     * src/index.ts resolves and the container transitions to normal
     * mode. Calibration and the first member-capture / chest scan
     * happen later from the main app (gated server-side so nothing can
     * scan until both are done).
     */
    router.post('/auth-saved', (_req, res) => {
        if (!setupCompletedInProcess) {
            return res.status(409).json({ error: 'Setup flow not active.' });
        }
        if (!isGameAuthenticated()) {
            return res.status(400).json({
                error: 'No Total Battle auth detected in the saved storage state. Finish the in-game sign-in and try again.',
            });
        }
        authSavedInProcess = true;
        // Resolve the awaiter so the container can swap setup-mode →
        // normal-mode. Done before responding so a slow client doesn't
        // delay the transition; the response is informational either way.
        _setupDoneResolve?.();
        _setupDoneResolve = null;
        _setupDoneReject = null;
        return res.json({ ok: true, finished: true });
    });
    return router;
}
//# sourceMappingURL=setup.js.map