// The scan is pipelined: clicking a gift card CLAIMS that chest in-game and
// the row is written to the DB immediately. So a chest row is not a cache of
// something we can go back and re-read — the gift is gone from the Gifts tab
// the instant we clicked it, and the row is the only remaining record.
//
// That makes deleting rows on an aborted scan uniquely destructive, and it is
// exactly what happened: `result.newChests` is assigned only when a sweep
// RETURNS, so a browser crash mid-sweep unwound the stack with the tally still
// inside it. finalizeScanFailure read the resulting 0 as "nothing to keep" and
// called deleteChestsBySession on rows that were already on disk.
//
// These tests drive finalizeScanFailure with a ScanResult whose counters say
// zero while the database says otherwise — the shape of a mid-sweep crash.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finalizeScanFailure } from '../../src/scheduler/scan-finalize.js';
import { MaintenanceModeError, SessionKickedError } from '../../src/browser/navigator.js';
import * as chestRepo from '../../src/data/repositories/chest-repo.js';
import * as triumphalChestRepo from '../../src/data/repositories/triumphal-chest-repo.js';
import { upsertMember } from '../../src/data/repositories/member-repo.js';
import { createSession, getSessionById } from '../../src/data/repositories/session-repo.js';
import { ChestType, ScanStatus } from '../../src/models/enums.js';
import { makeTestDb, seedTwoClans } from '../helpers/test-db.js';
import type { ScanResult } from '../../src/scheduler/scan-result.js';
import type { ScanFinalizeContext } from '../../src/scheduler/scan-finalize.js';

function makeContext(clanId: number): ScanFinalizeContext {
  return {
    clanId,
    isRunning: true,
    stateMachine: { transition: vi.fn() } as unknown as ScanFinalizeContext['stateMachine'],
    progressMessage: 'Scanning Gifts list',
    recordScanError: vi.fn(),
    getLastScanError: () => ({ message: 'mouse.click: Target crashed', phase: 'Scanning Gifts list' }),
    clearLastScanError: vi.fn(),
    setMaintenanceBlock: vi.fn(),
    clearMaintenanceBlock: vi.fn(),
    scheduleNextCycle: vi.fn(),
    flagSkipNextScheduling: vi.fn(),
    reportProgress: vi.fn(),
    config: { screenshotRetentionDays: 3 },
  };
}

/** A ScanResult as it looks when a sweep threw before returning: the tallies
 *  never got assigned, so every counter still reads zero. */
function crashedMidSweepResult(): ScanResult {
  return {
    success: false,
    chestsFound: 0,
    newChests: 0,
    errors: 0,
    giftsData: [],
    triumphalData: [],
  };
}

describe('finalizeScanFailure — chests claimed before an abort', () => {
  let cleanup: () => void;
  let clanId: number;
  let otherClanId: number;
  let sessionId: number;
  let memberId: number;

  beforeEach(() => {
    const t = makeTestDb();
    cleanup = t.cleanup;
    const { clanIdA, clanIdB } = seedTwoClans();
    clanId = clanIdA;
    otherClanId = clanIdB;
    sessionId = createSession('scheduled', clanId).id;
    memberId = upsertMember('Alice', clanId).id;
  });

  afterEach(() => cleanup());

  function insertGiftChest(chestName = 'Common Chest', session = sessionId, clan = clanId): void {
    chestRepo.insertChest({
      sessionId: session,
      clanId: clan,
      playerName: 'Alice',
      memberId: upsertMember('Alice', clan).id,
      chestName,
      chestType: ChestType.COMMON,
      chestSource: 'clan_gift',
      pointValue: 1,
      capturedAt: '2026-07-28T06:17:00.000Z',
      confidence: 1,
    });
  }

  function insertTriumphalChest(chestName = "Conqueror's Chest"): void {
    triumphalChestRepo.insertChest({
      sessionId,
      clanId,
      playerName: 'Alice',
      memberId,
      chestName,
      chestType: ChestType.COMMON,
      chestSource: 'bank',
      pointValue: 0,
      capturedAt: '2026-07-28T06:17:10.000Z',
      effectiveAt: '2026-07-28T06:17:10.000Z',
      confidence: 1,
    });
  }

  it('keeps gift chests already on disk when the browser crashes mid-sweep', () => {
    insertGiftChest('Common Chest');
    insertGiftChest('Rare Chest');
    const result = crashedMidSweepResult();

    const outcome = finalizeScanFailure(
      new Error('mouse.click: Target crashed'),
      makeContext(clanId),
      result,
      sessionId,
    );

    // The rows survive. This is the assertion the whole fix exists for.
    expect(chestRepo.countChestsBySession(sessionId, clanId)).toBe(2);
    expect(chestRepo.getChestsBySession(sessionId, clanId)).toHaveLength(2);
    // And the session records them rather than claiming the scan found nothing.
    expect(getSessionById(sessionId, clanId)?.status).toBe(ScanStatus.COMPLETED);
    expect(getSessionById(sessionId, clanId)?.chestsFound).toBe(2);
    expect(result.newChests).toBe(2);
    // Kept-partial is a handled outcome, not one runCycle should re-throw.
    expect(outcome.action).toBe('return');
  });

  it('keeps triumphal chests too — they live in their own table', () => {
    insertTriumphalChest();
    insertTriumphalChest('Champion Chest');

    finalizeScanFailure(
      new Error('mouse.click: Target crashed'),
      makeContext(clanId),
      crashedMidSweepResult(),
      sessionId,
    );

    // Triumphal rows alone are enough to block the rollback, even though they
    // don't count toward chestsFound (which stays gifts-only, as on the
    // success path). The Scan History detail view lists them separately.
    expect(triumphalChestRepo.countBySession(sessionId, clanId)).toBe(2);
    expect(getSessionById(sessionId, clanId)?.status).toBe(ScanStatus.COMPLETED);
  });

  it('reports gifts-only in chestsFound while protecting both tables', () => {
    insertGiftChest();
    insertTriumphalChest();

    const result = crashedMidSweepResult();
    finalizeScanFailure(new Error('page crashed'), makeContext(clanId), result, sessionId);

    expect(chestRepo.countChestsBySession(sessionId, clanId)).toBe(1);
    expect(triumphalChestRepo.countBySession(sessionId, clanId)).toBe(1);
    expect(result.newChests).toBe(1);
    expect(getSessionById(sessionId, clanId)?.chestsFound).toBe(1);
  });

  it('keeps chests claimed before a maintenance abort', () => {
    insertGiftChest();

    const outcome = finalizeScanFailure(
      new MaintenanceModeError('Server maintenance', 15 * 60_000),
      makeContext(clanId),
      crashedMidSweepResult(),
      sessionId,
    );

    expect(chestRepo.countChestsBySession(sessionId, clanId)).toBe(1);
    expect(getSessionById(sessionId, clanId)?.status).toBe(ScanStatus.COMPLETED);
    expect(outcome.action).toBe('return');
  });

  it('keeps chests claimed before a session kick', () => {
    insertGiftChest();

    finalizeScanFailure(
      new SessionKickedError('Another device logged in'),
      makeContext(clanId),
      crashedMidSweepResult(),
      sessionId,
    );

    expect(chestRepo.countChestsBySession(sessionId, clanId)).toBe(1);
    expect(getSessionById(sessionId, clanId)?.status).toBe(ScanStatus.COMPLETED);
  });

  it('still fails the session cleanly when nothing was claimed', () => {
    const outcome = finalizeScanFailure(
      new Error('Navigation timeout'),
      makeContext(clanId),
      crashedMidSweepResult(),
      sessionId,
    );

    expect(getSessionById(sessionId, clanId)?.status).toBe(ScanStatus.FAILED);
    // Genuinely-empty failures still bubble up so runCycle applies its cooldown.
    expect(outcome.action).toBe('rethrow');
  });

  it('never counts or touches another clan\'s rows for the same session id', () => {
    // Session ids are global, so a clan-blind count would keep a failed scan
    // alive on the strength of a different clan's chests.
    const otherSession = createSession('scheduled', otherClanId).id;
    insertGiftChest('Common Chest', otherSession, otherClanId);

    const outcome = finalizeScanFailure(
      new Error('mouse.click: Target crashed'),
      makeContext(clanId),
      crashedMidSweepResult(),
      sessionId,
    );

    expect(getSessionById(sessionId, clanId)?.status).toBe(ScanStatus.FAILED);
    expect(outcome.action).toBe('rethrow');
    // The other clan's chest is untouched by our rollback.
    expect(chestRepo.countChestsBySession(otherSession, otherClanId)).toBe(1);
  });
});
