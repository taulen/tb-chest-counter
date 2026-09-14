"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.slugifyClanName = slugifyClanName;
exports.listClans = listClans;
exports.getClanById = getClanById;
exports.getClanBySlug = getClanBySlug;
exports.getClanByPublicShareToken = getClanByPublicShareToken;
exports.setClanPublicShareToken = setClanPublicShareToken;
exports.clanCount = clanCount;
exports.createClan = createClan;
exports.renameClan = renameClan;
exports.setClanActive = setClanActive;
exports.setClanScanIntervalMinutes = setClanScanIntervalMinutes;
exports.setClanInactivitySettings = setClanInactivitySettings;
exports.setClanLeaderboardGoal = setClanLeaderboardGoal;
exports.setClanDiscordSettings = setClanDiscordSettings;
exports.setClanLastDigestStatus = setClanLastDigestStatus;
exports.markClanNeedsReauth = markClanNeedsReauth;
exports.clearClanNeedsReauth = clearClanNeedsReauth;
exports.setClanChestTrackerSettings = setClanChestTrackerSettings;
exports.setClanResourcesEnabled = setClanResourcesEnabled;
exports.setClanResourceAutoCapture = setClanResourceAutoCapture;
exports.deleteClan = deleteClan;
const database_js_1 = require("../database.js");
const logger_js_1 = require("../../utils/logger.js");
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
function rowToClan(row) {
    return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        gameUrl: row.game_url,
        scanIntervalMinutes: row.scan_interval_minutes ?? null,
        isActive: !!row.is_active,
        createdAt: row.created_at,
        createdBy: row.created_by ?? null,
        discordEnabled: !!row.discord_enabled,
        discordToken: row.discord_token || '',
        discordChannelId: row.discord_channel_id || '',
        discordGuildId: row.discord_guild_id || '',
        discordScanReportsEnabled: !!row.discord_scan_reports_enabled,
        discordOnlyNewChests: !!row.discord_only_new_chests,
        discordDailyDigestEnabled: !!row.discord_daily_digest_enabled,
        discordDailyDigestShareUserId: row.discord_daily_digest_share_user_id || '',
        discordCommandsEnabled: !!row.discord_commands_enabled,
        ctShareCode: row.ct_share_code || '',
        ctPollIntervalHours: row.ct_poll_interval_hours ?? null,
        ctBackfillWeeks: row.ct_backfill_weeks ?? null,
        publicShareToken: row.public_share_token || '',
        lastDigestAt: row.last_digest_at || '',
        lastDigestChannelError: row.last_digest_channel_error || '',
        lastDigestDmError: row.last_digest_dm_error || '',
        lastDigestGameDay: row.last_digest_game_day || '',
        needsReauth: !!row.needs_reauth,
        reauthFailedAt: row.reauth_failed_at || '',
        resourcesEnabled: !!row.resources_enabled,
        // Defaults to true for rows written before the column existed — see migration
        // v60: adding it must not silently stop reading a clan that was being read.
        resourceAutoCapture: row.resource_auto_capture === undefined
            ? true
            : !!row.resource_auto_capture,
        inactivitySweepEnabled: !!row.inactivity_sweep_enabled,
        inactivityDays: row.inactivity_days ?? null,
        leaderboardGoalEnabled: !!row.leaderboard_goal_enabled,
        leaderboardWeeklyGoalPoints: row.leaderboard_weekly_goal_points ?? null,
    };
}
function listClans(options = {}) {
    const db = (0, database_js_1.getDb)();
    const query = options.activeOnly
        ? 'SELECT * FROM clans WHERE is_active = 1 ORDER BY id'
        : 'SELECT * FROM clans ORDER BY id';
    const rows = db.prepare(query).all();
    return rows.map(rowToClan);
}
function getClanById(id) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare('SELECT * FROM clans WHERE id = ?').get(id);
    return row ? rowToClan(row) : null;
}
function getClanBySlug(slug) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare('SELECT * FROM clans WHERE slug = ?').get(slug);
    return row ? rowToClan(row) : null;
}
function getClanByPublicShareToken(token) {
    if (!token)
        return null;
    const db = (0, database_js_1.getDb)();
    const row = db
        .prepare('SELECT * FROM clans WHERE public_share_token = ?')
        .get(token);
    return row ? rowToClan(row) : null;
}
function setClanPublicShareToken(id, token) {
    const db = (0, database_js_1.getDb)();
    db.prepare('UPDATE clans SET public_share_token = ? WHERE id = ?').run(token, id);
}
function clanCount() {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare('SELECT COUNT(*) as c FROM clans').get();
    return row.c;
}
function createClan(input) {
    const db = (0, database_js_1.getDb)();
    const now = new Date().toISOString();
    const slug = slugifyClanName(input.name);
    if (!slug) {
        throw new Error('Clan name produces an empty slug');
    }
    // game_url is a vestigial NOT NULL column from migration v16; it's
    // populated with the global TB constant for backward-compat but
    // isn't surfaced anywhere in the UI or repos.
    // resources_enabled = 1 for a NEW clan: resource tracking is part of what
    // the app does now, and the instance-wide switch defaults on too, so a clan
    // created today starts collecting as soon as Stages 5+6 are calibrated. The
    // column's own DEFAULT stays 0 on purpose — that governs EXISTING rows a
    // migration adds the column to, and turning a feature on under a running
    // deployment is not a migration's call. Per-clan opt-out is on the Clans
    // page, and resource_auto_capture (the daily-read switch) already defaults 1.
    const result = db.prepare(`
    INSERT INTO clans (
      name, slug, game_url, scan_interval_minutes, is_active, created_at, created_by,
      resources_enabled
    ) VALUES (?, ?, ?, ?, 1, ?, ?, 1)
  `).run(input.name.trim(), slug, 'https://totalbattle.com', input.scanIntervalMinutes ?? null, now, input.createdBy ?? null);
    log.info(`Created clan #${result.lastInsertRowid} "${input.name}" (slug=${slug})`);
    const created = getClanById(result.lastInsertRowid);
    if (!created)
        throw new Error('Failed to read back created clan');
    return created;
}
function renameClan(id, newName) {
    const db = (0, database_js_1.getDb)();
    const slug = slugifyClanName(newName);
    if (!slug)
        throw new Error('Clan name produces an empty slug');
    db.prepare('UPDATE clans SET name = ?, slug = ? WHERE id = ?').run(newName.trim(), slug, id);
}
function setClanActive(id, active) {
    const db = (0, database_js_1.getDb)();
    db.prepare('UPDATE clans SET is_active = ? WHERE id = ?').run(active ? 1 : 0, id);
}
function setClanScanIntervalMinutes(id, minutes) {
    const db = (0, database_js_1.getDb)();
    db.prepare('UPDATE clans SET scan_interval_minutes = ? WHERE id = ?').run(minutes, id);
}
/**
 * Set a clan's member-inactivity-sweep settings. `enabled` is the on/off
 * toggle; `days` is the threshold — null to fall back to the global
 * MEMBER_INACTIVITY_DAYS default, or a positive integer for a custom cutoff
 * (ignored while the sweep is disabled).
 */
function setClanInactivitySettings(id, settings) {
    const db = (0, database_js_1.getDb)();
    db.prepare('UPDATE clans SET inactivity_sweep_enabled = ?, inactivity_days = ? WHERE id = ?').run(settings.enabled ? 1 : 0, settings.days, id);
}
/**
 * Set this clan's leaderboard goal. `weeklyPoints` is null when the admin
 * cleared the field — the flag is stored independently so re-enabling doesn't
 * require retyping the target, and resolveLeaderboardGoal() is what decides
 * that the combination means "no goal".
 */
function setClanLeaderboardGoal(id, settings) {
    const db = (0, database_js_1.getDb)();
    db.prepare('UPDATE clans SET leaderboard_goal_enabled = ?, leaderboard_weekly_goal_points = ? WHERE id = ?').run(settings.enabled ? 1 : 0, settings.weeklyPoints, id);
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
      discord_commands_enabled = ?
    WHERE id = ?
  `).run(s.enabled ? 1 : 0, s.token, s.channelId, s.guildId, s.scanReportsEnabled ? 1 : 0, s.onlyNewChests ? 1 : 0, s.dailyDigestEnabled ? 1 : 0, s.dailyDigestShareUserId, s.commandsEnabled ? 1 : 0, id);
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
 * the login bridge after it writes a fresh storage-state.json, and the
 * auth-check phase whenever it verifies the saved session still loads the
 * game. Without the latter the flag was effectively write-once — a single
 * bad cycle (a canvas that timed out under memory pressure, say) left the
 * clan reading "Needs re-authentication" forever, while every scan after it
 * signed in perfectly well. The badge even claimed to mean "the most recent
 * scan was able to load the game", which nothing enforced.
 *
 * The `needs_reauth = 1` guard also keeps the happy path write-free: a
 * healthy clan's scan does not touch the row at all.
 */
function clearClanNeedsReauth(id) {
    const db = (0, database_js_1.getDb)();
    const result = db.prepare(`UPDATE clans SET needs_reauth = 0, reauth_failed_at = ''
     WHERE id = ? AND needs_reauth = 1`).run(id);
    return { recovered: result.changes > 0 };
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
function setClanResourcesEnabled(id, enabled) {
    const db = (0, database_js_1.getDb)();
    db.prepare('UPDATE clans SET resources_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}
/** Include or exclude this clan from the daily automated history read. */
function setClanResourceAutoCapture(id, enabled) {
    const db = (0, database_js_1.getDb)();
    db.prepare('UPDATE clans SET resource_auto_capture = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}
/**
 * Refuses if this is the last clan or if any users are still scoped to it.
 * Caller is responsible for archiving/reassigning users first.
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
        // chest_daily_summary is a derived rollup with no FK, but leaving its
        // rows behind would resurrect the dead clan's numbers if the id is reused.
        db.prepare('DELETE FROM chest_daily_summary WHERE clan_id = ?').run(id);
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
        db.prepare('DELETE FROM merge_rules WHERE clan_id = ?').run(id);
        // source_point_overrides is a GLOBAL scoring table (no clan_id) since
        // v43 — it is shared across clans and must survive a clan deletion.
        db.prepare('DELETE FROM chest_type_overrides WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM review_acknowledgments WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM resource_upload_batches WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM resource_icon_templates WHERE clan_id = ?').run(id);
        db.prepare('DELETE FROM resource_capture_cursor WHERE clan_id = ?').run(id);
        // share_link_daily rows hang off share_links; drop them first, then the
        // ledger rows themselves, so the clans delete doesn't hit the
        // share_links.clan_id FK.
        db.prepare('DELETE FROM share_link_daily WHERE link_id IN (SELECT id FROM share_links WHERE clan_id = ?)').run(id);
        db.prepare('DELETE FROM share_links WHERE clan_id = ?').run(id);
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