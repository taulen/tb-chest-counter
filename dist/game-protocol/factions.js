"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FACTION_DISPLAY_ORDER = void 0;
exports.hallOfFameView = hallOfFameView;
/** T78 ids in the order the game's Hall of Fame shows them, left to right: Wolves, Lions, Eagles. */
exports.FACTION_DISPLAY_ORDER = [3, 1, 2];
function stepsOf(t, level) {
    const lines = level > 0 ? t.levels[String(level)]?.lines ?? [] : [];
    const n = t.levels[String(level + 1)];
    return { lines, next: level < t.maxLevel && n ? { level: level + 1, lines: n.lines, requires: n.requires } : null };
}
/**
 * The view, or null when the static data has no factions (a cache from
 * before NAMES_FORMAT 5) or the player's techs have never been read. A
 * faction the player has not raised is level 0 (the game lists only
 * researched techs).
 */
function hallOfFameView(names, techLevels, artUrl) {
    const factions = names?.factions;
    const hall = names?.hallOfFame;
    if (!factions || !hall || !techLevels)
        return null;
    const levelOf = (techId) => Math.max(0, Number(techLevels[String(techId)]) || 0);
    const known = Object.values(factions);
    const ordered = [
        ...exports.FACTION_DISPLAY_ORDER.map((id) => factions[String(id)]).filter((f) => f),
        ...known.filter((f) => !exports.FACTION_DISPLAY_ORDER.includes(f.id)).sort((a, b) => a.id - b.id),
    ];
    const hallLevel = levelOf(hall.techId);
    return {
        level: hallLevel,
        maxLevel: hall.maxLevel,
        ...stepsOf(hall, hallLevel),
        factions: ordered.map((f) => {
            const level = levelOf(f.techId);
            return {
                id: f.id,
                key: f.key,
                name: f.name,
                techId: f.techId,
                level,
                maxLevel: f.maxLevel,
                ...stepsOf(f, level),
                windowUrl: f.art.stainedGlass ? artUrl(f.art.stainedGlass) : null,
                crestUrl: f.art.icon ? artUrl(f.art.icon) : null,
            };
        }),
    };
}
//# sourceMappingURL=factions.js.map