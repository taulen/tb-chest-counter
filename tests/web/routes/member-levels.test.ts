// /api/member-levels with real auth: any member reads; only admins preview and
// import, into their own clan, dated the day they save.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../../src/config/index.js', () => ({
  loadConfig: () => ({ gameDayRolloverUtcHour: 17 }),
  getConfig: () => ({ gameDayRolloverUtcHour: 17 }),
  resetConfig: vi.fn(),
}));

import { createMemberLevelsRouter } from '../../../src/web/routes/member-levels.js';
import { requireAuth, requireClanContext, SESSION_COOKIE_NAME } from '../../../src/web/middleware/auth.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';
import * as userRepo from '../../../src/data/repositories/user-repo.js';
import { getDb } from '../../../src/data/database.js';

describe('/api/member-levels', () => {
  let app: express.Express;
  let cleanup: () => void;
  let cookies: Record<'admin1' | 'user1', string>;
  let taulen: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-24T12:00:00Z')); // game day 2026-10-23
    cleanup = makeTestDb().cleanup;
    seedTwoClans();
    const now = new Date().toISOString();
    taulen = (getDb().prepare(
      `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
       VALUES (1, 'taulen', 'taulen', ?, ?, 1) RETURNING id`,
    ).get(now, now) as { id: number }).id;
    const su = userRepo.createUser('su', 'Test1234!aA', 'superadmin');
    const mk = (name: string, role: 'admin' | 'user') => {
      const u = userRepo.createUser(name, 'Test1234!aA', role, su.id, 1);
      return `${SESSION_COOKIE_NAME}=${userRepo.createSession(u.id)}`;
    };
    cookies = { admin1: mk('a1', 'admin'), user1: mk('u1', 'user') };
    app = express();
    app.use(express.json());
    app.use('/api/member-levels', requireAuth, requireClanContext, createMemberLevelsRouter());
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const send = (method: 'get' | 'post', path: string, who: keyof typeof cookies, body?: object) => {
    let r = request(app)[method](path).set('Accept', 'application/json').set('Cookie', cookies[who]);
    if (body) r = r.send(body);
    return r;
  };

  it('keeps preview and import to admins', async () => {
    expect((await send('post', '/api/member-levels/preview', 'user1', { text: 'taulen: G8' })).status).toBe(403);
    expect((await send('post', '/api/member-levels/import', 'user1', { entries: [{ memberId: taulen, levels: { g: 8 } }] })).status).toBe(403);
  });

  it('previews, imports dated today whatever the client sends, and reads back for anyone', async () => {
    const pre = await send('post', '/api/member-levels/preview', 'admin1', { text: 'taulen: G8/M8/S7/E8/C35/D284\njunk line' });
    expect(pre.status).toBe(200);
    expect(pre.body.rows[0]).toMatchObject({ rawName: 'taulen', memberId: taulen, matchKind: 'exact' });
    expect(pre.body.skipped).toEqual(['junk line']);

    const imp = await send('post', '/api/member-levels/import', 'admin1', {
      date: '2020-01-01',
      entries: [{ memberId: taulen, levels: pre.body.rows[0].levels, raw: pre.body.rows[0].raw }],
    });
    expect(imp.body.result).toEqual({ saved: 1, guardsReports: 1, rejected: 0 });

    const get = await send('get', '/api/member-levels', 'user1');
    expect(get.body.rows[0]).toMatchObject({
      memberId: taulen, levels: { g: 8, d: 284 }, lastReported: '2026-10-23', guardsEstimate: 8,
    });
  });
});
