/**
 * The scan loop with lanes: clans on different accounts scan at the same
 * time, clans on one account one after another, an unknown account alone; a
 * manual scan queues on its clan's lane; "busy" holds while any lane works.
 * The per-clan scan is a fake the test releases by hand — no game, no login.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { setClanScanAccount } from '../../src/data/repositories/scan-account-repo.js';
import { ScanLoop } from '../../src/scheduler/loop.js';
import type { ScanResult } from '../../src/scheduler/scan-result.js';
import { makeTestDb } from '../helpers/test-db.js';

let cleanup: () => void;
let loop: ScanLoop | null = null;
beforeEach(() => { ({ cleanup } = makeTestDb()); });
afterEach(() => { loop?.stop(); loop = null; cleanup(); });

const OK: ScanResult = { success: true, chestsFound: 0, newChests: 0, errors: 0, giftsData: [], triumphalData: [] };
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

function clans(ids: number[]): void {
  const db = getDb();
  db.prepare('UPDATE clans SET is_active = 0').run();
  for (const id of ids) {
    db.prepare(`INSERT OR REPLACE INTO clans (id, name, slug, game_url, is_active, created_at) VALUES (?, ?, ?, 'https://totalbattle.com', 1, ?)`)
      .run(id, `Clan ${id}`, `clan-${id}`, new Date().toISOString());
  }
}

/** A loop whose scans wait until the test opens them; `started` lists clans in start order. */
function makeLoop(parallel = true) {
  const started: number[] = [];
  const gates = new Map<number, () => void>();
  const l = new ScanLoop({ scanIntervalMs: 3_600_000, gameDayRolloverUtcHour: 17 } as never, undefined, {
    hasLogin: () => true,
    parallel: () => parallel,
    scanClan: (clanId, _trigger, report) => {
      started.push(clanId);
      report(`scanning ${clanId}`);
      return new Promise<ScanResult>((resolve) => gates.set(clanId, () => resolve(OK)));
    },
  });
  (l as unknown as { running: boolean }).running = true;
  loop = l;
  const open = async (clanId: number) => { gates.get(clanId)!(); gates.delete(clanId); await tick(); };
  return { l, started, open };
}

describe('ScanLoop lanes', () => {
  it('scans clans on different accounts at once and clans on one account one after another', async () => {
    clans([2, 3, 5]);
    setClanScanAccount(2, 'tb:111', null, 'scan');
    setClanScanAccount(3, 'tb:222', null, 'scan');
    setClanScanAccount(5, 'tb:222', null, 'scan'); // SIK and SK7 share an account
    const { l, started, open } = makeLoop();

    const cycle = l.triggerManualScanAllClans();
    await tick();
    expect(started).toEqual([2, 3]); // 5 waits for 3: same account
    expect(l.getRunningClanIds()).toEqual([2, 3]);
    expect(l.getDeployState().busy).toBe(true);
    expect(l.getScanOverview()).toMatchObject({
      clans: [{ clanId: 2, phase: 'scan', progressMessage: 'scanning 2' }, { clanId: 3, phase: 'scan' }],
      cycleDone: 0, cycleTotal: 3,
    });

    await open(3);
    expect(started).toEqual([2, 3, 5]);
    expect(l.getRunningClanIds()).toEqual([2, 5]);
    await open(2);
    expect(l.getDeployState().busy).toBe(true); // 5 still runs
    expect(l.getScanOverview()?.cycleDone).toBe(2);
    await open(5);
    await cycle;
    expect(l.getDeployState().busy).toBe(false);
    expect(l.getScanOverview()).toBeNull();
    expect(l.getNextScanAt()).not.toBeNull(); // the next cycle is armed
  });

  it('runs a clan whose account is not known yet alone, after the lanes', async () => {
    clans([2, 3]);
    setClanScanAccount(2, 'tb:111', null, 'scan');
    const { l, started, open } = makeLoop();
    const cycle = l.triggerManualScanAllClans();
    await tick();
    expect(started).toEqual([2]);
    await open(2);
    expect(started).toEqual([2, 3]);
    await open(3);
    await cycle;
  });

  it('is one clan at a time with SCAN_PARALLEL=0', async () => {
    clans([2, 3]);
    setClanScanAccount(2, 'tb:111', null, 'scan');
    setClanScanAccount(3, 'tb:222', null, 'scan');
    const { l, started, open } = makeLoop(false);
    const cycle = l.triggerManualScanAllClans();
    await tick();
    expect(started).toEqual([2]);
    await open(2);
    expect(started).toEqual([2, 3]);
    await open(3);
    await cycle;
  });

  it('queues a manual scan on a busy lane, refuses a clan already queued, and never waits on another account', async () => {
    clans([2, 3, 5]);
    setClanScanAccount(2, 'tb:111', null, 'scan');
    setClanScanAccount(3, 'tb:222', null, 'scan');
    setClanScanAccount(5, 'tb:222', null, 'scan');
    const { l, started, open } = makeLoop();

    const s3 = l.triggerManualScan(3);
    await tick();
    const s5 = l.triggerManualScan(5); // same account as 3: queued
    const s2 = l.triggerManualScan(2); // other account: starts now
    await tick();
    expect(started).toEqual([3, 2]);
    expect(l.isClanScanQueuedOrRunning(5)).toBe(true);
    expect((await l.triggerManualScan(5)).alreadyRunning).toBe(true);
    expect((await l.triggerManualScan(3)).alreadyRunning).toBe(true);

    await open(3);
    expect(started).toEqual([3, 2, 5]);
    await open(2);
    await open(5);
    await Promise.all([s3, s5, s2]);
    expect(l.getDeployState().busy).toBe(false);
  });

  it('refuses a second cycle while one runs and keeps "busy" across a lane\'s gap', async () => {
    clans([3, 5]);
    setClanScanAccount(3, 'tb:222', null, 'scan');
    setClanScanAccount(5, 'tb:222', null, 'scan');
    const { l, started, open } = makeLoop();
    const cycle = l.triggerManualScanAllClans();
    await tick();
    expect(l.isCycleRunning()).toBe(true);
    await l.triggerManualScanAllClans(); // refused, returns at once
    expect(started).toEqual([3]);
    await open(3);
    expect(l.getDeployState().busy).toBe(true);
    await open(5);
    await cycle;
    expect(l.isCycleRunning()).toBe(false);
  });
});
