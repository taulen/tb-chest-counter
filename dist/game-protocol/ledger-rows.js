"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SPEEDUP_HOURS = void 0;
exports.ledgerToRows = ledgerToRows;
const game_day_js_1 = require("../utils/game-day.js");
/** Clan Speedup item → hours per item. */
exports.SPEEDUP_HOURS = { 2050: 1, 2051: 3, 2052: 8, 2053: 15, 2054: 24, 2055: 72 };
const SPEEDUP_SLUG = 'clan-speedup';
const DIRECTION_BY_KIND = { 1: -1, 2: 1, 3: 1, 4: 1, 7: 1 };
function ledgerToRows(entries, names, types, opts) {
    const byName = new Map(types.map((t) => [t.name.toLowerCase(), t]));
    const speedup = types.find((t) => t.slug === SPEEDUP_SLUG);
    const rows = [];
    const skipped = {};
    const skip = (why) => { skipped[why] = (skipped[why] ?? 0) + 1; };
    for (const e of entries) {
        const direction = DIRECTION_BY_KIND[e.kind];
        if (!direction) {
            skip(`kind ${e.kind}`);
            continue;
        }
        const transactionDate = (0, game_day_js_1.gameDateFor)(e.occurredAt * 1000, opts.rolloverUtcHour);
        if (opts.afterDate && transactionDate <= opts.afterDate) {
            skip('covered by OCR rows');
            continue;
        }
        let type;
        let amount = 0;
        let mixed = false;
        for (const [item, count] of Object.entries(e.amounts)) {
            const hours = exports.SPEEDUP_HOURS[item];
            const t = hours !== undefined ? speedup : byName.get((names.gifts[item]?.chest ?? '').toLowerCase());
            if (!t) {
                type = undefined;
                mixed = false;
                amount = 0;
                skip(`unmapped item ${item}`);
                break;
            }
            if (type && type.id !== t.id) {
                mixed = true;
                break;
            }
            type = t;
            amount += hours !== undefined ? count * hours : count;
        }
        if (mixed) {
            skip('several resource types in one entry');
            continue;
        }
        if (!type) {
            if (!Object.keys(e.amounts).length)
                skip('no amounts');
            continue;
        }
        if (opts.untrackedSlugs.has(type.slug)) {
            skip(`untracked ${type.slug}`);
            continue;
        }
        if (amount <= 0) {
            skip('zero amount');
            continue;
        }
        rows.push({ entryId: e.entryId, playerId: e.playerId, resourceTypeId: type.id, direction, amount, transactionDate });
    }
    return { rows, skipped };
}
//# sourceMappingURL=ledger-rows.js.map