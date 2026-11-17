"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startCaptureRun = startCaptureRun;
exports.finishCaptureRun = finishCaptureRun;
exports.savePlayers = savePlayers;
exports.saveGifts = saveGifts;
exports.saveLedger = saveLedger;
exports.saveTechs = saveTechs;
exports.saveCitySnapshot = saveCitySnapshot;
exports.saveCaptains = saveCaptains;
exports.citySnapshotPlayers = citySnapshotPlayers;
exports.cityChangedSinceRead = cityChangedSinceRead;
exports.saveMapObjects = saveMapObjects;
exports.saveRawSnapshot = saveRawSnapshot;
exports.hasRawSnapshot = hasRawSnapshot;
exports.recentCaptureRuns = recentCaptureRuns;
/**
 * Storage for what the game server itself reports (migration v102).
 *
 * Everything is keyed on the game's own permanent ids — player id, gift id,
 * ledger entry id — so re-reading the same data is always an update, never a
 * duplicate. See docs/game-protocol.md.
 */
const zlib_1 = require("zlib");
const database_js_1 = require("../database.js");
function startCaptureRun(clanId) {
    const r = (0, database_js_1.getDb)()
        .prepare('INSERT INTO game_capture_runs (clan_id, started_at) VALUES (?, ?)')
        .run(clanId, new Date().toISOString());
    return Number(r.lastInsertRowid);
}
function finishCaptureRun(runId, res) {
    (0, database_js_1.getDb)()
        .prepare(`UPDATE game_capture_runs
          SET finished_at = ?, ok = ?, error = ?, game_clan_id = ?, members = ?, gift_entries = ?,
              new_gifts = ?, ledger_new = ?, names_version = ?, duration_ms = ?
        WHERE id = ?`)
        .run(new Date().toISOString(), res.ok ? 1 : 0, res.error ?? null, res.gameClanId ?? null, res.members ?? null, res.giftEntries ?? null, res.newGifts ?? null, res.ledgerNew ?? null, res.namesVersion ?? null, res.durationMs, runId);
}
/**
 * Upsert the clan's current members. Players no longer in the member list keep
 * their row with in_clan = 0, so departures stay visible. A history row is
 * written only when a tracked stat or the name changed since the last one.
 */
function savePlayers(clanId, members, players, now = new Date().toISOString()) {
    const db = (0, database_js_1.getDb)();
    const roles = new Map(members.map((m) => [m.playerId, m]));
    const upsert = db.prepare(`INSERT INTO game_players
       (clan_id, player_id, name, role, joined_at, in_clan, might, hero_level, city_level, vip, gold_pass, hero_avatar, city_id, first_seen, last_seen)
     VALUES (@clanId, @playerId, @name, @role, @joinedAt, 1, @might, @heroLevel, @cityLevel, @vip, @goldPass, @heroAvatar, @cityId, @now, @now)
     ON CONFLICT (clan_id, player_id) DO UPDATE SET
       name = excluded.name, role = excluded.role, joined_at = excluded.joined_at, in_clan = 1,
       might = excluded.might, hero_level = excluded.hero_level, city_level = excluded.city_level,
       vip = excluded.vip, gold_pass = excluded.gold_pass, hero_avatar = excluded.hero_avatar,
       city_id = excluded.city_id, last_seen = excluded.last_seen`);
    const lastHistory = db.prepare(`SELECT name, might, hero_level, city_level, vip, gold_pass, hero_avatar, role FROM game_player_history
      WHERE clan_id = ? AND player_id = ? ORDER BY captured_at DESC LIMIT 1`);
    const addHistory = db.prepare(`INSERT OR IGNORE INTO game_player_history (clan_id, player_id, captured_at, name, might, hero_level, city_level, vip, gold_pass, hero_avatar, role)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const markGone = db.prepare('UPDATE game_players SET in_clan = 0 WHERE clan_id = ? AND in_clan = 1 AND last_seen < ?');
    db.transaction(() => {
        for (const p of players) {
            const m = roles.get(p.playerId);
            if (!m)
                continue; // only clan members — lookups can return other players
            const row = {
                clanId, playerId: p.playerId, name: p.name, role: m.role, joinedAt: m.joinedAt,
                might: p.might, heroLevel: p.heroLevel, cityLevel: p.cityLevel, vip: p.vip,
                goldPass: p.goldPass ? 1 : 0, heroAvatar: p.heroAvatar, cityId: p.cityId, now,
            };
            upsert.run(row);
            const prev = lastHistory.get(clanId, p.playerId);
            const changed = !prev
                || prev.name !== p.name || prev.might !== p.might || prev.hero_level !== p.heroLevel
                || prev.city_level !== p.cityLevel || prev.vip !== p.vip || prev.gold_pass !== row.goldPass
                || prev.hero_avatar !== p.heroAvatar || prev.role !== m.role;
            if (changed)
                addHistory.run(clanId, p.playerId, now, p.name, p.might, p.heroLevel, p.cityLevel, p.vip, row.goldPass, p.heroAvatar, m.role);
        }
        markGone.run(clanId, now);
    })();
}
/** Upsert gifts by the game's gift id. Returns how many were seen for the first time. */
function saveGifts(clanId, gifts, now = new Date().toISOString()) {
    const db = (0, database_js_1.getDb)();
    const exists = db.prepare('SELECT 1 FROM game_gifts WHERE clan_id = ? AND gift_id = ?');
    const upsert = db.prepare(`INSERT INTO game_gifts
       (clan_id, gift_id, sender_id, sender_name, gift_type, chest_name, source_name, chest_count, tab, arrived_at, expires_at, first_seen, last_seen)
     VALUES (@clanId, @giftId, @senderId, @senderName, @giftType, @chestName, @sourceName, @count, @tab, @arrivedAt, @expiresAt, @now, @now)
     ON CONFLICT (clan_id, gift_id) DO UPDATE SET
       sender_name = excluded.sender_name, chest_name = excluded.chest_name, source_name = excluded.source_name,
       chest_count = excluded.chest_count, last_seen = excluded.last_seen`);
    let fresh = 0;
    db.transaction(() => {
        for (const g of gifts) {
            if (!exists.get(clanId, g.giftId))
                fresh++;
            upsert.run({ clanId, now, ...g });
        }
    })();
    return fresh;
}
/** Insert ledger entries not seen before. Returns how many were new. */
function saveLedger(clanId, entries, now = new Date().toISOString()) {
    const db = (0, database_js_1.getDb)();
    const insert = db.prepare(`INSERT OR IGNORE INTO game_ledger (clan_id, entry_id, player_id, kind, resource, amounts, occurred_at, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
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
function saveTechs(clanId, playerId, techs, now = new Date().toISOString()) {
    const db = (0, database_js_1.getDb)();
    const current = new Map(db.prepare('SELECT tech_id, level FROM game_player_techs WHERE clan_id = ? AND player_id = ?').all(clanId, playerId).map((r) => [r.tech_id, r.level]));
    const upsert = db.prepare(`INSERT INTO game_player_techs (clan_id, player_id, tech_id, level, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (clan_id, player_id, tech_id) DO UPDATE SET level = excluded.level, last_seen = excluded.last_seen`);
    const history = db.prepare('INSERT OR IGNORE INTO game_player_tech_history (clan_id, player_id, tech_id, level, changed_at) VALUES (?, ?, ?, ?, ?)');
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
function saveCitySnapshot(clanId, playerId, gameDate, snap, now = new Date().toISOString()) {
    (0, database_js_1.getDb)().prepare(`INSERT OR REPLACE INTO game_city_snapshots (clan_id, player_id, game_date, captured_at, tech_count, buildings, hero)
     VALUES (?, ?, ?, ?, ?, ?, ?)`).run(clanId, playerId, gameDate, now, snap.techCount, JSON.stringify(snap.buildings), JSON.stringify(snap.hero));
}
/**
 * Store a player's captains; a history row only when a captain is new or its
 * value changed. Returns the number of such changes.
 */
function saveCaptains(clanId, playerId, captains, now = new Date().toISOString()) {
    const db = (0, database_js_1.getDb)();
    const prev = new Map(db.prepare('SELECT captain_id, value FROM game_player_captains WHERE clan_id = ? AND player_id = ?')
        .all(clanId, playerId).map((r) => [r.captain_id, r.value]));
    const upsert = db.prepare(`INSERT INTO game_player_captains (clan_id, player_id, captain_id, value, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (clan_id, player_id, captain_id) DO UPDATE SET value = excluded.value, last_seen = excluded.last_seen`);
    const hist = db.prepare('INSERT OR IGNORE INTO game_player_captain_history (clan_id, player_id, captain_id, value, changed_at) VALUES (?, ?, ?, ?, ?)');
    let changed = 0;
    db.transaction(() => {
        for (const c of captains) {
            upsert.run(clanId, playerId, c.id, c.value, now, now);
            if (prev.get(c.id) !== c.value) {
                hist.run(clanId, playerId, c.id, c.value, now);
                changed++;
            }
        }
    })();
    return changed;
}
/** Players of this clan whose city was already captured for the game day. */
function citySnapshotPlayers(clanId, gameDate) {
    return new Set((0, database_js_1.getDb)().prepare('SELECT player_id FROM game_city_snapshots WHERE clan_id = ? AND game_date = ?').all(clanId, gameDate).map((r) => r.player_id));
}
/**
 * Players whose city has been read today but whose player record changed since
 * (a game_player_history row newer than the last city read — might or hero
 * level moved, which finished research and talents nearly always do). Reading
 * those again on this scan dates a research or talent upgrade to the scan it
 * happened in, instead of to the day.
 */
function cityChangedSinceRead(clanId, gameDate) {
    return new Set((0, database_js_1.getDb)().prepare(`SELECT c.player_id FROM game_city_snapshots c
        WHERE c.clan_id = ? AND c.game_date = ?
          AND EXISTS (SELECT 1 FROM game_player_history h
                       WHERE h.clan_id = c.clan_id AND h.player_id = c.player_id AND h.captured_at > c.captured_at)`).all(clanId, gameDate).map((r) => r.player_id));
}
/** Upsert map objects by the game's object id. Returns how many were new. */
function saveMapObjects(clanId, objects, now = new Date().toISOString()) {
    const db = (0, database_js_1.getDb)();
    const exists = db.prepare('SELECT 1 FROM game_map_objects WHERE clan_id = ? AND object_id = ?');
    const upsert = db.prepare(`INSERT INTO game_map_objects (clan_id, object_id, object_type, object_name, level, realm, x, y, owner_id, expires_at, first_seen, last_seen)
     VALUES (@clanId, @objectId, @type, @name, @level, @realm, @x, @y, @ownerId, @expiresAt, @now, @now)
     ON CONFLICT (clan_id, object_id) DO UPDATE SET level = excluded.level, expires_at = excluded.expires_at, last_seen = excluded.last_seen`);
    let fresh = 0;
    db.transaction(() => {
        for (const o of objects) {
            if (!exists.get(clanId, o.objectId))
                fresh++;
            upsert.run({ clanId, now, ...o });
        }
    })();
    return fresh;
}
/** Keep a raw game reply (gzip of its decoded JSON) once per game day. */
function saveRawSnapshot(clanId, kind, refId, gameDate, value, now = new Date().toISOString()) {
    (0, database_js_1.getDb)().prepare(`INSERT OR REPLACE INTO game_raw_snapshots (clan_id, kind, ref_id, game_date, captured_at, payload) VALUES (?, ?, ?, ?, ?, ?)`).run(clanId, kind, refId, gameDate, now, (0, zlib_1.gzipSync)(JSON.stringify(value)));
}
function hasRawSnapshot(clanId, kind, refId, gameDate) {
    return !!(0, database_js_1.getDb)().prepare('SELECT 1 FROM game_raw_snapshots WHERE clan_id = ? AND kind = ? AND ref_id = ? AND game_date = ?')
        .get(clanId, kind, refId, gameDate);
}
function recentCaptureRuns(clanId, limit = 20) {
    return (0, database_js_1.getDb)()
        .prepare(`SELECT id, clan_id, started_at, finished_at, ok, error, members, gift_entries, new_gifts, ledger_new, duration_ms
         FROM game_capture_runs WHERE clan_id = ? ORDER BY id DESC LIMIT ?`)
        .all(clanId, limit).map((r) => ({
        id: r.id,
        clanId: r.clan_id,
        startedAt: r.started_at,
        finishedAt: r.finished_at ?? null,
        ok: r.ok === 1,
        error: r.error ?? null,
        members: r.members ?? null,
        giftEntries: r.gift_entries ?? null,
        newGifts: r.new_gifts ?? null,
        ledgerNew: r.ledger_new ?? null,
        durationMs: r.duration_ms ?? null,
    }));
}
//# sourceMappingURL=game-protocol-repo.js.map