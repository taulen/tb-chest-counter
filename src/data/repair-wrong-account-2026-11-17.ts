/**
 * One-time repair (Nov 17 2026), run at startup: TO BE REMOVED once it has run
 * on prod. A no-op anywhere else, and once done (marker in game_parse_markers).
 *
 * Two scans of clan #5 (SK7 - SIN CITY), 15:18 and 15:27 UTC, signed in as
 * SIK's scanner account (tb:74858156, player 1241245577338) and read the SIK
 * clan (game clan 4522600562715) as if it were SK7, until SK7's login was saved
 * again at 15:31:33. They wrote into clan 5: 93 members (and renamed SK7's
 * "Ace K260 SK" to SIK's "Ace"), 99 players with their research, captains,
 * gear and artifacts, the SIK account's 306 chat channels / 63k messages, SIK's
 * event standings, clan research / stats / rankings / medals / treasury, 1,265
 * ledger rows (all also in clan 3) and 2 resource rows, raw replies, and "left
 * the clan" audit rows for SK7's 90 members (they were relinked at 15:31).
 * No chests, claims or gifts were written (scan sessions 8512 / 8515: 0).
 *
 * Everything below is keyed to clan 5 and that window, and to the players
 * first seen in clan 5 inside it — SK7's own players were never read there.
 */
import type Database from 'better-sqlite3';
import { despace } from '../utils/name-normalize.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('repair-wrong-account');

const CLAN = 5;
const SIK_GAME_CLAN = 4522600562715;
/** From the first wrong scan's trigger to the moment SK7's login was saved again. */
const FROM = '2026-11-17T15:18:19';
const TO = '2026-11-17T15:31:33';
/** The first good scan after it: research rows that only put SK7's levels back. */
const REVERTS_UNTIL = '2026-11-17T15:40';
const MARKER = 'repair-wrong-account-2026-11-17';
/** SK7's member the wrong read linked to SIK's "Ace" and renamed; as it was. */
const ACE = { id: 1645, wrongName: 'Ace', wrongPlayer: 1301375182471, name: 'Ace K260 SK', aliases: ['Ace'], lastSeen: '2026-11-13T23:10:39.411Z' };

/** Per-player game tables: every row of a wrongly read player in clan 5 goes. */
const PLAYER_TABLES = [
  'game_player_history', 'game_player_daily', 'game_player_techs', 'game_player_tech_history',
  'game_player_captains', 'game_player_captain_history', 'game_player_captain_equipment', 'game_player_equipment_history',
  'game_player_artifacts', 'game_player_artifact_history', 'game_city_snapshots', 'game_city_status_history',
  'game_event_standings', 'game_event_standing_history', 'game_players',
] as const;

/** Clan-scoped tables whose rows from the window are all SIK's: [table, time column]. */
const WINDOW_TABLES: ReadonlyArray<[string, string]> = [
  ['game_event_reads', 'read_at'],
  ['game_clan_stats', 'captured_at'],
  ['game_clan_rankings', 'captured_at'],
  ['game_clan_ranking_lists', 'captured_at'],
  ['game_clan_medals', 'first_seen'],
  ['game_clan_treasury', 'captured_at'],
  ['game_clan_tech_history', 'changed_at'],
  ['game_clan_techs', 'first_seen'],
  ['game_ledger', 'captured_at'],
  ['game_raw_snapshots', 'captured_at'],
  ['game_map_objects', 'first_seen'],
  ['resource_transactions', 'created_at'],
  ['member_snapshots', 'captured_at'],
  ['chat_post_channels', 'seen_at'],
];

const tableExists = (db: Database.Database, name: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/** Returns what was removed, or null when there is nothing to repair here. */
export function repairWrongAccountScan(db: Database.Database): Record<string, number> | null {
  if (!tableExists(db, 'game_parse_markers') || !tableExists(db, 'game_capture_runs')) return null;
  if (db.prepare('SELECT 1 FROM game_parse_markers WHERE clan_id = ? AND parser = ?').get(CLAN, MARKER)) return null;
  // Only on the database it happened to: a capture run of clan 5 that read SIK's game clan in the window.
  const evidence = db.prepare(
    'SELECT COUNT(*) AS n FROM game_capture_runs WHERE clan_id = ? AND game_clan_id = ? AND started_at >= ? AND started_at < ?',
  ).get(CLAN, SIK_GAME_CLAN, FROM, TO) as { n: number };
  if (!evidence.n) return null;

  const removed: Record<string, number> = {};
  const run = (label: string, sql: string, ...params: unknown[]): void => {
    removed[label] = (removed[label] ?? 0) + db.prepare(sql).run(...params).changes;
  };

  db.transaction(() => {
    // The players read from SIK: first seen in clan 5 inside the window.
    db.exec('CREATE TEMP TABLE IF NOT EXISTS repair_wrong_players (player_id INTEGER PRIMARY KEY)');
    db.exec('DELETE FROM temp.repair_wrong_players');
    db.prepare(
      `INSERT INTO temp.repair_wrong_players (player_id)
       SELECT player_id FROM game_players WHERE clan_id = ? AND first_seen >= ? AND first_seen < ?`,
    ).run(CLAN, FROM, TO);
    removed.players_found = (db.prepare('SELECT COUNT(*) AS n FROM temp.repair_wrong_players').get() as { n: number }).n;
    for (const t of PLAYER_TABLES) {
      run(t, `DELETE FROM ${t} WHERE clan_id = ? AND player_id IN (SELECT player_id FROM temp.repair_wrong_players)`, CLAN);
    }

    // Events: SIK's runs, only read in the window.
    run('game_event_runs', 'DELETE FROM game_event_runs WHERE clan_id = ? AND first_seen >= ? AND first_seen < ? AND last_read < ?', CLAN, FROM, TO, TO);

    for (const [t, col] of WINDOW_TABLES) {
      if (!tableExists(db, t)) continue;
      run(t, `DELETE FROM ${t} WHERE clan_id = ? AND ${col} >= ? AND ${col} < ?`, CLAN, FROM, TO);
    }
    // The good scan then wrote SK7's research back as "changes": drop each row
    // that only restores the level from before the window.
    run('game_clan_tech_history (reverts)', `
      DELETE FROM game_clan_tech_history WHERE rowid IN (
        SELECT h.rowid FROM game_clan_tech_history h
         WHERE h.clan_id = ? AND h.changed_at >= ? AND h.changed_at < ?
           AND h.level = (SELECT p.level FROM game_clan_tech_history p
                           WHERE p.clan_id = h.clan_id AND p.tech_id = h.tech_id AND p.changed_at < ?
                           ORDER BY p.changed_at DESC LIMIT 1))`, CLAN, TO, REVERTS_UNTIL, FROM);

    // The SIK account's chats.
    run('chat_messages', `
      DELETE FROM chat_messages WHERE clan_id = ? AND channel_url IN (
        SELECT channel_url FROM chat_channels WHERE clan_id = ? AND first_seen >= ? AND first_seen < ?)`, CLAN, CLAN, FROM, TO);
    run('chat_channels', 'DELETE FROM chat_channels WHERE clan_id = ? AND first_seen >= ? AND first_seen < ?', CLAN, FROM, TO);

    // Members created from SIK's roster (never one with chests: none have any).
    const junk = (db.prepare(
      `SELECT id FROM members WHERE clan_id = ? AND first_seen >= ? AND first_seen < ?
          AND id NOT IN (SELECT member_id FROM chest_records WHERE member_id IS NOT NULL)
          AND id NOT IN (SELECT member_id FROM triumphal_chest_records WHERE member_id IS NOT NULL)`,
    ).all(CLAN, FROM, TO) as Array<{ id: number }>).map((r) => r.id);
    if (junk.length) {
      const list = junk.join(',');
      // Every table that references members: clear or detach the rows first.
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
      for (const t of tables) {
        for (const fk of db.prepare(`PRAGMA foreign_key_list(${t})`).all() as Array<{ table: string; from: string; on_delete: string }>) {
          if (fk.table !== 'members' || t === 'members') continue;
          if (fk.on_delete === 'SET NULL') run(`${t}.${fk.from} (detached)`, `UPDATE ${t} SET ${fk.from} = NULL WHERE ${fk.from} IN (${list})`);
          else run(`${t}.${fk.from}`, `DELETE FROM ${t} WHERE ${fk.from} IN (${list})`);
        }
      }
      run('members', `DELETE FROM members WHERE id IN (${list})`);
      run('audit_log (their departures)', `
        DELETE FROM audit_log WHERE clan_id = ? AND action = 'member.left_clan'
           AND created_at >= ? AND created_at < ? AND json_extract(details, '$.id') IN (${list})`, CLAN, TO, REVERTS_UNTIL);
    }

    // SK7's Ace, as it was.
    const ace = db.prepare('UPDATE members SET name = ?, normalized_name = ?, despaced_name = ?, aliases = ?, game_player_id = NULL, is_active = 0, left_at = ?, last_seen = ? WHERE id = ? AND clan_id = ? AND name = ? AND game_player_id = ?')
      .run(ACE.name, ACE.name.toLowerCase(), despace(ACE.name), JSON.stringify(ACE.aliases), ACE.lastSeen, ACE.lastSeen, ACE.id, CLAN, ACE.wrongName, ACE.wrongPlayer);
    removed['Ace restored'] = ace.changes;
    if (ace.changes) {
      run('audit_log (Ace rename + departure)', `
        DELETE FROM audit_log WHERE clan_id = ? AND created_at >= ? AND created_at < ?
           AND action IN ('rename_member', 'member.left_clan') AND json_extract(details, '$.id') = ?`, CLAN, FROM, REVERTS_UNTIL, ACE.id);
    }

    // SK7's members never left: the wrong roster made them look gone for 13 minutes.
    run('audit_log (false SK7 departures)', `
      DELETE FROM audit_log WHERE clan_id = ? AND action = 'member.left_clan' AND created_at >= ? AND created_at < ?`, CLAN, FROM, TO);

    db.prepare(
      `INSERT INTO game_parse_markers (clan_id, parser, version, done_at) VALUES (?, ?, 1, ?)
       ON CONFLICT (clan_id, parser) DO UPDATE SET version = excluded.version, done_at = excluded.done_at`,
    ).run(CLAN, MARKER, new Date().toISOString());
  })();

  const total = Object.entries(removed).filter(([k]) => k !== 'players_found' && k !== 'Ace restored').reduce((s, [, n]) => s + n, 0);
  log.warn({ noAlert: true }, `Clan #5 wrong-account repair: removed ${total} rows written by the 15:18/15:27 scans that signed in as SIK — ${JSON.stringify(removed)}`);
  return removed;
}
