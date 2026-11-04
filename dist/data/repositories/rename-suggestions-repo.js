"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RENAME_SUGGESTION_WINDOW_DAYS = void 0;
exports.getRenameSuggestions = getRenameSuggestions;
exports.dismissRenameSuggestion = dismissRenameSuggestion;
/**
 * Likely in-game renames, surfaced in the admin Review Queue as merge suggestions.
 *
 * A rename leaves no trace in a name — "Cauldron" became "Aldrin", "IamNotHades"
 * became "Atlas" — so the app can only see it as two members: the old one stops being
 * read and a new one appears. Nothing joins them, so the player's history is split
 * across two rows and every leaderboard shows them short. The live sweep in Nov 2026
 * found eleven such pairs nobody had merged.
 *
 * The evidence is the daily might capture. A player appears on the in-game member
 * list exactly once a day, so a rename shows up as one member's might series ENDING
 * and another's BEGINNING a day later, at the same hero level and within a percent of
 * the same might. Two different players matching on all of that, on consecutive days,
 * with the first one never read again, is not a coincidence that happens.
 *
 * Suggestions only — merging is an admin's call (two alts of one owner can hand over
 * the same way, and only a person knows). "Not the same player" is remembered per pair
 * in `rename_suggestion_dismissals`.
 */
const database_js_1 = require("../database.js");
/** How recent the new name's first reading must be for a pair to be suggested. */
exports.RENAME_SUGGESTION_WINDOW_DAYS = 30;
/** Days the might series may skip between the old name's last read and the new one's first. */
const MAX_GAP_DAYS = 3;
/** Might ratio new/old allowed across the hand-over: a day or three of growth, never a drop. */
const MIN_POWER_RATIO = 0.99;
const MAX_POWER_RATIO = 1.04;
/** Hero levels gained across the hand-over. */
const MAX_LEVEL_GAIN = 8;
/**
 * Days after the new name's first reading during which the old name may still collect
 * chests: gifts sent before the rename keep the old name on their card for their ~20h
 * life (live: "From: Cauldron" cards were still being opened hours after the rename).
 */
const OLD_NAME_GRACE_DAYS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const dayMs = (gameDate) => Date.parse(`${gameDate}T00:00:00Z`);
/** Likely renames for a clan, best match first. Pure read. */
function getRenameSuggestions(clanId, nowMs = Date.now()) {
    const db = (0, database_js_1.getDb)();
    // One row per member that has a might series: its first and last reading, plus its
    // chest total and newest chest. Readings with a blank game_date (pre-v57) can't be
    // placed on a day, so they don't take part.
    const rows = db.prepare(`
    WITH s AS (
      SELECT member_id, game_date, level, power,
             ROW_NUMBER() OVER (PARTITION BY member_id ORDER BY game_date ASC)  AS asc_rank,
             ROW_NUMBER() OVER (PARTITION BY member_id ORDER BY game_date DESC) AS desc_rank
        FROM member_snapshots
       WHERE clan_id = ? AND game_date != '' AND power > 0
    )
    SELECT m.id AS memberId, m.name, m.is_active AS isActive,
           COALESCE(c.cnt, 0) AS chests, c.lastAt AS lastChestAt,
           f.game_date AS firstDate, f.level AS firstLevel, f.power AS firstPower,
           l.game_date AS lastDate,  l.level AS lastLevel,  l.power AS lastPower
      FROM members m
      JOIN s f ON f.member_id = m.id AND f.asc_rank = 1
      JOIN s l ON l.member_id = m.id AND l.desc_rank = 1
      LEFT JOIN (SELECT member_id, COUNT(*) AS cnt, MAX(captured_at) AS lastAt
                   FROM chest_records WHERE clan_id = ? GROUP BY member_id) c
             ON c.member_id = m.id
     WHERE m.clan_id = ?
  `).all(clanId, clanId, clanId);
    const dismissed = new Set(db.prepare('SELECT from_member_id AS f, to_member_id AS t FROM rename_suggestion_dismissals WHERE clan_id = ?')
        .all(clanId).map((d) => `${d.f}>${d.t}`));
    const windowStart = nowMs - exports.RENAME_SUGGESTION_WINDOW_DAYS * DAY_MS;
    const candidates = [];
    for (const to of rows) {
        const toStart = dayMs(to.firstDate);
        if (toStart < windowStart)
            continue;
        for (const from of rows) {
            if (from.memberId === to.memberId || dismissed.has(`${from.memberId}>${to.memberId}`))
                continue;
            // The old series must END before the new one BEGINS: one player is on the list
            // once a day, so any overlap means two players.
            const gapDays = (toStart - dayMs(from.lastDate)) / DAY_MS;
            if (gapDays < 1 || gapDays > MAX_GAP_DAYS)
                continue;
            const ratio = to.firstPower / from.lastPower;
            if (ratio < MIN_POWER_RATIO || ratio > MAX_POWER_RATIO)
                continue;
            // A 0 is the badge failing to read, not a level — compare only real values.
            if (from.lastLevel > 0 && to.firstLevel > 0) {
                const gain = to.firstLevel - from.lastLevel;
                if (gain < 0 || gain > MAX_LEVEL_GAIN)
                    continue;
            }
            // The old name must have stopped collecting too, past the leftover-card grace.
            if (from.lastChestAt !== null && from.lastChestAt > toStart + OLD_NAME_GRACE_DAYS * DAY_MS)
                continue;
            candidates.push({ from, to, ratio });
        }
    }
    // Closest might first, then each member used once: a member can only have been
    // renamed into one name, and a name can only have come from one member.
    candidates.sort((a, b) => Math.abs(a.ratio - 1) - Math.abs(b.ratio - 1));
    const usedFrom = new Set();
    const usedTo = new Set();
    const out = [];
    for (const c of candidates) {
        if (usedFrom.has(c.from.memberId) || usedTo.has(c.to.memberId))
            continue;
        usedFrom.add(c.from.memberId);
        usedTo.add(c.to.memberId);
        out.push({
            from: side(c.from, 'last'),
            to: side(c.to, 'first'),
            powerChangePct: Math.round((c.ratio - 1) * 10000) / 100,
        });
    }
    return out.sort((a, b) => b.to.gameDate.localeCompare(a.to.gameDate));
}
function side(r, which) {
    return {
        memberId: r.memberId,
        name: r.name,
        isActive: r.isActive === 1,
        chests: r.chests,
        gameDate: which === 'first' ? r.firstDate : r.lastDate,
        level: which === 'first' ? r.firstLevel : r.lastLevel,
        power: which === 'first' ? r.firstPower : r.lastPower,
    };
}
/** Remember that an admin said this pair is two different players. */
function dismissRenameSuggestion(clanId, fromMemberId, toMemberId) {
    (0, database_js_1.getDb)().prepare(`INSERT INTO rename_suggestion_dismissals (clan_id, from_member_id, to_member_id, dismissed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(clan_id, from_member_id, to_member_id) DO NOTHING`).run(clanId, fromMemberId, toMemberId, new Date().toISOString());
}
//# sourceMappingURL=rename-suggestions-repo.js.map