"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IGNORED_KEYS = exports.SECTION_DEFS = void 0;
exports.genericSection = genericSection;
exports.sectionDef = sectionDef;
exports.sectionOrder = sectionOrder;
/**
 * What Tools → What's new lists, per kind of game data — the one place that
 * says how a kind is named, pictured and drilled into. Two sources, both per
 * static-data version and both diffed whole:
 *
 *   names  data/game-static/<version>/names.json (static-data.ts GameNames)
 *   art    data/game-art/static-<version>.json  (game-art/art-static.ts ArtStatic)
 *
 * A key that has no entry here is still diffed and listed (`genericSection`):
 * its entries named by `name` / `title` / a plain string, its changes as raw
 * values. So when the game data grows a new kind, the page shows it the next
 * patch with nothing to do; an entry below only makes it read better (a name,
 * a picture, a drill-down), and pages/whats-new.js's SECTION_VIEWS gives it a
 * label and a layout. See docs/game-patches.md → "What's new".
 */
const selection_js_1 = require("../game-art/selection.js");
const str = (v) => (typeof v === 'string' ? v : '');
const mapped = (ctx, map, id) => {
    const m = ctx.mappings[map];
    const v = m?.[id];
    return typeof v === 'string' ? v : undefined;
};
const art = (name) => (typeof name === 'string' && name ? (0, selection_js_1.safeArtName)(name) : undefined);
/** [text, value] pairs (the game's own bonus lines) as ValueLines at `at`. */
function pairLines(pairs, at) {
    if (!Array.isArray(pairs))
        return [];
    const out = [];
    for (const p of pairs) {
        if (Array.isArray(p) && typeof p[0] === 'string')
            out.push({ at, text: p[0], value: String(p[1] ?? '') });
    }
    return out;
}
/** A captain's star bonuses: { "1": [[text, value]…], … }. */
function starLines(stars) {
    if (!stars || typeof stars !== 'object')
        return [];
    return Object.entries(stars).flatMap(([s, pairs]) => pairLines(pairs, `★${s}`));
}
/** An artifact's level or star table: { effectId: [level, [[text, value]…]] }. */
function levelTable(table, mark) {
    if (!table || typeof table !== 'object')
        return [];
    return Object.values(table).flatMap((row) => Array.isArray(row) ? pairLines(row[1], `${mark}${row[0]}`) : []);
}
/** The bonus lines of an artifact's lowest and highest level ({ effectId: [level, lines] }). */
function levelEnds(table) {
    if (!table || typeof table !== 'object')
        return null;
    const rows = Object.values(table).filter((r) => Array.isArray(r) && typeof r[0] === 'number');
    if (!rows.length)
        return null;
    rows.sort((a, b) => a[0] - b[0]);
    return { first: rows[0][1], last: rows[rows.length - 1][1], firstLevel: rows[0][0], lastLevel: rows[rows.length - 1][0] };
}
/** "boudica_icon" → "boudica": the stem the client derives a captain's other pictures from. */
const iconStem = (icon) => str(icon).toLowerCase().replace(/_icon$/, '');
exports.SECTION_DEFS = [
    {
        key: 'events', source: 'names', groupByName: true,
        name: (v) => str(v.title),
        detail: (v) => ({ code: v.code }),
    },
    {
        key: 'captains', source: 'names',
        name: (v) => str(v.name),
        sub: (v) => str(v.rarityName) || undefined,
        icon: (v, id, ctx) => [mapped(ctx, 'captains', id), art(v.icon)],
        // The captain screen's full-body picture, else the city sprite. Not `art`
        // (lvlup_*): a tall level-up strip with the face at its foot.
        art: (v, id, ctx) => [mapped(ctx, 'captainArt', id), iconStem(v.icon) && `citizen_captain_${iconStem(v.icon)}`],
        layers: (v, _id, ctx) => {
            const tile = ctx.mappings.captainTile;
            const r = String(v.rarity ?? '');
            return tile ? { back: tile.backs?.[r], frame: tile.frames?.[r] } : undefined;
        },
        detail: (v) => ({ rarity: v.rarity, rarityName: v.rarityName, stars: v.stars }),
        lines: (v) => [{ text: 'Rarity', value: str(v.rarityName) }, ...starLines(v.stars)],
    },
    {
        key: 'heroes', source: 'names',
        name: (v) => str(v.name),
        icon: (v) => [art(v.icon)],
    },
    {
        key: 'artifacts', source: 'names',
        name: (v) => str(v.name),
        sub: (v) => str(v.rarityName) || undefined,
        icon: (v, id, ctx) => [mapped(ctx, 'artifacts', id), art(v.icon)],
        detail: (v) => {
            const ends = levelEnds(v.levels);
            return {
                rarity: v.rarity,
                rarityName: v.rarityName,
                maxLevel: v.maxLevel,
                maxStar: v.maxStar,
                first: ends?.first,
                firstLevel: ends?.firstLevel,
                last: ends?.last,
                lastLevel: ends?.lastLevel,
                bonuses: v.bonuses ? Object.values(v.bonuses).map((b) => [b?.[0], b?.[1]]) : undefined,
            };
        },
        lines: (v) => [
            { text: 'Max level', value: String(v.maxLevel ?? '') },
            { text: 'Max star level', value: String(v.maxStar ?? '') },
            ...levelTable(v.levels, 'Lv '),
            ...levelTable(v.stars, '★'),
        ],
    },
    {
        key: 'gifts', source: 'names', groupByName: true,
        // T8: a gift type's names (gifts) and the same id's kind and quality (items).
        values: (src) => {
            const gifts = src.gifts;
            if (!gifts)
                return undefined;
            const items = (src.items ?? {});
            const out = {};
            for (const [id, g] of Object.entries(gifts))
                out[id] = { ...g, ...(items[id] ?? {}) };
            return out;
        },
        name: (v) => str(v.chest),
        sub: (v) => str(v.source) || undefined,
        icon: (_v, id, ctx) => [ctx.itemIcons.get(id)],
        detail: (v) => ({ source: v.source || undefined, kind: v.kind, quality: v.quality }),
        lines: (v) => [
            { text: 'Source', value: str(v.source) },
            { text: 'Quality', value: v.quality === undefined ? '' : String(v.quality) },
        ],
    },
    {
        key: 'titles', source: 'names',
        name: (v) => str(v.name),
        sub: (v) => str(v.source) || undefined,
        icon: (v, id, ctx) => [mapped(ctx, 'titleArt', id), art(v.art), mapped(ctx, 'titles', id), art(v.icon)],
        detail: (v) => ({ description: v.description, source: v.source, seconds: v.seconds }),
        lines: (v) => [
            { text: 'Bonus', value: str(v.description) },
            { text: 'Source', value: str(v.source) },
            { text: 'Duration', value: String(v.seconds ?? '') },
        ],
    },
    {
        key: 'medals', source: 'names',
        name: (v) => str(v.name),
        sub: (v) => str(v.tierName) || undefined,
        icon: (v) => [art(v.icon)],
        detail: (v) => ({ description: v.description, tier: v.tier, tierName: v.tierName }),
    },
    {
        key: 'equipment', source: 'names', groupByName: true,
        name: (v) => str(v.name),
        icon: (v, id, ctx) => [mapped(ctx, 'equipment', id), art(v.icon)],
        detail: (v) => ({ grade: v.grade, lines: v.lines }),
        lines: (v) => pairLines(v.lines),
    },
    {
        key: 'inserts', source: 'names',
        name: (v) => str(v.name),
        icon: (v, id, ctx) => [mapped(ctx, 'inserts', id), art(v.icon)],
        detail: (v) => ({ kind: v.kind }),
    },
    {
        key: 'factions', source: 'names',
        name: (v) => str(v.name),
        icon: (v) => [art(v.art?.icon), art(v.art?.frameIcon)],
        detail: (v) => ({ maxLevel: v.maxLevel }),
    },
    {
        key: 'techs', source: 'names',
        name: (v) => str(v.name),
        icon: (_v, id, ctx) => [mapped(ctx, 'techs', id), ctx.techIcons.get(id)],
        detail: (v) => ({ maxLevel: v.maxLevel }),
        lines: (v) => [{ text: 'Max level', value: String(v.maxLevel ?? '') }],
    },
    { key: 'objects', source: 'names', groupByName: true, name: (v) => str(v) },
    { key: 'terrains', source: 'names', name: (v) => str(v) },
    { key: 'equipmentGrades', source: 'names', name: (v) => str(v) },
    // The art static slice: what names.json does not carry.
    {
        key: 'frames', source: 'art',
        name: (v) => str(v.name),
        icon: (v, id, ctx) => [mapped(ctx, 'avatarFrames', id), art(v.visual)],
    },
    {
        key: 'cityLooks', source: 'art',
        name: (v) => str(v.name),
        // The look at its highest city level — the grandest of its pictures.
        icon: (v) => {
            const icons = v.icons && typeof v.icons === 'object' ? Object.entries(v.icons) : [];
            icons.sort((a, b) => Number(b[0]) - Number(a[0]));
            return icons.map(([, n]) => art(n));
        },
    },
    {
        key: 'units', source: 'art', groupByName: true,
        // An array of { id, … } in the slice.
        values: (src) => (Array.isArray(src.units) ? Object.fromEntries(src.units.map((u) => [String(u.id), u])) : undefined),
        name: (v) => str(v.name),
        sub: (v) => (v.tier ? `T${v.tier}` : undefined),
        icon: (v) => [art(v.icon)],
        detail: (v) => ({ tier: v.tier, strength: v.strength, health: v.health }),
        lines: (v) => [
            { text: 'Strength', value: String(v.strength ?? '') },
            { text: 'Health', value: String(v.health ?? '') },
        ],
    },
];
/**
 * Keys never listed: bookkeeping, and what another section already covers
 * (names.json `items` rides in `gifts`; the art slice's copies of names.json's
 * sections, and its tree `branches` — the research trees have their own part).
 */
exports.IGNORED_KEYS = {
    names: new Set(['version', 'builtAt', 'format', 'textLanguages', 'items']),
    art: new Set(['version', 'format', 'heroes', 'techs', 'items', 'captains', 'artifacts', 'equipment', 'inserts', 'titles', 'branches']),
};
/** A key without a registry entry: listed all the same, named as well as the value allows. */
function genericSection(key, source) {
    return {
        key,
        source,
        name: (v) => {
            if (typeof v === 'string')
                return v;
            if (v && typeof v === 'object')
                return str(v.name) || str(v.title) || str(v.chest);
            return '';
        },
        icon: (v) => (v && typeof v === 'object' ? [art(v.icon), art(v.visual), art(v.art)] : []),
    };
}
function sectionDef(source, key) {
    return exports.SECTION_DEFS.find((d) => d.source === source && d.key === key) ?? genericSection(key, source);
}
/** Display order: the registry's, then any other key alphabetically. */
function sectionOrder(source, key) {
    const i = exports.SECTION_DEFS.findIndex((d) => d.source === source && d.key === key);
    return i >= 0 ? i : exports.SECTION_DEFS.length;
}
//# sourceMappingURL=notes-sections.js.map