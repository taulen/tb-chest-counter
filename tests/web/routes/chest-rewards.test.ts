/**
 * GET /api/resources/chest-rewards (Resources → Chest rewards): the ACTIVE
 * clan's claims only, every item and chest type named with its quality and
 * icon, and a bad window refused rather than read unbounded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// The game's names without the CDN: two reward items, a pack and a chest type.
vi.mock('../../../src/game-protocol/static-data.js', async (orig) => {
  const real = await orig<typeof import('../../../src/game-protocol/static-data.js')>();
  return {
    ...real,
    loadGameNames: async () => ({
      version: 'test',
      builtAt: '',
      gifts: {
        2: { chest: 'Silver', source: '' },
        1123: { chest: 'Silver', source: '' },
        2007: { chest: 'Speedup', source: '' },
        5512: { chest: 'Barbarian Chest', source: 'Level 15 Crypt' },
      },
      items: {
        2: { kind: 1 },
        1123: { kind: 2, grants: { 2: 250000 } },
        2007: { kind: 3, seconds: 28800 },
        5512: { kind: 10, quality: 3 },
      },
      techs: {}, objects: {}, heroes: {}, captains: {},
    }),
  };
});
// No extracted art in a test: every id has an icon URL of its own.
vi.mock('../../../src/game-art/item-icons.js', () => ({
  itemIconUrls: async (ids: number[]) => new Map(ids.map((id) => [id, `/game-art/v1/item_${id}.png`])),
}));

import { createResourcesDataRouter } from '../../../src/web/routes/resources.js';
import { getDb } from '../../../src/data/database.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';

const FROM = '2026-11-17T17:00:00.000Z';
const TO = '2026-11-18T17:00:00.000Z';

describe('GET /api/resources/chest-rewards', () => {
  let cleanup: () => void;

  beforeEach(() => {
    ({ cleanup } = makeTestDb());
    seedTwoClans();
    const ins = getDb().prepare(
      `INSERT INTO game_claims (clan_id, session_id, gift_id, gift_type, tab, rewards, claimed_at, batch_size, gift_ids)
       VALUES (?, 1, ?, 5512, 1, ?, ?, ?, NULL)`,
    );
    ins.run(1, 1, '{"2":10000,"1123":1,"2007":1}', '2026-11-18T01:00:00.000Z', 1);
    ins.run(1, 2, '{"2":30000}', '2026-11-18T02:00:00.000Z', 3);
    ins.run(2, 3, '{"2":99999999}', '2026-11-18T02:00:00.000Z', 1);
  });
  afterEach(() => cleanup());

  function app(clanId: number): express.Express {
    const a = express();
    a.use((req, _res, next) => { req.clanId = clanId; next(); });
    a.use('/api/resources', createResourcesDataRouter());
    return a;
  }

  it('answers the active clan\'s income and chest types with names, quality and icons', async () => {
    const res = await request(app(1)).get('/api/resources/chest-rewards').query({ from: FROM, to: TO });
    expect(res.status).toBe(200);
    const { income, byChest, items, chestTypes } = res.body;
    expect(income.chests).toBe(4);
    const silver = income.totals.find((t: { key: string }) => t.key === 'r2');
    expect(silver).toMatchObject({ unit: 'amount', total: 290000, fromPacks: 250000 });
    expect(income.totals.find((t: { key: string }) => t.key === 't3')).toMatchObject({ unit: 'time', total: 28800 });
    expect(byChest).toHaveLength(1);
    expect(byChest[0]).toMatchObject({ giftType: 5512, chests: 4, singles: 1 });
    expect(byChest[0].rewards.find((r: { key: string }) => r.key === 'r2').perChest).toBe(290000 / 4);
    expect(items['2']).toEqual({ name: 'Silver', kind: 1, quality: 0, seconds: 0, iconUrl: '/game-art/v1/item_2.png' });
    expect(items['1123'].name).toBe('Silver');
    expect(items['2007']).toMatchObject({ name: 'Speedup', seconds: 28800 });
    expect(chestTypes['5512']).toEqual({
      name: 'Barbarian Chest', source: 'Level 15 Crypt', kind: 10, quality: 3, seconds: 0, iconUrl: '/game-art/v1/item_5512.png',
    });
  });

  it('never reads another clan\'s claims', async () => {
    const res = await request(app(2)).get('/api/resources/chest-rewards').query({ from: FROM, to: TO });
    expect(res.body.income.chests).toBe(1);
    expect(res.body.income.totals[0].total).toBe(99999999);
  });

  it('refuses a missing, reversed or over-long window', async () => {
    expect((await request(app(1)).get('/api/resources/chest-rewards')).status).toBe(400);
    expect((await request(app(1)).get('/api/resources/chest-rewards').query({ from: TO, to: FROM })).status).toBe(400);
    expect((await request(app(1)).get('/api/resources/chest-rewards')
      .query({ from: FROM, to: TO, trendFrom: '2026-01-01T17:00:00.000Z' })).status).toBe(400);
    expect((await request(app(1)).get('/api/resources/chest-rewards')
      .query({ from: FROM, to: TO, trendFrom: '2026-11-19T17:00:00.000Z' })).status).toBe(400);
  });
});
