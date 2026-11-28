"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.REPORT_WINDOW_DAYS = void 0;
exports.loadCitadels = loadCitadels;
exports.loadTroopEffects = loadTroopEffects;
exports.reportPlayers = reportPlayers;
exports.reportArmiesFor = reportArmiesFor;
/**
 * Players' armies as their shared battle reports recorded them, for Tools →
 * Citadel and → Stacks: "fill in from a battle report" (docs/battle-reports.md).
 * The bonuses themselves are worked out in the browser (lib/report-bonuses.js),
 * which has the calculators' troops and the citadels' defenders; this sends
 * what the game measured:
 *
 *  - each troop's units and the game's base strength and health (T9);
 *  - its health per unit with every bonus: the stack's pool on the first hit
 *    it took ÷ its units — exact, a full stack's pool is units × unit health;
 *  - its card as the march's own effects add it up (troop-effects.ts: the
 *    report's field-14 effects and running boosts, every strength / health
 *    line aimed at its unit) — the card less one army-wide amount the report
 *    doesn't carry, which the page measures from what the battle shows;
 *  - every strike it made, as the log has it: the damage dealt (capped at what
 *    the target had left), extraA — the part of it that came from "vs"
 *    features (damage × features ÷ (1 + bonus + features): Phoenix I on a
 *    Bear, 26 units or 1, the same 7.01 / 45.375 share) — and extraB, the
 *    damage before the luck when the strike doubled (the simulator's units ×
 *    strength × (1 + bonus + features) to the unit), plus whether it killed
 *    its target (then the damage is only what that took).
 *
 * Whose: a player's battles are the ones they FOUGHT (the march owner — the
 * army whose bonuses these are) and the ones they POSTED (usually their own;
 * a report of someone else's army says whose it is). The dialog opens on the
 * viewer's own players together and lists anyone else on request
 * (reportPlayers): their own players see every clan's shares, anyone else
 * only what was shared in the clan being viewed.
 *
 * Only the last REPORT_WINDOW_DAYS: bonuses change with captains and gear, so
 * an older battle is never what anyone fills in from — and reading every
 * report's summary for every player made the dialog take seconds to open.
 * Tools → Citadel asks for citadel battles only (`targets`: the game's
 * citadels, static-data.ts GameCitadel), each with its level.
 */
const fs_1 = __importDefault(require("fs"));
const zlib_1 = __importDefault(require("zlib"));
const database_js_1 = require("./database.js");
const art_static_js_1 = require("../game-art/art-static.js");
const store_js_1 = require("../game-art/store.js");
const static_data_js_1 = require("../game-protocol/static-data.js");
const battle_report_js_1 = require("../game-protocol/battle-report.js");
const troop_effects_js_1 = require("../game-protocol/troop-effects.js");
const game_player_names_js_1 = require("./game-player-names.js");
/** The game's citadels by T7 id (names build, format 16+); empty when the names can't be read. */
async function loadCitadels() {
    try {
        return (await (0, static_data_js_1.loadGameNames)()).citadels ?? {};
    }
    catch {
        return {};
    }
}
let effectsMemo = null;
/** The newest troop-effects.json the names build wrote (static-data.ts), kept in memory until a newer one appears. */
function loadTroopEffects() {
    const file = (0, static_data_js_1.newestStaticFile)(troop_effects_js_1.TROOP_EFFECTS_FILE);
    if (!file)
        return null;
    const mtimeMs = fs_1.default.statSync(file).mtimeMs;
    if (effectsMemo?.file === file && effectsMemo.mtimeMs === mtimeMs)
        return effectsMemo.table;
    try {
        const table = JSON.parse(fs_1.default.readFileSync(file, 'utf8'));
        if (table.format !== troop_effects_js_1.TROOP_EFFECTS_FORMAT)
            return null;
        effectsMemo = { file, mtimeMs, table };
        return table;
    }
    catch {
        return null;
    }
}
const LIVE = {
    units: () => (0, art_static_js_1.cachedArtUnits)((0, store_js_1.gameArtDir)()),
    objects: async () => (await (0, static_data_js_1.loadGameNames)()).objects,
    citadels: loadCitadels,
    troopEffects: loadTroopEffects,
};
/** How far back the dialog looks. */
exports.REPORT_WINDOW_DAYS = 7;
/**
 * Battles of the dialog: read, with a strike log, fought in the window. The
 * time comes first so the summary's text is only searched for those.
 */
function readable(f) {
    const since = Math.floor((f.nowMs ?? Date.now()) / 1000) - exports.REPORT_WINDOW_DAYS * 86_400;
    const targets = f.targets ?? null;
    const onTarget = targets === null ? '' : targets.length ? `AND r.target_static_id IN (${targets.map(() => '?').join(',')})` : 'AND 0';
    return {
        sql: `r.report_at >= ? AND r.status = 'ok' AND r.kind = 'battle' ${onTarget} AND r.summary LIKE '%"strikes"%'`,
        args: [since, ...(targets ?? [])],
    };
}
/** A player's name: the clan's (member or game), else the game's anywhere, else what they post under. */
function namesFor(clanId, ids) {
    const out = new Map();
    for (const [id, n] of (0, game_player_names_js_1.gamePlayerNames)(clanId, ids))
        if (n.name)
            out.set(id, n.name);
    const db = (0, database_js_1.getDb)();
    for (const id of ids) {
        if (out.has(id))
            continue;
        const g = db.prepare('SELECT name FROM game_players WHERE player_id = ? ORDER BY last_seen DESC LIMIT 1').get(id);
        const s = g ? undefined : db.prepare("SELECT sender_name AS name FROM battle_report_shares WHERE sender_player_id = ? AND sender_name <> '' ORDER BY shared_at DESC LIMIT 1").get(id);
        const name = g?.name ?? s?.name;
        if (name)
            out.set(id, name);
    }
    return out;
}
/**
 * The players the viewer can pick: their own (every clan's shares) and anyone
 * who fought or posted a readable battle shared in `clanId`, each with their
 * battles in the window. Own first, then by name. One pass over the window's
 * shares.
 */
function reportPlayers(clanId, ownIds, filter = {}) {
    const { sql, args } = readable(filter);
    const rows = (0, database_js_1.getDb)().prepare(`SELECT r.entry_id AS e, r.attacker_player_id AS a, s.sender_player_id AS p, s.clan_id AS c
     FROM battle_reports r JOIN battle_report_shares s ON s.entry_id = r.entry_id
     WHERE ${sql}`).all(...args);
    const own = new Set(ownIds);
    const inClan = new Set(rows.filter((r) => r.c === clanId).map((r) => r.e));
    const battles = new Map(ownIds.map((id) => [id, new Set()]));
    const add = (id, e) => {
        // Another player's battles only as shared in this clan; the viewer's own from every clan's.
        if (id === null || (!own.has(id) && !inClan.has(e)))
            return;
        let set = battles.get(id);
        if (!set)
            battles.set(id, (set = new Set()));
        set.add(e);
    };
    for (const r of rows) {
        add(r.a, r.e);
        add(r.p, r.e);
    }
    const names = namesFor(clanId, [...battles.keys()]);
    return [...battles].map(([id, set]) => ({ playerId: id, name: names.get(id) ?? '', battles: set.size, own: own.has(id) }))
        .sort((a, b) => Number(b.own) - Number(a.own) || Number(!a.name) - Number(!b.name) || a.name.localeCompare(b.name));
}
/** The players' readable battles (fought or posted), newest first; `clanId` = only those shared there. */
function battleIds(playerIds, clanId, filter, limit) {
    if (!playerIds.length)
        return [];
    const { sql, args } = readable(filter);
    const ph = playerIds.map(() => '?').join(',');
    return (0, database_js_1.getDb)().prepare(`SELECT r.entry_id FROM battle_reports r
     WHERE ${sql}
       AND (r.attacker_player_id IN (${ph}) OR EXISTS (SELECT 1 FROM battle_report_shares s WHERE s.entry_id = r.entry_id AND s.sender_player_id IN (${ph})))
       AND (? IS NULL OR EXISTS (SELECT 1 FROM battle_report_shares s WHERE s.entry_id = r.entry_id AND s.clan_id = ?))
     ORDER BY r.report_at DESC LIMIT ?`).all(...args, ...playerIds, ...playerIds, clanId, clanId, limit).map((r) => r.entry_id);
}
/**
 * The newest battles with a strike log of one player or several (the
 * viewer's own, together), fought or posted, newest first, in the window.
 * `clanId` limits them to what was shared in that clan (anyone but the
 * viewer's own players); `namesClanId` is the clan whose names are used.
 */
async function reportArmiesFor(players, opts, lookups = LIVE) {
    const ids = battleIds(Array.isArray(players) ? players : [players], opts.clanId, opts, opts.limit ?? 20);
    if (!ids.length)
        return [];
    const db = (0, database_js_1.getDb)();
    const row = db.prepare(`SELECT r.entry_id, r.report_at, r.target_static_id, r.won, r.attacker_player_id, r.summary, r.raw,
            (SELECT s.sender_name FROM battle_report_shares s WHERE s.entry_id = r.entry_id ORDER BY s.shared_at LIMIT 1) AS shared_by
     FROM battle_reports r WHERE r.entry_id = ?`);
    const rows = ids.map((id) => row.get(id));
    const effectsTable = lookups.troopEffects?.() ?? null;
    const units = lookups.units();
    let objects = {};
    try {
        objects = await lookups.objects();
    }
    catch { /* names unavailable: targets go unnamed */ }
    let citadels = {};
    try {
        citadels = (await lookups.citadels?.()) ?? {};
    }
    catch { /* no levels */ }
    const attackerNames = namesFor(opts.namesClanId, [...new Set(rows.map((r) => r.attacker_player_id).filter((p) => p !== null))]);
    const unitOf = (id) => {
        const u = units.get(id);
        return { unit: id, name: u?.name ?? '', strength: u?.strength ?? 0, health: u?.health ?? 0 };
    };
    const out = [];
    for (const r of rows) {
        let s;
        try {
            s = JSON.parse(r.summary);
        }
        catch {
            continue;
        }
        const mine = s.attackers[0];
        if (!mine)
            continue;
        const strikes = s.strikes ?? [];
        // The march's effects and commanders come from the raw report (kept for every report read): the summary predates them.
        let effects = null;
        let led = null;
        if (r.raw) {
            try {
                const side = (0, battle_report_js_1.parseBattleReport)(zlib_1.default.gunzipSync(r.raw))?.attackers[0];
                if (effectsTable)
                    effects = side?.effects ?? null;
                if (side?.commanders.length) {
                    led = { hero: side.commanders.includes(battle_report_js_1.HERO_COMMANDER), captains: side.commanders.filter((c) => c !== battle_report_js_1.HERO_COMMANDER).length };
                }
            }
            catch {
                effects = null;
            }
        }
        const troops = mine.units.map(([unit, count]) => {
            const firstHit = strikes.find((x) => x.targetArmyId === mine.army && x.targetUnit === unit && x.targetCount > 0);
            const own = strikes.filter((x) => x.byAttacker && x.armyId === mine.army && x.unit === unit && x.count > 0);
            return {
                ...unitOf(unit),
                count,
                card: effectsTable && effects?.length ? (0, troop_effects_js_1.troopCard)(effectsTable, effects, unit) : null,
                unitHealth: firstHit ? firstHit.poolBefore / firstHit.targetCount : null,
                strikes: own.map((x) => ({
                    count: x.count, damage: x.damage, extraA: x.extraA, extraB: x.extraB, capped: x.countAfter === 0, target: unitOf(x.targetUnit),
                })),
            };
        });
        out.push({
            entryId: r.entry_id,
            at: new Date(r.report_at * 1000).toISOString(),
            target: {
                staticId: r.target_static_id,
                name: r.target_static_id !== null ? objects[String(r.target_static_id)] ?? '' : '',
                level: r.target_static_id !== null ? citadels[String(r.target_static_id)]?.level ?? null : null,
            },
            won: r.won === 1,
            attacker: { playerId: r.attacker_player_id, name: r.attacker_player_id !== null ? attackerNames.get(r.attacker_player_id) ?? '' : '' },
            led,
            sharedBy: r.shared_by ?? '',
            troops,
        });
    }
    return out;
}
//# sourceMappingURL=report-armies.js.map