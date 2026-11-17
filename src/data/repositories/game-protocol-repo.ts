/**
 * Storage for what the game server itself reports (migration v102).
 *
 * Everything is keyed on the game's own permanent ids — player id, gift id,
 * ledger entry id — so re-reading the same data is always an update, never a
 * duplicate. See docs/game-protocol.md.
 */
import { gunzipSync, gzipSync } from 'zlib';
import { getDb } from '../database.js';
import type { CityCaptain, ClanMember, PlayerRecord, LedgerEntry } from '../../game-protocol/messages.js';
import type { WornArtifact } from '../../game-protocol/artifacts.js';
import { HERO_ENTRY_ID, type WornItem } from '../../game-protocol/equipment.js';

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
export function savePlayers(
  clanId: number,
  members: ClanMember[],
  players: PlayerRecord[],
  now = new Date().toISOString(),
  /** The scan's game day (rollover-aware); the daily Gold Ingots row is keyed by it. */
  gameDate: string = now.slice(0, 10),
): void {
  const db = getDb();
  const roles = new Map(members.map((m) => [m.playerId, m]));
  const upsert = db.prepare(
    `INSERT INTO game_players
       (clan_id, player_id, name, role, joined_at, in_clan, might, hero_level, city_level, vip, gold_pass, hero_avatar,
        avatar_frame, city_appearance, city_id, gold_ingots, first_seen, last_seen)
     VALUES (@clanId, @playerId, @name, @role, @joinedAt, 1, @might, @heroLevel, @cityLevel, @vip, @goldPass, @heroAvatar,
        @avatarFrame, @cityAppearance, @cityId, @goldIngots, @now, @now)
     ON CONFLICT (clan_id, player_id) DO UPDATE SET
       name = excluded.name, role = excluded.role, joined_at = excluded.joined_at, in_clan = 1,
       might = excluded.might, hero_level = excluded.hero_level, city_level = excluded.city_level,
       vip = excluded.vip, gold_pass = excluded.gold_pass, hero_avatar = excluded.hero_avatar,
       avatar_frame = excluded.avatar_frame, city_appearance = excluded.city_appearance,
       city_id = excluded.city_id, gold_ingots = COALESCE(excluded.gold_ingots, game_players.gold_ingots),
       last_seen = excluded.last_seen`,
  );
  // Gold Ingots tick up every few minutes, so they are kept per game day (the
  // day's latest reading, rewritten every scan) — never part of the change
  // check below, which would write a history row per player per scan.
  const daily = db.prepare(
    `INSERT INTO game_player_daily (clan_id, player_id, game_date, gold_ingots, captured_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (clan_id, player_id, game_date) DO UPDATE SET
       gold_ingots = COALESCE(excluded.gold_ingots, game_player_daily.gold_ingots), captured_at = excluded.captured_at`,
  );
  const lastHistory = db.prepare(
    `SELECT name, might, hero_level, city_level, vip, gold_pass, hero_avatar, role FROM game_player_history
      WHERE clan_id = ? AND player_id = ? ORDER BY captured_at DESC LIMIT 1`,
  );
  const addHistory = db.prepare(
    `INSERT OR IGNORE INTO game_player_history (clan_id, player_id, captured_at, name, might, hero_level, city_level, vip, gold_pass, hero_avatar, role)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const markGone = db.prepare('UPDATE game_players SET in_clan = 0 WHERE clan_id = ? AND in_clan = 1 AND last_seen < ?');

  db.transaction(() => {
    for (const p of players) {
      const m = roles.get(p.playerId);
      if (!m) continue; // only clan members — lookups can return other players
      const row = {
        clanId, playerId: p.playerId, name: p.name, role: m.role, joinedAt: m.joinedAt,
        might: p.might, heroLevel: p.heroLevel, cityLevel: p.cityLevel, vip: p.vip,
        goldPass: p.goldPass ? 1 : 0, heroAvatar: p.heroAvatar, cityId: p.cityId, goldIngots: p.goldIngots ?? null, now,
        avatarFrame: p.avatarFrame ?? null, cityAppearance: p.cityAppearance ?? null,
      };
      upsert.run(row);
      if (p.goldIngots !== null && p.goldIngots !== undefined) daily.run(clanId, p.playerId, gameDate, p.goldIngots, now);
      const prev = lastHistory.get(clanId, p.playerId) as
        | { name: string; might: number | null; hero_level: number | null; city_level: number | null; vip: number | null;
            gold_pass: number | null; hero_avatar: number | null; role: number | null }
        | undefined;
      const changed = !prev
        || prev.name !== p.name || prev.might !== p.might || prev.hero_level !== p.heroLevel
        || prev.city_level !== p.cityLevel || prev.vip !== p.vip || prev.gold_pass !== row.goldPass
        || prev.hero_avatar !== p.heroAvatar || prev.role !== m.role;
      if (changed) addHistory.run(clanId, p.playerId, now, p.name, p.might, p.heroLevel, p.cityLevel, p.vip, row.goldPass, p.heroAvatar, m.role);
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
  snap: { techCount: number; buildings: unknown; dragon: unknown },
  now = new Date().toISOString(),
): void {
  // The `hero` column holds the city's field 26 — the DRAGON (named before
  // that was known; CityRecord.dragon).
  getDb().prepare(
    `INSERT OR REPLACE INTO game_city_snapshots (clan_id, player_id, game_date, captured_at, tech_count, buildings, hero)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(clanId, playerId, gameDate, now, snap.techCount, JSON.stringify(snap.buildings), JSON.stringify(snap.dragon));
}

/**
 * Store a player's captains (city field 9); a history row only when a captain
 * is new or its level or star level moved. Returns the number of such changes.
 * The hero's entry (id 1) is stored for its current level and XP but writes no
 * history: the captains' history (and the member timeline built on it) is
 * captains only, and the hero's level history is game_players.hero_level.
 */
export function saveCaptains(clanId: number, playerId: number, captains: CityCaptain[], now = new Date().toISOString()): number {
  const db = getDb();
  const prev = new Map((db.prepare('SELECT captain_id, level, stars FROM game_player_captains WHERE clan_id = ? AND player_id = ?')
    .all(clanId, playerId) as Array<{ captain_id: number; level: number; stars: number }>).map((r) => [r.captain_id, r]));
  const upsert = db.prepare(
    `INSERT INTO game_player_captains (clan_id, player_id, captain_id, level, stars, xp, slot, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (clan_id, player_id, captain_id) DO UPDATE SET
       level = excluded.level, stars = excluded.stars, xp = excluded.xp, slot = excluded.slot, last_seen = excluded.last_seen`,
  );
  const hist = db.prepare(
    'INSERT OR IGNORE INTO game_player_captain_history (clan_id, player_id, captain_id, level, stars, changed_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  let changed = 0;
  db.transaction(() => {
    for (const c of captains) {
      upsert.run(clanId, playerId, c.id, c.level, c.stars, c.xp, c.slot, now, now);
      if (c.id === HERO_ENTRY_ID) continue;
      const p = prev.get(c.id);
      if (!p || p.level !== c.level || p.stars !== c.stars) {
        hist.run(clanId, playerId, c.id, c.level, c.stars, now);
        changed++;
      }
    }
  })();
  return changed;
}

/**
 * The artifacts a player's line-up captains wear, as one city read showed
 * them (v112). Every artifact in the read is upserted and marked in the
 * line-up; any other stored artifact of the player is marked out of it (it
 * moved to a benched captain — still owned, just not in the city data). A
 * history row is written when an artifact comes into the line-up (first seen,
 * or back), when its level, star level or rolls changed, and — with
 * in_lineup 0 (v118) — when it leaves the line-up. Reads may be replayed from
 * the archive oldest first (each replayed read lands in history at its own
 * time; replaying the same read twice is a no-op). Returns the history rows
 * written.
 */
export function saveArtifacts(clanId: number, playerId: number, artifacts: WornArtifact[], at = new Date().toISOString()): number {
  const db = getDb();
  const prev = new Map((db.prepare('SELECT artifact_type, level, star, bonuses, in_lineup FROM game_player_artifacts WHERE clan_id = ? AND player_id = ?')
    .all(clanId, playerId) as Array<{ artifact_type: number; level: number; star: number; bonuses: string; in_lineup: number }>).map((r) => [r.artifact_type, r]));
  const upsert = db.prepare(
    `INSERT INTO game_player_artifacts (clan_id, player_id, artifact_type, level, star, bonuses, in_lineup, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (clan_id, player_id, artifact_type) DO UPDATE SET
       level = excluded.level, star = excluded.star, bonuses = excluded.bonuses, in_lineup = 1,
       first_seen = MIN(first_seen, excluded.first_seen), last_seen = excluded.last_seen`,
  );
  const hist = db.prepare(
    `INSERT OR IGNORE INTO game_player_artifact_history (clan_id, player_id, artifact_type, level, star, bonuses, in_lineup, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const benched = db.prepare('UPDATE game_player_artifacts SET in_lineup = 0 WHERE clan_id = ? AND player_id = ? AND artifact_type = ?');
  let changed = 0;
  db.transaction(() => {
    const seen = new Set<number>();
    for (const a of artifacts) {
      const bonuses = JSON.stringify(a.bonuses);
      seen.add(a.type);
      upsert.run(clanId, playerId, a.type, a.level, a.star, bonuses, at, at);
      const p = prev.get(a.type);
      // New, back in the line-up, or moved on: a row (in the line-up).
      if (!p || p.in_lineup === 0 || p.level !== a.level || p.star !== a.star || p.bonuses !== bonuses) {
        changed += hist.run(clanId, playerId, a.type, a.level, a.star, bonuses, 1, at).changes;
      }
    }
    for (const [type, p] of prev) {
      if (seen.has(type)) continue;
      benched.run(clanId, playerId, type);
      // Left the line-up (its captain was benched or it moved to one): a row, once.
      if (p.in_lineup !== 0) changed += hist.run(clanId, playerId, type, p.level, p.star, p.bonuses, 0, at).changes;
    }
  })();
  return changed;
}

/**
 * What every captain of a player wears, as one city read showed it (v112):
 * one row per filled position. A history row is written when a position gets
 * a different item (by instance uid), a different enchantment or gems, or is
 * emptied (item_type 0). Replayable oldest-first like saveArtifacts. Only call
 * it with a read that carried the item list — an empty read would look like
 * every captain undressed. Returns the history rows written.
 */
export function saveCaptainEquipment(
  clanId: number,
  playerId: number,
  worn: WornItem[],
  at = new Date().toISOString(),
  /**
   * Only these captains are compared (and only their positions can empty):
   * a one-time archive re-read for one wearer — the hero, added Nov 2026 —
   * must not touch the history of captains already stored.
   */
  onlyCaptains?: ReadonlySet<number>,
): number {
  const db = getDb();
  type Row = { captain_id: number; position: number; item_uid: string; item_type: number; enchantment: number; gems: string };
  const key = (captainId: number, position: number) => `${captainId}:${position}`;
  if (onlyCaptains) worn = worn.filter((w) => onlyCaptains.has(w.captainId));
  const prev = new Map((db.prepare(
    'SELECT captain_id, position, item_uid, item_type, enchantment, gems FROM game_player_captain_equipment WHERE clan_id = ? AND player_id = ?',
  ).all(clanId, playerId) as Row[]).filter((r) => !onlyCaptains || onlyCaptains.has(r.captain_id)).map((r) => [key(r.captain_id, r.position), r]));
  const upsert = db.prepare(
    `INSERT INTO game_player_captain_equipment
       (clan_id, player_id, captain_id, position, item_uid, item_type, enchantment, gems, raw, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (clan_id, player_id, captain_id, position) DO UPDATE SET
       item_uid = excluded.item_uid, item_type = excluded.item_type, enchantment = excluded.enchantment,
       gems = excluded.gems, raw = excluded.raw, last_seen = excluded.last_seen,
       first_seen = CASE WHEN game_player_captain_equipment.item_uid = excluded.item_uid
                         THEN MIN(game_player_captain_equipment.first_seen, excluded.first_seen) ELSE excluded.first_seen END`,
  );
  const hist = db.prepare(
    `INSERT OR IGNORE INTO game_player_equipment_history
       (clan_id, player_id, captain_id, position, item_uid, item_type, enchantment, gems, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const remove = db.prepare('DELETE FROM game_player_captain_equipment WHERE clan_id = ? AND player_id = ? AND captain_id = ? AND position = ?');
  let changed = 0;
  db.transaction(() => {
    const seen = new Set<string>();
    for (const w of worn) {
      const k = key(w.captainId, w.position);
      seen.add(k);
      const gems = JSON.stringify(w.gems);
      upsert.run(clanId, playerId, w.captainId, w.position, w.uid, w.type, w.enchantment, gems, JSON.stringify(w.raw), at, at);
      const p = prev.get(k);
      if (!p || p.item_uid !== w.uid || p.item_type !== w.type || p.enchantment !== w.enchantment || p.gems !== gems) {
        changed += hist.run(clanId, playerId, w.captainId, w.position, w.uid, w.type, w.enchantment, gems, at).changes;
      }
    }
    for (const [k, p] of prev) {
      if (seen.has(k)) continue;
      remove.run(clanId, playerId, p.captain_id, p.position);
      changed += hist.run(clanId, playerId, p.captain_id, p.position, '', 0, 0, '[]', at).changes;
    }
  })();
  return changed;
}

/** The archive version a parser last replayed for this clan (0 = never). */
export function getParseMarker(clanId: number, parser: string): number {
  const row = getDb().prepare('SELECT version FROM game_parse_markers WHERE clan_id = ? AND parser = ?').get(clanId, parser) as
    { version: number } | undefined;
  return row?.version ?? 0;
}

export function setParseMarker(clanId: number, parser: string, version: number, now = new Date().toISOString()): void {
  getDb().prepare(
    `INSERT INTO game_parse_markers (clan_id, parser, version, done_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (clan_id, parser) DO UPDATE SET version = excluded.version, done_at = excluded.done_at`,
  ).run(clanId, parser, version, now);
}

/**
 * Every archived raw reply of one kind for the clan, oldest read first, one at
 * a time (a clan's archive can be thousands of replies). Body as archived.
 */
export function* rawSnapshotsOldestFirst(clanId: number, kind: string): Generator<{ refId: number; capturedAt: string; body: unknown }> {
  // Keys first, then one payload at a time: the caller WRITES while it walks
  // (history rows), and better-sqlite3 refuses any statement while an
  // .iterate() cursor is open on the connection ("This database connection
  // is busy executing a query" — the artifacts replay failed on prod with it,
  // Nov 2026). The payloads stay out of memory together.
  const db = getDb();
  const keys = db.prepare(
    `SELECT ref_id AS refId, game_date AS gameDate, captured_at AS capturedAt FROM game_raw_snapshots
      WHERE clan_id = ? AND kind = ? ORDER BY captured_at, ref_id`,
  ).all(clanId, kind) as Array<{ refId: number; gameDate: string; capturedAt: string }>;
  const payloadOf = db.prepare('SELECT payload FROM game_raw_snapshots WHERE clan_id = ? AND kind = ? AND ref_id = ? AND game_date = ?');
  for (const k of keys) {
    const row = payloadOf.get(clanId, kind, k.refId, k.gameDate) as { payload: Buffer } | undefined;
    if (row) yield { refId: k.refId, capturedAt: k.capturedAt, body: JSON.parse(gunzipSync(row.payload).toString('utf8')) };
  }
}

/** Players of this clan with any captain stored (v108) — the rest are read once more to backfill. */
export function playersWithCaptains(clanId: number): Set<number> {
  return new Set(
    (getDb().prepare('SELECT DISTINCT player_id FROM game_player_captains WHERE clan_id = ?').all(clanId) as
      Array<{ player_id: number }>).map((r) => r.player_id),
  );
}

/** Players of this clan whose city was already captured for the game day. */
export function citySnapshotPlayers(clanId: number, gameDate: string): Set<number> {
  return new Set(
    (getDb().prepare('SELECT player_id FROM game_city_snapshots WHERE clan_id = ? AND game_date = ?').all(clanId, gameDate) as
      Array<{ player_id: number }>).map((r) => r.player_id),
  );
}

/**
 * Players whose city has been read today but whose player record changed since
 * (a game_player_history row newer than the last city read — might or hero
 * level moved, which finished research and talents nearly always do). Reading
 * those again on this scan dates a research or talent upgrade to the scan it
 * happened in, instead of to the day.
 */
export function cityChangedSinceRead(clanId: number, gameDate: string): Set<number> {
  return new Set(
    (getDb().prepare(
      `SELECT c.player_id FROM game_city_snapshots c
        WHERE c.clan_id = ? AND c.game_date = ?
          AND EXISTS (SELECT 1 FROM game_player_history h
                       WHERE h.clan_id = c.clan_id AND h.player_id = c.player_id AND h.captured_at > c.captured_at)`,
    ).all(clanId, gameDate) as Array<{ player_id: number }>).map((r) => r.player_id),
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

/**
 * Shield and burning state of member cities, as the map shows them (v112).
 * Only players already in game_players for this clan are updated; a history
 * row is written when the state is first seen or changes. Returns how many
 * players changed state.
 */
export function saveCityStatuses(
  clanId: number,
  statuses: Array<{ playerId: number; shielded: boolean; burning: boolean }>,
  now = new Date().toISOString(),
): number {
  const db = getDb();
  const prevOf = db.prepare('SELECT shielded, burning FROM game_players WHERE clan_id = ? AND player_id = ?');
  const update = db.prepare('UPDATE game_players SET shielded = ?, burning = ?, map_seen_at = ? WHERE clan_id = ? AND player_id = ?');
  const hist = db.prepare(
    'INSERT OR IGNORE INTO game_city_status_history (clan_id, player_id, changed_at, shielded, burning) VALUES (?, ?, ?, ?, ?)',
  );
  let changed = 0;
  db.transaction(() => {
    for (const s of statuses) {
      const prev = prevOf.get(clanId, s.playerId) as { shielded: number | null; burning: number | null } | undefined;
      if (!prev) continue; // not a member we track
      const sh = s.shielded ? 1 : 0;
      const bu = s.burning ? 1 : 0;
      update.run(sh, bu, now, clanId, s.playerId);
      if (prev.shielded !== sh || prev.burning !== bu) {
        hist.run(clanId, s.playerId, now, sh, bu);
        changed++;
      }
    }
  })();
  return changed;
}

/** Keep a raw game reply (gzip of its decoded JSON) once per game day. */
export function saveRawSnapshot(clanId: number, kind: string, refId: number, gameDate: string, value: unknown, now = new Date().toISOString()): void {
  getDb().prepare(
    `INSERT OR REPLACE INTO game_raw_snapshots (clan_id, kind, ref_id, game_date, captured_at, payload) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(clanId, kind, refId, gameDate, now, gzipSync(JSON.stringify(value)));
}

/**
 * The latest archived city reply of every player in the clan who has one but
 * no research or no captains stored — so a parser fixed or added later fills
 * them from what was already read (a reply holds both). Body as archived.
 */
export function rawCitiesMissingData(clanId: number): Array<{ playerId: number; capturedAt: string; body: unknown }> {
  const rows = getDb().prepare(`
    SELECT r.ref_id AS playerId, r.captured_at AS capturedAt, r.payload
      FROM game_raw_snapshots r
     WHERE r.clan_id = ? AND r.kind = 'city'
       AND r.game_date = (SELECT MAX(game_date) FROM game_raw_snapshots
                           WHERE clan_id = r.clan_id AND kind = 'city' AND ref_id = r.ref_id)
       AND (NOT EXISTS (SELECT 1 FROM game_player_techs t WHERE t.clan_id = r.clan_id AND t.player_id = r.ref_id)
         OR NOT EXISTS (SELECT 1 FROM game_player_captains c WHERE c.clan_id = r.clan_id AND c.player_id = r.ref_id))
  `).all(clanId) as Array<{ playerId: number; capturedAt: string; payload: Buffer }>;
  return rows.map((r) => ({ playerId: r.playerId, capturedAt: r.capturedAt, body: JSON.parse(gunzipSync(r.payload).toString('utf8')) }));
}

/** Drop raw snapshots of one kind from game days before `beforeGameDate`. Returns rows removed. */
export function pruneRawSnapshots(kind: string, beforeGameDate: string): number {
  return getDb().prepare('DELETE FROM game_raw_snapshots WHERE kind = ? AND game_date < ?').run(kind, beforeGameDate).changes;
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
