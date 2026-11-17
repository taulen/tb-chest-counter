// GET /api/game/clan/roster-changes with real auth: the active clan's joins and
// leaves only, a departure the sync logged shown once (not again from the
// member's left_at), a return, the chips, the name search, the 30-day counts
// and cursor paging.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createGameRouter } from '../../../src/web/routes/game.js';
import { requireAuth, requireClanContext, SESSION_COOKIE_NAME } from '../../../src/web/middleware/auth.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';
import * as userRepo from '../../../src/data/repositories/user-repo.js';
import { getDb } from '../../../src/data/database.js';

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const unix = (msAgo: number) => Math.floor((Date.now() - msAgo) / 1000);

describe('/api/game/clan/roster-changes', () => {
  let app: express.Express;
  let cleanup: () => void;
  let cookies: Record<'user1' | 'user2', string>;
  const ids: Record<string, number> = {};

  beforeEach(() => {
    cleanup = makeTestDb().cleanup;
    seedTwoClans();
    const su = userRepo.createUser('su', 'Test1234!aA', 'superadmin');
    const mk = (name: string, clanId: number) => {
      const u = userRepo.createUser(name, 'Test1234!aA', 'user', su.id, clanId);
      return `${SESSION_COOKIE_NAME}=${userRepo.createSession(u.id)}`;
    };
    cookies = { user1: mk('u1', 1), user2: mk('u2', 2) };
    const db = getDb();
    const addMember = (clanId: number, name: string, firstSeen: string, opts: { active?: boolean; leftAt?: string | null; player?: number | null } = {}) => {
      ids[name] = Number(db.prepare(
        `INSERT INTO members (clan_id, name, normalized_name, aliases, first_seen, last_seen, is_active, left_at, game_player_id)
         VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?)`,
      ).run(clanId, name, name.toLowerCase(), firstSeen, firstSeen, opts.active === false ? 0 : 1, opts.leftAt ?? null, opts.player ?? null).lastInsertRowid);
    };
    const addPlayer = (clanId: number, playerId: number, name: string, joinedAt: number, inClan = 1) => {
      db.prepare(
        `INSERT INTO game_players (clan_id, player_id, name, role, joined_at, in_clan, might, hero_level, city_level, vip, gold_pass, hero_avatar, city_id, first_seen, last_seen)
         VALUES (?, ?, ?, 4, ?, ?, 100, 211, 44, 17, 0, 9, 5, ?, ?)`,
      ).run(clanId, playerId, name, joinedAt, inClan, iso(2 * DAY), iso(0));
    };
    const audit = (clanId: number, action: string, at: string, details: object) => db.prepare(
      'INSERT INTO audit_log (user_id, clan_id, action, details, created_at) VALUES (NULL, ?, ?, ?, ?)',
    ).run(clanId, action, JSON.stringify(details), at);

    // Clan 1: a newcomer, a returner (the site had them months ago), one who
    // left through the sync (audit + left_at), one the OCR era swept, and an
    // old-timer who joined long before the window.
    addMember(1, 'Derda', iso(1 * DAY), { player: 101 });
    addPlayer(1, 101, 'Derda', unix(1 * DAY + 3_600_000));
    addMember(1, 'Nightfrog', iso(90 * DAY), { player: 102 });
    addPlayer(1, 102, 'Nightfrog', unix(2 * DAY));
    const leftAt = iso(3 * DAY);
    addMember(1, 'Sir Grayling', iso(49 * DAY), { player: 103, active: false, leftAt });
    addPlayer(1, 103, 'Sir Grayling', unix(50 * DAY), 0);
    audit(1, 'member.left_clan', leftAt, { id: ids['Sir Grayling'], name: 'Sir Grayling', source: 'game', linked: true });
    addMember(1, 'Clau', iso(80 * DAY), { active: false, leftAt: iso(25 * DAY) });
    addMember(1, 'Kern', iso(200 * DAY), { player: 104 });
    addPlayer(1, 104, 'Kern', unix(210 * DAY));
    // Clan 2's departure: never on clan 1's list.
    addMember(2, 'Elsewhere', iso(9 * DAY), { active: false, leftAt: iso(1 * DAY) });

    app = express();
    app.use('/api/game', requireAuth, requireClanContext, createGameRouter());
  });

  afterEach(() => cleanup());

  const get = (path: string, who: keyof typeof cookies) => request(app).get(path).set('Accept', 'application/json').set('Cookie', cookies[who]);
  type Entry = { name: string; kind: string; source: string; memberId: number | null };
  const summary = (entries: Entry[]) => entries.map((e) => `${e.name}:${e.kind}:${e.source}`);

  it('needs a signed-in member of the clan, and lists only the active clan\'s', async () => {
    expect((await request(app).get('/api/game/clan/roster-changes').set('Accept', 'application/json')).status).toBe(401);
    const two = await get('/api/game/clan/roster-changes', 'user2');
    expect(two.status).toBe(200);
    expect(summary(two.body.entries)).toEqual(['Elsewhere:left:site']);
  });

  it('lists joins, returns and leaves newest first, each leave once, with counts and portraits', async () => {
    const r = await get('/api/game/clan/roster-changes', 'user1');
    expect(r.status).toBe(200);
    expect(summary(r.body.entries)).toEqual([
      'Derda:joined:game',
      'Nightfrog:returned:game',
      'Sir Grayling:left:game',
      'Clau:left:site',
      'Sir Grayling:joined:game',
      'Kern:joined:game',
    ]);
    expect(r.body.entries[0]).toMatchObject({ memberId: ids.Derda, playerId: 101, heroLevel: 211 });
    // Sir Grayling's leave has no player on it: the portrait is the member's.
    expect(r.body.entries[2]).toMatchObject({ memberId: ids['Sir Grayling'], heroLevel: 211 });
    expect(r.body.entries[3]).toMatchObject({ avatarUrl: null, frameUrl: null, heroLevel: null });
    expect(r.body.entries[1].seenSince).toBeTruthy();
    expect(r.body.counts).toEqual({ days: 30, joined: 2, returned: 1, left: 2 });
    expect(r.body.total).toBe(6);
    expect(r.body.readSince).toBeTruthy();
  });

  it('filters by chip and name, and pages by cursor', async () => {
    const left = (await get('/api/game/clan/roster-changes?filter=left', 'user1')).body;
    expect(summary(left.entries)).toEqual(['Sir Grayling:left:game', 'Clau:left:site']);
    expect(left.counts.joined).toBe(2); // the counts ignore the filter
    const joined = (await get('/api/game/clan/roster-changes?filter=joined&q=grayling', 'user1')).body;
    expect(summary(joined.entries)).toEqual(['Sir Grayling:joined:game']);

    const p1 = (await get('/api/game/clan/roster-changes?limit=4', 'user1')).body;
    expect(p1.entries).toHaveLength(4);
    expect(p1.next).toBeTruthy();
    const p2 = (await get(`/api/game/clan/roster-changes?limit=4&before=${encodeURIComponent(p1.next)}`, 'user1')).body;
    expect(summary(p2.entries)).toEqual(['Sir Grayling:joined:game', 'Kern:joined:game']);
    expect(p2.next).toBeNull();
  });
});
