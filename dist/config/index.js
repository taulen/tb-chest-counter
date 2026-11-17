"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
exports.getConfig = getConfig;
exports.resetConfig = resetConfig;
const dotenv_1 = __importDefault(require("dotenv"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const schema_js_1 = require("./schema.js");
function getEnvFilePaths() {
    const configured = process.env.APP_CONFIG_PATH?.trim();
    const persistentPath = configured ? path_1.default.resolve(configured) : path_1.default.resolve('data', 'app.env');
    return [path_1.default.resolve('.env'), persistentPath];
}
function loadEnvFiles(override) {
    for (const envPath of getEnvFilePaths()) {
        if (fs_1.default.existsSync(envPath)) {
            dotenv_1.default.config({ path: envPath, override, quiet: true });
        }
    }
}
loadEnvFiles(false);
let cachedConfig = null;
function envToConfigInput() {
    return {
        scanIntervalMs: process.env.SCAN_INTERVAL_MS,
        dbPath: process.env.DB_PATH,
        storageStatePath: process.env.STORAGE_STATE_PATH,
        webPort: process.env.WEB_PORT,
        webExternalUrl: process.env.WEB_EXTERNAL_URL,
        webEnabled: process.env.WEB_ENABLED,
        gameDayRolloverUtcHour: process.env.GAME_DAY_ROLLOVER_UTC_HOUR,
        chestPointValues: process.env.CHEST_POINT_VALUES,
        logLevel: process.env.LOG_LEVEL,
    };
}
function loadConfig() {
    if (cachedConfig)
        return cachedConfig;
    // Re-read env files so runtime setup changes are picked up without requiring
    // a process restart. Persistent app.env is loaded after legacy .env.
    loadEnvFiles(true);
    const raw = envToConfigInput();
    // Strip undefined values so Zod defaults kick in
    const cleaned = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
    const result = schema_js_1.configSchema.safeParse(cleaned);
    if (!result.success) {
        console.error('Configuration validation failed:');
        for (const issue of result.error.issues) {
            console.error(`  ${issue.path.join('.')}: ${issue.message}`);
        }
        process.exit(1);
    }
    cachedConfig = result.data;
    return cachedConfig;
}
function getConfig() {
    return cachedConfig ?? loadConfig();
}
function resetConfig() {
    cachedConfig = null;
}
//# sourceMappingURL=index.js.map