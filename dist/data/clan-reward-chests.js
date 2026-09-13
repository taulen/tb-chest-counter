"use strict";
/**
 * Clan-reward chests — the end-of-event placement prizes the game hands to ONE
 * account on the whole clan's behalf, and which therefore must not be credited
 * to that member on any surface that ranks members against each other.
 *
 * Why this exists: on the 2026-08-24 Trials of Olympus run the clan's leader
 * received 1006 Olympus Elite Chests in a single 59-second drop. That one drop
 * owned two of the clan's three all-time "most chests in a day" podium slots
 * and its all-time #1 chest total, for chests nobody farmed — MAX() over a
 * game-day bucket makes such a record permanent and unbeatable. The same is
 * true of Dark Omens' ranking chest and the plain Olympus Chest.
 *
 * The declaration lives in EVENT_CATALOG (`clanReward: true`), not here, so a
 * new event's reward is declared once next to the rest of that event's config.
 * This module only resolves those names to `chests.id`.
 *
 * WHAT IS AND ISN'T FILTERED — the rule is "ranking vs holdings":
 *  - Excluded: every member RANKING and personal-best figure — best single day,
 *    all-time top contributors, the leaderboard (and so the public share board,
 *    the Discord digest and the member rank badge).
 *  - Kept: clan grand totals, the daily activity charts, the chest catalog, the
 *    per-chest drill-down, every audit view, and a member's own chest history.
 *    The clan does hold these chests; the events page shows who received them.
 *
 * Resolution is deliberately forgiving in the same three tiers as
 * resolvePredicate (exact → correctChestName → accent/case/punctuation fold),
 * because the failure mode here is the mirror image of the Ragnarok zero and
 * worse: a stranded name doesn't blank a column, it silently puts 1006 chests
 * back onto one member's record where they look like a real result. So an
 * unresolved name warns, and a set that resolves to nothing at all is an error.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.clanRewardChestNames = clanRewardChestNames;
exports.clanRewardChestIds = clanRewardChestIds;
exports.clanRewardExclusionSql = clanRewardExclusionSql;
const database_js_1 = require("./database.js");
const event_catalog_js_1 = require("../config/event-catalog.js");
const chest_names_js_1 = require("../vision/chest-names.js");
const ocr_normalize_js_1 = require("../vision/ocr-normalize.js");
const logger_js_1 = require("../utils/logger.js");
const log = (0, logger_js_1.childLogger)('clan-rewards');
// One line per bad name for the life of the process. NOT log-throttle: this is
// a permanent configuration defect, not a hot-path burst, and it must not be
// evicted from the 20-entry System ring buffer by a later repeat of itself.
const warned = new Set();
function warnOnce(key, message, noAlert = false) {
    if (warned.has(key))
        return;
    warned.add(key);
    if (noAlert)
        log.warn({ noAlert: true }, message);
    else
        log.warn(message);
}
/** Accent-, case- and punctuation-insensitive identity of a chest name. */
function foldKey(s) {
    return (0, ocr_normalize_js_1.foldDiacritics)(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}
/**
 * Every chest name the catalog declares as a clan reward. Derived from
 * EVENT_CATALOG on every call — it's a handful of array reads over a frozen
 * literal, and deriving it means a new event's reward is picked up by declaring
 * it in one place.
 */
function clanRewardChestNames() {
    return event_catalog_js_1.EVENT_CATALOG.flatMap((def) => def.rules)
        .filter((rule) => rule.clanReward)
        .flatMap((rule) => [
        ...(rule.chestName ? [rule.chestName] : []),
        ...(rule.chestNames || []),
    ]);
}
/**
 * Those names resolved against the live `chests` table. Not cached: `chests`
 * holds ~90 rows on production and the whole read measures 0.2ms, whereas a
 * cache would have to be invalidated by the scan path that mints a new chest
 * row moments before the post-scan rollup rebuild.
 */
function clanRewardChestIds() {
    const rows = (0, database_js_1.getDb)().prepare('SELECT id, name FROM chests').all();
    const byExact = new Map();
    const byFold = new Map();
    for (const row of rows) {
        byExact.set(row.name, row.id);
        const folded = foldKey(row.name);
        if (folded && !byFold.has(folded))
            byFold.set(folded, row.id);
    }
    const declared = clanRewardChestNames();
    const ids = [];
    for (const name of declared) {
        const exact = byExact.get(name);
        if (exact !== undefined) {
            ids.push(exact);
            continue;
        }
        const corrected = (0, chest_names_js_1.correctChestName)(name);
        const hit = (corrected !== name ? byExact.get(corrected) : undefined) ?? byFold.get(foldKey(name));
        if (hit !== undefined) {
            ids.push(hit);
            warnOnce(name, `Clan-reward chest "${name}" is a stale spelling of a chest the database holds under `
                + 'another name. Still excluded from member rankings, but correct the literal in '
                + 'src/config/event-catalog.ts.');
        }
        else {
            // noAlert, and not an error on its own: a fresh install holds no chests
            // at all, and pre-declaring one is supported — so this is the normal
            // state of a clan that has never placed in that event. Lighting the
            // System dot for it is the noise checkConfigIntegrity is careful to
            // avoid; that sweep already reports the same names properly, against a
            // database that actually has chest records.
            warnOnce(name, `Clan-reward chest "${name}" matches no chest in the database, so nothing is excluded `
                + 'for it. Expected until the chest is first scanned; otherwise the name in '
                + 'src/config/event-catalog.ts is wrong.', true);
        }
    }
    return ids;
}
/**
 * `AND <alias>chest_id NOT IN (…)` for splicing into a WHERE clause, or an
 * empty string when nothing resolved.
 *
 * Failing OPEN (no filter) is deliberate: it is exactly today's behaviour, so a
 * name that goes stale over-counts rather than blanking a board — and
 * clanRewardChestIds has already said so in the log.
 *
 * The ids are integers straight out of `chests.id` and are re-checked here
 * before interpolation, because a bound parameter list can't be spliced into a
 * fragment without forcing every caller to thread the params through too.
 */
function clanRewardExclusionSql(columnPrefix = '') {
    const ids = clanRewardChestIds().filter((id) => Number.isInteger(id));
    if (ids.length === 0)
        return '';
    return ` AND ${columnPrefix}chest_id NOT IN (${ids.join(',')})`;
}
//# sourceMappingURL=clan-reward-chests.js.map