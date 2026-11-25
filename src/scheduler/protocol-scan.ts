/**
 * The protocol scan: a clan's chests recorded from the game's own gift list
 * and opened with the game's own claim request (docs/game-protocol.md). Runs
 * on the session and data that runGameProtocolCapture just read.
 *
 * Order, chosen so tracking can never be lost:
 *   1. Every gift on both tabs is RECORDED first, keyed by game_gift_id. A gift
 *      a member sent is earned whether or not we open it, and a gift already
 *      recorded (a re-run after a crash, a claim that failed) is never recorded
 *      twice: only `count − rows already carrying its id` rows are added.
 *   2. Then the gifts are claimed (15013) — single Gifts-tab chests a chest
 *      type per request, Triumphal chests and bundles one chest per request —
 *      and each request's rewards are kept in game_claims. A failed claim
 *      leaves the gift in the game; the next cycle records nothing new for it
 *      and claims it again.
 *   3. The Clan Capital ledger becomes resource_transactions rows (one per entry,
 *      game_entry_id unique), from the day after the newest row the retired
 *      screenshot reader captured, so the switch-over never double-counts a day.
 *
 * Names: the game's names are exact, so no correction runs. Each resolves to
 * the spelling already stored for it when one normalises the same (rows the
 * retired screenshot reader wrote say "Lvl 25-29 Vault of the Ancients" where
 * the game says "Level 25–29 …"), so points, merge rules and history keep
 * keying on the names they always had; the clan's chest/source merge rules
 * then apply as they always did.
 */
import { getDb } from '../data/database.js';
import * as chestRepo from '../data/repositories/chest-repo.js';
import * as triumphalChestRepo from '../data/repositories/triumphal-chest-repo.js';
import { getPointsForSourceAt, loadPointSchedule } from '../data/repositories/source-points-repo.js';
import {
  createBatch,
  insertTransactions,
  listResourceTypes,
  UNTRACKED_RESOURCE_SLUGS,
} from '../data/repositories/resource-repo.js';
import { chestTypeFor } from '../data/chest-names.js';
import { parseClaimRewards } from '../game-protocol/messages.js';
import { ledgerToRows } from '../game-protocol/ledger-rows.js';
import { makeMemberResolver } from '../game-protocol/member-sync.js';
import type { CaptureData } from './game-protocol-phase.js';
import type { NamedGift } from '../data/repositories/game-protocol-repo.js';
import type { GiftEntry } from '../models/types.js';
import { childLogger } from '../utils/logger.js';
import { CLAIM_GAP, requestGap } from '../utils/request-gap.js';
import { planGiftClaims } from '../game-protocol/claim-plan.js';

const log = childLogger('protocol-scan');

/** Most gifts in one claim request (the game's own "Claim chests" sends the whole tab). */
const CLAIM_BATCH_MAX = 100;
/** Chests per claim request: a bigger stack is split across requests (claim-plan.ts). */
const CLAIM_CHESTS_MAX = 100;
/** Sender name used when the game gave us neither a member link nor a name. */
const UNKNOWN_SENDER = '[Unknown]';
/** Ledger items already reported as untracked in this process (one System note each). */
const reportedUnmapped = new Set<string>();

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

export async function recordAndClaim(ctx: ProtocolScanContext, d: CaptureData): Promise<ProtocolScanTally> {
  const { clanId, sessionId } = ctx;
  const tally: ProtocolScanTally = { gifts: [], triumphal: [], alreadyRecorded: 0, claimed: 0, claimFailures: 0, resourceRows: 0, warnings: [] };
  const memberFor = makeMemberResolver(clanId, d.memberIds);
  const schedule = loadPointSchedule(clanId);
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
    // The game's own names, verbatim (Nov 25 2026): no mapping onto older spellings.
    const chestName = g.chestName || `Unknown gift ${g.giftType}`;
    const source = g.sourceName;
    const chestType = chestTypeFor(chestName);
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
        gameGiftId: g.giftId,
      };
      const inserted = tab === 2 ? triumphalChestRepo.insertChest(row) : chestRepo.insertChest(row);
      if (!inserted) continue;
      const entry: GiftEntry = {
        playerName: row.playerName, chestName, chestType, source, timeLeft: '',
        giftTab: tab === 2 ? 'triumphal' : 'gifts', quantity: 1,
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

  // 2. Claim. Gifts-tab chests go a chest TYPE at a time: one request holding
  //    every entry of that type, each asked for with its chest count — the way
  //    the game's own "Claim chests" asks for the whole tab — capped at
  //    CLAIM_BATCH_MAX entries / CLAIM_CHESTS_MAX chests (claim-plan.ts). A
  //    summon's 293-chest stack is three requests, not 293. Rewards stay known
  //    per type (the game sums a request's rewards; batch_size = chests). A
  //    refused request is retried a chest at a time, so one bad gift never
  //    holds the rest. Triumphal chests go exactly as the game's Open button
  //    does: one chest per request, a 3× bundle three requests.
  const saveClaim = getDb().prepare(
    `INSERT INTO game_claims (clan_id, session_id, gift_id, gift_type, tab, rewards, claimed_at, batch_size, gift_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // A varied gap between claims, quicker than a player clicks Open by hand.
  const gap = () => requestGap(CLAIM_GAP[0], CLAIM_GAP[1]);
  let warned = false;
  const failed = new Set<number>();
  const claimFailed = (giftId: number, err: unknown) => {
    failed.add(giftId);
    if (!warned) log.warn({ noAlert: true }, `Clan #${clanId}: claiming gift ${giftId} failed (recorded; retried next cycle): ${String(err)}`);
    warned = true;
  };
  // Progress in CHESTS, not gift entries: a bundle or a summon's drop is one
  // entry holding many chests. Counting entries showed SIK's 473 chests as
  // "Opening chests (11/44)…" for a minute and a half, which looked stuck.
  const totalChests = d.gifts.reduce((n, g) => n + g.count, 0);
  let openedChests = 0;
  let shownAt = -Infinity;
  const progress = (force = false): void => {
    if (!force && openedChests - shownAt < 10 && openedChests < totalChests) return;
    shownAt = openedChests;
    ctx.reportProgress(`Opening chests (${openedChests}/${totalChests})…`);
  };
  /** `n` chests of one gift, one chest per request; stops at the first refusal. */
  const claimChests = async (g: NamedGift, n: number): Promise<void> => {
    for (let i = 0; i < n; i++) {
      try {
        const rewards = parseClaimRewards(await d.client.claim({ [g.giftId]: 1 }));
        saveClaim.run(clanId, sessionId, g.giftId, g.giftType, g.tab, JSON.stringify(rewards), new Date().toISOString(), 1, null);
      } catch (err) {
        claimFailed(g.giftId, err);
        openedChests += n - i; // skipped: recorded, the next scan opens them
        progress();
        return;
      }
      openedChests++;
      progress();
      await gap();
    }
  };

  progress(true);
  for (const req of planGiftClaims(d.gifts.filter((g) => g.tab === 1), CLAIM_BATCH_MAX, CLAIM_CHESTS_MAX)) {
    try {
      const ask: Record<number, number> = {};
      for (const p of req.parts) ask[p.gift.giftId] = p.n;
      const rewards = parseClaimRewards(await d.client.claim(ask));
      saveClaim.run(
        clanId, sessionId, req.parts[0].gift.giftId, req.giftType, 1, JSON.stringify(rewards), new Date().toISOString(),
        req.chests, req.parts.length > 1 ? JSON.stringify(req.parts.map((p) => p.gift.giftId)) : null,
      );
      openedChests += req.chests;
      progress(true);
      await gap();
    } catch {
      await gap();
      for (const p of req.parts) await claimChests(p.gift, p.n);
    }
  }
  for (const g of d.gifts.filter((x) => x.tab !== 1)) await claimChests(g, g.count);
  tally.claimFailures = failed.size;
  tally.claimed = d.gifts.length - failed.size;
  if (tally.claimFailures) {
    tally.warnings.push(`${tally.claimFailures} of ${d.gifts.length} gift entries could not be opened in full; their chests are recorded and the next scan opens them`);
  }

  // 3. Ledger → resource rows.
  try {
    tally.resourceRows = importLedger(clanId, sessionId, d, memberFor, ctx.rolloverUtcHour);
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

/**
 * Ledger entries newer than the clan's screenshot-read rows → resource_transactions,
 * in a batch tagged with this scan's session (Scan History counts them). Returns rows written.
 */
function importLedger(
  clanId: number,
  sessionId: number,
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
  // A resource the game added that we don't track yet: just information, once
  // per item per process, on the System page (no alert dot). It needs a
  // resource type + icon (docs/game-protocol.md, "Adding a resource type").
  // Replaces the OCR-era "unresolved resources" review, retired Nov 2026.
  for (const [why, n] of Object.entries(skipped)) {
    if (!why.startsWith('unmapped item ') || reportedUnmapped.has(why)) continue;
    reportedUnmapped.add(why);
    log.warn({ noAlert: true }, `The Clan Capital ledger has a resource we don't track yet (${why.slice('unmapped '.length)}, ${n}× in clan #${clanId}'s read) — its rows are left out until it is added as a resource type.`);
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
    sessionId,
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
