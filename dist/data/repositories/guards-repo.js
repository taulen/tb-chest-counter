"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGuardsLevels = getGuardsLevels;
exports.summarizeGuards = summarizeGuards;
exports.getGuardsSummaries = getGuardsSummaries;
exports.getClanGuardsOverview = getClanGuardsOverview;
/**
 * Guards (Guardsmen) levels per member — the Guardsmen tier from the member's
 * own research, as the game reports it (data/member-tiers.ts,
 * game-protocol/troop-tiers.ts). Nothing here is inferred: a member whose
 * research has not been read from the game has no level.
 *
 * Level-ups are the Guardsmen tier changes seen after the member's first
 * research read, each dated between the read before it ("after") and the read
 * that saw it ("by"). A tier held at the first read was reached at some point
 * before it, so it is not a level-up.
 *
 * Until Nov 2026 the level was estimated from Omen Essence and Scientific
 * Tractates donations plus admin entries; that estimate is retired, and the
 * member_guards_reports table those entries went into is kept, unread.
 */
const database_js_1 = require("../database.js");
const ttl_cache_js_1 = require("../../utils/ttl-cache.js");
const game_day_js_1 = require("../../utils/game-day.js");
const index_js_1 = require("../../config/index.js");
const member_tiers_js_1 = require("../member-tiers.js");
const guards_levels_js_1 = require("../../config/guards-levels.js");
const CACHE_TTL_MS = 60_000;
/**
 * memberId → sorted game days their city (research) was read, for dating a
 * level-up between two reads.
 */
function readDays(clanId) {
    const rows = (0, database_js_1.getDb)().prepare(`
    SELECT m.id AS memberId, s.game_date AS day
      FROM members m
      JOIN game_city_snapshots s ON s.clan_id = m.clan_id AND s.player_id = m.game_player_id
     WHERE m.clan_id = ?
     ORDER BY m.id, s.game_date
  `).all(clanId);
    const out = new Map();
    for (const r of rows) {
        const list = out.get(r.memberId);
        if (list)
            list.push(r.day);
        else
            out.set(r.memberId, [r.day]);
    }
    return out;
}
/**
 * Every member's Guardsmen level for one clan; members whose research has not
 * been read (or who have no Guardsmen unlock) are absent.
 *
 * Returns a SHARED cached Map — read it, never mutate it.
 */
function getGuardsLevels(clanId) {
    return (0, ttl_cache_js_1.cached)(`guards:${clanId}:levels`, CACHE_TTL_MS, () => {
        const rollover = (0, index_js_1.loadConfig)().gameDayRolloverUtcHour;
        const day = (iso) => (0, game_day_js_1.gameDateFor)(Date.parse(iso), rollover);
        const days = readDays(clanId);
        const out = new Map();
        for (const [memberId, m] of (0, member_tiers_js_1.getMemberTiers)(clanId)) {
            const level = m.tiers.guardsmen;
            if (!level)
                continue;
            const firstSeen = day(m.firstReadAt);
            const reads = days.get(memberId) ?? [];
            const levelUps = [];
            for (const c of m.changes.guardsmen) {
                if (c.from === null)
                    continue;
                const by = day(c.at);
                // The newest read before the one that saw it; failing that, the first read.
                let after = firstSeen;
                for (const d of reads)
                    if (d < by)
                        after = d;
                levelUps.push({ from: c.from, to: c.to, after, by });
            }
            out.set(memberId, { level, asOf: day(m.readAt), firstSeen, levelUps });
        }
        return out;
    });
}
/** Cut a member's level down to what a table cell shows. `today` is a game day. */
function summarizeGuards(g, today) {
    const age = (0, game_day_js_1.daysBetweenGameDates)(g.asOf, today);
    return {
        level: g.level,
        asOf: g.asOf,
        stale: age !== null && age > guards_levels_js_1.GUARDS_STALE_DAYS,
        lastLevelUp: g.levelUps.length > 0 ? g.levelUps[g.levelUps.length - 1] : null,
    };
}
/** memberId → summary for every member with a level. */
function getGuardsSummaries(clanId, today) {
    const out = new Map();
    for (const [memberId, g] of getGuardsLevels(clanId))
        out.set(memberId, summarizeGuards(g, today));
    return out;
}
/** The clan's make-up for the Analytics overview — active members only. */
function getClanGuardsOverview(clanId, today, recentDays = 30) {
    const active = (0, database_js_1.getDb)().prepare('SELECT id, name FROM members WHERE clan_id = ? AND is_active = 1').all(clanId);
    const levels = getGuardsLevels(clanId);
    const counts = new Map();
    let known = 0;
    let stale = 0;
    const recentLevelUps = [];
    for (const m of active) {
        const g = levels.get(m.id);
        if (!g)
            continue;
        known++;
        counts.set(g.level, (counts.get(g.level) ?? 0) + 1);
        if (summarizeGuards(g, today).stale)
            stale++;
        for (const up of g.levelUps) {
            const age = (0, game_day_js_1.daysBetweenGameDates)(up.by, today);
            if (age !== null && age <= recentDays)
                recentLevelUps.push({ ...up, memberId: m.id, name: m.name });
        }
    }
    recentLevelUps.sort((a, b) => (a.by < b.by ? 1 : a.by > b.by ? -1 : a.name.localeCompare(b.name)));
    return {
        distribution: [...counts.entries()].sort((a, b) => b[0] - a[0]).map(([level, members]) => ({ level, members })),
        known,
        unknown: active.length - known,
        stale,
        recentLevelUps,
    };
}
//# sourceMappingURL=guards-repo.js.map