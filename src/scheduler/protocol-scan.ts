/**
 * The protocol scan: a clan's chests recorded from the game's own gift list
 * and opened with the game's own claim request — no browser, no OCR, no
 * calibration (docs/game-protocol.md). Runs on the session and data that
 * runGameProtocolCapture just read.
 *
 * Order, chosen so tracking can never be lost:
 *   1. Every gift on both tabs is RECORDED first, keyed by game_gift_id. A gift
 *      a member sent is earned whether or not we open it, and a gift already
 *      recorded (a re-run after a crash, a claim that failed) is never recorded
 *      twice: only `count − rows already carrying its id` rows are added.
 *   2. Then each gift is claimed (15013) and the rewards it gave are kept in
 *      game_claims. A failed claim leaves the gift in the game; the next cycle
 *      records nothing new for it and claims it again.
 *   3. The Clan Capital ledger becomes resource_transactions rows (one per entry,
 *      game_entry_id unique), from the day after the newest OCR-captured row on,
 *      so the switch-over never double-counts a day.
 *
 * Names: the game's names are exact, so no OCR correction runs. Each resolves to
 * the spelling already stored for it when one normalises the same (the OCR read
 * "Lvl 25-29 Vault of the Ancients" where the game says "Level 25–29 …"), so
 * points, merge rules and history keep keying on the names they always had;
 * the clan's chest/source merge rules then apply exactly as on the OCR path.
 */
import { getDb } from '../data/database.js';
import * as chestRepo from '../data/repositories/chest-repo.js';
import * as triumphalChestRepo from '../data/repositories/triumphal-chest-repo.js';
import { applyMergeRulesCached, loadMergeRules } from '../data/repositories/merge-repo.js';
import { getPointsForSourceAt, loadPointSchedule } from '../data/repositories/source-points-repo.js';
import {
  createBatch,
  insertTransactions,
  listResourceTypes,
  UNTRACKED_RESOURCE_SLUGS,
} from '../data/repositories/resource-repo.js';
import { getChestRarity } from '../vision/chest-names.js';
import { normalizeGiftText } from '../game-protocol/compare.js';
import { parseClaimRewards } from '../game-protocol/messages.js';
import { ledgerToRows } from '../game-protocol/ledger-rows.js';
import { makeMemberResolver } from '../game-protocol/member-sync.js';
import type { CaptureData } from './game-protocol-phase.js';
import type { ChestRecord, GiftEntry } from '../models/types.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('protocol-scan');

/** Pause between claims; the game client itself spaces its requests. */
const CLAIM_GAP_MS = 150;
/** Sender name used when the game gave us neither a member link nor a name. */
const UNKNOWN_SENDER = '[Unknown]';

export interface ProtocolScanContext {
  clanId: number;
  sessionId: number;
  rolloverUtcHour: number;
  nextCapturedAt: () => string;
  reportProgress: (message: string) => void;
  incrementLiveChestCount: () => void;
}

export interface ProtocolScanTally {
  /** Gifts-tab chests recorded this run (one entry per chest). */
  gifts: GiftEntry[];
  triumphal: GiftEntry[];
  /** Chests already recorded by an earlier run (re-seen, not re-recorded). */
  alreadyRecorded: number;
  claimed: number;
  claimFailures: number;
  resourceRows: number;
  /** Short notes for the session row (empty when everything went cleanly). */
  warnings: string[];
}

/** Stored spelling for each normalised name, oldest row first. */
function storedNames(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of getDb().prepare(sql).all() as Array<{ v: string }>) {
    const k = normalizeGiftText(r.v);
    if (!out.has(k)) out.set(k, r.v);
  }
  return out;
}

export async function recordAndClaim(ctx: ProtocolScanContext, d: CaptureData): Promise<ProtocolScanTally> {
  const { clanId, sessionId } = ctx;
  const tally: ProtocolScanTally = { gifts: [], triumphal: [], alreadyRecorded: 0, claimed: 0, claimFailures: 0, resourceRows: 0, warnings: [] };
  const memberFor = makeMemberResolver(clanId, d.memberIds);
  const chestMerge = loadMergeRules('chest', clanId);
  const sourceMerge = loadMergeRules('source', clanId);
  const schedule = loadPointSchedule(clanId);
  const chestNames = storedNames('SELECT name AS v FROM chests ORDER BY id');
  const sourceNames = storedNames('SELECT source AS v FROM chest_sources ORDER BY id');
  const stored = (names: Map<string, string>, name: string) => names.get(normalizeGiftText(name)) ?? name;
  const countGift = {
    1: getDb().prepare('SELECT COUNT(*) AS n FROM chest_records WHERE clan_id = ? AND game_gift_id = ?'),
    2: getDb().prepare('SELECT COUNT(*) AS n FROM triumphal_chest_records WHERE clan_id = ? AND game_gift_id = ?'),
  } as const;

  // 1. Record, oldest first so captured_at follows arrival.
  ctx.reportProgress(`Recording ${d.gifts.reduce((n, g) => n + g.count, 0)} chests…`);
  const unnamed = new Set<number>();
  for (const g of [...d.gifts].sort((a, b) => a.arrivedAt - b.arrivedAt)) {
    const tab = g.tab === 2 ? 2 : 1;
    const have = (countGift[tab].get(clanId, g.giftId) as { n: number }).n;
    tally.alreadyRecorded += Math.min(have, g.count);
    const missing = g.count - have;
    if (missing <= 0) continue;

    if (!g.chestName) unnamed.add(g.giftType);
    const chestName = applyMergeRulesCached(chestMerge, stored(chestNames, g.chestName || `Unknown gift ${g.giftType}`));
    const source = applyMergeRulesCached(sourceMerge, stored(sourceNames, g.sourceName));
    const chestType = getChestRarity(chestName) as ChestRecord['chestType'];
    const senderName = g.senderName || d.byId.get(g.senderId)?.name || '';
    const memberId = memberFor(g.senderId, senderName) ?? memberFor(0, UNKNOWN_SENDER);
    if (memberId === null) {
      tally.warnings.push(`gift ${g.giftId}: no member for sender ${g.senderId}`);
      continue;
    }
    const earnedAt = g.arrivedAt * 1000;
    // Triumphals are bookkeeping only — never points. Everything else scores
    // the values in force on the game day it was earned.
    const pointValue = tab === 2 ? 0 : getPointsForSourceAt(schedule, source, chestName, earnedAt);
    for (let i = 0; i < missing; i++) {
      const row = {
        sessionId,
        clanId,
        playerName: senderName || UNKNOWN_SENDER,
        memberId,
        chestName,
        chestType,
        chestSource: source,
        pointValue,
        capturedAt: ctx.nextCapturedAt(),
        earnedAt,
        confidence: 1,
        gameGiftId: g.giftId,
      };
      const inserted = tab === 2 ? triumphalChestRepo.insertChest(row) : chestRepo.insertChest(row);
      if (!inserted) continue;
      const entry: GiftEntry = {
        playerName: row.playerName, chestName, chestType, source, timeLeft: '',
        giftTab: tab === 2 ? 'triumphal' : 'gifts', quantity: 1, confidence: 1,
      };
      if (tab === 2) {
        tally.triumphal.push(entry);
      } else {
        tally.gifts.push(entry);
        ctx.incrementLiveChestCount();
      }
    }
  }
  if (unnamed.size) {
    tally.warnings.push(`gift types without a name in the game data: ${[...unnamed].join(', ')}`);
  }

  // 2. Claim, one gift entry per request so each reward set is attributable.
  const saveClaim = getDb().prepare(
    'INSERT INTO game_claims (clan_id, session_id, gift_id, gift_type, tab, rewards, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  let i = 0;
  for (const g of d.gifts) {
    i++;
    if (i % 10 === 1) ctx.reportProgress(`Opening chests (${i}/${d.gifts.length})…`);
    try {
      const rewards = parseClaimRewards(await d.client.claim({ [g.giftId]: g.count }));
      saveClaim.run(clanId, sessionId, g.giftId, g.giftType, g.tab, JSON.stringify(rewards), new Date().toISOString());
      tally.claimed++;
    } catch (err) {
      tally.claimFailures++;
      if (tally.claimFailures <= 3) log.warn({ noAlert: true }, `Clan #${clanId}: claiming gift ${g.giftId} failed (recorded; retried next cycle): ${String(err)}`);
    }
    await new Promise((r) => setTimeout(r, CLAIM_GAP_MS));
  }
  if (tally.claimFailures) {
    tally.warnings.push(`${tally.claimFailures} of ${d.gifts.length} chest(s) could not be opened; they are recorded and the next scan opens them`);
  }

  // 3. Ledger → resource rows.
  try {
    tally.resourceRows = importLedger(clanId, d, memberFor, ctx.rolloverUtcHour);
  } catch (err) {
    tally.warnings.push(`Clan Capital ledger import failed: ${String(err)}`);
  }

  log.info(
    `Clan #${clanId} protocol scan: recorded ${tally.gifts.length} chests + ${tally.triumphal.length} triumphal ` +
    `(${tally.alreadyRecorded} already recorded), opened ${tally.claimed}/${d.gifts.length} gift entries, ` +
    `${tally.resourceRows} resource rows`,
  );
  return tally;
}

/** Ledger entries newer than the clan's OCR-captured rows → resource_transactions. Returns rows written. */
function importLedger(
  clanId: number,
  d: CaptureData,
  memberFor: (playerId: number, name: string) => number | null,
  rolloverUtcHour: number,
): number {
  if (!d.ledger.length) return 0;
  const db = getDb();
  const afterDate = (db.prepare(
    'SELECT MAX(transaction_date) AS d FROM resource_transactions WHERE clan_id = ? AND game_entry_id IS NULL',
  ).get(clanId) as { d: string | null }).d ?? '';
  const minEntry = Math.min(...d.ledger.map((e) => e.entryId));
  const have = new Set((db.prepare(
    'SELECT game_entry_id AS id FROM resource_transactions WHERE clan_id = ? AND game_entry_id >= ?',
  ).all(clanId, minEntry) as Array<{ id: number }>).map((r) => r.id));

  const { rows, skipped } = ledgerToRows(d.ledger, d.names, listResourceTypes(), {
    afterDate,
    rolloverUtcHour,
    untrackedSlugs: UNTRACKED_RESOURCE_SLUGS,
  });
  const fresh = rows.filter((r) => !have.has(r.entryId));
  const unexpected = Object.entries(skipped).filter(([why]) => /unmapped|several|kind /.test(why));
  if (unexpected.length) {
    log.info(`Clan #${clanId} ledger: left out ${unexpected.map(([why, n]) => `${n}× ${why}`).join(', ')}`);
  }
  if (!fresh.length) return 0;

  const resolved = fresh
    .map((r) => {
      const name = d.byId.get(r.playerId)?.name ?? '';
      return { r, name, memberId: memberFor(r.playerId, name) };
    })
    .filter((x): x is { r: typeof x.r; name: string; memberId: number } => x.memberId !== null);
  if (!resolved.length) return 0;

  const batch = createBatch({
    clanId,
    uploadedBy: null,
    uploadDate: resolved[resolved.length - 1].r.transactionDate,
    fileCount: 1,
    rowCount: resolved.length,
    errorCount: fresh.length - resolved.length,
    notes: 'Clan Capital ledger (read from the game)',
    source: 'scan',
  });
  insertTransactions(resolved.map(({ r, name, memberId }) => ({
    clanId,
    batchId: batch.id,
    memberId,
    resourceTypeId: r.resourceTypeId,
    direction: r.direction,
    amount: r.amount,
    transactionDate: r.transactionDate,
    rawPlayerName: name,
    gameEntryId: r.entryId,
  })));
  return resolved.length;
}
