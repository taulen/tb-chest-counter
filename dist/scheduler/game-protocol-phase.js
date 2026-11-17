"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CITY_PARSERS = void 0;
exports.runGameProtocolCapture = runGameProtocolCapture;
exports.collectCaptureExtras = collectCaptureExtras;
/**
 * Game protocol capture — the first half of every clan's scan.
 *
 * Reads what the game server itself reports for the clan and stores it
 * (migration v102):
 *
 *   - the clan record: members (role, joined) and BOTH gift tabs, read before
 *     the scan claims anything;
 *   - every member's player record: name, might, hero level, city level, VIP,
 *     Gold Pass, current hero;
 *   - the Clan Capital ledger (~two weeks, stored by entry id).
 *
 * The scan (protocol-scan.ts) then records and claims the gifts on the same
 * session. This never throws out of its call site: a failure is a logged,
 * recorded outcome and the next cycle tries again. A definite logout flags the
 * clan for re-authentication. See docs/game-protocol.md.
 */
const path_1 = __importDefault(require("path"));
const logger_js_1 = require("../utils/logger.js");
const clan_paths_js_1 = require("../config/clan-paths.js");
const client_js_1 = require("../game-protocol/client.js");
const session_health_js_1 = require("./session-health.js");
const static_data_js_1 = require("../game-protocol/static-data.js");
const messages_js_1 = require("../game-protocol/messages.js");
const game_clan_repo_js_1 = require("../data/repositories/game-clan-repo.js");
const game_protocol_repo_js_1 = require("../data/repositories/game-protocol-repo.js");
const member_sync_js_1 = require("../game-protocol/member-sync.js");
const artifacts_js_1 = require("../game-protocol/artifacts.js");
const equipment_js_1 = require("../game-protocol/equipment.js");
const game_day_js_1 = require("../utils/game-day.js");
const request_gap_js_1 = require("../utils/request-gap.js");
const tech_trees_js_1 = require("../game-protocol/tech-trees.js");
const log = (0, logger_js_1.childLogger)('game-protocol');
/** Player lookups per request; the game client itself asks for ~90 at a time. */
const PLAYER_BATCH = 100;
/**
 * The part of a scan that has to come before claiming: sign in, the clan
 * record (members + gifts), player records, the ledger, member sync. The
 * slower collection (cities, map tiles, raw archive — collectCaptureExtras)
 * runs after the chests are opened, so a daily city pass or a backfill never
 * holds them up.
 */
async function runGameProtocolCapture(clanId, opts) {
    const started = Date.now();
    const runId = (0, game_protocol_repo_js_1.startCaptureRun)(clanId);
    try {
        const names = await (0, static_data_js_1.loadGameNames)();
        const client = await client_js_1.GameClient.connect({
            storageStatePath: (0, clan_paths_js_1.clanStorageStatePath)(clanId),
            deviceFile: path_1.default.join((0, clan_paths_js_1.clanDataDir)(clanId), 'game-device.json'),
        });
        (0, session_health_js_1.noteSessionHealthy)(clanId, 'the game capture signed in with the saved session');
        const clanFrame = await client.clanRecord();
        const record = (0, messages_js_1.parseClanRecord)(clanFrame);
        if (!record || !record.members.length) {
            throw new Error(`the game returned no member list for clan ${client.clanId} — is the account still in the clan?`);
        }
        const players = [];
        const ids = record.members.map((m) => m.playerId);
        for (let i = 0; i < ids.length; i += PLAYER_BATCH) {
            players.push(...(0, messages_js_1.parsePlayers)(await client.players(ids.slice(i, i + PLAYER_BATCH))));
        }
        const byId = new Map(players.map((p) => [p.playerId, p]));
        const ledger = (0, messages_js_1.parseLedger)(await client.ledger(record.clanId));
        // Gift senders and ledger players outside the member list (left since)
        // still need a name.
        const strangers = [...new Set([...record.gifts.map((g) => g.senderId), ...ledger.map((e) => e.playerId)])]
            .filter((id) => !byId.has(id));
        for (let i = 0; i < strangers.length; i += PLAYER_BATCH) {
            for (const p of (0, messages_js_1.parsePlayers)(await client.players(strangers.slice(i, i + PLAYER_BATCH))))
                byId.set(p.playerId, p);
        }
        const gifts = record.gifts.map((g) => ({
            giftId: g.giftId,
            senderId: g.senderId,
            senderName: byId.get(g.senderId)?.name ?? '',
            giftType: g.giftType,
            chestName: names.gifts[g.giftType]?.chest ?? '',
            sourceName: names.gifts[g.giftType]?.source ?? '',
            count: g.count,
            tab: g.tab,
            arrivedAt: g.arrivedAt,
            expiresAt: g.expiresAt,
        }));
        const gameDate = (0, game_day_js_1.currentGameDate)(opts.rolloverUtcHour);
        (0, game_protocol_repo_js_1.savePlayers)(clanId, record.members, players, new Date().toISOString(), gameDate);
        const newGifts = (0, game_protocol_repo_js_1.saveGifts)(clanId, gifts);
        const ledgerNew = (0, game_protocol_repo_js_1.saveLedger)(clanId, ledger);
        const unnamed = gifts.filter((g) => !g.chestName).length;
        // Members: link to game ids, exact names, roles, seen, might/hero snapshot, departures.
        let memberIds = new Map();
        let syncNote = '';
        try {
            const sync = (0, member_sync_js_1.syncMembersFromGame)(clanId, record.members, players, gameDate);
            memberIds = sync.memberIds;
            syncNote = `members linked ${sync.linked} (+${sync.newlyLinked} matched, +${sync.created} new, ` +
                `${sync.renamed} renamed, ${sync.departed} left${sync.mergedByRule ? `, ${sync.mergedByRule} alts by merge rule` : ''})`;
        }
        catch (err) {
            log.warn({ noAlert: true }, `Clan #${clanId} member sync failed (capture data kept): ${String(err)}`);
        }
        const data = { client, names, record, byId, gifts, ledger, gameDate, memberIds };
        const outcome = {
            ok: true,
            members: record.members.length,
            giftEntries: gifts.length,
            newGifts,
            ledgerNew,
        };
        (0, game_protocol_repo_js_1.finishCaptureRun)(runId, { ...outcome, gameClanId: record.clanId, namesVersion: names.version, durationMs: Date.now() - started });
        log.info(`Clan #${clanId} game capture: ${record.members.length} members, ${gifts.length} gift entries ` +
            `(${newGifts} new${unnamed ? `, ${unnamed} with no name yet` : ''}), ${ledgerNew} new ledger entries; ` +
            `${syncNote} — in ${Date.now() - started} ms`);
        return { ...outcome, data, clanFrame };
    }
    catch (err) {
        const error = String(err instanceof Error ? err.message : err);
        (0, game_protocol_repo_js_1.finishCaptureRun)(runId, { ok: false, error, durationMs: Date.now() - started });
        if (err instanceof client_js_1.SessionLoggedOutError) {
            // A definite logout is the same signal the scan's auth check acts on.
            (0, session_health_js_1.noteSessionLoggedOut)(clanId, 'saved Total Battle session is logged out (seen by the game capture)');
        }
        else {
            log.warn({ noAlert: true }, `Clan #${clanId} game capture failed: ${error}`);
        }
        return { ok: false, error, loggedOut: err instanceof client_js_1.SessionLoggedOutError };
    }
}
/** Cities per cycle: a big clan's daily research pass spreads over a couple of cycles. */
const MAX_CITIES_PER_CYCLE = 120;
/** Game days of raw city replies kept (game_raw_snapshots kind 'city'). */
const RAW_CITY_DAYS = 60;
/** Cities (or clan objects) per 601 request; the game client itself asks for 19 in one. */
const CITY_BATCH = 20;
/**
 * City-reply parsers added after replies were already archived, with their
 * version. The archive of raw city replies is replayed through each once per
 * version per clan (game_parse_markers) — bump a version when that parsing
 * changes, and every archived read is re-parsed on the next scan.
 */
exports.CITY_PARSERS = { artifacts: 1, equipment: 1 };
/** Artifacts (field 14) and captain equipment (fields 9 + 10) of one city read. */
function saveCityGear(clanId, playerId, city, names, at, only) {
    let changed = 0;
    // A reply without effects / items is malformed, not "nothing worn" — skip it
    // rather than mark everything benched or undressed.
    if ((!only || only.has('artifacts')) && city.effects.length && names.artifacts) {
        changed += (0, game_protocol_repo_js_1.saveArtifacts)(clanId, playerId, (0, artifacts_js_1.artifactsFromEffects)(city.effects, names.artifacts), at);
    }
    if ((!only || only.has('equipment')) && city.items.length) {
        const captains = city.captains.filter((c) => names.captains?.[String(c.id)]);
        changed += (0, game_protocol_repo_js_1.saveCaptainEquipment)(clanId, playerId, (0, equipment_js_1.captainEquipment)(captains, city.items), at);
    }
    return changed;
}
/** Map tiles per cycle (members' city tiles + their neighbours). */
const MAX_TILES_PER_CYCLE = 60;
const TILE_BATCH = 9;
// Varied, short gaps between reads (utils/request-gap.ts), never one fixed tick.
const pause = () => (0, request_gap_js_1.requestGap)(request_gap_js_1.READ_GAP[0], request_gap_js_1.READ_GAP[1]);
/**
 * The collection a scan does after its chests are opened, on the same game
 * session: cities, map tiles, the raw archive. Never throws; logs one line.
 */
async function collectCaptureExtras(clanId, data, clanFrame) {
    const started = Date.now();
    try {
        const extras = await collectExtras(clanId, data, clanFrame);
        log.info(`Clan #${clanId} game collection: ${extras} — in ${Date.now() - started} ms`);
    }
    catch (err) {
        log.warn({ noAlert: true }, `Clan #${clanId} game collection failed: ${String(err)}`);
    }
}
/** Ranking kind of message 23 that is wealth points (verified against the in-game list). */
const RANKING_WEALTH = 7;
/**
 * The clan itself, every scan (Clan page): the Clan Capital (research, treasury,
 * position), might and wealth points (25), help points (14003), the medals
 * (28001) and the kingdom's wealth ranking (23) — the read-only requests the
 * game sends whenever its clan window opens. Each one is isolated; whatever was
 * read is stored, a stats row per scan. Returns a summary for the log line.
 */
async function collectClan(clanId, d, now) {
    const rec = d.record;
    const notes = [];
    const capitalId = rec.capitalId;
    let position = null;
    let techChanges = 0;
    if (capitalId !== null) {
        // The archive first: research read before this table existed becomes the
        // baseline, dated to when it was read, so the live read below records
        // anything that moved since as a change.
        if (!(0, game_clan_repo_js_1.hasClanTechs)(clanId)) {
            const raw = (0, game_clan_repo_js_1.latestArchivedClanObject)(clanId, capitalId);
            const old = raw ? (0, messages_js_1.parseClanCapital)({ type: 601, seq: 0, head: [601, 0], body: raw.body, children: [], events: [] }) : null;
            if (raw && old && Object.keys(old.techs).length) {
                (0, game_clan_repo_js_1.saveClanTechs)(clanId, old.techs, raw.capturedAt);
                notes.push('research filled from the archive');
            }
        }
        try {
            const capital = (0, messages_js_1.parseClanCapital)(await d.client.city(capitalId));
            if (capital) {
                position = capital.position;
                if (Object.keys(capital.techs).length)
                    techChanges = (0, game_clan_repo_js_1.saveClanTechs)(clanId, capital.techs, now);
                if (Object.keys(capital.treasury).length)
                    (0, game_clan_repo_js_1.saveClanTreasury)(clanId, d.gameDate, capital.treasury, now);
            }
        }
        catch (err) {
            notes.push(`capital unreadable: ${String(err instanceof Error ? err.message : err)}`);
        }
    }
    (0, game_clan_repo_js_1.saveClanInfo)(clanId, {
        gameClanId: rec.clanId,
        tag: rec.tag,
        name: rec.name,
        foundedAt: rec.foundedAt,
        language: rec.language,
        capitalId,
        position,
    }, now);
    const raw = { record: (0, messages_js_1.plainWire)(rec.extra) };
    const ask = async (label, fn) => {
        try {
            return await fn();
        }
        catch (err) {
            notes.push(`${label} unreadable: ${String(err instanceof Error ? err.message : err)}`);
            return null;
        }
    };
    const stats = await ask('clan stats', async () => (0, messages_js_1.parseClanStats)(await d.client.clanStats(rec.clanId)));
    if (stats)
        raw.stats = stats.raw;
    const border = capitalId !== null ? await ask('help points', async () => (0, messages_js_1.parseCapitalBorder)(await d.client.capitalBorder(capitalId))) : null;
    if (border)
        raw.border = border.raw;
    const medals = await ask('medals', async () => (0, messages_js_1.parseClanMedals)(await d.client.clanMedals(rec.clanId)));
    if (medals?.length)
        (0, game_clan_repo_js_1.saveClanMedals)(clanId, medals, now);
    const ranking = await ask('wealth ranking', async () => (0, messages_js_1.parseClanRanking)(await d.client.clanRanking(RANKING_WEALTH)));
    (0, game_clan_repo_js_1.saveClanStats)(clanId, d.gameDate, {
        members: rec.members.length,
        memberLimit: rec.memberLimit,
        // The clan record's own figure; message 25 carries the same number.
        might: rec.might ?? stats?.might ?? null,
        wealth: stats?.wealth ?? null,
        helpPoints: border?.helpPoints ?? null,
        wealthRank: ranking?.length ? (0, messages_js_1.rankIn)(ranking, rec.clanId) : null,
        raw,
    }, now);
    return `clan: ${techChanges} research changes${notes.length ? ` (${notes.join('; ')})` : ''}`;
}
/**
 * Collect what we don't display yet but want history of — each part isolated,
 * so one failing never costs the others or the capture:
 *   - daily: every member's city (research + hero talents, buildings, hero),
 *     the raw clan record, and every clan-owned object (Clan Capital) raw;
 *   - every cycle: vaults and member-owned map objects around members' cities.
 * Returns a short summary for the log line.
 */
async function collectExtras(clanId, d, clanFrame) {
    const parts = [];
    const now = new Date().toISOString();
    try {
        // Rebuilds only when the game published a new version (one small request otherwise).
        await (0, tech_trees_js_1.loadTechTrees)();
    }
    catch (err) {
        parts.push(`tech trees unavailable: ${String(err)}`);
    }
    try {
        if (!(0, game_protocol_repo_js_1.hasRawSnapshot)(clanId, 'clan_record', 0, d.gameDate)) {
            (0, game_protocol_repo_js_1.saveRawSnapshot)(clanId, 'clan_record', 0, d.gameDate, clanFrame.body, now);
            let objects = 0;
            // All of the clan's objects in one request (two past CITY_BATCH), the way
            // the game client reads them.
            const wanted = d.record.objects.filter((id) => !(0, game_protocol_repo_js_1.hasRawSnapshot)(clanId, 'clan_object', id, d.gameDate));
            for (let i = 0; i < wanted.length; i += CITY_BATCH) {
                for (const c of (0, messages_js_1.splitCityReply)(await d.client.cities(wanted.slice(i, i + CITY_BATCH)))) {
                    (0, game_protocol_repo_js_1.saveRawSnapshot)(clanId, 'clan_object', c.cityId, d.gameDate, c.body, now);
                    objects++;
                }
                await pause();
            }
            parts.push(`clan record + ${objects} clan objects archived`);
        }
    }
    catch (err) {
        parts.push(`clan archive failed: ${String(err)}`);
    }
    try {
        parts.push(await collectClan(clanId, d, now));
    }
    catch (err) {
        parts.push(`clan pass failed: ${String(err)}`);
    }
    try {
        // A parser added or changed since the replies were archived replays the
        // whole archive once (oldest read first), so its history starts at the
        // first archived read instead of today. Artifacts (city field 14) were in
        // every archived city reply before they were parsed (Nov 2026). No request.
        const due = new Set(Object.keys(exports.CITY_PARSERS)
            .filter((p) => (0, game_protocol_repo_js_1.getParseMarker)(clanId, p) < exports.CITY_PARSERS[p]));
        // Artifact names come with names.json format 3; without them, wait.
        if (!d.names.artifacts)
            due.delete('artifacts');
        if (due.size) {
            let replies = 0;
            let rows = 0;
            for (const raw of (0, game_protocol_repo_js_1.rawSnapshotsOldestFirst)(clanId, 'city')) {
                const city = (0, messages_js_1.parseCityRecord)({ type: 601, seq: 0, head: [601, 0], body: raw.body, children: [], events: [] });
                if (!city)
                    continue;
                rows += saveCityGear(clanId, raw.refId, city, d.names, raw.capturedAt, due);
                replies++;
            }
            for (const p of due)
                (0, game_protocol_repo_js_1.setParseMarker)(clanId, p, exports.CITY_PARSERS[p]);
            parts.push(`${[...due].join(' + ')} re-read from ${replies} archived city replies (${rows} history rows)`);
        }
    }
    catch (err) {
        parts.push(`city archive replay failed: ${String(err)}`);
    }
    try {
        // What was already read comes first: a member with an archived city reply
        // but no research or captains stored (a parser fixed or added since — the
        // research parser missed players without tech 1215 until Nov 17 2026) is
        // filled from that reply, dated to when it was read. No request.
        let refilled = 0;
        for (const raw of (0, game_protocol_repo_js_1.rawCitiesMissingData)(clanId)) {
            const city = (0, messages_js_1.parseCityRecord)({ type: 601, seq: 0, head: [601, 0], body: raw.body, children: [], events: [] });
            if (!city)
                continue;
            if (Object.keys(city.techs).length)
                (0, game_protocol_repo_js_1.saveTechs)(clanId, raw.playerId, city.techs, raw.capturedAt);
            const captains = city.captains.filter((c) => d.names.captains?.[String(c.id)]);
            if (captains.length)
                (0, game_protocol_repo_js_1.saveCaptains)(clanId, raw.playerId, captains, raw.capturedAt);
            saveCityGear(clanId, raw.playerId, city, d.names, raw.capturedAt);
            refilled++;
        }
        if (refilled)
            parts.push(`${refilled} filled from archived city replies`);
    }
    catch (err) {
        parts.push(`archive re-read failed: ${String(err)}`);
    }
    try {
        // Every member once a game day, plus — every scan — anyone whose might or
        // hero level moved since their city was last read, so a finished research
        // or talent is dated to the scan that saw it (history keeps every change).
        const done = (0, game_protocol_repo_js_1.citySnapshotPlayers)(clanId, d.gameDate);
        const changedSince = (0, game_protocol_repo_js_1.cityChangedSinceRead)(clanId, d.gameDate);
        // Also anyone with no captains stored yet: a one-time backfill so the
        // Captains tab fills on the next scan instead of after the next reset.
        const withCaptains = (0, game_protocol_repo_js_1.playersWithCaptains)(clanId);
        const todo = d.record.members
            .map((m) => d.byId.get(m.playerId))
            .filter((p) => !!p && p.cityId !== null
            && (!done.has(p.playerId) || changedSince.has(p.playerId) || !withCaptains.has(p.playerId)))
            .slice(0, MAX_CITIES_PER_CYCLE);
        let changed = 0;
        let failed = 0;
        let requests = 0;
        let firstError = '';
        const fail = (err) => {
            // One unreadable city never stops the rest; it is retried next cycle.
            // Counted in the log line — a silent skip hid missing data before.
            failed++;
            if (!firstError)
                firstError = String(err instanceof Error ? err.message : err);
        };
        // CITY_BATCH cities per 601 request, as the game client asks for a clan's
        // objects — 120 cities used to be 120 requests.
        for (let i = 0; i < todo.length; i += CITY_BATCH) {
            const batch = todo.slice(i, i + CITY_BATCH);
            const bodies = new Map();
            const singleFailed = new Set();
            try {
                requests++;
                for (const c of (0, messages_js_1.splitCityReply)(await d.client.cities(batch.map((p) => p.cityId))))
                    bodies.set(c.cityId, c.body);
            }
            catch {
                // The batch as a whole failed: read its cities one by one, so one bad
                // city costs only itself.
                for (const p of batch) {
                    try {
                        requests++;
                        bodies.set(p.cityId, (await d.client.city(p.cityId)).body);
                    }
                    catch (err) {
                        singleFailed.add(p.cityId);
                        fail(err);
                    }
                    await pause();
                }
            }
            for (const p of batch) {
                const body = bodies.get(p.cityId);
                if (!body) {
                    if (!singleFailed.has(p.cityId))
                        fail(`city ${p.cityId} missing from the reply`);
                    continue;
                }
                try {
                    const city = (0, messages_js_1.parseCityRecord)({ type: 601, seq: 0, head: [601, 0], body, children: [], events: [] });
                    if (!city) {
                        fail(`city ${p.cityId} unreadable`);
                        continue;
                    }
                    // The whole reply too (the day's latest read): a field decoded later
                    // — captains were in it all along — can be re-parsed from this
                    // instead of waiting for every city to be read again.
                    (0, game_protocol_repo_js_1.saveRawSnapshot)(clanId, 'city', p.playerId, d.gameDate, body, now);
                    changed += (0, game_protocol_repo_js_1.saveTechs)(clanId, p.playerId, city.techs, now);
                    (0, game_protocol_repo_js_1.saveCitySnapshot)(clanId, p.playerId, d.gameDate, { techCount: Object.keys(city.techs).length, buildings: city.buildings, hero: city.hero }, now);
                    // Field 9 also holds the hero (id 1, no T75 row): keep named captains.
                    const captains = city.captains.filter((c) => d.names.captains?.[String(c.id)]);
                    if (captains.length)
                        changed += (0, game_protocol_repo_js_1.saveCaptains)(clanId, p.playerId, captains, now);
                    // The artifacts the line-up captains wear (field 14) and every
                    // captain's equipment (fields 9 + 10).
                    changed += saveCityGear(clanId, p.playerId, city, d.names, now);
                }
                catch (err) {
                    fail(err);
                }
            }
            await pause();
        }
        if (todo.length) {
            parts.push(`${todo.length} cities read in ${requests} requests (${changed} research/talent/captain/artifact changes${failed ? `; ${failed} failed: ${firstError}` : ''})`);
        }
        // ~5 KB per city per day: keep RAW_CITY_DAYS of them, not every day forever.
        const keepFrom = new Date(Date.parse(`${d.gameDate}T00:00:00Z`) - RAW_CITY_DAYS * 86_400_000).toISOString().slice(0, 10);
        (0, game_protocol_repo_js_1.pruneRawSnapshots)('city', keepFrom);
    }
    catch (err) {
        parts.push(`city pass failed: ${String(err)}`);
    }
    try {
        // Every member's own tile first, so the cap never drops a member's city
        // (its shield and burning state come from it), then the tiles around.
        const own = new Set();
        const around = new Set();
        for (const m of d.record.members) {
            const pos = d.byId.get(m.playerId)?.position;
            if (!pos || pos[0] !== d.client.realmId)
                continue;
            own.add((0, messages_js_1.tileOf)(pos[1], pos[2]));
            for (const dx of [-20, 0, 20])
                for (const dy of [-20, 0, 20])
                    around.add((0, messages_js_1.tileOf)(pos[1] + dx, pos[2] + dy));
        }
        const list = [...new Set([...own, ...around])].filter((t) => t >= 0).slice(0, Math.max(MAX_TILES_PER_CYCLE, own.size));
        const memberIds = new Set(d.record.members.map((m) => m.playerId));
        const rows = [];
        const cities = new Map();
        for (let i = 0; i < list.length; i += TILE_BATCH) {
            const frame = await d.client.mapTiles(list.slice(i, i + TILE_BATCH));
            for (const o of (0, messages_js_1.parseMapObjects)(frame)) {
                const name = d.names.objects[String(o.type)] ?? '';
                if (!/vault/i.test(name) && !(o.ownerId !== null && memberIds.has(o.ownerId)))
                    continue;
                rows.push({ objectId: o.objectId, type: o.type, name, level: o.level, realm: o.realm, x: o.x, y: o.y, ownerId: o.ownerId, expiresAt: o.expiresAt });
            }
            for (const c of (0, messages_js_1.parseMapCities)(frame)) {
                if (memberIds.has(c.ownerId))
                    cities.set(c.ownerId, { playerId: c.ownerId, shielded: c.shielded, burning: c.burning });
            }
            await pause();
        }
        const fresh = (0, game_protocol_repo_js_1.saveMapObjects)(clanId, rows, now);
        const statusChanges = (0, game_protocol_repo_js_1.saveCityStatuses)(clanId, [...cities.values()], now);
        const shielded = [...cities.values()].filter((c) => c.shielded).length;
        const burning = [...cities.values()].filter((c) => c.burning).length;
        parts.push(`${rows.length} vaults/member objects on ${list.length} tiles (${fresh} new); ` +
            `${cities.size} member cities: ${shielded} shielded, ${burning} burning (${statusChanges} changed)`);
    }
    catch (err) {
        parts.push(`map pass failed: ${String(err)}`);
    }
    return parts.join('; ');
}
//# sourceMappingURL=game-protocol-phase.js.map