"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.planGiftClaims = planGiftClaims;
function planGiftClaims(gifts, maxEntries, maxChests) {
    const byType = new Map();
    for (const g of gifts) {
        if (!(g.count > 0))
            continue;
        const list = byType.get(g.giftType) ?? [];
        list.push(g);
        byType.set(g.giftType, list);
    }
    const out = [];
    for (const [giftType, list] of byType) {
        let cur = null;
        for (const gift of list) {
            let left = gift.count;
            while (left > 0) {
                if (!cur || cur.parts.length >= maxEntries || cur.chests >= maxChests) {
                    cur = { giftType, parts: [], chests: 0 };
                    out.push(cur);
                }
                const n = Math.min(left, maxChests - cur.chests);
                cur.parts.push({ gift, n });
                cur.chests += n;
                left -= n;
            }
        }
    }
    return out;
}
//# sourceMappingURL=claim-plan.js.map