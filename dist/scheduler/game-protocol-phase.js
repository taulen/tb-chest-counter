"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CITY_PARSERS = exports.WrongClanLoginError = void 0;
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
const scan_account_repo_js_1 = require("../data/repositories/scan-account-repo.js");
const session_health_js_1 = require("./session-health.js");
const static_data_js_1 = require("../game-protocol/static-data.js");
const messages_js_1 = require("../game-protocol/messages.js");
const event_read_js_1 = require("./event-read.js");
const olympus_read_js_1 = require("./olympus-read.js");
const olympus_js_1 = require("../game-protocol/olympus.js");
const map_plan_js_1 = require("./map-plan.js");
const ancients_js_1 = require("../game-protocol/ancients.js");
const game_event_repo_js_1 = require("../data/repositories/game-event-repo.js");
const game_clan_repo_js_1 = require("../data/repositories/game-clan-repo.js");
const game_protocol_repo_js_1 = require("../data/repositories/game-protocol-repo.js");
const member_sync_js_1 = require("../game-protocol/member-sync.js");
const artifacts_js_1 = require("../game-protocol/artifacts.js");
const equipment_js_1 = require("../game-protocol/equipment.js");
const game_day_js_1 = require("../utils/game-day.js");
const request_gap_js_1 = require("../utils/request-gap.js");
const tech_trees_js_1 = require("../game-protocol/tech-trees.js");
const log = (0, logger_js_1.childLogger)('game-protocol');
/** The saved login signed in to a different game clan than the one this clan was read as before. */
class WrongClanLoginError extends Error {
    constructor(message) {
        super(message);
        this.name = 'WrongClanLoginError';
    }
}
exports.WrongClanLoginError = WrongClanLoginError;
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
            // The account this clan is scanned with: a login that now signs in as
            // another one stops before any token is presented (client.ts).
            expectSuid: (0, scan_account_repo_js_1.getClanScanAccount)(clanId),
            deviceFile: path_1.default.join((0, clan_paths_js_1.clanDataDir)(clanId), 'game-device.json'),
        });
        (0, session_health_js_1.noteSessionHealthy)(clanId, 'the game capture signed in with the saved session');
        const clanFrame = await client.clanRecord();
        const record = (0, messages_js_1.parseClanRecord)(clanFrame);
        if (!record || !record.members.length) {
            throw new Error(`the game returned no member list for clan ${client.clanId} — is the account still in the clan?`);
        }
        // A login that signs in to ANOTHER game clan is never scanned as this one:
        // nothing is written, the clan is flagged for a new login. A clan's game id
        // never changes. Nov 17 2026: SK7's saved login signed in as SIK's account
        // and two scans wrote SIK's members, chats and research into SK7.
        const known = (0, game_clan_repo_js_1.getClanInfo)(clanId);
        if (known && known.gameClanId !== record.clanId) {
            throw new WrongClanLoginError(`the saved login signs in to [${record.tag}] ${record.name} (game clan ${record.clanId}, account ${client.suid || 'unknown'}), `
                + `not this clan's [${known.tag}] ${known.name} (game clan ${known.gameClanId}) — log in again with this clan's account`);
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
                `${sync.renamed} renamed, ${sync.departed} left)`;
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
        else if (err instanceof WrongClanLoginError || err instanceof client_js_1.WrongAccountError) {
            // Same remedy as a logout: a fresh login with the right account.
            (0, session_health_js_1.noteSessionLoggedOut)(clanId, error);
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
// heroEquipment (Nov 2026): the hero's gear — field 9's entry id 1 — was left
// out; one re-read of the archive gives it history from the first archived read
// without touching the captains' equipment history already stored.
// dragon (Nov 2026): field 26's evolution stage and name — the archived days'
// snapshots get them, so the profile and the timeline need no new read.
// heroEntry (Nov 2026): the hero's own field-9 entry (level, XP) was stored only
// from live reads, so most heroes had no XP bar until their next daily read; the
// archive fills it now, newest read winning, first archived read as first seen.
// titles (Nov 2026): field 21, the titles a player holds (game-protocol/titles.ts)
// — the player record carries them every scan from now on; the archive gives
// them history from the first archived read, with each grant's event id.
exports.CITY_PARSERS = { artifacts: 1, equipment: 1, heroEquipment: 1, dragon: 1, heroEntry: 1, titles: 1 };
const HERO_ONLY = new Set([equipment_js_1.HERO_ENTRY_ID]);
/** Artifacts (field 14) and the hero's and captains' equipment (fields 9 + 10) of one city read. */
function saveCityGear(clanId, playerId, city, names, at, only) {
    let changed = 0;
    // A reply without effects / items is malformed, not "nothing worn" — skip it
    // rather than mark everything benched or undressed.
    if ((!only || only.has('artifacts')) && city.effects.length && names.artifacts) {
        changed += (0, game_protocol_repo_js_1.saveArtifacts)(clanId, playerId, (0, artifacts_js_1.artifactsFromEffects)(city.effects, names.artifacts), at);
    }
    const allGear = !only || only.has('equipment');
    if ((allGear || only?.has('heroEquipment')) && city.items.length) {
        const wearers = city.captains.filter((c) => c.id === equipment_js_1.HERO_ENTRY_ID || names.captains?.[String(c.id)]);
        changed += (0, game_protocol_repo_js_1.saveCaptainEquipment)(clanId, playerId, (0, equipment_js_1.captainEquipment)(wearers, city.items), at, allGear ? undefined : HERO_ONLY);
    }
    return changed;
}
/**
 * A Vault of the Ancients goes up by itself within 8–10 map squares of the
 * city of the player who raised it (the user, Nov 20 2026).
 */
const VAULT_RADIUS = 10;
/**
 * How far back a vault still counts as this run's: it stands 24 h at most,
 * and the next Ancients run is days away.
 */
const VAULT_RUN_LOOKBACK_MS = 30 * 3600_000;
/** Keep searching this long after Ancients' Treasure ends: a vault raised in its last minutes. */
const VAULT_SEARCH_GRACE_SEC = 2 * 3600;
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
/** Clans per 15200 request (the game itself asks for a ranking list's 100 at once). */
const SUMMARY_BATCH = 100;
/**
 * Every clan ranking of the kingdom (23, each kind of CLAN_RANKING_KINDS), the
 * listed clans' tag, name, logo and members (15200, one request per 100 clans
 * across all lists), stored as the latest list per kind plus this clan's rank
 * and value. Returns the lists read, by kind.
 */
async function collectRankings(clanId, d, now, ask) {
    const lists = new Map();
    for (const kind of messages_js_1.CLAN_RANKING_KINDS) {
        const list = await ask(`ranking ${kind}`, async () => (0, messages_js_1.parseClanRanking)(await d.client.clanRanking(kind)));
        if (list?.length)
            lists.set(kind, [...list].sort((a, b) => b.value - a.value));
    }
    if (!lists.size)
        return lists;
    const ids = [...new Set([...lists.values()].flatMap((l) => l.map((e) => e.clanId)))];
    const summaries = new Map();
    for (let i = 0; i < ids.length; i += SUMMARY_BATCH) {
        const batch = await ask('clan names', async () => (0, messages_js_1.parseClanSummaries)(await d.client.clanSummaries(ids.slice(i, i + SUMMARY_BATCH))));
        for (const s of batch ?? [])
            summaries.set(s.clanId, s);
    }
    const own = d.record.clanId;
    for (const [kind, list] of lists) {
        const entries = list.map((e) => {
            const s = summaries.get(e.clanId);
            return {
                clanId: e.clanId,
                value: e.value,
                tag: s?.tag ?? '',
                name: s?.name ?? '',
                logo: s?.logo ?? null,
                members: s?.members ?? null,
                memberLimit: s?.memberLimit ?? null,
            };
        });
        const at = list.findIndex((e) => e.clanId === own);
        (0, game_clan_repo_js_1.saveClanRanking)(clanId, d.gameDate, kind, entries, { rank: at < 0 ? null : at + 1, value: at < 0 ? null : list[at].value }, now);
    }
    return lists;
}
/**
 * The clan itself, every scan (Clan page): the Clan Capital (research, treasury,
 * position), might and wealth points (25), help points (14003), the medals
 * (28001), the kingdom's clan rankings (23, every kind, with the listed
 * clans' names and logos from 15200) — the read-only requests the
 * game sends whenever its clan window opens. Each one is isolated; whatever was
 * read is stored, a stats row per scan. Returns a summary for the log line.
 */
/**
 * Event standings, every scan: the events the account's realm runs (24001)
 * and, for each running one, its "Clan members" tab (38003) — the requests
 * the client sends when the event window opens, read-only. No per-event code:
 * whatever runs is read and stored per run (type, run, occurrence), titled
 * from T44. An event without a clan-members tab answers nothing or empty and
 * is skipped. Rise of the Ancients also reads its window header (38000:
 * summons left), and every read gets a row (v123) — event-read.ts. Raw replies
 * are archived (kinds 'event' / 'event_progress', one per run per game day) so
 * a field decoded later can be re-read. Between scans, event-poller.ts reads
 * a running Rise of the Ancients again on the session this scan leaves.
 */
async function collectEvents(clanId, d, now) {
    const listFrame = await d.client.eventList(d.client.clanId || d.record.clanId, d.client.realmId);
    (0, game_protocol_repo_js_1.saveRawSnapshot)(clanId, 'event_list', 0, d.gameDate, listFrame.body, now);
    const nowSec = Math.floor(Date.now() / 1000);
    const running = (0, messages_js_1.parseEventList)(listFrame).filter((e) => (0, messages_js_1.isEventRunning)(e, nowSec));
    const treasure = running.some((e) => e.type === ancients_js_1.ANCIENTS_TREASURE_EVENT_TYPE);
    let read = 0;
    let rows = 0;
    let moved = 0;
    let summons = '';
    for (const e of running) {
        const meta = d.names.events?.[`${e.type},${e.run}`];
        try {
            const got = await (0, event_read_js_1.readEventStandings)(clanId, d.client, { eventType: e.type, run: e.run, occurrence: e.occurrence }, {
                now, gameDate: d.gameDate, source: 'scan', pause,
                entry: { e, code: meta?.code ?? '', title: meta?.title ?? '' },
            });
            read++;
            if (got) {
                rows += got.rows;
                moved += got.moved;
                if (got.summonsLeft !== null)
                    summons = `, Tin Man summons left ${got.summonsLeft}${got.summonsMax !== null ? ` of ${got.summonsMax}` : ''}`;
            }
            if (e.type === olympus_js_1.OLYMPUS_EVENT_TYPE) {
                await pause();
                const note = await (0, olympus_read_js_1.readOlympusMatchup)(clanId, d.client, { eventType: e.type, run: e.run, occurrence: e.occurrence }, {
                    now, gameDate: d.gameDate, pause, ownClanId: d.client.clanId || d.record.clanId,
                }).catch((err) => `olympus matchup failed: ${String(err)}`);
                summons += `, ${note}`;
            }
        }
        catch {
            // Not every event has a clan-members tab; nothing to keep.
        }
        await pause();
    }
    return { note: `events: ${running.length} running, ${read} read, ${rows} member rows (${moved} moved)${summons}`, treasure };
}
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
        logo: rec.logo,
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
    const rankings = await collectRankings(clanId, d, now, ask);
    const wealthList = rankings.get(RANKING_WEALTH);
    (0, game_clan_repo_js_1.saveClanStats)(clanId, d.gameDate, {
        members: rec.members.length,
        memberLimit: rec.memberLimit,
        // The clan record's own figure; message 25 carries the same number.
        might: rec.might ?? stats?.might ?? null,
        wealth: stats?.wealth ?? null,
        helpPoints: border?.helpPoints ?? null,
        wealthRank: wealthList?.length ? (0, messages_js_1.rankIn)(wealthList, rec.clanId) : null,
        raw,
    }, now);
    return `clan: ${techChanges} research changes, ${rankings.size} rankings${notes.length ? ` (${notes.join('; ')})` : ''}`;
}
/**
 * The map around members' cities (map-plan.ts decides which tiles): members'
 * own tiles every scan (shield, burning — and most vaults); while vaults are
 * being raised, the reach of every member still without one, dropped as each
 * vault turns up; each standing member vault's tile, for its "last seen".
 * Keeps vaults and member-owned objects on those tiles (game_map_objects) and
 * members' city state. Nothing further out: the 3×3 ring read every scan
 * until Nov 20 2026 found one member-owned object in 3½ days (a Mimic Chest).
 *
 * `treasure`: Ancients' Treasure is on (this scan's event list); null = the
 * list couldn't be read, so search to be safe. Searching also starts when the
 * game's run ended under VAULT_SEARCH_GRACE_SEC ago, or when a vault nobody
 * had seen turns up on the tiles read anyway.
 */
async function readMapPass(clanId, d, now, treasure) {
    const nowMs = Date.parse(now);
    const nowSec = Math.floor(nowMs / 1000);
    const memberIds = new Set(d.record.members.map((m) => m.playerId));
    // This run's vaults so far: whose are found, and which still stood at the last pass.
    const known = (0, game_protocol_repo_js_1.vaultsSeenSince)(clanId, new Date(nowMs - VAULT_RUN_LOOKBACK_MS).toISOString());
    const knownIds = new Set(known.map((v) => v.objectId));
    const lastPass = (0, game_protocol_repo_js_1.lastMapPassAt)(clanId);
    const mine = known.filter((v) => v.ownerId !== null && memberIds.has(v.ownerId));
    const track = mine
        .filter((v) => v.x !== null && v.y !== null)
        .filter((v) => (v.expiresAt === null || v.expiresAt > nowSec) && (lastPass === null || v.lastSeen >= lastPass))
        .map((v) => (0, messages_js_1.tileOf)(v.x, v.y));
    const lastTreasure = (0, game_event_repo_js_1.listRunsOfType)(clanId, ancients_js_1.ANCIENTS_TREASURE_EVENT_TYPE)[0];
    const inGrace = lastTreasure?.endsAt != null
        && (lastTreasure.startsAt ?? 0) <= nowSec && nowSec <= lastTreasure.endsAt + VAULT_SEARCH_GRACE_SEC;
    const search = treasure !== false || inGrace;
    const own = new Set();
    const reach = new Map();
    for (const m of d.record.members) {
        const pos = d.byId.get(m.playerId)?.position;
        if (!pos || pos[0] !== d.client.realmId)
            continue;
        own.add((0, messages_js_1.tileOf)(pos[1], pos[2]));
        reach.set(m.playerId, (0, messages_js_1.tilesWithin)(pos[1], pos[2], VAULT_RADIUS));
    }
    const plan = new map_plan_js_1.TilePlan({
        own,
        track,
        reach,
        found: mine.map((v) => v.ownerId),
        search,
    });
    const rows = new Map();
    const cities = new Map();
    let requests = 0;
    for (let batch = plan.next(TILE_BATCH); batch.length; batch = plan.next(TILE_BATCH)) {
        const frame = await d.client.mapTiles(batch);
        requests++;
        plan.markRead(batch);
        for (const o of (0, messages_js_1.parseMapObjects)(frame)) {
            const name = d.names.objects[String(o.type)] ?? '';
            const vault = /vault/i.test(name);
            if (!vault && !(o.ownerId !== null && memberIds.has(o.ownerId)))
                continue;
            rows.set(o.objectId, { objectId: o.objectId, type: o.type, name, level: o.level, realm: o.realm, x: o.x, y: o.y, ownerId: o.ownerId, expiresAt: o.expiresAt });
            if (!vault)
                continue;
            if (o.ownerId !== null && memberIds.has(o.ownerId))
                plan.markFound(o.ownerId);
            // A vault nobody had seen: vaults are going up — look for the rest.
            if (!knownIds.has(o.objectId))
                plan.startSearch();
        }
        for (const c of (0, messages_js_1.parseMapCities)(frame)) {
            if (memberIds.has(c.ownerId))
                cities.set(c.ownerId, { playerId: c.ownerId, shielded: c.shielded, burning: c.burning });
        }
        await pause();
    }
    const fresh = (0, game_protocol_repo_js_1.saveMapObjects)(clanId, [...rows.values()], now);
    const statusChanges = (0, game_protocol_repo_js_1.saveCityStatuses)(clanId, [...cities.values()], now);
    const shielded = [...cities.values()].filter((c) => c.shielded).length;
    const burning = [...cities.values()].filter((c) => c.burning).length;
    const vaults = plan.isSearching ? `vault search on, ${plan.stillSearching} members without one` : 'vault search off';
    return `${rows.size} vaults/member objects on ${plan.readCount} tiles in ${requests} requests (${fresh} new; ${vaults}`
        + `${track.length ? `; ${track.length} standing tracked` : ''}); `
        + `${cities.size} member cities: ${shielded} shielded, ${burning} burning (${statusChanges} changed)`;
}
/**
 * Collect what we don't display yet but want history of — each part isolated,
 * so one failing never costs the others or the capture:
 *   - daily: every member's city (research + hero talents, buildings, hero),
 *     the raw clan record, and every clan-owned object (Clan Capital) raw;
 *   - every cycle: the map around members' cities (readMapPass).
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
    // Whether Ancients' Treasure (vault day) is on, from this scan's event
    // list; null when the list couldn't be read — the map pass then searches.
    let treasure = null;
    try {
        const events = await collectEvents(clanId, d, now);
        treasure = events.treasure;
        parts.push(events.note);
    }
    catch (err) {
        parts.push(`events failed: ${String(err)}`);
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
                if (due.has('dragon') && city.dragon.level !== null)
                    (0, game_protocol_repo_js_1.updateCityDragon)(clanId, raw.refId, raw.gameDate, city.dragon);
                if (due.has('heroEntry')) {
                    const hero = city.captains.find((c) => c.id === equipment_js_1.HERO_ENTRY_ID);
                    if (hero)
                        rows += (0, game_protocol_repo_js_1.saveHeroEntryFromArchive)(clanId, raw.refId, hero, raw.capturedAt);
                }
                if (due.has('titles') && city.titles)
                    rows += (0, game_protocol_repo_js_1.saveTitles)(clanId, raw.refId, city.titles, raw.capturedAt);
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
            const captains = city.captains.filter((c) => c.id === equipment_js_1.HERO_ENTRY_ID || d.names.captains?.[String(c.id)]);
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
                    (0, game_protocol_repo_js_1.saveCitySnapshot)(clanId, p.playerId, d.gameDate, { techCount: Object.keys(city.techs).length, buildings: city.buildings, dragon: city.dragon }, now);
                    // Field 9 also holds the hero (id 1, no T75 row): kept for its level
                    // and XP (no history row); otherwise named captains only.
                    const captains = city.captains.filter((c) => c.id === equipment_js_1.HERO_ENTRY_ID || d.names.captains?.[String(c.id)]);
                    if (captains.length)
                        changed += (0, game_protocol_repo_js_1.saveCaptains)(clanId, p.playerId, captains, now);
                    // The artifacts the line-up captains wear (field 14) and every
                    // captain's equipment (fields 9 + 10).
                    changed += saveCityGear(clanId, p.playerId, city, d.names, now);
                    // Its titles (field 21): the player record gave them this scan
                    // already; this adds each grant's event id.
                    if (city.titles)
                        (0, game_protocol_repo_js_1.saveTitles)(clanId, p.playerId, city.titles, now);
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
        parts.push(await readMapPass(clanId, d, now, treasure));
    }
    catch (err) {
        parts.push(`map pass failed: ${String(err)}`);
    }
    return parts.join('; ');
}
//# sourceMappingURL=game-protocol-phase.js.map