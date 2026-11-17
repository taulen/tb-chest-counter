"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.unlockIndex = unlockIndex;
exports.troopTiers = troopTiers;
/** Tree ids per family: [tree whose numerals ARE the tier, tree whose numerals are tier − 7]. */
const FAMILY_TREES = {
    guardsmen: { base: [1], plus7: [23] },
    specialists: { base: [2], plus7: [24] },
    engineers: { base: [8], plus7: [25] },
    monsters: { base: [15], plus7: [26] },
    crypts: { base: [5], plus7: [] },
};
const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
function numeral(name) {
    const m = /\s([IVX]+)$/.exec(name.trim());
    return m ? ROMAN[m[1]] ?? null : null;
}
/** techId → tier it unlocks, per family (built once per trees version). */
function unlockIndex(trees) {
    const out = {};
    for (const [family, ids] of Object.entries(FAMILY_TREES)) {
        const map = new Map();
        for (const tree of trees.trees) {
            const offset = ids.base.includes(tree.id) ? 0 : ids.plus7.includes(tree.id) ? 7 : null;
            if (offset === null)
                continue;
            for (const node of tree.nodes) {
                if (node.maxLevel !== 1)
                    continue;
                if (family === 'crypts' && !/^Crypts\b/.test(node.name))
                    continue;
                const n = numeral(node.name);
                if (n !== null)
                    map.set(node.techId, n + offset);
            }
        }
        out[family] = map;
    }
    return out;
}
/** The player's tiers from their tech levels. Crypts start at I without research. */
function troopTiers(levels, index) {
    const tiers = { guardsmen: null, specialists: null, engineers: null, monsters: null, crypts: null };
    for (const family of Object.keys(index)) {
        let best = null;
        for (const [techId, tier] of index[family]) {
            if ((levels[techId] ?? 0) >= 1 && (best === null || tier > best))
                best = tier;
        }
        if (family === 'crypts') {
            const tier = best === null && Object.keys(levels).length ? 1 : best;
            tiers.crypts = tier === null ? null : tier * 5;
        }
        else {
            tiers[family] = best;
        }
    }
    return tiers;
}
//# sourceMappingURL=troop-tiers.js.map