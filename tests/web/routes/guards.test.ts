// /api/guards with real auth: read-only, open to any clan member, clan-scoped.
// The level is the Guardsmen tier from research; nothing is entered by hand.

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
import { linkPlayer, readResearch, useResearchTrees } from '../../helpers/research-tiers.js';
import * as userRepo from '../../../src/data/repositories/user-repo.js';
import { getDb } from '../../../src/data/database.js';

describe('/api/guards', () => {
  let app: express.Express;
  let cleanup: () => void;
  let undoTrees: () => void;
  let cookies: Record<'admin1' | 'user1', string>;
  let member1: number;
  let member2: number;

  beforeEach(() => {
    // The readings below are dated 2026-11-17 and a level goes stale after
    // GUARDS_STALE_DAYS (7): on the real clock this test turned red at the
    // 2026-11-25 17:00 UTC rollover. Pinned a day after the readings.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-18T12:00:00Z'));
    cleanup = makeTestDb().cleanup;
    undoTrees = useResearchTrees();
    seedTwoClans();
    member1 = seedChestData(1).members.alice;
    member2 = seedChestData(2).members.alice;

    const su = userRepo.createUser('su', 'Test1234!aA', 'superadmin');
    const mk = (name: string, role: 'admin' | 'user', clanId: number) => {
      const u = userRepo.createUser(name, 'Test1234!aA', role, su.id, clanId);
      return `${SESSION_COOKIE_NAME}=${userRepo.createSession(u.id)}`;
    };
    cookies = { admin1: mk('a1', 'admin', 1), user1: mk('u1', 'user', 1) };

    app = express();
    app.use(express.json());
    app.use('/api/guards', requireAuth, requireClanContext, createGuardsRouter());
  });

  afterEach(() => {
    undoTrees();
    cleanup();
    vi.useRealTimers();
  });

  const send = (method: 'get' | 'post' | 'delete', path: string, who: keyof typeof cookies, body?: object) => {
    let r = request(app)[method](path).set('Accept', 'application/json').set('Cookie', cookies[who]);
    if (body) r = r.send(body);
    return r;
  };

  it('lists the roster with each level from research and the game\'s Gold Pass', async () => {
    linkPlayer(member1, 101);
    getDb().prepare(
      `INSERT INTO game_players (clan_id, player_id, name, gold_pass, first_seen, last_seen) VALUES (1, 101, 'alice', 1, '', '')`,
    ).run();
    readResearch(1, 101, 8, '2026-11-17T20:00:00.000Z', '2026-11-17');

    const r = await send('get', '/api/guards/overview', 'user1');
    expect(r.status).toBe(200);
    const row = r.body.rows.find((x: { memberId: number }) => x.memberId === member1);
    expect(row).toMatchObject({ guards: { level: 8, asOf: '2026-11-17' }, goldPass: 'current' });
    expect(r.body.clan.guards).toMatchObject({ known: 1, distribution: [{ level: 8, members: 1 }] });
    expect(r.body.clan.goldPass.current.holders).toBe(1);
    // No game history covering last cycle: no number for it, rather than a wrong one.
    expect(r.body.clan.goldPass.previous).toBeNull();
  });

  it('reads one member, and keeps to the caller\'s clan', async () => {
    linkPlayer(member1, 101);
    readResearch(1, 101, 7, '2026-11-17T20:00:00.000Z', '2026-11-17');
    const detail = await send('get', `/api/guards/member/${member1}`, 'user1');
    expect(detail.status).toBe(200);
    expect(detail.body.guards).toMatchObject({ level: 7, firstSeen: '2026-11-17', levelUps: [] });
    expect(detail.body.summary).toMatchObject({ level: 7, stale: false });
    expect((await send('get', `/api/guards/member/${member2}`, 'user1')).status).toBe(404);
  });

  it('no longer takes hand-entered levels', async () => {
    const add = await send('post', `/api/guards/member/${member1}/reports`, 'admin1', { level: 8 });
    expect(add.status).toBe(404);
    expect((await send('delete', '/api/guards/reports/1', 'admin1')).status).toBe(404);
  });
});
