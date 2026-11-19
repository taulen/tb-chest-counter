/**
 * Scan History's rewards (GET /api/sessions, GET /api/sessions/:id): each scan
 * carries what opening its chests gathered, from its own game_claims rows —
 * the list its resources (amounts only, packs as the resource they hold), the
 * detail everything (resources, speedup time, item counts), each item named
 * and drawn. A scan that opened nothing answers [] / null and never waits on
 * the game's names.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../../src/discord/bot.js', () => ({
  startClanBot: vi.fn(),
  stopClanBot: vi.fn(),
  sendClanTestMessage: vi.fn(async () => ({ ok: true })),
  isClanBotConnected: vi.fn(() => false),
}));
vi.mock('../../../src/scheduler/loop.js', () => ({ ScanLoop: class {} }));
vi.mock('../../../src/web/login-bridge.js', () => ({ loginBridge: { getStatus: () => ({ active: false }) } }));
vi.mock('../../../src/config/index.js', () => ({
  loadConfig: () => ({ gameDayRolloverUtcHour: 17, scanIntervalMs: 60 * 60 * 1000 }),
  resetConfig: vi.fn(),
}));
vi.mock('../../../src/web/middleware/auth.js', () => {
  const asMember = (req: import('express').Request, _res: import('express').Response, next: import('express').NextFunction) => {
    req.user = { id: 1, username: 'member', role: 'user', clanId: 1 } as never;
    req.clanId = 1;
    next();
  };
  return { requireAuth: asMember, requireAdmin: asMember, requireSuperAdmin: asMember, SESSION_COOKIE_NAME: 'session' };
});

// The game's names without the CDN: Gold, Silver, a Silver pack, a speedup, an item.
const loadGameNames = vi.fn(async () => ({
  version: 'test',
  builtAt: '',
  gifts: {
    1: { chest: 'Gold', source: '' },
    2: { chest: 'Silver', source: '' },
    1123: { chest: 'Silver', source: '' },
    2007: { chest: 'Speedup', source: '' },
    535: { chest: 'Cerberus Fang', source: '' },
  },
  items: {
    1: { kind: 1 },
    2: { kind: 1 },
    1123: { kind: 2, grants: { 2: 250000 } },
    2007: { kind: 3, seconds: 28800 },
    535: { kind: 7, quality: 2 },
  },
  techs: {}, objects: {}, heroes: {}, captains: {},
}));
vi.mock('../../../src/game-protocol/static-data.js', async (orig) => {
  const real = await orig<typeof import('../../../src/game-protocol/static-data.js')>();
  return { ...real, loadGameNames: () => loadGameNames() };
});
vi.mock('../../../src/game-art/item-icons.js', () => ({
  itemIconUrls: async (ids: number[]) => new Map(ids.map((id) => [id, `/game-art/v1/item_${id}.png`])),
}));

import { createApiRouter } from '../../../src/web/routes/api.js';
import { resetRewardNamesCache } from '../../../src/data/reward-items.js';
import { getDb } from '../../../src/data/database.js';
import { makeTestDb, seedChestData } from '../../helpers/test-db.js';

describe('Scan History rewards', () => {
  let cleanup: () => void;
  let app: express.Express;
  let sessionId: number;
  let quietId: number;

  beforeEach(() => {
    ({ cleanup } = makeTestDb());
    resetRewardNamesCache();
    loadGameNames.mockClear();
    sessionId = seedChestData(1).sessionId;
    const db = getDb();
    const startedAt = (db.prepare('SELECT started_at FROM scan_sessions WHERE id = ?').get(sessionId) as { started_at: string }).started_at;
    const later = new Date(Date.parse(startedAt) + 1000).toISOString();
    quietId = (db.prepare(
      `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
       VALUES (1, ?, ?, 'completed', 'scheduled') RETURNING id`,
    ).get(later, later) as { id: number }).id;
    const ins = db.prepare(
      `INSERT INTO game_claims (clan_id, session_id, gift_id, gift_type, tab, rewards, claimed_at, batch_size, gift_ids)
       VALUES (1, ?, ?, 5512, 1, ?, ?, ?, NULL)`,
    );
    ins.run(sessionId, 1, '{"2":40000,"1123":1,"2007":2}', later, 3);
    ins.run(sessionId, 2, '{"1":100,"535":1}', later, 1);

    app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
  });
  afterEach(() => cleanup());

  it('the list gives each scan its resources, and names and draws them', async () => {
    const res = await request(app).get('/api/sessions');
    expect(res.status).toBe(200);
    const scanned = res.body.sessions.find((s: { id: number }) => s.id === sessionId);
    expect(scanned.resources).toEqual([
      { itemId: 1, total: 100, fromPacks: 0 },
      { itemId: 2, total: 290000, fromPacks: 250000 },
    ]);
    expect(res.body.sessions.find((s: { id: number }) => s.id === quietId).resources).toEqual([]);
    expect(res.body.items['2']).toEqual({ name: 'Silver', kind: 1, quality: 0, seconds: 0, iconUrl: '/game-art/v1/item_2.png' });
    expect(Object.keys(res.body.items).sort()).toEqual(['1', '2']);
  });

  it('a scan\'s page gives everything it paid out: resources, speedup time, items', async () => {
    const res = await request(app).get(`/api/sessions/${sessionId}`);
    expect(res.status).toBe(200);
    expect(res.body.rewards.chests).toBe(4);
    expect(res.body.rewards.requests).toBe(2);
    const byKey = Object.fromEntries(res.body.rewards.totals.map((tot: { key: string }) => [tot.key, tot]));
    expect(byKey.r2).toMatchObject({ unit: 'amount', total: 290000, fromPacks: 250000 });
    expect(byKey.t3).toMatchObject({ unit: 'time', total: 2 * 28800 });
    expect(byKey.i535).toMatchObject({ unit: 'count', total: 1 });
    expect(res.body.items['535']).toMatchObject({ name: 'Cerberus Fang', quality: 2 });
    expect(res.body.items['1123']).toMatchObject({ name: 'Silver' });
  });

  it('a scan that opened nothing answers null and never asks the game for names', async () => {
    const res = await request(app).get(`/api/sessions/${quietId}`);
    expect(res.status).toBe(200);
    expect(res.body.rewards).toBeNull();
    expect(res.body.items).toEqual({});
    expect(loadGameNames).not.toHaveBeenCalled();
  });
});
