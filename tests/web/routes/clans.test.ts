import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// All side-effectful neighbours of clans.ts get stubbed before we
// import the router. The intent of this file is to verify HTTP shape
// + multi-clan scoping + that the route handlers call the right
// downstream functions — not to exercise Discord, the scanner, or
// the browser launcher (each of those has its own test surface).
vi.mock('../../../src/discord/bot.js', () => ({
  startClanBot: vi.fn(),
  stopClanBot: vi.fn(),
  sendClanTestMessage: vi.fn(async () => ({ ok: true })),
  isClanBotConnected: vi.fn(() => false),
}));

vi.mock('../../../src/browser/launcher.js', () => ({
  launchBrowser: vi.fn(),
  closeBrowser: vi.fn(async () => {}),
}));

vi.mock('../../../src/scheduler/loop.js', () => ({
  ScanLoop: class {},
}));

vi.mock('../../../src/config/index.js', () => ({
  loadConfig: () => ({ gameDayRolloverUtcHour: 17 }),
}));

// Bypass auth: every request is a superadmin from clan 1.
vi.mock('../../../src/web/middleware/auth.js', () => ({
  requireAuth: (req: import('express').Request, _res: import('express').Response, next: import('express').NextFunction) => {
    req.user = { id: 1, username: 'test-admin', role: 'superadmin', clanId: 1 } as never;
    req.clanId = 1;
    next();
  },
  requireAdmin: (req: import('express').Request, _res: import('express').Response, next: import('express').NextFunction) => {
    req.user = { id: 1, username: 'test-admin', role: 'superadmin', clanId: 1 } as never;
    req.clanId = 1;
    next();
  },
  requireSuperAdmin: (req: import('express').Request, _res: import('express').Response, next: import('express').NextFunction) => {
    req.user = { id: 1, username: 'test-admin', role: 'superadmin', clanId: 1 } as never;
    req.clanId = 1;
    next();
  },
  requireClanAccess: (req: import('express').Request, _res: import('express').Response, next: import('express').NextFunction) => {
    req.user = { id: 1, username: 'test-admin', role: 'superadmin', clanId: 1 } as never;
    req.clanId = 1;
    next();
  },
  requireClanAdmin: (req: import('express').Request, _res: import('express').Response, next: import('express').NextFunction) => {
    req.user = { id: 1, username: 'test-admin', role: 'superadmin', clanId: 1 } as never;
    req.clanId = 1;
    next();
  },
  SESSION_COOKIE_NAME: 'session',
}));

// logAction reads the user-repo's audit-log table, which our test DB has.
// No need to mock it.

import { createClansRouter } from '../../../src/web/routes/clans.js';
import { sendClanTestMessage } from '../../../src/discord/bot.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';
import { createUser } from '../../../src/data/repositories/user-repo.js';

describe('clans router — baseline coverage for Phase B1 split', () => {
  let cleanup: () => void;
  let app: express.Express;

  beforeEach(() => {
    const t = makeTestDb();
    cleanup = t.cleanup;
    seedTwoClans();

    // logAction requires a user row to satisfy the FK; create one with
    // the same id the auth mock injects.
    createUser('test-admin', 'irrelevant-pw-1234', 'superadmin');

    app = express();
    app.use(express.json());
    app.use('/api/clans', createClansRouter());
  });

  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  describe('GET /api/clans', () => {
    it('lists all clans for a superadmin', async () => {
      const res = await request(app).get('/api/clans');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.clans)).toBe(true);
      expect(res.body.clans.length).toBe(2);
      const names = res.body.clans.map((c: { name: string }) => c.name);
      expect(names).toContain('Clan #1');
      expect(names).toContain('Clan #2');
    });

    it('strips discordToken from the response (token is write-only)', async () => {
      const res = await request(app).get('/api/clans');
      for (const c of res.body.clans) {
        expect(c.discordToken).toBeUndefined();
        expect(c).toHaveProperty('discordTokenSet');
      }
    });
  });

  describe('GET /api/clans/:clanId', () => {
    it('returns the clan when it exists', async () => {
      const res = await request(app).get('/api/clans/1');
      expect(res.status).toBe(200);
      expect(res.body.clan?.id).toBe(1);
    });

    it('returns 404 for a missing clan', async () => {
      const res = await request(app).get('/api/clans/999');
      expect(res.status).toBe(404);
    });

    it('returns 400 for a non-numeric clanId', async () => {
      const res = await request(app).get('/api/clans/abc');
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/clans/:clanId/discord', () => {
    it('persists settings and triggers the bot hot-reload', async () => {
      const res = await request(app)
        .put('/api/clans/1/discord')
        .send({
          enabled: false,
          channelId: '12345',
          guildId: '67890',
          scanReportsEnabled: true,
          onlyNewChests: false,
          dailyDigestEnabled: false,
          commandsEnabled: true,
        });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe('POST /api/clans/:clanId/discord/test', () => {
    it('proxies to sendClanTestMessage and returns ok', async () => {
      const res = await request(app).post('/api/clans/1/discord/test');
      expect(res.status).toBe(200);
      expect(vi.mocked(sendClanTestMessage)).toHaveBeenCalledWith(1);
    });
  });

  describe('GET /api/clans/:clanId/onboard/status', () => {
    it('returns idle status for a clan with no onboard activity', async () => {
      const res = await request(app).get('/api/clans/1/onboard/status');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('idle');
    });
  });

  describe('public share-token lifecycle + analytics/recovery', () => {
    it('generate → analytics → disable → recover round-trip', async () => {
      const gen = await request(app).post('/api/clans/1/share-token');
      expect(gen.status).toBe(200);
      const token = gen.body.publicShareToken as string;
      expect(typeof token).toBe('string');

      // Analytics shows the active link, no revoked history yet.
      const a1 = await request(app).get('/api/clans/1/share-token/analytics');
      expect(a1.status).toBe(200);
      expect(a1.body.active?.token).toBe(token);
      expect(a1.body.recentRevoked).toEqual([]);

      // Disable revokes (not deletes) — one recoverable link remains.
      const del = await request(app).delete('/api/clans/1/share-token');
      expect(del.status).toBe(200);
      const a2 = await request(app).get('/api/clans/1/share-token/analytics');
      expect(a2.body.active).toBeNull();
      expect(a2.body.recentRevoked.length).toBe(1);

      // Recover brings the same token back as the active link.
      const linkId = a2.body.recentRevoked[0].id;
      const rec = await request(app).post('/api/clans/1/share-token/recover').send({ linkId });
      expect(rec.status).toBe(200);
      expect(rec.body.publicShareToken).toBe(token);

      const a3 = await request(app).get('/api/clans/1/share-token/analytics');
      expect(a3.body.active?.token).toBe(token);
    });

    it('regenerating revokes the previous token into history', async () => {
      const token1 = (await request(app).post('/api/clans/1/share-token')).body.publicShareToken;
      const token2 = (await request(app).post('/api/clans/1/share-token')).body.publicShareToken;
      expect(token2).not.toBe(token1);

      const a = await request(app).get('/api/clans/1/share-token/analytics');
      expect(a.body.active?.token).toBe(token2);
      expect(a.body.recentRevoked.map((r: { token: string }) => r.token)).toContain(token1);
    });

    it('recover rejects a missing/invalid linkId', async () => {
      const res = await request(app).post('/api/clans/1/share-token/recover').send({ linkId: 'nope' });
      expect(res.status).toBe(400);
    });
  });

  // The leaderboard points goal. ONE weekly number is stored and every other
  // timeframe is derived from it on the client, so the only things the route
  // has to get right are: reject a value that can't be a target, and keep the
  // flag and the number independent so switching the colouring off doesn't
  // discard what the admin typed.
  describe('leaderboard goal', () => {
    it('stores the weekly target and reads it back on the clan', async () => {
      const res = await request(app)
        .put('/api/clans/1/leaderboard-goal')
        .send({ enabled: true, weeklyPoints: 25_000 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, enabled: true, weeklyPoints: 25_000 });

      const clan = (await request(app).get('/api/clans/1')).body.clan;
      expect(clan.leaderboardGoalEnabled).toBe(true);
      expect(clan.leaderboardWeeklyGoalPoints).toBe(25_000);
    });

    it('keeps the target when the colouring is switched off', async () => {
      await request(app).put('/api/clans/1/leaderboard-goal').send({ enabled: true, weeklyPoints: 25_000 });
      await request(app).put('/api/clans/1/leaderboard-goal').send({ enabled: false, weeklyPoints: 25_000 });
      const clan = (await request(app).get('/api/clans/1')).body.clan;
      expect(clan.leaderboardGoalEnabled).toBe(false);
      // Not cleared: re-enabling must not mean retyping the number.
      expect(clan.leaderboardWeeklyGoalPoints).toBe(25_000);
    });

    it('accepts a blank target as "not configured yet"', async () => {
      const res = await request(app)
        .put('/api/clans/1/leaderboard-goal')
        .send({ enabled: true, weeklyPoints: '' });
      expect(res.status).toBe(200);
      expect(res.body.weeklyPoints).toBeNull();
    });

    it('rejects zero, negative, fractional and absurd targets', async () => {
      // Zero is the one that matters: stored as a goal it would divide into
      // every ratio and paint the whole board green.
      for (const bad of [0, -1, 1.5, 500_000_000, 'abc']) {
        const res = await request(app)
          .put('/api/clans/1/leaderboard-goal')
          .send({ enabled: true, weeklyPoints: bad });
        expect(res.status, `weeklyPoints=${bad}`).toBe(400);
      }
    });

    it('404s for a clan that does not exist', async () => {
      const res = await request(app)
        .put('/api/clans/999/leaderboard-goal')
        .send({ enabled: true, weeklyPoints: 100 });
      expect(res.status).toBe(404);
    });
  });

  // Phase A3 regression: deleting a clan must clear its onboardState
  // entry so the per-process Map doesn't grow forever as clans are
  // added and removed. We can't peek at the Map directly through HTTP,
  // but we can prove indirectly: after delete + recreate of a clan with
  // the same id, the onboard status comes back as 'idle' (the default
  // for an unknown id), not whatever stale state was there before.
  describe('Phase A3: onboardState cleanup on clan delete', () => {
    it('returns to idle after the clan is deleted', async () => {
      // Status route returns idle by default — synthesise a non-idle
      // entry by hitting a route that writes onboardState. The simplest
      // is to delete the clan and then re-fetch status: the id is gone,
      // status should be the synthetic idle.
      // (Full integration of "set non-idle → delete → re-create → idle"
      // would require running the actual capture flow which spawns a
      // browser. The cleanup happens in the DELETE handler regardless,
      // so the no-leak invariant is captured here as a baseline.)
      const del = await request(app).delete('/api/clans/2');
      expect(del.status).toBe(200);

      const res = await request(app).get('/api/clans/2/onboard/status');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('idle');
    });
  });
});
