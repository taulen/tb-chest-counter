/**
 * A city's construction, troop training and research speed — the three
 * percentages of the game's Statistics page ("Research speed: 2026.3%") — and
 * where they come from, read for ANY member's city.
 *
 * City field 14 lists every effect active in the city with the source it comes
 * from (bit flags, below). names.json's `speeds` (static-data.ts buildSpeeds,
 * from T20) says what each effect adds; the bonuses add up. Two sources are
 * not in field 14 and are looked up by level instead: VIP (tech 1000, the
 * player record's level) and the clan's own research (game_clan_techs).
 *
 * Checked Nov 26 2026 against a member's Statistics page: research 2016.25 %
 * here vs 2026.3 % in the game, construction 1335.75 % vs 1345.8 % — the same
 * +10 % on both from a boost that runs out (a clan bonus item; the site can't
 * see those), and the game rounds to one decimal. Gear counts for the hero and
 * the three line-up captains, as the game counts it: a benched captain's gear
 * is not in field 14 and not in the game's total either.
 *
 * Pure; tests/game-protocol/city-speeds.test.ts.
 */
import type { GameSpeeds } from './static-data.js';

export type SpeedStat = 'construction' | 'training' | 'research';
export type SpeedSource = 'research' | 'buildings' | 'gear' | 'captains' | 'titles' | 'artifacts' | 'offers' | 'vip' | 'clan' | 'other';

export interface SpeedLine {
  /** Percent, two decimals (+2016.25 %). */
  total: number;
  /** The same total by where it comes from; sources that add nothing are left out. */
  by: Partial<Record<SpeedSource, number>>;
}

export type CitySpeeds = Record<SpeedStat, SpeedLine>;

export const SPEED_STATS: readonly SpeedStat[] = ['research', 'construction', 'training'];
/** The order the triple in names.json keeps them in. */
const TRIPLE_INDEX: Record<SpeedStat, number> = { construction: 0, training: 1, research: 2 };

/**
 * Field 14's source bits, named from what each one's effects belong to:
 * 2 research and Hall of Fame (T21 levels), 4 the main buildings at their
 * levels (the Academy at 45: +300 % research), 32 the Barracks and walls
 * (T17), 16 gear with its gems and enchantments, 128 captain levels and star
 * levels (T10, T75), 256 titles (T29), 1 / 8192 / 16384 an artifact's rolls,
 * star level and level, 2048 / 4096 shop offers (T19).
 */
const SOURCE_BITS: Array<[number, SpeedSource]> = [
  [2, 'research'], [4, 'buildings'], [32, 'buildings'], [16, 'gear'], [128, 'captains'], [256, 'titles'],
  [16384, 'artifacts'], [8192, 'artifacts'], [1, 'artifacts'], [2048, 'offers'], [4096, 'offers'],
];

export const VIP_TECH_ID = 1000;

function sourceOf(bits: number): SpeedSource {
  for (const [bit, source] of SOURCE_BITS) if ((bits & bit) !== 0) return source;
  return 'other';
}

const round = (v: number): number => Math.round(v * 100) / 100;

/**
 * The three speeds of a city. `effects` is field 14 (`[effectId, sourceBits,
 * count]`); `vip` the player's VIP level, `clanLevels` the clan's research
 * levels when the city was read. Null when the reply carried no effects (a
 * malformed reply, not a city without bonuses).
 */
export function citySpeeds(
  effects: ReadonlyArray<{ id: number; source: number; count: number }>,
  table: GameSpeeds,
  extra: { vip?: number | null; clanLevels?: Record<string, number> } = {},
): CitySpeeds | null {
  if (!effects.length) return null;
  const out = {} as CitySpeeds;
  for (const stat of SPEED_STATS) out[stat] = { total: 0, by: {} };
  const add = (effectId: number, count: number, source: SpeedSource): void => {
    const triple = table.effects[String(effectId)];
    if (!triple) return;
    for (const stat of SPEED_STATS) {
      const v = triple[TRIPLE_INDEX[stat]] * count;
      if (!v) continue;
      out[stat].total += v;
      out[stat].by[source] = (out[stat].by[source] ?? 0) + v;
    }
  };
  for (const e of effects) add(e.id, e.count || 1, sourceOf(e.source));
  const byLevel = (techId: string, level: number | null | undefined): number | undefined =>
    (level ? table.techs[techId]?.[String(level)] : undefined);
  const vipEffect = byLevel(String(VIP_TECH_ID), extra.vip);
  if (vipEffect) add(vipEffect, 1, 'vip');
  for (const [techId, level] of Object.entries(extra.clanLevels ?? {})) {
    const effect = byLevel(techId, level);
    if (effect) add(effect, 1, 'clan');
  }
  for (const stat of SPEED_STATS) {
    out[stat].total = round(out[stat].total);
    for (const k of Object.keys(out[stat].by) as SpeedSource[]) out[stat].by[k] = round(out[stat].by[k] as number);
  }
  return out;
}
