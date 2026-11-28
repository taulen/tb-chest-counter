// GET /api/game/research-levels: the linked player's troop levels for the
// "Your levels" card, picked as Tools → Costs picks — the account's players in
// the ACTIVE clan, its main one unless ?player= names another. The branches
// that need no game files: not linked here, linked but not read yet.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../../src/config/index.js', () => ({
  loadConfig: () => ({ gameDayRolloverUtcHour: 17 }),
  getConfig: () => ({ gameDayRolloverUtcHour: 17 }),
  resetConfig: vi.fn(),
}));

import { createGameRouter } from '../../../src/web/routes/game.js';
import { requireAuth, requireClanContext, SESSION_COOKIE_NAME } from '../../../src/web/middleware/auth.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';
import * as userRepo from '../../../src/data/repositories/user-repo.js';
import { getDb } from '../../../src/data/database.js';

describe('/api/game/research-levels', () => {
  let app: express.Express;
  let cleanup: () => void;
  let linked: string;
  let unlinked: string;

  beforeEach(() => {
    cleanup = makeTestDb().cleanup;
    seedTwoClans();
    const su = userRepo.createUser('su', 'Test1234!aA', 'superadmin');
    const a = userRepo.createUser('a', 'Test1234!aA', 'user', su.id, 1);
    const b = userRepo.createUser('b', 'Test1234!aA', 'user', su.id, 1);
    linked = `${SESSION_COOKIE_NAME}=${userRepo.createSession(a.id)}`;
    unlinked = `${SESSION_COOKIE_NAME}=${userRepo.createSession(b.id)}`;
    const link = getDb().prepare('INSERT INTO user_game_links (user_id, clan_id, player_id, player_name, linked_at, synced_at) VALUES (?, ?, ?, ?, ?, ?)');
    link.run(a.id, 1, 701, 'Main', '2026-11-01', '2026-11-01');
    link.run(a.id, 1, 702, 'Alt', '2026-11-02', '2026-11-02');
    // A link in another clan: not this clan's.
    link.run(a.id, 2, 801, 'Elsewhere', '2026-11-01', '2026-11-01');
    app = express();
    app.use(express.json());
    app.use('/api/game', requireAuth, requireClanContext, createGameRouter());
  });

  afterEach(() => cleanup());

  it('lists the account\'s players in the active clan and takes its main one; not read yet means no levels', async () => {
    const r = await request(app).get('/api/game/research-levels').set('Accept', 'application/json').set('Cookie', linked);
    expect(r.status).toBe(200);
    expect(r.body.players).toEqual([{ playerId: 701, name: 'Main' }, { playerId: 702, name: 'Alt' }]);
    expect(r.body.player).toEqual({ playerId: 701, name: 'Main', readAt: null, levels: null });
  });

  it('takes another of the account\'s players when asked, never one of another clan', async () => {
    const alt = await request(app).get('/api/game/research-levels?player=702').set('Accept', 'application/json').set('Cookie', linked);
    expect(alt.body.player.playerId).toBe(702);
    const other = await request(app).get('/api/game/research-levels?player=801').set('Accept', 'application/json').set('Cookie', linked);
    expect(other.body.player.playerId).toBe(701);
  });

  it('says so when the account has no player in this clan', async () => {
    const r = await request(app).get('/api/game/research-levels').set('Accept', 'application/json').set('Cookie', unlinked);
    expect(r.body).toEqual({ players: [], player: null });
  });
});
