/**
 * Storage for what the game server itself reports (migration v102).
 *
 * Everything is keyed on the game's own permanent ids — player id, gift id,
 * ledger entry id — so re-reading the same data is always an update, never a
 * duplicate. See docs/game-protocol.md.
 */
import { gzipSync } from 'zlib';
import { getDb } from '../database.js';
import type { ClanMember, PlayerRecord, LedgerEntry } from '../../game-protocol/messages.js';

export interface NamedGift {
  giftId: number;
  senderId: number;
  senderName: string;
  giftType: number;
  chestName: string;
  sourceName: string;
  count: number;
  tab: number;
  arrivedAt: number;
  expiresAt: number;
}

export interface CaptureRunResult {
  ok: boolean;
  error?: string;
  gameClanId?: number;
  members?: number;
  giftEntries?: number;
  newGifts?: number;
  ledgerNew?: number;
  namesVersion?: string;
  durationMs: number;
}

export function startCaptureRun(clanId: number): number {
  const r = getDb()
    .prepare('INSERT INTO game_capture_runs (clan_id, started_at) VALUES (?, ?)')
    .run(clanId, new Date().toISOString());
  return Number(r.lastInsertRowid);
}

export function finishCaptureRun(runId: number, res: CaptureRunResult): void {
  getDb()
    .prepare(
      `UPDATE game_capture_runs
          SET finished_at = ?, ok = ?, error = ?, game_clan_id = ?, members = ?, gift_entries = ?,
              new_gifts = ?, ledger_new = ?, names_version = ?, duration_ms = ?
        WHERE id = ?`,
    )
    .run(
      new Date().toISOString(),
      res.ok ? 1 : 0,
      res.error ?? null,
      res.gameClanId ?? null,
      res.members ?? null,
      res.giftEntries ?? null,
      res.newGifts ?? null,
      res.ledgerNew ?? null,
      res.namesVersion ?? null,
      res.durationMs,
      runId,
    );
}

/**
 * Upsert the clan's current members. Players no longer in the member list keep
 * their row with in_clan = 0, so departures stay visible. A history row is
 * written only when a tracked stat or the name changed since the last one.
 */
export function savePlayers(clanId: number, members: ClanMember[], players: PlayerRecord[], now = new Date().toISOString()): void {
  const db = getDb();
  const roles = new Map(members.map((m) => [m.playerId, m]));
  const upsert = db.prepare(
    `INSERT INTO game_players
       (clan_id, player_id, name, role, joined_at, in_clan, might, hero_level, city_level, vip, gold_pass, hero_avatar, city_id, first_seen, last_seen)
     VALUES (@clanId, @playerId, @name, @role, @joinedAt, 1, @might, @heroLevel, @cityLevel, @vip, @goldPass, @heroAvatar, @cityId, @now, @now)
     ON CONFLICT (clan_id, player_id) DO UPDATE SET
       name = excluded.name, role = excluded.role, joined_at = excluded.joined_at, in_clan = 1,
       might = excluded.might, hero_level = excluded.hero_level, city_level = excluded.city_level,
       vip = excluded.vip, gold_pass = excluded.gold_pass, hero_avatar = excluded.hero_avatar,
       city_id = excluded.city_id, last_seen = excluded.last_seen`,
  );
  const lastHistory = db.prepare(
    `SELECT name, might, hero_level, city_level, vip, gold_pass FROM game_player_history
      WHERE clan_id = ? AND player_id = ? ORDER BY captured_at DESC LIMIT 1`,
  );
  const addHistory = db.prepare(
    `INSERT OR IGNORE INTO game_player_history (clan_id, player_id, captured_at, name, might, hero_level, city_level, vip, gold_pass)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const markGone = db.prepare('UPDATE game_players SET in_clan = 0 WHERE clan_id = ? AND in_clan = 1 AND last_seen < ?');

  db.transaction(() => {
    for (const p of players) {
      const m = roles.get(p.playerId);
      if (!m) continue; // only clan members — lookups can return other players
      const row = {
        clanId, playerId: p.playerId, name: p.name, role: m.role, joinedAt: m.joinedAt,
        might: p.might, heroLevel: p.heroLevel, cityLevel: p.cityLevel, vip: p.vip,
        goldPass: p.goldPass ? 1 : 0, heroAvatar: p.heroAvatar, cityId: p.cityId, now,
      };
      upsert.run(row);
      const prev = lastHistory.get(clanId, p.playerId) as
        | { name: string; might: number | null; hero_level: number | null; city_level: number | null; vip: number | null; gold_pass: number | null }
        | undefined;
      const changed = !prev
        || prev.name !== p.name || prev.might !== p.might || prev.hero_level !== p.heroLevel
        || prev.city_level !== p.cityLevel || prev.vip !== p.vip || prev.gold_pass !== row.goldPass;
      if (changed) addHistory.run(clanId, p.playerId, now, p.name, p.might, p.heroLevel, p.cityLevel, p.vip, row.goldPass);
    }
    markGone.run(clanId, now);
  })();
}

/** Upsert gifts by the game's gift id. Returns how many were seen for the first time. */
export function saveGifts(clanId: number, gifts: NamedGift[], now = new Date().toISOString()): number {
  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM game_gifts WHERE clan_id = ? AND gift_id = ?');
  const upsert = db.prepare(
    `INSERT INTO game_gifts
       (clan_id, gift_id, sender_id, sender_name, gift_type, chest_name, source_name, chest_count, tab, arrived_at, expires_at, first_seen, last_seen)
     VALUES (@clanId, @giftId, @senderId, @senderName, @giftType, @chestName, @sourceName, @count, @tab, @arrivedAt, @expiresAt, @now, @now)
     ON CONFLICT (clan_id, gift_id) DO UPDATE SET
       sender_name = excluded.sender_name, chest_name = excluded.chest_name, source_name = excluded.source_name,
       chest_count = excluded.chest_count, last_seen = excluded.last_seen`,
  );
  let fresh = 0;
  db.transaction(() => {
    for (const g of gifts) {
      if (!exists.get(clanId, g.giftId)) fresh++;
      upsert.run({ clanId, now, ...g });
    }
  })();
  return fresh;
}

/** Insert ledger entries not seen before. Returns how many were new. */
export function saveLedger(clanId: number, entries: LedgerEntry[], now = new Date().toISOString()): number {
  const db = getDb();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO game_ledger (clan_id, entry_id, player_id, kind, resource, amounts, occurred_at, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let added = 0;
  db.transaction(() => {
    for (const e of entries) {
      added += insert.run(clanId, e.entryId, e.playerId, e.kind, e.resource, JSON.stringify(e.amounts), e.occurredAt, now).changes;
    }
  })();
  return added;
}

/**
 * Research + hero talent levels for one player. Upserts the current level and
 * writes a history row only for techs whose level changed (or are new).
 * Returns how many changed.
 */
export function saveTechs(clanId: number, playerId: number, techs: Record<string, number>, now = new Date().toISOString()): number {
  const db = getDb();
  const current = new Map(
    (db.prepare('SELECT tech_id, level FROM game_player_techs WHERE clan_id = ? AND player_id = ?').all(clanId, playerId) as
      Array<{ tech_id: number; level: number }>).map((r) => [r.tech_id, r.level]),
  );
  const upsert = db.prepare(
    `INSERT INTO game_player_techs (clan_id, player_id, tech_id, level, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (clan_id, player_id, tech_id) DO UPDATE SET level = excluded.level, last_seen = excluded.last_seen`,
  );
  const history = db.prepare(
    'INSERT OR IGNORE INTO game_player_tech_history (clan_id, player_id, tech_id, level, changed_at) VALUES (?, ?, ?, ?, ?)',
  );
  let changed = 0;
  db.transaction(() => {
    for (const [id, level] of Object.entries(techs)) {
      const techId = Number(id);
      upsert.run(clanId, playerId, techId, level, now, now);
      if (current.get(techId) !== level) {
        history.run(clanId, playerId, techId, level, now);
        changed++;
      }
    }
  })();
  return changed;
}

export function saveCitySnapshot(
  clanId: number,
  playerId: number,
  gameDate: string,
  snap: { techCount: number; buildings: unknown; hero: unknown },
  now = new Date().toISOString(),
): void {
  getDb().prepare(
    `INSERT OR REPLACE INTO game_city_snapshots (clan_id, player_id, game_date, captured_at, tech_count, buildings, hero)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(clanId, playerId, gameDate, now, snap.techCount, JSON.stringify(snap.buildings), JSON.stringify(snap.hero));
}

/** Players of this clan whose city was already captured for the game day. */
export function citySnapshotPlayers(clanId: number, gameDate: string): Set<number> {
  return new Set(
    (getDb().prepare('SELECT player_id FROM game_city_snapshots WHERE clan_id = ? AND game_date = ?').all(clanId, gameDate) as
      Array<{ player_id: number }>).map((r) => r.player_id),
  );
}

export interface MapObjectRow {
  objectId: number;
  type: number;
  name: string;
  level: number | null;
  realm: number | null;
  x: number | null;
  y: number | null;
  ownerId: number | null;
  expiresAt: number | null;
}

/** Upsert map objects by the game's object id. Returns how many were new. */
export function saveMapObjects(clanId: number, objects: MapObjectRow[], now = new Date().toISOString()): number {
  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM game_map_objects WHERE clan_id = ? AND object_id = ?');
  const upsert = db.prepare(
    `INSERT INTO game_map_objects (clan_id, object_id, object_type, object_name, level, realm, x, y, owner_id, expires_at, first_seen, last_seen)
     VALUES (@clanId, @objectId, @type, @name, @level, @realm, @x, @y, @ownerId, @expiresAt, @now, @now)
     ON CONFLICT (clan_id, object_id) DO UPDATE SET level = excluded.level, expires_at = excluded.expires_at, last_seen = excluded.last_seen`,
  );
  let fresh = 0;
  db.transaction(() => {
    for (const o of objects) {
      if (!exists.get(clanId, o.objectId)) fresh++;
      upsert.run({ clanId, now, ...o });
    }
  })();
  return fresh;
}

/** Keep a raw game reply (gzip of its decoded JSON) once per game day. */
export function saveRawSnapshot(clanId: number, kind: string, refId: number, gameDate: string, value: unknown, now = new Date().toISOString()): void {
  getDb().prepare(
    `INSERT OR REPLACE INTO game_raw_snapshots (clan_id, kind, ref_id, game_date, captured_at, payload) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(clanId, kind, refId, gameDate, now, gzipSync(JSON.stringify(value)));
}

export function hasRawSnapshot(clanId: number, kind: string, refId: number, gameDate: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM game_raw_snapshots WHERE clan_id = ? AND kind = ? AND ref_id = ? AND game_date = ?')
    .get(clanId, kind, refId, gameDate);
}

export interface CaptureRunRow {
  id: number;
  clanId: number;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean;
  error: string | null;
  members: number | null;
  giftEntries: number | null;
  newGifts: number | null;
  ledgerNew: number | null;
  durationMs: number | null;
}

export function recentCaptureRuns(clanId: number, limit = 20): CaptureRunRow[] {
  return (getDb()
    .prepare(
      `SELECT id, clan_id, started_at, finished_at, ok, error, members, gift_entries, new_gifts, ledger_new, duration_ms
         FROM game_capture_runs WHERE clan_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(clanId, limit) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as number,
    clanId: r.clan_id as number,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string) ?? null,
    ok: r.ok === 1,
    error: (r.error as string) ?? null,
    members: (r.members as number) ?? null,
    giftEntries: (r.gift_entries as number) ?? null,
    newGifts: (r.new_gifts as number) ?? null,
    ledgerNew: (r.ledger_new as number) ?? null,
    durationMs: (r.duration_ms as number) ?? null,
  }));
}
