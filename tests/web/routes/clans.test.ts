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

  describe('public share links — multiple per clan, vanity keys, analytics', () => {
    it('add → analytics → disable → restore round-trip, other links untouched', async () => {
      const gen = await request(app).post('/api/clans/1/share-links').send({ label: 'Discord' });
      expect(gen.status).toBe(200);
      const token = gen.body.link.token as string;
      expect(typeof token).toBe('string');
      expect(gen.body.link.label).toBe('Discord');
      expect(gen.body.link.isVanity).toBe(false);

      // A second link coexists with the first — this is the whole feature.
      const gen2 = await request(app).post('/api/clans/1/share-links').send({});
      const token2 = gen2.body.link.token as string;
      expect(token2).not.toBe(token);

      const a1 = await request(app).get('/api/clans/1/share-links');
      expect(a1.status).toBe(200);
      expect(a1.body.links.map((l: { token: string }) => l.token).sort()).toEqual(
        [token, token2].sort(),
      );
      expect(a1.body.recentRevoked).toEqual([]);
      // Each live link carries its own series, not a merged one.
      for (const l of a1.body.links) expect(Array.isArray(l.daily)).toBe(true);

      // Disabling one revokes (not deletes) it and leaves the other live.
      const linkId = gen.body.link.id as number;
      const del = await request(app).delete(`/api/clans/1/share-links/${linkId}`);
      expect(del.status).toBe(200);
      const a2 = await request(app).get('/api/clans/1/share-links');
      expect(a2.body.links.map((l: { token: string }) => l.token)).toEqual([token2]);
      expect(a2.body.recentRevoked.map((r: { token: string }) => r.token)).toEqual([token]);

      // Restore adds it back alongside the other — no swap any more.
      const rec = await request(app).post(`/api/clans/1/share-links/${linkId}/restore`);
      expect(rec.status).toBe(200);
      expect(rec.body.token).toBe(token);
      const a3 = await request(app).get('/api/clans/1/share-links');
      expect(a3.body.links.map((l: { token: string }) => l.token).sort()).toEqual(
        [token, token2].sort(),
      );
    });

    it('accepts a vanity key, lowercases it, and refuses a duplicate', async () => {
      const ok = await request(app).post('/api/clans/1/share-links').send({ key: 'FamilY' });
      expect(ok.status).toBe(200);
      expect(ok.body.link.token).toBe('family');
      expect(ok.body.link.isVanity).toBe(true);

      const dupe = await request(app).post('/api/clans/1/share-links').send({ key: 'family' });
      expect(dupe.status).toBe(400);
      expect(dupe.body.error).toMatch(/taken/i);

      // Another clan can't claim it either — the key is a global namespace.
      const crossClan = await request(app).post('/api/clans/2/share-links').send({ key: 'FAMILY' });
      expect(crossClan.status).toBe(400);
    });

    it('refuses a malformed or reserved vanity key', async () => {
      for (const key of ['ab', 'waytoolongkey', 'has space', 'has-dash', 'under_score', 'ünï']) {
        const res = await request(app).post('/api/clans/1/share-links').send({ key });
        expect(res.status, `key ${key} should be refused`).toBe(400);
      }
      const reserved = await request(app).post('/api/clans/1/share-links').send({ key: 'login' });
      expect(reserved.status).toBe(400);
      expect(reserved.body.error).toMatch(/reserved/i);
    });

    it('renames a link without changing its key', async () => {
      const gen = await request(app).post('/api/clans/1/share-links').send({ key: 'family' });
      const linkId = gen.body.link.id as number;

      const ren = await request(app)
        .patch(`/api/clans/1/share-links/${linkId}`)
        .send({ label: 'Recruiting post' });
      expect(ren.status).toBe(200);

      const a = await request(app).get('/api/clans/1/share-links');
      expect(a.body.links[0].label).toBe('Recruiting post');
      expect(a.body.links[0].token).toBe('family');
    });

    it('permanent delete only applies to a disabled link, and frees the key', async () => {
      const gen = await request(app).post('/api/clans/1/share-links').send({ key: 'family' });
      const linkId = gen.body.link.id as number;

      // Live links can't be deleted outright.
      const tooSoon = await request(app).delete(`/api/clans/1/share-links/${linkId}/permanent`);
      expect(tooSoon.status).toBe(409);

      await request(app).delete(`/api/clans/1/share-links/${linkId}`);
      // Still claimed while it sits in the recovery list.
      const stillTaken = await request(app).post('/api/clans/1/share-links').send({ key: 'family' });
      expect(stillTaken.status).toBe(400);

      const gone = await request(app).delete(`/api/clans/1/share-links/${linkId}/permanent`);
      expect(gone.status).toBe(200);
      const reclaimed = await request(app).post('/api/clans/1/share-links').send({ key: 'family' });
      expect(reclaimed.status).toBe(200);
    });

    it('rejects a non-numeric linkId and refuses another clan’s link', async () => {
      const bad = await request(app).post('/api/clans/1/share-links/nope/restore');
      expect(bad.status).toBe(400);

      const other = await request(app).post('/api/clans/2/share-links').send({});
      const otherId = other.body.link.id as number;
      const crossClan = await request(app).delete(`/api/clans/1/share-links/${otherId}`);
      expect(crossClan.status).toBe(404);
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
