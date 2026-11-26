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
import type { HeldTitle } from '../../game-protocol/titles.js';

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
      // The titles they hold (field 19) and how often they received each (field 20).
      if (p.titles) saveTitles(clanId, p.playerId, p.titles, now);
      if (p.titleCounts) saveTitleCounts(clanId, p.playerId, p.titleCounts, now);
    }
    markGone.run(clanId, now);
  })();
}

/**
 * The titles one read showed a player holding (v125): the player record's
 * field 19 (every scan) or the city's field 21 (daily, and the archive). One
 * row per grant, keyed (title, assigned_at): a title received again is a new
 * row, so the table is the history. A stored grant the read lacks gets
 * `gone_at` — when the read is newer than its last sighting and the grant
 * already existed at the read (an archived read from before it was received
 * says nothing about it). Replayable in any order: first_seen / last_seen only
 * widen, gone_at only moves earlier, and a sighting after gone_at clears it.
 * Returns the rows that changed (new grants + newly gone).
 */
export function saveTitles(clanId: number, playerId: number, titles: HeldTitle[], at = new Date().toISOString()): number {
  const db = getDb();
  const atSec = Math.floor(Date.parse(at) / 1000);
  type Row = { title_id: number; assigned_at: number; last_seen: string; gone_at: string | null };
  const key = (titleId: number, assignedAt: number) => `${titleId}:${assignedAt}`;
  const prev = new Map((db.prepare(
    'SELECT title_id, assigned_at, last_seen, gone_at FROM game_player_titles WHERE clan_id = ? AND player_id = ?',
  ).all(clanId, playerId) as Row[]).map((r) => [key(r.title_id, r.assigned_at), r]));
  const upsert = db.prepare(
    `INSERT INTO game_player_titles (clan_id, player_id, title_id, assigned_at, event_id, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (clan_id, player_id, title_id, assigned_at) DO UPDATE SET
       event_id = COALESCE(excluded.event_id, game_player_titles.event_id),
       first_seen = MIN(game_player_titles.first_seen, excluded.first_seen),
       last_seen = MAX(game_player_titles.last_seen, excluded.last_seen),
       gone_at = CASE WHEN game_player_titles.gone_at <= excluded.last_seen THEN NULL ELSE game_player_titles.gone_at END`,
  );
  const gone = db.prepare(
    'UPDATE game_player_titles SET gone_at = ? WHERE clan_id = ? AND player_id = ? AND title_id = ? AND assigned_at = ?',
  );
  let changed = 0;
  db.transaction(() => {
    const seen = new Set<string>();
    for (const t of titles) {
      const k = key(t.titleId, t.assignedAt);
      if (seen.has(k)) continue;
      seen.add(k);
      upsert.run(clanId, playerId, t.titleId, t.assignedAt, t.eventId, at, at);
      if (!prev.has(k)) changed++;
    }
    for (const [k, r] of prev) {
      if (seen.has(k) || r.last_seen >= at || r.assigned_at > atSec) continue;
      if (r.gone_at !== null && r.gone_at <= at) continue;
      if (r.gone_at === null) changed++;
      gone.run(at, clanId, playerId, r.title_id, r.assigned_at);
    }
  })();
  return changed;
}

/** How many times a player received each title in all (402 field 20): the latest count per title. */
export function saveTitleCounts(clanId: number, playerId: number, counts: Record<string, number>, at = new Date().toISOString()): void {
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO game_player_title_counts (clan_id, player_id, title_id, times, first_seen, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (clan_id, player_id, title_id) DO UPDATE SET
       times = excluded.times,
       updated_at = CASE WHEN game_player_title_counts.times = excluded.times
                         THEN game_player_title_counts.updated_at ELSE excluded.updated_at END`,
  );
  db.transaction(() => {
    for (const [titleId, times] of Object.entries(counts)) upsert.run(clanId, playerId, Number(titleId), times, at, at);
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
  snap: { techCount: number; buildings: unknown; dragon: unknown; speeds?: unknown },
  now = new Date().toISOString(),
): void {
  // The `hero` column holds the city's field 26 — the DRAGON (named before
  // that was known; CityRecord.dragon). `speeds`: city-speeds.ts, or NULL.
  getDb().prepare(
    `INSERT OR REPLACE INTO game_city_snapshots (clan_id, player_id, game_date, captured_at, tech_count, buildings, hero, speeds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(clanId, playerId, gameDate, now, snap.techCount, JSON.stringify(snap.buildings), JSON.stringify(snap.dragon),
    snap.speeds ? JSON.stringify(snap.speeds) : null);
}

/**
 * Work out a game day's speeds from an archived reply of that day (the
 * replay: speeds were stored from Nov 26 2026, the archive holds the 60 days
 * before). A day without a snapshot row is left alone — the replay never
 * invents a read. Returns whether a row changed.
 */
export function updateCitySpeeds(clanId: number, playerId: number, gameDate: string, speeds: unknown): boolean {
  const json = JSON.stringify(speeds);
  return getDb().prepare(
    'UPDATE game_city_snapshots SET speeds = ? WHERE clan_id = ? AND player_id = ? AND game_date = ? AND speeds IS NOT ?',
  ).run(json, clanId, playerId, gameDate, json).changes > 0;
}

/** A player's VIP level when `iso` was read: the player history's, else today's. */
export function vipAt(clanId: number, playerId: number, iso: string): number | null {
  const db = getDb();
  const h = db.prepare(
    'SELECT vip FROM game_player_history WHERE clan_id = ? AND player_id = ? AND captured_at <= ? AND vip IS NOT NULL ORDER BY captured_at DESC LIMIT 1',
  ).get(clanId, playerId, iso) as { vip: number } | undefined;
  if (h) return h.vip;
  const p = db.prepare('SELECT vip FROM game_players WHERE clan_id = ? AND player_id = ?').get(clanId, playerId) as { vip: number | null } | undefined;
  return p?.vip ?? null;
}

/**
 * The clan's research levels when `iso` was read: each tech's latest level
 * by then; one first read after `iso` counts from its first level (the
 * clan's research was first read with the first city reads).
 */
export function clanTechLevelsAt(clanId: number, iso: string): Record<string, number> {
  const rows = getDb().prepare(
    'SELECT tech_id, level, changed_at FROM game_clan_tech_history WHERE clan_id = ? ORDER BY changed_at',
  ).all(clanId) as Array<{ tech_id: number; level: number; changed_at: string }>;
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = String(r.tech_id);
    if (r.changed_at <= iso || !(k in out)) out[k] = r.level;
  }
  return out;
}

/**
 * Rewrite the dragon of a game day's city snapshot from an archived reply of
 * that day — stage and name were parsed only from Nov 2026, and the archive
 * holds them for every day it kept. A day without a snapshot row is left
 * alone (the replay never invents a read). Returns whether a row changed.
 */
export function updateCityDragon(clanId: number, playerId: number, gameDate: string, dragon: unknown): boolean {
  return getDb().prepare(
    'UPDATE game_city_snapshots SET hero = ? WHERE clan_id = ? AND player_id = ? AND game_date = ? AND hero IS NOT ?',
  ).run(JSON.stringify(dragon), clanId, playerId, gameDate, JSON.stringify(dragon)).changes > 0;
}

/**
 * Store a player's captains (city field 9); a history row only when a captain
 * is new or its level or star level moved. Returns the number of such changes.
 * The hero's entry (id 1) is stored for its current level and XP but writes no
 * history: the captains' history (and the member timeline built on it) is
 * captains only, and the hero's level history is game_players.hero_level.
 */
/**
 * The hero's field-9 entry (level, XP) from an archived city read, for the
 * one-time replay: the stored row keeps the newest read's values whatever the
 * replay order — a live read today is never overwritten by an older archived
 * one — and the earliest read as first_seen ("Tracked since"). Returns 1 when
 * the row was written.
 */
export function saveHeroEntryFromArchive(clanId: number, playerId: number, hero: CityCaptain, at: string): number {
  if (hero.id !== HERO_ENTRY_ID) return 0;
  return getDb().prepare(
    `INSERT INTO game_player_captains (clan_id, player_id, captain_id, level, stars, xp, slot, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (clan_id, player_id, captain_id) DO UPDATE SET
       first_seen = MIN(game_player_captains.first_seen, excluded.first_seen),
       level = CASE WHEN excluded.last_seen > game_player_captains.last_seen THEN excluded.level ELSE game_player_captains.level END,
       stars = CASE WHEN excluded.last_seen > game_player_captains.last_seen THEN excluded.stars ELSE game_player_captains.stars END,
       xp = CASE WHEN excluded.last_seen > game_player_captains.last_seen THEN excluded.xp ELSE game_player_captains.xp END,
       slot = CASE WHEN excluded.last_seen > game_player_captains.last_seen THEN excluded.slot ELSE game_player_captains.slot END,
       last_seen = MAX(game_player_captains.last_seen, excluded.last_seen)`,
  ).run(clanId, playerId, HERO_ENTRY_ID, hero.level, hero.stars, hero.xp, hero.slot, at, at).changes > 0 ? 1 : 0;
}

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
export function* rawSnapshotsOldestFirst(clanId: number, kind: string): Generator<{ refId: number; gameDate: string; capturedAt: string; body: unknown }> {
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
    if (row) yield { refId: k.refId, gameDate: k.gameDate, capturedAt: k.capturedAt, body: JSON.parse(gunzipSync(row.payload).toString('utf8')) };
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

export interface RaisedVault {
  objectId: number;
  level: number | null;
  realm: number | null;
  x: number | null;
  y: number | null;
  ownerId: number | null;
  /** The clan's member row for the owner (linked on game_player_id), or null. */
  memberId: number | null;
  /** The member's name, else the game's name for a player seen in the clan's roster. */
  ownerName: string | null;
  /** The owner is (or was) in the clan: a linked member or a roster player. */
  inClan: boolean;
  firstSeen: string;
  lastSeen: string;
}

/**
 * Vaults of the Ancients seen on the map around the clan's cities whose first
 * sighting falls in [from, to) — either bound may be omitted. The map object's
 * owner is the player who raised it (one vault per player per Vaultsday, the
 * first day of an Ancients run). Oldest sighting first.
 */
export function listRaisedVaults(clanId: number, from?: string | null, to?: string | null): RaisedVault[] {
  const rows = getDb().prepare(
    `SELECT o.object_id, o.level, o.realm, o.x, o.y, o.owner_id, o.first_seen, o.last_seen,
            m.id AS member_id, m.name AS member_name, gp.name AS player_name
       FROM game_map_objects o
       LEFT JOIN members m ON m.clan_id = o.clan_id AND m.game_player_id = o.owner_id
       LEFT JOIN game_players gp ON gp.clan_id = o.clan_id AND gp.player_id = o.owner_id
      WHERE o.clan_id = ? AND o.object_name LIKE '%vault%'
        AND (? IS NULL OR o.first_seen >= ?) AND (? IS NULL OR o.first_seen < ?)
      ORDER BY o.first_seen, o.object_id`,
  ).all(clanId, from ?? null, from ?? null, to ?? null, to ?? null) as Array<{
    object_id: number; level: number | null; realm: number | null; x: number | null; y: number | null;
    owner_id: number | null; first_seen: string; last_seen: string;
    member_id: number | null; member_name: string | null; player_name: string | null;
  }>;
  return rows.map((r) => ({
    objectId: r.object_id,
    level: r.level,
    realm: r.realm,
    x: r.x,
    y: r.y,
    ownerId: r.owner_id,
    memberId: r.member_id,
    ownerName: r.member_name ?? r.player_name,
    inClan: r.member_id !== null || r.player_name !== null,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  }));
}

export interface KnownVault {
  objectId: number;
  ownerId: number | null;
  x: number | null;
  y: number | null;
  /** Unix seconds. */
  expiresAt: number | null;
  lastSeen: string;
}

/** Vaults (any owner) first seen at or after `since` (ISO) — this run's, for the map pass. */
export function vaultsSeenSince(clanId: number, since: string): KnownVault[] {
  return (getDb().prepare(
    `SELECT object_id, owner_id, x, y, expires_at, last_seen FROM game_map_objects
      WHERE clan_id = ? AND object_name LIKE '%vault%' AND first_seen >= ?`,
  ).all(clanId, since) as Array<{
    object_id: number; owner_id: number | null; x: number | null; y: number | null; expires_at: number | null; last_seen: string;
  }>).map((r) => ({ objectId: r.object_id, ownerId: r.owner_id, x: r.x, y: r.y, expiresAt: r.expires_at, lastSeen: r.last_seen }));
}

/** When the map pass last saw members' cities (game_players.map_seen_at), or null. */
export function lastMapPassAt(clanId: number): string | null {
  const row = getDb().prepare('SELECT MAX(map_seen_at) AS at FROM game_players WHERE clan_id = ?').get(clanId) as { at: string | null };
  return row.at;
}

/**
 * When the map around the clan's cities was first read, or null: the oldest
 * map object or city-status row (a clan whose map never held a vault still
 * has the latter).
 */
export function mapReadSince(clanId: number): string | null {
  const row = getDb().prepare(
    `SELECT MIN(t) AS since FROM (
       SELECT MIN(first_seen) AS t FROM game_map_objects WHERE clan_id = ?
       UNION ALL SELECT MIN(changed_at) FROM game_city_status_history WHERE clan_id = ?
     )`,
  ).get(clanId, clanId) as { since: string | null };
  return row.since;
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
