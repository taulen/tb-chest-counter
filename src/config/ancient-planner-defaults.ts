/**
 * Starting values for the Ancient planner (Tools page).
 *
 * Every member can move the sliders; what the page OPENS on is the clan's saved
 * default — an admin's "Save as clan default" — or, until a clan has saved one,
 * the built-ins below. Stored as JSON on `clans.ancient_planner_defaults` (v79).
 *
 * Pure and import-free; the bounds mirror web/public/lib/ancient-planner.js.
 */

export interface AncientPlannerSettings {
  /** Tin Man level before the first summon, 1–250. */
  level: number;
  /** Tome of Knowledge level, 1–28 (level 26 = +70%). */
  tomeLevel: number;
  /** No-shows, % of the vault pot. */
  missing: number;
  /** Members who trick one vault level up, %. */
  trick: number;
  /** Expected overshoot, %. */
  margin: number;
  /** Members with no guards estimate: 'skip' or a tier key 'g1'–'g9'. */
  unknownAs: string;
  /** Summons planned, 1–8. */
  summons: number;
}

export const BUILT_IN_ANCIENT_DEFAULTS: Readonly<AncientPlannerSettings> = {
  level: 1,
  tomeLevel: 26,
  missing: 5,
  trick: 0,
  margin: 15,
  unknownAs: 'g7',
  summons: 3,
};

const BOUNDS: Record<Exclude<keyof AncientPlannerSettings, 'unknownAs'>, [number, number]> = {
  level: [1, 250],
  tomeLevel: [1, 28],
  missing: [0, 100],
  trick: [0, 100],
  margin: [0, 100],
  summons: [1, 8],
};

const UNKNOWN_AS = new Set(['skip', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9']);

/**
 * A complete, in-range settings object, or a list of what is wrong with it.
 * Strict on purpose: a save is an admin's deliberate choice, so a bad field is
 * refused rather than quietly clamped into something they didn't pick.
 */
export function parseAncientSettings(
  raw: unknown,
): { ok: true; settings: AncientPlannerSettings } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...BUILT_IN_ANCIENT_DEFAULTS };
  for (const [key, [min, max]] of Object.entries(BOUNDS) as Array<[keyof typeof BOUNDS, [number, number]]>) {
    const v = src[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      errors.push(`${key} must be a whole number from ${min} to ${max}`);
    } else {
      out[key] = v;
    }
  }
  if (typeof src.unknownAs !== 'string' || !UNKNOWN_AS.has(src.unknownAs)) {
    errors.push("unknownAs must be 'skip' or g1–g9");
  } else {
    out.unknownAs = src.unknownAs;
  }
  return errors.length ? { ok: false, errors } : { ok: true, settings: out };
}
