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
    app.use('/api/event-scores/olympus', requireAuth, requireClanContext, createTinmanRouter('olympus'));
    app.use('/api/event-scores/ragnarok', requireAuth, requireClanContext, createTinmanRouter('ragnarok'));
    app.use('/api/event-scores/dark-omens', requireAuth, requireClanContext, createTinmanRouter('dark-omens'));
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

  it('reads a run whose day is still ahead as empty, so Events opens it on Participants', async () => {
    // A live Ancients run files its scores under its Tinman day, still ahead.
    const get = await send('get', '/api/tinman?date=2026-10-29', 'user1');
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({ date: '2026-10-29', summons: [], players: [] });
    expect((await send('get', '/api/tinman?date=2026-13-01', 'user1')).status).toBe(400);
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

  describe('Olympus (per day)', () => {
    const OLY = '2026-10-21';

    it('takes days 1–5 only, files them apart from Ancients, and has no targets', async () => {
      const put = await send('put', `/api/event-scores/olympus/${OLY}/summons/5`, 'admin1', { text: PASTE });
      expect(put.status).toBe(200);
      expect(put.body.warning).toBeNull();
      expect((await send('put', `/api/event-scores/olympus/${OLY}/summons/6`, 'admin1', { text: PASTE })).status).toBe(400);
      expect((await send('put', `/api/event-scores/olympus/${OLY}/summons/1`, 'user1', { text: PASTE })).status).toBe(403);
      expect((await send('put', `/api/event-scores/olympus/${OLY}/targets`, 'admin1', { text: 'G9 61.3M' })).status).toBe(404);

      const get = await send('get', `/api/event-scores/olympus?date=${OLY}`, 'user1');
      expect(get.body).toMatchObject({ maxSummons: 5, targets: null, isTinmanDay: null, dates: [OLY] });
      expect(get.body.summons).toMatchObject([{ summon: 5, rows: 2 }]);
      expect((await send('get', `/api/tinman?date=${OLY}`, 'user1')).body.summons).toEqual([]);
    });

    it('defaults to the newest pasted run', async () => {
      await send('put', `/api/event-scores/olympus/${OLY}/summons/1`, 'admin1', { text: PASTE });
      expect((await send('get', '/api/event-scores/olympus', 'user1')).body.date).toBe(OLY);
    });
  });

  describe('Ragnarok (per day)', () => {
    const RAG = '2026-10-21';

    it('takes days 1–2 only, files them apart from Olympus on the same day, and has no targets', async () => {
      const put = await send('put', `/api/event-scores/ragnarok/${RAG}/summons/2`, 'admin1', { text: PASTE });
      expect(put.status).toBe(200);
      expect(put.body.warning).toBeNull();
      expect((await send('put', `/api/event-scores/ragnarok/${RAG}/summons/3`, 'admin1', { text: PASTE })).status).toBe(400);
      expect((await send('put', `/api/event-scores/ragnarok/${RAG}/summons/1`, 'user1', { text: PASTE })).status).toBe(403);
      expect((await send('put', `/api/event-scores/ragnarok/${RAG}/targets`, 'admin1', { text: 'G9 61.3M' })).status).toBe(404);

      const get = await send('get', `/api/event-scores/ragnarok?date=${RAG}`, 'user1');
      expect(get.body).toMatchObject({ maxSummons: 2, targets: null, isTinmanDay: null, dates: [RAG] });
      expect(get.body.summons).toMatchObject([{ summon: 2, rows: 2 }]);
      expect((await send('get', `/api/event-scores/olympus?date=${RAG}`, 'user1')).body.summons).toEqual([]);

      expect((await send('delete', `/api/event-scores/ragnarok/${RAG}/summons/2`, 'admin1')).status).toBe(200);
      const actions = getDb().prepare("SELECT action FROM audit_log WHERE action LIKE 'ragnarok_%' ORDER BY id").all();
      expect(actions).toEqual([{ action: 'ragnarok_upload' }, { action: 'ragnarok_delete' }]);
    });
  });

  describe('Dark Omens — Spoils of Dread damage (per day)', () => {
    const OMENS = '2026-10-15';

    it('takes days 1–2 only, files them apart from Ragnarok on the same day, and has no targets', async () => {
      await send('put', `/api/event-scores/ragnarok/${OMENS}/summons/1`, 'admin1', { text: PASTE });
      const put = await send('put', `/api/event-scores/dark-omens/${OMENS}/summons/1`, 'admin1', { text: PASTE });
      expect(put.status).toBe(200);
      expect(put.body.result).toMatchObject({ rows: 2, matched: 1, unmatched: 1 });
      expect((await send('put', `/api/event-scores/dark-omens/${OMENS}/summons/3`, 'admin1', { text: PASTE })).status).toBe(400);
      expect((await send('put', `/api/event-scores/dark-omens/${OMENS}/summons/2`, 'user1', { text: PASTE })).status).toBe(403);
      expect((await send('put', `/api/event-scores/dark-omens/${OMENS}/targets`, 'admin1', { text: 'G9 61.3M' })).status).toBe(404);

      const get = await send('get', `/api/event-scores/dark-omens?date=${OMENS}`, 'user1');
      expect(get.body).toMatchObject({ maxSummons: 2, targets: null, dates: [OMENS] });
      expect(get.body.players.map((p: { name: string; total: number }) => [p.name, p.total]))
        .toEqual([['Frostbite', 59_878_655], ['Stranger', 10]]);

      // Deleting the Dark Omens day leaves the Ragnarok run on that date alone.
      expect((await send('delete', `/api/event-scores/dark-omens/${OMENS}/summons/1`, 'admin1')).status).toBe(200);
      expect((await send('get', `/api/event-scores/ragnarok?date=${OMENS}`, 'user1')).body.summons).toMatchObject([{ summon: 1 }]);
      const actions = getDb().prepare("SELECT action FROM audit_log WHERE action LIKE 'dark-omens_%' ORDER BY id").all();
      expect(actions).toEqual([{ action: 'dark-omens_upload' }, { action: 'dark-omens_delete' }]);
    });
  });

  describe('in a Seasonal Kingdom', () => {
    // The SK calendar as fetched in Nov 2026: Tinman on Nov 13, then every 5
    // days. The normal cadence (Oct 23 + 6k) would put it on Nov 16 instead.
    const ev = (summary: string, start: string, end: string) =>
      ['BEGIN:VEVENT', `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${summary}`, 'END:VEVENT'].join('\r\n');
    const SK_FEED = [
      'BEGIN:VCALENDAR',
      ev("💎 Ancients' Treasure", '20261112T170000Z', '20261113T170000Z'),
      ev('🛕 Rise of the Ancients', '20261113T170000Z', '20261114T170000Z'),
      ev("💎 Ancients' Treasure", '20261116T170000Z', '20261117T170000Z'),
      ev('🛕 Rise of the Ancients', '20261117T170000Z', '20261118T170000Z'),
      'END:VCALENDAR',
    ].join('\r\n');

    beforeEach(() => {
      vi.setSystemTime(new Date('2026-11-18T12:00:00Z')); // game day 2026-11-17, an SK Tinman day
      // The sessions above were issued on Oct 24 and have lapsed by now.
      const session = (name: string) => {
        const { id } = getDb().prepare('SELECT id FROM users WHERE username = ?').get(name) as { id: number };
        return `${SESSION_COOKIE_NAME}=${userRepo.createSession(id)}`;
      };
      cookies = { admin1: session('a1'), admin2: session('a2'), user1: session('u1') };
      getDb().prepare('UPDATE clans SET seasonal_kingdom = 1 WHERE id = 1').run();
      vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => (String(url).includes('realm=season') ? SK_FEED : 'BEGIN:VCALENDAR\r\nEND:VCALENDAR'),
      })));
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('defaults to the newest Tinman day on its own calendar, not the 6-day cadence', async () => {
      const get = await send('get', '/api/tinman', 'user1');
      expect(get.body.date).toBe('2026-11-17');
      expect(get.body.isTinmanDay).toBe(true);
      expect((await send('get', '/api/tinman?date=2026-11-16', 'user1')).body.isTinmanDay).toBe(false);
    });

    it('warns about a paste filed off its calendar, and not about one on it', async () => {
      const off = await send('put', '/api/tinman/2026-11-16/summons/1', 'admin1', { text: PASTE });
      expect(off.status).toBe(200);
      expect(off.body.warning).toMatch(/Seasonal Kingdom calendar/);
      const on = await send('put', '/api/tinman/2026-11-13/summons/1', 'admin1', { text: PASTE });
      expect(on.body.warning).toBeNull();
      // Nov 17's Tinman day is today, not past, so Nov 13's run isn't a cycle old yet.
      expect(on.body.staleWarning).toBeNull();
    });

    it('leaves a normal-kingdom clan on the 6-day cadence', async () => {
      const put = await send('put', '/api/tinman/2026-11-16/summons/1', 'admin2', { text: PASTE });
      expect(put.body.warning).toBeNull(); // Nov 16 is a Tinman day on Oct 23 + 6k
    });
  });
});
