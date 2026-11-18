/**
 * /api/join (routes/join.ts): what a code from the game chat does for the
 * visitor, and doing it — over real HTTP with real sessions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createJoinRouter, suggestUsername } from '../../../src/web/routes/join.js';
import { recordInviteRequest, reserveInviteSend } from '../../../src/data/repositories/account-invite-repo.js';
import * as userRepo from '../../../src/data/repositories/user-repo.js';
import { SESSION_COOKIE_NAME } from '../../../src/web/middleware/auth.js';
import { getDb } from '../../../src/data/database.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';

let cleanup: () => void;
let app: express.Express;
const PW = 'Test1234!aA-x';

beforeEach(() => {
  ({ cleanup } = makeTestDb());
  seedTwoClans();
  app = express();
  app.use(express.json());
  app.use('/api/join', createJoinRouter());
});
afterEach(() => cleanup());

function gamePlayer(clanId: number, playerId: number, name: string, role: number): void {
  getDb().prepare(
    `INSERT INTO game_players (clan_id, player_id, name, role, joined_at, in_clan, first_seen, last_seen)
     VALUES (?, ?, ?, ?, 1790000000, 1, 'x', 'x')`,
  ).run(clanId, playerId, name, role);
}
let n = 1;
function code(clanId: number, playerId: number): string {
  const id = n++;
  recordInviteRequest({ clanId, channelUrl: `c${id}`, messageId: id, senderChatId: `tb:${playerId}`, playerId, requestedAt: Date.now() }, 'pending', null);
  const reqId = (getDb().prepare('SELECT id FROM chat_invite_requests WHERE message_id = ?').get(id) as { id: number }).id;
  return reserveInviteSend(reqId)!.code;
}
const cookieOf = (res: request.Response): string => {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (raw ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? '';
};

describe('/api/join', () => {
  it('an unknown code and a used one answer the same, uncacheable', async () => {
    const r = await request(app).post('/api/join/check').send({ code: 'ABCD-EFGH' });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('This code is not valid or has expired.');
    expect(r.headers['cache-control']).toMatch(/no-store/);
  });

  it('new: check shows the player and the role, redeem creates the account and signs it in; the code works once', async () => {
    gamePlayer(1, 11, 'Sir Lance-lot', 2);
    const c = code(1, 11);
    const chk = await request(app).post('/api/join/check').send({ code: c.toLowerCase() });
    expect(chk.status).toBe(200);
    expect(chk.body).toMatchObject({ mode: 'new', role: 'admin', player: { name: 'Sir Lance-lot', rank: 2 }, viewer: null, suggestedUsername: 'SirLance-lot' });

    const weak = await request(app).post('/api/join/redeem').send({ code: c, username: 'lance', password: 'short' });
    expect(weak.status).toBe(400);

    const ok = await request(app).post('/api/join/redeem').send({ code: c, username: 'lance', password: PW });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ mode: 'new', user: { username: 'lance', role: 'admin', clanId: 1 } });
    const cookie = cookieOf(ok);
    expect(cookie).not.toBe('');
    expect(userRepo.validateSession(cookie.split('=')[1])?.user.username).toBe('lance');

    expect((await request(app).post('/api/join/redeem').send({ code: c, username: 'lance2', password: PW })).status).toBe(404);
  });

  it('signed in: the code adds its clan to the account; a player linked elsewhere is refused', async () => {
    gamePlayer(1, 21, 'Home', 4);
    const first = await request(app).post('/api/join/redeem').send({ code: code(1, 21), username: 'homer', password: PW });
    const cookie = cookieOf(first);
    gamePlayer(2, 22, 'Alt', 1);
    const c2 = code(2, 22);
    const chk = await request(app).post('/api/join/check').set('Cookie', cookie).send({ code: c2 });
    expect(chk.body).toMatchObject({ mode: 'add-clan', viewer: { username: 'homer' }, role: 'admin' });
    // `stay: true` (the in-app dialog): the clan is added, the session stays put.
    const sessionClan = () => (getDb().prepare('SELECT active_clan_id FROM user_sessions WHERE token = ?')
      .get(cookie.split('=')[1]) as { active_clan_id: number | null }).active_clan_id;
    const before = sessionClan();
    const added = await request(app).post('/api/join/redeem').set('Cookie', cookie).send({ code: c2, stay: true });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ mode: 'add-clan', clanId: 2 });
    expect(userRepo.getClanAccessRole(first.body.user.id, 2)).toBe('admin');
    expect(sessionClan()).toBe(before);

    // Another account trying to take player 22.
    const other = userRepo.createUser('other', PW, 'user', undefined, 2);
    const otherCookie = `${SESSION_COOKIE_NAME}=${userRepo.createSession(other.id)}`;
    getDb().prepare('DELETE FROM account_invite_codes').run();
    const c3 = code(2, 22);
    const refused = await request(app).post('/api/join/redeem').set('Cookie', otherCookie).send({ code: c3 });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/already linked to another account/);
  });

  it('signed out with a linked player: recover sets a new password and signs in', async () => {
    gamePlayer(1, 31, 'Forgetful', 4);
    await request(app).post('/api/join/redeem').send({ code: code(1, 31), username: 'forgetful', password: PW });
    getDb().prepare('DELETE FROM account_invite_codes').run();
    const c = code(1, 31);
    expect((await request(app).post('/api/join/check').send({ code: c })).body).toMatchObject({ mode: 'recover', username: 'forgetful' });
    const r = await request(app).post('/api/join/redeem').send({ code: c, password: 'NewPass1!word' });
    expect(r.status).toBe(200);
    expect(userRepo.authenticate('forgetful', 'NewPass1!word')).not.toBeNull();
  });

  it('wrong guesses are limited per address', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await request(app).post('/api/join/check').send({ code: `WRONG${i}XX` })).status;
    expect(last).toBe(429);
  });

  it('suggests a username from the in-game name, or nothing when too little survives', () => {
    expect(suggestUsername('Ölaf the Bold')).toBe('OlaftheBold');
    expect(suggestUsername('Король')).toBe('');
  });
});
