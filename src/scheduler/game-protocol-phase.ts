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
import path from 'path';
import { childLogger } from '../utils/logger.js';
import { clanDataDir, clanStorageStatePath } from '../config/clan-paths.js';
import { GameClient, SessionLoggedOutError } from '../game-protocol/client.js';
import { noteSessionHealthy, noteSessionLoggedOut } from './session-health.js';
import { loadGameNames, type GameNames } from '../game-protocol/static-data.js';
import type { Frame, Wire } from '../game-protocol/codec.js';
import {
  parseCapitalBorder,
  parseCityRecord,
  parseClanCapital,
  parseClanMedals,
  parseClanRanking,
  parseClanRecord,
  parseClanStats,
  parseLedger,
  parseMapCities,
  parseMapObjects,
  parsePlayers,
  plainWire,
  rankIn,
  splitCityReply,
  tileOf,
  type ClanRecord,
  type LedgerEntry,
  type PlayerRecord,
} from '../game-protocol/messages.js';
import {
  hasClanTechs,
  latestArchivedClanObject,
  saveClanInfo,
  saveClanMedals,
  saveClanStats,
  saveClanTechs,
  saveClanTreasury,
} from '../data/repositories/game-clan-repo.js';
import {
  citySnapshotPlayers,
  cityChangedSinceRead,
  playersWithCaptains,
  rawCitiesMissingData,
  pruneRawSnapshots,
  saveCaptains,
  finishCaptureRun,
  hasRawSnapshot,
  saveCitySnapshot,
  saveGifts,
  saveLedger,
  saveCityStatuses,
  saveMapObjects,
  savePlayers,
  saveRawSnapshot,
  saveTechs,
  startCaptureRun,
  type MapObjectRow,
  type NamedGift,
} from '../data/repositories/game-protocol-repo.js';
import { syncMembersFromGame } from '../game-protocol/member-sync.js';
import { currentGameDate } from '../utils/game-day.js';
import { READ_GAP, requestGap } from '../utils/request-gap.js';
import { loadTechTrees } from '../game-protocol/tech-trees.js';

const log = childLogger('game-protocol');

/** Player lookups per request; the game client itself asks for ~90 at a time. */
const PLAYER_BATCH = 100;

export interface GameProtocolOutcome {
  ok: boolean;
  /** The saved website session is logged out (already recorded as needing re-auth). */
  loggedOut?: boolean;
  members?: number;
  giftEntries?: number;
  newGifts?: number;
  ledgerNew?: number;
  error?: string;
}

/** What a capture read, for callers that act on it (the protocol scan claims on the same session). */
export interface CaptureData {
  client: GameClient;
  names: GameNames;
  record: ClanRecord;
  byId: Map<number, PlayerRecord>;
  gifts: NamedGift[];
  ledger: LedgerEntry[];
  gameDate: string;
  /** game player id → our member id (after member sync). */
  memberIds: Map<number, number>;
}

/**
 * The part of a scan that has to come before claiming: sign in, the clan
 * record (members + gifts), player records, the ledger, member sync. The
 * slower collection (cities, map tiles, raw archive — collectCaptureExtras)
 * runs after the chests are opened, so a daily city pass or a backfill never
 * holds them up.
 */
export async function runGameProtocolCapture(
  clanId: number,
  opts: { rolloverUtcHour: number },
): Promise<GameProtocolOutcome & { data?: CaptureData; clanFrame?: Frame }> {
  const started = Date.now();
  const runId = startCaptureRun(clanId);
  try {
    const names = await loadGameNames();
    const client = await GameClient.connect({
      storageStatePath: clanStorageStatePath(clanId),
      deviceFile: path.join(clanDataDir(clanId), 'game-device.json'),
    });
    noteSessionHealthy(clanId, 'the game capture signed in with the saved session');
    const clanFrame = await client.clanRecord();
    const record = parseClanRecord(clanFrame);
    if (!record || !record.members.length) {
      throw new Error(`the game returned no member list for clan ${client.clanId} — is the account still in the clan?`);
    }

    const players: PlayerRecord[] = [];
    const ids = record.members.map((m) => m.playerId);
    for (let i = 0; i < ids.length; i += PLAYER_BATCH) {
      players.push(...parsePlayers(await client.players(ids.slice(i, i + PLAYER_BATCH))));
    }
    const byId = new Map(players.map((p) => [p.playerId, p]));

    const ledger = parseLedger(await client.ledger(record.clanId));

    // Gift senders and ledger players outside the member list (left since)
    // still need a name.
    const strangers = [...new Set([...record.gifts.map((g) => g.senderId), ...ledger.map((e) => e.playerId)])]
      .filter((id) => !byId.has(id));
    for (let i = 0; i < strangers.length; i += PLAYER_BATCH) {
      for (const p of parsePlayers(await client.players(strangers.slice(i, i + PLAYER_BATCH)))) byId.set(p.playerId, p);
    }

    const gifts: NamedGift[] = record.gifts.map((g) => ({
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

    const gameDate = currentGameDate(opts.rolloverUtcHour);
    savePlayers(clanId, record.members, players, new Date().toISOString(), gameDate);
    const newGifts = saveGifts(clanId, gifts);
    const ledgerNew = saveLedger(clanId, ledger);
    const unnamed = gifts.filter((g) => !g.chestName).length;

    // Members: link to game ids, exact names, roles, seen, might/hero snapshot, departures.
    let memberIds = new Map<number, number>();
    let syncNote = '';
    try {
      const sync = syncMembersFromGame(clanId, record.members, players, gameDate);
      memberIds = sync.memberIds;
      syncNote = `members linked ${sync.linked} (+${sync.newlyLinked} matched, +${sync.created} new, ` +
        `${sync.renamed} renamed, ${sync.departed} left${sync.mergedByRule ? `, ${sync.mergedByRule} alts by merge rule` : ''})`;
    } catch (err) {
      log.warn({ noAlert: true }, `Clan #${clanId} member sync failed (capture data kept): ${String(err)}`);
    }

    const data: CaptureData = { client, names, record, byId, gifts, ledger, gameDate, memberIds };

    const outcome = {
      ok: true,
      members: record.members.length,
      giftEntries: gifts.length,
      newGifts,
      ledgerNew,
    };
    finishCaptureRun(runId, { ...outcome, gameClanId: record.clanId, namesVersion: names.version, durationMs: Date.now() - started });
    log.info(
      `Clan #${clanId} game capture: ${record.members.length} members, ${gifts.length} gift entries ` +
      `(${newGifts} new${unnamed ? `, ${unnamed} with no name yet` : ''}), ${ledgerNew} new ledger entries; ` +
      `${syncNote} — in ${Date.now() - started} ms`,
    );
    return { ...outcome, data, clanFrame };
  } catch (err) {
    const error = String(err instanceof Error ? err.message : err);
    finishCaptureRun(runId, { ok: false, error, durationMs: Date.now() - started });
    if (err instanceof SessionLoggedOutError) {
      // A definite logout is the same signal the scan's auth check acts on.
      noteSessionLoggedOut(clanId, 'saved Total Battle session is logged out (seen by the game capture)');
    } else {
      log.warn({ noAlert: true }, `Clan #${clanId} game capture failed: ${error}`);
    }
    return { ok: false, error, loggedOut: err instanceof SessionLoggedOutError };
  }
}

/** Cities per cycle: a big clan's daily research pass spreads over a couple of cycles. */
const MAX_CITIES_PER_CYCLE = 120;
/** Game days of raw city replies kept (game_raw_snapshots kind 'city'). */
const RAW_CITY_DAYS = 60;
/** Cities (or clan objects) per 601 request; the game client itself asks for 19 in one. */
const CITY_BATCH = 20;
/** Map tiles per cycle (members' city tiles + their neighbours). */
const MAX_TILES_PER_CYCLE = 60;
const TILE_BATCH = 9;
// Varied, short gaps between reads (utils/request-gap.ts), never one fixed tick.
const pause = (): Promise<void> => requestGap(READ_GAP[0], READ_GAP[1]);

/**
 * The collection a scan does after its chests are opened, on the same game
 * session: cities, map tiles, the raw archive. Never throws; logs one line.
 */
export async function collectCaptureExtras(clanId: number, data: CaptureData, clanFrame: Frame): Promise<void> {
  const started = Date.now();
  try {
    const extras = await collectExtras(clanId, data, clanFrame);
    log.info(`Clan #${clanId} game collection: ${extras} — in ${Date.now() - started} ms`);
  } catch (err) {
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
async function collectClan(clanId: number, d: CaptureData, now: string): Promise<string> {
  const rec = d.record;
  const notes: string[] = [];
  const capitalId = rec.capitalId;
  let position: [number, number, number] | null = null;
  let techChanges = 0;

  if (capitalId !== null) {
    // The archive first: research read before this table existed becomes the
    // baseline, dated to when it was read, so the live read below records
    // anything that moved since as a change.
    if (!hasClanTechs(clanId)) {
      const raw = latestArchivedClanObject(clanId, capitalId);
      const old = raw ? parseClanCapital({ type: 601, seq: 0, head: [601, 0], body: raw.body as Wire[], children: [], events: [] }) : null;
      if (raw && old && Object.keys(old.techs).length) {
        saveClanTechs(clanId, old.techs, raw.capturedAt);
        notes.push('research filled from the archive');
      }
    }
    try {
      const capital = parseClanCapital(await d.client.city(capitalId));
      if (capital) {
        position = capital.position;
        if (Object.keys(capital.techs).length) techChanges = saveClanTechs(clanId, capital.techs, now);
        if (Object.keys(capital.treasury).length) saveClanTreasury(clanId, d.gameDate, capital.treasury, now);
      }
    } catch (err) {
      notes.push(`capital unreadable: ${String(err instanceof Error ? err.message : err)}`);
    }
  }
  saveClanInfo(clanId, {
    gameClanId: rec.clanId,
    tag: rec.tag,
    name: rec.name,
    foundedAt: rec.foundedAt,
    language: rec.language,
    capitalId,
    position,
  }, now);

  const raw: Record<string, unknown> = { record: plainWire(rec.extra) };
  const ask = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      notes.push(`${label} unreadable: ${String(err instanceof Error ? err.message : err)}`);
      return null;
    }
  };
  const stats = await ask('clan stats', async () => parseClanStats(await d.client.clanStats(rec.clanId)));
  if (stats) raw.stats = stats.raw;
  const border = capitalId !== null ? await ask('help points', async () => parseCapitalBorder(await d.client.capitalBorder(capitalId))) : null;
  if (border) raw.border = border.raw;
  const medals = await ask('medals', async () => parseClanMedals(await d.client.clanMedals(rec.clanId)));
  if (medals?.length) saveClanMedals(clanId, medals, now);
  const ranking = await ask('wealth ranking', async () => parseClanRanking(await d.client.clanRanking(RANKING_WEALTH)));

  saveClanStats(clanId, d.gameDate, {
    members: rec.members.length,
    memberLimit: rec.memberLimit,
    // The clan record's own figure; message 25 carries the same number.
    might: rec.might ?? stats?.might ?? null,
    wealth: stats?.wealth ?? null,
    helpPoints: border?.helpPoints ?? null,
    wealthRank: ranking?.length ? rankIn(ranking, rec.clanId) : null,
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
async function collectExtras(clanId: number, d: CaptureData, clanFrame: Frame): Promise<string> {
  const parts: string[] = [];
  const now = new Date().toISOString();

  try {
    // Rebuilds only when the game published a new version (one small request otherwise).
    await loadTechTrees();
  } catch (err) {
    parts.push(`tech trees unavailable: ${String(err)}`);
  }

  try {
    if (!hasRawSnapshot(clanId, 'clan_record', 0, d.gameDate)) {
      saveRawSnapshot(clanId, 'clan_record', 0, d.gameDate, clanFrame.body, now);
      let objects = 0;
      // All of the clan's objects in one request (two past CITY_BATCH), the way
      // the game client reads them.
      const wanted = d.record.objects.filter((id) => !hasRawSnapshot(clanId, 'clan_object', id, d.gameDate));
      for (let i = 0; i < wanted.length; i += CITY_BATCH) {
        for (const c of splitCityReply(await d.client.cities(wanted.slice(i, i + CITY_BATCH)))) {
          saveRawSnapshot(clanId, 'clan_object', c.cityId, d.gameDate, c.body, now);
          objects++;
        }
        await pause();
      }
      parts.push(`clan record + ${objects} clan objects archived`);
    }
  } catch (err) {
    parts.push(`clan archive failed: ${String(err)}`);
  }

  try {
    parts.push(await collectClan(clanId, d, now));
  } catch (err) {
    parts.push(`clan pass failed: ${String(err)}`);
  }

  try {
    // What was already read comes first: a member with an archived city reply
    // but no research or captains stored (a parser fixed or added since — the
    // research parser missed players without tech 1215 until Nov 17 2026) is
    // filled from that reply, dated to when it was read. No request.
    let refilled = 0;
    for (const raw of rawCitiesMissingData(clanId)) {
      const city = parseCityRecord({ type: 601, seq: 0, head: [601, 0], body: raw.body as Wire[], children: [], events: [] });
      if (!city) continue;
      if (Object.keys(city.techs).length) saveTechs(clanId, raw.playerId, city.techs, raw.capturedAt);
      const captains = city.captains.filter((c) => d.names.captains?.[String(c.id)]);
      if (captains.length) saveCaptains(clanId, raw.playerId, captains, raw.capturedAt);
      refilled++;
    }
    if (refilled) parts.push(`${refilled} filled from archived city replies`);
  } catch (err) {
    parts.push(`archive re-read failed: ${String(err)}`);
  }

  try {
    // Every member once a game day, plus — every scan — anyone whose might or
    // hero level moved since their city was last read, so a finished research
    // or talent is dated to the scan that saw it (history keeps every change).
    const done = citySnapshotPlayers(clanId, d.gameDate);
    const changedSince = cityChangedSinceRead(clanId, d.gameDate);
    // Also anyone with no captains stored yet: a one-time backfill so the
    // Captains tab fills on the next scan instead of after the next reset.
    const withCaptains = playersWithCaptains(clanId);
    const todo = d.record.members
      .map((m) => d.byId.get(m.playerId))
      .filter((p): p is PlayerRecord => !!p && p.cityId !== null
        && (!done.has(p.playerId) || changedSince.has(p.playerId) || !withCaptains.has(p.playerId)))
      .slice(0, MAX_CITIES_PER_CYCLE);
    let changed = 0;
    let failed = 0;
    let requests = 0;
    let firstError = '';
    const fail = (err: unknown): void => {
      // One unreadable city never stops the rest; it is retried next cycle.
      // Counted in the log line — a silent skip hid missing data before.
      failed++;
      if (!firstError) firstError = String(err instanceof Error ? err.message : err);
    };
    // CITY_BATCH cities per 601 request, as the game client asks for a clan's
    // objects — 120 cities used to be 120 requests.
    for (let i = 0; i < todo.length; i += CITY_BATCH) {
      const batch = todo.slice(i, i + CITY_BATCH);
      const bodies = new Map<number, Wire[]>();
      const singleFailed = new Set<number>();
      try {
        requests++;
        for (const c of splitCityReply(await d.client.cities(batch.map((p) => p.cityId as number)))) bodies.set(c.cityId, c.body);
      } catch {
        // The batch as a whole failed: read its cities one by one, so one bad
        // city costs only itself.
        for (const p of batch) {
          try {
            requests++;
            bodies.set(p.cityId as number, (await d.client.city(p.cityId as number)).body);
          } catch (err) {
            singleFailed.add(p.cityId as number);
            fail(err);
          }
          await pause();
        }
      }
      for (const p of batch) {
        const body = bodies.get(p.cityId as number);
        if (!body) {
          if (!singleFailed.has(p.cityId as number)) fail(`city ${p.cityId} missing from the reply`);
          continue;
        }
        try {
          const city = parseCityRecord({ type: 601, seq: 0, head: [601, 0], body, children: [], events: [] });
          if (!city) {
            fail(`city ${p.cityId} unreadable`);
            continue;
          }
          // The whole reply too (the day's latest read): a field decoded later
          // — captains were in it all along — can be re-parsed from this
          // instead of waiting for every city to be read again.
          saveRawSnapshot(clanId, 'city', p.playerId, d.gameDate, body, now);
          changed += saveTechs(clanId, p.playerId, city.techs, now);
          saveCitySnapshot(clanId, p.playerId, d.gameDate, { techCount: Object.keys(city.techs).length, buildings: city.buildings, hero: city.hero }, now);
          // Field 9 also holds the hero (id 1, no T75 row): keep named captains.
          const captains = city.captains.filter((c) => d.names.captains?.[String(c.id)]);
          if (captains.length) changed += saveCaptains(clanId, p.playerId, captains, now);
        } catch (err) {
          fail(err);
        }
      }
      await pause();
    }
    if (todo.length) {
      parts.push(`${todo.length} cities read in ${requests} requests (${changed} research/talent/captain changes${failed ? `; ${failed} failed: ${firstError}` : ''})`);
    }
    // ~5 KB per city per day: keep RAW_CITY_DAYS of them, not every day forever.
    const keepFrom = new Date(Date.parse(`${d.gameDate}T00:00:00Z`) - RAW_CITY_DAYS * 86_400_000).toISOString().slice(0, 10);
    pruneRawSnapshots('city', keepFrom);
  } catch (err) {
    parts.push(`city pass failed: ${String(err)}`);
  }

  try {
    // Every member's own tile first, so the cap never drops a member's city
    // (its shield and burning state come from it), then the tiles around.
    const own = new Set<number>();
    const around = new Set<number>();
    for (const m of d.record.members) {
      const pos = d.byId.get(m.playerId)?.position;
      if (!pos || pos[0] !== d.client.realmId) continue;
      own.add(tileOf(pos[1], pos[2]));
      for (const dx of [-20, 0, 20]) for (const dy of [-20, 0, 20]) around.add(tileOf(pos[1] + dx, pos[2] + dy));
    }
    const list = [...new Set([...own, ...around])].filter((t) => t >= 0).slice(0, Math.max(MAX_TILES_PER_CYCLE, own.size));
    const memberIds = new Set(d.record.members.map((m) => m.playerId));
    const rows: MapObjectRow[] = [];
    const cities = new Map<number, { playerId: number; shielded: boolean; burning: boolean }>();
    for (let i = 0; i < list.length; i += TILE_BATCH) {
      const frame = await d.client.mapTiles(list.slice(i, i + TILE_BATCH));
      for (const o of parseMapObjects(frame)) {
        const name = d.names.objects[String(o.type)] ?? '';
        if (!/vault/i.test(name) && !(o.ownerId !== null && memberIds.has(o.ownerId))) continue;
        rows.push({ objectId: o.objectId, type: o.type, name, level: o.level, realm: o.realm, x: o.x, y: o.y, ownerId: o.ownerId, expiresAt: o.expiresAt });
      }
      for (const c of parseMapCities(frame)) {
        if (memberIds.has(c.ownerId)) cities.set(c.ownerId, { playerId: c.ownerId, shielded: c.shielded, burning: c.burning });
      }
      await pause();
    }
    const fresh = saveMapObjects(clanId, rows, now);
    const statusChanges = saveCityStatuses(clanId, [...cities.values()], now);
    const shielded = [...cities.values()].filter((c) => c.shielded).length;
    const burning = [...cities.values()].filter((c) => c.burning).length;
    parts.push(
      `${rows.length} vaults/member objects on ${list.length} tiles (${fresh} new); ` +
      `${cities.size} member cities: ${shielded} shielded, ${burning} burning (${statusChanges} changed)`,
    );
  } catch (err) {
    parts.push(`map pass failed: ${String(err)}`);
  }
  return parts.join('; ');
}

