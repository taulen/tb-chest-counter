"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.realNameBehindCut = realNameBehindCut;
exports.repairCutNames = repairCutNames;
const ocr_normalize_js_1 = require("../vision/ocr-normalize.js");
const logger_js_1 = require("../utils/logger.js");
const log = (0, logger_js_1.childLogger)('repair-cut-names');
/** What the old reader cut off: a tail starting at a K-number. */
const CUT_TAIL = /^\s*\(?\s*[Kk]\s*[:.]?\s*\d/;
/** member-repo's normalizeName: what `normalized_name` holds. */
const normalizeName = (name) => name.trim().toLowerCase().replace(/\s+/g, ' ');
/** The one alias whose cut-off form `name` is, or null (none, or ambiguous). */
function realNameBehindCut(name, aliases) {
    const fits = [...new Set(aliases.map((a) => a.trim()).filter((a) => a.length > name.length && a.startsWith(name) && CUT_TAIL.test(a.slice(name.length))))];
    return fits.length === 1 ? fits[0] : null;
}
function repairCutNames(database) {
    const members = database.prepare("SELECT id, clan_id AS clanId, name, aliases FROM members WHERE aliases IS NOT NULL AND aliases != '[]'").all();
    const taken = database.prepare('SELECT name FROM members WHERE clan_id = ? AND id != ? AND (normalized_name = ? OR despaced_name = ?)');
    const rename = database.prepare('UPDATE members SET name = ?, normalized_name = ?, despaced_name = ?, aliases = ? WHERE id = ?');
    const repointRules = database.prepare("UPDATE merge_rules SET to_value = ? WHERE clan_id = ? AND type = 'player' AND to_value = ?");
    const dropSelfRule = database.prepare("DELETE FROM merge_rules WHERE clan_id = ? AND type = 'player' AND from_value = ? AND to_value = ?");
    const restored = [];
    for (const m of members) {
        let aliases;
        try {
            aliases = JSON.parse(m.aliases);
        }
        catch {
            continue;
        }
        if (!Array.isArray(aliases))
            continue;
        const real = realNameBehindCut(m.name, aliases);
        if (!real)
            continue;
        const holder = taken.get(m.clanId, m.id, normalizeName(real), (0, ocr_normalize_js_1.despace)(real));
        if (holder) {
            log.warn(`Clan #${m.clanId}: left "${m.name}" as is — "${holder.name}" already holds the name "${real}"`);
            continue;
        }
        const kept = aliases.filter((a) => a.trim().toLowerCase() !== real.toLowerCase());
        if (!kept.some((a) => a.trim().toLowerCase() === m.name.toLowerCase()))
            kept.push(m.name);
        rename.run(real, normalizeName(real), (0, ocr_normalize_js_1.despace)(real), JSON.stringify(kept), m.id);
        repointRules.run(real, m.clanId, m.name);
        dropSelfRule.run(m.clanId, real, real);
        restored.push(`#${m.clanId} "${m.name}" → "${real}"`);
    }
    if (restored.length > 0) {
        log.info(`Restored ${restored.length} member name(s) cut at a kingdom number: ${restored.join(', ')}`);
    }
    return restored.length;
}
//# sourceMappingURL=repair-cut-names-2026-11.js.map