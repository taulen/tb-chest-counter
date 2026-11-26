"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIN_CLAN_SCAN_INTERVAL_MINUTES = void 0;
exports.slugifyClanName = slugifyClanName;
exports.clanLabel = clanLabel;
exports.normalizeShortCode = normalizeShortCode;
exports.listClans = listClans;
exports.listDeletedClans = listDeletedClans;
exports.getClanById = getClanById;
exports.getClanByIdIncludingDeleted = getClanByIdIncludingDeleted;
exports.getClanBySlug = getClanBySlug;
exports.clanCount = clanCount;
exports.createClan = createClan;
exports.renameClan = renameClan;
exports.setClanActive = setClanActive;
exports.setClanScanIntervalMinutes = setClanScanIntervalMinutes;
exports.setClanPublicUrl = setClanPublicUrl;
exports.clanPublicUrl = clanPublicUrl;
exports.setClanLeaderboardGoal = setClanLeaderboardGoal;
exports.listGoalHistory = listGoalHistory;
exports.setClanWeekStart = setClanWeekStart;
exports.getClanWeekStart = getClanWeekStart;
exports.setClanSeasonalKingdom = setClanSeasonalKingdom;
exports.weekStartAllowed = weekStartAllowed;
exports.clanCalendarRealm = clanCalendarRealm;
exports.getClanAncientDefaults = getClanAncientDefaults;
exports.setClanAncientDefaults = setClanAncientDefaults;
exports.setClanDiscordSettings = setClanDiscordSettings;
exports.setClanLastDigestStatus = setClanLastDigestStatus;
exports.setClanLastWeeklyDigestStatus = setClanLastWeeklyDigestStatus;
exports.markClanNeedsReauth = markClanNeedsReauth;
exports.clearClanNeedsReauth = clearClanNeedsReauth;
exports.reauthWarningKey = reauthWarningKey;
exports.reauthLegacyMatcher = reauthLegacyMatcher;
exports.setClanChestTrackerSettings = setClanChestTrackerSettings;
exports.softDeleteClan = softDeleteClan;
exports.rehomeAccountsOffDeletedClans = rehomeAccountsOffDeletedClans;
exports.restoreDeletedClan = restoreDeletedClan;
exports.deleteClan = deleteClan;
const database_js_1 = require("../database.js");
const logger_js_1 = require("../../utils/logger.js");
const log_buffer_js_1 = require("../../utils/log-buffer.js");
const game_day_js_1 = require("../../utils/game-day.js");
const ancient_planner_defaults_js_1 = require("../../config/ancient-planner-defaults.js");
const goal_history_js_1 = require("../goal-history.js");
const log = (0, logger_js_1.childLogger)('clan-repo');
/**
 * URL-safe slug. Lowercase, runs of non-alphanumerics collapse to `-`,
 * trimmed. Per project convention we never %20 in user-facing URLs —
 * slug is what the URL resolves on.
 */
function slugifyClanName(name) {
    return name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
/** A clan's label: "CWB - ChaosWithoutBorders" with a short code, else the name alone. */
function clanLabel(name, shortCode) {
    const code = (shortCode ?? '').trim();
    return code ? `${code} - ${name}` : name;
}
/** A short code: 1–8 letters or digits, as typed; '' clears it. Null when invalid. */
function normalizeShortCode(raw) {
    const code = typeof raw === 'string' ? raw.trim() : '';
    if (!code)
        return '';
    return /^[\p{L}\p{N}]{1,8}$/u.test(code) ? code : null;
}
function rowToClan(row) {
    const baseName = row.name;
    const shortCode = row.short_code ?? '';
    return {
        id: row.id,
        name: clanLabel(baseName, shortCode),
        baseName,
        shortCode,
        slug: row.slug,
        gameUrl: row.game_url,
        scanIntervalMinutes: row.scan_interval_minutes == null
            ? null
            : Math.max(exports.MIN_CLAN_SCAN_INTERVAL_MINUTES, row.scan_interval_minutes),
        isActive: !!row.is_active,
        createdAt: row.created_at,
        createdBy: row.created_by ?? null,
        publicUrl: row.public_url || '',
        discordEnabled: !!row.discord_enabled,
        discordToken: row.discord_token || '',
        discordChannelId: row.discord_channel_id || '',
        discordGuildId: row.discord_guild_id || '',
        discordScanReportsEnabled: !!row.discord_scan_reports_enabled,
        discordOnlyNewChests: !!row.discord_only_new_chests,
        discordDailyDigestEnabled: !!row.discord_daily_digest_enabled,
        discordDailyDigestShareUserId: row.discord_daily_digest_share_user_id || '',
        discordCommandsEnabled: !!row.discord_commands_enabled,
        discordWeeklyDigestEnabled: !!row.discord_weekly_digest_enabled,
        ctShareCode: row.ct_share_code || '',
        ctPollIntervalHours: row.ct_poll_interval_hours ?? null,
        ctBackfillWeeks: row.ct_backfill_weeks ?? null,
        lastDigestAt: row.last_digest_at || '',
        lastDigestChannelError: row.last_digest_channel_error || '',
        lastDigestDmError: row.last_digest_dm_error || '',
        lastDigestGameDay: row.last_digest_game_day || '',
        lastWeeklyDigestAt: row.last_weekly_digest_at || '',
        lastWeeklyDigestWeek: row.last_weekly_digest_week || '',
        lastWeeklyDigestError: row.last_weekly_digest_error || '',
        needsReauth: !!row.needs_reauth,
        reauthFailedAt: row.reauth_failed_at || '',
        leaderboardGoalEnabled: !!row.leaderboard_goal_enabled,
        leaderboardWeeklyGoalPoints: row.leaderboard_weekly_goal_points ?? null,
        weekStart: (0, game_day_js_1.isWeekStart)(row.week_start) ? row.week_start : 'sunday',
        seasonalKingdom: !!row.seasonal_kingdom,
        deletedAt: row.deleted_at || '',
    };
}
/**
 * Appended to every clan lookup below.
 *
 * A soft-deleted clan has to disappear from the whole application — the clan
 * picker, the scan loop, the Discord digest, the ChestTracker poller, its own
 * public share link — while its rows stay in place. Doing that at each of the
 * ~50 call sites would be a list nobody could keep complete; doing it in the
 * five functions they all go through is one line each.
 */
const LIVE = "deleted_at = ''";
/** Live clans only. A soft-deleted one is listed by `listDeletedClans`. */
function listClans(options = {}) {
    const db = (0, database_js_1.getDb)();
    const query = options.activeOnly
        ? `SELECT * FROM clans WHERE is_active = 1 AND ${LIVE} ORDER BY id`
        : `SELECT * FROM clans WHERE ${LIVE} ORDER BY id`;
    const rows = db.prepare(query).all();
    return rows.map(rowToClan);
}
/**
 * Soft-deleted clans, newest deletion first — the System page's restore list.
 * Deliberately a separate function rather than a flag on `listClans`: a caller
 * that forgets a flag gets the safe answer, and a caller that wants the
 * deleted ones has to say so.
 */
function listDeletedClans() {
    const db = (0, database_js_1.getDb)();
    const rows = db.prepare("SELECT * FROM clans WHERE deleted_at != '' ORDER BY deleted_at DESC").all();
    return rows.map(rowToClan);
}
function getClanById(id) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare(`SELECT * FROM clans WHERE id = ? AND ${LIVE}`).get(id);
    return row ? rowToClan(row) : null;
}
/**
 * The one lookup that can see a soft-deleted clan. Only the restore path and
 * the deleted-clans listing should use it — everything else wants `getClanById`,
 * which refuses a deleted clan and is why nothing else had to change.
 */
function getClanByIdIncludingDeleted(id) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare('SELECT * FROM clans WHERE id = ?').get(id);
    return row ? rowToClan(row) : null;
}
function getClanBySlug(slug) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare(`SELECT * FROM clans WHERE slug = ? AND ${LIVE}`).get(slug);
    return row ? rowToClan(row) : null;
}
/** Live clans only — this is what the "cannot delete the last clan" guard reads. */
function clanCount() {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare(`SELECT COUNT(*) as c FROM clans WHERE ${LIVE}`).get();
    return row.c;
}
function createClan(input) {
    const db = (0, database_js_1.getDb)();
    const now = new Date().toISOString();
    const shortCode = (input.shortCode ?? '').trim();
    // The slug follows the label, so "CWB" + "ChaosWithoutBorders" keeps the
    // URL a clan created as "CWB - ChaosWithoutBorders" always had.
    const slug = slugifyClanName(clanLabel(input.name.trim(), shortCode));
    if (!slug) {
        throw new Error('Clan name produces an empty slug');
    }
    // game_url is a vestigial NOT NULL column from migration v16; it's
    // populated with the global TB constant for backward-compat but
    // isn't surfaced anywhere in the UI or repos.
    const result = db.prepare(`
    INSERT INTO clans (
      name, short_code, slug, game_url, scan_interval_minutes, is_active, created_at, created_by
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(input.name.trim(), shortCode, slug, 'https://totalbattle.com', input.scanIntervalMinutes ?? null, now, input.createdBy ?? null);
    log.info(`Created clan #${result.lastInsertRowid} "${input.name}" (slug=${slug})`);
    const created = getClanById(result.lastInsertRowid);
    if (!created)
        throw new Error('Failed to read back created clan');
    return created;
}
/**
 * Set a clan's name and short code. The slug follows the label ("CWB -
 * ChaosWithoutBorders" → cwb-chaoswithoutborders), so splitting a name into
 * code + name keeps the clan's URL.
 */
function renameClan(id, newName, shortCode) {
    const db = (0, database_js_1.getDb)();
    const current = db.prepare('SELECT short_code FROM clans WHERE id = ?').get(id);
    const code = (shortCode ?? current?.short_code ?? '').trim();
    const slug = slugifyClanName(clanLabel(newName.trim(), code));
    if (!slug)
        throw new Error('Clan name produces an empty slug');
    db.prepare('UPDATE clans SET name = ?, short_code = ?, slug = ? WHERE id = ?').run(newName.trim(), code, slug, id);
}
function setClanActive(id, active) {
    const db = (0, database_js_1.getDb)();
    db.prepare('UPDATE clans SET is_active = ? WHERE id = ?').run(active ? 1 : 0, id);
}
/**
 * The shortest scan interval a clan may have of its own. Each scan signs in to
 * the game on the clan's scanner account, and a redeploy waits for a 5-minute
 * gap before the next scan (scripts/deploy-when-idle.mjs): a clan scanned every
 * 5 minutes never leaves one. Older rows below it read as the floor.
 */
exports.MIN_CLAN_SCAN_INTERVAL_MINUTES = 10;
function setClanScanIntervalMinutes(id, minutes) {
    const db = (0, database_js_1.getDb)();
    db.prepare('UPDATE clans SET scan_interval_minutes = ? WHERE id = ?').run(minutes, id);
}
/** `url` must already be normalised (normalizePublicUrl); '' clears it. */
function setClanPublicUrl(id, url) {
    (0, database_js_1.getDb)().prepare('UPDATE clans SET public_url = ? WHERE id = ?').run(url, id);
}
/** The base URL links for this clan should use: its own domain, else the
 *  global WEB_EXTERNAL_URL. '' when neither is set (= emit no links). */
function clanPublicUrl(clan, globalUrl) {
    return (clan?.publicUrl || globalUrl || '').replace(/\/+$/, '');
}
/**
 * Set this clan's leaderboard goal. `weeklyPoints` is null when the admin
 * cleared the field — the flag is stored independently so re-enabling doesn't
 * require retyping the target, and resolveLeaderboardGoal() is what decides
 * that the combination means "no goal".
 */
function setClanLeaderboardGoal(id, settings, 
/**
 * First game day of the week in progress: the new number applies to this
 * whole week and every one after it, while finished weeks keep the goal they
 * were played under (clan_goal_history, utils/weekly-goal.ts).
 */
effectiveFrom) {
    const db = (0, database_js_1.getDb)();
    db.transaction(() => {
        db.prepare('UPDATE clans SET leaderboard_goal_enabled = ?, leaderboard_weekly_goal_points = ?, leaderboard_goal_amber_pct = NULL WHERE id = ?').run(settings.enabled ? 1 : 0, settings.weeklyPoints, id);
        (0, goal_history_js_1.writeGoalStep)(db, id, effectiveFrom, settings.weeklyPoints, new Date().toISOString());
    })();
}
/** The clan's weekly goal over time, oldest step first. */
function listGoalHistory(id) {
    return (0, goal_history_js_1.readGoalHistory)((0, database_js_1.getDb)(), id);
}
/** Set how this clan cuts its week (Sunday, Tinman to Tinman, or its own). */
function setClanWeekStart(id, weekStart) {
    (0, database_js_1.getDb)().prepare('UPDATE clans SET week_start = ? WHERE id = ?').run(weekStart, id);
}
/**
 * A clan's week shape by id, 'sunday' for an unknown clan. For callers that
 * hold only a clan id and need a week window (gameWindow's last argument).
 */
function getClanWeekStart(id) {
    return getClanById(id)?.weekStart ?? 'sunday';
}
/**
 * Mark a clan as playing a Seasonal Kingdom, or not. A clan on Tinman weeks
 * keeps them across the switch, on the cadence of the kingdom it now plays:
 * the normal 6-day 'ancients' becomes the SK 'ancients-sk' and back, since SK
 * runs Ancients on its own rotation (every 5 days in SK 2026). Returns the week
 * shape the clan ends up with, so the caller can tell the page.
 */
function setClanSeasonalKingdom(id, enabled) {
    const db = (0, database_js_1.getDb)();
    return db.transaction(() => {
        db.prepare('UPDATE clans SET seasonal_kingdom = ? WHERE id = ?').run(enabled ? 1 : 0, id);
        const [from, to] = enabled ? ['ancients', 'ancients-sk'] : ['ancients-sk', 'ancients'];
        db.prepare('UPDATE clans SET week_start = ? WHERE id = ? AND week_start = ?').run(to, id, from);
        return getClanWeekStart(id);
    })();
}
/**
 * Whether a clan may hold `weekStart`: each kingdom has its own Tinman week
 * ('ancients' normal, 'ancients-sk' Seasonal Kingdom) and can't hold the
 * other's, whose cadence it doesn't play on.
 */
function weekStartAllowed(clan, weekStart) {
    if (weekStart === 'ancients')
        return !clan.seasonalKingdom;
    if (weekStart === 'ancients-sk')
        return clan.seasonalKingdom;
    return true;
}
function clanCalendarRealm(id) {
    return getClanById(id)?.seasonalKingdom ? 'season' : 'default';
}
/**
 * The clan's saved Ancient planner defaults, or null when none were saved — or
 * when what is stored no longer passes validation (a bound tightened since),
 * in which case the built-ins apply rather than a half-valid plan.
 */
function getClanAncientDefaults(id) {
    const row = (0, database_js_1.getDb)().prepare('SELECT ancient_planner_defaults AS raw FROM clans WHERE id = ?')
        .get(id);
    if (!row?.raw)
        return null;
    try {
        const stored = JSON.parse(row.raw);
        const parsed = (0, ancient_planner_defaults_js_1.parseAncientSettings)(stored.settings);
        if (!parsed.ok)
            return null;
        return {
            settings: parsed.settings,
            savedAt: typeof stored.savedAt === 'string' ? stored.savedAt : '',
            savedBy: typeof stored.savedBy === 'string' ? stored.savedBy : '',
        };
    }
    catch {
        return null;
    }
}
function setClanAncientDefaults(id, value) {
    (0, database_js_1.getDb)().prepare('UPDATE clans SET ancient_planner_defaults = ? WHERE id = ?').run(JSON.stringify(value), id);
}
function setClanDiscordSettings(id, s) {
    const db = (0, database_js_1.getDb)();
    db.prepare(`
    UPDATE clans SET
      discord_enabled = ?,
      discord_token = ?,
      discord_channel_id = ?,
      discord_guild_id = ?,
      discord_scan_reports_enabled = ?,
      discord_only_new_chests = ?,
      discord_daily_digest_enabled = ?,
      discord_daily_digest_share_user_id = ?,
      discord_commands_enabled = ?,
      discord_weekly_digest_enabled = ?
    WHERE id = ?
  `).run(s.enabled ? 1 : 0, s.token, s.channelId, s.guildId, s.scanReportsEnabled ? 1 : 0, s.onlyNewChests ? 1 : 0, s.dailyDigestEnabled ? 1 : 0, s.dailyDigestShareUserId, s.commandsEnabled ? 1 : 0, s.weeklyDigestEnabled ? 1 : 0, id);
}
/**
 * Persist the outcome of a scheduled daily-digest run. Called once
 * per run after both the channel post and DM steps complete (or
 * fail). Empty error strings mean the step succeeded; non-empty =
 * a short, human-readable reason surfaced on the clan card.
 *
 * Test-DM does NOT call this — it stays isolated so a successful
 * test doesn't paper over a real digest-time failure recorded
 * earlier.
 */
function setClanLastDigestStatus(id, status) {
    const db = (0, database_js_1.getDb)();
    db.prepare(`
    UPDATE clans SET
      last_digest_at = ?,
      last_digest_game_day = ?,
      last_digest_channel_error = ?,
      last_digest_dm_error = ?
    WHERE id = ?
  `).run(status.at, status.gameDay, status.channelError, status.dmError, id);
}
/**
 * Persist the outcome of a weekly-digest run — the weekly twin of
 * setClanLastDigestStatus. `week` is the reported week's first game day;
 * `error` is '' on full delivery, else the channel and/or DM failure.
 */
function setClanLastWeeklyDigestStatus(id, status) {
    (0, database_js_1.getDb)().prepare(`
    UPDATE clans SET
      last_weekly_digest_at = ?,
      last_weekly_digest_week = ?,
      last_weekly_digest_error = ?
    WHERE id = ?
  `).run(status.at, status.week, status.error, id);
}
/**
 * Atomically flip the needs-reauth flag on. Returns true the first
 * time the flag transitions 0 → 1 for this clan; returns false if it
 * was already set. Callers use the return value to gate one-shot
 * notifications (Discord ping) so a clan that keeps failing every
 * scan cycle doesn't spam the channel — only the first failure of a
 * streak triggers the notice.
 */
function markClanNeedsReauth(id) {
    const db = (0, database_js_1.getDb)();
    const result = db.prepare(`UPDATE clans
     SET needs_reauth = 1, reauth_failed_at = ?
     WHERE id = ? AND needs_reauth = 0`).run(new Date().toISOString(), id);
    return { firstTime: result.changes > 0 };
}
/**
 * Atomically flip the needs-reauth flag off. Mirror of
 * markClanNeedsReauth: returns true only on the 1 → 0 transition, so
 * callers can announce a recovery exactly once instead of every cycle.
 *
 * Two callers, and the second is the one that makes the flag trustworthy:
 * the login bridge after it writes a fresh storage-state.json, and
 * session-health.ts whenever a scan or session check sees the saved session
 * signed in. Without the latter the flag was effectively write-once — a single
 * bad cycle left the clan reading "Needs re-authentication" forever, while
 * every scan after it signed in perfectly well. The badge even claimed to mean "the most recent
 * scan was able to load the game", which nothing enforced.
 *
 * The `needs_reauth = 1` guard also keeps the happy path write-free: a
 * healthy clan's scan does not touch the row at all.
 *
 * It also retires the clan's re-auth warnings on the System page, and does
 * so on EVERY call rather than only on the 1 → 0 transition. Those entries
 * used to stay under "Needs attention" until newer warnings evicted them —
 * days after the login was fixed — because nothing ever told the log buffer
 * the condition had cleared. Running it on every healthy cycle also sweeps up
 * entries whose flag was cleared before this existed. It only writes when it
 * finds something, so the happy path stays write-free here too.
 */
function clearClanNeedsReauth(id) {
    const db = (0, database_js_1.getDb)();
    const result = db.prepare(`UPDATE clans SET needs_reauth = 0, reauth_failed_at = ''
     WHERE id = ? AND needs_reauth = 1`).run(id);
    (0, log_buffer_js_1.resolveEntries)(reauthWarningKey(id), reauthLegacyMatcher(id));
    return { recovered: result.changes > 0 };
}
/** The `resolveKey` every re-auth warning for a clan is logged under. */
function reauthWarningKey(id) {
    return `reauth:clan:${id}`;
}
/**
 * Matches a clan's re-auth errors logged before they carried a resolveKey, on
 * the message the auth check has always written: "Clan #<id> needs
 * re-authentication — …". The " needs" right after the id is what keeps
 * clan #1 from claiming clan #12's.
 */
function reauthLegacyMatcher(id) {
    const prefix = `Clan #${id} needs re-authentication `;
    return (e) => e.msg.startsWith(prefix);
}
function setClanChestTrackerSettings(id, s) {
    const db = (0, database_js_1.getDb)();
    db.prepare(`
    UPDATE clans SET
      ct_share_code = ?,
      ct_poll_interval_hours = ?,
      ct_backfill_weeks = ?
    WHERE id = ?
  `).run(s.shareCode, s.pollIntervalHours, s.backfillWeeks, id);
}
/**
 * Hide a clan and everything it owns, without destroying a single row.
 *
 * This is what `DELETE /api/clans/:id` does now. The hard cascade below still
 * exists but nothing in the UI reaches it, because the cascade is how a clan's
 * entire history was lost in September: it ran, the pre-action snapshot was the
 * only copy left, and it survived by luck rather than design.
 *
 * Two things it deliberately does NOT do:
 *
 *   - It does not require the clan's users to be detached first. That guard is
 *     exactly what made the loss permanent — satisfying it meant deleting nine
 *     accounts before the clan could go, so the "reversible" operation was
 *     preceded by nine irreversible ones. Users stay attached and come back
 *     with the clan; until then `requireClanContext` tells them their clan is
 *     unavailable rather than silently dropping them into clan #1.
 *   - It does not free the clan's name, slug or share token. They stay owned by
 *     the hidden clan so a restore cannot collide with something created in the
 *     meantime — and so the clan comes back on the same public link.
 *
 * Sessions parked on the clan lose their pointer, so a superadmin who was
 * viewing it falls back to a live clan on the next request instead of looking
 * at a clan that no longer answers.
 */
function softDeleteClan(id) {
    const db = (0, database_js_1.getDb)();
    if (clanCount() <= 1)
        return { ok: false, reason: 'Cannot delete the last remaining clan' };
    const existing = db.prepare("SELECT id FROM clans WHERE id = ? AND deleted_at = ''").get(id);
    if (!existing)
        return { ok: false, reason: 'Clan not found' };
    const now = new Date().toISOString();
    let rehomed = 0;
    const tx = db.transaction(() => {
        db.prepare('UPDATE clans SET deleted_at = ?, is_active = 0 WHERE id = ?').run(now, id);
        db.prepare('UPDATE user_sessions SET active_clan_id = NULL WHERE active_clan_id = ?').run(id);
        rehomed = rehomeAccountsOffDeletedClans(now);
    });
    tx();
    log.info(`Soft-deleted clan #${id} — rows retained, restorable from the System page`
        + (rehomed ? `; ${rehomed} account(s) moved home to another of their clans` : ''));
    return { ok: true };
}
/**
 * Accounts whose HOME clan is soft-deleted but who still hold a live extra
 * clan move home to it (the earliest grant), and keep the deleted clan as an
 * extra grant with their old role — inert while it's deleted, back if it's
 * restored. Accounts with no live clan stay as they are: there is nowhere to
 * move them. Returns how many moved.
 *
 * Why: deleting SIK (Nov 17 2026) left six accounts homed on it with a live
 * CWB grant. Sessions start in the home clan, so they opened a clan that no
 * longer answers and had no way to reach CWB — it looked as if the invite
 * work had taken their access away. Migration v129 repaired those six; every
 * soft delete calls this from then on.
 */
function rehomeAccountsOffDeletedClans(now = new Date().toISOString()) {
    const db = (0, database_js_1.getDb)();
    const stranded = db.prepare(`SELECT u.id, u.clan_id AS home, u.role FROM users u
       JOIN clans c ON c.id = u.clan_id
      WHERE u.role != 'superadmin' AND c.deleted_at != ''`).all();
    let moved = 0;
    for (const u of stranded) {
        const next = db.prepare(`SELECT a.clan_id, a.role FROM user_clan_access a
         JOIN clans c ON c.id = a.clan_id AND c.deleted_at = ''
        WHERE a.user_id = ?
        ORDER BY a.created_at, a.clan_id LIMIT 1`).get(u.id);
        if (!next)
            continue;
        db.prepare('UPDATE users SET clan_id = ?, role = ? WHERE id = ?').run(next.clan_id, next.role, u.id);
        db.prepare('DELETE FROM user_clan_access WHERE user_id = ? AND clan_id = ?').run(u.id, next.clan_id);
        db.prepare('INSERT OR IGNORE INTO user_clan_access (user_id, clan_id, role, created_at) VALUES (?, ?, ?, ?)')
            .run(u.id, u.home, u.role === 'admin' ? 'admin' : 'user', now);
        moved++;
    }
    return moved;
}
/**
 * Bring a soft-deleted clan back. Nothing was moved, so this is the flag flip
 * the delete is the mirror of — `is_active` included, since the delete cleared
 * it and a clan restored as inactive would still be invisible to the scan loop.
 */
function restoreDeletedClan(id) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare("SELECT id FROM clans WHERE id = ? AND deleted_at != ''").get(id);
    if (!row)
        return { ok: false, reason: 'No deleted clan with that id' };
    db.prepare("UPDATE clans SET deleted_at = '', is_active = 1 WHERE id = ?").run(id);
    log.info(`Restored soft-deleted clan #${id}`);
    return { ok: true };
}
/**
 * Permanently destroy a clan and every row it owns. **No route calls this.**
 *
 * Kept as the primitive a deliberate manual purge would use, and because
 * tests/data/fk-delete-guards.test.ts drives it to prove the clan-scoped table
 * list is still complete — a new table with an FK to clans(id) fails that test
 * whether or not anyone ever purges. `softDeleteClan` is what the UI does.
 *
 * Refuses if this is the last clan or if any users are still scoped to it.
 */
function deleteClan(id) {
    const db = (0, database_js_1.getDb)();
    if (clanCount() <= 1)
        return { ok: false, reason: 'Cannot delete the last remaining clan' };
    const userCount = db.prepare('SELECT COUNT(*) as c FROM users WHERE clan_id = ?').get(id);
    if (userCount.c > 0) {
        return { ok: false, reason: `${userCount.c} user(s) are still attached to this clan` };
    }
    // Cascade scan_sessions, chest_records, members, etc. via FK CASCADE
    // would be cleanest, but the existing schema's FKs don't have cascade.
    // We delete child rows first to keep referential integrity and so the
    // delete is observable in audit logs as one transaction.
    //
    // ORDER MATTERS — FKs are immediate, so every child must be gone before
    // its parent. The grouping below is deepest-first:
    //   members' children -> members -> scan_sessions -> clan-scoped tables
    // Getting this wrong doesn't corrupt anything (the transaction rolls
    // back) but it does make the delete fail outright, which is what
    // happened for any clan holding triumphal records or resource uploads.
    const tx = db.transaction(() => {
        // 1. Rows referencing members(id) and/or scan_sessions(id).
        db.prepare('DELETE FROM triumphal_chest_records WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM chest_records WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM resource_transactions WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM member_snapshots WHERE member_id IN (SELECT id FROM members WHERE clan_id = ?)').run(id);
        // Cascades off members too, but also holds its own clans(id) FK.
        db.prepare('DELETE FROM member_guards_reports WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM member_level_reports WHERE clan_id = ?').run(id);
        // Tinman standings: scores before their uploads (the scores' FK), both
        // before members and clans.
        db.prepare('DELETE FROM tinman_scores WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM tinman_uploads WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM tinman_targets WHERE clan_id = ?').run(id);
        // chest_daily_summary is a derived rollup with no FK, but leaving its
        // rows behind would resurrect the dead clan's numbers if the id is reused.
        db.prepare('DELETE FROM chest_daily_summary WHERE clan_id = ?').run(id);
        // Same: no FK (see migration v92), keyed by member ids a reused clan id would
        // hand to unrelated players.
        db.prepare('DELETE FROM clan_goal_history WHERE clan_id = ?').run(id);
        // The ChestTracker ingest tables carry a clan_id with NO foreign key to
        // clans(id) — they predate multi-clan and the column was bolted on with a
        // DEFAULT rather than a reference. So nothing here fails if they are
        // skipped, the fk-delete-guards test (which works from the live FK list)
        // cannot see them, and they were in fact being left behind: a deleted
        // clan's poll history and snapshots survived, ready to be re-attributed to
        // whoever next took the id. Same argument as chest_daily_summary above.
        //
        // Order matters within the group even though clans doesn't enforce it:
        // player_snapshot/player_category reference ct_player_ref WITHOUT cascade.
        db.prepare('DELETE FROM player_category WHERE snapshot_id IN (SELECT id FROM snapshot WHERE clan_id = ?)').run(id);
        db.prepare('DELETE FROM player_snapshot WHERE snapshot_id IN (SELECT id FROM snapshot WHERE clan_id = ?)').run(id);
        db.prepare('DELETE FROM snapshot_chest_definition WHERE snapshot_id IN (SELECT id FROM snapshot WHERE clan_id = ?)').run(id);
        db.prepare('DELETE FROM snapshot WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM ct_player_ref WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM poll_log WHERE clan_id = ?').run(id);
        // discord_member_links CASCADEs off members, but it also holds its own
        // clans(id) FK — so clear it explicitly rather than relying on the member
        // delete below to take it out sideways.
        db.prepare('DELETE FROM discord_member_links WHERE clan_id = ?').run(id);
        // 2. members and scan_sessions themselves, now unreferenced.
        db.prepare('DELETE FROM members WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM scan_sessions WHERE clan_id = ?').run(id);
        // 3. Remaining clan-scoped tables.
        // Per-clan chest points (v86) and their history (v99); the values first,
        // they point at the history's dated steps. triumphal_chest_points stays global.
        db.prepare('DELETE FROM source_point_overrides WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM source_point_changes WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM review_acknowledgments WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM resource_upload_batches WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM resource_icon_templates WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM resource_capture_cursor WHERE clan_id = ?').run(id);
        // Game protocol capture (v102): keyed on game ids, no member FKs.
        db.prepare('DELETE FROM game_player_history WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_players WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_gifts WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_ledger WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_capture_runs WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_scan_comparisons WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_claims WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_player_tech_history WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_player_techs WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_city_snapshots WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_map_objects WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_raw_snapshots WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_player_captain_history WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_player_captains WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_player_daily WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_city_status_history WHERE clan_id = ?').run(id);
        // The clan's own game data (v111).
        db.prepare('DELETE FROM game_clan_info WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_clan_stats WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_clan_tech_history WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_clan_techs WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_clan_treasury WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_clan_medals WHERE clan_id = ?').run(id);
        // Artifacts, captain equipment and archive re-parse markers (v112).
        db.prepare('DELETE FROM game_player_artifact_history WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_player_artifacts WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_player_equipment_history WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_player_captain_equipment WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_parse_markers WHERE clan_id = ?').run(id);
        // Players' titles (v125).
        db.prepare('DELETE FROM game_player_titles WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_player_title_counts WHERE clan_id = ?').run(id);
        // In-game chat digest (v115).
        db.prepare('DELETE FROM chat_digest_posts WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM chat_post_channels WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM chat_digest_settings WHERE clan_id = ?').run(id);
        // The clan's logo and rankings (v117).
        db.prepare('DELETE FROM game_clan_rankings WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_clan_ranking_lists WHERE clan_id = ?').run(id);
        // Event standings from the game (v120).
        db.prepare('DELETE FROM game_event_matchup_clans WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_event_matchups WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_event_reads WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_event_standing_history WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_event_standings WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM game_event_runs WHERE clan_id = ?').run(id);
        // The scanner account (v118).
        db.prepare('DELETE FROM clan_scan_accounts WHERE clan_id = ?').run(id);
        // Accounts from the game (v127): codes before the requests they answer.
        db.prepare('DELETE FROM account_invite_codes WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM chat_invite_requests WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM chat_invite_welcomes WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM account_invite_settings WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM chat_send_state WHERE clan_id = ?').run(id);
        // Chat commands (v135).
        db.prepare('DELETE FROM chat_command_requests WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM chat_command_settings WHERE clan_id = ?').run(id);
        // Dragon Coins back to members (v140).
        db.prepare('DELETE FROM dragon_coin_returns WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM dragon_coin_return_settings WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM user_game_links WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM user_clan_main WHERE clan_id = ?').run(id);
        // In-game chat (v104).
        db.prepare('DELETE FROM chat_messages WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM chat_channels WHERE clan_id = ?').run(id);
        // share_link_daily rows hang off share_links; drop them first, then the
        // ledger rows themselves, so the clans delete doesn't hit the
        // share_links.clan_id FK.
        db.prepare('DELETE FROM share_link_daily WHERE link_id IN (SELECT id FROM share_links WHERE clan_id = ?)').run(id);
        db.prepare('DELETE FROM share_links WHERE clan_id = ?').run(id);
        // Guests of the clan lose the grant; their home clans are untouched.
        db.prepare('DELETE FROM user_clan_access WHERE clan_id = ?').run(id);
        // 4. Two nullable back-references. The audit trail is history and
        // survives the clan (v47 made clan_id nullable precisely so it could);
        // a live session just loses its active-clan pointer and falls back.
        db.prepare('UPDATE audit_log SET clan_id = NULL WHERE clan_id = ?').run(id);
        db.prepare('UPDATE user_sessions SET active_clan_id = NULL WHERE active_clan_id = ?').run(id);
        db.prepare('DELETE FROM clans WHERE id = ?').run(id);
    });
    tx();
    log.info(`Deleted clan #${id}`);
    return { ok: true };
}
//# sourceMappingURL=clan-repo.js.map