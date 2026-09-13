import { Router } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import Database from 'better-sqlite3';
import {
  applyRestoredDatabase,
  applySetupFromInput,
  needsSetup,
  SETUP_DEFAULTS,
} from '../../setup-wizard.js';
import { resetConfig } from '../../config/index.js';
import { createSession } from '../../data/repositories/user-repo.js';
import { parseBoundedInt } from '../../utils/parse-int.js';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '../middleware/auth.js';

type SetupBody = {
  adminUsername?: unknown;
  adminPassword?: unknown;
  scanIntervalMinutes?: unknown;
  webPort?: unknown;
  dbPath?: unknown;
};

let setupCompletedInProcess = false;
let authSavedInProcess = false;

let _setupDoneResolve: (() => void) | null = null;
let _setupDoneReject: ((err: Error) => void) | null = null;

/** Resolves once the operator has both completed the form AND saved a
 *  Total Battle session via the embedded login bridge. The boot-time
 *  awaiter in src/index.ts hangs on this promise; resolving it lets the
 *  process tear down the setup-mode server and start the normal one.
 *
 *  Calibration and member capture are deliberately NOT part of setup —
 *  they're guarded server-side everywhere a scan can be triggered, and
 *  the dashboard surfaces the next required step to the operator. */
export function waitForSetupComplete(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    _setupDoneResolve = resolve;
    _setupDoneReject = reject;
  });
}

function hasAuthInStorageState(storageStatePath: string): boolean {
  if (!fs.existsSync(storageStatePath)) return false;
  const raw = fs.readFileSync(storageStatePath, 'utf8');
  if (!raw.trim()) return false;

  const parsed = JSON.parse(raw) as {
    cookies?: Array<{ domain?: string; name?: string; value?: string }>;
    origins?: Array<{ origin?: string; localStorage?: Array<{ name?: string; value?: string }> }>;
  };

  const cookies = parsed.cookies ?? [];
  const origins = parsed.origins ?? [];

  const hasTbCookie = cookies.some((c) => (c.domain ?? '').includes('totalbattle'));
  const hasTbOriginData = origins.some((o) => (o.origin ?? '').includes('totalbattle'));

  return hasTbCookie || hasTbOriginData;
}

function isGameAuthenticated(): boolean {
  try {
    // Setup operates on clan #1 (the seeded clan). The login bridge
    // writes here when the operator finishes the in-app sign-in.
    const targetPath = path.resolve('data', 'clans', '1', 'storage-state.json');
    return hasAuthInStorageState(targetPath);
  } catch {
    return false;
  }
}

/** True while the wizard owns the routing surface. The setup-mode
 *  server's middleware uses this to redirect random URLs back to
 *  /setup until the operator has both filled in the form and signed
 *  in to Total Battle. Once both are done, isSetupFlowActive() flips
 *  false and the main app takes over (with its own onboarding
 *  banners for calibrate / capture-members). */
export function isSetupFlowActive(): boolean {
  if (needsSetup()) return true;
  if (!setupCompletedInProcess) return false;
  if (!isGameAuthenticated()) return true;
  if (!authSavedInProcess) return true;
  return false;
}

export function createSetupRouter(): Router {
  const router = Router();

  router.get('/defaults', (_req, res) => {
    if (!needsSetup() || setupCompletedInProcess) {
      return res.status(409).json({ error: 'Setup is already complete.' });
    }

    return res.json({
      defaults: {
        scanIntervalMinutes: SETUP_DEFAULTS.scanInterval,
        webPort: SETUP_DEFAULTS.webPort,
        dbPath: SETUP_DEFAULTS.dbPath,
      },
    });
  });

  router.post('/complete', (req, res) => {
    if (!needsSetup() || setupCompletedInProcess) {
      return res.status(409).json({ error: 'Setup is already complete.' });
    }

    try {
      const body = (req.body ?? {}) as SetupBody;

      const result = applySetupFromInput({
        adminUsername: String(body.adminUsername ?? ''),
        adminPassword: String(body.adminPassword ?? ''),
        scanInterval: parseBoundedInt(body.scanIntervalMinutes, SETUP_DEFAULTS.scanInterval, { min: 1, max: 1440 }),
        webPort: parseBoundedInt(body.webPort, SETUP_DEFAULTS.webPort, { min: 1, max: 65535 }),
        dbPath: String(body.dbPath ?? SETUP_DEFAULTS.dbPath),
      });

      // Reset config cache so next load reads the fresh .env file
      resetConfig();
      setupCompletedInProcess = true;
      authSavedInProcess = false;

      // Auto-issue a session cookie for the freshly-created superadmin so
      // the embedded login bridge on the next setup screen can hit the
      // admin login-session endpoints without forcing a separate sign-in.
      const token = createSession(result.user.id);
      res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions(req));

      return res.json({
        ok: true,
        adminUsername: result.adminUsername,
        envPath: result.envPath,
      });
    } catch (err) {
      return res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  /**
   * POST /restore-backup { fileName, contentBase64 }
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
   * Validation order matters. Everything that can reject the upload happens
   * against a temp file, before anything touches the destination — a restore
   * that fails must leave a first-run install still able to run setup.
   */
  router.post('/restore-backup', (req, res) => {
    if (!needsSetup() || setupCompletedInProcess) {
      return res.status(409).json({ error: 'Setup is already complete.' });
    }

    let tempPath = '';
    try {
      const body = (req.body ?? {}) as { fileName?: unknown; contentBase64?: unknown };
      const fileName = String(body.fileName ?? '').trim();
      const contentBase64 = String(body.contentBase64 ?? '').trim();
      if (!fileName) return res.status(400).json({ error: 'fileName is required' });
      if (!contentBase64) return res.status(400).json({ error: 'contentBase64 is required' });

      const lowerName = fileName.toLowerCase();
      if (!lowerName.endsWith('.db') && !lowerName.endsWith('.db.gz') && !lowerName.endsWith('.gz')) {
        return res.status(400).json({ error: 'Backup file must be a .db or .db.gz file' });
      }

      // Same size ceilings as /api/import/backup-db, deliberately: a backup
      // this flow accepts must be one the running app's restore would accept
      // too, or an operator could seed an install they can never re-restore.
      let buffer = Buffer.from(contentBase64, 'base64');
      if (buffer.length < 16) {
        return res.status(400).json({ error: 'Backup file is too small or invalid' });
      }
      if (buffer.length > 100 * 1024 * 1024) {
        return res.status(400).json({ error: 'Backup file too large (max 100MB)' });
      }
      if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
        try {
          buffer = zlib.gunzipSync(buffer);
        } catch (gzErr) {
          return res.status(400).json({ error: `Failed to decompress gzip backup: ${String(gzErr)}` });
        }
        if (buffer.length > 200 * 1024 * 1024) {
          return res.status(400).json({ error: 'Decompressed backup too large (max 200MB)' });
        }
      }
      if (!buffer.subarray(0, 16).toString('utf8').startsWith('SQLite format 3')) {
        return res.status(400).json({ error: 'File does not appear to be a valid SQLite backup' });
      }

      // Staged in the OS temp dir, not under data/: on a first run the data
      // volume may not exist yet, and this file is worthless the moment the
      // copy below succeeds.
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-setup-restore-'));
      tempPath = path.join(tempDir, 'restore.db');
      fs.writeFileSync(tempPath, buffer);

      // Read the accounts BEFORE adopting the file. A backup with no
      // superadmin produces an install nobody can administer, and by then the
      // setup window has closed — the operator would have to delete the volume
      // and start over. Cheaper to refuse it here while they still have the
      // form.
      const probe = new Database(tempPath, { readonly: true, fileMustExist: true });
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
          .get() as { c: number };
        superadmins = row.c;
      } finally {
        probe.close();
      }
      if (superadmins === 0) {
        return res.status(400).json({
          error: 'That backup has no superadmin account, so nobody could sign in to the restored install.',
        });
      }

      const result = applyRestoredDatabase({ sourceDbPath: tempPath });

      // Config cache still holds the pre-setup view; the env file just landed.
      resetConfig();

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
        restoredFrom: fileName,
        bytes: buffer.length,
        users: result.users,
        superadmins: result.superadmins,
      });
    } catch (err) {
      return res.status(400).json({ error: `Restore failed: ${String(err instanceof Error ? err.message : err)}` });
    } finally {
      if (tempPath && fs.existsSync(tempPath)) {
        try {
          fs.rmSync(path.dirname(tempPath), { recursive: true, force: true });
        } catch { /* temp dir cleanup is best effort */ }
      }
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
