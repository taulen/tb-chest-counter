"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KIND_HEALTH = exports.KIND_STRENGTH = exports.TROOP_EFFECTS_FORMAT = exports.TROOP_EFFECTS_FILE = void 0;
exports.buildTroopEffects = buildTroopEffects;
exports.troopCard = troopCard;
exports.TROOP_EFFECTS_FILE = 'troop-effects.json';
/** Bump when the file's shape changes. */
exports.TROOP_EFFECTS_FORMAT = 1;
exports.KIND_STRENGTH = 4;
exports.KIND_HEALTH = 5;
const isLine = (e) => Array.isArray(e);
const condKey = (e) => JSON.stringify(Array.isArray(e[3]) ? e[3] : []);
const percent = (e) => (typeof e[5] === 'number' && e[5] !== 0 ? (e[5] - 10000) / 100 : 0);
/** The table from T20 (rows `[…, …, …, lines]`, a line `[kind, targetVec, [], [cond], 0, value ×10000, flat]`). */
function buildTroopEffects(t20, vec, version) {
    const linesOf = (row) => (Array.isArray(row) && Array.isArray(row[3]) ? row[3].filter(isLine) : [])
        .filter((e) => e[0] === exports.KIND_STRENGTH || e[0] === exports.KIND_HEALTH);
    const counts = new Map();
    for (const row of Object.values(t20))
        for (const e of linesOf(row))
            counts.set(condKey(e), (counts.get(condKey(e)) ?? 0) + 1);
    const general = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '[]';
    const targets = [];
    const targetIndex = new Map();
    const effects = {};
    for (const [id, row] of Object.entries(t20)) {
        const out = [];
        for (const e of linesOf(row)) {
            const cond = condKey(e);
            if (cond !== general && cond !== '[]')
                continue;
            const pct = percent(e);
            if (!pct)
                continue;
            const units = (vec(e[1]) ?? []).filter((u) => typeof u === 'number');
            let t = -1;
            if (units.length) {
                const key = units.join(',');
                t = targetIndex.get(key) ?? -1;
                if (t === -1) {
                    t = targets.length;
                    targets.push(units);
                    targetIndex.set(key, t);
                }
            }
            out.push([e[0], t, pct]);
        }
        if (out.length)
            effects[id] = out;
    }
    return { format: exports.TROOP_EFFECTS_FORMAT, version, targets, effects };
}
/**
 * A unit's strength and health bonus (percent) from an effect list, as its
 * card adds them up — less what the effect list doesn't carry.
 */
function troopCard(table, effects, unitId) {
    const reaches = new Set([-1]);
    table.targets.forEach((units, i) => { if (units.includes(unitId))
        reaches.add(i); });
    let strength = 0;
    let health = 0;
    for (const e of effects) {
        for (const [kind, target, pct] of table.effects[String(e.id)] ?? []) {
            if (!reaches.has(target))
                continue;
            if (kind === exports.KIND_STRENGTH)
                strength += pct * (e.count || 1);
            else if (kind === exports.KIND_HEALTH)
                health += pct * (e.count || 1);
        }
    }
    return { strength: Math.round(strength * 1000) / 1000, health: Math.round(health * 1000) / 1000 };
}
//# sourceMappingURL=troop-effects.js.map