// GET /api/game/members/:memberId/timeline with real auth: clan-scoped, the
// baseline of each source left out, a member's merges and the player's own
// changes on one list, paged by cursor.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createMemberTimelineRouter } from '../../../src/web/routes/member-timeline.js';
import { requireAuth, requireClanContext, SESSION_COOKIE_NAME } from '../../../src/web/middleware/auth.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';
import * as userRepo from '../../../src/data/repositories/user-repo.js';
import { getDb } from '../../../src/data/database.js';
import type { GameNames } from '../../../src/game-protocol/static-data.js';

const PLAYER = 1297080171719;

describe('/api/game/members/:id/timeline', () => {
  let app: express.Express;
  let cleanup: () => void;
  let cookies: Record<'user1' | 'user2', string>;
  let memberId: number;

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
    memberId = Number(db.prepare(
      `INSERT INTO members (clan_id, name, normalized_name, aliases, first_seen, last_seen, game_player_id)
       VALUES (1, 'Nimduen', 'nimduen', '["Нимдуен"]', '', '', ?)`,
    ).run(PLAYER).lastInsertRowid);
    db.prepare(
      `INSERT INTO game_players (clan_id, player_id, name, role, joined_at, in_clan, might, hero_level, city_level, vip, gold_pass, hero_avatar, city_id, first_seen, last_seen)
       VALUES (1, ?, 'Нимдуен', 4, 1790000000, 1, 100, 211, 44, 17, 0, 9, 5, '2026-11-16T10:00:00Z', '2026-11-17T10:00:00Z')`,
    ).run(PLAYER);
    const hist = db.prepare(
      `INSERT INTO game_player_history (clan_id, player_id, captured_at, name, might, hero_level, city_level, vip, gold_pass, hero_avatar, role)
       VALUES (1, ?, ?, 'Нимдуен', 100, ?, 44, 17, 0, 9, 4)`,
    );
    hist.run(PLAYER, '2026-11-16T10:00:00Z', 205); // baseline
    hist.run(PLAYER, '2026-11-17T10:00:00Z', 211);
    const tech = db.prepare('INSERT INTO game_player_tech_history (clan_id, player_id, tech_id, level, changed_at) VALUES (1, ?, ?, ?, ?)');
    tech.run(PLAYER, 1001, 4, '2026-11-16T10:00:00Z'); // baseline
    tech.run(PLAYER, 1002, 9, '2026-11-16T10:00:00Z'); // baseline
    tech.run(PLAYER, 1001, 5, '2026-11-17T11:00:00Z');
    tech.run(PLAYER, 1002, 10, '2026-11-17T11:00:00Z');
    db.prepare(`INSERT INTO audit_log (user_id, clan_id, action, details, created_at) VALUES (NULL, 1, 'merge_player', ?, '2026-11-17T01:52:48.608Z')`)
      .run(JSON.stringify({ from: 'Нимдуен', to: 'Nimduen', clanId: 1 }));
    // Another clan's audit row about a same-named member: never shown here.
    db.prepare(`INSERT INTO audit_log (user_id, clan_id, action, details, created_at) VALUES (NULL, 2, 'merge_player', ?, '2026-11-17T01:00:00Z')`)
      .run(JSON.stringify({ from: 'X', to: 'Nimduen', clanId: 2 }));

    const names = {
      techs: { 1001: { name: 'Ballistics', maxLevel: 10 }, 1002: { name: 'Masonry', maxLevel: 10 } },
      titles: { 29: { name: 'Prefect', description: '', source: 'Received from the Loyalty Bonus', seconds: 604_800, icon: 'perfect_28', art: 'bonus_perfect_72' } },
    } as unknown as GameNames;
    app = express();
    app.use('/api/game', requireAuth, requireClanContext, createMemberTimelineRouter({ names: async () => names }));
  });

  afterEach(() => cleanup());

  const get = (path: string, who: keyof typeof cookies) => request(app).get(path).set('Accept', 'application/json').set('Cookie', cookies[who]);

  it('needs a signed-in member of the member\'s clan', async () => {
    expect((await request(app).get(`/api/game/members/${memberId}/timeline`).set('Accept', 'application/json')).status).toBe(401);
    expect((await get(`/api/game/members/${memberId}/timeline`, 'user2')).status).toBe(404);
  });

  it('lists the player\'s changes and the merge into the member, newest first, without the baseline', async () => {
    const r = await get(`/api/game/members/${memberId}/timeline`, 'user1');
    expect(r.status).toBe(200);
    expect(r.body.linked).toBe(true);
    expect(r.body.entries.map((e: { kind: string }) => e.kind)).toEqual(['research', 'hero_level', 'merged', 'joined']);
    const research = r.body.entries[0];
    expect(research.items.map((i: { name: string; prevLevel: number; level: number }) => [i.name, i.prevLevel, i.level]))
      .toEqual(expect.arrayContaining([['Ballistics', 4, 5], ['Masonry', 9, 10]]));
    expect(r.body.entries[1]).toMatchObject({ from: 205, to: 211 });
  });

  it('pages and filters', async () => {
    const p1 = (await get(`/api/game/members/${memberId}/timeline?limit=2`, 'user1')).body;
    expect(p1.entries).toHaveLength(2);
    expect(p1.next).toBeTruthy();
    const p2 = (await get(`/api/game/members/${memberId}/timeline?limit=2&before=${encodeURIComponent(p1.next)}`, 'user1')).body;
    expect(p2.entries.map((e: { kind: string }) => e.kind)).toEqual(['merged', 'joined']);
    expect(p2.next).toBeNull();
    const clan = (await get(`/api/game/members/${memberId}/timeline?groups=clan`, 'user1')).body;
    expect(clan.entries.map((e: { kind: string }) => e.kind)).toEqual(['merged', 'joined']);
  });

  it('adds the player\'s titles under Titles, and tags merges of names neither the game nor a person gave', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO game_player_titles (clan_id, player_id, title_id, assigned_at, event_id, first_seen, last_seen, gone_at)
       VALUES (1, ?, 29, ?, NULL, '2026-11-16T12:00:00.000Z', '2026-11-17T10:00:00.000Z', NULL)`,
    ).run(PLAYER, Date.parse('2026-11-16T10:00:00Z') / 1000);
    const audit = db.prepare(`INSERT INTO audit_log (user_id, clan_id, action, details, created_at) VALUES (NULL, ?, ?, ?, ?)`);
    // A spelling only the screenshot reader ever produced.
    audit.run(1, 'merge_player', JSON.stringify({ from: 'Nimdu3n', to: 'Nimduen', clanId: 1 }), '2026-05-01T11:10:58.131Z');
    // A name an admin typed (in any clan) is a person's, not the reader's.
    audit.run(2, 'rename_member', JSON.stringify({ id: '999', newName: 'Nim the Typed' }), '2026-05-01T09:00:00.000Z');
    audit.run(1, 'merge_player', JSON.stringify({ from: 'Nim the Typed', to: 'Nimduen', clanId: 1 }), '2026-05-02T11:00:00.000Z');

    // Read while the title is still held: a title runs out 7 days after it was
    // given, so from 2026-11-23 the real clock added a "ran out" entry and
    // this failed on every run (only Date is faked; the request's I/O is real).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
    let titles;
    try {
      titles = (await get(`/api/game/members/${memberId}/timeline?groups=titles`, 'user1')).body;
    } finally {
      vi.useRealTimers();
    }
    expect(titles.entries).toEqual([expect.objectContaining({
      kind: 'titles', group: 'titles', day: '2026-11-15', at: '2026-11-16T10:00:00.000Z',
      items: [expect.objectContaining({ titleId: 29, name: 'Prefect', change: 'received' })],
    })]);

    const merged = (await get(`/api/game/members/${memberId}/timeline?groups=clan`, 'user1')).body.entries
      .filter((e: { kind: string }) => e.kind === 'merged')
      .map((e: { ocr: boolean; from?: string; items?: unknown[] }) => [e.ocr, e.items ?? e.from]);
    expect(merged).toEqual([
      // The game reports "Нимдуен" for the player: a real merge.
      [false, 'Нимдуен'],
      [false, 'Nim the Typed'],
      [true, [{ name: 'Nimdu3n', ats: ['2026-05-01T11:10:58.131Z'] }]],
    ]);
  });
});
