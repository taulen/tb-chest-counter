"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LEVEL_MAX = exports.LEVEL_KEYS = void 0;
exports.parseLevelReports = parseLevelReports;
/**
 * Parse player levels posted in the in-game chat, one player per line:
 *
 *     taulen: G8/M8/S7/E8/C35/D284
 *     Dark Knight: G7.M8.S7.E7.C30.D199
 *     Ironhide: g8 m8 s 7 e 8 c35 d238
 *     Dardaen: g8 m8 s7 e6, g8m8s7e6d250
 *     IamNotHades: g8/m7/s7/e7/dragon 250/c25
 *
 * The name is everything before the first ":" (after an optional chat
 * timestamp). After it, each letter G M S E C D — or the word "dragon" —
 * followed by a number is one level; separators, case and stray marks
 * ("C30*", "S8(only 1 unlocked)") don't matter. The LAST value of a letter on a
 * line wins ("D234, D 246*" → 246), and a player posting twice is merged
 * field by field, later lines winning — chat runs top to bottom.
 *
 * Anything that isn't a letter-and-number in range is ignored rather than
 * guessed at: "E -12", "EK- Updated", "C/", a bare "/215".
 *
 * Pure — no database — so tests can run it on its own.
 */
const ocr_normalize_js_1 = require("../vision/ocr-normalize.js");
exports.LEVEL_KEYS = ['g', 'm', 's', 'e', 'c', 'd'];
/** Highest believable value per letter; anything above is a misread. */
exports.LEVEL_MAX = { g: 10, m: 10, s: 10, e: 10, c: 60, d: 500 };
const TIMESTAMP = /^\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*/;
const TOKEN = /(dragon|[gmsecd])\s*[:=.]?\s*(\d{1,3})(?!\d)/gi;
function parseLevelReports(text) {
    const byKey = new Map();
    const skipped = [];
    for (const rawLine of String(text ?? '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line)
            continue;
        const body = line.replace(TIMESTAMP, '');
        const colon = body.indexOf(':');
        if (colon <= 0) {
            skipped.push(line);
            continue;
        }
        const name = body.slice(0, colon).replace(/\s+/g, ' ').trim();
        const rest = body.slice(colon + 1);
        const levels = {};
        for (const m of rest.matchAll(TOKEN)) {
            const key = (m[1].toLowerCase() === 'dragon' ? 'd' : m[1].toLowerCase());
            const value = Number(m[2]);
            if (value >= 1 && value <= exports.LEVEL_MAX[key])
                levels[key] = value;
        }
        if (!name || Object.keys(levels).length === 0) {
            skipped.push(line);
            continue;
        }
        const key = (0, ocr_normalize_js_1.despace)(name) || name.toLowerCase();
        const prev = byKey.get(key);
        if (prev) {
            prev.levels = { ...prev.levels, ...levels };
            prev.raw = `${prev.raw}\n${line}`;
        }
        else {
            byKey.set(key, { name, levels, raw: line });
        }
    }
    return { players: [...byKey.values()], skipped };
}
//# sourceMappingURL=member-levels-parse.js.map