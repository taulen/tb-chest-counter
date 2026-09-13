"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveSnapshots = saveSnapshots;
exports.hasSnapshotForGameDate = hasSnapshotForGameDate;
exports.getLastCaptureAt = getLastCaptureAt;
exports.getSnapshotDates = getSnapshotDates;
exports.getMightWithDelta = getMightWithDelta;
exports.getLatestMightByMember = getLatestMightByMember;
exports.getLatestForMember = getLatestForMember;
exports.getMemberHistory = getMemberHistory;
exports.getClanTotals = getClanTotals;
exports.getSeriesForMembers = getSeriesForMembers;
/**
 * Daily "might" (power level) snapshots for clan members.
 *
 * Storage is the pre-existing `member_snapshots` table — see migration v57 for
 * why this reuses it instead of adding a table. One row per (member, game day),
 * keyed on the game-day date rather than a wall-clock timestamp so a re-capture
 * on the same day overwrites rather than duplicating.
 *
 * Boundary note: this is *our own* OCR-read data, keyed on `members(id)`. It is
 * deliberately unrelated to the ChestTracker import (`snapshot`,
 * `player_snapshot`, `ct_player_ref`, …) — nothing here reads or writes those
 * tables, and nothing there should ever join to these rows. The two datasets
 * answer different questions and must be able to break independently.
 *
 * `level` is the account level from the avatar badge — the column the v30 bootstrap
 * created for it and nothing ever filled. It's only populated when the calibrated
 * crop reaches left far enough to include the avatars, which the default calibration
 * does not; 0 means "not read", since the column is NOT NULL and rebuilding the
 * table to allow NULL isn't worth it. Filter on `level > 0`.
 */
const database_js_1 = require("../database.js");
const ttl_cache_js_1 = require("../../utils/ttl-cache.js");
/** Charts are read-mostly and the underlying data changes once a day. */
const CHART_CACHE_TTL_MS = 60_000;
function dropCaches(clanId) {
    (0, ttl_cache_js_1.invalidate)(`might:${clanId}:`);
}
/**
 * Indices of the longest non-decreasing subsequence of `values`.
 *
 * Patience-style, O(n log n), with predecessor links so the actual chain comes back
 * rather than just its length — the whole point here is *which* readings to keep.
 * `<=` in the search makes it non-DEcreasing rather than strictly increasing, which
 * matters enormously: a hero level holds the same value for weeks at a time, and a
 * strict version would throw away every repeat.
 */
function longestNonDecreasingIndices(values) {
    /** tails[k] = index of the smallest tail among chains of length k+1. */
    const tails = [];
    const prev = new Array(values.length).fill(-1);
    for (let i = 0; i < values.length; i++) {
        let lo = 0;
        let hi = tails.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (values[tails[mid]] <= values[i])
                lo = mid + 1;
            else
                hi = mid;
        }
        prev[i] = lo > 0 ? tails[lo - 1] : -1;
        if (lo === tails.length)
            tails.push(i);
        else
            tails[lo] = i;
    }
    const keep = new Set();
    for (let k = tails.length > 0 ? tails[tails.length - 1] : -1; k >= 0; k = prev[k])
        keep.add(k);
    return keep;
}
/**
 * Every hero-level reading this clan holds that its own history actually supports,
 * as memberId → (game day → level). A reading the invariant rejects is simply
 * absent, which callers surface as null — the same "not read" state a day the OCR
 * couldn't see the avatar already produces, and which the charts already span.
 *
 * WHY this exists rather than trusting the column:
 *
 * A hero level cannot go down. It is a monotonically rising number in the game, so
 * any downward step in a member's series is measurement error by definition — and
 * production had them everywhere: 108 of 237 members with at least one drop across
 * fifteen game days, which is what made the member chart's level line saw-tooth. The
 * capture-side cause (a badge matched against the EDGE of a member's row band, so a
 * pixel of jitter handed it to the member above — see browser/might-capture.ts's
 * ownerForBadge) is fixed, but two things still need this:
 *
 *   - the fifteen days already in the database, which no capture fix can revisit;
 *   - the residue, because OCR never reaches zero error and one bad reading is
 *     enough to put a visible cliff in a chart of a quantity that cannot fall.
 *
 * Deliberately NOT a write-side ratchet. Clamping on the way in would bake a single
 * bad HIGH read in permanently — the same capture bug produced 367 for a level-179
 * member — and every correct reading afterwards would then be the one rejected.
 * Filtering on read recomputes from the raw rows every time, so one more day of
 * evidence can overturn any earlier judgement, and the table keeps saying exactly
 * what the scanner saw.
 *
 * The rule is the physical invariant and nothing more. It does NOT cap how fast a
 * level may rise: that would be a guess, and monotonicity is a fact. So a single
 * implausible spike between two stable stretches is dropped (keeping the long chain
 * beats keeping the spike), while a genuine jump after a gap in coverage survives.
 */
function trustedHeroLevels(clanId, memberIds) {
    const db = (0, database_js_1.getDb)();
    const filter = memberIds && memberIds.length > 0
        ? `AND member_id IN (${memberIds.map(() => '?').join(',')})`
        : '';
    // Deliberately the FULL history, never the caller's window: the chain that decides
    // which readings are trustworthy is a property of the whole series, and judging a
    // 30-day view on its own would let the window boundary change the answer.
    const rows = db.prepare(`
    SELECT member_id AS memberId, game_date AS gameDate, level
    FROM member_snapshots
    WHERE clan_id = ? AND game_date != '' AND level > 0 ${filter}
    ORDER BY member_id ASC, game_date ASC
  `).all(clanId, ...(memberIds ?? []));
    const byMember = new Map();
    for (const r of rows) {
        const list = byMember.get(r.memberId);
        if (list)
            list.push(r);
        else
            byMember.set(r.memberId, [r]);
    }
    const out = new Map();
    for (const [memberId, series] of byMember) {
        const keep = longestNonDecreasingIndices(series.map((s) => s.level));
        const kept = new Map();
        series.forEach((s, i) => { if (keep.has(i))
            kept.set(s.gameDate, s.level); });
        out.set(memberId, kept);
    }
    return out;
}
/** The most recent trusted reading in one member's map, or null when it is empty.
 *  The map is built in game-day order, so the last entry is the newest. */
function latestTrusted(kept) {
    if (!kept || kept.size === 0)
        return null;
    let last = null;
    for (const level of kept.values())
        last = level;
    return last;
}
/**
 * Write one game-day's snapshots for a clan.
 *
 * Idempotent per (member, game day): re-running the capture on the same game
 * day updates the existing rows, so a manual re-scan or a second scheduled
 * cycle after a partial failure can't produce two readings for one day. Runs as
 * a single transaction — a might capture is either wholly recorded or not at
 * all, so a half-written day can't skew a growth chart.
 *
 * Returns the number of rows written (inserted + updated).
 */
function saveSnapshots(clanId, gameDate, capturedAtIso, rows) {
    if (rows.length === 0)
        return 0;
    const db = (0, database_js_1.getDb)();
    // The conflict target repeats the partial index's WHERE clause — SQLite
    // requires that to resolve an upsert against a partial unique index.
    // COALESCE on update so a re-capture never blanks an existing evidence crop:
    // the crop is only produced on the day a member was new, and a forced re-run
    // later that same day would otherwise overwrite the path with NULL.
    // `level` guards ONLY against the 0 placeholder, for the same reason COALESCE
    // guards the crop: a re-capture whose crop clipped the avatar must not overwrite a
    // level already read with "not read". Any genuine reading wins, including a lower
    // one.
    //
    // This was MAX(excluded.level, member_snapshots.level) until the hero-level
    // investigation, on the argument that levels only ever go up. They do — but a
    // MISREAD doesn't, and the ratchet made every wrong-high value permanent for its
    // game day. The badge mis-assignment that filed one member's level under their
    // neighbour put values like 367 on a level-179 player, and "Re-capture now" then
    // could not correct it, which is precisely what that action promises to do (see
    // `force` in scheduler/might-capture-phase.ts). Judging which readings a member's
    // history supports is the read side's job — trustedHeroLevels — and it can only do
    // that honestly if the write side stops editorialising.
    const stmt = db.prepare(`
    INSERT INTO member_snapshots (member_id, clan_id, level, power, captured_at, game_date, row_crop_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(member_id, game_date) WHERE game_date != ''
    DO UPDATE SET power = excluded.power,
                  level = CASE WHEN excluded.level > 0
                               THEN excluded.level ELSE member_snapshots.level END,
                  captured_at = excluded.captured_at,
                  row_crop_path = COALESCE(excluded.row_crop_path, member_snapshots.row_crop_path)
  `);
    const tx = db.transaction((batch) => {
        let n = 0;
        for (const row of batch) {
            stmt.run(row.memberId, clanId, row.level ?? 0, row.might, capturedAtIso, gameDate, row.cropPath ?? null);
            n++;
        }
        return n;
    });
    const written = tx(rows);
    dropCaches(clanId);
    return written;
}
/**
 * True when this clan already has a snapshot for the given game day. The
 * scheduler's once-a-day gate: cheap enough to run every scan cycle, and it
 * makes the capture self-healing across downtime without any persisted
 * catch-up state (same property the inactivity sweep relies on).
 */
function hasSnapshotForGameDate(clanId, gameDate) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare(`SELECT 1 AS hit FROM member_snapshots
     WHERE clan_id = ? AND game_date = ? LIMIT 1`).get(clanId, gameDate);
    return row !== undefined;
}
/** When this clan's most recent might capture ran, or null if never. */
function getLastCaptureAt(clanId) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare(`SELECT captured_at AS capturedAt, game_date AS gameDate
     FROM member_snapshots
     WHERE clan_id = ? AND game_date != ''
     ORDER BY game_date DESC, captured_at DESC LIMIT 1`).get(clanId);
    return row ?? null;
}
/** Distinct game days this clan has data for, oldest first. */
function getSnapshotDates(clanId) {
    const db = (0, database_js_1.getDb)();
    const rows = db.prepare(`SELECT DISTINCT game_date AS d FROM member_snapshots
     WHERE clan_id = ? AND game_date != '' ORDER BY d ASC`).all(clanId);
    return rows.map((r) => r.d);
}
/**
 * Latest might per active member, plus the change over `deltaDays`.
 *
 * The baseline is the newest snapshot at or before (latest - deltaDays), not
 * the snapshot exactly N days back: captures can be missed (container down over
 * a rollover, a failed scan cycle), and a strict date match would blank the
 * delta column for everyone whenever that happened. Members with no snapshot at
 * all are omitted — the caller left-joins them back in as "no data yet" so a
 * freshly-onboarded clan doesn't show a column of zeroes that look like real
 * readings.
 */
function getMightWithDelta(clanId, deltaDays = 7) {
    return (0, ttl_cache_js_1.cached)(`might:${clanId}:delta:${deltaDays}`, CHART_CACHE_TTL_MS, () => {
        const db = (0, database_js_1.getDb)();
        const rows = db.prepare(`
      WITH ranked AS (
        SELECT member_id, game_date, power, level,
               ROW_NUMBER() OVER (PARTITION BY member_id ORDER BY game_date DESC) AS rn
        FROM member_snapshots
        WHERE clan_id = ? AND game_date != ''
      ),
      latest AS (SELECT member_id, game_date, power, level FROM ranked WHERE rn = 1)
      SELECT
        m.id                AS memberId,
        m.name              AS name,
        l.power             AS might,
        l.game_date         AS gameDate,
        (SELECT s.power FROM member_snapshots s
           WHERE s.member_id = m.id AND s.clan_id = ? AND s.game_date != ''
             AND s.game_date <= date(l.game_date, ?)
           ORDER BY s.game_date DESC LIMIT 1) AS baselineMight,
        (SELECT s.game_date FROM member_snapshots s
           WHERE s.member_id = m.id AND s.clan_id = ? AND s.game_date != ''
             AND s.game_date <= date(l.game_date, ?)
           ORDER BY s.game_date DESC LIMIT 1) AS baselineDate
      FROM members m
      JOIN latest l ON l.member_id = m.id
      WHERE m.clan_id = ? AND m.is_active = 1
      ORDER BY l.power DESC
    `).all(clanId, clanId, `-${deltaDays} days`, clanId, `-${deltaDays} days`, clanId);
        // The member's newest reading the invariant supports, which is NOT necessarily
        // the one on `gameDate`: if today's badge read low, today is the reading the
        // series rejects, and yesterday's is the level this player actually holds.
        const trusted = trustedHeroLevels(clanId);
        return rows.map((r) => ({
            ...r,
            heroLevel: latestTrusted(trusted.get(r.memberId)),
            delta: r.baselineMight === null ? null : r.might - r.baselineMight,
        }));
    });
}
/**
 * Latest might + hero level for every member of a clan, keyed by member id.
 *
 * The lean sibling of getMightWithDelta: the leaderboard decorates each row with
 * these two numbers and has no use for the baseline/delta correlated subqueries,
 * which are the expensive half of that query. Members with no snapshot are simply
 * absent from the map — the caller renders them as "—" rather than as a zero that
 * would sort like a real reading.
 *
 * Hero level comes from trustedHeroLevels, NOT from the latest row: a badge that
 * read low today is the reading the series rejects, and the level the player
 * actually holds is the newest one the history supports. Sharing that helper is
 * what keeps the leaderboard's level column from disagreeing with the Might page
 * about the same member on the same day.
 */
function getLatestMightByMember(clanId) {
    return (0, ttl_cache_js_1.cached)(`might:${clanId}:latest-by-member`, CHART_CACHE_TTL_MS, () => {
        const db = (0, database_js_1.getDb)();
        const rows = db.prepare(`
      WITH ranked AS (
        SELECT member_id, game_date, power,
               ROW_NUMBER() OVER (PARTITION BY member_id ORDER BY game_date DESC) AS rn
        FROM member_snapshots
        WHERE clan_id = ? AND game_date != ''
      )
      SELECT member_id AS memberId, power AS might, game_date AS gameDate
      FROM ranked WHERE rn = 1
    `).all(clanId);
        const trusted = trustedHeroLevels(clanId);
        const out = new Map();
        for (const r of rows) {
            out.set(r.memberId, {
                might: r.might,
                heroLevel: latestTrusted(trusted.get(r.memberId)),
                gameDate: r.gameDate,
            });
        }
        return out;
    });
}
/**
 * A member's most recent reading: current might, hero level, and which game day it
 * came from. Null when they have never been captured.
 *
 * Separate from getMemberHistory because the member page wants the current values as
 * headline stats even when there aren't yet two points to draw a trend from.
 */
function getLatestForMember(memberId, clanId) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare(`SELECT power AS might, game_date AS gameDate
     FROM member_snapshots
     WHERE member_id = ? AND clan_id = ? AND game_date != ''
     ORDER BY game_date DESC LIMIT 1`).get(memberId, clanId);
    if (!row)
        return null;
    // The headline "Hero level" is the level this member HOLDS, so it comes from the
    // newest trusted reading rather than from the newest row — those differ exactly
    // when the newest row is the one the history rejects.
    return { ...row, heroLevel: latestTrusted(trustedHeroLevels(clanId, [memberId]).get(memberId)) };
}
/**
 * One member's full might history, oldest first. `days` limits the window to
 * the most recent N game days (0 / omitted = everything).
 */
function getMemberHistory(memberId, clanId, days = 0) {
    const db = (0, database_js_1.getDb)();
    const clause = days > 0
        ? `AND game_date >= date((SELECT MAX(game_date) FROM member_snapshots
                              WHERE clan_id = ? AND game_date != ''), ?)`
        : '';
    const params = [memberId, clanId];
    if (days > 0)
        params.push(clanId, `-${days} days`);
    const rows = db.prepare(`
    SELECT game_date AS gameDate, power AS might
    FROM member_snapshots
    WHERE member_id = ? AND clan_id = ? AND game_date != '' ${clause}
    ORDER BY game_date ASC
  `).all(...params);
    // Judged over the whole history, then read back through this window — a reading
    // near the window's left edge is only judgeable against what came before it.
    const trusted = trustedHeroLevels(clanId, [memberId]).get(memberId);
    return rows.map((r) => ({ ...r, heroLevel: trusted?.get(r.gameDate) ?? null }));
}
/**
 * Clan-wide might per game day. `memberCount` travels with the total because
 * the two move together — a total that jumps 400M because three big players
 * joined is not growth, and a chart without the headcount makes that
 * indistinguishable from everyone levelling up.
 *
 * Counts every member with a snapshot that day, including ones since gone
 * inactive, so a historical point keeps reporting what the clan actually was
 * at the time rather than being retroactively rewritten by the roster changing.
 */
function getClanTotals(clanId, days = 90) {
    return (0, ttl_cache_js_1.cached)(`might:${clanId}:totals:${days}`, CHART_CACHE_TTL_MS, () => {
        const db = (0, database_js_1.getDb)();
        return db.prepare(`
      SELECT game_date       AS gameDate,
             SUM(power)      AS totalMight,
             COUNT(*)        AS memberCount
      FROM member_snapshots
      WHERE clan_id = ? AND game_date != ''
        AND game_date >= date((SELECT MAX(game_date) FROM member_snapshots
                               WHERE clan_id = ? AND game_date != ''), ?)
      GROUP BY game_date
      ORDER BY game_date ASC
    `).all(clanId, clanId, `-${days} days`);
    });
}
/**
 * Parallel series for the comparison chart. Members are returned in the order
 * requested so the frontend's colour assignment is stable as the user toggles
 * selections, and an id with no snapshots still comes back (with an empty
 * points array) so the UI can say so rather than silently dropping it.
 *
 * Clan-scoped on both the member and the snapshot so a caller can't read
 * another clan's series by passing its member ids.
 */
function getSeriesForMembers(clanId, memberIds, days = 90) {
    if (memberIds.length === 0)
        return [];
    const db = (0, database_js_1.getDb)();
    const placeholders = memberIds.map(() => '?').join(',');
    const names = db.prepare(`SELECT id, name FROM members WHERE clan_id = ? AND id IN (${placeholders})`).all(clanId, ...memberIds);
    const nameById = new Map(names.map((n) => [n.id, n.name]));
    const rows = db.prepare(`
    SELECT member_id AS memberId, game_date AS gameDate, power AS might
    FROM member_snapshots
    WHERE clan_id = ? AND game_date != '' AND member_id IN (${placeholders})
      AND game_date >= date((SELECT MAX(game_date) FROM member_snapshots
                             WHERE clan_id = ? AND game_date != ''), ?)
    ORDER BY game_date ASC
  `).all(clanId, ...memberIds, clanId, `-${days} days`);
    const trusted = trustedHeroLevels(clanId, memberIds);
    const byMember = new Map();
    for (const r of rows) {
        const list = byMember.get(r.memberId) ?? [];
        list.push({
            gameDate: r.gameDate,
            might: r.might,
            heroLevel: trusted.get(r.memberId)?.get(r.gameDate) ?? null,
        });
        byMember.set(r.memberId, list);
    }
    return memberIds
        .filter((id) => nameById.has(id))
        .map((id) => ({
        memberId: id,
        name: nameById.get(id),
        points: byMember.get(id) ?? [],
    }));
}
//# sourceMappingURL=might-repo.js.map