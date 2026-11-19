/**
 * Scan History's per-scan numbers. GET /api/sessions gives each scan the Clan
 * Capital ledger rows it recorded (`resourceRows`, v134 batch session_id).
 * GET /api/sessions/:id adds that scan's ledger per resource and direction,
 * and what opening its chests paid out (its own game_claims rows: resources,
 * speedup time, item counts), each item named and drawn. A scan that opened
 * nothing answers null and never waits on the game's names.
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
import { createBatch, insertTransactions } from '../../../src/data/repositories/resource-repo.js';
import { getDb } from '../../../src/data/database.js';
import { makeTestDb, seedChestData } from '../../helpers/test-db.js';

describe('Scan History per-scan numbers', () => {
  let cleanup: () => void;
  let app: express.Express;
  let sessionId: number;
  let quietId: number;

  beforeEach(() => {
    ({ cleanup } = makeTestDb());
    resetRewardNamesCache();
    loadGameNames.mockClear();
    const seed = seedChestData(1);
    sessionId = seed.sessionId;
    const db = getDb();
    const startedAt = (db.prepare('SELECT started_at FROM scan_sessions WHERE id = ?').get(sessionId) as { started_at: string }).started_at;
    const later = new Date(Date.parse(startedAt) + 1000).toISOString();
    quietId = (db.prepare(
      `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source)
       VALUES (1, ?, ?, 'completed', 'scheduled') RETURNING id`,
    ).get(later, later) as { id: number }).id;

    // What the chests paid out.
    const ins = db.prepare(
      `INSERT INTO game_claims (clan_id, session_id, gift_id, gift_type, tab, rewards, claimed_at, batch_size, gift_ids)
       VALUES (1, ?, ?, 5512, 1, ?, ?, ?, NULL)`,
    );
    ins.run(sessionId, 1, '{"2":40000,"1123":1,"2007":2}', later, 3);
    ins.run(sessionId, 2, '{"1":100,"535":1}', later, 1);

    // The Clan Capital ledger: three rows this scan read, one an upload's.
    const type = (slug: string) => (db.prepare('SELECT id FROM resource_types WHERE slug = ?').get(slug) as { id: number }).id;
    const members = db.prepare('SELECT id FROM members WHERE clan_id = 1 ORDER BY id').all() as Array<{ id: number }>;
    const row = (batchId: number, memberId: number, slug: string, direction: 1 | -1, amount: number) => ({
      clanId: 1, batchId, memberId, resourceTypeId: type(slug), direction, amount,
      transactionDate: '2026-11-18', rawPlayerName: '',
    });
    const scanBatch = createBatch({
      clanId: 1, uploadedBy: null, uploadDate: '2026-11-18', fileCount: 1, rowCount: 3, errorCount: 0,
      notes: 'Clan Capital ledger (read from the game)', source: 'scan', sessionId,
    });
    insertTransactions([
      row(scanBatch.id, members[0].id, 'silver', 1, 1000),
      row(scanBatch.id, members[1].id, 'silver', 1, 500),
      row(scanBatch.id, members[0].id, 'dragon-coins', -1, 7),
    ]);
    const upload = createBatch({ clanId: 1, uploadedBy: null, uploadDate: '2026-11-18', fileCount: 1, rowCount: 1, errorCount: 0, notes: '' });
    insertTransactions([row(upload.id, members[0].id, 'silver', 1, 99)]);

    app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
  });
  afterEach(() => cleanup());

  it('the list gives each scan the ledger rows it recorded', async () => {
    const res = await request(app).get('/api/sessions');
    expect(res.status).toBe(200);
    const byId = new Map((res.body as Array<{ id: number; resourceRows: number }>).map((s) => [s.id, s]));
    expect(byId.get(sessionId)!.resourceRows).toBe(3);
    expect(byId.get(quietId)!.resourceRows).toBe(0);
    // The list never asks the game for names.
    expect(loadGameNames).not.toHaveBeenCalled();
  });

  it('a scan\'s page gives its ledger per resource and direction, Sent first', async () => {
    const res = await request(app).get(`/api/sessions/${sessionId}`);
    expect(res.status).toBe(200);
    expect(res.body.ledger.rows).toBe(3);
    expect(res.body.ledger.members).toBe(2);
    expect(res.body.ledger.byResource).toEqual([
      { slug: 'silver', name: expect.any(String), direction: 1, rows: 2, amount: 1500 },
      { slug: 'dragon-coins', name: 'Dragon Coins', direction: -1, rows: 1, amount: 7 },
    ]);
  });

  it('a scan\'s page gives everything its chests paid out: resources, speedup time, items', async () => {
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

  it('a scan that recorded and opened nothing answers empty and never asks the game for names', async () => {
    const res = await request(app).get(`/api/sessions/${quietId}`);
    expect(res.status).toBe(200);
    expect(res.body.ledger).toEqual({ rows: 0, members: 0, byResource: [] });
    expect(res.body.rewards).toBeNull();
    expect(res.body.items).toEqual({});
    expect(loadGameNames).not.toHaveBeenCalled();
  });
});
