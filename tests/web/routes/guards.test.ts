// /api/guards with real auth: reads open to any clan member, the one write
// (an admin entering a member's level) admin-only and clan-scoped.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../../src/config/index.js', () => ({
  loadConfig: () => ({ gameDayRolloverUtcHour: 17 }),
  getConfig: () => ({ gameDayRolloverUtcHour: 17 }),
  resetConfig: vi.fn(),
}));

import { createGuardsRouter } from '../../../src/web/routes/guards.js';
import { requireAuth, requireClanContext, SESSION_COOKIE_NAME } from '../../../src/web/middleware/auth.js';
import { makeTestDb, seedChestData, seedTwoClans } from '../../helpers/test-db.js';
import * as userRepo from '../../../src/data/repositories/user-repo.js';
import { getDb } from '../../../src/data/database.js';

describe('/api/guards', () => {
  let app: express.Express;
  let cleanup: () => void;
  let cookies: Record<'admin1' | 'admin2' | 'user1', string>;
  let member1: number;
  let member2: number;

  beforeEach(() => {
    cleanup = makeTestDb().cleanup;
    seedTwoClans();
    member1 = seedChestData(1).members.alice;
    member2 = seedChestData(2).members.alice;

    const su = userRepo.createUser('su', 'Test1234!aA', 'superadmin');
    const mk = (name: string, role: 'admin' | 'user', clanId: number) => {
      const u = userRepo.createUser(name, 'Test1234!aA', role, su.id, clanId);
      return `${SESSION_COOKIE_NAME}=${userRepo.createSession(u.id)}`;
    };
    cookies = { admin1: mk('a1', 'admin', 1), admin2: mk('a2', 'admin', 2), user1: mk('u1', 'user', 1) };

    app = express();
    app.use(express.json());
    app.use('/api/guards', requireAuth, requireClanContext, createGuardsRouter());
  });

  afterEach(() => cleanup());

  const send = (method: 'get' | 'post' | 'delete', path: string, who: keyof typeof cookies, body?: object) => {
    let r = request(app)[method](path).set('Accept', 'application/json').set('Cookie', cookies[who]);
    if (body) r = r.send(body);
    return r;
  };

  it('lists the roster for any clan member', async () => {
    const r = await send('get', '/api/guards/overview', 'user1');
    expect(r.status).toBe(200);
    expect(r.body.rows.map((x: { memberId: number }) => x.memberId)).toContain(member1);
    expect(r.body.clan.guards).toMatchObject({ estimated: 0 });
  });

  it('lets an admin enter a level, and reads it back on the member', async () => {
    const add = await send('post', `/api/guards/member/${member1}/reports`, 'admin1', {
      level: 8, observedDate: '2026-09-01', note: 'in chat',
    });
    expect(add.status).toBe(200);

    const detail = await send('get', `/api/guards/member/${member1}`, 'user1');
    expect(detail.status).toBe(200);
    expect(detail.body.estimate.level).toBe(8);
    expect(detail.body.reports).toMatchObject([{ level: 8, note: 'in chat', createdByName: 'a1' }]);
    expect(detail.body.goldPass).toHaveLength(6);
  });

  it('refuses the write to a plain member', async () => {
    const r = await send('post', `/api/guards/member/${member1}/reports`, 'user1', { level: 8 });
    expect(r.status).toBe(403);
  });

  it('keeps an admin inside their own clan', async () => {
    const add = await send('post', `/api/guards/member/${member2}/reports`, 'admin1', { level: 8 });
    expect(add.status).toBe(404);

    getDb().prepare(
      `INSERT INTO member_guards_reports (clan_id, member_id, level, observed_date, created_at)
       VALUES (1, ?, 7, '2026-09-01', '')`,
    ).run(member1);
    const id = (getDb().prepare('SELECT id FROM member_guards_reports').get() as { id: number }).id;
    expect((await send('delete', `/api/guards/reports/${id}`, 'admin2')).status).toBe(404);
    expect((await send('delete', `/api/guards/reports/${id}`, 'admin1')).status).toBe(200);
  });

  it('rejects a level or date that cannot be right', async () => {
    const path = `/api/guards/member/${member1}/reports`;
    expect((await send('post', path, 'admin1', { level: 10 })).status).toBe(400);
    expect((await send('post', path, 'admin1', { level: 0 })).status).toBe(400);
    expect((await send('post', path, 'admin1', { level: 7.5 })).status).toBe(400);
    expect((await send('post', path, 'admin1', { level: 7, observedDate: '2026-02-30' })).status).toBe(400);
    expect((await send('post', path, 'admin1', { level: 7, observedDate: '2999-01-01' })).status).toBe(400);
  });
});
