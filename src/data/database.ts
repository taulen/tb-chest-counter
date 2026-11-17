import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { childLogger } from '../utils/logger.js';
import { correctChestName, getChestRarity, isHardcodedChestName, KNOWN_CHESTS, TRIUMPHAL_PACKAGE_POINTS } from './chest-names.js';
import { getSourceKey, getSourceRarity, sourceSpellingKey, canonicalSourceKey } from './source-names.js';
import { despace } from '../utils/name-normalize.js';
import { reportConfigIntegrity } from './config-integrity.js';
import { repairAldrin } from './repair-aldrin-2026-11.js';
import { repairCutNames } from './repair-cut-names-2026-11.js';
import { backfillGoalHistory } from './goal-history.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { chatSearchText, chatSenderPlayerId } from '../game-protocol/chat-text.js';

const log = childLogger('database');

let db: Database.Database | null = null;

type Migration = {
  version: number;
  sql?: string;
  run?: (database: Database.Database) => void;
};

/**
 * The schema, as one consolidated baseline.
 *
 * This is the second such consolidation. The first folded D1 → D30 into a
 * single entry; this one folds v31 → v72 into the same shape, for the same
 * reasons and by the same recipe: the body below is the `sqlite_master` output
 * of a database built by running every one of those migrations in order, with
 * `IF NOT EXISTS` added to each statement.
 *
 * Why it is safe to drop the steps: they only ever ran forward, and every
 * deployment that existed has already run them. A fresh install never needed
 * the intermediate states — it needed the schema they add up to, which is what
 * this is. Nothing here rolls a v55 database forward to v72; if such a database
 * ever turns up, restore it under an older release first and let that walk it
 * up.
 *
 * What the steps did carry, and what this must therefore carry too, is SEED
 * DATA. Several migrations inserted reference rows (the resource types, the
 * triumphal package values), and a schema-only squash would have produced a
 * fresh install whose `resource_types` table is empty — which fails silently,
 * because an unknown resource simply lands unresolved and looks like a bad OCR
 * read. `run` below reinstates them.
 *
 * To change the schema from here, append a NEW entry at version 73 or higher.
 * The runner compares against `MAX(version)` in schema_version, so an existing
 * database (already at 72) skips this entry entirely and applies only what
 * comes after it.
 *
 * The full history of every squashed migration remains in git.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 72,
    sql: `
      CREATE TABLE IF NOT EXISTS "audit_log" (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER REFERENCES users(id),
              clan_id INTEGER REFERENCES clans(id),
              action TEXT NOT NULL,
              details TEXT,
              created_at TEXT NOT NULL
            );

      CREATE TABLE IF NOT EXISTS chest_daily_summary (
              clan_id   INTEGER NOT NULL,
              member_id INTEGER NOT NULL,
              game_day  TEXT    NOT NULL,
              chests    INTEGER NOT NULL,
              points    INTEGER NOT NULL, earned_chests INTEGER NOT NULL DEFAULT 0, earned_points INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (clan_id, member_id, game_day)
            );

      CREATE TABLE IF NOT EXISTS chest_definition_ref (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              type TEXT NOT NULL,
              name TEXT NOT NULL,
              source TEXT NOT NULL,
              points INTEGER NOT NULL DEFAULT 0,
              override_points INTEGER
            );

      CREATE TABLE IF NOT EXISTS chest_records (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              clan_id INTEGER NOT NULL DEFAULT 1,
              session_id INTEGER NOT NULL REFERENCES scan_sessions(id),
              member_id INTEGER NOT NULL REFERENCES members(id),
              chest_id INTEGER NOT NULL REFERENCES chests(id),
              chest_source_id INTEGER REFERENCES chest_sources(id),
              point_value INTEGER NOT NULL DEFAULT 0,
              captured_at INTEGER NOT NULL,
              confidence INTEGER NOT NULL DEFAULT 0,
              debug_crop_path TEXT, raw_player_ocr TEXT, earned_at INTEGER, effective_at
              GENERATED ALWAYS AS (COALESCE(earned_at, captured_at)) VIRTUAL,
              UNIQUE(session_id, member_id, chest_id, captured_at)
            );

      CREATE TABLE IF NOT EXISTS chest_sources (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              source TEXT NOT NULL UNIQUE
            );

      CREATE TABLE IF NOT EXISTS chest_type_overrides (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              clan_id INTEGER NOT NULL REFERENCES clans(id) DEFAULT 1,
              chest_name TEXT NOT NULL,
              chest_type TEXT NOT NULL,
              created_at TEXT NOT NULL,
              UNIQUE(clan_id, chest_name)
            );

      CREATE TABLE IF NOT EXISTS chests (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL UNIQUE,
              chest_type TEXT NOT NULL DEFAULT 'unknown'
            );

      CREATE TABLE IF NOT EXISTS clans (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL UNIQUE,
              slug TEXT NOT NULL UNIQUE,
              game_url TEXT NOT NULL,
              scan_interval_minutes INTEGER,
              is_active INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL,
              created_by INTEGER REFERENCES users(id),
              discord_enabled INTEGER NOT NULL DEFAULT 0,
              discord_token TEXT NOT NULL DEFAULT '',
              discord_channel_id TEXT NOT NULL DEFAULT '',
              discord_guild_id TEXT NOT NULL DEFAULT '',
              discord_scan_reports_enabled INTEGER NOT NULL DEFAULT 1,
              discord_only_new_chests INTEGER NOT NULL DEFAULT 0,
              discord_daily_digest_enabled INTEGER NOT NULL DEFAULT 0,
              discord_commands_enabled INTEGER NOT NULL DEFAULT 1,
              ct_share_code TEXT NOT NULL DEFAULT '',
              ct_poll_interval_hours INTEGER,
              ct_backfill_weeks INTEGER,
              public_share_token TEXT NOT NULL DEFAULT '',
              discord_daily_digest_share_user_id TEXT NOT NULL DEFAULT '',
              last_digest_at TEXT NOT NULL DEFAULT '',
              last_digest_channel_error TEXT NOT NULL DEFAULT '',
              last_digest_dm_error TEXT NOT NULL DEFAULT ''
            , needs_reauth INTEGER NOT NULL DEFAULT 0, reauth_failed_at TEXT NOT NULL DEFAULT '', resources_enabled INTEGER NOT NULL DEFAULT 0, last_digest_game_day TEXT NOT NULL DEFAULT '', inactivity_days INTEGER, inactivity_sweep_enabled INTEGER NOT NULL DEFAULT 1, resource_auto_capture INTEGER NOT NULL DEFAULT 1, leaderboard_goal_enabled INTEGER NOT NULL DEFAULT 0, leaderboard_weekly_goal_points INTEGER);

      CREATE TABLE IF NOT EXISTS ct_config (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

      CREATE TABLE IF NOT EXISTS ct_player_ref (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              clan_id INTEGER NOT NULL DEFAULT 1,
              name TEXT NOT NULL,
              UNIQUE(clan_id, name)
            );

      CREATE TABLE IF NOT EXISTS discord_member_links (
              clan_id         INTEGER NOT NULL REFERENCES clans(id),
              discord_user_id TEXT    NOT NULL,
              member_id       INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
              linked_at       TEXT    NOT NULL,
              PRIMARY KEY (clan_id, discord_user_id)
            );

      CREATE TABLE IF NOT EXISTS member_snapshots (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              member_id INTEGER NOT NULL REFERENCES members(id),
              level INTEGER NOT NULL,
              power INTEGER NOT NULL,
              captured_at TEXT NOT NULL,
              clan_id INTEGER DEFAULT 1
            , game_date TEXT NOT NULL DEFAULT '', row_crop_path TEXT);

      CREATE TABLE IF NOT EXISTS members (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              clan_id INTEGER NOT NULL REFERENCES clans(id) DEFAULT 1,
              name TEXT NOT NULL,
              normalized_name TEXT NOT NULL,
              aliases TEXT DEFAULT '[]',
              first_seen TEXT NOT NULL,
              last_seen TEXT NOT NULL,
              is_active INTEGER DEFAULT 1,
              level INTEGER DEFAULT 0,
              power INTEGER DEFAULT 0,
              clan_role TEXT DEFAULT '', despaced_name TEXT NOT NULL DEFAULT '', left_at TEXT,
              UNIQUE(clan_id, normalized_name)
            );

      CREATE TABLE IF NOT EXISTS merge_rules (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              clan_id INTEGER NOT NULL REFERENCES clans(id) DEFAULT 1,
              type TEXT NOT NULL CHECK(type IN ('player', 'chest', 'source')),
              from_value TEXT NOT NULL,
              to_value TEXT NOT NULL,
              created_at TEXT NOT NULL,
              UNIQUE(clan_id, type, from_value)
            );

      CREATE TABLE IF NOT EXISTS player_category (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
              player_ref_id INTEGER NOT NULL REFERENCES ct_player_ref(id),
              category TEXT NOT NULL,
              chests INTEGER NOT NULL DEFAULT 0,
              clan_id INTEGER NOT NULL DEFAULT 1
            );

      CREATE TABLE IF NOT EXISTS player_snapshot (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
              player_ref_id INTEGER NOT NULL REFERENCES ct_player_ref(id),
              guards_level INTEGER NOT NULL DEFAULT 0,
              points INTEGER NOT NULL DEFAULT 0,
              chests INTEGER NOT NULL DEFAULT 0,
              clan_id INTEGER NOT NULL DEFAULT 1
            );

      CREATE TABLE IF NOT EXISTS poll_log (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              polled_at TEXT NOT NULL,
              share_code TEXT NOT NULL,
              window_start TEXT NOT NULL,
              window_end TEXT NOT NULL,
              trigger TEXT NOT NULL,
              status INTEGER NOT NULL,
              etag_changed INTEGER NOT NULL DEFAULT 0,
              prior_etag TEXT,
              new_etag TEXT,
              error_message TEXT,
              clan_id INTEGER NOT NULL DEFAULT 1
            );

      CREATE TABLE IF NOT EXISTS resource_capture_cursor (
              clan_id        INTEGER PRIMARY KEY REFERENCES clans(id),
              -- JSON array of row fingerprints, newest first, starting at the newest row
              -- the game had FINISHED writing. Not the top of the list: those rows are
              -- still being merged into and move. See buildCursorFingerprints in
              -- browser/resource-sweep-rules.ts.
              top_rows       TEXT NOT NULL,
              -- Game day the capture last RAN on. Purely the once-a-day gate, and it
              -- advances even on a run that could not move the marker.
              game_date      TEXT NOT NULL,
              captured_at    TEXT NOT NULL,
              -- transaction_date of the row top_rows starts at — i.e. how old the MARKER
              -- is, which is not the same as how long ago the phase ran. The date backstop
              -- is sized from this, so that a run of unusable reads widens the next sweep
              -- to reach a marker that is getting older instead of stopping short of it.
              newest_date    TEXT NOT NULL DEFAULT '',
              rows_inserted  INTEGER NOT NULL DEFAULT 0
            );

      CREATE TABLE IF NOT EXISTS resource_icon_templates (
              id               INTEGER PRIMARY KEY AUTOINCREMENT,
              clan_id          INTEGER NOT NULL REFERENCES clans(id),
              resource_type_id INTEGER NOT NULL REFERENCES resource_types(id),
              template_data    BLOB NOT NULL,
              updated_at       TEXT NOT NULL,
              UNIQUE(clan_id, resource_type_id)
            );

      CREATE TABLE IF NOT EXISTS "resource_transactions" (
              id               INTEGER PRIMARY KEY AUTOINCREMENT,
              clan_id          INTEGER NOT NULL REFERENCES clans(id),
              batch_id         INTEGER NOT NULL REFERENCES resource_upload_batches(id),
              member_id        INTEGER NOT NULL REFERENCES members(id),
              resource_type_id INTEGER REFERENCES resource_types(id),
              direction        INTEGER NOT NULL CHECK(direction IN (1, -1)),
              amount           INTEGER NOT NULL CHECK(amount > 0),
              transaction_date TEXT NOT NULL,
              raw_player_name  TEXT NOT NULL DEFAULT '',
              created_at       TEXT NOT NULL
            , row_crop_path TEXT);

      CREATE TABLE IF NOT EXISTS resource_types (
              id   INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL UNIQUE,
              slug TEXT NOT NULL UNIQUE
            );

      CREATE TABLE IF NOT EXISTS "resource_upload_batches" (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    clan_id      INTEGER NOT NULL REFERENCES clans(id),
                    uploaded_by  INTEGER REFERENCES users(id),
                    uploaded_at  TEXT NOT NULL,
                    upload_date  TEXT NOT NULL,
                    row_count    INTEGER NOT NULL DEFAULT 0,
                    error_count  INTEGER NOT NULL DEFAULT 0,
                    notes        TEXT NOT NULL DEFAULT '',
                    file_count   INTEGER NOT NULL DEFAULT 1
                  , source TEXT NOT NULL DEFAULT 'upload');

      CREATE TABLE IF NOT EXISTS review_acknowledgments (
              clan_id INTEGER NOT NULL REFERENCES clans(id) DEFAULT 1,
              category TEXT NOT NULL CHECK(category IN ('chest_name', 'chest_source', 'member')),
              acknowledged_at TEXT NOT NULL,
              PRIMARY KEY (clan_id, category)
            );

      CREATE TABLE IF NOT EXISTS scan_sessions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              started_at TEXT NOT NULL,
              completed_at TEXT,
              status TEXT NOT NULL DEFAULT 'pending',
              chests_found INTEGER DEFAULT 0,
              screenshots_taken INTEGER DEFAULT 0,
              errors_encountered INTEGER DEFAULT 0,
              trigger_source TEXT NOT NULL DEFAULT 'scheduled',
              error_message TEXT,
              error_phase TEXT,
              clan_id INTEGER DEFAULT 1
            );

      CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
          );

      CREATE TABLE IF NOT EXISTS share_link_daily (
              link_id INTEGER NOT NULL REFERENCES share_links(id),
              day     TEXT NOT NULL,
              views   INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (link_id, day)
            );

      CREATE TABLE IF NOT EXISTS share_links (
              id            INTEGER PRIMARY KEY AUTOINCREMENT,
              clan_id       INTEGER NOT NULL REFERENCES clans(id),
              token         TEXT NOT NULL,
              created_at    TEXT NOT NULL,
              created_by    INTEGER REFERENCES users(id),
              revoked_at    TEXT,
              revoked_by    INTEGER REFERENCES users(id),
              revoke_reason TEXT NOT NULL DEFAULT '',
              hit_count        INTEGER NOT NULL DEFAULT 0,
              last_used_at     TEXT,
              api_hit_count    INTEGER NOT NULL DEFAULT 0,
              api_last_used_at TEXT
            , unique_visits INTEGER NOT NULL DEFAULT 0, return_visits INTEGER NOT NULL DEFAULT 0, duration_ms_total INTEGER NOT NULL DEFAULT 0, duration_samples INTEGER NOT NULL DEFAULT 0, timeframe_changes INTEGER NOT NULL DEFAULT 0);

      CREATE TABLE IF NOT EXISTS snapshot (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              fetched_at TEXT NOT NULL,
              share_code TEXT NOT NULL,
              window_start TEXT NOT NULL,
              window_end TEXT NOT NULL,
              duration_days INTEGER NOT NULL,
              player_count INTEGER NOT NULL DEFAULT 0,
              total_chests INTEGER NOT NULL DEFAULT 0,
              total_points INTEGER NOT NULL DEFAULT 0,
              trigger TEXT NOT NULL DEFAULT 'scheduled',
              etag TEXT,
              settings_json TEXT,
              last_scanned_at TEXT,
              kingdom INTEGER,
              scoring_json TEXT,
              clan_id INTEGER NOT NULL DEFAULT 1
            );

      CREATE TABLE IF NOT EXISTS snapshot_chest_definition (
              snapshot_id INTEGER NOT NULL REFERENCES snapshot(id) ON DELETE CASCADE,
              chest_definition_ref_id INTEGER NOT NULL REFERENCES chest_definition_ref(id),
              clan_id INTEGER NOT NULL DEFAULT 1,
              PRIMARY KEY (snapshot_id, chest_definition_ref_id)
            );

      CREATE TABLE IF NOT EXISTS "source_point_overrides" (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              source_key TEXT NOT NULL,
              chest_name TEXT NOT NULL DEFAULT '',
              point_value INTEGER NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE(source_key, chest_name)
            );

      CREATE TABLE IF NOT EXISTS triumphal_chest_points (
              id             INTEGER PRIMARY KEY AUTOINCREMENT,
              chest_name     TEXT NOT NULL UNIQUE,
              package_points INTEGER NOT NULL,
              updated_at     TEXT NOT NULL
            );

      CREATE TABLE IF NOT EXISTS triumphal_chest_records (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              clan_id INTEGER NOT NULL DEFAULT 1,
              session_id INTEGER NOT NULL REFERENCES scan_sessions(id),
              member_id INTEGER NOT NULL REFERENCES members(id),
              chest_id INTEGER NOT NULL REFERENCES chests(id),
              chest_source_id INTEGER REFERENCES chest_sources(id),
              point_value INTEGER NOT NULL DEFAULT 0,
              captured_at INTEGER NOT NULL,
              confidence INTEGER NOT NULL DEFAULT 0,
              debug_crop_path TEXT
            , raw_player_ocr TEXT, earned_at INTEGER, effective_at
              GENERATED ALWAYS AS (COALESCE(earned_at, captured_at)) VIRTUAL);

      CREATE TABLE IF NOT EXISTS user_sessions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              token TEXT NOT NULL UNIQUE,
              expires_at TEXT NOT NULL,
              created_at TEXT NOT NULL,
              active_clan_id INTEGER REFERENCES clans(id)
            );

      CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              username TEXT NOT NULL UNIQUE,
              password_hash TEXT NOT NULL,
              role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('superadmin', 'admin', 'user')),
              created_by INTEGER REFERENCES users(id),
              created_at TEXT NOT NULL,
              last_login TEXT,
              clan_id INTEGER REFERENCES clans(id)
            , last_visited TEXT, theme TEXT NOT NULL DEFAULT 'dark');

      CREATE VIEW IF NOT EXISTS chest_records_v AS
              SELECT
                cr.id, cr.clan_id, cr.session_id,
                m.name AS player_name,
                cr.member_id,
                ch.name AS chest_name, ch.chest_type,
                COALESCE(cs.source, '') AS chest_source,
                1 AS quantity,
                cr.point_value, cr.captured_at, cr.effective_at, cr.confidence,
                cr.debug_crop_path, cr.chest_id, cr.chest_source_id
              FROM chest_records cr
              JOIN members m ON m.id = cr.member_id
              JOIN chests ch ON ch.id = cr.chest_id
              LEFT JOIN chest_sources cs ON cs.id = cr.chest_source_id;

      CREATE VIEW IF NOT EXISTS triumphal_chest_records_v AS
              SELECT
                tr.id, tr.clan_id, tr.session_id,
                m.name AS player_name,
                tr.member_id,
                ch.name AS chest_name, ch.chest_type,
                COALESCE(cs.source, '') AS chest_source,
                1 AS quantity,
                tr.point_value, tr.captured_at, tr.effective_at, tr.confidence,
                tr.debug_crop_path, tr.chest_id, tr.chest_source_id
              FROM triumphal_chest_records tr
              JOIN members m ON m.id = tr.member_id
              JOIN chests ch ON ch.id = tr.chest_id
              LEFT JOIN chest_sources cs ON cs.id = tr.chest_source_id;

      CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_chest_def_ref_unique
              ON chest_definition_ref(type, name, source, points, COALESCE(override_points, -1));

      CREATE INDEX IF NOT EXISTS idx_chest_records_captured        ON chest_records(captured_at);

      CREATE INDEX IF NOT EXISTS idx_chest_records_chest_id        ON chest_records(chest_id);

      CREATE INDEX IF NOT EXISTS idx_chest_records_chest_source_id ON chest_records(chest_source_id);

      CREATE INDEX IF NOT EXISTS idx_chest_records_clan_chest_captured  ON chest_records(clan_id, chest_id, captured_at);

      CREATE INDEX IF NOT EXISTS idx_chest_records_clan_points ON chest_records(clan_id, point_value);

      CREATE INDEX IF NOT EXISTS idx_chest_records_clan_source_captured ON chest_records(clan_id, chest_source_id, captured_at);

      CREATE INDEX IF NOT EXISTS idx_chest_records_clan_source_chest    ON chest_records(clan_id, chest_source_id, chest_id);

      CREATE INDEX IF NOT EXISTS idx_chest_records_member          ON chest_records(member_id);

      CREATE INDEX IF NOT EXISTS idx_chest_records_session         ON chest_records(session_id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_clans_public_share_token
              ON clans(public_share_token) WHERE public_share_token != '';

      CREATE INDEX IF NOT EXISTS idx_cr_clan_captured_member_pts ON chest_records(clan_id, captured_at, member_id, point_value);

      CREATE INDEX IF NOT EXISTS idx_cr_clan_chest_pts           ON chest_records(clan_id, chest_id, point_value);

      CREATE INDEX IF NOT EXISTS idx_cr_clan_effective_member_pts ON chest_records(clan_id, effective_at, member_id, point_value);

      CREATE INDEX IF NOT EXISTS idx_cr_clan_member_captured_pts ON chest_records(clan_id, member_id, captured_at, point_value);

      CREATE INDEX IF NOT EXISTS idx_cr_clan_member_effective_pts ON chest_records(clan_id, member_id, effective_at, point_value);

      CREATE INDEX IF NOT EXISTS idx_cr_clan_source_pts          ON chest_records(clan_id, chest_source_id, point_value);

      CREATE INDEX IF NOT EXISTS idx_discord_links_member ON discord_member_links(member_id);

      CREATE INDEX IF NOT EXISTS idx_member_snapshots_clan   ON member_snapshots(clan_id);

      CREATE INDEX IF NOT EXISTS idx_member_snapshots_clan_day
              ON member_snapshots(clan_id, game_date);

      CREATE INDEX IF NOT EXISTS idx_member_snapshots_member ON member_snapshots(member_id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_member_snapshots_member_day
              ON member_snapshots(member_id, game_date) WHERE game_date != '';

      CREATE INDEX IF NOT EXISTS idx_members_clan       ON members(clan_id);

      CREATE INDEX IF NOT EXISTS idx_members_clan_active        ON members(clan_id, is_active);

      CREATE INDEX IF NOT EXISTS idx_members_despaced ON members(clan_id, despaced_name);

      CREATE INDEX IF NOT EXISTS idx_members_name       ON members(name);

      CREATE INDEX IF NOT EXISTS idx_members_normalized ON members(normalized_name);

      CREATE INDEX IF NOT EXISTS idx_player_category_ref      ON player_category(player_ref_id);

      CREATE INDEX IF NOT EXISTS idx_player_category_snapshot ON player_category(snapshot_id);

      CREATE INDEX IF NOT EXISTS idx_player_snapshot_clan     ON player_snapshot(clan_id);

      CREATE INDEX IF NOT EXISTS idx_player_snapshot_ref      ON player_snapshot(player_ref_id);

      CREATE INDEX IF NOT EXISTS idx_player_snapshot_snapshot ON player_snapshot(snapshot_id);

      CREATE INDEX IF NOT EXISTS idx_poll_log_clan       ON poll_log(clan_id);

      CREATE INDEX IF NOT EXISTS idx_poll_log_polled_at  ON poll_log(polled_at);

      CREATE INDEX IF NOT EXISTS idx_poll_log_share_code ON poll_log(share_code);

      CREATE INDEX IF NOT EXISTS idx_resource_icon_templates_clan
              ON resource_icon_templates(clan_id);

      CREATE INDEX IF NOT EXISTS idx_resource_transactions_clan
              ON resource_transactions(clan_id);

      CREATE INDEX IF NOT EXISTS idx_resource_transactions_date
              ON resource_transactions(clan_id, transaction_date);

      CREATE INDEX IF NOT EXISTS idx_resource_transactions_member
              ON resource_transactions(member_id);

      CREATE INDEX IF NOT EXISTS idx_resource_transactions_unresolved
              ON resource_transactions(clan_id, transaction_date)
              WHERE resource_type_id IS NULL;

      CREATE INDEX IF NOT EXISTS idx_resource_upload_batches_clan
                    ON resource_upload_batches(clan_id);

      CREATE INDEX IF NOT EXISTS idx_scan_sessions_clan ON scan_sessions(clan_id);

      CREATE INDEX IF NOT EXISTS idx_scan_sessions_clan_status_completed ON scan_sessions(clan_id, status, completed_at);

      CREATE INDEX IF NOT EXISTS idx_share_links_clan ON share_links(clan_id, revoked_at);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_share_links_token ON share_links(token);

      CREATE INDEX IF NOT EXISTS idx_snapshot_chest_def_clan
              ON snapshot_chest_definition(clan_id);

      CREATE INDEX IF NOT EXISTS idx_snapshot_chest_def_ref
              ON snapshot_chest_definition(chest_definition_ref_id);

      CREATE INDEX IF NOT EXISTS idx_snapshot_clan            ON snapshot(clan_id);

      CREATE INDEX IF NOT EXISTS idx_snapshot_fetched_at      ON snapshot(fetched_at);

      CREATE INDEX IF NOT EXISTS idx_snapshot_kingdom         ON snapshot(kingdom);

      CREATE INDEX IF NOT EXISTS idx_snapshot_last_scanned_at ON snapshot(last_scanned_at);

      CREATE INDEX IF NOT EXISTS idx_snapshot_share_code      ON snapshot(share_code);

      CREATE INDEX IF NOT EXISTS idx_snapshot_window          ON snapshot(window_start, window_end);

      CREATE INDEX IF NOT EXISTS idx_triumphal_chest_records_captured ON triumphal_chest_records(captured_at);

      CREATE INDEX IF NOT EXISTS idx_triumphal_chest_records_clan     ON triumphal_chest_records(clan_id);

      CREATE INDEX IF NOT EXISTS idx_triumphal_chest_records_member   ON triumphal_chest_records(member_id);

      CREATE INDEX IF NOT EXISTS idx_triumphal_chest_records_session  ON triumphal_chest_records(session_id);

      CREATE INDEX IF NOT EXISTS idx_triumphal_clan_effective ON triumphal_chest_records(clan_id, effective_at);

      CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token);

      CREATE INDEX IF NOT EXISTS idx_users_clan          ON users(clan_id);

      CREATE INDEX IF NOT EXISTS idx_users_username      ON users(username);
    `,
    run: (database): void => {
      // Reference rows that migrations used to insert. INSERT OR IGNORE keeps
      // this a no-op on a database that already holds them.
      const types: Array<[string, string]> = [
        ['Food', 'food'],
        ['Silver', 'silver'],
        ['Lumber', 'lumber'],
        ['Dragon Coins', 'dragon-coins'],
        ['Iron', 'iron'],
        ['Scientific Tractates', 'scientific-tractates'],
        ['Clan Speedup', 'clan-speedup'],
        ['Stone', 'stone'],
        ['Omen Essence', 'omen-essence'],
        ['Boards', 'boards'],
        ['Cement', 'cement'],
        ['Chronoglyph Clan Fragment', 'chronoglyph-clan-fragment'],
        ['Seal of Suppression', 'seal-of-suppression'],
        ['Steel', 'steel'],
        ['Hermes\' Loyalty Level', 'hermes-loyalty-level'],
        ['Torch of Olympus Clan Fragment', 'torch-of-olympus-clan-fragment'],
        ['Religious Tractates', 'religious-tractates'],
      ];
      const insertType = database.prepare(
        'INSERT OR IGNORE INTO resource_types (name, slug) VALUES (?, ?)',
      );
      for (const [name, slug] of types) insertType.run(name, slug);

      // Seeded from the code constant rather than a copied list, so the two
      // cannot drift: a chest added to TRIUMPHAL_PACKAGE_POINTS is seeded here
      // on the next fresh install without touching this file.
      const now = new Date().toISOString();
      const insertTriumphal = database.prepare(
        `INSERT OR IGNORE INTO triumphal_chest_points (chest_name, package_points, updated_at)
         VALUES (?, ?, ?)`,
      );
      for (const [name, points] of Object.entries(TRIUMPHAL_PACKAGE_POINTS)) {
        insertTriumphal.run(name, points, now);
      }
    },
  },
  {
    // Soft delete for clans.
    //
    // Deleting a clan used to run a cascade across ~20 tables, and the only
    // thing standing between an operator and permanent loss was the pre-action
    // snapshot taken moments before. That is a backup, not a safety net: it
    // expires under retention, it has to be found, and restoring from it is a
    // separate piece of machinery. A clan deleted in September was recoverable
    // only because one such file happened to still exist.
    //
    // So the rows now stay and the clan is marked instead. Empty string rather
    // than NULL for the same reason the rest of this schema uses it — the
    // lookups all read `deleted_at = ''`, and a NULL would silently never match.
    version: 73,
    sql: `
      ALTER TABLE clans ADD COLUMN deleted_at TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    // Many public share links per clan, each with its own counters, plus
    // admin-chosen vanity keys.
    //
    // share_links was already a per-token ledger; what capped a clan at one
    // live link was clans.public_share_token, the column `/<token>` actually
    // resolved through. This migration moves resolution onto the ledger and
    // drops that column rather than keeping it as a "primary" link: the whole
    // failure mode of the old design was two places claiming to know which
    // token is live, and a clan with five links has no honest answer to put
    // in a single column.
    //
    // The backfill is the load-bearing half. A clan whose token predates the
    // ledger has no share_links row at all, and dropping the column without
    // seeding one would take its live URL offline silently — the exact class
    // of failure (a link that 404s while the data is still right there) this
    // codebase has already paid for once at the edge.
    version: 74,
    run: (database): void => {
      database.exec(`ALTER TABLE share_links ADD COLUMN label TEXT NOT NULL DEFAULT ''`);
      database.exec(`ALTER TABLE share_links ADD COLUMN is_vanity INTEGER NOT NULL DEFAULT 0`);

      // Seed a live ledger row for any clan holding a token the ledger doesn't
      // know about (pre-ledger installs), so no working URL goes dark.
      const orphans = database
        .prepare(
          `SELECT id, public_share_token AS token FROM clans
            WHERE public_share_token != ''
              AND public_share_token NOT IN (SELECT token FROM share_links)`,
        )
        .all() as { id: number; token: string }[];
      const insertLink = database.prepare(
        `INSERT INTO share_links (clan_id, token, created_at, created_by)
         VALUES (?, ?, ?, NULL)`,
      );
      const now = new Date().toISOString();
      for (const o of orphans) insertLink.run(o.id, o.token, now);

      // A clan's token could also exist in the ledger as REVOKED while the
      // column still pointed at it (they were updated independently before
      // this). The column was authoritative, so trust it and re-activate.
      database
        .prepare(
          `UPDATE share_links SET revoked_at = NULL, revoked_by = NULL, revoke_reason = ''
            WHERE revoked_at IS NOT NULL
              AND token IN (SELECT public_share_token FROM clans WHERE public_share_token != '')`,
        )
        .run();

      // The index has to go first — SQLite refuses to drop an indexed column.
      database.exec('DROP INDEX IF EXISTS idx_clans_public_share_token');
      database.exec('ALTER TABLE clans DROP COLUMN public_share_token');
    },
  },
  {
    // Guards levels an admin entered by hand.
    //
    // The level itself is never stored: it is estimated on every read from the
    // donations already in resource_transactions (src/data/guards-estimator.ts),
    // so that one more day of evidence can overturn any earlier judgement — the
    // same reason hero level is filtered on read rather than clamped on write.
    // What the estimator cannot do without help is a member who never donates
    // essence or tractates, or one whose rows are misattributed; this is where a
    // leader records what a member told them. Each row is a DATED observation
    // the estimator weighs like any other, so a report is a floor for its date
    // and later donations can still carry the member above it.
    //
    // member_id cascades: a member deleted outright takes its reports with it.
    // A MERGE must not rely on that — merge-repo repoints them first.
    version: 75,
    sql: `
      CREATE TABLE IF NOT EXISTS member_guards_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        clan_id INTEGER NOT NULL REFERENCES clans(id),
        member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 9),
        observed_date TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_member_guards_reports_member
        ON member_guards_reports(clan_id, member_id);
    `,
  },
  {
    // The event calendar stops being a pure pass-through of the tbclanportal
    // feed (src/external/event-calendar.ts).
    //
    // event_calendar_runs is what the feed SAID, kept after it stops saying it.
    // The feed is a rolling ~1-month window, and a run that ages out of it was
    // previously re-projected from the event's cadence, which is only right while
    // the game never moves anything. In Oct 2026 it moved the 24-day rotation
    // (Dark Omens Oct 21 → Oct 15), and that projection would have put the run
    // back on Oct 21 the moment it left the feed. Global, like the feed: one row
    // per run the feed has shown as started, keyed by its start.
    //
    // event_schedule_corrections is the hand fix for a feed that is behind the
    // game: tbclanportal still listed the Oct 2026 Olympus on Oct 30 when it ran
    // Oct 24, and every public calendar copied it. A row moves ONE feed run, and
    // only while the feed still lists a run at feed_start_at — so it falls inert
    // by itself once the portal corrects its own feed.
    version: 76,
    sql: `
      CREATE TABLE IF NOT EXISTS event_calendar_runs (
        event_key TEXT NOT NULL,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        PRIMARY KEY (event_key, start_at)
      );
      CREATE TABLE IF NOT EXISTS event_schedule_corrections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL,
        feed_start_at TEXT NOT NULL,
        actual_start_at TEXT NOT NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        UNIQUE (event_key, feed_start_at)
      );
    `,
  },
  {
    // Tartaros crypts are their own source key now ("tartaros 20"), where they
    // used to share the common one with every other non-epic, non-rare crypt.
    // Their values lived as per-chest overrides under that common key
    // ("common 20" / "Tartaros Chest"); each moves across as the new key's own
    // value, so no chest scores differently and no stored record changes.
    // Matched on the canonical key, so a spaceless "common20" row moves too.
    version: 77,
    run: (database): void => {
      // v86 gave the table a clan_id; a replay after it must keep each row's.
      const perClan = (database.prepare('PRAGMA table_info(source_point_overrides)').all() as { name: string }[])
        .some((c) => c.name === 'clan_id');
      const rows = database.prepare(
        `SELECT id, ${perClan ? 'clan_id' : 'NULL AS clan_id'}, source_key, point_value, updated_at
           FROM source_point_overrides WHERE chest_name = 'Tartaros Chest' ORDER BY id`,
      ).all() as { id: number; clan_id: number | null; source_key: string; point_value: number; updated_at: string }[];
      const insert = perClan
        ? database.prepare(
          "INSERT OR IGNORE INTO source_point_overrides (clan_id, source_key, chest_name, point_value, updated_at) VALUES (?, ?, '', ?, ?)",
        )
        : database.prepare(
          "INSERT OR IGNORE INTO source_point_overrides (source_key, chest_name, point_value, updated_at) VALUES (?, '', ?, ?)",
        );
      const remove = database.prepare('DELETE FROM source_point_overrides WHERE id = ?');
      for (const row of rows) {
        const m = /^common(\d+)$/.exec(canonicalSourceKey(row.source_key));
        if (!m) continue;
        if (perClan) insert.run(row.clan_id, `tartaros ${m[1]}`, row.point_value, row.updated_at);
        else insert.run(`tartaros ${m[1]}`, row.point_value, row.updated_at);
        remove.run(row.id);
      }
    },
  },
  {
    // How a clan cuts its week: 'sunday' (the only shape until now, so every
    // existing clan keeps it) or 'ancients' — Tinman to Tinman, 6 days.
    // Guarded so a test that rewinds schema_version past it can replay it.
    version: 78,
    run: (database): void => {
      const cols = database.prepare('PRAGMA table_info(clans)').all() as { name: string }[];
      if (cols.some((c) => c.name === 'week_start')) return;
      database.exec(`ALTER TABLE clans ADD COLUMN week_start TEXT NOT NULL DEFAULT 'sunday'`);
    },
  },
  {
    // The Ancient planner's per-clan starting values, saved by an admin: JSON
    // { settings, savedAt, savedBy } — see config/ancient-planner-defaults.ts.
    // NULL = the clan never saved any, so the built-ins apply. Guarded for replay.
    version: 79,
    run: (database): void => {
      const cols = database.prepare('PRAGMA table_info(clans)').all() as { name: string }[];
      if (cols.some((c) => c.name === 'ancient_planner_defaults')) return;
      database.exec('ALTER TABLE clans ADD COLUMN ancient_planner_defaults TEXT');
    },
  },
  {
    // Rise of the Ancients standings, pasted in by an admin after each summon
    // (see data/repositories/tinman-repo.ts). The in-game ranking is CUMULATIVE
    // over the run, so each upload is a full snapshot and a summon's own points
    // are the difference from the previous one.
    //
    // One upload per (clan, Tinman game day, summon); re-pasting a summon
    // replaces it. Scores keep the name exactly as pasted next to the member it
    // was matched to, so a wrong match is always visible and correctable.
    // member_id is SET NULL on a member delete (the row falls back to its raw
    // name); a player MERGE repoints it in merge-repo instead. The uploader is a
    // stored username, not a users FK, so the record outlives the account.
    version: 80,
    sql: `
      CREATE TABLE IF NOT EXISTS tinman_uploads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        clan_id INTEGER NOT NULL REFERENCES clans(id),
        tinman_date TEXT NOT NULL,
        summon INTEGER NOT NULL CHECK (summon BETWEEN 1 AND 8),
        uploaded_by TEXT NOT NULL DEFAULT '',
        uploaded_at TEXT NOT NULL,
        UNIQUE (clan_id, tinman_date, summon)
      );
      CREATE TABLE IF NOT EXISTS tinman_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        upload_id INTEGER NOT NULL REFERENCES tinman_uploads(id) ON DELETE CASCADE,
        clan_id INTEGER NOT NULL REFERENCES clans(id),
        rank INTEGER NOT NULL,
        raw_name TEXT NOT NULL,
        member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
        match_kind TEXT NOT NULL CHECK (match_kind IN ('exact', 'fuzzy', 'manual', 'unmatched', 'rejected')),
        points INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tinman_scores_upload ON tinman_scores(upload_id);
      CREATE INDEX IF NOT EXISTS idx_tinman_scores_member ON tinman_scores(clan_id, member_id);
    `,
  },
  {
    // Per-tier point targets for one Rise of the Ancients run, pasted from the
    // Ancient planner's "Points per member" table. One row per (clan, Tinman
    // day); `tiers` is JSON { t9, g9 … g1 → points each }, `kills` the number
    // of kills the targets were made for (null when the paste didn't say).
    version: 81,
    sql: `
      CREATE TABLE IF NOT EXISTS tinman_targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        clan_id INTEGER NOT NULL REFERENCES clans(id),
        tinman_date TEXT NOT NULL,
        tiers TEXT NOT NULL,
        kills INTEGER,
        saved_by TEXT NOT NULL DEFAULT '',
        saved_at TEXT NOT NULL,
        UNIQUE (clan_id, tinman_date)
      );
    `,
  },
  {
    // Levels players post in the in-game chat ("taulen: G8/M8/S7/E8/C35/D284"),
    // imported by an admin (data/repositories/member-levels-repo.ts). One row
    // per member per import, each letter as reported (NULL = not said). The
    // G value is ALSO written as a member_guards_reports entry so the guards
    // estimator weighs it; this table is the full record of what was said.
    // member_id cascades on a member delete; a player MERGE repoints it.
    version: 82,
    sql: `
      CREATE TABLE IF NOT EXISTS member_level_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        clan_id INTEGER NOT NULL REFERENCES clans(id),
        member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        observed_date TEXT NOT NULL,
        g_level INTEGER,
        m_level INTEGER,
        s_level INTEGER,
        e_level INTEGER,
        c_level INTEGER,
        d_level INTEGER,
        raw_text TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_member_level_reports_member
        ON member_level_reports(clan_id, member_id, observed_date);
    `,
  },
  {
    // A record's type comes from its crypt when the crypt states one
    // (getSourceRarity): chests.chest_type is one value per NAME, and Barbarian
    // Chest drops from common and epic crypts alike, so every epic-crypt one
    // read "common". NULL = the source states no rarity and the chest's own
    // type applies. Filled by syncSourceRarities, which runs every boot.
    // Guarded for replay; the view is dropped and rebuilt either way.
    version: 83,
    run: (database): void => {
      const cols = database.prepare('PRAGMA table_info(chest_sources)').all() as { name: string }[];
      if (!cols.some((c) => c.name === 'rarity')) {
        database.exec('ALTER TABLE chest_sources ADD COLUMN rarity TEXT');
      }
      database.exec(`
        DROP VIEW IF EXISTS chest_records_v;
        CREATE VIEW chest_records_v AS
          SELECT
            cr.id, cr.clan_id, cr.session_id,
            m.name AS player_name,
            cr.member_id,
            ch.name AS chest_name, COALESCE(cs.rarity, ch.chest_type) AS chest_type,
            COALESCE(cs.source, '') AS chest_source,
            1 AS quantity,
            cr.point_value, cr.captured_at, cr.effective_at, cr.confidence,
            cr.debug_crop_path, cr.chest_id, cr.chest_source_id
          FROM chest_records cr
          JOIN members m ON m.id = cr.member_id
          JOIN chests ch ON ch.id = cr.chest_id
          LEFT JOIN chest_sources cs ON cs.id = cr.chest_source_id;
      `);
    },
  },
  {
    // The per-clan rarity overrides went with the admin Chest Type card. Every
    // one was already written through to chests.chest_type when it was set, so
    // nothing they said is lost; a chest's type is now declared in KNOWN_CHESTS
    // (syncChestTypes) or comes from its crypt (v83).
    version: 84,
    sql: 'DROP TABLE IF EXISTS chest_type_overrides;',
  },
  {
    // The domain a clan's members reach the app on (SIK uses sinful.day, the
    // rest chests.taul1.com). Links the app builds for a clan — the Discord
    // digest, share-link URLs — use it; '' falls back to WEB_EXTERNAL_URL.
    // Guarded for replay.
    version: 85,
    run: (database): void => {
      const cols = database.prepare('PRAGMA table_info(clans)').all() as { name: string }[];
      if (!cols.some((c) => c.name === 'public_url')) {
        database.exec("ALTER TABLE clans ADD COLUMN public_url TEXT NOT NULL DEFAULT ''");
      }
    },
  },
  {
    // Chest points are per clan again: v43 made them one global table, and
    // clans need to score the same chest differently. Every clan — soft-deleted
    // ones included, so a restore keeps its values — gets a copy of the global
    // rows, so no clan scores anything differently on the day this lands and no
    // stored record moves. From here each clan's rows are its own; a clan
    // created later starts from the built-in defaults. Guarded for replay.
    version: 86,
    run: (database): void => {
      const cols = database.prepare('PRAGMA table_info(source_point_overrides)').all() as { name: string }[];
      if (cols.some((c) => c.name === 'clan_id')) return;
      database.exec(`
        CREATE TABLE source_point_overrides_v86 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          clan_id INTEGER NOT NULL REFERENCES clans(id),
          source_key TEXT NOT NULL,
          chest_name TEXT NOT NULL DEFAULT '',
          point_value INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(clan_id, source_key, chest_name)
        );
        INSERT INTO source_point_overrides_v86 (clan_id, source_key, chest_name, point_value, updated_at)
          SELECT c.id, o.source_key, o.chest_name, o.point_value, o.updated_at
            FROM source_point_overrides o CROSS JOIN clans c
           ORDER BY c.id, o.id;
        DROP TABLE source_point_overrides;
        ALTER TABLE source_point_overrides_v86 RENAME TO source_point_overrides;
      `);
    },
  },
  {
    // The Discord weekly digest: posted after the rollover that ends the
    // clan's week (Sunday, or Tinman to Tinman — whatever week_start says).
    // Off for every existing clan. The last_weekly_* columns mirror the daily
    // digest's last_digest_* ones: the week (its first game day) the last run
    // reported, when, and a short error ('' = delivered). Guarded for replay.
    version: 87,
    run: (database): void => {
      const cols = new Set(
        (database.prepare('PRAGMA table_info(clans)').all() as { name: string }[]).map((c) => c.name),
      );
      const add = (name: string, ddl: string) => {
        if (!cols.has(name)) database.exec(`ALTER TABLE clans ADD COLUMN ${name} ${ddl}`);
      };
      add('discord_weekly_digest_enabled', 'INTEGER NOT NULL DEFAULT 0');
      add('last_weekly_digest_at', "TEXT NOT NULL DEFAULT ''");
      add('last_weekly_digest_week', "TEXT NOT NULL DEFAULT ''");
      add('last_weekly_digest_error', "TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    // Extra clans an account can switch into, beyond its home clan
    // (users.clan_id). Each row carries the account's role IN THAT CLAN, so
    // an admin at home can be a plain user next door. Superadmin-granted;
    // never holds a row for the home clan or for a superadmin. Scoping is
    // resolved per request in validateSession — see user-repo.ts.
    version: 88,
    run: (database): void => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS user_clan_access (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          clan_id INTEGER NOT NULL REFERENCES clans(id),
          role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
          created_at TEXT NOT NULL,
          PRIMARY KEY (user_id, clan_id)
        );
        CREATE INDEX IF NOT EXISTS idx_user_clan_access_clan ON user_clan_access(clan_id);
      `);
    },
  },
  {
    // The account's UI language (lib/i18n.js), synced like the theme. '' =
    // never chosen: the browser's own choice stands and is adopted on first
    // sign-in. English is the default either way. Guarded for replay.
    version: 89,
    run: (database): void => {
      const cols = new Set(
        (database.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name),
      );
      if (!cols.has('language')) {
        database.exec("ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT ''");
      }
    },
  },
  {
    // Pasted event standings beyond Rise of the Ancients: Trials of Olympus is
    // filed per day the way Ancients is per summon (tinman-repo.ts). Uploads
    // gain an event_key ('ancients' for every existing row) and the one-upload
    // rule becomes per (clan, event, run day, round), so an Olympus run that
    // starts on a Tinman day can't collide with that Tinman run.
    //
    // SQLite can't alter a UNIQUE constraint, so both tables are rebuilt with
    // their ids. Scores go first: dropping tinman_uploads while the old
    // tinman_scores still referenced it would CASCADE-delete every score. The
    // rename then repoints tinman_scores_v90's FK at the new tinman_uploads.
    // Guarded for replay.
    version: 90,
    run: (database): void => {
      const cols = database.prepare('PRAGMA table_info(tinman_uploads)').all() as { name: string }[];
      if (cols.some((c) => c.name === 'event_key')) return;
      database.transaction(() => {
        database.exec(`
          CREATE TABLE tinman_uploads_v90 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            clan_id INTEGER NOT NULL REFERENCES clans(id),
            event_key TEXT NOT NULL DEFAULT 'ancients',
            tinman_date TEXT NOT NULL,
            summon INTEGER NOT NULL CHECK (summon BETWEEN 1 AND 8),
            uploaded_by TEXT NOT NULL DEFAULT '',
            uploaded_at TEXT NOT NULL,
            UNIQUE (clan_id, event_key, tinman_date, summon)
          );
          CREATE TABLE tinman_scores_v90 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            upload_id INTEGER NOT NULL REFERENCES tinman_uploads_v90(id) ON DELETE CASCADE,
            clan_id INTEGER NOT NULL REFERENCES clans(id),
            rank INTEGER NOT NULL,
            raw_name TEXT NOT NULL,
            member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
            match_kind TEXT NOT NULL CHECK (match_kind IN ('exact', 'fuzzy', 'manual', 'unmatched', 'rejected')),
            points INTEGER NOT NULL
          );
          INSERT INTO tinman_uploads_v90 (id, clan_id, event_key, tinman_date, summon, uploaded_by, uploaded_at)
            SELECT id, clan_id, 'ancients', tinman_date, summon, uploaded_by, uploaded_at FROM tinman_uploads;
          INSERT INTO tinman_scores_v90 (id, upload_id, clan_id, rank, raw_name, member_id, match_kind, points)
            SELECT id, upload_id, clan_id, rank, raw_name, member_id, match_kind, points FROM tinman_scores;
          DROP TABLE tinman_scores;
          DROP TABLE tinman_uploads;
          ALTER TABLE tinman_uploads_v90 RENAME TO tinman_uploads;
          ALTER TABLE tinman_scores_v90 RENAME TO tinman_scores;
          CREATE INDEX IF NOT EXISTS idx_tinman_scores_upload ON tinman_scores(upload_id);
          CREATE INDEX IF NOT EXISTS idx_tinman_scores_member ON tinman_scores(clan_id, member_id);
        `);
      })();
    },
  },
  {
    // Data only: clan #3's Cauldron → Aldrin rename, whose Nov 3 chests the gift
    // scan filed under "Ilrin". See repair-aldrin-2026-11.ts. Guarded on member
    // id + name + clan, so a no-op anywhere else and safe to replay.
    version: 91,
    run: (database): void => {
      database.transaction(() => repairAldrin(database))();
    },
  },
  {
    // Likely-rename merge suggestions an admin marked "not the same player"
    // (rename-suggestions-repo.ts). Member ids carry no FK on purpose: a row only
    // hides a suggestion, so one outliving its member is inert, and an FK would
    // make every member delete path account for it. deleteClan clears the clan's.
    version: 92,
    sql: `
      CREATE TABLE IF NOT EXISTS rename_suggestion_dismissals (
        clan_id INTEGER NOT NULL,
        from_member_id INTEGER NOT NULL,
        to_member_id INTEGER NOT NULL,
        dismissed_at TEXT NOT NULL,
        PRIMARY KEY (clan_id, from_member_id, to_member_id)
      );
    `,
  },
  {
    // The weekly points goal over time. clans.leaderboard_weekly_goal_points is
    // one number, so raising the goal re-judged every finished week against the
    // new figure. Each row is "from the week starting effective_from, the goal
    // is weekly_points" (utils/weekly-goal.ts, data/goal-history.ts), filled
    // from the audit log's record of every goal save. Backfilled only into an
    // empty table, so a replay leaves later saves alone. deleteClan clears it.
    version: 93,
    run: (database): void => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS clan_goal_history (
          clan_id INTEGER NOT NULL REFERENCES clans(id),
          effective_from TEXT NOT NULL,
          weekly_points INTEGER,
          set_at TEXT NOT NULL,
          -- v94's column, here too: the backfill below writes through
          -- writeGoalStep, which sets it. v94 skips it when present.
          amber_pct INTEGER,
          PRIMARY KEY (clan_id, effective_from)
        );
      `);
      const filled = database.prepare('SELECT COUNT(*) AS c FROM clan_goal_history').get() as { c: number };
      if (filled.c > 0) return;
      database.transaction(() => backfillGoalHistory(
        database, DEFAULT_CONFIG.gameDayRolloverUtcHour, Date.now(),
      ))();
    },
  },
  {
    // The clan's own amber threshold: amber ("close to goal") starts at this
    // percent of the weekly goal; NULL keeps the 66% every clan had until now,
    // so no backfill. Stored on each goal step too, so moving it never repaints
    // finished weeks (utils/weekly-goal.ts). PRAGMA-guarded for replay.
    version: 94,
    run: (database): void => {
      const has = (table: string, column: string): boolean =>
        (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
      if (!has('clans', 'leaderboard_goal_amber_pct')) {
        database.exec('ALTER TABLE clans ADD COLUMN leaderboard_goal_amber_pct INTEGER');
      }
      if (!has('clan_goal_history', 'amber_pct')) {
        database.exec('ALTER TABLE clan_goal_history ADD COLUMN amber_pct INTEGER');
      }
    },
  },
  {
    // Tools → Citadel: each account's saved armies (citadel-preset-repo.ts).
    // Per user, not per clan — an army is one player's troops and bonuses.
    // `data` is the validated JSON the page sends. deleteUser clears them.
    version: 95,
    sql: `
      CREATE TABLE IF NOT EXISTS citadel_presets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, name)
      );
    `,
  },
  {
    // Tools → Citadel: the troop tiers each account has unlocked (Guardsmen,
    // Specialists, Monsters, Engineers; NULL = any). Per user, kept until they
    // change it; the troop picker only offers troops at or below these.
    version: 96,
    sql: `
      CREATE TABLE IF NOT EXISTS citadel_levels (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        g INTEGER CHECK (g BETWEEN 1 AND 9),
        s INTEGER CHECK (s BETWEEN 1 AND 9),
        m INTEGER CHECK (m BETWEEN 1 AND 9),
        e INTEGER CHECK (e BETWEEN 1 AND 9),
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    // Tools → Stacks: each account's saved armies for the stack calculator
    // (stack-preset-repo.ts) — troops, health bonuses and the sizing settings.
    // Same shape as citadel_presets, kept apart so the two lists never mix.
    // deleteUser clears them.
    version: 97,
    sql: `
      CREATE TABLE IF NOT EXISTS stack_presets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, name)
      );
    `,
  },
  {
    // "Your levels": how many top levels the troop picker shows, counted down
    // from the account's highest level (1-4, or 9 = all). NULL keeps the
    // default of 4, so no backfill. PRAGMA-guarded for replay.
    version: 98,
    run: (database): void => {
      const cols = database.prepare('PRAGMA table_info(citadel_levels)').all() as { name: string }[];
      if (!cols.some((c) => c.name === 'span')) {
        database.exec('ALTER TABLE citadel_levels ADD COLUMN span INTEGER CHECK (span BETWEEN 1 AND 9)');
      }
    },
  },
  {
    // Chest points get a history (docs/chest-points-history.md). A value now
    // applies FROM a game day: `effective_from` '' is all history, a date is
    // "from that game day's reset on". `point_value` NULL is "from that day,
    // no value of its own" (the chest falls back to the source value or the
    // default). Every row a save writes from a date belongs to that date's
    // `source_point_changes` step, which the History view lists and edits;
    // corrections to all history and copies are kept there as a log.
    //
    // The existing rows become the all-history values, so no clan scores
    // anything differently on the day this lands and no stored record moves.
    // Guarded for replay.
    version: 99,
    run: (database): void => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS source_point_changes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          clan_id INTEGER NOT NULL REFERENCES clans(id),
          kind TEXT NOT NULL CHECK (kind IN ('step', 'correction', 'copy')),
          effective_from TEXT NOT NULL DEFAULT '',
          lines TEXT NOT NULL DEFAULT '[]',
          note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          created_by TEXT NOT NULL DEFAULT '',
          updated_at TEXT,
          updated_by TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_source_point_steps_day
          ON source_point_changes(clan_id, effective_from) WHERE kind = 'step';
      `);
      const cols = database.prepare('PRAGMA table_info(source_point_overrides)').all() as { name: string }[];
      if (cols.some((c) => c.name === 'effective_from')) return;
      database.exec(`
        CREATE TABLE source_point_overrides_v99 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          clan_id INTEGER NOT NULL REFERENCES clans(id),
          source_key TEXT NOT NULL,
          chest_name TEXT NOT NULL DEFAULT '',
          point_value INTEGER,
          effective_from TEXT NOT NULL DEFAULT '',
          change_id INTEGER REFERENCES source_point_changes(id),
          updated_at TEXT NOT NULL,
          UNIQUE(clan_id, source_key, chest_name, effective_from)
        );
        INSERT INTO source_point_overrides_v99 (id, clan_id, source_key, chest_name, point_value, effective_from, updated_at)
          SELECT id, clan_id, source_key, chest_name, point_value, '', updated_at FROM source_point_overrides;
        DROP TABLE source_point_overrides;
        ALTER TABLE source_point_overrides_v99 RENAME TO source_point_overrides;
      `);
    },
  },
  {
    // Seasonal Kingdoms (docs/seasonal-kingdoms.md). An SK is a 90-day
    // tournament server with its own event rotation, so a clan playing one
    // reads its event windows from tbclanportal's SK calendar
    // (feed.ics?realm=season) instead of the normal one.
    //
    //  - clans.seasonal_kingdom: the per-clan switch on the Clans page.
    //  - event_calendar_runs gains `realm` and it joins the key: the two feeds
    //    list the same event keys, often starting on the same day (both list a
    //    Triumphal reset on 2026-11-21), so without it one feed's archive would
    //    overwrite the other's. Every existing row is the normal feed's.
    //  - Forest Essence and Magic Seeds are SK clan-capital resources; their
    //    icons come from the game's bundles by name (src/game-art).
    //
    // All three halves are guarded, so a replay is a no-op.
    version: 100,
    run: (database): void => {
      const clanCols = database.prepare('PRAGMA table_info(clans)').all() as { name: string }[];
      if (!clanCols.some((c) => c.name === 'seasonal_kingdom')) {
        database.exec('ALTER TABLE clans ADD COLUMN seasonal_kingdom INTEGER NOT NULL DEFAULT 0');
      }
      const runCols = database.prepare('PRAGMA table_info(event_calendar_runs)').all() as { name: string }[];
      if (!runCols.some((c) => c.name === 'realm')) {
        database.exec(`
          CREATE TABLE event_calendar_runs_v100 (
            realm TEXT NOT NULL DEFAULT 'default',
            event_key TEXT NOT NULL,
            start_at TEXT NOT NULL,
            end_at TEXT NOT NULL,
            PRIMARY KEY (realm, event_key, start_at)
          );
          INSERT INTO event_calendar_runs_v100 (realm, event_key, start_at, end_at)
            SELECT 'default', event_key, start_at, end_at FROM event_calendar_runs;
          DROP TABLE event_calendar_runs;
          ALTER TABLE event_calendar_runs_v100 RENAME TO event_calendar_runs;
        `);
      }
      const insertType = database.prepare(
        'INSERT OR IGNORE INTO resource_types (name, slug) VALUES (?, ?)',
      );
      insertType.run('Forest Essence', 'forest-essence');
      insertType.run('Magic Seeds', 'magic-seeds');
    },
  },
  {
    // One-time repair: member names the member-list reader cut at a kingdom number
    // ("Living SK7" read as "Living S") and that a merge then kept as the surviving
    // name — SK7's 41 hand-named members, Nov 13 2026. See repair-cut-names-2026-11.ts.
    // Generic and guarded, so another database or a replay is a no-op.
    version: 101,
    run: (database): void => {
      database.transaction(() => repairCutNames(database))();
    },
  },
  {
    // Game protocol capture (Nov 2026): what the game server itself says, read
    // by the direct client in src/game-protocol before each clan's scan. Runs in
    // parallel with the OCR pipeline first; see docs/game-protocol.md.
    //
    //   game_players        one row per game player per clan, keyed on the game's
    //                       permanent player id (names can change, ids can't)
    //   game_player_history a row only when a player's stats changed
    //   game_gifts          every Gifts / Triumphal entry seen, keyed on the
    //                       game's own gift id, so re-reading never duplicates
    //   game_ledger         Clan Capital ledger entries, keyed on entry id
    //   game_capture_runs   one row per capture, for health and comparison
    //   game_scan_comparisons per scan and tab: the game's gift list vs the
    //                       OCR rows of that scan (src/game-protocol/compare.ts)
    //
    // IF NOT EXISTS throughout: runMigrations replays everything above a
    // rewound MAX(version), so this has to be a no-op the second time.
    version: 102,
    sql: `
      CREATE TABLE IF NOT EXISTS game_players (
        clan_id INTEGER NOT NULL REFERENCES clans(id),
        player_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        role INTEGER,
        joined_at INTEGER,
        in_clan INTEGER NOT NULL DEFAULT 1,
        might INTEGER,
        hero_level INTEGER,
        city_level INTEGER,
        vip INTEGER,
        gold_pass INTEGER,
        hero_avatar INTEGER,
        city_id INTEGER,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        PRIMARY KEY (clan_id, player_id)
      );
      CREATE TABLE IF NOT EXISTS game_player_history (
        clan_id INTEGER NOT NULL REFERENCES clans(id),
        player_id INTEGER NOT NULL,
        captured_at TEXT NOT NULL,
        name TEXT NOT NULL,
        might INTEGER,
        hero_level INTEGER,
        city_level INTEGER,
        vip INTEGER,
        gold_pass INTEGER,
        PRIMARY KEY (clan_id, player_id, captured_at)
      );
      CREATE TABLE IF NOT EXISTS game_gifts (
        clan_id INTEGER NOT NULL REFERENCES clans(id),
        gift_id INTEGER NOT NULL,
        sender_id INTEGER NOT NULL,
        sender_name TEXT NOT NULL DEFAULT '',
        gift_type INTEGER NOT NULL,
        chest_name TEXT NOT NULL DEFAULT '',
        source_name TEXT NOT NULL DEFAULT '',
        chest_count INTEGER NOT NULL DEFAULT 1,
        tab INTEGER NOT NULL DEFAULT 1,
        arrived_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        PRIMARY KEY (clan_id, gift_id)
      );
      CREATE INDEX IF NOT EXISTS idx_game_gifts_arrived ON game_gifts (clan_id, arrived_at);
      CREATE TABLE IF NOT EXISTS game_ledger (
        clan_id INTEGER NOT NULL REFERENCES clans(id),
        entry_id INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        kind INTEGER NOT NULL,
        resource INTEGER NOT NULL,
        amounts TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        captured_at TEXT NOT NULL,
        PRIMARY KEY (clan_id, entry_id)
      );
      CREATE INDEX IF NOT EXISTS idx_game_ledger_time ON game_ledger (clan_id, occurred_at);
      CREATE TABLE IF NOT EXISTS game_capture_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        clan_id INTEGER NOT NULL REFERENCES clans(id),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        ok INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        game_clan_id INTEGER,
        members INTEGER,
        gift_entries INTEGER,
        new_gifts INTEGER,
        ledger_new INTEGER,
        names_version TEXT,
        duration_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_game_capture_runs_clan ON game_capture_runs (clan_id, started_at);
      CREATE TABLE IF NOT EXISTS game_scan_comparisons (
        clan_id INTEGER NOT NULL REFERENCES clans(id),
        -- no FK: a comparison must never block deleting a scan session
        session_id INTEGER NOT NULL,
        capture_run_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        tab INTEGER NOT NULL,
        game INTEGER NOT NULL,
        ocr INTEGER NOT NULL,
        matched INTEGER NOT NULL,
        misreads INTEGER NOT NULL,
        ocr_only INTEGER NOT NULL,
        ocr_late INTEGER NOT NULL,
        game_only INTEGER NOT NULL,
        details TEXT NOT NULL,
        PRIMARY KEY (session_id, tab)
      );
    `,
  },
  {
    // Game protocol, phase 2 (Nov 2026): link our rows to the game's own ids so
    // the protocol can replace the browser scan, and start collecting what the
    // protocol gives that OCR never could. See docs/game-protocol.md.
    //
    //   members.game_player_id        the game's permanent player id (renames keep it)
    //   chest_records / triumphal_chest_records.game_gift_id
    //                                 the gift a protocol-scanned record came from
    //   resource_transactions.game_entry_id
    //                                 the Clan Capital ledger entry a row came from;
    //                                 unique, so re-reading the ledger never double-counts
    //   game_claims                   rewards each claimed chest gave
    //   game_player_techs (+ history) research + hero talent levels per player
    //   game_city_snapshots           daily buildings + hero summary per player
    //   game_map_objects              player-owned map objects (vaults) near the clan
    //   game_raw_snapshots            raw replies (clan record, Clan Capital) daily,
    //                                 kept for fields not decoded yet
    //
    // Every step is guarded / IF NOT EXISTS: runMigrations replays everything
    // above a rewound MAX(version).
    version: 103,
    run: (database): void => {
      const addColumn = (table: string, column: string, ddl: string): void => {
        const cols = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (!cols.some((c) => c.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      };
      addColumn('members', 'game_player_id', 'game_player_id INTEGER');
      addColumn('chest_records', 'game_gift_id', 'game_gift_id INTEGER');
      addColumn('triumphal_chest_records', 'game_gift_id', 'game_gift_id INTEGER');
      addColumn('resource_transactions', 'game_entry_id', 'game_entry_id INTEGER');
      database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_members_game_player
          ON members (clan_id, game_player_id) WHERE game_player_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_tx_game_entry
          ON resource_transactions (clan_id, game_entry_id) WHERE game_entry_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_chest_records_game_gift
          ON chest_records (clan_id, game_gift_id) WHERE game_gift_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS game_claims (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          clan_id INTEGER NOT NULL REFERENCES clans(id),
          session_id INTEGER NOT NULL,
          gift_id INTEGER NOT NULL,
          gift_type INTEGER NOT NULL,
          tab INTEGER NOT NULL,
          rewards TEXT NOT NULL,
          claimed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_game_claims_clan ON game_claims (clan_id, claimed_at);
        CREATE TABLE IF NOT EXISTS game_player_techs (
          clan_id INTEGER NOT NULL REFERENCES clans(id),
          player_id INTEGER NOT NULL,
          tech_id INTEGER NOT NULL,
          level INTEGER NOT NULL,
          first_seen TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          PRIMARY KEY (clan_id, player_id, tech_id)
        );
        CREATE TABLE IF NOT EXISTS game_player_tech_history (
          clan_id INTEGER NOT NULL REFERENCES clans(id),
          player_id INTEGER NOT NULL,
          tech_id INTEGER NOT NULL,
          level INTEGER NOT NULL,
          changed_at TEXT NOT NULL,
          PRIMARY KEY (clan_id, player_id, tech_id, changed_at)
        );
        CREATE TABLE IF NOT EXISTS game_city_snapshots (
          clan_id INTEGER NOT NULL REFERENCES clans(id),
          player_id INTEGER NOT NULL,
          game_date TEXT NOT NULL,
          captured_at TEXT NOT NULL,
          tech_count INTEGER NOT NULL DEFAULT 0,
          buildings TEXT NOT NULL DEFAULT '{}',
          hero TEXT NOT NULL DEFAULT '{}',
          PRIMARY KEY (clan_id, player_id, game_date)
        );
        CREATE TABLE IF NOT EXISTS game_map_objects (
          clan_id INTEGER NOT NULL REFERENCES clans(id),
          object_id INTEGER NOT NULL,
          object_type INTEGER NOT NULL,
          object_name TEXT NOT NULL DEFAULT '',
          level INTEGER,
          realm INTEGER,
          x INTEGER,
          y INTEGER,
          owner_id INTEGER,
          expires_at INTEGER,
          first_seen TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          PRIMARY KEY (clan_id, object_id)
        );
        CREATE INDEX IF NOT EXISTS idx_game_map_objects_owner ON game_map_objects (clan_id, owner_id, first_seen);
        -- Raw game replies kept for later decoding (gzip of the decoded JSON):
        -- the clan record and every clan-owned object (Clan Capital: buildings,
        -- clan research …) once per game day. Collect now, decode when needed.
        CREATE TABLE IF NOT EXISTS game_raw_snapshots (
          clan_id INTEGER NOT NULL REFERENCES clans(id),
          kind TEXT NOT NULL,
          ref_id INTEGER NOT NULL,
          game_date TEXT NOT NULL,
          captured_at TEXT NOT NULL,
          payload BLOB NOT NULL,
          PRIMARY KEY (clan_id, kind, ref_id, game_date)
        );
      `);
    },
  },
  {
    // In-game chat (Nov 2026), read through the game's own chat service with
    // the scanner account's token (src/game-protocol/chat.ts): the clan chat and
    // the account's private (1:1) messages. Stored per clan; two clans scanned
    // through one website account each keep their own copy of its private
    // messages. Message ids are Sendbird's, unique per channel.
    version: 104,
    run: (database): void => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS chat_channels (
          clan_id INTEGER NOT NULL REFERENCES clans(id),
          channel_url TEXT NOT NULL,
          custom_type TEXT NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          member_count INTEGER NOT NULL DEFAULT 0,
          members TEXT NOT NULL DEFAULT '[]',
          last_message_at INTEGER,
          first_seen TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          PRIMARY KEY (clan_id, channel_url)
        );
        CREATE TABLE IF NOT EXISTS chat_messages (
          clan_id INTEGER NOT NULL REFERENCES clans(id),
          channel_url TEXT NOT NULL,
          message_id INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          custom_type TEXT NOT NULL DEFAULT '',
          sender_id TEXT NOT NULL DEFAULT '',
          sender_name TEXT NOT NULL DEFAULT '',
          sender_info TEXT NOT NULL DEFAULT '',
          message TEXT NOT NULL DEFAULT '',
          data TEXT NOT NULL DEFAULT '',
          captured_at TEXT NOT NULL,
          PRIMARY KEY (clan_id, channel_url, message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_chat_messages_time ON chat_messages (clan_id, channel_url, created_at);
      `);
    },
  },
  {
    // Player history also tracks the hero shown (avatar) and the clan rank, so
    // a member's timeline can show hero switches and promotions. Seeded from
    // the current values so the first capture after this records no false change.
    version: 105,
    run: (database): void => {
      const cols = database.prepare('PRAGMA table_info(game_player_history)').all() as { name: string }[];
      if (!cols.some((c) => c.name === 'hero_avatar')) database.exec('ALTER TABLE game_player_history ADD COLUMN hero_avatar INTEGER');
      if (!cols.some((c) => c.name === 'role')) database.exec('ALTER TABLE game_player_history ADD COLUMN role INTEGER');
      database.exec(`
        UPDATE game_player_history SET
          hero_avatar = (SELECT g.hero_avatar FROM game_players g WHERE g.clan_id = game_player_history.clan_id AND g.player_id = game_player_history.player_id),
          role = (SELECT g.role FROM game_players g WHERE g.clan_id = game_player_history.clan_id AND g.player_id = game_player_history.player_id)
        WHERE hero_avatar IS NULL AND role IS NULL;
      `);
    },
  },
  {
    // Each player's captains (Hercules, Skadi, …), from field 30 of the city
    // record the daily city pass already reads: the current value per captain,
    // and a history row whenever it changes (a new captain or progress).
    version: 106,
    run: (database): void => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS game_player_captains (
          clan_id INTEGER NOT NULL REFERENCES clans(id),
          player_id INTEGER NOT NULL,
          captain_id INTEGER NOT NULL,
          value INTEGER NOT NULL,
          first_seen TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          PRIMARY KEY (clan_id, player_id, captain_id)
        );
        CREATE TABLE IF NOT EXISTS game_player_captain_history (
          clan_id INTEGER NOT NULL REFERENCES clans(id),
          player_id INTEGER NOT NULL,
          captain_id INTEGER NOT NULL,
          value INTEGER NOT NULL,
          changed_at TEXT NOT NULL,
          PRIMARY KEY (clan_id, player_id, captain_id, changed_at)
        );
      `);
    },
  },
  {
    // v106 filled game_player_captains from city field 30, which turned out to
    // be the city's ARMY (troop counts by T9 unit id) whose ids merely overlap
    // the T75 captain ids. Those rows are not captains: clear them. The tables
    // stay for the real captain data once its message is found.
    version: 107,
    run: (database): void => {
      database.exec(`
        DELETE FROM game_player_captain_history;
        DELETE FROM game_player_captains;
      `);
    },
  },
  {
    // The real captains: city field 9, readable for every member's city.
    // Level and star level as the game's Captains screen shows them; history
    // keeps a row whenever either moves (or a captain is new). Experience is
    // kept current only — it moves with every battle. The v106 tables were
    // empty since v107, so they are replaced with the right columns.
    version: 108,
    run: (database): void => {
      database.exec(`
        DROP TABLE IF EXISTS game_player_captain_history;
        DROP TABLE IF EXISTS game_player_captains;
        CREATE TABLE game_player_captains (
          clan_id INTEGER NOT NULL REFERENCES clans(id),
          player_id INTEGER NOT NULL,
          captain_id INTEGER NOT NULL,
          level INTEGER NOT NULL,
          stars INTEGER NOT NULL,
          xp INTEGER,
          slot INTEGER NOT NULL DEFAULT 0,
          first_seen TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          PRIMARY KEY (clan_id, player_id, captain_id)
        );
        CREATE TABLE game_player_captain_history (
          clan_id INTEGER NOT NULL REFERENCES clans(id),
          player_id INTEGER NOT NULL,
          captain_id INTEGER NOT NULL,
          level INTEGER NOT NULL,
          stars INTEGER NOT NULL,
          changed_at TEXT NOT NULL,
          PRIMARY KEY (clan_id, player_id, captain_id, changed_at)
        );
      `);
    },
  },
  {
    // Chests are opened a chest TYPE at a time (one 15013 with every gift of
    // that type, like the game's own "Claim chests"), and the game sums the
    // rewards of a request. A game_claims row is now one request: gift_id its
    // first gift, batch_size how many chests it opened, gift_ids all of them
    // (JSON, null for a single chest). Rewards per chest type still average as
    // SUM(rewards) / SUM(batch_size). Guarded: runMigrations may replay this.
    version: 109,
    run: (database): void => {
      const cols = database.prepare('PRAGMA table_info(game_claims)').all() as { name: string }[];
      if (!cols.some((c) => c.name === 'batch_size')) {
        database.exec('ALTER TABLE game_claims ADD COLUMN batch_size INTEGER NOT NULL DEFAULT 1');
      }
      if (!cols.some((c) => c.name === 'gift_ids')) {
        database.exec('ALTER TABLE game_claims ADD COLUMN gift_ids TEXT');
      }
    },
  },
  {
    // v110 — Gold Ingots, public in the game for every player (402 field 17).
    // They tick up by one every few minutes, so they are NOT part of
    // game_player_history's change check (that would write a row per player
    // per scan and re-read every city): game_players holds the current value,
    // game_player_daily the game day's latest reading (updated every scan).
    version: 110,
    run: (database): void => {
      const cols = database.prepare('PRAGMA table_info(game_players)').all() as { name: string }[];
      if (!cols.some((c) => c.name === 'gold_ingots')) {
        database.exec('ALTER TABLE game_players ADD COLUMN gold_ingots INTEGER');
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS game_player_daily (
          clan_id INTEGER NOT NULL REFERENCES clans(id),
          player_id INTEGER NOT NULL,
          game_date TEXT NOT NULL,
          gold_ingots INTEGER,
          captured_at TEXT NOT NULL,
          PRIMARY KEY (clan_id, player_id, game_date)
        );
      `);
    },
  },
  {
    // The clan itself, from the game (Clan page):
    //   game_clan_info          what the in-game Information tab shows and
    //                           rarely changes: tag, name, founded, language,
    //                           the Clan Capital and where it stands;
    //   game_clan_stats         one row per scan: members / member limit,
    //                           might, wealth points (25), help points (14003),
    //                           rank by wealth (23); `raw` keeps every number
    //                           read but not decoded yet;
    //   game_clan_techs (+ _history)  the clan's research — Clan Capital
    //                           field 17 — history only on change;
    //   game_clan_treasury      the capital's treasury (field 5), the day's
    //                           latest read per resource;
    //   game_clan_medals        the Information tab's medals (28001).
    // IF NOT EXISTS: runMigrations may replay this.
    version: 111,
    run: (database): void => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS game_clan_info (
          clan_id INTEGER PRIMARY KEY REFERENCES clans(id),
          game_clan_id INTEGER NOT NULL,
          tag TEXT NOT NULL DEFAULT '',
          name TEXT NOT NULL DEFAULT '',
          founded_at TEXT,
          language TEXT,
          capital_id INTEGER,
          realm INTEGER,
          capital_x INTEGER,
          capital_y INTEGER,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS game_clan_stats (
          clan_id INTEGER NOT NULL REFERENCES clans(id),
          captured_at TEXT NOT NULL,
          game_date TEXT NOT NULL,
          members INTEGER,
          member_limit INTEGER,
          might INTEGER,
          wealth INTEGER,
          help_points INTEGER,
          wealth_rank INTEGER,
          raw TEXT,
          PRIMARY KEY (clan_id, captured_at)
        );
        CREATE INDEX IF NOT EXISTS idx_game_clan_stats_day ON game_clan_stats (clan_id, game_date);
        CREATE TABLE IF NOT EXISTS game_clan_techs (
          clan_id INTEGER NOT NULL REFERENCES clans(id),
          tech_id INTEGER NOT NULL,
          level INTEGER NOT NULL,
          first_seen TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          PRIMARY KEY (clan_id, tech_id)
        );
        CREATE TABLE IF NOT EXISTS game_clan_tech_history (
          clan_id INTEGER NOT NULL REFERENCES clans(id),
          tech_id INTEGER NOT NULL,
          level INTEGER NOT NULL,
          changed_at TEXT NOT NULL,
          PRIMARY KEY (clan_id, tech_id, changed_at)
        );
        CREATE TABLE IF NOT EXISTS game_clan_treasury (
          clan_id INTEGER NOT NULL REFERENCES clans(id),
          game_date TEXT NOT NULL,
          resource_id INTEGER NOT NULL,
          amount INTEGER NOT NULL,
          captured_at TEXT NOT NULL,
          PRIMARY KEY (clan_id, game_date, resource_id)
        );
        CREATE TABLE IF NOT EXISTS game_clan_medals (
          clan_id INTEGER NOT NULL REFERENCES clans(id),
          medal_id INTEGER NOT NULL,
          earned_at TEXT,
          first_seen TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          PRIMARY KEY (clan_id, medal_id)
        );
      `);
    },
  },
  {
    // v112 — shield and burning (walls down) per member city, from the map
    // tiles (312) the scan already reads: tile [4] lists each tile's cities,
    // field 39 = shield bubble, field 25 = burning. game_players holds the
    // current state, game_city_status_history a row whenever it changes (so
    // "shield dropped at", "burning since" are answerable).
    version: 112,
    run: (database): void => {
      const cols = database.prepare('PRAGMA table_info(game_players)').all() as { name: string }[];
      if (!cols.some((c) => c.name === 'shielded')) database.exec('ALTER TABLE game_players ADD COLUMN shielded INTEGER');
      if (!cols.some((c) => c.name === 'burning')) database.exec('ALTER TABLE game_players ADD COLUMN burning INTEGER');
      if (!cols.some((c) => c.name === 'map_seen_at')) database.exec('ALTER TABLE game_players ADD COLUMN map_seen_at TEXT');
      database.exec(`
        CREATE TABLE IF NOT EXISTS game_city_status_history (
          clan_id INTEGER NOT NULL REFERENCES clans(id),
          player_id INTEGER NOT NULL,
          changed_at TEXT NOT NULL,
          shielded INTEGER NOT NULL,
          burning INTEGER NOT NULL,
          PRIMARY KEY (clan_id, player_id, changed_at)
        );
      `);
    },
  },
  {
    // v113 — the clan chat as a permanent, searchable history (Chats page).
    //   - chat_messages gets a stable INTEGER PRIMARY KEY (rebuilt once, in a
    //     transaction): the full-text index refers to rows by it, and an
    //     implicit rowid may change on VACUUM. The old key stays UNIQUE.
    //   - sender_player_id (from sender_info's hex), search_text (the text with
    //     its placeholders' names and coordinates), updated_at +
    //     previous_message (an edit keeps the text it replaced), translations.
    //   - chat_channels.history_complete: the backfill reached the start.
    //   - chat_messages_fts (FTS5, external content, kept by triggers).
    // Replay-safe: every step is guarded or idempotent.
    version: 113,
    run: (database): void => {
      const cols = (table: string): string[] =>
        (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      if (!cols('chat_messages').includes('id')) {
        database.transaction(() => {
          database.exec(`
            CREATE TABLE chat_messages_v113 (
              id INTEGER PRIMARY KEY,
              clan_id INTEGER NOT NULL REFERENCES clans(id),
              channel_url TEXT NOT NULL,
              message_id INTEGER NOT NULL,
              created_at INTEGER NOT NULL,
              custom_type TEXT NOT NULL DEFAULT '',
              sender_id TEXT NOT NULL DEFAULT '',
              sender_name TEXT NOT NULL DEFAULT '',
              sender_info TEXT NOT NULL DEFAULT '',
              message TEXT NOT NULL DEFAULT '',
              data TEXT NOT NULL DEFAULT '',
              captured_at TEXT NOT NULL,
              sender_player_id INTEGER,
              search_text TEXT NOT NULL DEFAULT '',
              updated_at INTEGER NOT NULL DEFAULT 0,
              previous_message TEXT,
              translations TEXT NOT NULL DEFAULT '',
              UNIQUE (clan_id, channel_url, message_id)
            );
            INSERT INTO chat_messages_v113
              (clan_id, channel_url, message_id, created_at, custom_type, sender_id, sender_name, sender_info, message, data, captured_at)
              SELECT clan_id, channel_url, message_id, created_at, custom_type, sender_id, sender_name, sender_info, message, data, captured_at
                FROM chat_messages ORDER BY clan_id, channel_url, created_at, message_id;
            DROP TABLE chat_messages;
            ALTER TABLE chat_messages_v113 RENAME TO chat_messages;
          `);
        })();
      }
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_chat_messages_time ON chat_messages (clan_id, channel_url, created_at);
        CREATE INDEX IF NOT EXISTS idx_chat_messages_sender ON chat_messages (clan_id, sender_player_id, created_at);
      `);
      if (!cols('chat_channels').includes('history_complete')) {
        database.exec('ALTER TABLE chat_channels ADD COLUMN history_complete INTEGER NOT NULL DEFAULT 0');
      }
      // Derived columns for the rows stored before v113.
      const todo = database.prepare(
        "SELECT id, message, data, sender_info FROM chat_messages WHERE search_text = '' OR sender_player_id IS NULL",
      ).all() as Array<{ id: number; message: string; data: string; sender_info: string }>;
      const fill = database.prepare('UPDATE chat_messages SET search_text = ?, sender_player_id = ? WHERE id = ?');
      database.transaction(() => {
        for (const r of todo) fill.run(chatSearchText(r.message, r.data), chatSenderPlayerId(r.sender_info), r.id);
      })();
      database.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
          search_text, sender_name,
          content='chat_messages', content_rowid='id',
          tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER IF NOT EXISTS chat_messages_fts_ai AFTER INSERT ON chat_messages BEGIN
          INSERT INTO chat_messages_fts (rowid, search_text, sender_name) VALUES (new.id, new.search_text, new.sender_name);
        END;
        CREATE TRIGGER IF NOT EXISTS chat_messages_fts_ad AFTER DELETE ON chat_messages BEGIN
          INSERT INTO chat_messages_fts (chat_messages_fts, rowid, search_text, sender_name)
            VALUES ('delete', old.id, old.search_text, old.sender_name);
        END;
        CREATE TRIGGER IF NOT EXISTS chat_messages_fts_au AFTER UPDATE OF search_text, sender_name ON chat_messages BEGIN
          INSERT INTO chat_messages_fts (chat_messages_fts, rowid, search_text, sender_name)
            VALUES ('delete', old.id, old.search_text, old.sender_name);
          INSERT INTO chat_messages_fts (rowid, search_text, sender_name) VALUES (new.id, new.search_text, new.sender_name);
        END;
        INSERT INTO chat_messages_fts (chat_messages_fts) VALUES ('rebuild');
      `);
    },
  },
  {
    // v114 — the player's cosmetics from their 402 record: avatar_frame (field 6) is
    // the frame the game draws their hero portrait in, city_appearance
    // (field 5) their city's look — both ids of the customizations table
    // (static T52: type 1 frames, 1 = "Standard"; type 2 city looks, 9 =
    // "Player's City"). Guarded: runMigrations may replay this.
    version: 114,
    run: (database): void => {
      const cols = database.prepare('PRAGMA table_info(game_players)').all() as { name: string }[];
      if (!cols.some((c) => c.name === 'avatar_frame')) database.exec('ALTER TABLE game_players ADD COLUMN avatar_frame INTEGER');
      if (!cols.some((c) => c.name === 'city_appearance')) database.exec('ALTER TABLE game_players ADD COLUMN city_appearance INTEGER');
    },
  },
];

/**
 * Make sure clan #1 exists. The pre-consolidation v16 migration inserted
 * this row as part of the multi-clan rollout; the v30 consolidation
 * collapsed the schema-only DDL into a single bootstrap but the seed
 * INSERT was lost. Production survived because every existing instance
 * already had the row, but a fresh install (or any test that calls
 * initDatabase against a clean file) would hit FK errors the moment
 * something inserted a row referencing clans(id). Runs every boot;
 * INSERT OR IGNORE makes it a no-op on existing databases.
 */
function ensureSeedClan(database: Database.Database): void {
  database.prepare(
    `INSERT OR IGNORE INTO clans (id, name, slug, game_url, is_active, created_at)
     VALUES (1, ?, ?, ?, 1, ?)`,
  ).run(
    'Clan #1',
    'clan-1',
    'https://totalbattle.com',
    new Date().toISOString(),
  );
}

function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const currentVersion = database.prepare(
    'SELECT MAX(version) as v FROM schema_version',
  ).get() as { v: number | null } | undefined;

  const version = currentVersion?.v ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version > version) {
      log.info(`Running migration v${migration.version}`);
      if (migration.sql) {
        database.exec(migration.sql);
      }
      if (migration.run) {
        migration.run(database);
      }
      database.prepare(
        'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)',
      ).run(migration.version, new Date().toISOString());
    }
  }
}


/**
 * Reconcile chest names in the `chests` reference table against the
 * canonical list in chest-names.ts. Idempotent — does nothing on a
 * healthy DB. Picks up new entries to KNOWN_CHESTS / correctChestName
 * fixes the next time the server boots, by renaming the affected
 * `chests` row in place (or merging into an existing canonical row
 * if both happened to coexist).
 *
 * Not a schema migration; runs every startup as a small reconciliation
 * pass. Cheap (one row per distinct chest name).
 */
function cleanupChestNames(database: Database.Database): void {
  const rows = database.prepare(
    'SELECT id, name FROM chests',
  ).all() as { id: number; name: string }[];

  let fixed = 0;
  for (const row of rows) {
    const corrected = correctChestName(row.name);
    if (corrected === row.name) continue;

    const rarity = getChestRarity(corrected);

    const existing = database.prepare(
      'SELECT id FROM chests WHERE name = ? AND id != ?',
    ).get(corrected, row.id) as { id: number } | undefined;

    if (existing) {
      // OR IGNORE, then drop whatever could not move. chest_records has
      // UNIQUE(session_id, member_id, chest_id, captured_at), and one scan really
      // can hold several chests for one member at one instant — 180 such groups in
      // production — so if the surviving chest is already there for that moment,
      // the plain UPDATE throws SQLITE_CONSTRAINT. This runs inside initDatabase,
      // so that is not a failed rename, it is an app that cannot boot. A row that
      // collides is the same physical chest read under two spellings, so dropping
      // it is the correct outcome rather than a loss — migration v61 does exactly
      // this for the same merge and this path never learned it.
      let moved = 0;
      let dropped = 0;
      for (const table of ['chest_records', 'triumphal_chest_records']) {
        moved += database.prepare(
          `UPDATE OR IGNORE ${table} SET chest_id = ? WHERE chest_id = ?`,
        ).run(existing.id, row.id).changes;
        dropped += database.prepare(
          `DELETE FROM ${table} WHERE chest_id = ?`,
        ).run(row.id).changes;
      }
      if (dropped > 0) {
        log.info(
          `Chest merge "${row.name}" → "${corrected}": ${moved} record(s) repointed, `
          + `${dropped} exact duplicate(s) removed.`,
        );
      }
      database.prepare('UPDATE chests SET chest_type = ? WHERE id = ?').run(rarity, existing.id);
      database.prepare('DELETE FROM chests WHERE id = ?').run(row.id);
    } else {
      database.prepare(
        'UPDATE chests SET name = ?, chest_type = ? WHERE id = ?',
      ).run(corrected, rarity, row.id);
    }

    // Two tables keep the chest NAME as text rather than an id, so a rename here detaches
    // whatever an admin configured against the old spelling: the override survives but points
    // at a name no chest has, and shows up as a row with 0 chests. This is not hypothetical —
    // it is the same failure the accent fold produced on the source-key side, and this helper
    // has always renamed without carrying them.
    //
    // OR IGNORE first because each has a UNIQUE key on the name and a value may already exist
    // under the corrected spelling; that one is the admin's own and wins. Whatever cannot move
    // is then removed rather than left stranded.
    for (const table of ['source_point_overrides', 'triumphal_chest_points']) {
      database.prepare(
        `UPDATE OR IGNORE ${table} SET chest_name = ? WHERE chest_name = ?`,
      ).run(corrected, row.name);
      database.prepare(`DELETE FROM ${table} WHERE chest_name = ?`).run(row.name);
    }

    // merge_rules is the third name-keyed table and the one nothing has ever
    // carried. Only `to_value` moves: a chest rule is variant → canonical, so
    // `from_value` IS the bad spelling and must keep pointing at it — that is the
    // whole job of the rule. Repointing from_value too would collapse the rule
    // onto itself, the self-loop cleanup would delete it, and the next scan would
    // re-mint the `chests` row this rename just removed.
    database.prepare(
      "UPDATE merge_rules SET to_value = ? WHERE type = 'chest' AND to_value = ?",
    ).run(corrected, row.name);
    database.prepare(
      "DELETE FROM merge_rules WHERE type = 'chest' AND from_value = to_value",
    ).run();

    fixed++;
    log.info(`Fixed chest name: "${row.name}" → "${corrected}" (${rarity})`);
  }

  if (fixed > 0) {
    log.info(`Cleaned up ${fixed} chest name variations`);
  }
}

/**
 * Give every chest the type KNOWN_CHESTS declares for it. getOrCreateChestId
 * sets a type on first sight only, so without this a type changed in the
 * catalog never reached a chest already stored. Names the catalog doesn't
 * declare keep the type they were first stored with.
 */
function syncChestTypes(database: Database.Database): void {
  const rows = database.prepare('SELECT id, name, chest_type FROM chests').all() as
    { id: number; name: string; chest_type: string }[];
  const update = database.prepare('UPDATE chests SET chest_type = ? WHERE id = ?');
  for (const row of rows) {
    const declared = isHardcodedChestName(row.name) ? KNOWN_CHESTS[row.name] : undefined;
    if (declared && declared !== row.chest_type) update.run(declared, row.id);
  }
}

/**
 * Bring every `chest_sources.rarity` in line with getSourceRarity. The two
 * single-row inserts set it themselves; this covers the rows that existed
 * before v83, the bulk copy in clan-restore, and any later change to the rule.
 * One row per distinct source string, so cheap enough to run every boot.
 */
export function syncSourceRarities(database: Database.Database): void {
  const rows = database.prepare('SELECT id, source, rarity FROM chest_sources').all() as
    { id: number; source: string; rarity: string | null }[];
  const update = database.prepare('UPDATE chest_sources SET rarity = ? WHERE id = ?');
  for (const row of rows) {
    const rarity = getSourceRarity(row.source);
    if (rarity !== row.rarity) update.run(rarity, row.id);
  }
}

export function initDatabase(dbPath: string): Database.Database {
  if (db) return db;

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // A second connection (the daily backup's WAL checkpoint, an external
  // sqlite tool) can briefly hold the write lock. Without a busy_timeout the
  // app connection throws SQLITE_BUSY immediately instead of waiting; give it
  // up to 5s to acquire the lock before erroring.
  db.pragma('busy_timeout = 5000');

  runMigrations(db);
  ensureSeedClan(db);
  cleanupChestNames(db);
  syncChestTypes(db);
  syncSourceRarities(db);
  // Right after the rename pass, so anything it just stranded is reported in the
  // same breath. Read-only and never throws — see config-integrity.ts.
  reportConfigIntegrity(db);

  // Self-heal stale "Manual review needed" banners on any scan session
  // whose unknown-name rows were reassigned. Cheap one-shot per startup
  // and idempotent — touches zero rows once the operator has cleaned up.
  db.exec(`
    UPDATE scan_sessions
       SET error_message = NULL, error_phase = NULL
     WHERE error_phase = 'Manual review needed'
       AND id NOT IN (
         SELECT DISTINCT cr.session_id
         FROM chest_records cr
         JOIN members m ON m.id = cr.member_id
         WHERE m.name = '[Unknown]'
            OR m.name = ''
            OR TRIM(m.name) = ''
            OR LOWER(TRIM(m.name)) = 'inactive player'
       )
  `);

  log.debug(`Database initialized at ${dbPath}`);
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    log.info('Database closed');
  }
}
