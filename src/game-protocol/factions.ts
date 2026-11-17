/**
 * A player's Hall of Fame as the game's Hall of Fame screen shows it: the
 * three factions' levels with what each level gives, and the hall's own level.
 *
 * Nothing new is read for it: a faction's level IS a city tech (field 17,
 * stored per player in game_player_techs with its history) — 800 Lions of
 * Courage, 801 Wolves of Tenacity, 802 Eagles of Resolve, 803 the Hall of
 * Fame. The faction table (T78) ties a faction to its tech and art; the tech's
 * level rows (T21) carry the bonuses and the next level's conditions. Both
 * come from the static data (static-data.ts buildFactions → GameNames).
 */
import type { GameLevelledTech, GameNames, GameTextLine } from './static-data.js';

/** T78 ids in the order the game's Hall of Fame shows them, left to right: Wolves, Lions, Eagles. */
export const FACTION_DISPLAY_ORDER: readonly number[] = [3, 1, 2];

export interface LevelStep {
  level: number;
  lines: GameTextLine[];
  /** The conditions to reach it, as the game words them (English; tGame translates). */
  requires: string[];
}

export interface FactionLevelView {
  id: number;
  key: string;
  name: string;
  techId: number;
  level: number;
  maxLevel: number;
  /** What the current level gives (empty at level 0). */
  lines: GameTextLine[];
  /** The next level, null at the top. */
  next: LevelStep | null;
  /** The faction's stained-glass window and crest (T78's sprite names through `artUrl`), null until extracted. */
  windowUrl: string | null;
  crestUrl: string | null;
}

export interface HallOfFameView {
  level: number;
  maxLevel: number;
  lines: GameTextLine[];
  next: LevelStep | null;
  factions: FactionLevelView[];
}

function stepsOf(t: GameLevelledTech, level: number): { lines: GameTextLine[]; next: LevelStep | null } {
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
export function hallOfFameView(
  names: Pick<GameNames, 'factions' | 'hallOfFame'> | null | undefined,
  techLevels: Record<string, number> | null,
  artUrl: (name: string) => string | null,
): HallOfFameView | null {
  const factions = names?.factions;
  const hall = names?.hallOfFame;
  if (!factions || !hall || !techLevels) return null;
  const levelOf = (techId: number) => Math.max(0, Number(techLevels[String(techId)]) || 0);
  const known = Object.values(factions);
  const ordered = [
    ...FACTION_DISPLAY_ORDER.map((id) => factions[String(id)]).filter((f) => f),
    ...known.filter((f) => !FACTION_DISPLAY_ORDER.includes(f.id)).sort((a, b) => a.id - b.id),
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
