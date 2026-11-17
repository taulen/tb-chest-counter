/**
 * Game protocol capture — the parallel run.
 *
 * Before each clan's OCR scan, read what the game server itself reports for
 * that clan and store it (migration v102):
 *
 *   - the clan record: members (role, joined) and BOTH gift tabs, read before
 *     the scan claims anything, so each scan can be compared gift by gift;
 *   - every member's player record: name, might, hero level, city level, VIP,
 *     Gold Pass, current hero;
 *   - the Clan Capital ledger (~two weeks, stored by entry id).
 *
 * Contract, same as the post-scan phases: this never throws out of its call
 * site, never touches the OCR tables or the scan state, and never decides a
 * clan needs re-authentication — the scan that follows is the authority on
 * that. A failure is a logged, recorded no-op and the next cycle tries again.
 *
 * It runs BEFORE the clan's browser is launched: a direct login takes over the
 * account's game session, and the scan's own fresh navigation then takes it
 * back. See docs/game-protocol.md.
 */
import path from 'path';
import { childLogger } from '../utils/logger.js';
import { clanDataDir, clanStorageStatePath } from '../config/clan-paths.js';
import { GameClient, SessionLoggedOutError } from '../game-protocol/client.js';
import { noteSessionHealthy, noteSessionLoggedOut } from './session-health.js';
import { loadGameNames, type GameNames } from '../game-protocol/static-data.js';
import type { Frame } from '../game-protocol/codec.js';
import {
  parseCityRecord,
  parseClanRecord,
  parseLedger,
  parseMapObjects,
  parsePlayers,
  tileOf,
  type ClanRecord,
  type LedgerEntry,
  type PlayerRecord,
} from '../game-protocol/messages.js';
import {
  citySnapshotPlayers,
  finishCaptureRun,
  hasRawSnapshot,
  loadScanComparisonInputs,
  saveCitySnapshot,
  saveGifts,
  saveLedger,
  saveMapObjects,
  savePlayers,
  saveRawSnapshot,
  saveScanComparison,
  saveTechs,
  startCaptureRun,
  type MapObjectRow,
  type NamedGift,
} from '../data/repositories/game-protocol-repo.js';
import { compareGifts } from '../game-protocol/compare.js';
import { syncMembersFromGame } from '../game-protocol/member-sync.js';
import { currentGameDate } from '../utils/game-day.js';

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

export async function runGameProtocolCapture(
  clanId: number,
  opts: { rolloverUtcHour: number },
): Promise<GameProtocolOutcome & { data?: CaptureData }> {
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

    savePlayers(clanId, record.members, players);
    const newGifts = saveGifts(clanId, gifts);
    const ledgerNew = saveLedger(clanId, ledger);
    const unnamed = gifts.filter((g) => !g.chestName).length;
    const gameDate = currentGameDate(opts.rolloverUtcHour);

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
    const extras = await collectExtras(clanId, data, clanFrame);

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
      `${syncNote}; ${extras} — in ${Date.now() - started} ms`,
    );
    return { ...outcome, data };
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
/** Map tiles per cycle (members' city tiles + their neighbours). */
const MAX_TILES_PER_CYCLE = 60;
const TILE_BATCH = 9;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    if (!hasRawSnapshot(clanId, 'clan_record', 0, d.gameDate)) {
      saveRawSnapshot(clanId, 'clan_record', 0, d.gameDate, clanFrame.body, now);
      let objects = 0;
      for (const id of d.record.objects) {
        if (hasRawSnapshot(clanId, 'clan_object', id, d.gameDate)) continue;
        saveRawSnapshot(clanId, 'clan_object', id, d.gameDate, (await d.client.city(id)).body, now);
        objects++;
        await pause(100);
      }
      parts.push(`clan record + ${objects} clan objects archived`);
    }
  } catch (err) {
    parts.push(`clan archive failed: ${String(err)}`);
  }

  try {
    const done = citySnapshotPlayers(clanId, d.gameDate);
    const todo = d.record.members
      .map((m) => d.byId.get(m.playerId))
      .filter((p): p is PlayerRecord => !!p && p.cityId !== null && !done.has(p.playerId))
      .slice(0, MAX_CITIES_PER_CYCLE);
    let changed = 0;
    for (const p of todo) {
      try {
        const city = parseCityRecord(await d.client.city(p.cityId as number));
        if (city) {
          changed += saveTechs(clanId, p.playerId, city.techs, now);
          saveCitySnapshot(clanId, p.playerId, d.gameDate, { techCount: Object.keys(city.techs).length, buildings: city.buildings, hero: city.hero }, now);
        }
      } catch {
        // One unreadable city never stops the rest; it is retried next cycle.
      }
      await pause(100);
    }
    if (todo.length) parts.push(`${todo.length} cities read (${changed} research/talent changes)`);
  } catch (err) {
    parts.push(`city pass failed: ${String(err)}`);
  }

  try {
    const tiles = new Set<number>();
    for (const m of d.record.members) {
      const pos = d.byId.get(m.playerId)?.position;
      if (!pos || pos[0] !== d.client.realmId) continue;
      for (const dx of [-20, 0, 20]) for (const dy of [-20, 0, 20]) tiles.add(tileOf(pos[1] + dx, pos[2] + dy));
    }
    const list = [...tiles].filter((t) => t >= 0).slice(0, MAX_TILES_PER_CYCLE);
    const memberIds = new Set(d.record.members.map((m) => m.playerId));
    const rows: MapObjectRow[] = [];
    for (let i = 0; i < list.length; i += TILE_BATCH) {
      for (const o of parseMapObjects(await d.client.mapTiles(list.slice(i, i + TILE_BATCH)))) {
        const name = d.names.objects[String(o.type)] ?? '';
        if (!/vault/i.test(name) && !(o.ownerId !== null && memberIds.has(o.ownerId))) continue;
        rows.push({ objectId: o.objectId, type: o.type, name, level: o.level, realm: o.realm, x: o.x, y: o.y, ownerId: o.ownerId, expiresAt: o.expiresAt });
      }
      await pause(100);
    }
    const fresh = saveMapObjects(clanId, rows, now);
    parts.push(`${rows.length} vaults/member objects on ${list.length} tiles (${fresh} new)`);
  } catch (err) {
    parts.push(`map pass failed: ${String(err)}`);
  }
  return parts.join('; ');
}

/**
 * After a scan: compare its OCR rows with the gift list the game reported just
 * before it, per tab, store the result and log one `[game-vs-ocr]` line.
 * Read-only towards the OCR tables; never throws.
 */
export function compareScanWithGameCapture(clanId: number, sessionId: number): void {
  try {
    const inputs = loadScanComparisonInputs(clanId, sessionId);
    if (!inputs) return;
    const expand = (rows: typeof inputs.gifts, tab: number) =>
      rows.filter((g) => g.tab === tab).flatMap((g) => Array.from({ length: g.count }, () => g));
    const parts: string[] = [];
    for (const [tab, label, ocr] of [[1, 'gifts', inputs.chestRows], [2, 'triumphal', inputs.triumphalRows]] as const) {
      const c = compareGifts(expand(inputs.gifts, tab), ocr, inputs.captureEpoch);
      saveScanComparison(clanId, sessionId, inputs.runId, tab, c);
      parts.push(
        `${label}: game ${c.game} · OCR ${c.ocr} · matched ${c.matched} · misreads ${c.misreads} · ` +
        `OCR-only ${c.ocrOnly} (+${c.ocrLate} late) · game-only ${c.gameOnly}`,
      );
    }
    log.info(`[game-vs-ocr] clan #${clanId} session ${sessionId} — ${parts.join(' | ')}`);
  } catch (err) {
    log.warn({ noAlert: true }, `[game-vs-ocr] comparison failed for clan #${clanId} session ${sessionId}: ${String(err)}`);
  }
}
