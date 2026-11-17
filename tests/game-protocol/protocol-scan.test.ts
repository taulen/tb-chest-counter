/**
 * The protocol scan's recording and claiming (scheduler/protocol-scan.ts),
 * against a real test DB and a fake game client.
 *
 * The invariant that matters most: a gift is recorded once, before it is
 * opened, whatever happens to the claim — so a failed claim or a re-run can
 * neither lose a chest nor count it twice.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { upsertMember } from '../../src/data/repositories/member-repo.js';
import * as sessionRepo from '../../src/data/repositories/session-repo.js';
import { recordAndClaim } from '../../src/scheduler/protocol-scan.js';
import type { CaptureData } from '../../src/scheduler/game-protocol-phase.js';
import type { NamedGift } from '../../src/data/repositories/game-protocol-repo.js';
import type { Frame, Wire } from '../../src/game-protocol/codec.js';
import type { LedgerEntry } from '../../src/game-protocol/messages.js';
import { makeTestDb } from '../helpers/test-db.js';

let cleanup: () => void;
beforeEach(() => { ({ cleanup } = makeTestDb()); });
afterEach(() => cleanup());

const ARRIVED = Date.parse('2026-11-16T12:00:00Z') / 1000;

function gift(giftId: number, senderId: number, senderName: string, over: Partial<NamedGift> = {}): NamedGift {
  return {
    giftId, senderId, senderName, giftType: 5212, chestName: 'Bone Chest', sourceName: 'Level 10 Crypt',
    count: 1, tab: 1, arrivedAt: ARRIVED, expiresAt: ARRIVED + 72000, ...over,
  };
}

function fakeClient(opts: { failIds?: number[] } = {}) {
  const claims: Array<Record<number, number>> = [];
  const client = {
    claims,
    async claim(gifts: Record<number, number>): Promise<Frame> {
      claims.push(gifts);
      if (Object.keys(gifts).some((id) => opts.failIds?.includes(Number(id)))) throw new Error('claim refused');
      const body: Wire[] = [[[{ 2050: 1 }]]];
      return { type: 15013, seq: 1, head: [15013, 1], body, children: [], events: [] };
    },
  };
  return client;
}

function capture(gifts: NamedGift[], memberIds: Map<number, number>, client = fakeClient(), ledger: LedgerEntry[] = []): CaptureData {
  return {
    client: client as unknown as CaptureData['client'],
    names: { version: 't', builtAt: '', gifts: { 2: { chest: 'Silver', source: '' } }, techs: {}, objects: {}, heroes: {} } as unknown as CaptureData['names'],
    record: {
      clanId: 77, tag: 'T', name: 'Test', members: [], gifts: [], objects: [],
      capitalId: null, memberLimit: null, might: null, foundedAt: null, language: '', logo: null, extra: { f9: null, f11: null, f12: null },
    },
    byId: new Map(),
    gifts,
    ledger,
    gameDate: '2026-11-16',
    memberIds,
  };
}

let clock = Date.parse('2026-11-16T20:00:00Z');
const ctx = (sessionId: number) => ({
  clanId: 1,
  sessionId,
  rolloverUtcHour: 17,
  nextCapturedAt: () => new Date(clock++).toISOString(),
  reportProgress: () => {},
  incrementLiveChestCount: () => {},
});

const rows = (table: string) => getDb().prepare(
  `SELECT r.game_gift_id AS gift, m.name AS member, c.name AS chest, s.source, r.point_value AS points, r.earned_at AS earned
     FROM ${table} r JOIN members m ON m.id = r.member_id JOIN chests c ON c.id = r.chest_id
     JOIN chest_sources s ON s.id = r.chest_source_id ORDER BY r.id`,
).all() as Array<{ gift: number; member: string; chest: string; source: string; points: number; earned: number }>;

describe('recordAndClaim', () => {
  it('records every chest once with its game id, then opens it and keeps the rewards', async () => {
    const miana = upsertMember('Miana', 1).id;
    const client = fakeClient();
    const s = sessionRepo.createSession('manual', 1).id;
    const tally = await recordAndClaim(ctx(s), capture([
      gift(10, 501, 'Miana'),
      gift(11, 501, 'Miana', { giftType: 1156, chestName: 'Silver Chest', sourceName: 'Bank', tab: 2, count: 3 }),
    ], new Map([[501, miana]]), client));

    expect(tally).toMatchObject({ alreadyRecorded: 0, claimed: 2, claimFailures: 0, warnings: [] });
    expect(rows('chest_records')).toEqual([
      expect.objectContaining({ gift: 10, member: 'Miana', chest: 'Bone Chest', source: 'Level 10 Crypt', earned: ARRIVED * 1000 }),
    ]);
    // A triumphal bundle of 3 is three bookkeeping rows, never points.
    expect(rows('triumphal_chest_records').map((r) => [r.gift, r.chest, r.points])).toEqual([[11, 'Silver Chest', 0], [11, 'Silver Chest', 0], [11, 'Silver Chest', 0]]);
    // One chest per request, like the game's Open button: the bundle is three.
    expect(client.claims).toEqual([{ 10: 1 }, { 11: 1 }, { 11: 1 }, { 11: 1 }]);
    const claims = getDb().prepare('SELECT gift_id, rewards FROM game_claims ORDER BY id').all();
    expect(claims).toEqual([
      { gift_id: 10, rewards: '{"2050":1}' },
      { gift_id: 11, rewards: '{"2050":1}' }, { gift_id: 11, rewards: '{"2050":1}' }, { gift_id: 11, rewards: '{"2050":1}' },
    ]);
  });

  it('opens single Gifts-tab chests a chest type per request, keeping the summed rewards per request', async () => {
    const miana = upsertMember('Miana', 1).id;
    const client = fakeClient();
    const silver = { giftType: 1156, chestName: 'Silver Chest', sourceName: 'Bank' };
    const tally = await recordAndClaim(ctx(sessionRepo.createSession('manual', 1).id), capture([
      gift(30, 501, 'Miana'), gift(31, 501, 'Miana', silver), gift(32, 501, 'Miana'), gift(33, 501, 'Miana'),
    ], new Map([[501, miana]]), client));

    expect(tally).toMatchObject({ claimed: 4, claimFailures: 0 });
    expect(client.claims).toEqual([{ 30: 1, 32: 1, 33: 1 }, { 31: 1 }]);
    expect(getDb().prepare('SELECT gift_id, gift_type, batch_size, gift_ids FROM game_claims ORDER BY id').all()).toEqual([
      { gift_id: 30, gift_type: 5212, batch_size: 3, gift_ids: '[30,32,33]' },
      { gift_id: 31, gift_type: 1156, batch_size: 1, gift_ids: null },
    ]);
  });

  it('keeps a chest whose claim failed, and a re-run neither loses nor doubles it', async () => {
    const miana = upsertMember('Miana', 1).id;
    const gifts = [gift(20, 501, 'Miana'), gift(21, 501, 'Miana')];
    const first = await recordAndClaim(ctx(sessionRepo.createSession('manual', 1).id), capture(gifts, new Map([[501, miana]]), fakeClient({ failIds: [21] })));
    expect(first).toMatchObject({ claimed: 1, claimFailures: 1 });
    expect(first.warnings[0]).toMatch(/1 of 2 chest\(s\) could not be opened/);
    expect(rows('chest_records').map((r) => r.gift)).toEqual([20, 21]);

    // Next cycle: gift 21 is still in the game.
    const again = await recordAndClaim(ctx(sessionRepo.createSession('manual', 1).id), capture([gifts[1]], new Map([[501, miana]])));
    expect(again).toMatchObject({ alreadyRecorded: 1, claimed: 1, gifts: [] });
    expect(rows('chest_records').map((r) => r.gift)).toEqual([20, 21]);
  });

  it('files a chest under the stored spelling of its source', async () => {
    const miana = upsertMember('Miana', 1).id;
    getDb().prepare("INSERT INTO chest_sources (source) VALUES ('Lvl 25-29 Vault of the Ancients')").run();
    await recordAndClaim(ctx(sessionRepo.createSession('manual', 1).id), capture([
      gift(30, 501, 'Miana', { chestName: 'Sapphire Chest', sourceName: 'Level 25–29 Vault of the Ancients' }),
    ], new Map([[501, miana]])));
    expect(rows('chest_records')[0].source).toBe('Lvl 25-29 Vault of the Ancients');
  });

  it('credits a gift from a player who has left without bringing them back', async () => {
    const gone = upsertMember('OldTimer', 1).id;
    getDb().prepare("UPDATE members SET is_active = 0, left_at = '2026-11-01T00:00:00.000Z' WHERE id = ?").run(gone);
    await recordAndClaim(ctx(sessionRepo.createSession('manual', 1).id), capture([
      gift(40, 900, 'OldTimer'),
      gift(41, 901, 'Stranger'),
    ], new Map()));

    const m = (name: string) => getDb().prepare('SELECT id, is_active, left_at, game_player_id FROM members WHERE name = ?').get(name) as
      { id: number; is_active: number; left_at: string | null; game_player_id: number | null };
    expect(m('OldTimer')).toMatchObject({ id: gone, is_active: 0, left_at: '2026-11-01T00:00:00.000Z', game_player_id: 900 });
    expect(m('Stranger')).toMatchObject({ is_active: 0, game_player_id: 901 });
    expect(rows('chest_records').map((r) => r.member)).toEqual(['OldTimer', 'Stranger']);
  });

  it('imports ledger entries after the newest OCR day, once', async () => {
    const miana = upsertMember('Miana', 1).id;
    const silver = (getDb().prepare("SELECT id FROM resource_types WHERE slug = 'silver'").get() as { id: number }).id;
    const batch = (getDb().prepare(
      "INSERT INTO resource_upload_batches (clan_id, uploaded_at, upload_date, source) VALUES (1, '2026-11-15', '2026-11-15', 'scan') RETURNING id",
    ).get() as { id: number }).id;
    getDb().prepare(
      `INSERT INTO resource_transactions (clan_id, batch_id, member_id, resource_type_id, direction, amount, transaction_date, created_at)
       VALUES (1, ?, ?, ?, 1, 5, '2026-11-15', '2026-11-16')`,
    ).run(batch, miana, silver);
    const ledger: LedgerEntry[] = [
      { entryId: 1, playerId: 501, kind: 3, resource: 2, occurredAt: Date.parse('2026-11-15T20:00:00Z') / 1000, amounts: { 2: 100 } }, // day 15: OCR has it
      { entryId: 2, playerId: 501, kind: 3, resource: 2, occurredAt: Date.parse('2026-11-16T20:00:00Z') / 1000, amounts: { 2: 200 } }, // day 16: new
    ];
    const run = () => recordAndClaim(ctx(sessionRepo.createSession('manual', 1).id), capture([], new Map([[501, miana]]), fakeClient(), ledger));
    expect((await run()).resourceRows).toBe(1);
    expect((await run()).resourceRows).toBe(0);
    const tx = getDb().prepare('SELECT amount, transaction_date, game_entry_id FROM resource_transactions WHERE game_entry_id IS NOT NULL').all();
    expect(tx).toEqual([{ amount: 200, transaction_date: '2026-11-16', game_entry_id: 2 }]);
  });
});
