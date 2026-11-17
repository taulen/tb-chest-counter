/**
 * Captain equipment from a city record (601) — readable for ANY player.
 *
 * A captain entry (field 9) lists six equipment positions in [12],
 * `[captainId, slotId, itemUid, 100]`; the uid is an item instance in field 10,
 * `[uid, itemType, [cityId], 1000, a, b, c, enchantment, [gems], presetId]`.
 * The item TYPE is a T11 row and already includes the quality grade (the same
 * "Cursed Claw Coat" is a different type per grade, Poor … Godlike), so its
 * bonuses are that row's props. Gems and the enchantment are T8 items.
 *
 * Captain entry [14] holds presets `[presetId, captainId, [six uids]]`; the
 * first matches [12] and is what an item's presetId points at. Only [12] — what
 * the captain wears now — is read. Checked on the signed-in account's city and
 * archived member cities (Nov 2026): Carter wears Cursed Claw Coat (4423,
 * Godlike) with a Pioneer Enchantment and an Amber.
 */
import type { CityCaptain, CityItem } from './messages.js';
import type { GameNames } from './static-data.js';

export interface ItemView {
  name: string;
  /** Quality grade 1–8 (Poor … Godlike); 0 unknown. */
  grade: number;
  gradeName: string;
  /** Icon address (for the art mapping), '' unknown. */
  icon: string;
  /** The item's bonuses at its grade. */
  lines: Array<[string, string]>;
  enchantment: { id: number; name: string } | null;
  gems: Array<{ id: number; name: string }>;
}

/** What the game's item card shows for one worn item. Pure. */
export function describeItem(
  type: number,
  enchantment: number,
  gems: number[],
  names: Pick<GameNames, 'equipment' | 'equipmentGrades' | 'inserts'> | null | undefined,
): ItemView {
  const e = names?.equipment?.[String(type)];
  const insert = (id: number) => ({ id, name: names?.inserts?.[String(id)]?.name ?? `#${id}` });
  return {
    name: e?.name ?? `#${type}`,
    grade: e?.grade ?? 0,
    gradeName: names?.equipmentGrades?.[String(e?.grade ?? 0)] ?? '',
    icon: e?.icon ?? '',
    lines: e?.lines ?? [],
    enchantment: enchantment ? insert(enchantment) : null,
    gems: gems.map(insert),
  };
}

export interface WornItem {
  captainId: number;
  /** Equipment position 0–5 in the captain entry. */
  position: number;
  uid: string;
  type: number;
  enchantment: number;
  gems: number[];
  /** Undecoded instance fields, kept raw. */
  raw: Array<number | null>;
}

/** City field 9's entry for the hero: it wears gear like a captain but has no T75 row. */
export const HERO_ENTRY_ID = 1;

/**
 * The equipment slots the game shows (every field-9 entry lists six positions):
 * the hero wears six items, a captain three. Prod, Nov 2026: captains' gear only
 * ever sits at positions 3–5 (2,303 / 2,205 / 2,127 items), the hero's at 0–5.
 */
export const HERO_GEAR_POSITIONS: readonly number[] = [0, 1, 2, 3, 4, 5];
export const CAPTAIN_GEAR_POSITIONS: readonly number[] = [3, 4, 5];

/** Every item the given captains (and the hero, entry id 1) wear, by wearer then position. Pure. */
export function captainEquipment(captains: CityCaptain[], items: CityItem[]): WornItem[] {
  const byUid = new Map(items.map((it) => [it.uid, it]));
  const out: WornItem[] = [];
  for (const c of captains) {
    (c.equipment ?? []).forEach((uid, position) => {
      const it = uid ? byUid.get(uid) : undefined;
      if (!it) return;
      out.push({ captainId: c.id, position, uid, type: it.type, enchantment: it.enchantment, gems: it.gems, raw: it.raw });
    });
  }
  return out;
}
