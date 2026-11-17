"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SUMMON_ARTIFACT_IDS = exports.ANCIENTS_EVENT_TYPE = void 0;
exports.figurineSummons = figurineSummons;
exports.ANCIENTS_EVENT_TYPE = 1024;
/**
 * The artifacts whose level is the number of summons: the Enchanted Figurine
 * ("Number of summons" / "Summons: %value%" in the game's clandoom_artifacts
 * config), id 2 in normal kingdoms' runs and 4 in the Seasonal Kingdom run (T44
 * f9 artifactIds [1,2,3] / [1,4,3]).
 *
 * Its level IS the summon count, not a step on the Tome's and Clock's shared
 * 28-level cost ladder: CWB's Figurine had 6,156 points in on Nov 17 2026
 * (ladder level 4) yet reported level 2, and the game showed "2 of 2" for CWB
 * and "1 of 2" for SIK (level 2, 1,800 points). That matches the Ancient
 * planner's costs: a 3rd summon only from 10,200 points.
 */
exports.SUMMON_ARTIFACT_IDS = [2, 4];
/** The run's summons in all according to the Figurine, or null when the header had none. */
function figurineSummons(progress) {
    if (!progress)
        return null;
    for (const id of exports.SUMMON_ARTIFACT_IDS) {
        const a = progress.artifacts[id];
        if (a && a.level > 0)
            return a.level;
    }
    return null;
}
//# sourceMappingURL=ancients.js.map