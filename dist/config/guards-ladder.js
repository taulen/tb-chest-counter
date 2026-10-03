"use strict";
/**
 * The guardsmen-level ladder: what each guards level (G1–G9) donates.
 *
 * The game never shows a member's guards level anywhere the scanner can read it,
 * and no tracker in the field automates it — chesttracker.com makes admins type
 * it in by hand. But two donations the resource capture already records are
 * level-gated, and that is enough to infer it:
 *
 *  - **Omen Essence** (Dark Omens, roughly every 24 days). Every donation line is
 *    an exact multiple of a per-level UNIT, and the units step ×1.3 per level.
 *    A full donation is 70 units — 770,000 at G7, 1,001,000 at G8 — and two of
 *    them (140 units) is the "G7 does 1.54M, G8 does 2.02M" figure players quote.
 *    Partial donations stay divisible, so even someone who never donates in full
 *    gives their level away.
 *  - **Scientific Tractates** (Ragnarok, roughly every 24 days, ~12 days offset
 *    from Dark Omens). One fixed amount per level. A member can donate a LOWER
 *    tier than their own (seen: a G8 donating the G7 15M), but never a higher one.
 *
 * Measured on the 2026-09-28 production backup: the estimate agreed with the
 * hand-maintained ChestTracker level for 116 of 131 clan-1 members, and nearly
 * every disagreement was a ChestTracker update made AFTER our last donation —
 * the donations usually see a level-up first.
 *
 * Every value here is a game constant read off real donations, not a guess, with
 * two exceptions flagged inline. A wrong value fails silently — the estimator
 * just files that level's donations as noise — so tests/config/guards-ladder.test.ts
 * pins the shape of the ladder and runs as part of `npm run build`.
 *
 * Pure and import-free so the estimator and its guard tests stay fast.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GUARDS_STALE_DAYS = exports.GOLD_PASS_TRACTATE_AMOUNT = exports.TRACTATE_TIERS = exports.ESSENCE_MAX_UNITS_PER_LINE = exports.ESSENCE_FULL_DONATION_UNITS = exports.ESSENCE_UNITS = exports.TRACTATE_RESOURCE_SLUG = exports.ESSENCE_RESOURCE_SLUG = exports.GUARDS_MAX_LEVEL = exports.GUARDS_MIN_LEVEL = void 0;
exports.matchEssenceAmount = matchEssenceAmount;
exports.tractateTierLevel = tractateTierLevel;
exports.GUARDS_MIN_LEVEL = 1;
exports.GUARDS_MAX_LEVEL = 9;
/** `resource_types.slug` of the two level-gated donations. */
exports.ESSENCE_RESOURCE_SLUG = 'omen-essence';
exports.TRACTATE_RESOURCE_SLUG = 'scientific-tractates';
/**
 * Essence units by level. G4–G8 are each confirmed by dozens of full (70-unit)
 * donations across both clans. G9 by one full donation and 30 partials from 11
 * members — G9s rarely donate in full. G3 by four full 269,500 donations from
 * three clan-2 members in June–July 2026, who later donated at G4. G2 by a single
 * full 207,200, kept because it sits on the ×1.3 ladder. G1 has never been seen
 * donating.
 */
exports.ESSENCE_UNITS = [
    { level: 2, unit: 2_960 },
    { level: 3, unit: 3_850 },
    { level: 4, unit: 5_000 },
    { level: 5, unit: 6_500 },
    { level: 6, unit: 8_450 },
    { level: 7, unit: 11_000 },
    { level: 8, unit: 14_300 },
    { level: 9, unit: 18_600 },
    { level: 9, unit: 22_300, boosted: true },
];
/** Units in one full donation. */
exports.ESSENCE_FULL_DONATION_UNITS = 70;
/**
 * The most units one history line can carry. Before 2026-09-05 the capture also
 * wrote the day the game was still merging into, so two full donations could
 * arrive as one 140-unit line; anything larger is not a donation at that level.
 * The cap is what keeps 770,000 from also reading as 200 × G3.
 */
exports.ESSENCE_MAX_UNITS_PER_LINE = 140;
/** Scientific Tractates donated per level during Ragnarok. */
exports.TRACTATE_TIERS = [
    { level: 4, amount: 190_000 },
    { level: 5, amount: 1_100_000 },
    { level: 6, amount: 4_200_000 },
    { level: 7, amount: 15_000_000 },
    { level: 8, amount: 58_000_000 },
    { level: 9, amount: 76_000_000 },
];
/**
 * The tractate line a Gold Pass leaves behind: opening a pass-reward Union Chest
 * donates exactly this much, on the same day the chest arrives. 250k is NOT a
 * level tier — 133 members of every level donate it — which is why it lives
 * here, next to the tiers it must never be mistaken for.
 */
exports.GOLD_PASS_TRACTATE_AMOUNT = 250_000;
/**
 * Days without new evidence before an estimate is shown as stale. Dark Omens
 * and Ragnarok each come round about every 24 days, ~12 days apart, so a member
 * who donates is re-read at least every couple of weeks; past this, the level
 * may well have moved on (it only ever goes up).
 */
exports.GUARDS_STALE_DAYS = 35;
/**
 * Every level whose unit divides this essence amount within the per-line cap.
 * Empty for an amount no level explains — a misread, or another resource's row
 * filed under essence — which carries no information and is skipped.
 */
function matchEssenceAmount(amount) {
    if (!Number.isInteger(amount) || amount <= 0)
        return [];
    const out = [];
    for (const u of exports.ESSENCE_UNITS) {
        if (amount % u.unit !== 0)
            continue;
        const units = amount / u.unit;
        if (units > exports.ESSENCE_MAX_UNITS_PER_LINE)
            continue;
        out.push({ level: u.level, unit: u.unit, units, boosted: u.boosted === true });
    }
    return out;
}
/** The level a tractate amount is the tier of, or null when it is not a tier. */
function tractateTierLevel(amount) {
    return exports.TRACTATE_TIERS.find((t) => t.amount === amount)?.level ?? null;
}
//# sourceMappingURL=guards-ladder.js.map