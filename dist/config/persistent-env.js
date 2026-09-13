"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPersistentEnvPath = getPersistentEnvPath;
exports.readEnvValue = readEnvValue;
exports.updateEnvValue = updateEnvValue;
exports.deleteEnvValue = deleteEnvValue;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
/**
 * Resolve the persistent env file path. APP_CONFIG_PATH overrides; otherwise
 * defaults to data/app.env on the mounted volume.
 */
function getPersistentEnvPath() {
    const configured = process.env.APP_CONFIG_PATH?.trim();
    return configured ? path_1.default.resolve(configured) : path_1.default.resolve('data', 'app.env');
}
/**
 * Read a value from the persistent env file. Returns null if the file
 * doesn't exist or the key isn't present.
 */
function readEnvValue(key) {
    const envPath = getPersistentEnvPath();
    if (!fs_1.default.existsSync(envPath))
        return null;
    const content = fs_1.default.readFileSync(envPath, 'utf8');
    const regex = new RegExp(`^${key}=(.*)$`, 'm');
    const match = content.match(regex);
    return match ? match[1] : null;
}
/**
 * Write or update a key=value pair in the persistent env file. Creates the
 * file if it doesn't exist. Survives container redeploys because the file
 * lives on the mounted data volume.
 */
function updateEnvValue(key, value) {
    const envPath = getPersistentEnvPath();
    const line = `${key}=${value}`;
    if (!fs_1.default.existsSync(envPath)) {
        const dir = path_1.default.dirname(envPath);
        if (!fs_1.default.existsSync(dir))
            fs_1.default.mkdirSync(dir, { recursive: true });
        fs_1.default.writeFileSync(envPath, `${line}\n`);
        return;
    }
    const content = fs_1.default.readFileSync(envPath, 'utf8');
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
        fs_1.default.writeFileSync(envPath, content.replace(regex, line));
        return;
    }
    const suffix = content.endsWith('\n') ? '' : '\n';
    fs_1.default.writeFileSync(envPath, `${content}${suffix}${line}\n`);
}
/**
 * Remove a key from the persistent env file (no-op if missing).
 */
function deleteEnvValue(key) {
    const envPath = getPersistentEnvPath();
    if (!fs_1.default.existsSync(envPath))
        return;
    const content = fs_1.default.readFileSync(envPath, 'utf8');
    const regex = new RegExp(`^${key}=.*$\\n?`, 'm');
    if (regex.test(content)) {
        fs_1.default.writeFileSync(envPath, content.replace(regex, ''));
    }
}
//# sourceMappingURL=persistent-env.js.map