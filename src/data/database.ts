import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { childLogger } from '../utils/logger.js';
import { correctChestName, getChestRarity, TRIUMPHAL_PACKAGE_POINTS } from '../vision/chest-names.js';
import { getSourceKey, sourceSpellingKey } from '../vision/source-names.js';
import { despace } from '../vision/ocr-normalize.js';
import { reportConfigIntegrity } from './config-integrity.js';

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

    // Three tables keep the chest NAME as text rather than an id, so a rename here detaches
    // whatever an admin configured against the old spelling: the override survives but points
    // at a name no chest has, and shows up as a row with 0 chests. This is not hypothetical —
    // it is the same failure the accent fold produced on the source-key side, and this helper
    // has always renamed without carrying them.
    //
    // OR IGNORE first because each has a UNIQUE key on the name and a value may already exist
    // under the corrected spelling; that one is the admin's own and wins. Whatever cannot move
    // is then removed rather than left stranded.
    for (const table of ['source_point_overrides', 'chest_type_overrides', 'triumphal_chest_points']) {
      database.prepare(
        `UPDATE OR IGNORE ${table} SET chest_name = ? WHERE chest_name = ?`,
      ).run(corrected, row.name);
      database.prepare(`DELETE FROM ${table} WHERE chest_name = ?`).run(row.name);
    }

    // merge_rules is the fourth name-keyed table and the one nothing has ever
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
