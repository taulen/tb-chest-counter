"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tierCosts = tierCosts;
exports.tiersForPlayer = tiersForPlayer;
/**
 * What a troop tier costs — "G5 → G6", "S6 → S7", "C25 → C30" — worked out from
 * the game's own prerequisites, the question players ask of Tools → Costs.
 *
 * A tier is the unit unlocks troop-tiers.ts numbers (Heavy arbalester VI,
 * Heavy halberdier VI, Mounted knight VI, Battle griffin VI = G6; the II trees
 * continue at 8; crypts are Archeology's "Crypts" unlocks, level = numeral × 5).
 * Having tier N means having every unlock of tiers ≤ N and everything they
 * need, level by level (tech-levels.json `needs`, never OR'd). A step N−1 → N
 * is what tier N's need adds to tier N−1's: every research and level on the
 * way, with what it costs, takes and gives. Steps add up, so a range is a sum.
 *
 * Beside each step: what each of its units costs alone, and the research of
 * the family's trees that opens at that tier but that no tier needs (the
 * user's "only 2 of 3 are needed": carrying capacity is a dead end) — shown as
 * optional, never counted. Pure; tests/game-protocol/tier-costs.test.ts.
 *
 * tiersForPlayer takes one player's research levels off every step — what is
 * left of it for them — and finds their tier the way the rest of the site
 * does (the highest unit they have unlocked), for Tools → Costs' "from where
 * you are". Steps still add up: every step up to tier N is everything tier N
 * needs minus what they have.
 */
const troop_tiers_js_1 = require("./troop-tiers.js");
const LETTER = { guardsmen: 'G', specialists: 'S', engineers: 'E', monsters: 'M', crypts: 'C' };
const FAMILY_TREES = {
    guardsmen: [1, 23],
    specialists: [2, 24],
    engineers: [8, 25],
    monsters: [15, 26],
    crypts: [5],
};
/** Add `techId` up to `level`, and everything those levels ask for. */
function addNeed(techId, level, need, levels) {
    const have = need.get(techId) ?? 0;
    if (level <= have)
        return;
    need.set(techId, level);
    for (const l of levels.techs[String(techId)] ?? []) {
        if (l.level <= have || l.level > level)
            continue;
        for (const [other, lv] of l.needs ?? [])
            addNeed(other, lv, need, levels);
    }
}
function closure(start, levels) {
    const need = new Map();
    for (const [id, lv] of start)
        addNeed(id, lv, need, levels);
    return need;
}
function addCost(into, cost) {
    for (const [id, n] of Object.entries(cost))
        into[id] = (into[id] ?? 0) + n;
}
/** The levels from (exclusive) → to (inclusive) of a tech, summed. */
function span(techId, from, to, levels) {
    const item = { techId, from, to, cost: {}, seconds: 0, might: 0 };
    for (const l of levels.techs[String(techId)] ?? []) {
        if (l.level <= from || l.level > to)
            continue;
        addCost(item.cost, l.cost);
        item.seconds += l.seconds;
        item.might += l.might;
    }
    return item;
}
/** What `after` needs beyond `before`, as path items. */
function diff(before, after, levels, order) {
    const out = [];
    for (const [id, to] of after) {
        const from = before.get(id) ?? 0;
        if (to > from)
            out.push(span(id, from, to, levels));
    }
    return out.sort((a, b) => (order.get(a.techId) ?? 1e9) - (order.get(b.techId) ?? 1e9) || a.techId - b.techId);
}
/** Every tree's research in reading order (tree order, then left to right, top to bottom). */
function treeOrder(trees) {
    const order = new Map();
    for (const t of trees.trees) {
        const nodes = [...t.nodes].sort((a, b) => a.col - b.col || a.row - b.row);
        for (const n of [...nodes, ...(t.unplaced ?? [])])
            if (!order.has(n.techId))
                order.set(n.techId, order.size);
    }
    return order;
}
/** Can a tech's first level be researched once `have` is had? */
function opensWith(techId, have, levels) {
    const first = (levels.techs[String(techId)] ?? []).find((l) => l.level === 1);
    return !!first && (first.needs ?? []).every(([id, lv]) => (have.get(id) ?? 0) >= lv);
}
function tierCosts(trees, levels) {
    const index = (0, troop_tiers_js_1.unlockIndex)(trees);
    const order = treeOrder(trees);
    const out = [];
    for (const family of Object.keys(LETTER)) {
        const byTier = new Map();
        for (const [techId, tier] of index[family]) {
            if (!levels.techs[String(techId)])
                continue;
            if (!byTier.has(tier))
                byTier.set(tier, []);
            byTier.get(tier).push(techId);
        }
        const tiers = [...byTier.keys()].sort((a, b) => a - b);
        if (!tiers.length)
            continue;
        const label = (tier) => (family === 'crypts' ? `C${tier * 5}` : `${LETTER[family]}${tier}`);
        // Having tier N: every unlock of tiers ≤ N, and all they need.
        const upTo = [];
        let start = [];
        for (const tier of tiers) {
            start = [...start, ...byTier.get(tier).map((id) => [id, 1])];
            upTo.push(closure(start, levels));
        }
        const top = upTo[upTo.length - 1];
        // The family's research nobody needs all of: what is left of it opens at a
        // tier. Only what the game draws in its trees — research it keeps out of
        // them (an old "upkeep cost") can't be bought.
        const familyTechs = trees.trees
            .filter((t) => FAMILY_TREES[family].includes(t.id))
            .flatMap((t) => t.nodes);
        const optionalAt = new Map();
        for (const n of familyTechs) {
            const max = levels.techs[String(n.techId)]?.length ?? 0;
            const needed = top.get(n.techId) ?? 0;
            if (max <= needed)
                continue;
            const at = tiers.findIndex((_, i) => opensWith(n.techId, upTo[i], levels));
            if (at < 0)
                continue;
            if (!optionalAt.has(at))
                optionalAt.set(at, []);
            optionalAt.get(at).push(span(n.techId, needed, max, levels));
        }
        const steps = tiers.map((tier, i) => {
            const before = i > 0 ? upTo[i - 1] : new Map();
            const items = diff(before, upTo[i], levels, order);
            const step = {
                tier,
                label: label(tier),
                unlocks: byTier.get(tier),
                items,
                cost: {},
                seconds: 0,
                might: 0,
                buildings: {},
                units: [],
                optional: (optionalAt.get(i) ?? []).sort((a, b) => (order.get(a.techId) ?? 1e9) - (order.get(b.techId) ?? 1e9)),
            };
            Object.assign(step, totals(items, levels));
            // A unit alone: what it needs beyond the tier before.
            for (const unit of step.unlocks) {
                step.units.push(unitCost(unit, diff(before, closure([...before, [unit, 1]], levels), levels, order)));
            }
            return step;
        });
        out.push({ family, letter: LETTER[family], trees: FAMILY_TREES[family], steps });
    }
    return out;
}
/** What path items add up to: cost, time, Might, the highest level each building is asked for. */
function totals(items, levels) {
    const out = { cost: {}, seconds: 0, might: 0, buildings: {} };
    for (const it of items) {
        addCost(out.cost, it.cost);
        out.seconds += it.seconds;
        out.might += it.might;
        for (const l of levels.techs[String(it.techId)] ?? []) {
            if (l.level <= it.from || l.level > it.to || !l.building)
                continue;
            const [b, lv] = l.building;
            out.buildings[String(b)] = Math.max(out.buildings[String(b)] ?? 0, lv);
        }
    }
    return out;
}
function unitCost(techId, items) {
    const cost = {};
    let seconds = 0;
    for (const it of items) {
        addCost(cost, it.cost);
        seconds += it.seconds;
    }
    return { techId, cost, seconds, items };
}
/** A path item as a player still has it: from the level they have; null when they have all of it. */
function leftOf(it, have, levels) {
    const had = have[String(it.techId)] ?? 0;
    if (had >= it.to)
        return null;
    return had > it.from ? span(it.techId, had, it.to, levels) : it;
}
/**
 * Every family's steps as one player still has them: each step's research
 * from the levels they have, what is left of each unit alone and of the
 * optional research, and their tier (the site's G6) with the next one. A step
 * they have all of keeps its place with nothing in it.
 */
function tiersForPlayer(families, have, levels) {
    const left = (items) => items.map((it) => leftOf(it, have, levels)).filter((it) => it !== null);
    return families.map((f) => {
        let current = f.family === 'crypts' ? 1 : 0;
        for (const s of f.steps)
            if (s.unlocks.some((u) => (have[String(u)] ?? 0) >= 1))
                current = Math.max(current, s.tier);
        const steps = f.steps.map((s) => {
            const items = left(s.items);
            return {
                ...s,
                items,
                ...totals(items, levels),
                units: s.units.map((u) => unitCost(u.techId, left(u.items))),
                optional: left(s.optional),
            };
        });
        return { ...f, steps, current, next: f.steps.find((s) => s.tier > current)?.tier ?? null };
    });
}
//# sourceMappingURL=tier-costs.js.map