"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.READER_LABELS = exports.PATCH_READERS = void 0;
exports.warningKey = warningKey;
exports.readPatchStatus = readPatchStatus;
exports.updatePatchStatus = updatePatchStatus;
exports.reportReaderOk = reportReaderOk;
exports.reportReaderFailed = reportReaderFailed;
exports.resetPatchStatusMemo = resetPatchStatusMemo;
/**
 * What each reader of the game's files made of the live game patch.
 *
 * Four things are rebuilt from the game's own files whenever it publishes a
 * patch: names and texts (static-data.ts), research trees (tech-trees.ts), art
 * (game-art/store.ts) and the client version the scan's login sends
 * (client-version.ts). Each reports here when it reads a patch or fails to.
 *
 * A failure is one alerting warning (it lights the System dot) per reader and
 * game version, cleared by `resolveEntries` when that reader next succeeds —
 * the warning says what can't be read; the System page's Game Patch card shows
 * every reader at once. Meanwhile each reader serves the previous patch's data.
 * See docs/game-patches.md.
 *
 * Kept in data/game-patch.json (GAME_PATCH_FILE overrides it), so a restart
 * neither forgets a failure nor raises it again.
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const logger_js_1 = require("../utils/logger.js");
const log_buffer_js_1 = require("../utils/log-buffer.js");
const log = (0, logger_js_1.childLogger)('game-patch');
exports.PATCH_READERS = ['names', 'trees', 'art', 'client'];
exports.READER_LABELS = {
    names: 'Game names and texts',
    trees: 'Research trees',
    art: 'Game art',
    client: 'Client version',
};
function warningKey(reader) {
    return `game-patch:${reader}`;
}
function statusFile() {
    if (process.env.GAME_PATCH_FILE)
        return path_1.default.resolve(process.env.GAME_PATCH_FILE);
    // Tests that drive a reader don't leave a status file in the working copy.
    if (process.env.VITEST)
        return null;
    return path_1.default.resolve('data', 'game-patch.json');
}
let memo = null;
function readPatchStatus() {
    if (memo)
        return memo;
    const file = statusFile();
    try {
        if (file && fs_1.default.existsSync(file)) {
            const parsed = JSON.parse(fs_1.default.readFileSync(file, 'utf8'));
            memo = { ...parsed, readers: parsed.readers ?? {} };
            return memo;
        }
    }
    catch (err) {
        log.warn({ noAlert: true }, `Game patch status unreadable, starting afresh (${String(err)})`);
    }
    memo = { readers: {} };
    return memo;
}
function updatePatchStatus(change) {
    const s = readPatchStatus();
    change(s);
    const file = statusFile();
    if (file) {
        try {
            fs_1.default.mkdirSync(path_1.default.dirname(file), { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            fs_1.default.writeFileSync(tmp, JSON.stringify(s, null, 2));
            fs_1.default.renameSync(tmp, file);
        }
        catch (err) {
            log.warn({ noAlert: true }, `Game patch status could not be saved (${String(err)})`);
        }
    }
    return s;
}
const errText = (err) => (err instanceof Error ? err.message : String(err));
/** `reader` read game version `live`. Clears its warning when it had one. */
function reportReaderOk(reader, live) {
    const prev = readPatchStatus().readers[reader];
    if (prev?.ok && prev.live === live)
        return;
    updatePatchStatus((s) => {
        s.readers[reader] = { live, served: live, ok: true, error: null, checkedAt: new Date().toISOString() };
    });
    if (!prev || !prev.ok) {
        if (prev && !prev.ok)
            log.info(`Game patch: ${exports.READER_LABELS[reader]} read for game version ${live}.`);
        (0, log_buffer_js_1.resolveEntries)(warningKey(reader));
    }
}
/**
 * `reader` could not read game version `live` (null = it couldn't tell which)
 * and serves `served` meanwhile. Warns once per reader and version.
 */
function reportReaderFailed(reader, live, served, err) {
    const prev = readPatchStatus().readers[reader];
    const now = new Date().toISOString();
    const again = !!prev && !prev.ok && prev.live === live;
    updatePatchStatus((s) => {
        s.readers[reader] = {
            live,
            served,
            ok: false,
            error: errText(err),
            checkedAt: now,
            failingSince: again ? prev.failingSince ?? now : now,
        };
    });
    if (again)
        return;
    log.warn({ resolveKey: warningKey(reader) }, `Game patch: ${exports.READER_LABELS[reader]} can't be read for game version ${live ?? '(unknown)'}: ${errText(err)}. ` +
        (served ? `Serving the previous patch's (${served}) until it can.` : 'Nothing to serve until it can.') +
        ' System → Game Patch has every reader; docs/game-patches.md says how to fix it.');
}
/** Test seam. */
function resetPatchStatusMemo() {
    memo = null;
}
//# sourceMappingURL=status.js.map