// /api/tinman with real auth: any member reads, only admins paste, delete and
// assign — and always into their own clan.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../../src/config/index.js', () => ({
  loadConfig: () => ({ gameDayRolloverUtcHour: 17 }),
  getConfig: () => ({ gameDayRolloverUtcHour: 17 }),
  resetConfig: vi.fn(),
}));

import { createTinmanRouter } from '../../../src/web/routes/tinman.js';
import { requireAuth, requireClanContext, SESSION_COOKIE_NAME } from '../../../src/web/middleware/auth.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';
import * as userRepo from '../../../src/data/repositories/user-repo.js';
import { getDb } from '../../../src/data/database.js';

const DATE = '2026-10-23';
const PASTE = '| Rank | Name | Points |\n| :--- | :--- | :--- |\n| 1 | Frostbite | 59,878,655 |\n| 2 | Stranger | 10 |';

describe('/api/tinman', () => {
  let app: express.Express;
  let cleanup: () => void;
  let cookies: Record<'admin1' | 'admin2' | 'user1', string>;
  let frost: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-24T12:00:00Z')); // game day 2026-10-23
    cleanup = makeTestDb().cleanup;
    seedTwoClans();
    const now = new Date().toISOString();
    frost = (getDb().prepare(
      `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active)
       VALUES (1, 'Frostbite', 'frostbite', ?, ?, 1) RETURNING id`,
    ).get(now, now) as { id: number }).id;

    const su = userRepo.createUser('su', 'Test1234!aA', 'superadmin');
    const mk = (name: string, role: 'admin' | 'user', clanId: number) => {
      const u = userRepo.createUser(name, 'Test1234!aA', role, su.id, clanId);
      return `${SESSION_COOKIE_NAME}=${userRepo.createSession(u.id)}`;
    };
    cookies = { admin1: mk('a1', 'admin', 1), admin2: mk('a2', 'admin', 2), user1: mk('u1', 'user', 1) };

    app = express();
    app.use(express.json());
    app.use('/api/tinman', requireAuth, requireClanContext, createTinmanRouter());
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const send = (method: 'get' | 'put' | 'delete', path: string, who: keyof typeof cookies, body?: object) => {
    let r = request(app)[method](path).set('Accept', 'application/json').set('Cookie', cookies[who]);
    if (body) r = r.send(body);
    return r;
  };

  it('lets an admin paste a summon and any member read it', async () => {
    const put = await send('put', `/api/tinman/${DATE}/summons/1`, 'admin1', { text: PASTE });
    expect(put.status).toBe(200);
    expect(put.body.result).toMatchObject({ rows: 2, matched: 1, unmatched: 1, skipped: 0 });

    const get = await send('get', `/api/tinman?date=${DATE}`, 'user1');
    expect(get.status).toBe(200);
    expect(get.body.isTinmanDay).toBe(true);
    expect(get.body.summons).toMatchObject([{ summon: 1, uploadedBy: 'a1', rows: 2, unmatched: 1 }]);
    expect(get.body.players[0]).toMatchObject({ memberId: frost, total: 59_878_655 });
  });

  it('defaults to the newest Tinman day', async () => {
    const get = await send('get', '/api/tinman', 'user1');
    expect(get.body.date).toBe(DATE);
  });

  it('refuses writes to a plain member', async () => {
    expect((await send('put', `/api/tinman/${DATE}/summons/1`, 'user1', { text: PASTE })).status).toBe(403);
    expect((await send('put', `/api/tinman/${DATE}/assign`, 'user1', { rawName: 'Stranger', memberId: null })).status).toBe(403);
    expect((await send('delete', `/api/tinman/${DATE}/summons/1`, 'user1')).status).toBe(403);
  });

  it('rejects a paste with no readable rows, a bad summon, or a future day', async () => {
    const empty = await send('put', `/api/tinman/${DATE}/summons/1`, 'admin1', { text: 'hello there' });
    expect(empty.status).toBe(400);
    expect(empty.body.skipped).toEqual(['hello there']);
    expect((await send('put', `/api/tinman/${DATE}/summons/9`, 'admin1', { text: PASTE })).status).toBe(400);
    expect((await send('put', '/api/tinman/2026-10-29/summons/1', 'admin1', { text: PASTE })).status).toBe(400);
  });

  it('assigns a name for the run, and keeps another clan out of it', async () => {
    await send('put', `/api/tinman/${DATE}/summons/1`, 'admin1', { text: PASTE });
    // Clan 2's admin can't reach clan 1's member or run.
    expect((await send('put', `/api/tinman/${DATE}/assign`, 'admin2', { rawName: 'Stranger', memberId: frost })).status).toBe(404);
    const ok = await send('put', `/api/tinman/${DATE}/assign`, 'admin1', { rawName: 'Stranger', memberId: null });
    expect(ok.status).toBe(200);
    const get = await send('get', `/api/tinman?date=${DATE}`, 'user1');
    expect(get.body.review).toMatchObject([{ rawName: 'Stranger', matchKind: 'rejected' }]);
  });

  it('stores per-tier targets for the run, admin-only, and returns them with guards levels', async () => {
    const text = 'For 3 kills, already lowered for a 15% overshoot.\nG9 \t6 members \t61.3M \t368M \t19.2%\nG7 \t59 members \t10.9M \t643M \t33.5%';
    expect((await send('put', `/api/tinman/${DATE}/targets`, 'user1', { text })).status).toBe(403);
    const put = await send('put', `/api/tinman/${DATE}/targets`, 'admin1', { text });
    expect(put.status).toBe(200);
    expect(put.body.targets).toMatchObject({ tiers: { g9: 61_300_000, g7: 10_900_000 }, kills: 3, savedBy: 'a1' });

    await send('put', `/api/tinman/${DATE}/summons/1`, 'admin1', { text: PASTE });
    const get = await send('get', `/api/tinman?date=${DATE}`, 'user1');
    expect(get.body.targets.kills).toBe(3);
    // No donation evidence in this test DB, so the level is unknown.
    expect(get.body.players[0]).toMatchObject({ memberId: frost, guardsLevel: null });

    expect((await send('put', `/api/tinman/${DATE}/targets`, 'admin1', { text: 'nothing here' })).status).toBe(400);
    expect((await send('delete', `/api/tinman/${DATE}/targets`, 'admin1')).status).toBe(200);
    expect((await send('get', `/api/tinman?date=${DATE}`, 'user1')).body.targets).toBeNull();
  });

  it('deletes a summon', async () => {
    await send('put', `/api/tinman/${DATE}/summons/1`, 'admin1', { text: PASTE });
    expect((await send('delete', `/api/tinman/${DATE}/summons/1`, 'admin1')).status).toBe(200);
    const get = await send('get', `/api/tinman?date=${DATE}`, 'user1');
    expect(get.body.summons).toEqual([]);
  });
});
