"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CAPTAIN_GEAR_POSITIONS = exports.HERO_GEAR_POSITIONS = exports.HERO_ENTRY_ID = void 0;
exports.describeItem = describeItem;
exports.captainEquipment = captainEquipment;
/** What the game's item card shows for one worn item. Pure. */
function describeItem(type, enchantment, gems, names) {
    const e = names?.equipment?.[String(type)];
    const insert = (id) => ({ id, name: names?.inserts?.[String(id)]?.name ?? `#${id}` });
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
/** City field 9's entry for the hero: it wears gear like a captain but has no T75 row. */
exports.HERO_ENTRY_ID = 1;
/**
 * The equipment slots the game shows (every field-9 entry lists six positions):
 * the hero wears six items, a captain three. Prod, Nov 2026: captains' gear only
 * ever sits at positions 3–5 (2,303 / 2,205 / 2,127 items), the hero's at 0–5.
 */
exports.HERO_GEAR_POSITIONS = [0, 1, 2, 3, 4, 5];
exports.CAPTAIN_GEAR_POSITIONS = [3, 4, 5];
/** Every item the given captains (and the hero, entry id 1) wear, by wearer then position. Pure. */
function captainEquipment(captains, items) {
    const byUid = new Map(items.map((it) => [it.uid, it]));
    const out = [];
    for (const c of captains) {
        (c.equipment ?? []).forEach((uid, position) => {
            const it = uid ? byUid.get(uid) : undefined;
            if (!it)
                return;
            out.push({ captainId: c.id, position, uid, type: it.type, enchantment: it.enchantment, gems: it.gems, raw: it.raw });
        });
    }
    return out;
}
//# sourceMappingURL=equipment.js.map