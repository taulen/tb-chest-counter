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
import { loadGameNames } from '../game-protocol/static-data.js';
import { parseClanRecord, parseLedger, parsePlayers, type PlayerRecord } from '../game-protocol/messages.js';
import {
  finishCaptureRun,
  loadScanComparisonInputs,
  saveGifts,
  saveLedger,
  savePlayers,
  saveScanComparison,
  startCaptureRun,
  type NamedGift,
} from '../data/repositories/game-protocol-repo.js';
import { compareGifts } from '../game-protocol/compare.js';

const log = childLogger('game-protocol');

/** Player lookups per request; the game client itself asks for ~90 at a time. */
const PLAYER_BATCH = 100;

export interface GameProtocolOutcome {
  ok: boolean;
  members?: number;
  giftEntries?: number;
  newGifts?: number;
  ledgerNew?: number;
  error?: string;
}

export async function runGameProtocolCapture(clanId: number): Promise<GameProtocolOutcome> {
  const started = Date.now();
  const runId = startCaptureRun(clanId);
  try {
    const names = await loadGameNames();
    const client = await GameClient.connect({
      storageStatePath: clanStorageStatePath(clanId),
      deviceFile: path.join(clanDataDir(clanId), 'game-device.json'),
    });
    noteSessionHealthy(clanId, 'the game capture signed in with the saved session');
    const record = parseClanRecord(await client.clanRecord());
    if (!record || !record.members.length) {
      throw new Error(`the game returned no member list for clan ${client.clanId} — is the account still in the clan?`);
    }

    const players: PlayerRecord[] = [];
    const ids = record.members.map((m) => m.playerId);
    for (let i = 0; i < ids.length; i += PLAYER_BATCH) {
      players.push(...parsePlayers(await client.players(ids.slice(i, i + PLAYER_BATCH))));
    }
    const byId = new Map(players.map((p) => [p.playerId, p]));

    // Senders outside the member list (left since sending) still need a name.
    const strangers = [...new Set(record.gifts.map((g) => g.senderId).filter((id) => !byId.has(id)))];
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
    const ledger = parseLedger(await client.ledger(record.clanId));

    savePlayers(clanId, record.members, players);
    const newGifts = saveGifts(clanId, gifts);
    const ledgerNew = saveLedger(clanId, ledger);
    const unnamed = gifts.filter((g) => !g.chestName).length;

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
      `(${newGifts} new${unnamed ? `, ${unnamed} with no name yet` : ''}), ${ledgerNew} new ledger entries ` +
      `in ${Date.now() - started} ms`,
    );
    return outcome;
  } catch (err) {
    const error = String(err instanceof Error ? err.message : err);
    finishCaptureRun(runId, { ok: false, error, durationMs: Date.now() - started });
    if (err instanceof SessionLoggedOutError) {
      // A definite logout is the same signal the scan's auth check acts on.
      noteSessionLoggedOut(clanId, 'saved Total Battle session is logged out (seen by the game capture)');
    } else {
      log.warn({ noAlert: true }, `Clan #${clanId} game capture failed (the scan is unaffected): ${error}`);
    }
    return { ok: false, error };
  }
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
