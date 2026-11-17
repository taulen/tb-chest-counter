/**
 * The one-time repair of clan #5's wrong-account scans (Nov 17 2026): only
 * clan 5's rows from the window, only the wrongly read players, SK7's own data
 * untouched; Ace restored; a no-op without the evidence and after it ran.
 * Removed together with src/data/repair-wrong-account-2026-11-17.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { repairWrongAccountScan } from '../../src/data/repair-wrong-account-2026-11-17.js';
import { makeTestDb } from '../helpers/test-db.js';

let cleanup: () => void;
beforeEach(() => { ({ cleanup } = makeTestDb()); });
afterEach(() => cleanup());

const IN = '2026-11-17T15:18:32.355Z';
const IN2 = '2026-11-17T15:27:39.110Z';
const BEFORE = '2026-11-17T14:37:51.623Z';
const AFTER = '2026-11-17T15:31:49.684Z';
const SK7_PLAYER = 4599909976661;
const SIK_PLAYER = 1301375182471;

function seed(withEvidence = true): void {
  const db = getDb();
  for (const [id, name] of [[3, 'SIK'], [5, 'SK7']] as const) {
    db.prepare(`INSERT OR IGNORE INTO clans (id, name, slug, game_url, is_active, created_at) VALUES (?, ?, ?, 'https://totalbattle.com', 1, ?)`)
      .run(id, name, name.toLowerCase(), BEFORE);
  }
  if (withEvidence) {
    db.prepare('INSERT INTO game_capture_runs (clan_id, started_at, game_clan_id, ok) VALUES (5, ?, 4522600562715, 1)').run(IN);
  }
  db.prepare('INSERT INTO game_capture_runs (clan_id, started_at, game_clan_id, ok) VALUES (5, ?, 4599909974038, 1)').run(AFTER);

  const player = db.prepare(`INSERT INTO game_players (clan_id, player_id, name, role, in_clan, first_seen, last_seen) VALUES (5, ?, ?, 5, ?, ?, ?)`);
  player.run(SK7_PLAYER, 'taulen', 1, '2026-11-17T01:26:36.989Z', AFTER);
  player.run(SIK_PLAYER, 'Ace', 0, IN, IN2);
  const techs = db.prepare('INSERT INTO game_player_techs (clan_id, player_id, tech_id, level, first_seen, last_seen) VALUES (5, ?, 1, 3, ?, ?)');
  techs.run(SK7_PLAYER, BEFORE, AFTER);
  techs.run(SIK_PLAYER, IN, IN);

  // Members: SK7's own, one created from SIK's roster (with a snapshot), and Ace.
  const member = db.prepare(`INSERT INTO members (id, clan_id, name, normalized_name, despaced_name, aliases, first_seen, last_seen, is_active, left_at, game_player_id)
    VALUES (?, 5, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  member.run(1600, 'taulen', 'taulen', 'taulen', '[]', '2026-11-10T00:00:00Z', AFTER, 1, null, SK7_PLAYER);
  member.run(1751, 'Dairamar', 'dairamar', 'dairamar', '[]', IN, IN2, 0, AFTER, 1241245577000);
  member.run(1645, 'Ace', 'ace', 'ace', '["Ace","Ace K260 SK"]', '2026-11-13T11:20:13.633Z', IN2, 0, AFTER, SIK_PLAYER);
  db.prepare('INSERT INTO member_snapshots (member_id, level, power, captured_at, clan_id) VALUES (1751, 0, 100, ?, 5)').run(IN);
  db.prepare('INSERT INTO member_snapshots (member_id, level, power, captured_at, clan_id) VALUES (1600, 0, 100, ?, 5)').run(BEFORE);

  const audit = db.prepare('INSERT INTO audit_log (user_id, clan_id, action, details, created_at) VALUES (NULL, ?, ?, ?, ?)');
  audit.run(5, 'member.left_clan', JSON.stringify({ id: 1600, name: 'taulen', source: 'game' }), IN);
  audit.run(5, 'rename_member', JSON.stringify({ id: 1645, from: 'Ace K260 SK', newName: 'Ace', source: 'game' }), IN);
  audit.run(5, 'member.left_clan', JSON.stringify({ id: 1751, name: 'Dairamar', source: 'game' }), AFTER);
  audit.run(5, 'member.left_clan', JSON.stringify({ id: 1645, name: 'Ace', source: 'game' }), AFTER);
  audit.run(5, 'member.left_clan', JSON.stringify({ id: 1600, name: 'taulen', source: 'game' }), '2026-11-16T10:00:00Z');
  audit.run(3, 'member.left_clan', JSON.stringify({ id: 9, name: 'x', source: 'game' }), IN);

  // Clan research: SK7 at level 2, the wrong read wrote SIK's 5, the good scan put 2 back; a real move to 4 later.
  const hist = db.prepare('INSERT INTO game_clan_tech_history (clan_id, tech_id, level, changed_at) VALUES (5, ?, ?, ?)');
  hist.run(10, 2, '2026-11-17T02:00:00Z');
  hist.run(10, 5, IN);
  hist.run(10, 2, AFTER);
  hist.run(11, 1, '2026-11-17T02:00:00Z');
  hist.run(11, 4, AFTER);

  // Chats: a channel only the SIK account had, and SK7's own.
  const ch = db.prepare(`INSERT INTO chat_channels (clan_id, channel_url, custom_type, name, member_count, members, last_message_at, first_seen, last_seen) VALUES (5, ?, 'clan', ?, 1, '[]', 0, ?, ?)`);
  ch.run('sik-clan', 'SIK', IN, IN2);
  ch.run('sk7-clan', 'SK7', BEFORE, AFTER);
  const msg = db.prepare(`INSERT INTO chat_messages (clan_id, channel_url, message_id, created_at, custom_type, sender_id, sender_name, sender_info, message, data, captured_at, sender_player_id, search_text, updated_at, translations)
    VALUES (5, ?, ?, 0, '', 's', 'n', '', 'hello', '', ?, NULL, 'hello', 0, '')`);
  msg.run('sik-clan', 1, IN);
  msg.run('sk7-clan', 2, BEFORE);

  db.prepare(`INSERT INTO game_ledger (clan_id, entry_id, player_id, kind, resource, amounts, occurred_at, captured_at) VALUES (5, 1, ?, 1, 1, '[]', 0, ?)`).run(SIK_PLAYER, IN);
  db.prepare(`INSERT INTO game_ledger (clan_id, entry_id, player_id, kind, resource, amounts, occurred_at, captured_at) VALUES (5, 2, ?, 1, 1, '[]', 0, ?)`).run(SK7_PLAYER, AFTER);
}

const count = (sql: string, ...p: unknown[]): number => (getDb().prepare(sql).get(...p) as { n: number }).n;

describe('wrong-account repair (clan 5, Nov 17 2026)', () => {
  it('removes what the wrong scans wrote and nothing of SK7 or SIK', () => {
    seed();
    expect(repairWrongAccountScan(getDb())).not.toBeNull();

    expect(count('SELECT COUNT(*) n FROM game_players WHERE clan_id = 5')).toBe(1);
    expect(count('SELECT COUNT(*) n FROM game_player_techs WHERE clan_id = 5 AND player_id = ?', SK7_PLAYER)).toBe(1);
    expect(count('SELECT COUNT(*) n FROM game_player_techs WHERE player_id = ?', SIK_PLAYER)).toBe(0);

    expect(count('SELECT COUNT(*) n FROM members WHERE id = 1751')).toBe(0);
    expect(count('SELECT COUNT(*) n FROM member_snapshots WHERE member_id = 1751')).toBe(0);
    expect(count('SELECT COUNT(*) n FROM member_snapshots WHERE member_id = 1600')).toBe(1);
    expect(getDb().prepare('SELECT name, normalized_name, despaced_name, aliases, game_player_id, is_active, left_at FROM members WHERE id = 1645').get()).toEqual({
      name: 'Ace K260 SK', normalized_name: 'ace k260 sk', despaced_name: 'acek260sk', aliases: '["Ace"]',
      game_player_id: null, is_active: 0, left_at: '2026-11-13T23:10:39.411Z',
    });

    // Audit: the false departures, the rename and the junk departures go; older and other clans' stay.
    expect(count("SELECT COUNT(*) n FROM audit_log WHERE clan_id = 5")).toBe(1);
    expect(count("SELECT COUNT(*) n FROM audit_log WHERE clan_id = 3")).toBe(1);

    // Research: the wrong level and its revert go, the real move stays.
    expect(getDb().prepare('SELECT tech_id, level, changed_at FROM game_clan_tech_history WHERE clan_id = 5 ORDER BY tech_id, changed_at').all()).toEqual([
      { tech_id: 10, level: 2, changed_at: '2026-11-17T02:00:00Z' },
      { tech_id: 11, level: 1, changed_at: '2026-11-17T02:00:00Z' },
      { tech_id: 11, level: 4, changed_at: AFTER },
    ]);

    expect(count("SELECT COUNT(*) n FROM chat_channels WHERE clan_id = 5")).toBe(1);
    expect(count("SELECT COUNT(*) n FROM chat_messages WHERE clan_id = 5 AND channel_url = 'sk7-clan'")).toBe(1);
    expect(count("SELECT COUNT(*) n FROM chat_messages WHERE channel_url = 'sik-clan'")).toBe(0);
    expect(count('SELECT COUNT(*) n FROM game_ledger WHERE clan_id = 5')).toBe(1);

    // Once only.
    expect(repairWrongAccountScan(getDb())).toBeNull();
  });

  it('does nothing on a database without the wrong scan', () => {
    seed(false);
    expect(repairWrongAccountScan(getDb())).toBeNull();
    expect(count('SELECT COUNT(*) n FROM game_players WHERE clan_id = 5')).toBe(2);
    expect(count('SELECT COUNT(*) n FROM members WHERE clan_id = 5')).toBe(3);
  });
});
