/**
 * Rise of the Ancients — the Tin Man event (T44 type 1024, code clandoom_epic).
 * Every scan and every between-scans poll reads its window header (38000) with
 * its "Clan members" standings (38003); see docs/game-protocol.md and
 * data/summon-windows.ts.
 */
import type { GameEventProgress } from './messages.js';

export const ANCIENTS_EVENT_TYPE = 1024;

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
export const SUMMON_ARTIFACT_IDS = [2, 4] as const;

/** The run's summons in all according to the Figurine, or null when the header had none. */
export function figurineSummons(progress: GameEventProgress | null): number | null {
  if (!progress) return null;
  for (const id of SUMMON_ARTIFACT_IDS) {
    const a = progress.artifacts[id];
    if (a && a.level > 0) return a.level;
  }
  return null;
}
