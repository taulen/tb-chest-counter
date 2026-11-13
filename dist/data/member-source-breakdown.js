"use strict";
/**
 * What one member's leaderboard points were made of in a window: their chests
 * grouped by the source that paid them — "Level 10 Crypt · 100 chests · 500
 * points" — in the sections of the FAQ's points table (points-guide.ts), so a
 * visitor can read the two side by side. Behind the public share page's
 * per-player hover card and tap-to-open sheet (lib/leaderboard-breakdown.js).
 *
 * Totals are the leaderboard row's own: getMemberChestsBySource runs
 * computeLeaderboard's WHERE with the member added, clan-reward exclusion
 * included, and every record lands in exactly one group here.
 *
 * A source is identified the way scoring identifies it — getSourceKey, compared
 * despaced (canonicalSourceKey) — so OCR spellings of one source are one line.
 * The line is labelled with the game's own text for it (the spelling the clan
 * has received most), not a name built from the key: that text is what a player
 * recognises, and what tGame()'s "Level {n} Crypt" patterns translate.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.foldMemberSources = foldMemberSources;
exports.getMemberSourceBreakdown = getMemberSourceBreakdown;
const database_js_1 = require("./database.js");
const chest_repo_js_1 = require("./repositories/chest-repo.js");
const source_points_repo_js_1 = require("./repositories/source-points-repo.js");
const source_categories_js_1 = require("./source-categories.js");
const source_names_js_1 = require("../vision/source-names.js");
const SECTION_ORDER = [
    'crypts', 'heroic', 'squads', 'runic', 'vault', 'events', 'tournaments', 'shops', 'other',
];
/** Sections whose sources are a level ladder, listed by tier and level rather than by points. */
const LADDER_SECTIONS = new Set(['crypts', 'heroic', 'runic', 'vault']);
const CATEGORY_INDEX = new Map(source_categories_js_1.SOURCE_CATEGORIES.map((c, i) => [c.key, i]));
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
function sectionFor(category) {
    return category === 'citadels' ? 'crypts' : category;
}
/**
 * The clan's most-received spelling of each source, by despaced key. From the
 * per-clan source summary the FAQ and the Chest Points board already read, so
 * it is warm (and shared) in the common case.
 */
function clanSourceSpellings(clanId) {
    const best = new Map();
    for (const s of (0, source_points_repo_js_1.getSourceKeySummary)(clanId)) {
        if (!s.sampleSource || s.totalCount === 0)
            continue;
        const canon = (0, source_names_js_1.canonicalSourceKey)(s.sourceKey);
        const cur = best.get(canon);
        if (!cur || s.totalCount > cur.count)
            best.set(canon, { source: s.sampleSource, count: s.totalCount });
    }
    return new Map([...best].map(([canon, v]) => [canon, v.source]));
}
/**
 * Fold per-source-string counts into sections. Pure, for the tests.
 *
 * `spellings` maps a despaced source key to the label to show for it; a key it
 * doesn't know is labelled with this member's most-received spelling.
 */
function foldMemberSources(raw, spellings = new Map()) {
    const buckets = new Map();
    for (const r of raw) {
        const key = r.source ? (0, source_names_js_1.getSourceKey)(r.source) : null;
        // '' collects everything without a usable source: no source recorded, or
        // one too garbled to key.
        const canon = key ? (0, source_names_js_1.canonicalSourceKey)(key) : '';
        let b = buckets.get(canon);
        if (!b) {
            b = { key, label: '', labelChests: -1, chests: 0, points: 0 };
            buckets.set(canon, b);
        }
        b.chests += r.chests;
        b.points += r.points;
        if (key && r.chests > b.labelChests) {
            b.label = r.source;
            b.labelChests = r.chests;
        }
        // The spaced spelling of a key is the one the category patterns read.
        if (key && b.key && key.split(' ').length > b.key.split(' ').length)
            b.key = key;
    }
    const bySection = new Map();
    let totalChests = 0;
    let totalPoints = 0;
    for (const [canon, b] of buckets) {
        totalChests += b.chests;
        totalPoints += b.points;
        const category = b.key ? (0, source_categories_js_1.sourceCategory)(b.key) : 'other';
        const source = b.key ? (spellings.get(canon) ?? b.label) : '';
        const level = (0, source_names_js_1.parseSourceLevel)(source) ?? Number(/(\d+)/.exec(b.key ?? '')?.[1] ?? 0);
        const line = {
            source,
            chests: b.chests,
            points: b.points,
            category,
            rank: b.key ? (0, source_categories_js_1.sourceSortRank)(b.key) : 0,
            level,
        };
        const section = sectionFor(category);
        const list = bySection.get(section) ?? [];
        list.push(line);
        bySection.set(section, list);
    }
    const sections = [];
    for (const key of SECTION_ORDER) {
        const lines = bySection.get(key);
        if (!lines)
            continue;
        lines.sort(LADDER_SECTIONS.has(key)
            // Crypts before citadels, then common → rare → epic → Tartaros, then level.
            ? (a, b) => (CATEGORY_INDEX.get(a.category) ?? 99) - (CATEGORY_INDEX.get(b.category) ?? 99)
                || a.rank - b.rank
                || a.level - b.level
                || collator.compare(a.source, b.source)
            // Named sources: what paid most first. The no-source line sorts like any other.
            : (a, b) => b.points - a.points || b.chests - a.chests || collator.compare(a.source, b.source));
        sections.push({
            key,
            chests: lines.reduce((n, l) => n + l.chests, 0),
            points: lines.reduce((n, l) => n + l.points, 0),
            rows: lines.map(({ source, chests, points }) => ({ source, chests, points })),
        });
    }
    return { totalChests, totalPoints, sections };
}
/**
 * The breakdown for one ACTIVE member of `clanId` over [from, to) (ISO; both
 * optional, as on the leaderboard), or null when the clan has no such member —
 * the same set of people the board lists, so the endpoint reveals nobody the
 * board doesn't.
 */
function getMemberSourceBreakdown(clanId, memberId, from, to) {
    const member = (0, database_js_1.getDb)()
        .prepare('SELECT name FROM members WHERE id = ? AND clan_id = ? AND is_active = 1')
        .get(memberId, clanId);
    if (!member)
        return null;
    const raw = (0, chest_repo_js_1.getMemberChestsBySource)(clanId, memberId, from, to);
    return {
        memberId,
        memberName: member.name,
        ...foldMemberSources(raw, clanSourceSpellings(clanId)),
    };
}
//# sourceMappingURL=member-source-breakdown.js.map