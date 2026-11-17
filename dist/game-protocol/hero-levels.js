"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.heroLevelView = heroLevelView;
const at = (levels, idx, level) => {
    const v = levels.series[idx]?.[level - 1];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
};
/**
 * The level view of field-9 entry `heroId` (1 = the hero, else a T75 captain
 * id) at `level` / `stars`, or null when names.json has no levels for it.
 * `withStats` is for captains: their Stats screen is exactly these values.
 */
function heroLevelView(names, heroId, level, stars = 0, withStats = true) {
    const levels = names?.heroLevels;
    const s = levels?.heroes?.[String(heroId)];
    if (!levels || !s || !Number.isInteger(level) || level < 1)
        return null;
    const maxLevel = levels.series[s.xp]?.length ?? 0;
    if (level > maxLevel)
        return null;
    let stats = null;
    if (withStats) {
        const mightSeries = levels.series[s.might] ?? [];
        let might = 0;
        for (let i = 0; i < level && i < mightSeries.length; i++)
            might += mightSeries[i] ?? 0;
        might += names?.captains?.[String(heroId)]?.starMight?.[String(stars)] ?? 0;
        stats = {
            leadership: at(levels, s.leadership, level) ?? 0,
            authority: at(levels, s.authority, level) ?? 0,
            dominance: at(levels, s.dominance, level) ?? 0,
            might,
        };
    }
    return {
        xpFloor: at(levels, s.xp, level),
        xpNext: level < maxLevel ? at(levels, s.xp, level + 1) : null,
        stats,
    };
}
//# sourceMappingURL=hero-levels.js.map