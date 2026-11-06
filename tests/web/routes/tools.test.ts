// /api/tools with real auth: the roster read is open to any clan member; saving
// the clan's Ancient planner defaults is admin-only and lands on the caller's
// own clan.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../../src/config/index.js', () => ({
  loadConfig: () => ({ gameDayRolloverUtcHour: 17 }),
  getConfig: () => ({ gameDayRolloverUtcHour: 17 }),
  resetConfig: vi.fn(),
}));

import { createToolsRouter } from '../../../src/web/routes/tools.js';
import { requireAuth, requireClanContext, SESSION_COOKIE_NAME } from '../../../src/web/middleware/auth.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';
import * as userRepo from '../../../src/data/repositories/user-repo.js';
import { BUILT_IN_ANCIENT_DEFAULTS } from '../../../src/config/ancient-planner-defaults.js';

const SETTINGS = { level: 135, tomeLevel: 26, missing: 5, trick: 10, margin: 12, unknownAs: 'g6', summons: 4 };

describe('/api/tools', () => {
  let app: express.Express;
  let cleanup: () => void;
  let cookies: Record<'admin1' | 'admin2' | 'user1', string>;

  beforeEach(() => {
    cleanup = makeTestDb().cleanup;
    seedTwoClans();
    const su = userRepo.createUser('su', 'Test1234!aA', 'superadmin');
    const mk = (name: string, role: 'admin' | 'user', clanId: number) => {
      const u = userRepo.createUser(name, 'Test1234!aA', role, su.id, clanId);
      return `${SESSION_COOKIE_NAME}=${userRepo.createSession(u.id)}`;
    };
    cookies = { admin1: mk('a1', 'admin', 1), admin2: mk('a2', 'admin', 2), user1: mk('u1', 'user', 1) };

    app = express();
    app.use(express.json());
    app.use('/api/tools', requireAuth, requireClanContext, createToolsRouter());
  });

  afterEach(() => cleanup());

  const send = (method: 'get' | 'put' | 'delete', path: string, who: keyof typeof cookies, body?: object) => {
    let r = request(app)[method](path).set('Accept', 'application/json').set('Cookie', cookies[who]);
    if (body) r = r.send(body);
    return r;
  };

  it('opens on the built-in defaults until a clan saves its own', async () => {
    const r = await send('get', '/api/tools/ancient-roster', 'user1');
    expect(r.status).toBe(200);
    expect(r.body.defaults).toMatchObject({ source: 'built-in', settings: BUILT_IN_ANCIENT_DEFAULTS });
    expect(r.body.defaults.settings).toMatchObject({ missing: 5, unknownAs: 'g7', tomeLevel: 26, summons: 3 });
  });

  it('lets an admin save the clan default, which every member then opens on', async () => {
    const save = await send('put', '/api/tools/ancient-defaults', 'admin1', { settings: SETTINGS });
    expect(save.status).toBe(200);
    expect(save.body.defaults).toMatchObject({ source: 'clan', savedBy: 'a1', settings: SETTINGS });

    const r = await send('get', '/api/tools/ancient-roster', 'user1');
    expect(r.body.defaults).toMatchObject({ source: 'clan', savedBy: 'a1', settings: SETTINGS });
  });

  it('refuses the save to a plain member', async () => {
    const r = await send('put', '/api/tools/ancient-defaults', 'user1', { settings: SETTINGS });
    expect(r.status).toBe(403);
  });

  it('refuses out-of-range settings rather than clamping them', async () => {
    const r = await send('put', '/api/tools/ancient-defaults', 'admin1', { settings: { ...SETTINGS, summons: 9 } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/summons/);
    const bad = await send('put', '/api/tools/ancient-defaults', 'admin1', { settings: { ...SETTINGS, unknownAs: 't9' } });
    expect(bad.status).toBe(400);
  });

  it("keeps each clan's default to itself", async () => {
    await send('put', '/api/tools/ancient-defaults', 'admin2', { settings: SETTINGS });
    const r = await send('get', '/api/tools/ancient-roster', 'admin1');
    expect(r.body.defaults.source).toBe('built-in');
  });
});

describe('/api/tools/citadel-presets', () => {
  let app: express.Express;
  let cleanup: () => void;
  let cookies: Record<'user1' | 'user1b' | 'admin2', string>;
  const ARMY = {
    citadelId: 'elven-20',
    rows: [
      { troopId: 'wyvern', count: 12, strengthPct: 3611.5, healthPct: 2669.8 },
      { troopId: 'fire-phoenix-1', count: 1, strengthPct: 3711.5, healthPct: 2769.8 },
    ],
  };

  beforeEach(() => {
    cleanup = makeTestDb().cleanup;
    seedTwoClans();
    const su = userRepo.createUser('su', 'Test1234!aA', 'superadmin');
    const mk = (name: string, role: 'admin' | 'user', clanId: number) => {
      const u = userRepo.createUser(name, 'Test1234!aA', role, su.id, clanId);
      return `${SESSION_COOKIE_NAME}=${userRepo.createSession(u.id)}`;
    };
    cookies = { user1: mk('u1', 'user', 1), user1b: mk('u1b', 'user', 1), admin2: mk('a2', 'admin', 2) };
    app = express();
    app.use(express.json());
    app.use('/api/tools', requireAuth, requireClanContext, createToolsRouter());
  });

  afterEach(() => cleanup());

  const send = (method: 'get' | 'put' | 'delete', path: string, who: keyof typeof cookies, body?: object) => {
    let r = request(app)[method](path).set('Accept', 'application/json').set('Cookie', cookies[who]);
    if (body) r = r.send(body);
    return r;
  };

  it('saves an army for any member and lists it back', async () => {
    expect((await send('get', '/api/tools/citadel-presets', 'user1')).body).toEqual({ presets: [] });
    const save = await send('put', '/api/tools/citadel-presets', 'user1', { name: '  Elven 20   wyverns ', data: ARMY });
    expect(save.status).toBe(200);
    expect(save.body.preset).toMatchObject({ name: 'Elven 20 wyverns', data: ARMY });
    const list = await send('get', '/api/tools/citadel-presets', 'user1');
    expect(list.body.presets).toHaveLength(1);
    expect(list.body.presets[0].data).toEqual(ARMY);
  });

  it('overwrites a preset saved under the same name', async () => {
    await send('put', '/api/tools/citadel-presets', 'user1', { name: 'Main', data: ARMY });
    const again = await send('put', '/api/tools/citadel-presets', 'user1', { name: 'Main', data: { ...ARMY, citadelId: 'elven-25' } });
    expect(again.body.presets).toHaveLength(1);
    expect(again.body.presets[0].data.citadelId).toBe('elven-25');
  });

  it("keeps each account's presets to itself, even in the same clan", async () => {
    const mine = await send('put', '/api/tools/citadel-presets', 'user1', { name: 'Mine', data: ARMY });
    expect((await send('get', '/api/tools/citadel-presets', 'user1b')).body.presets).toEqual([]);
    expect((await send('get', '/api/tools/citadel-presets', 'admin2')).body.presets).toEqual([]);
    const steal = await send('delete', `/api/tools/citadel-presets/${mine.body.preset.id}`, 'admin2');
    expect(steal.status).toBe(404);
    const own = await send('delete', `/api/tools/citadel-presets/${mine.body.preset.id}`, 'user1');
    expect(own.status).toBe(200);
    expect(own.body.presets).toEqual([]);
  });

  it('refuses a malformed army rather than storing it', async () => {
    const bad = [
      { name: '', data: ARMY },
      { name: 'x'.repeat(41), data: ARMY },
      { name: 'X', data: { ...ARMY, citadelId: 'tower-9' } },
      { name: 'X', data: { ...ARMY, rows: [{ troopId: 'Wyvern!', count: 1, strengthPct: 0, healthPct: 0 }] } },
      { name: 'X', data: { ...ARMY, rows: [{ troopId: 'wyvern', count: 1.5, strengthPct: 0, healthPct: 0 }] } },
      { name: 'X', data: { ...ARMY, rows: [{ troopId: 'wyvern', count: 1, strengthPct: 'lots', healthPct: 0 }] } },
      { name: 'X', data: { ...ARMY, rows: Array.from({ length: 31 }, () => ARMY.rows[0]) } },
    ];
    for (const body of bad) {
      const r = await send('put', '/api/tools/citadel-presets', 'user1', body);
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect((await send('get', '/api/tools/citadel-presets', 'user1')).body.presets).toEqual([]);
  });

  it('caps an account at 50 presets but still lets one be overwritten', async () => {
    for (let i = 0; i < 50; i++) {
      expect((await send('put', '/api/tools/citadel-presets', 'user1', { name: `P${i}`, data: ARMY })).status).toBe(200);
    }
    expect((await send('put', '/api/tools/citadel-presets', 'user1', { name: 'One more', data: ARMY })).status).toBe(409);
    expect((await send('put', '/api/tools/citadel-presets', 'user1', { name: 'P7', data: ARMY })).status).toBe(200);
  });
});
