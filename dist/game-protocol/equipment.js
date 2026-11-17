"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
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
/** Every item the given captains wear, by captain then position. Pure. */
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