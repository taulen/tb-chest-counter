"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUILD_INFO = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_path_1 = __importDefault(require("node:path"));
function readFileTrim(filepath) {
    try {
        const raw = node_fs_1.default.readFileSync(filepath, 'utf8').trim();
        return raw.length > 0 ? raw : null;
    }
    catch {
        return null;
    }
}
/**
 * Walk a directory recursively and return all file paths matching the
 * given extensions. Used by the dev-fallback fingerprint to mirror the
 * Dockerfile's `find ... | sort` step.
 */
function collectFiles(rootDir, exts) {
    const out = [];
    function walk(dir) {
        let entries;
        try {
            entries = node_fs_1.default.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const full = node_path_1.default.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            }
            else if (entry.isFile() && exts.has(node_path_1.default.extname(entry.name))) {
                out.push(full);
            }
        }
    }
    walk(rootDir);
    return out.sort();
}
function fingerprintOfDistAndPublic() {
    // Dev fallback: hash the same set of files the Dockerfile hashes,
    // in the same sorted order, so dev runs report the same fingerprint
    // a docker build would compute for the same source.
    const exts = new Set(['.js', '.json', '.html', '.css']);
    const roots = [
        { container: '/app/dist', dev: node_path_1.default.resolve('dist') },
        { container: '/app/src/web/public', dev: node_path_1.default.resolve('src/web/public') },
    ];
    const files = [];
    for (const { container, dev } of roots) {
        if (node_fs_1.default.existsSync(container)) {
            files.push(...collectFiles(container, exts));
        }
        else if (node_fs_1.default.existsSync(dev)) {
            files.push(...collectFiles(dev, exts));
        }
    }
    if (files.length === 0)
        return null;
    // Same digest scheme as the Dockerfile: hash each file, hash the
    // newline-joined list of "<sha>  <path>" lines.
    const lines = [];
    for (const file of files) {
        try {
            const buf = node_fs_1.default.readFileSync(file);
            const sha = node_crypto_1.default.createHash('sha256').update(buf).digest('hex');
            // Strip the absolute prefix so dev and container compute the
            // same hash for the same logical path.
            const rel = file.startsWith('/app/') ? file.slice('/app/'.length) : node_path_1.default.relative(process.cwd(), file).replace(/\\/g, '/');
            lines.push(`${sha}  ${rel}`);
        }
        catch {
            return null;
        }
    }
    return node_crypto_1.default.createHash('sha256').update(lines.join('\n') + '\n').digest('hex').slice(0, 7);
}
function resolveBuildInfo() {
    const builtAt = readFileTrim('/app/BUILD_TIME')
        ?? readFileTrim(node_path_1.default.resolve('BUILD_TIME'))
        ?? new Date().toISOString();
    const fingerprint = readFileTrim('/app/BUILD_FINGERPRINT')
        ?? readFileTrim(node_path_1.default.resolve('BUILD_FINGERPRINT'))
        ?? fingerprintOfDistAndPublic()
        ?? 'unknown';
    return Object.freeze({ builtAt, fingerprint });
}
exports.BUILD_INFO = resolveBuildInfo();
//# sourceMappingURL=build-info.js.map