import { getDb } from '../database.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger('clan-repo');

/**
 * One row per clan tracked by this instance. Discord and ChestTracker
 * settings live here (per-clan) instead of global env vars — multi-tenant
 * means each clan has its own Discord channel/bot and its own
 * ChestTracker share code.
 */
export interface Clan {
  id: number;
  name: string;
  slug: string;
  gameUrl: string;
  scanIntervalMinutes: number | null;
  isActive: boolean;
  createdAt: string;
  createdBy: number | null;

  // Discord per-clan
  discordEnabled: boolean;
  discordToken: string;
  discordChannelId: string;
  discordGuildId: string;
  discordScanReportsEnabled: boolean;
  discordOnlyNewChests: boolean;
  discordDailyDigestEnabled: boolean;
  /**
   * Comma-separated Discord user IDs (singular column name predates
   * multi-recipient support; a bare legacy ID parses as a one-element
   * list). Parse with `parseDigestRecipients` — never split by hand.
   */
  discordDailyDigestShareUserId: string;
  discordCommandsEnabled: boolean;

  // ChestTracker per-clan
  ctShareCode: string;
  ctPollIntervalHours: number | null;
  ctBackfillWeeks: number | null;

  // Public read-only share. Empty string when disabled. Six case-sensitive
  // alphanumerics resolve to /<token> on the public-share router.
  publicShareToken: string;

  // Status of the most recent scheduled daily-digest run. lastDigestAt
  // is empty until the first run completes. The two error fields are
  // empty on success and contain a short message on failure so the
  // clan card can surface "Last digest: failed — <reason>".
  lastDigestAt: string;
  lastDigestChannelError: string;
  lastDigestDmError: string;
  // The completed game day (YYYY-MM-DD) the last digest reported. Empty
  // until the first digest sent by a build that tracks it. Used by the
  // boot-time catch-up to tell whether the most recent elapsed rollover
  // was already digested.
  lastDigestGameDay: string;

  // Flagged true by the auth-check phase when the saved TB session
  // cannot load the game canvas (cookies expired or evicted). Cleared
  // when the operator saves a fresh session via the login bridge.
  // reauthFailedAt is the ISO timestamp of the most recent failure;
  // empty when needsReauth is false.
  needsReauth: boolean;
  reauthFailedAt: string;

  // Resource tracking feature toggle. Off by default; admins enable it
  // per-clan from the Clan settings page to surface the Resources tab.
  resourcesEnabled: boolean;
  /**
   * Include this clan in the DAILY automated read of the Clan Capital history.
   *
   * Distinct from resourcesEnabled, which is "does this clan track resources at
   * all" (the tab, uploads). A clan can track resources and still be read by hand —
   * before this existed the only ways to arrange that were disabling the read for
   * every clan or giving up the tab. Ignored entirely when resourcesEnabled is off,
   * and gated in turn by the instance-wide RESOURCE_CAPTURE_ENABLED.
   */
  resourceAutoCapture: boolean;

  // Daily member-inactivity sweep, per clan. inactivitySweepEnabled is the
  // on/off toggle (defaults on). inactivityDays is the threshold — days a
  // member can go unseen before being soft-removed — where null inherits the
  // global MEMBER_INACTIVITY_DAYS default and a positive number is a custom
  // cutoff. The days value is ignored when the sweep is disabled.
  inactivitySweepEnabled: boolean;
  inactivityDays: number | null;

  /**
   * Leaderboard points goal. `leaderboardGoalEnabled` turns the per-row
   * green/amber/red colouring on; `leaderboardWeeklyGoalPoints` is the WEEKLY
   * target every other timeframe is derived from (see scaleGoalForPeriod in
   * lib/leaderboard-render.js) — a single number so the daily / weekly / monthly
   * views can never state goals that contradict each other.
   *
   * Null (or 0) means "enabled but never configured", which reads as no goal at
   * all: resolveLeaderboardGoal() treats the pair as off unless BOTH the flag is
   * set and the number is positive.
   */
  leaderboardGoalEnabled: boolean;
  leaderboardWeeklyGoalPoints: number | null;
}

/**
 * URL-safe slug. Lowercase, runs of non-alphanumerics collapse to `-`,
 * trimmed. Per project convention we never %20 in user-facing URLs —
 * slug is what the URL resolves on.
 */
export function slugifyClanName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function rowToClan(row: Record<string, unknown>): Clan {
  return {
    id: row.id as number,
    name: row.name as string,
    slug: row.slug as string,
    gameUrl: row.game_url as string,
    scanIntervalMinutes: (row.scan_interval_minutes as number | null) ?? null,
    isActive: !!(row.is_active as number),
    createdAt: row.created_at as string,
    createdBy: (row.created_by as number | null) ?? null,
    discordEnabled: !!(row.discord_enabled as number),
    discordToken: (row.discord_token as string) || '',
    discordChannelId: (row.discord_channel_id as string) || '',
    discordGuildId: (row.discord_guild_id as string) || '',
    discordScanReportsEnabled: !!(row.discord_scan_reports_enabled as number),
    discordOnlyNewChests: !!(row.discord_only_new_chests as number),
    discordDailyDigestEnabled: !!(row.discord_daily_digest_enabled as number),
    discordDailyDigestShareUserId: (row.discord_daily_digest_share_user_id as string) || '',
    discordCommandsEnabled: !!(row.discord_commands_enabled as number),
    ctShareCode: (row.ct_share_code as string) || '',
    ctPollIntervalHours: (row.ct_poll_interval_hours as number | null) ?? null,
    ctBackfillWeeks: (row.ct_backfill_weeks as number | null) ?? null,
    publicShareToken: (row.public_share_token as string) || '',
    lastDigestAt: (row.last_digest_at as string) || '',
    lastDigestChannelError: (row.last_digest_channel_error as string) || '',
    lastDigestDmError: (row.last_digest_dm_error as string) || '',
    lastDigestGameDay: (row.last_digest_game_day as string) || '',
    needsReauth: !!(row.needs_reauth as number),
    reauthFailedAt: (row.reauth_failed_at as string) || '',
    resourcesEnabled: !!(row.resources_enabled as number),
    // Defaults to true for rows written before the column existed — see migration
    // v60: adding it must not silently stop reading a clan that was being read.
    resourceAutoCapture: (row.resource_auto_capture as number | undefined) === undefined
      ? true
      : !!(row.resource_auto_capture as number),
    inactivitySweepEnabled: !!(row.inactivity_sweep_enabled as number),
    inactivityDays: (row.inactivity_days as number | null) ?? null,
    leaderboardGoalEnabled: !!(row.leaderboard_goal_enabled as number),
    leaderboardWeeklyGoalPoints: (row.leaderboard_weekly_goal_points as number | null) ?? null,
  };
}

export function listClans(options: { activeOnly?: boolean } = {}): Clan[] {
  const db = getDb();
  const query = options.activeOnly
    ? 'SELECT * FROM clans WHERE is_active = 1 ORDER BY id'
    : 'SELECT * FROM clans ORDER BY id';
  const rows = db.prepare(query).all() as Record<string, unknown>[];
  return rows.map(rowToClan);
}

export function getClanById(id: number): Clan | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM clans WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToClan(row) : null;
}

export function getClanBySlug(slug: string): Clan | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM clans WHERE slug = ?').get(slug) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToClan(row) : null;
}

export function getClanByPublicShareToken(token: string): Clan | null {
  if (!token) return null;
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM clans WHERE public_share_token = ?')
    .get(token) as Record<string, unknown> | undefined;
  return row ? rowToClan(row) : null;
}

export function setClanPublicShareToken(id: number, token: string): void {
  const db = getDb();
  db.prepare('UPDATE clans SET public_share_token = ? WHERE id = ?').run(token, id);
}

export function clanCount(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as c FROM clans').get() as { c: number };
  return row.c;
}

export interface CreateClanInput {
  name: string;
  createdBy?: number | null;
  scanIntervalMinutes?: number | null;
}

export function createClan(input: CreateClanInput): Clan {
  const db = getDb();
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
  `).run(
    input.name.trim(),
    slug,
    'https://totalbattle.com',
    input.scanIntervalMinutes ?? null,
    now,
    input.createdBy ?? null,
  );
  log.info(`Created clan #${result.lastInsertRowid} "${input.name}" (slug=${slug})`);
  const created = getClanById(result.lastInsertRowid as number);
  if (!created) throw new Error('Failed to read back created clan');
  return created;
}

export function renameClan(id: number, newName: string): void {
  const db = getDb();
  const slug = slugifyClanName(newName);
  if (!slug) throw new Error('Clan name produces an empty slug');
  db.prepare('UPDATE clans SET name = ?, slug = ? WHERE id = ?').run(newName.trim(), slug, id);
}

export function setClanActive(id: number, active: boolean): void {
  const db = getDb();
  db.prepare('UPDATE clans SET is_active = ? WHERE id = ?').run(active ? 1 : 0, id);
}

export function setClanScanIntervalMinutes(id: number, minutes: number | null): void {
  const db = getDb();
  db.prepare('UPDATE clans SET scan_interval_minutes = ? WHERE id = ?').run(minutes, id);
}

/**
 * Set a clan's member-inactivity-sweep settings. `enabled` is the on/off
 * toggle; `days` is the threshold — null to fall back to the global
 * MEMBER_INACTIVITY_DAYS default, or a positive integer for a custom cutoff
 * (ignored while the sweep is disabled).
 */
export function setClanInactivitySettings(
  id: number,
  settings: { enabled: boolean; days: number | null },
): void {
  const db = getDb();
  db.prepare(
    'UPDATE clans SET inactivity_sweep_enabled = ?, inactivity_days = ? WHERE id = ?',
  ).run(settings.enabled ? 1 : 0, settings.days, id);
}

/**
 * Set this clan's leaderboard goal. `weeklyPoints` is null when the admin
 * cleared the field — the flag is stored independently so re-enabling doesn't
 * require retyping the target, and resolveLeaderboardGoal() is what decides
 * that the combination means "no goal".
 */
export function setClanLeaderboardGoal(
  id: number,
  settings: { enabled: boolean; weeklyPoints: number | null },
): void {
  const db = getDb();
  db.prepare(
    'UPDATE clans SET leaderboard_goal_enabled = ?, leaderboard_weekly_goal_points = ? WHERE id = ?',
  ).run(settings.enabled ? 1 : 0, settings.weeklyPoints, id);
}

export interface DiscordSettings {
  enabled: boolean;
  token: string;
  channelId: string;
  guildId: string;
  scanReportsEnabled: boolean;
  onlyNewChests: boolean;
  dailyDigestEnabled: boolean;
  /** Comma-separated user IDs — see `Clan.discordDailyDigestShareUserId`. */
  dailyDigestShareUserId: string;
  commandsEnabled: boolean;
}

export function setClanDiscordSettings(id: number, s: DiscordSettings): void {
  const db = getDb();
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
  `).run(
    s.enabled ? 1 : 0,
    s.token,
    s.channelId,
    s.guildId,
    s.scanReportsEnabled ? 1 : 0,
    s.onlyNewChests ? 1 : 0,
    s.dailyDigestEnabled ? 1 : 0,
    s.dailyDigestShareUserId,
    s.commandsEnabled ? 1 : 0,
    id,
  );
}

export interface ChestTrackerSettings {
  shareCode: string;
  pollIntervalHours: number | null;
  backfillWeeks: number | null;
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
export function setClanLastDigestStatus(
  id: number,
  status: { at: string; gameDay: string; channelError: string; dmError: string },
): void {
  const db = getDb();
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
export function markClanNeedsReauth(id: number): { firstTime: boolean } {
  const db = getDb();
  const result = db.prepare(
    `UPDATE clans
     SET needs_reauth = 1, reauth_failed_at = ?
     WHERE id = ? AND needs_reauth = 0`,
  ).run(new Date().toISOString(), id);
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
export function clearClanNeedsReauth(id: number): { recovered: boolean } {
  const db = getDb();
  const result = db.prepare(
    `UPDATE clans SET needs_reauth = 0, reauth_failed_at = ''
     WHERE id = ? AND needs_reauth = 1`,
  ).run(id);
  return { recovered: result.changes > 0 };
}

export function setClanChestTrackerSettings(id: number, s: ChestTrackerSettings): void {
  const db = getDb();
  db.prepare(`
    UPDATE clans SET
      ct_share_code = ?,
      ct_poll_interval_hours = ?,
      ct_backfill_weeks = ?
    WHERE id = ?
  `).run(s.shareCode, s.pollIntervalHours, s.backfillWeeks, id);
}

export function setClanResourcesEnabled(id: number, enabled: boolean): void {
  const db = getDb();
  db.prepare('UPDATE clans SET resources_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

/** Include or exclude this clan from the daily automated history read. */
export function setClanResourceAutoCapture(id: number, enabled: boolean): void {
  const db = getDb();
  db.prepare('UPDATE clans SET resource_auto_capture = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

/**
 * Refuses if this is the last clan or if any users are still scoped to it.
 * Caller is responsible for archiving/reassigning users first.
 */
export function deleteClan(id: number): { ok: true } | { ok: false; reason: string } {
  const db = getDb();
  if (clanCount() <= 1) return { ok: false, reason: 'Cannot delete the last remaining clan' };

  const userCount = db.prepare(
    'SELECT COUNT(*) as c FROM users WHERE clan_id = ?',
  ).get(id) as { c: number };
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
    db.prepare(
      'DELETE FROM member_snapshots WHERE member_id IN (SELECT id FROM members WHERE clan_id = ?)',
    ).run(id);
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
    db.prepare(
      'DELETE FROM player_category WHERE snapshot_id IN (SELECT id FROM snapshot WHERE clan_id = ?)',
    ).run(id);
    db.prepare(
      'DELETE FROM player_snapshot WHERE snapshot_id IN (SELECT id FROM snapshot WHERE clan_id = ?)',
    ).run(id);
    db.prepare(
      'DELETE FROM snapshot_chest_definition WHERE snapshot_id IN (SELECT id FROM snapshot WHERE clan_id = ?)',
    ).run(id);
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
    db.prepare(
      'DELETE FROM share_link_daily WHERE link_id IN (SELECT id FROM share_links WHERE clan_id = ?)',
    ).run(id);
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
