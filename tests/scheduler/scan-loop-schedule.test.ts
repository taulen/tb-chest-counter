/**
 * Every clan on its own schedule: the loop's timer fires for the soonest clan
 * due, a cycle scans only the clans due by then, and each clan's next scan is
 * its own interval (Clans page) or the global one after its last scan. Until
 * Nov 2026 the per-clan interval was stored and editable but nothing read it.
 * The per-clan scan is a fake the test releases by hand — no game, no login.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { getClanById, setClanScanIntervalMinutes } from '../../src/data/repositories/clan-repo.js';
import { getLastCompletedAtByClan } from '../../src/data/repositories/session-repo.js';
import { setClanScanAccount } from '../../src/data/repositories/scan-account-repo.js';
import { ScanLoop } from '../../src/scheduler/loop.js';
import type { ScanResult } from '../../src/scheduler/scan-result.js';
import { makeTestDb } from '../helpers/test-db.js';

let cleanup: () => void;
let loop: ScanLoop | null = null;
beforeEach(() => { ({ cleanup } = makeTestDb()); });
afterEach(() => { loop?.stop(); loop = null; cleanup(); });

const MIN = 60_000;
const GLOBAL_MS = 90 * MIN;
const OK: ScanResult = { success: true, chestsFound: 0, newChests: 0, errors: 0, giftsData: [], triumphalData: [] };
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

/** Active clans, each with its own interval in minutes (null = the global one), on separate accounts. */
function clans(spec: Record<number, number | null>): void {
  const db = getDb();
  db.prepare('UPDATE clans SET is_active = 0').run();
  for (const [id, minutes] of Object.entries(spec)) {
    db.prepare(`INSERT OR REPLACE INTO clans (id, name, slug, game_url, scan_interval_minutes, is_active, created_at)
      VALUES (?, ?, ?, 'https://totalbattle.com', ?, 1, ?)`)
      .run(Number(id), `Clan ${id}`, `clan-${id}`, minutes, new Date().toISOString());
    setClanScanAccount(Number(id), `tb:${id}`, null, 'scan');
  }
}

type LoopInternals = {
  running: boolean;
  nextScanAt: number | null;
  lastScanAt: Map<number, number>;
  runCycle: (trigger?: string, scope?: 'due' | 'all') => Promise<void>;
};

/** A started-looking loop whose scans wait until the test opens them. */
function makeLoop(lastScanAgoMin: Record<number, number>) {
  const started: number[] = [];
  const gates = new Map<number, () => void>();
  const l = new ScanLoop({ scanIntervalMs: GLOBAL_MS, gameDayRolloverUtcHour: 17 } as never, undefined, {
    hasLogin: () => true,
    parallel: () => true,
    scanClan: (clanId) => {
      started.push(clanId);
      return new Promise<ScanResult>((resolve) => gates.set(clanId, () => resolve(OK)));
    },
  });
  const s = l as unknown as LoopInternals;
  s.running = true;
  s.nextScanAt = Date.now();
  for (const [id, ago] of Object.entries(lastScanAgoMin)) s.lastScanAt.set(Number(id), Date.now() - ago * MIN);
  loop = l;
  const open = async (clanId: number) => { gates.get(clanId)!(); gates.delete(clanId); await tick(); };
  const runCycle = () => s.runCycle.call(l, 'scheduled');
  return { l, started, open, runCycle };
}

/** Minutes from now, rounded, for readable expectations. */
const inMin = (at: number | null) => (at === null ? null : Math.round((at - Date.now()) / MIN));

describe('ScanLoop per-clan schedule', () => {
  it("a scheduled cycle scans only the clans that are due, each on its own interval", async () => {
    clans({ 2: 10, 5: null });
    const { l, started, open, runCycle } = makeLoop({ 2: 11, 5: 30 });
    expect(inMin(l.getNextScanAtForClan(2))).toBe(-1);
    expect(inMin(l.getNextScanAtForClan(5))).toBe(60);

    const cycle = runCycle();
    await tick();
    expect(started).toEqual([2]); // 5 has an hour to go on the global interval
    await open(2);
    await cycle;

    expect(inMin(l.getNextScanAtForClan(2))).toBe(10);
    expect(inMin(l.getNextScanAtForClan(5))).toBe(60);
    expect(inMin(l.getNextScanAt())).toBe(10); // the timer waits for the soonest clan
  });

  it('a clan out of the rotation has no next scan', async () => {
    clans({ 2: 10 });
    getDb().prepare(`INSERT OR REPLACE INTO clans (id, name, slug, game_url, is_active, created_at)
      VALUES (7, 'Clan 7', 'clan-7', 'https://totalbattle.com', 0, ?)`).run(new Date().toISOString());
    const { l } = makeLoop({ 2: 1 });
    expect(l.getNextScanAtForClan(7)).toBeNull();
    expect(l.getNextScanAtForClan(2)).not.toBeNull();
  });

  it('a manual scan moves only its own clan', async () => {
    clans({ 2: 10, 5: null });
    const { l, open } = makeLoop({ 2: 4, 5: 30 });
    const scan = l.triggerManualScan(5);
    await tick();
    await open(5);
    await scan;
    expect(inMin(l.getNextScanAtForClan(5))).toBe(90);
    expect(inMin(l.getNextScanAtForClan(2))).toBe(6);
    expect(inMin(l.getNextScanAt())).toBe(6);
  });

  it('a new interval on the Clans page re-arms the timer at once', async () => {
    clans({ 2: null, 5: null });
    const { l } = makeLoop({ 2: 20, 5: 20 });
    l.scheduleChanged();
    expect(inMin(l.getNextScanAt())).toBe(70);

    setClanScanIntervalMinutes(2, 30);
    l.scheduleChanged();
    expect(inMin(l.getNextScanAtForClan(2))).toBe(10);
    expect(inMin(l.getNextScanAt())).toBe(10);
  });

  it('"Scan all clans" scans every active clan, due or not', async () => {
    clans({ 2: 10, 5: null });
    const { l, started, open } = makeLoop({ 2: 1, 5: 1 });
    const cycle = l.triggerManualScanAllClans();
    await tick();
    expect(started.sort()).toEqual([2, 5]);
    await open(2);
    await open(5);
    await cycle;
    expect(inMin(l.getNextScanAtForClan(2))).toBe(10);
    expect(inMin(l.getNextScanAtForClan(5))).toBe(90);
  });

  it('a clan below the 10-minute floor reads as the floor', () => {
    clans({ 2: 5 });
    expect(getClanById(2)?.scanIntervalMinutes).toBe(10);
  });
});

describe('getLastCompletedAtByClan', () => {
  it("is each clan's newest completed scan, ignoring failed ones", () => {
    clans({ 2: null, 5: null });
    const db = getDb();
    const ins = db.prepare(`INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source) VALUES (?, ?, ?, ?, 'scheduled')`);
    ins.run(2, '2026-11-21T10:00:00.000Z', '2026-11-21T10:01:00.000Z', 'completed');
    ins.run(2, '2026-11-21T11:00:00.000Z', '2026-11-21T11:01:00.000Z', 'completed');
    ins.run(5, '2026-11-21T09:00:00.000Z', '2026-11-21T09:01:00.000Z', 'completed');
    ins.run(5, '2026-11-21T11:30:00.000Z', '2026-11-21T11:31:00.000Z', 'failed');
    const m = getLastCompletedAtByClan();
    expect(m.get(2)).toBe(Date.parse('2026-11-21T11:01:00.000Z'));
    expect(m.get(5)).toBe(Date.parse('2026-11-21T09:01:00.000Z'));
  });
});
