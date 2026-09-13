"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SETUP_DEFAULTS = void 0;
exports.applyRestoredDatabase = applyRestoredDatabase;
exports.applySetupFromInput = applySetupFromInput;
exports.needsSetup = needsSetup;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const database_js_1 = require("./data/database.js");
const user_repo_js_1 = require("./data/repositories/user-repo.js");
exports.SETUP_DEFAULTS = {
    scanInterval: 120,
    webPort: 3000,
    dbPath: './data/tb-chests.db',
};
function getPersistentEnvPath() {
    const configured = process.env.APP_CONFIG_PATH?.trim();
    return configured ? path_1.default.resolve(configured) : path_1.default.resolve('data', 'app.env');
}
function getLegacyEnvPath() {
    return path_1.default.resolve('.env');
}
function getDefaultDbPath() {
    return path_1.default.resolve(process.env.DB_PATH?.trim() || exports.SETUP_DEFAULTS.dbPath);
}
function buildEnvLines(answers) {
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
function writeSetupEnv(answers) {
    const envPath = getPersistentEnvPath();
    fs_1.default.mkdirSync(path_1.default.dirname(envPath), { recursive: true });
    const envLines = buildEnvLines(answers);
    fs_1.default.writeFileSync(envPath, envLines.join('\n') + '\n', { mode: 0o600 });
    // Backward compatibility for local/dev flows that still expect a root .env file.
    fs_1.default.writeFileSync(getLegacyEnvPath(), envLines.join('\n') + '\n', { mode: 0o600 });
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
function applyRestoredDatabase(input) {
    const dbPath = path_1.default.resolve(input.dbPath?.trim() || getDefaultDbPath());
    fs_1.default.mkdirSync(path_1.default.dirname(dbPath), { recursive: true });
    let displacedDb = null;
    if (fs_1.default.existsSync(dbPath)) {
        displacedDb = `${dbPath}.replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        fs_1.default.renameSync(dbPath, displacedDb);
    }
    try {
        // initDatabase hands back the cached handle if one is already open, so an
        // earlier open in this process would leave every later query pointed at
        // the file we are about to replace. Nothing in setup mode should have
        // opened one (needsSetup() means there is no DB yet), which is exactly why
        // this has to be unconditional rather than conditional on a flag.
        (0, database_js_1.closeDb)();
        fs_1.default.copyFileSync(input.sourceDbPath, dbPath);
        (0, database_js_1.initDatabase)(dbPath);
        const users = (0, user_repo_js_1.userCount)();
        if (users === 0) {
            // Unreachable via the route (it checks the temp file first), but a DB with
            // no accounts is an install nobody can sign in to — never leave one live.
            throw new Error('Restored database has no user accounts');
        }
        const superadmins = (0, user_repo_js_1.superadminCount)();
        const envPath = writeSetupEnv({
            adminUsername: '',
            adminPassword: '',
            scanInterval: input.scanInterval ?? exports.SETUP_DEFAULTS.scanInterval,
            webPort: input.webPort ?? exports.SETUP_DEFAULTS.webPort,
            dbPath,
        });
        return { envPath, dbPath, users, superadmins, displacedDb };
    }
    catch (err) {
        // Put back whatever we moved aside so a failed restore leaves the install
        // exactly as it was found.
        try {
            if (fs_1.default.existsSync(dbPath))
                fs_1.default.unlinkSync(dbPath);
            if (displacedDb && fs_1.default.existsSync(displacedDb))
                fs_1.default.renameSync(displacedDb, dbPath);
        }
        catch { /* best effort */ }
        throw err;
    }
}
function applySetupFromInput(input) {
    const normalizedUsername = (0, user_repo_js_1.normalizeUsername)(input.adminUsername);
    const usernameCheck = (0, user_repo_js_1.validateUsernamePolicy)(normalizedUsername);
    if (!usernameCheck.valid) {
        throw new Error(usernameCheck.message || 'Invalid admin username');
    }
    const passwordCheck = (0, user_repo_js_1.validatePasswordPolicy)(input.adminPassword);
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
    (0, database_js_1.initDatabase)(input.dbPath);
    let user = null;
    if ((0, user_repo_js_1.userCount)() === 0) {
        user = (0, user_repo_js_1.createUser)(normalizedUsername, input.adminPassword, 'superadmin');
    }
    else {
        user = (0, user_repo_js_1.authenticate)(normalizedUsername, input.adminPassword);
    }
    if (!user) {
        throw new Error('Could not resolve superadmin account after setup');
    }
    return { envPath, adminUsername: normalizedUsername, user };
}
function needsSetup() {
    const persistentEnvPath = getPersistentEnvPath();
    const legacyEnvPath = getLegacyEnvPath();
    const dbPath = getDefaultDbPath();
    if (fs_1.default.existsSync(persistentEnvPath) || fs_1.default.existsSync(legacyEnvPath)) {
        return false;
    }
    // In Docker, config may come from compose env vars while the durable setup state
    // is the existing database on /app/data. If that DB already exists, do not force
    // setup again just because the container root filesystem was recreated.
    return !fs_1.default.existsSync(dbPath);
}
//# sourceMappingURL=setup-wizard.js.map