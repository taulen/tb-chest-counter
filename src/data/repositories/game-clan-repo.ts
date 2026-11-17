/**
 * The clan's own game data (v111): what the in-game clan window shows — the
 * Information tab (tag, name, members, might, founded, medals), wealth and
 * help points, the Clan Capital's research and treasury — written by the scan
 * (game-protocol-phase.ts) and read by the Clan page (/api/game/clan).
 *
 * History: game_clan_stats keeps a row per scan; research keeps a history row
 * only when a level moves (the first read is the baseline, not a change); the
 * treasury keeps the day's latest read per resource.
 */
import { gunzipSync } from 'zlib';
import { getDb } from '../database.js';

export interface ClanInfoInput {
  gameClanId: number;
  tag: string;
  name: string;
  /** Unix s. */
  foundedAt: number | null;
  language: string;
  capitalId: number | null;
  position: [number, number, number] | null;
  /** Logo code (clan record f1[2]); null keeps the stored one. */
  logo?: number | null;
}

export function saveClanInfo(clanId: number, info: ClanInfoInput, now = new Date().toISOString()): void {
  getDb().prepare(`
    INSERT INTO game_clan_info (clan_id, game_clan_id, tag, name, founded_at, language, capital_id, realm, capital_x, capital_y, logo, updated_at)
    VALUES (@clanId, @gameClanId, @tag, @name, @foundedAt, @language, @capitalId, @realm, @x, @y, @logo, @now)
    ON CONFLICT (clan_id) DO UPDATE SET
      game_clan_id = excluded.game_clan_id, tag = excluded.tag, name = excluded.name,
      founded_at = COALESCE(excluded.founded_at, game_clan_info.founded_at),
      language = excluded.language,
      logo = COALESCE(excluded.logo, game_clan_info.logo),
      capital_id = COALESCE(excluded.capital_id, game_clan_info.capital_id),
      realm = COALESCE(excluded.realm, game_clan_info.realm),
      capital_x = COALESCE(excluded.capital_x, game_clan_info.capital_x),
      capital_y = COALESCE(excluded.capital_y, game_clan_info.capital_y),
      updated_at = excluded.updated_at
  `).run({
    clanId,
    gameClanId: info.gameClanId,
    tag: info.tag,
    name: info.name,
    foundedAt: info.foundedAt ? new Date(info.foundedAt * 1000).toISOString() : null,
    language: info.language || null,
    logo: info.logo ?? null,
    capitalId: info.capitalId,
    realm: info.position?.[0] ?? null,
    x: info.position?.[1] ?? null,
    y: info.position?.[2] ?? null,
    now,
  });
}

export interface ClanStatsInput {
  members: number | null;
  memberLimit: number | null;
  might: number | null;
  wealth: number | null;
  helpPoints: number | null;
  wealthRank: number | null;
  /** Everything read but not decoded, by source. */
  raw: Record<string, unknown>;
}

export function saveClanStats(clanId: number, gameDate: string, s: ClanStatsInput, now = new Date().toISOString()): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO game_clan_stats (clan_id, captured_at, game_date, members, member_limit, might, wealth, help_points, wealth_rank, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(clanId, now, gameDate, s.members, s.memberLimit, s.might, s.wealth, s.helpPoints, s.wealthRank, JSON.stringify(s.raw));
}

/** Save the clan's research; a history row only for a tech that is new or whose level moved. Returns the changes. */
export function saveClanTechs(clanId: number, techs: Record<string, number>, now = new Date().toISOString()): number {
  const db = getDb();
  const current = new Map(
    (db.prepare('SELECT tech_id, level FROM game_clan_techs WHERE clan_id = ?').all(clanId) as Array<{ tech_id: number; level: number }>)
      .map((r) => [r.tech_id, r.level]),
  );
  const upsert = db.prepare(`
    INSERT INTO game_clan_techs (clan_id, tech_id, level, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (clan_id, tech_id) DO UPDATE SET level = excluded.level, last_seen = excluded.last_seen
  `);
  const history = db.prepare('INSERT OR IGNORE INTO game_clan_tech_history (clan_id, tech_id, level, changed_at) VALUES (?, ?, ?, ?)');
  let changed = 0;
  db.transaction(() => {
    for (const [id, level] of Object.entries(techs)) {
      const techId = Number(id);
      upsert.run(clanId, techId, level, now, now);
      if (current.get(techId) !== level) {
        history.run(clanId, techId, level, now);
        changed++;
      }
    }
  })();
  return changed;
}

export function hasClanTechs(clanId: number): boolean {
  return !!getDb().prepare('SELECT 1 FROM game_clan_techs WHERE clan_id = ? LIMIT 1').get(clanId);
}

/** The latest archived raw reply of one clan-owned object (kind 'clan_object'), gunzipped. */
export function latestArchivedClanObject(clanId: number, objectId: number): { capturedAt: string; body: unknown } | null {
  const row = getDb().prepare(`
    SELECT captured_at AS capturedAt, payload FROM game_raw_snapshots
     WHERE clan_id = ? AND kind = 'clan_object' AND ref_id = ?
     ORDER BY game_date DESC LIMIT 1
  `).get(clanId, objectId) as { capturedAt: string; payload: Buffer } | undefined;
  if (!row) return null;
  return { capturedAt: row.capturedAt, body: JSON.parse(gunzipSync(row.payload).toString('utf8')) };
}

export function saveClanTreasury(clanId: number, gameDate: string, treasury: Record<string, number>, now = new Date().toISOString()): void {
  const db = getDb();
  const put = db.prepare(`
    INSERT OR REPLACE INTO game_clan_treasury (clan_id, game_date, resource_id, amount, captured_at) VALUES (?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const [id, amount] of Object.entries(treasury)) put.run(clanId, gameDate, Number(id), amount, now);
  })();
}

export function saveClanMedals(clanId: number, medals: Array<{ medalId: number; earnedAt: number }>, now = new Date().toISOString()): void {
  const db = getDb();
  const put = db.prepare(`
    INSERT INTO game_clan_medals (clan_id, medal_id, earned_at, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (clan_id, medal_id) DO UPDATE SET earned_at = excluded.earned_at, last_seen = excluded.last_seen
  `);
  db.transaction(() => {
    for (const m of medals) put.run(clanId, m.medalId, new Date(m.earnedAt * 1000).toISOString(), now, now);
  })();
}

// ---------------------------------------------------------------------------
// Reads (Clan page)
// ---------------------------------------------------------------------------

export interface ClanInfoRow {
  gameClanId: number;
  tag: string;
  name: string;
  foundedAt: string | null;
  language: string | null;
  logo: number | null;
  capitalId: number | null;
  realm: number | null;
  capitalX: number | null;
  capitalY: number | null;
  updatedAt: string;
}

export function getClanInfo(clanId: number): ClanInfoRow | null {
  const r = getDb().prepare(`
    SELECT game_clan_id AS gameClanId, tag, name, founded_at AS foundedAt, language, logo, capital_id AS capitalId,
           realm, capital_x AS capitalX, capital_y AS capitalY, updated_at AS updatedAt
      FROM game_clan_info WHERE clan_id = ?
  `).get(clanId) as ClanInfoRow | undefined;
  return r ?? null;
}

export interface ClanStatsRow {
  capturedAt: string;
  gameDate: string;
  members: number | null;
  memberLimit: number | null;
  might: number | null;
  wealth: number | null;
  helpPoints: number | null;
  wealthRank: number | null;
}

const STATS_COLUMNS = `captured_at AS capturedAt, game_date AS gameDate, members, member_limit AS memberLimit, might,
  wealth, help_points AS helpPoints, wealth_rank AS wealthRank`;

export function getLatestClanStats(clanId: number): ClanStatsRow | null {
  const r = getDb().prepare(`SELECT ${STATS_COLUMNS} FROM game_clan_stats WHERE clan_id = ? ORDER BY captured_at DESC LIMIT 1`)
    .get(clanId) as ClanStatsRow | undefined;
  return r ?? null;
}

/** One row per game day — the day's last read — for the last `days` game days, oldest first. */
export function getDailyClanStats(clanId: number, sinceGameDate: string): ClanStatsRow[] {
  return getDb().prepare(`
    SELECT ${STATS_COLUMNS} FROM game_clan_stats s
     WHERE clan_id = ? AND game_date >= ?
       AND captured_at = (SELECT MAX(captured_at) FROM game_clan_stats WHERE clan_id = s.clan_id AND game_date = s.game_date)
     ORDER BY game_date
  `).all(clanId, sinceGameDate) as ClanStatsRow[];
}

/** The clan's research levels and when they were last read. */
export function getClanTechs(clanId: number): { levels: Record<string, number>; readAt: string | null } {
  const rows = getDb().prepare('SELECT tech_id, level, last_seen FROM game_clan_techs WHERE clan_id = ?')
    .all(clanId) as Array<{ tech_id: number; level: number; last_seen: string }>;
  const levels: Record<string, number> = {};
  let readAt: string | null = null;
  for (const r of rows) {
    levels[String(r.tech_id)] = r.level;
    if (!readAt || r.last_seen > readAt) readAt = r.last_seen;
  }
  return { levels, readAt };
}

/**
 * Research levels reached since `sinceIso`, newest first. The first read of the
 * clan is its baseline (every tech "appears" then), so it is not a change.
 */
export function getClanTechChanges(clanId: number, sinceIso: string): Array<{ techId: number; level: number; changedAt: string }> {
  return getDb().prepare(`
    SELECT tech_id AS techId, level, changed_at AS changedAt FROM game_clan_tech_history
     WHERE clan_id = ? AND changed_at >= ?
       AND changed_at > (SELECT MIN(changed_at) FROM game_clan_tech_history WHERE clan_id = ?)
     ORDER BY changed_at DESC, tech_id
  `).all(clanId, sinceIso, clanId) as Array<{ techId: number; level: number; changedAt: string }>;
}

/** The treasury's latest day, with each resource's amount on the previous day it was read (for the change). */
export function getClanTreasury(clanId: number): { gameDate: string | null; capturedAt: string | null; rows: Array<{ resourceId: number; amount: number; previous: number | null }> } {
  const db = getDb();
  const last = db.prepare('SELECT MAX(game_date) AS d FROM game_clan_treasury WHERE clan_id = ?').get(clanId) as { d: string | null };
  if (!last.d) return { gameDate: null, capturedAt: null, rows: [] };
  const rows = db.prepare(`
    SELECT t.resource_id AS resourceId, t.amount, t.captured_at AS capturedAt,
           (SELECT p.amount FROM game_clan_treasury p
             WHERE p.clan_id = t.clan_id AND p.resource_id = t.resource_id AND p.game_date < t.game_date
             ORDER BY p.game_date DESC LIMIT 1) AS previous
      FROM game_clan_treasury t
     WHERE t.clan_id = ? AND t.game_date = ?
     ORDER BY t.resource_id
  `).all(clanId, last.d) as Array<{ resourceId: number; amount: number; capturedAt: string; previous: number | null }>;
  return {
    gameDate: last.d,
    capturedAt: rows.reduce<string | null>((m, r) => (!m || r.capturedAt > m ? r.capturedAt : m), null),
    rows: rows.map(({ resourceId, amount, previous }) => ({ resourceId, amount, previous })),
  };
}

export function getClanMedals(clanId: number): Array<{ medalId: number; earnedAt: string | null; lastSeen: string }> {
  return getDb().prepare(`
    SELECT medal_id AS medalId, earned_at AS earnedAt, last_seen AS lastSeen FROM game_clan_medals
     WHERE clan_id = ? AND last_seen = (SELECT MAX(last_seen) FROM game_clan_medals WHERE clan_id = ?)
     ORDER BY earned_at DESC
  `).all(clanId, clanId) as Array<{ medalId: number; earnedAt: string | null; lastSeen: string }>;
}

/** The clan's leader (game role 1) as the roster last read them, with the member row it links to. */
export function getClanLeader(clanId: number): { name: string; memberId: number | null } | null {
  const r = getDb().prepare(`
    SELECT gp.name, m.id AS memberId FROM game_players gp
      LEFT JOIN members m ON m.clan_id = gp.clan_id AND m.game_player_id = gp.player_id
     WHERE gp.clan_id = ? AND gp.role = 1 AND gp.in_clan = 1
     ORDER BY gp.last_seen DESC LIMIT 1
  `).get(clanId) as { name: string; memberId: number | null } | undefined;
  return r ?? null;
}

// ---------------------------------------------------------------------------
// Clan rankings (v117)
// ---------------------------------------------------------------------------

/** One clan in a kingdom ranking list, sorted by value (rank = position + 1). */
export interface RankingEntry {
  clanId: number;
  value: number;
  tag: string;
  name: string;
  logo: number | null;
  members: number | null;
  memberLimit: number | null;
}

/**
 * Store one ranking as read: the full list (replacing the last one) and this
 * clan's own rank and value (a history row per scan; rank null when the clan
 * isn't in the list).
 */
export function saveClanRanking(
  clanId: number,
  gameDate: string,
  kind: number,
  entries: RankingEntry[],
  own: { rank: number | null; value: number | null },
  now = new Date().toISOString(),
): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`INSERT OR REPLACE INTO game_clan_ranking_lists (clan_id, kind, captured_at, entries) VALUES (?, ?, ?, ?)`)
      .run(clanId, kind, now, JSON.stringify(entries));
    db.prepare(`INSERT OR REPLACE INTO game_clan_rankings (clan_id, captured_at, game_date, kind, rank, value) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(clanId, now, gameDate, kind, own.rank, own.value);
  })();
}

/** The latest list of every ranking kind read for the clan. */
export function getClanRankingLists(clanId: number): Array<{ kind: number; capturedAt: string; entries: RankingEntry[] }> {
  return (getDb().prepare('SELECT kind, captured_at AS capturedAt, entries FROM game_clan_ranking_lists WHERE clan_id = ?')
    .all(clanId) as Array<{ kind: number; capturedAt: string; entries: string }>)
    .map((r) => ({ kind: r.kind, capturedAt: r.capturedAt, entries: JSON.parse(r.entries) as RankingEntry[] }));
}

/** The clan's rank and value per kind, one row per game day (the day's last read), oldest first. */
export function getClanRankHistory(clanId: number, sinceGameDate: string): Array<{ kind: number; gameDate: string; rank: number | null; value: number | null }> {
  return getDb().prepare(`
    SELECT kind, game_date AS gameDate, rank, value FROM game_clan_rankings r
     WHERE clan_id = ? AND game_date >= ?
       AND captured_at = (SELECT MAX(captured_at) FROM game_clan_rankings
                           WHERE clan_id = r.clan_id AND kind = r.kind AND game_date = r.game_date)
     ORDER BY kind, game_date
  `).all(clanId, sinceGameDate) as Array<{ kind: number; gameDate: string; rank: number | null; value: number | null }>;
}
