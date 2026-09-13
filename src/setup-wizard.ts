import fs from 'fs';
import path from 'path';
import { closeDb, initDatabase } from './data/database.js';
import {
  authenticate,
  createUser,
  superadminCount,
  userCount,
  validatePasswordPolicy,
  validateUsernamePolicy,
  normalizeUsername,
  type User,
} from './data/repositories/user-repo.js';

// The interactive CLI wizard (formerly `runSetupWizard`) was retired in
// favour of the web-based `/setup` flow handled by `src/web/routes/setup.ts`.
// The helpers below are still used by that web path (and by
// `src/config/*` for default values), which is why they remain
// in this module rather than moving to the web route file.

export interface SetupAnswers {
  adminUsername: string;
  adminPassword: string;
  scanInterval: number;
  webPort: number;
  dbPath: string;
}

export const SETUP_DEFAULTS = {
  scanInterval: 120,
  webPort: 3000,
  dbPath: './data/tb-chests.db',
} as const;

function getPersistentEnvPath(): string {
  const configured = process.env.APP_CONFIG_PATH?.trim();
  return configured ? path.resolve(configured) : path.resolve('data', 'app.env');
}

function getLegacyEnvPath(): string {
  return path.resolve('.env');
}

function getDefaultDbPath(): string {
  return path.resolve(process.env.DB_PATH?.trim() || SETUP_DEFAULTS.dbPath);
}

function buildEnvLines(answers: SetupAnswers): string[] {
  return [
    '# TB Chest Counter Configuration',
    `# Generated on ${new Date().toISOString()}`,
    '',
    '# Scan settings (game URL is hardcoded to totalbattle.com)',
    `SCAN_INTERVAL_MS=${answers.scanInterval * 60 * 1000}`,
    'HEADLESS=true',
    '',
    '# Web Dashboard',
    'WEB_ENABLED=true',
    `WEB_PORT=${answers.webPort}`,
    '',
    '# Logging',
    'LOG_LEVEL=info',
    '',
    '# Storage',
    `DB_PATH=${answers.dbPath}`,
    'STORAGE_STATE_PATH=./data/auth/storage-state.json',
    'SCREENSHOT_RETENTION_DAYS=3',
  ];
}

/**
 * Write the setup env files (persistent + legacy) without touching the
 * database or the user table. Shared by the two ways setup can finish: the
 * normal form, which then creates a superadmin, and a restore, which inherits
 * every account from the backup instead.
 */
function writeSetupEnv(answers: SetupAnswers): string {
  const envPath = getPersistentEnvPath();
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  const envLines = buildEnvLines(answers);
  fs.writeFileSync(envPath, envLines.join('\n') + '\n', { mode: 0o600 });

  // Backward compatibility for local/dev flows that still expect a root .env file.
  fs.writeFileSync(getLegacyEnvPath(), envLines.join('\n') + '\n', { mode: 0o600 });
  return envPath;
}

/**
 * Finish setup from a restored database file instead of a new superadmin.
 *
 * `sourceDbPath` is a validated SQLite file (the caller has already checked the
 * header and that it carries a usable account) that gets copied into place as
 * the live DB. initDatabase then migrates it forward, which is what lets a
 * backup from an older schema be restored into a current image.
 *
 * The user table is deliberately NOT touched: inheriting the operators —
 * superadmins included — is the entire point of restoring. That also means the
 * post-restore login uses the OLD credentials, so this never issues a session
 * the way the form path does; the wizard hands the operator to /login.
 *
 * Anything already at the destination is moved aside rather than overwritten.
 * In a genuine first-run there is nothing there (needsSetup() gates on exactly
 * that), so this only fires if someone re-ran a restore inside one setup
 * session — precisely the case where silently discarding the previous file
 * would be unrecoverable.
 */
export function applyRestoredDatabase(input: {
  sourceDbPath: string;
  scanInterval?: number;
  webPort?: number;
  dbPath?: string;
}): { envPath: string; dbPath: string; users: number; superadmins: number; displacedDb: string | null } {
  const dbPath = path.resolve(input.dbPath?.trim() || getDefaultDbPath());
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  let displacedDb: string | null = null;
  if (fs.existsSync(dbPath)) {
    displacedDb = `${dbPath}.replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(dbPath, displacedDb);
  }

  try {
    // initDatabase hands back the cached handle if one is already open, so an
    // earlier open in this process would leave every later query pointed at
    // the file we are about to replace. Nothing in setup mode should have
    // opened one (needsSetup() means there is no DB yet), which is exactly why
    // this has to be unconditional rather than conditional on a flag.
    closeDb();
    fs.copyFileSync(input.sourceDbPath, dbPath);
    initDatabase(dbPath);

    const users = userCount();
    if (users === 0) {
      // Unreachable via the route (it checks the temp file first), but a DB with
      // no accounts is an install nobody can sign in to — never leave one live.
      throw new Error('Restored database has no user accounts');
    }
    const superadmins = superadminCount();

    const envPath = writeSetupEnv({
      adminUsername: '',
      adminPassword: '',
      scanInterval: input.scanInterval ?? SETUP_DEFAULTS.scanInterval,
      webPort: input.webPort ?? SETUP_DEFAULTS.webPort,
      dbPath,
    });

    return { envPath, dbPath, users, superadmins, displacedDb };
  } catch (err) {
    // Put back whatever we moved aside so a failed restore leaves the install
    // exactly as it was found.
    try {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      if (displacedDb && fs.existsSync(displacedDb)) fs.renameSync(displacedDb, dbPath);
    } catch { /* best effort */ }
    throw err;
  }
}

export function applySetupFromInput(input: SetupAnswers): { envPath: string; adminUsername: string; user: User } {
  const normalizedUsername = normalizeUsername(input.adminUsername);
  const usernameCheck = validateUsernamePolicy(normalizedUsername);
  if (!usernameCheck.valid) {
    throw new Error(usernameCheck.message || 'Invalid admin username');
  }

  const passwordCheck = validatePasswordPolicy(input.adminPassword);
  if (!passwordCheck.valid) {
    throw new Error(passwordCheck.message || 'Invalid admin password');
  }

  if (!Number.isInteger(input.scanInterval) || input.scanInterval < 1 || input.scanInterval > 1440) {
    throw new Error('Scan interval must be between 1 and 1440 minutes');
  }

  if (!Number.isInteger(input.webPort) || input.webPort < 1 || input.webPort > 65535) {
    throw new Error('Web port must be between 1 and 65535');
  }

  if (!input.dbPath || !input.dbPath.trim()) {
    throw new Error('Database path is required');
  }

  const envPath = writeSetupEnv({ ...input, adminUsername: normalizedUsername });

  initDatabase(input.dbPath);
  let user: User | null = null;
  if (userCount() === 0) {
    user = createUser(normalizedUsername, input.adminPassword, 'superadmin');
  } else {
    user = authenticate(normalizedUsername, input.adminPassword);
  }
  if (!user) {
    throw new Error('Could not resolve superadmin account after setup');
  }

  return { envPath, adminUsername: normalizedUsername, user };
}

export function needsSetup(): boolean {
  const persistentEnvPath = getPersistentEnvPath();
  const legacyEnvPath = getLegacyEnvPath();
  const dbPath = getDefaultDbPath();

  if (fs.existsSync(persistentEnvPath) || fs.existsSync(legacyEnvPath)) {
    return false;
  }

  // In Docker, config may come from compose env vars while the durable setup state
  // is the existing database on /app/data. If that DB already exists, do not force
  // setup again just because the container root filesystem was recreated.
  return !fs.existsSync(dbPath);
}
