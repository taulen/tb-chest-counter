// Read-path smoke coverage for api.ts.
//
// Goal: every GET endpoint that touches the DB returns 200 against a
// freshly-seeded test database. We don't assert deeply on response
// shape — that's a separate concern. We're catching the class of bug
// where a query references a column that no longer exists post-
// migration (analytics, triumphal, etc.), which silently 500'd
// against the live DB but was missed by the targeted unit suites.
//
// The seeded fixture is the small one in tests/helpers/test-db.ts:
// 2 members, 2 chests, 2 sources, 3 chest_records, 1 triumphal row.
// That's enough to exercise every JOIN and GROUP BY in the read
// paths without forcing each test to set up its own data.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Same neighbour-stub strategy as clans.test.ts. None of the
// /api/* GET routes we care about reach into Discord, the browser
// launcher, or the scan loop, but the api.ts file does import them
// at module top-level so the mocks have to exist before
// createApiRouter is loaded.
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
  ScanLoop: class {
    getNextScanAt() { return null; }
    getNextScanAtForClan() { return null; }
    isScanInProgress() { return false; }
    isPaused() { return false; }
    getProgressMessage() { return ''; }
    getLiveChestCount() { return 0; }
    getLastScanError() { return null; }
    getActiveClanId() { return 1; }
    getState() { return 'IDLE'; }
    getScanIntervalMs() { return 60_000; }
  },
}));

vi.mock('../../../src/web/login-bridge.js', () => ({
  loginBridge: {
    getStatus: () => ({ active: false }),
  },
}));

vi.mock('../../../src/config/index.js', () => ({
  loadConfig: () => ({
    gameDayRolloverUtcHour: 17,
    scanDebugFirstN: 0,
    scanIntervalMs: 60 * 60 * 1000,
    screenshotRetentionDays: 7,
    scanCropLeftPct: 0, scanCropTopPct: 0,
    scanCropRightPct: 0, scanCropBottomPct: 0,
    scanOpenButtonXPct: 0, scanOpenButtonYPct: 0,
    uiClanButtonXPct: 0, uiClanButtonYPct: 0,
    uiGiftsSidebarXPct: 0, uiGiftsSidebarYPct: 0,
    uiMembersSidebarXPct: 0, uiMembersSidebarYPct: 0,
    uiGiftsTabXPct: 0, uiGiftsTabYPct: 0,
    uiTriumphalTabXPct: 0, uiTriumphalTabYPct: 0,
    memberListCropLeftPct: 0, memberListCropTopPct: 0,
    memberListCropRightPct: 0, memberListCropBottomPct: 0,
  }),
  resetConfig: vi.fn(),
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
  SESSION_COOKIE_NAME: 'session',
}));

import { createApiRouter } from '../../../src/web/routes/api.js';
import { makeTestDb, seedChestData } from '../../helpers/test-db.js';
import { createUser } from '../../../src/data/repositories/user-repo.js';

describe('api.ts GET endpoints — read-path smoke coverage', () => {
  let cleanup: () => void;
  let app: express.Express;
  let seed: ReturnType<typeof seedChestData>;

  beforeEach(() => {
    const t = makeTestDb();
    cleanup = t.cleanup;
    seed = seedChestData(1);
    createUser('test-admin', 'irrelevant-pw-1234', 'superadmin');

    app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());
  });

  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  // Each test asserts only `status === 200` and either an array or an
  // object body — we're guarding the class of regression where a
  // schema change made a query reference a missing column. Deeper
  // shape assertions belong in the per-repo unit tests.

  describe('overview + status', () => {
    it('GET /api/stats', async () => {
      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        totalChests: expect.any(Number),
        totalPoints: expect.any(Number),
      });
    });
  });

  describe('chests', () => {
    it('GET /api/chests (recent)', async () => {
      const res = await request(app).get('/api/chests?limit=10');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('GET /api/chests/by-name/:name/members', async () => {
      const res = await request(app).get('/api/chests/by-name/Common%20Chest/members');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('chestName');
      expect(res.body).toHaveProperty('members');
    });

    it('GET /api/chests/by-name/:name/history', async () => {
      const res = await request(app)
        .get(`/api/chests/by-name/Common%20Chest/history?memberId=${seed.members.alice}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('records');
    });
  });

  describe('members', () => {
    it('GET /api/members', async () => {
      const res = await request(app).get('/api/members');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('GET /api/members/:id', async () => {
      const res = await request(app).get(`/api/members/${seed.members.alice}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('name');
    });

    it('GET /api/members/:id/chests', async () => {
      const res = await request(app).get(`/api/members/${seed.members.alice}/chests`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('chests');
      expect(Array.isArray(res.body.chests)).toBe(true);
    });
  });

  describe('leaderboard', () => {
    it('GET /api/leaderboard', async () => {
      const res = await request(app).get('/api/leaderboard');
      expect(res.status).toBe(200);
      // A bare ARRAY, deliberately: the Dashboard's "Weekly Top Contributors"
      // card consumes this response as one. That is why the points goal got its
      // own endpoint below instead of being folded in as a sibling field.
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('GET /api/leaderboard/goal — null when the clan has no goal set', async () => {
      const res = await request(app).get('/api/leaderboard/goal');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ weeklyPoints: null });
    });
  });

  describe('triumphal — would have caught D4 bugs #2 and #4', () => {
    it('GET /api/triumphal/leaderboard', async () => {
      const res = await request(app).get('/api/triumphal/leaderboard');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('GET /api/triumphal/chests', async () => {
      const res = await request(app).get('/api/triumphal/chests?limit=10');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('GET /api/triumphal/stats', async () => {
      const res = await request(app).get('/api/triumphal/stats');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        totalChests: expect.any(Number),
        uniqueMembers: expect.any(Number),
      });
    });
  });

  describe('sessions', () => {
    it('GET /api/sessions', async () => {
      const res = await request(app).get('/api/sessions');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('GET /api/sessions/:id', async () => {
      const res = await request(app).get(`/api/sessions/${seed.sessionId}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('session');
      expect(res.body).toHaveProperty('chests');
      expect(res.body).toHaveProperty('triumphalChests');
    });
  });

  describe('analytics — would have caught D4 bug #1', () => {
    it('GET /api/analytics/summary', async () => {
      const res = await request(app).get('/api/analytics/summary');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('bySource');
      expect(res.body).toHaveProperty('byType');
      expect(res.body).toHaveProperty('byName');
      expect(Array.isArray(res.body.bySource)).toBe(true);
      expect(Array.isArray(res.body.byType)).toBe(true);
      expect(Array.isArray(res.body.byName)).toBe(true);
    });

    it('GET /api/analytics/single-day-records', async () => {
      const res = await request(app).get('/api/analytics/single-day-records');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('byChests');
      expect(res.body).toHaveProperty('byPoints');
    });

    it('GET /api/analytics/daily', async () => {
      const res = await request(app).get('/api/analytics/daily?days=7');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('rolloverUtcHour');
      expect(res.body).toHaveProperty('days');
    });

    it('GET /api/analytics/top-contributors', async () => {
      const res = await request(app).get('/api/analytics/top-contributors?limit=5');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('topChests');
      expect(res.body).toHaveProperty('topPoints');
    });

    it('GET /api/members/:id accepts a window and scopes stats to it', async () => {
      const wide = await request(app)
        .get('/api/members/1?from=' + new Date(0).toISOString()
          + '&to=' + new Date(Date.now() + 86_400_000).toISOString());
      expect(wide.status).toBe(200);
      expect(wide.body.stats).toBeTruthy();

      // A window that ended before the fixture data begins must be empty, not
      // silently all-time — the failure mode if from/to are ignored.
      const empty = await request(app)
        .get('/api/members/1?from=' + new Date(0).toISOString()
          + '&to=' + new Date(1000).toISOString());
      expect(empty.status).toBe(200);
      expect(empty.body.stats.totalChests).toBe(0);
      // Weekly progress is deliberately NOT scoped by the window.
      expect(empty.body.progress).toBeTruthy();
    });

    it('GET /api/members/:id reports the rank gap either side', async () => {
      const res = await request(app).get('/api/members/1');
      expect(res.status).toBe(200);
      const n = res.body.neighbours;
      expect(n).toBeTruthy();
      expect(typeof n.points).toBe('number');
      // Whichever side exists must carry a non-negative gap: the board is
      // sorted, so "behind" and "ahead" can never be negative distances.
      if (n.above) expect(n.above.gap).toBeGreaterThanOrEqual(0);
      if (n.below) expect(n.below.gap).toBeGreaterThanOrEqual(0);
      // Rank 1 has nobody above; last place has nobody below.
      if (res.body.rank === 1) expect(n.above).toBeNull();
      if (res.body.rank === res.body.totalRanked) expect(n.below).toBeNull();
    });

    it('GET /api/leaderboard?format=csv returns a CSV attachment', async () => {
      const res = await request(app).get('/api/leaderboard?includeAll=1&format=csv');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');
      const [header, ...rows] = res.text.trim().split('\n');
      // Frozen header: something out there will be parsing this by column.
      expect(header).toBe('rank,member,chests,points,might,hero_level');
      expect(rows.length).toBeGreaterThan(0);
      // Same window, same exclusions as the JSON board.
      const json = await request(app).get('/api/leaderboard?includeAll=1');
      expect(rows.length).toBe(json.body.length);
    });

    it('GET /api/leaderboard still answers JSON without format=csv', async () => {
      const res = await request(app).get('/api/leaderboard?includeAll=1');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('GET /api/admin/scan-health returns a series', async () => {
      const res = await request(app).get('/api/admin/scan-health?limit=10');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.scans)).toBe(true);
    });

    it('GET /api/events/:key/series answers for a schedule-less event', async () => {
      // Citadels has no calendar names, so there are no occurrences to compare.
      // That is an empty series, not an error — the card simply doesn't draw.
      const res = await request(app).get('/api/events/citadels/series');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.runs)).toBe(true);
    });

    it('GET /api/events/:key/series 404s on an unknown event', async () => {
      const res = await request(app).get('/api/events/not-an-event/series');
      expect(res.status).toBe(404);
    });

    it('GET /api/analytics/window (all time)', async () => {
      const res = await request(app).get('/api/analytics/window');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('rolloverUtcHour');
      expect(res.body.current).toHaveProperty('totals');
      expect(res.body.current).toHaveProperty('days');
      expect(res.body.current).toHaveProperty('byType');
      expect(res.body.current).toHaveProperty('bySource');
      expect(res.body.current).toHaveProperty('byName');
      expect(res.body.current).toHaveProperty('contributors');
      // No window means no equal-length window before it to compare against.
      expect(res.body.previous).toBeNull();
    });

    it('GET /api/analytics/window (windowed, compare)', async () => {
      const to = new Date().toISOString();
      const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const res = await request(app)
        .get('/api/analytics/window?from=' + from + '&to=' + to + '&compare=1');
      expect(res.status).toBe(200);
      expect(res.body.current.fromDay).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
      expect(res.body.current.toDay).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
      // previous is summary-only by design: totals + days, no breakdowns.
      expect(res.body.previous).not.toBeNull();
      expect(res.body.previous).toHaveProperty('totals');
      expect(res.body.previous).toHaveProperty('days');
      expect(res.body.previous.byName).toBeUndefined();
      // and it abuts the current window without overlapping it.
      expect(res.body.previous.toDay < res.body.current.fromDay).toBe(true);
    });

    it('GET /api/analytics/window degrades to all-time on an invalid date', async () => {
      const res = await request(app).get('/api/analytics/window?from=nonsense&to=alsononsense');
      expect(res.status).toBe(200);
      expect(res.body.current.fromDay).toBeNull();
    });
  });

  describe('admin read paths', () => {
    it('GET /api/admin/merge-rules', async () => {
      const res = await request(app).get('/api/admin/merge-rules');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('GET /api/admin/source-points', async () => {
      const res = await request(app).get('/api/admin/source-points');
      expect(res.status).toBe(200);
      // Shape varies by version; tolerate either array or {sources}.
      expect(res.body).toBeTruthy();
    });

    it('GET /api/admin/review-queue', async () => {
      const res = await request(app).get('/api/admin/review-queue');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('chestNames');
      expect(res.body).toHaveProperty('chestSources');
      expect(res.body).toHaveProperty('members');
    });

    it('GET /api/admin/unique-chests', async () => {
      const res = await request(app).get('/api/admin/unique-chests');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('GET /api/admin/unique-sources', async () => {
      const res = await request(app).get('/api/admin/unique-sources');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('GET /api/admin/member-chest-counts', async () => {
      const res = await request(app).get('/api/admin/member-chest-counts');
      expect(res.status).toBe(200);
      // memberId → count map; every value must be a number, because the
      // admin dropdowns render it directly and a string would read as NaN.
      expect(typeof res.body).toBe('object');
      expect(Array.isArray(res.body)).toBe(false);
      for (const v of Object.values(res.body)) expect(typeof v).toBe('number');
    });

    it('GET /api/admin/unknown-chests', async () => {
      const res = await request(app).get('/api/admin/unknown-chests');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });
});
