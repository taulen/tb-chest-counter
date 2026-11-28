"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.battleDataResponse = battleDataResponse;
exports.loadBattleData = loadBattleData;
/**
 * The newest battle-data.json the names build wrote (game-protocol/battle-data.ts),
 * ready to send: GET /api/tools/battle-data serves it to Tools → Monsters as
 * is, with an ETag (the static-data version) and a gzipped copy.
 *
 * Kept in memory until a newer file appears; null when none was built yet
 * (the names build runs on the first game-data request after a deploy).
 */
const fs_1 = __importDefault(require("fs"));
const zlib_1 = __importDefault(require("zlib"));
const static_data_js_1 = require("../game-protocol/static-data.js");
const battle_data_js_1 = require("../game-protocol/battle-data.js");
let memo = null;
function load() {
    const file = (0, static_data_js_1.newestStaticFile)(battle_data_js_1.BATTLE_DATA_FILE);
    if (!file)
        return null;
    const mtimeMs = fs_1.default.statSync(file).mtimeMs;
    if (memo?.file === file && memo.mtimeMs === mtimeMs)
        return memo;
    try {
        const body = fs_1.default.readFileSync(file);
        const data = JSON.parse(body.toString('utf8'));
        if (data.format !== battle_data_js_1.BATTLE_DATA_FORMAT)
            return null;
        memo = {
            file,
            mtimeMs,
            data,
            res: { version: data.version, etag: `"battle-${data.version}"`, body, gzip: zlib_1.default.gzipSync(body) },
        };
        return memo;
    }
    catch {
        return null;
    }
}
/** The file as sent, or null when there is none. */
function battleDataResponse() {
    return load()?.res ?? null;
}
/** The parsed data (server-side readers), or null when there is none. */
function loadBattleData() {
    return load()?.data ?? null;
}
//# sourceMappingURL=battle-data.js.map