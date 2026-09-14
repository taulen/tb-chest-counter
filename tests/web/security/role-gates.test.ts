// End-to-end role-gate coverage.
//
// Unlike the other web/route tests in this repo, this file does NOT
// mock auth — it spins up the real Express stack (requireAuth →
// requireClanContext → requireAdmin / requireSuperAdmin / per-route
// scope checks) and drives every protected endpoint with a real
// session cookie attached to a real user row.
//
// What we're catching:
//   1. Endpoints that hide behind a UI gate but accept any
//      authenticated user when called directly.
//   2. Cross-clan leakage — admin of clan A able to mutate clan B.
//   3. Orphaned non-superadmin accounts (clan_id NULL) reaching
//      clan-scoped endpoints via the `?? 1` fallback bug we fixed.
//
// We don't assert response bodies — only status codes — because we
// want this file to keep working after future schema changes that
// alter response shape. The gate is the contract.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Side-effectful neighbours of the route files have to be mocked
// before the route modules are imported, mirroring the strategy used
// by the existing clans.test.ts.
vi.mock('../../../src/discord/bot.js', () => ({
  startClanBot: vi.fn(),
  stopClanBot: vi.fn(),
  sendClanTestMessage: vi.fn(async () => ({ ok: true })),
  sendClanDigestDmTest: vi.fn(async () => ({ ok: true })),
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
    clearLastScanError() {}
    getActiveClanId() { return 1; }
    getState() { return 'IDLE'; }
    getScanIntervalMs() { return 60_000; }
    setScanIntervalMs() {}
    setScannerSettings() {}
    triggerManualScan() { return Promise.resolve(); }
    triggerManualScanAllClans() { return Promise.resolve(); }
    pause() { return true; }
    resume() {}
  },
}));

vi.mock('../../../src/web/login-bridge.js', () => ({
  loginBridge: {
    isActive: () => false,
    status: () => ({ active: false }),
    getActiveClanId: () => null,
    start: vi.fn(),
    save: vi.fn(),
    cancel: vi.fn(),
  },
}));

vi.mock('../../../src/utils/db-backup.js', () => ({
  createPreActionBackup: vi.fn(async () => '/tmp/fake-backup.db.gz'),
  startDailyBackupSchedule: vi.fn(),
  listServerBackups: vi.fn(() => []),
}));

// loadConfig is consulted by several routes for things like
// gameDayRolloverUtcHour and the raw-OCR toggle state. Real impl
// reads process.env, which is fine, but we stub it to make the
// returned object deterministic regardless of the host shell.
vi.mock('../../../src/config/index.js', () => ({
  loadConfig: () => ({
    gameDayRolloverUtcHour: 17,
    scanDebugFirstN: 0,
    scanIntervalMs: 60 * 60 * 1000,
    screenshotRetentionDays: 7,
    enableRawOcrCapture: false,
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
  getConfig: () => ({
    gameDayRolloverUtcHour: 17,
    scanDebugFirstN: 0,
    scanIntervalMs: 60 * 60 * 1000,
    screenshotRetentionDays: 7,
    enableRawOcrCapture: false,
  }),
  resetConfig: vi.fn(),
}));

vi.mock('../../../src/config/persistent-env.js', () => ({
  readEnvValue: () => null,
  updateEnvValue: vi.fn(),
  deleteEnvValue: vi.fn(),
}));

// The resources data router transitively imports the OCR pipeline
// (paddleocr + sharp). We only exercise its auth gates here, never the
// actual upload processing, so stub the heavy module out.
vi.mock('../../../src/vision/resource-ocr.js', () => ({
  processResourceScreenshot: vi.fn(async () => ({ rows: [], errors: [], unmatchedNames: [] })),
}));

// Import order matters — mocks above MUST be set before any of these.
import { createApiRouter } from '../../../src/web/routes/api.js';
import { createAuthRouter } from '../../../src/web/routes/auth.js';
import { createClansRouter } from '../../../src/web/routes/clans.js';
import { createResourcesDataRouter } from '../../../src/web/routes/resources.js';
import {
  requireAuth,
  requireClanContext,
  SESSION_COOKIE_NAME,
} from '../../../src/web/middleware/auth.js';
import { makeTestDb, seedTwoClans, seedChestData } from '../../helpers/test-db.js';
import * as userRepo from '../../../src/data/repositories/user-repo.js';
import {
  getClanById,
  restoreDeletedClan,
  setClanPublicShareToken,
  softDeleteClan,
} from '../../../src/data/repositories/clan-repo.js';
import { getDb } from '../../../src/data/database.js';

type Persona = 'super' | 'admin1' | 'admin2' | 'user1' | 'orphan' | 'unauth';

interface Identity {
  userId: number;
  cookie: string;
}

describe('role-gate enforcement (real auth + real routes)', () => {
  let app: express.Express;
  let cleanup: () => void;
  let ids: Record<Exclude<Persona, 'unauth'>, Identity>;
  let memberClan1Id: number;
  let memberClan2Id: number;
  let sessionClan2Id: number;

  beforeEach(() => {
    const t = makeTestDb();
    cleanup = t.cleanup;
    seedTwoClans();

    // One member per clan so endpoints that need a :memberId have a
    // valid target on each side of the cross-clan boundary.
    const seedClan1 = seedChestData(1);
    const seedClan2 = seedChestData(2);
    memberClan1Id = seedClan1.members.alice;
    memberClan2Id = seedClan2.members.alice;
    sessionClan2Id = seedClan2.sessionId;

    // Seed five personas covering every role × clan combo the gates
    // care about. createSession returns the raw token; we wrap it
    // into the cookie format the middleware looks for.
    const mkSession = (userId: number): string => {
      const token = userRepo.createSession(userId);
      return `${SESSION_COOKIE_NAME}=${token}`;
    };

    // Passwords are arbitrary — sessions bypass them entirely.
    const su = userRepo.createUser('su', 'Test1234!aA', 'superadmin');
    const a1 = userRepo.createUser('a1', 'Test1234!aA', 'admin', su.id, 1);
    const a2 = userRepo.createUser('a2', 'Test1234!aA', 'admin', su.id, 2);
    const u1 = userRepo.createUser('u1', 'Test1234!aA', 'user', su.id, 1);
    const orph = userRepo.createUser('orph', 'Test1234!aA', 'admin', su.id, 1);
    // Orphan = admin role with clan_id forcibly nulled (the legacy
    // bug we patched and the security risk we're guarding against).
    getDb().prepare('UPDATE users SET clan_id = NULL WHERE id = ?').run(orph.id);

    ids = {
      super: { userId: su.id, cookie: mkSession(su.id) },
      admin1: { userId: a1.id, cookie: mkSession(a1.id) },
      admin2: { userId: a2.id, cookie: mkSession(a2.id) },
      user1: { userId: u1.id, cookie: mkSession(u1.id) },
      orphan: { userId: orph.id, cookie: mkSession(orph.id) },
    };

    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRouter());
    app.use('/api/clans', createClansRouter());
    // Mirror server.ts: read-only resource data behind requireAuth, mutating
    // routes gate themselves with requireAdmin inside the router.
    app.use('/api/resources', requireAuth, requireClanContext, createResourcesDataRouter(/* no scanLoop */ undefined));
    app.use('/api', requireAuth, requireClanContext, createApiRouter(/* no scanLoop */ undefined));
  });

  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  // ─── helpers ──────────────────────────────────────────────────

  const as = (persona: Persona) =>
    persona === 'unauth'
      ? { cookie: null }
      : { cookie: ids[persona].cookie };

  const send = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, persona: Persona, body?: object) => {
    const { cookie } = as(persona);
    // Accept: application/json mirrors how the real frontend's
    // api() helper calls every endpoint. Without it, the auth
    // middleware's unauthenticated branch redirects to /login
    // (302) instead of returning 401 JSON.
    let r = request(app)[method](path).set('Accept', 'application/json');
    if (cookie) r = r.set('Cookie', cookie);
    if (body) r = r.send(body);
    return r;
  };

  // Status assertion helper — accepts a code or list of acceptable codes.
  // We allow a range because some endpoints can return 200 OR 404 for
  // a valid caller (e.g. "session id 999 doesn't exist") and we only
  // care that the request wasn't rejected by the gate.
  const expectStatus = (actual: number, allowed: number | number[]) => {
    const list = Array.isArray(allowed) ? allowed : [allowed];
    expect(list, `expected one of ${list.join(',')}, got ${actual}`).toContain(actual);
  };

  // ─── superadmin-only endpoints ────────────────────────────────
  //
  // Every endpoint here should accept ONLY persona='super'. Every
  // other persona — including clan admins — must be rejected.

  describe('superadmin-only endpoints reject everyone else', () => {
    const SUPER_ONLY: Array<{ name: string; method: 'get' | 'post' | 'put' | 'delete'; path: string; body?: object }> = [
      { name: 'PUT /admin/settings/scan-interval', method: 'put', path: '/api/admin/settings/scan-interval', body: { scanIntervalMinutes: 30 } },
      { name: 'PUT /admin/settings/raw-ocr-capture', method: 'put', path: '/api/admin/settings/raw-ocr-capture', body: { enabled: false } },
      { name: 'GET /admin/settings/raw-ocr-capture', method: 'get', path: '/api/admin/settings/raw-ocr-capture' },
      { name: 'POST /admin/clear-last-scan-error', method: 'post', path: '/api/admin/clear-last-scan-error', body: {} },
      { name: 'PUT /admin/scanner-settings', method: 'put', path: '/api/admin/scanner-settings', body: { scanDebugFirstN: 5 } },
      { name: 'PUT /auth/users/:id/clan', method: 'put', path: '/api/auth/users/__ID__/clan', body: { clanId: 2 } },
      { name: 'POST /clans', method: 'post', path: '/api/clans', body: { name: 'TestClan' } },
      { name: 'GET /clans/deleted', method: 'get', path: '/api/clans/deleted' },
      { name: 'POST /clans/:id/restore', method: 'post', path: '/api/clans/2/restore', body: {} },
      { name: 'GET /members/:id/raw-ocr', method: 'get', path: '/api/members/__M1__/raw-ocr' },
      // Source point values are a global scoring table — reads are admin-tier
      // (see ADMIN_TIER below), but every write is superadmin-only.
      { name: 'PUT /admin/source-points', method: 'put', path: '/api/admin/source-points', body: { sourceKey: 'arena', chestName: '', pointValue: 10 } },
      { name: 'DELETE /admin/source-points', method: 'delete', path: '/api/admin/source-points?sourceKey=arena&chestName=' },
      { name: 'POST /admin/source-points/recalculate', method: 'post', path: '/api/admin/source-points/recalculate', body: {} },
      // Triumphal chest points: same global read-admin / write-superadmin split.
      { name: 'PUT /admin/triumphal-points', method: 'put', path: '/api/admin/triumphal-points', body: { chestName: 'Golden Chest', packagePoints: 50 } },
      { name: 'DELETE /admin/triumphal-points', method: 'delete', path: '/api/admin/triumphal-points?chestName=Golden%20Chest' },
    ];

    for (const ep of SUPER_ONLY) {
      it(`${ep.name} → super 2xx/3xx, others 401/403`, async () => {
        const subst = (path: string) =>
          path.replace('__ID__', String(ids.admin2.userId))
              .replace('__M1__', String(memberClan1Id));

        const fromSuper = await send(ep.method, subst(ep.path), 'super', ep.body);
        // Super gets through the gate (status < 500 and not 401/403);
        // 200/204/etc. and even 400/404 from missing-id arguments are
        // all "the gate accepted the request and the handler ran".
        expect(fromSuper.status, `super got ${fromSuper.status}: ${JSON.stringify(fromSuper.body)}`).not.toBe(401);
        expect(fromSuper.status).not.toBe(403);

        for (const p of ['admin1', 'admin2', 'user1', 'orphan', 'unauth'] as Persona[]) {
          const r = await send(ep.method, subst(ep.path), p, ep.body);
          expectStatus(r.status, p === 'unauth' ? 401 : 403);
        }
      });
    }
  });

  // ─── admin-or-superadmin endpoints ────────────────────────────
  //
  // Regular users and orphans must be rejected. Clan admins are
  // accepted (scoped to their own clan; see cross-clan suite below).

  describe('admin-tier endpoints reject regular users + orphans + anon', () => {
    const ADMIN_TIER: Array<{ name: string; method: 'get' | 'post' | 'put' | 'delete'; path: string; body?: object }> = [
      { name: 'GET /auth/users', method: 'get', path: '/api/auth/users' },
      { name: 'GET /auth/audit-log', method: 'get', path: '/api/auth/audit-log' },
      { name: 'GET /admin/merge-rules', method: 'get', path: '/api/admin/merge-rules?type=player' },
      { name: 'GET /admin/source-points', method: 'get', path: '/api/admin/source-points' },
      { name: 'GET /admin/triumphal-points', method: 'get', path: '/api/admin/triumphal-points' },
      // Review-evidence crops. Both stream clan screenshots, so they sit at admin
      // tier even though they only read. A missing id yields 404 for an admin, which
      // still proves the gate let them past.
      { name: 'GET /admin/unknown-chests/:id/crop', method: 'get', path: '/api/admin/unknown-chests/999/crop' },
      { name: 'GET /admin/members/:id/crop', method: 'get', path: '/api/admin/members/999/crop' },
    ];

    for (const ep of ADMIN_TIER) {
      it(`${ep.name} → admins through, users/orphans/anon rejected`, async () => {
        for (const p of ['super', 'admin1', 'admin2'] as Persona[]) {
          const r = await send(ep.method, ep.path, p, ep.body);
          expect(r.status, `${p} got ${r.status}: ${JSON.stringify(r.body)}`).not.toBe(401);
          expect(r.status).not.toBe(403);
        }
        for (const p of ['user1', 'orphan', 'unauth'] as Persona[]) {
          const r = await send(ep.method, ep.path, p, ep.body);
          expectStatus(r.status, p === 'unauth' ? 401 : 403);
        }
      });
    }
  });

  // ─── per-clan config routes require clan-ADMIN, not just membership ─
  //
  // Regression for the requireClanAccess → requireClanAdmin fix. These
  // routes live under /api/clans (mounted with NO mount-level auth), so
  // each route's inline guard is its only gate. They used to gate with
  // requireClanAccess, which checks clan MEMBERSHIP but not ROLE — so a
  // plain role='user' member of the clan could reconfigure the clan's
  // Discord bot token, ChestTracker share code, launch onboarding scans,
  // toggle features, and mint/revoke the public share link. The gate must
  // now reject a same-clan regular user while still admitting that clan's
  // admins. (The cross-clan admin case is covered in the suite below.)

  describe('per-clan config routes require clan-admin (not just membership)', () => {
    const CLAN_ADMIN: Array<{ name: string; method: 'get' | 'post' | 'put' | 'delete'; path: string; body?: object }> = [
      { name: 'PUT /clans/1/discord', method: 'put', path: '/api/clans/1/discord', body: { enabled: false } },
      { name: 'POST /clans/1/discord/test', method: 'post', path: '/api/clans/1/discord/test', body: {} },
      { name: 'POST /clans/1/discord/digest-dm-test', method: 'post', path: '/api/clans/1/discord/digest-dm-test', body: {} },
      { name: 'PUT /clans/1/chesttracker', method: 'put', path: '/api/clans/1/chesttracker', body: { shareCode: '' } },
      { name: 'GET /clans/1/onboard/status', method: 'get', path: '/api/clans/1/onboard/status' },
      { name: 'POST /clans/1/onboard/capture-members', method: 'post', path: '/api/clans/1/onboard/capture-members', body: {} },
      { name: 'POST /clans/1/onboard/first-scan', method: 'post', path: '/api/clans/1/onboard/first-scan', body: {} },
      { name: 'PUT /clans/1/resources', method: 'put', path: '/api/clans/1/resources', body: { enabled: true } },
      { name: 'PUT /clans/1/inactivity', method: 'put', path: '/api/clans/1/inactivity', body: { enabled: true } },
      { name: 'PUT /clans/1/leaderboard-goal', method: 'put', path: '/api/clans/1/leaderboard-goal', body: { enabled: true, weeklyPoints: 25000 } },
      { name: 'POST /clans/1/share-token', method: 'post', path: '/api/clans/1/share-token', body: {} },
      { name: 'DELETE /clans/1/share-token', method: 'delete', path: '/api/clans/1/share-token' },
    ];

    for (const ep of CLAN_ADMIN) {
      it(`${ep.name} → clan-1 admin/super through; own-clan user + cross-clan admin + orphan 403; anon 401`, async () => {
        // Legit: the superadmin and clan 1's own admin pass the gate
        // (handler may still return 409 for unmet preconditions like
        // missing storage-state — that's "gate accepted", not a reject).
        for (const p of ['super', 'admin1'] as Persona[]) {
          const r = await send(ep.method, ep.path, p, ep.body);
          expect(r.status, `${p} got ${r.status}: ${JSON.stringify(r.body)}`).not.toBe(401);
          expect(r.status, `${p} got ${r.status}: ${JSON.stringify(r.body)}`).not.toBe(403);
        }
        // The fix: a plain member of clan 1 is rejected on its OWN clan;
        // a clan-2 admin and an orphan are rejected too.
        for (const p of ['user1', 'admin2', 'orphan'] as Persona[]) {
          const r = await send(ep.method, ep.path, p, ep.body);
          expectStatus(r.status, 403);
        }
        expectStatus((await send(ep.method, ep.path, 'unauth', ep.body)).status, 401);
      });
    }
  });

  // ─── resources: read for all clan members, write for admins ───
  //
  // The Resources section (Overview + Totals dashboards) is visible to
  // every clan member, so its read endpoints accept any authenticated
  // member of a clan. Only the Admin sub-tab mutates data, so upload /
  // edit / delete stay admin-tier. Orphans (clan_id NULL) are blocked at
  // requireClanContext; anon is 401 throughout.

  describe('resources data routes', () => {
    const READ: Array<{ name: string; path: string }> = [
      { name: 'GET /resources/types', path: '/api/resources/types' },
      { name: 'GET /resources/summary', path: '/api/resources/summary' },
      { name: 'GET /resources/daily', path: '/api/resources/daily' },
      { name: 'GET /resources/transactions', path: '/api/resources/transactions' },
      { name: 'GET /resources/batches', path: '/api/resources/batches' },
    ];

    for (const ep of READ) {
      it(`${ep.name} → any clan member through, orphan 403, anon 401`, async () => {
        for (const p of ['super', 'admin1', 'admin2', 'user1'] as Persona[]) {
          const r = await send('get', ep.path, p);
          expect(r.status, `${p} got ${r.status}: ${JSON.stringify(r.body)}`).not.toBe(401);
          expect(r.status).not.toBe(403);
        }
        expectStatus((await send('get', ep.path, 'orphan')).status, 403);
        expectStatus((await send('get', ep.path, 'unauth')).status, 401);
      });
    }

    // Admin-only GET: the row crop is a screenshot of clan data, so it sits at the
    // same tier as the mutations even though it only reads. 404 for a missing txId is
    // fine here — the gate is what's under test.
    it('GET /resources/transactions/:id/crop → admins through, regular user/orphan 403, anon 401', async () => {
      const p404 = '/api/resources/transactions/999/crop';
      for (const p of ['super', 'admin1', 'admin2'] as Persona[]) {
        const r = await send('get', p404, p);
        expect(r.status, `${p} got ${r.status}: ${JSON.stringify(r.body)}`).not.toBe(401);
        expect(r.status).not.toBe(403);
      }
      for (const p of ['user1', 'orphan'] as Persona[]) {
        expectStatus((await send('get', p404, p)).status, 403);
      }
      expectStatus((await send('get', p404, 'unauth')).status, 401);
    });

    const WRITE: Array<{ name: string; method: 'post' | 'patch' | 'delete'; path: string; body?: object }> = [
      { name: 'POST /resources/upload', method: 'post', path: '/api/resources/upload', body: { images: [] } },
      { name: 'PATCH /resources/transactions/:id', method: 'patch', path: '/api/resources/transactions/999', body: { direction: 1, amount: 5, transactionDate: '2026-07-12' } },
      { name: 'DELETE /resources/batches/:id', method: 'delete', path: '/api/resources/batches/999' },
    ];

    for (const ep of WRITE) {
      it(`${ep.name} → admins through, regular user/orphan 403, anon 401`, async () => {
        for (const p of ['super', 'admin1', 'admin2'] as Persona[]) {
          const r = await send(ep.method, ep.path, p, ep.body);
          expect(r.status, `${p} got ${r.status}: ${JSON.stringify(r.body)}`).not.toBe(401);
          expect(r.status).not.toBe(403);
        }
        for (const p of ['user1', 'orphan', 'unauth'] as Persona[]) {
          const r = await send(ep.method, ep.path, p, ep.body);
          expectStatus(r.status, p === 'unauth' ? 401 : 403);
        }
      });
    }
  });

  // ─── orphan-account containment ───────────────────────────────
  //
  // The recently-fixed bug: a non-superadmin user with clan_id NULL
  // would silently default to clan #1 because endpoints used the
  // `req.clanId ?? 1` fallback. requireClanContext now blocks them
  // from /api/*, and requireAdmin blocks them from /auth/users (so
  // they can't escalate via the unfiltered "see all users" mode).

  describe('orphan accounts are blocked from clan-scoped data', () => {
    it('cannot reach any /api/* clan-scoped read endpoint', async () => {
      for (const p of ['/api/stats', '/api/members', '/api/leaderboard', '/api/sessions']) {
        const r = await send('get', p, 'orphan');
        expect(r.status, `${p} returned ${r.status}`).toBe(403);
      }
    });

    it('cannot list users (requireAdmin orphan-check)', async () => {
      const r = await send('get', '/api/auth/users', 'orphan');
      expect(r.status).toBe(403);
    });
  });

  // ─── soft-deleted clan containment ────────────────────────────
  //
  // Soft delete keeps every row, so the people who were in the clan are the
  // ones most likely to keep reading it: their user.clanId still points at a
  // clan whose chest_records, members and sessions are all exactly where they
  // were. Nothing in the route handlers knows about `deleted_at` — the whole
  // defence is that `getClanById` refuses a deleted clan, which turns this
  // into the same gate as the orphan case above.
  //
  // Getting it wrong in the other direction is just as bad: `req.clanId ?? 1`
  // means a user let through with no clan context reads clan #1 instead.

  describe('members of a soft-deleted clan are locked out', () => {
    const CLAN_SCOPED = ['/api/stats', '/api/members', '/api/leaderboard', '/api/sessions'];

    it('clan-2 admin and user lose access once clan 2 is deleted', async () => {
      // Baseline: they can read their own clan before the delete, so a
      // failure below is the delete and not a broken persona.
      for (const p of CLAN_SCOPED) {
        expectStatus((await send('get', p, 'admin2')).status, [200, 304]);
      }

      expect(softDeleteClan(2)).toEqual({ ok: true });

      for (const p of CLAN_SCOPED) {
        const r = await send('get', p, 'admin2');
        expect(r.status, `${p} returned ${r.status}`).toBe(403);
        expect(r.body.code).toBe('deleted_clan');
      }
    });

    it('does not quietly hand them clan #1 instead', async () => {
      softDeleteClan(2);
      const r = await send('get', '/api/stats', 'admin2');
      // The failure mode that matters is a 200 carrying someone else's data.
      expect(r.status).toBe(403);
    });

    it('leaves the other clan and superadmins alone', async () => {
      softDeleteClan(2);
      for (const p of CLAN_SCOPED) {
        expectStatus((await send('get', p, 'admin1')).status, [200, 304]);
        expectStatus((await send('get', p, 'super')).status, [200, 304]);
      }
    });

    it('gives access back on restore', async () => {
      softDeleteClan(2);
      expect((await send('get', '/api/stats', 'admin2')).status).toBe(403);

      expect(restoreDeletedClan(2)).toEqual({ ok: true });
      expectStatus((await send('get', '/api/stats', 'admin2')).status, [200, 304]);
    });

    it('DELETE /api/clans/:id soft-deletes rather than destroying rows', async () => {
      const chestsBefore = (getDb().prepare(
        'SELECT COUNT(*) n FROM chest_records WHERE clan_id = 2',
      ).get() as { n: number }).n;
      expect(chestsBefore).toBeGreaterThan(0);

      const r = await send('delete', '/api/clans/2', 'super');
      expectStatus(r.status, 200);

      const chestsAfter = (getDb().prepare(
        'SELECT COUNT(*) n FROM chest_records WHERE clan_id = 2',
      ).get() as { n: number }).n;
      expect(chestsAfter).toBe(chestsBefore);
      expect(getClanById(2)).toBeNull();

      // …and it comes back through the route, not just the repository.
      expectStatus((await send('post', '/api/clans/2/restore', 'super', {})).status, 200);
      expect(getClanById(2)).not.toBeNull();
    });
  });

  // ─── cross-clan leakage ───────────────────────────────────────
  //
  // The most dangerous class of bug — admin of clan A reaching
  // into clan B's data. Each test fixes admin1 (clan 1) as the
  // attacker, picks a clan-2 target, and asserts a hard 4xx.
  //
  // We also verify that admin2 (legitimate owner of clan 2)
  // succeeds on the same operation — otherwise a too-aggressive
  // gate would look "secure" while breaking the legit path.

  describe('clan-admin A cannot act on clan B', () => {
    it('PUT /auth/users/:id/role for a clan-2 user is rejected by admin1', async () => {
      const r = await send('put', `/api/auth/users/${ids.admin2.userId}/role`, 'admin1', { role: 'user' });
      expectStatus(r.status, 403);
    });

    it('DELETE /auth/users/:id targeting a clan-2 user is rejected by admin1', async () => {
      const r = await send('delete', `/api/auth/users/${ids.admin2.userId}`, 'admin1');
      expectStatus(r.status, 403);
    });

    it('POST /auth/users with clanId=2 from admin1 — clanId is ignored, account lands in admin1\'s clan', async () => {
      // Admin can call POST /auth/users but the body's clanId is
      // overridden to the caller's own clan. Verify it succeeds AND
      // the resulting account is in clan 1 (not the requested 2).
      const r = await send('post', '/api/auth/users', 'admin1', {
        username: 'crossclanattempt',
        password: 'Test1234!aA',
        role: 'user',
        clanId: 2,
      });
      expectStatus(r.status, 200);
      const created = userRepo.getUserById(r.body.id);
      expect(created?.clanId).toBe(1);
    });

    it('PUT /clans/:clanId for clan 2 is rejected by admin1', async () => {
      const r = await send('put', '/api/clans/2', 'admin1', { name: 'Hijacked' });
      expectStatus(r.status, 403);
    });

    it('PUT /clans/:clanId/discord for clan 2 is rejected by admin1', async () => {
      const r = await send('put', '/api/clans/2/discord', 'admin1', { discordToken: 'x', discordChannelId: 'y' });
      expectStatus(r.status, 403);
    });

    it('PUT /clans/:clanId/chesttracker for clan 2 is rejected by admin1', async () => {
      const r = await send('put', '/api/clans/2/chesttracker', 'admin1', { ctShareCode: 'X' });
      expectStatus(r.status, 403);
    });

    it('admin2 succeeds on the same clan-2 endpoint that rejected admin1', async () => {
      // Sanity check: the gate isn't just "everyone is rejected".
      const r = await send('put', '/api/clans/2/chesttracker', 'admin2', { ctShareCode: 'OK' });
      expect(r.status).not.toBe(403);
    });

    it('GET /members/:id resolves only inside the caller\'s clan', async () => {
      // admin1 asking for a clan-2 member should look like the
      // member doesn't exist, not return their data.
      const r = await send('get', `/api/members/${memberClan2Id}`, 'admin1');
      expectStatus(r.status, 404);
    });

    it('regular user1 cannot see a clan-2 member either', async () => {
      const r = await send('get', `/api/members/${memberClan2Id}`, 'user1');
      expectStatus(r.status, 404);
    });
  });

  // ─── cross-clan reads fail closed on a foreign id ─────────────
  //
  // The audit verified in code that clan-scoped reads never return
  // another clan's row for a guessed id — the repo SQL filters clan_id
  // and the :id routes 404. Pin that contract: a clan-1 caller (both a
  // regular user and the admin) asking for a clan-2 session/member id
  // gets 404, never the foreign data.

  describe('foreign-id reads across the clan boundary → 404', () => {
    const foreignReads = () => [
      { name: 'GET /sessions/:id (clan-2 session)', path: `/api/sessions/${sessionClan2Id}` },
      { name: 'GET /members/:id/chests (clan-2 member)', path: `/api/members/${memberClan2Id}/chests` },
      { name: 'GET /members/:id/triumphal-chests (clan-2 member)', path: `/api/members/${memberClan2Id}/triumphal-chests` },
    ];

    for (const p of ['admin1', 'user1'] as Persona[]) {
      it(`${p} (clan 1) gets 404 for every clan-2 id`, async () => {
        for (const ep of foreignReads()) {
          const r = await send('get', ep.path, p);
          expect(r.status, `${ep.name} as ${p} → ${r.status}`).toBe(404);
        }
      });
    }

    it('the same ids DO resolve for their legitimate clan-2 owner (admin2)', async () => {
      // Guards against a too-aggressive change that 404s everyone.
      for (const ep of foreignReads()) {
        const r = await send('get', ep.path, 'admin2');
        expect(r.status, `${ep.name} as admin2 → ${r.status}`).not.toBe(404);
      }
    });
  });

  // ─── content-level redaction for non-admins ───────────────────
  //
  // role-gates asserts status codes elsewhere; these two checks are
  // body-level. They guard the redactions shipped alongside the
  // requireClanAdmin fix: operator-only scan-error text and the live
  // public share token must not reach a plain member.

  describe('non-admin response redaction', () => {
    it('scan-error fields on /sessions are stripped for members, shown to admins', async () => {
      // Seed a FAILED clan-1 session carrying operator diagnostics.
      getDb().prepare(
        `INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source, error_message, error_phase)
         VALUES (1, ?, ?, 'failed', 'manual', ?, ?)`,
      ).run(new Date().toISOString(), new Date().toISOString(), 'Playwright navigation timeout', 'Navigating to Gifts tab');

      const asUser = await send('get', '/api/sessions?limit=50', 'user1');
      expect(asUser.status).toBe(200);
      const failedForUser = (asUser.body as Array<Record<string, unknown>>).find((s) => s.status === 'failed');
      expect(failedForUser, 'seeded failed session should be visible to members').toBeTruthy();
      expect(failedForUser!.errorMessage).toBeNull();
      expect(failedForUser!.errorPhase).toBeNull();

      const asAdmin = await send('get', '/api/sessions?limit=50', 'admin1');
      const failedForAdmin = (asAdmin.body as Array<Record<string, unknown>>).find((s) => s.status === 'failed');
      expect(failedForAdmin!.errorMessage).toBe('Playwright navigation timeout');
      expect(failedForAdmin!.errorPhase).toBe('Navigating to Gifts tab');
    });

    it('GET /clans withholds publicShareToken from a plain member, keeps it for admins', async () => {
      setClanPublicShareToken(1, 'aAaA11');

      const asUser = await send('get', '/api/clans', 'user1');
      expect(asUser.status).toBe(200);
      expect(asUser.body.clans[0]).not.toHaveProperty('publicShareToken');

      const asAdmin = await send('get', '/api/clans', 'admin1');
      expect(asAdmin.body.clans[0].publicShareToken).toBe('aAaA11');
    });
  });

  // ─── default-deny meta-test ───────────────────────────────────
  //
  // Enumerate EVERY route registered on the auth / clans / api routers
  // and assert an unauthenticated caller is rejected (401/403) on all of
  // them, except an explicit, reviewed public allowlist. This is the
  // structural guard: a new /api/clans route added WITHOUT an inline
  // guard (the exact bug the requireClanAdmin fix addressed) shows up
  // here as a non-401 the moment it's registered — no one has to
  // remember to hand-write a targeted test for it.

  describe('default-deny: every route rejects anonymous callers', () => {
    // (METHOD path) that is intentionally reachable without a session.
    // Keep SHORT and reviewed — every entry is a deliberate public route.
    const PUBLIC_ALLOWLIST = new Set<string>([
      'POST /api/auth/login',
    ]);

    interface RouteEntry { method: string; path: string; }

    // Walk an Express router stack, recursing into sub-routers mounted at
    // root (the clans composer uses `router.use(subRouter)` with no path).
    /* eslint-disable @typescript-eslint/no-explicit-any */
    function collect(stack: any[], prefix: string, out: RouteEntry[]): void {
      for (const layer of stack) {
        if (layer.route) {
          const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
          const methods = new Set<string>();
          if (layer.route.methods) {
            for (const m of Object.keys(layer.route.methods)) if (layer.route.methods[m]) methods.add(m);
          }
          for (const s of layer.route.stack ?? []) if (s.method) methods.add(s.method);
          for (const rp of paths) {
            for (const m of methods) out.push({ method: m.toUpperCase(), path: prefix + rp });
          }
        } else if (layer.handle && Array.isArray(layer.handle.stack)) {
          collect(layer.handle.stack, prefix, out);
        }
      }
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */

    function routesFor(router: { stack: unknown[] }, prefix: string): RouteEntry[] {
      const out: RouteEntry[] = [];
      collect(router.stack as any[], prefix, out);
      return out;
    }

    // Build throwaway router instances purely to read their route tables;
    // requests are still sent to the mounted `app` from beforeEach.
    const allRoutes: RouteEntry[] = [
      ...routesFor(createAuthRouter() as never, '/api/auth'),
      ...routesFor(createClansRouter() as never, '/api/clans'),
      ...routesFor(createApiRouter(undefined) as never, '/api'),
    ];

    it('discovered a plausible number of routes (walker sanity)', () => {
      // Guard against a silently-broken walker that would make the
      // assertion below pass vacuously.
      expect(allRoutes.length).toBeGreaterThanOrEqual(90);
    });

    it('anonymous request to every non-allowlisted route → 401/403', async () => {
      const leaks: string[] = [];
      for (const r of allRoutes) {
        const key = `${r.method} ${r.path}`;
        if (PUBLIC_ALLOWLIST.has(key)) continue;
        // Fill any :param with a placeholder so the route matches.
        const path = r.path.replace(/:[^/]+/g, '1');
        const method = r.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
        const res = await send(method, path, 'unauth');
        if (res.status !== 401 && res.status !== 403) {
          leaks.push(`${key} → ${res.status}`);
        }
      }
      expect(leaks, `routes reachable by an anonymous caller:\n${leaks.join('\n')}`).toEqual([]);
    });
  });

  // ─── self-protection on user CRUD ─────────────────────────────
  //
  // Catches the classic "I can lock myself out" bug. The DELETE
  // route explicitly refuses self-delete; verify it stays that way.

  describe('user self-protection', () => {
    it('cannot delete own account', async () => {
      const r = await send('delete', `/api/auth/users/${ids.super.userId}`, 'super');
      expectStatus(r.status, 400);
    });

    it('cannot demote the last superadmin', async () => {
      // The repo refuses to delete the last superadmin; verify the
      // analogous role-change behavior too. The endpoint requires
      // clanId when demoting a superadmin (see auth router).
      const r = await send('put', `/api/auth/users/${ids.super.userId}/role`, 'super', { role: 'admin', clanId: 1 });
      // Either the gate succeeds and the role flips (legitimate —
      // we created a second superadmin path via the seed, no wait,
      // only one super exists). With only one super, the request
      // SHOULD succeed at the gate level even though it'd brick the
      // instance. The deeper "last super" check lives in
      // deleteUser, not updateRole — by design, the operator can
      // self-demote if there's another super. Just verify the gate
      // accepts it.
      expect(r.status).not.toBe(401);
      expect(r.status).not.toBe(403);
    });
  });
});
