/**
 * How the game frames a unit's icon — read from the WebGL client's own UI
 * (prefab `Core/Icon/UnitIconView` in its Resources, Nov 2026; webgl-client.ts
 * extracts the sprites):
 *
 *   a 72×72 box holding, back to front,
 *     Back        back_icon_units_72x72_<colour>     72×72, centred
 *     Icon        the unit's portrait (T9 f4)         72×72 — most are cut-outs,
 *                                                     so the back shows through
 *     UnitBorder  frame_icon_units_94x92_<colour>    94×92, centred 2 px low
 *     TierIcon    icons_tir_<roman>_1                33×33, top-left 12 px left
 *                                                     of and 10 px above the box
 *
 * <colour> is the unit's tier (T9 f2) on the game's tier ladder, the same one
 * its per-tier draperies (drapery_tir_<roman>_1) are coloured by: 0 grey,
 * I white, II green, III blue, IV violet, V orange, VI red, VII gold, then
 * VIII–X the "II" shades (whiteII, greenII, blueII). The client's code picks
 * the sprites at run time; the ladder is what its art is named and coloured by.
 *
 * The roman badge exists for tiers I–VII only (icons_tir_I_1 … _VII_1) and a
 * plain grey disc for 0 (icons_tir_0_3). Tiers VIII–X have no badge sprite:
 * we show the plain disc of their colour family (icons_tir_<I|II|III>_3: white,
 * green, blue) with the numeral written over it (`numeral`).
 *
 * The geometry lives in style.css (.unit-icon) and is kept in step with this.
 */
import { safeArtName } from './selection.js';

/** Tier → the colour suffix of its back and frame sprites (index = tier). */
export const UNIT_TIER_COLOURS = [
  'grey', 'white', 'green', 'blue', 'violet', 'orange', 'red', 'gold', 'whiteII', 'greenII', 'blueII',
] as const;

export const TIER_NUMERALS = ['0', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'] as const;

/** The highest tier with a roman badge sprite of its own. */
const LAST_BADGE_TIER = 7;

const backName = (colour: string): string => `back_icon_units_72x72_${colour}`;
const frameName = (colour: string): string => `frame_icon_units_94x92_${colour}`;
/** A tier's badge sprite, and the numeral to write over it when the sprite has none. */
function badgeOf(tier: number): { sprite: string; numeral: string | null } {
  if (tier === 0) return { sprite: 'icons_tir_0_3', numeral: null };
  if (tier <= LAST_BADGE_TIER) return { sprite: `icons_tir_${TIER_NUMERALS[tier]}_1`, numeral: null };
  // VIII → I's white disc, IX → II's green, X → III's blue.
  return { sprite: `icons_tir_${TIER_NUMERALS[tier - LAST_BADGE_TIER]}_3`, numeral: TIER_NUMERALS[tier] };
}

/** The client texture names a unit frame uses (exact, case kept: "whiteII"). */
export function unitFrameTextures(): string[] {
  const out = new Set<string>();
  UNIT_TIER_COLOURS.forEach((colour, tier) => {
    out.add(backName(colour));
    out.add(frameName(colour));
    out.add(badgeOf(tier).sprite);
  });
  return [...out];
}

/**
 * The plate the game writes a player's hero level on, at the top-right of
 * their framed portrait (prefab `UserIconView`, child `LevelView__level`:
 * 29×35, its top-left 53 px right of the portrait's left edge and 8 px above
 * it; the number centred, 1.5 px high). The view chooses among icons_tir_1 and
 * icons_tir_shield_1…6 in code we cannot read; this is the sprite the prefab
 * is saved with.
 */
export const HERO_LEVEL_BADGE = 'icons_tir_shield_4';

/** Every texture we take from the client build. */
export function clientUiTextures(): string[] {
  return [...new Set([...unitFrameTextures(), HERO_LEVEL_BADGE])];
}

export interface UnitFrameArt {
  /** Image names (safeArtName) of the back, the frame and the tier badge. */
  back: string;
  frame: string;
  badge: string | null;
  /** Written over the badge: the badge sprite has no numeral of its own (VIII–X). */
  numeral: string | null;
}

/**
 * Tier ("0"–"10") → its frame art, for the tiers whose back and frame were
 * extracted. A missing badge leaves the frame without one.
 */
export function unitFrameArt(available: (name: string) => boolean): Record<string, UnitFrameArt> {
  const out: Record<string, UnitFrameArt> = {};
  UNIT_TIER_COLOURS.forEach((colour, tier) => {
    const back = safeArtName(backName(colour));
    const frame = safeArtName(frameName(colour));
    if (!available(back) || !available(frame)) return;
    const b = badgeOf(tier);
    const badge = safeArtName(b.sprite);
    out[String(tier)] = available(badge) ? { back, frame, badge, numeral: b.numeral } : { back, frame, badge: null, numeral: null };
  });
  return out;
}
