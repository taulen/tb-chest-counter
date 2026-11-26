/**
 * Dragon Coins back to members — the runner (scheduler/dragon-coin-returns.ts)
 * against a test DB and a fake game client: the gates (switch, kill switch,
 * Leader/Superior), the treasury, reserve-before-send, the ledger confirming
 * sends, and that no member's coins ever go out twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logged: string[] = [];
vi.mock('../../src/utils/logger.js', () => {
  const rec = (...args: unknown[]) => { logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  const l = { info: rec, warn: rec, debug: rec, error: rec, child: () => l };
  return { childLogger: () => l, getLogger: () => l, createLogger: () => l };
});
const treasury = vi.hoisted(() => ({ coins: null as number | null }));
vi.mock('../../src/game-protocol/messages.js', async (orig) => ({
  ...(await orig<typeof import('../../src/game-protocol/messages.js')>()),
  parseClanCapital: () => (treasury.coins === null ? null : { capitalId: 900, techs: {}, treasury: { 31: treasury.coins }, position: null }),
}));

import { getDb } from '../../src/data/database.js';
import { saveLedger } from '../../src/data/repositories/game-protocol-repo.js';
import { listDragonCoinReturns, setDragonCoinReturnsEnabled } from '../../src/data/repositories/dragon-coin-return-repo.js';
import { runDragonCoinReturns } from '../../src/scheduler/dragon-coin-returns.js';
import type { GameClient } from '../../src/game-protocol/client.js';
import type { ClanRecord, LedgerEntry } from '../../src/game-protocol/messages.js';
import type { Frame } from '../../src/game-protocol/codec.js';
import { makeTestDb, seedTwoClans } from '../helpers/test-db.js';

const CLAN = 2;
const GAME_CLAN = 1297080123906;
const SCANNER = 1241245577338;
const T0 = Date.parse('2026-11-26T12:00:00Z');
let nowMs = T0;
let cleanup: () => void;
let nextEntry = 30000;

beforeEach(() => {
  ({ cleanup } = makeTestDb());
  seedTwoClans();
  nowMs = T0;
  logged.length = 0;
  treasury.coins = 5_000_000;
  nextEntry = 30000;
  delete process.env.DRAGON_COIN_RETURNS_DISABLED;
});
afterEach(() => {
  cleanup();
  delete process.env.DRAGON_COIN_RETURNS_DISABLED;
});

const frame = (type: number, body: unknown[]): Frame => ({ type, seq: 1, head: [], body: body as Frame['body'], children: [], events: [] });
const ledgerFrame = (entries: LedgerEntry[]): Frame =>
  frame(15031, [[entries.map((e) => [e.entryId, [e.playerId], e.kind, e.resource, e.occurredAt, [e.amounts, {}, 1]])]]);

/** A member's event reward arriving in the treasury (stored as the scan stores the ledger). */
function arrives(playerId: number, amount: number, atMs: number, kind = 4): number {
  const entryId = nextEntry++;
  saveLedger(CLAN, [{ entryId, playerId, kind, resource: 31, occurredAt: Math.floor(atMs / 1000), amounts: { 31: amount } }]);
  return entryId;
}

/** A fake game: records sends, and its ledger shows each accepted one as a kind-1 entry. */
function fakeClient(opts: { reply?: (playerId: number) => unknown[] | Error; showInLedger?: boolean } = {}) {
  const sends: Array<{ playerId: number; resourceId: number; amount: number }> = [];
  const shown: LedgerEntry[] = [];
  const client = {
    playerId: SCANNER,
    city: vi.fn(async () => frame(601, [])),
    sendFromTreasury: vi.fn(async (playerId: number, resourceId: number, amount: number) => {
      sends.push({ playerId, resourceId, amount });
      const r = opts.reply?.(playerId) ?? [[]];
      if (opts.showInLedger !== false) shown.push({ entryId: nextEntry++, playerId, kind: 1, resource: 31, occurredAt: Math.floor(nowMs / 1000), amounts: { 31: amount } });
      if (r instanceof Error) throw r;
      return frame(15019, r);
    }),
    ledger: vi.fn(async () => ledgerFrame(shown)),
  };
  return { client: client as unknown as GameClient, sends, raw: client };
}

const record = (members: Array<[number, number]>, capitalId: number | null = 900): ClanRecord => ({
  clanId: GAME_CLAN, tag: 'CWB', name: 'ChaosWithoutBorders',
  members: members.map(([playerId, role]) => ({ playerId, role, joinedAt: 1700000000 })),
  gifts: [], objects: [], capitalId, memberLimit: 100, might: null,
} as unknown as ClanRecord);

const ROSTER: Array<[number, number]> = [[SCANNER, 2], [101, 4], [102, 5], [103, 3]];
const run = (client: GameClient, members = ROSTER, capitalId: number | null = 900) =>
  runDragonCoinReturns(CLAN, { client, record: record(members, capitalId), now: () => nowMs, gap: async () => {} });
const rows = () => listDragonCoinReturns(CLAN).map((r) => ({ playerId: r.playerId, amount: r.amount, status: r.status, confirmed: r.ledgerEntryId !== null }));

describe('runDragonCoinReturns', () => {
  it('does nothing while the switch is off', async () => {
    arrives(101, 21000, T0 - 3600_000);
    const { client, sends } = fakeClient();
    expect(await run(client)).toBe('');
    expect(sends).toEqual([]);
  });

  it('sends each member theirs back after the switch went on, and the ledger confirms it', async () => {
    setDragonCoinReturnsEnabled(CLAN, true, T0 - 7200_000);
    arrives(101, 50000, T0 - 9000_000); // before the switch: never
    arrives(101, 21000, T0 - 3600_000);
    arrives(101, 42000, T0 - 3000_000);
    arrives(102, 52000, T0 - 3000_000);
    const { client, sends } = fakeClient();
    const note = await run(client);
    expect(sends).toEqual([{ playerId: 101, resourceId: 31, amount: 63000 }, { playerId: 102, resourceId: 31, amount: 52000 }]);
    expect(note).toContain('sent 115,000 to 2 member(s)');
    expect(rows()).toEqual([
      { playerId: 101, amount: 63000, status: 'sent', confirmed: true },
      { playerId: 102, amount: 52000, status: 'sent', confirmed: true },
    ]);
    // The next scan sends nothing again.
    nowMs += 600_000;
    const again = fakeClient();
    await run(again.client);
    expect(again.sends).toEqual([]);
  });

  it('never sends what the clan won, credited to the Leader', async () => {
    setDragonCoinReturnsEnabled(CLAN, true, T0 - 7200_000);
    arrives(103, 525000, T0 - 3600_000, 8);
    arrives(103, 262500, T0 - 3600_000, 5);
    const { client, sends } = fakeClient();
    expect(await run(client)).toBe('');
    expect(sends).toEqual([]);
  });

  it('sends nothing unless the scanner account is Leader or Superior, and warns once', async () => {
    setDragonCoinReturnsEnabled(CLAN, true, T0 - 7200_000);
    arrives(101, 21000, T0 - 3600_000);
    const { client, sends } = fakeClient();
    const officer: Array<[number, number]> = [[SCANNER, 3], [101, 4]];
    expect(await run(client, officer)).toContain('not Leader or Superior');
    await run(client, officer);
    expect(sends).toEqual([]);
    expect(logged.filter((l) => l.includes('only a Leader or Superior can send'))).toHaveLength(1);
    // Promoted to Leader: it sends.
    await run(client, [[SCANNER, 1], [101, 4]]);
    expect(sends).toEqual([{ playerId: 101, resourceId: 31, amount: 21000 }]);
  });

  it('the server kill switch stops every send', async () => {
    process.env.DRAGON_COIN_RETURNS_DISABLED = '1';
    setDragonCoinReturnsEnabled(CLAN, true, T0 - 7200_000);
    arrives(101, 21000, T0 - 3600_000);
    const { client, sends } = fakeClient();
    expect(await run(client)).toContain('DRAGON_COIN_RETURNS_DISABLED');
    expect(sends).toEqual([]);
  });

  it('never asks for more than the treasury holds', async () => {
    setDragonCoinReturnsEnabled(CLAN, true, T0 - 7200_000);
    treasury.coins = 60000;
    arrives(101, 50000, T0 - 3600_000);
    arrives(102, 52000, T0 - 3000_000);
    const { client, sends } = fakeClient();
    const note = await run(client);
    expect(sends).toEqual([{ playerId: 101, resourceId: 31, amount: 50000 }]);
    expect(note).toContain('1 member(s) waiting: the treasury holds too few');
  });

  it('a send without a clear answer is never sent again until the ledger has had its say', async () => {
    setDragonCoinReturnsEnabled(CLAN, true, T0 - 7200_000);
    arrives(101, 21000, T0 - 3600_000);
    const lost = fakeClient({ reply: () => new Error('game server timeout'), showInLedger: false });
    await run(lost.client);
    expect(rows()).toEqual([{ playerId: 101, amount: 21000, status: 'unknown', confirmed: false }]);

    // Ten minutes on: still waiting on the ledger, nothing sent.
    nowMs += 10 * 60_000;
    const early = fakeClient();
    await run(early.client);
    expect(early.sends).toEqual([]);

    // Past the wait, the ledger never showed it: it did not go through, so it goes again.
    nowMs += 10 * 60_000;
    const retry = fakeClient();
    await run(retry.client);
    expect(retry.sends).toEqual([{ playerId: 101, resourceId: 31, amount: 21000 }]);
    expect(rows()).toEqual([
      { playerId: 101, amount: 21000, status: 'failed', confirmed: false },
      { playerId: 101, amount: 21000, status: 'sent', confirmed: true },
    ]);
  });

  it('a timed-out send the ledger shows counts as sent', async () => {
    setDragonCoinReturnsEnabled(CLAN, true, T0 - 7200_000);
    arrives(101, 21000, T0 - 3600_000);
    const { client } = fakeClient({ reply: () => new Error('game server timeout') });
    await run(client);
    expect(rows()).toEqual([{ playerId: 101, amount: 21000, status: 'sent', confirmed: true }]);
  });

  it('leaves the coins of a member who left the clan', async () => {
    setDragonCoinReturnsEnabled(CLAN, true, T0 - 7200_000);
    arrives(104, 21000, T0 - 3600_000);
    const { client, sends } = fakeClient();
    await run(client);
    expect(sends).toEqual([]);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM dragon_coin_returns').get()).toEqual({ n: 0 });
  });

  it('switching off and on again starts from then', async () => {
    setDragonCoinReturnsEnabled(CLAN, true, T0 - 7200_000);
    setDragonCoinReturnsEnabled(CLAN, false, T0 - 5000_000);
    arrives(101, 21000, T0 - 3600_000); // while off
    setDragonCoinReturnsEnabled(CLAN, true, T0 - 1800_000);
    arrives(102, 42000, T0 - 600_000);
    const { client, sends } = fakeClient();
    await run(client);
    expect(sends).toEqual([{ playerId: 102, resourceId: 31, amount: 42000 }]);
  });
});
