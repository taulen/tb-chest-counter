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

  it('refuses names with control or invisible characters, and bodies of the wrong shape', async () => {
    const bad: object[] = [
      { name: 'Army\u0000', data: ARMY },
      { name: 'Main‮gnp.exe', data: ARMY }, // right-to-left override
      { name: 'Ma​in', data: ARMY }, // zero-width space: looks like "Main"
      { name: 123, data: ARMY },
      { name: ['Main'], data: ARMY },
      { name: 'Main', data: 'elven-20' },
      { name: 'Main', data: { ...ARMY, rows: 'wyvern' } },
      { name: 'Main', data: { ...ARMY, rows: [{ troopId: { $gt: '' }, count: 1, strengthPct: 0, healthPct: 0 }] } },
      [],
    ];
    for (const body of bad) {
      const r = await send('put', '/api/tools/citadel-presets', 'user1', body);
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect((await send('get', '/api/tools/citadel-presets', 'user1')).body.presets).toEqual([]);
  });

  it('stores SQL- and HTML-looking names as plain text, harmlessly', async () => {
    const names = [`x'); DROP TABLE citadel_presets; --`, `" OR 1=1 --`, '<img src=x onerror=alert(1)>', 'Élite 🐉 ⚔️'];
    const other = await send('put', '/api/tools/citadel-presets', 'user1b', { name: 'Theirs', data: ARMY });
    for (const name of names) {
      const r = await send('put', '/api/tools/citadel-presets', 'user1', { name, data: ARMY });
      expect(r.status, name).toBe(200);
      expect(r.body.preset.name).toBe(name);
    }
    const list = (await send('get', '/api/tools/citadel-presets', 'user1')).body.presets.map((p: { name: string }) => p.name);
    expect([...list].sort()).toEqual([...names].sort());
    // The table and the other account's army are untouched.
    expect((await send('get', '/api/tools/citadel-presets', 'user1b')).body.presets.map((p: { name: string }) => p.name)).toEqual(['Theirs']);
    // A delete id that isn't a plain number matches nothing.
    for (const id of ['1 OR 1=1', `${other.body.preset.id};`, '0x1', '-1']) {
      expect((await send('delete', `/api/tools/citadel-presets/${encodeURIComponent(id)}`, 'user1')).status, id).toBe(404);
    }
    expect((await send('get', '/api/tools/citadel-presets', 'user1b')).body.presets).toHaveLength(1);
  });

  it('keeps troop levels per account, and refuses anything but 1-9 or null', async () => {
    expect((await send('get', '/api/tools/citadel-levels', 'user1')).body).toEqual({ levels: { g: null, s: null, m: null, e: null } });
    const put = await send('put', '/api/tools/citadel-levels', 'user1', { g: 8, s: 8, m: 8, e: 7 });
    expect(put.status).toBe(200);
    expect(put.body.levels).toEqual({ g: 8, s: 8, m: 8, e: 7 });
    expect((await send('get', '/api/tools/citadel-levels', 'user1')).body.levels).toEqual({ g: 8, s: 8, m: 8, e: 7 });
    // Another account sees its own (none).
    expect((await send('get', '/api/tools/citadel-levels', 'user1b')).body.levels).toEqual({ g: null, s: null, m: null, e: null });
    // Clearing one back to "any".
    expect((await send('put', '/api/tools/citadel-levels', 'user1', { g: 9, s: null, m: 8, e: 7 })).body.levels).toEqual({ g: 9, s: null, m: 8, e: 7 });
    for (const body of [{ g: 10 }, { g: 0 }, { s: 7.5 }, { m: '8' }, { e: '1; DROP TABLE citadel_levels' }]) {
      expect((await send('put', '/api/tools/citadel-levels', 'user1', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await send('get', '/api/tools/citadel-levels', 'user1')).body.levels).toEqual({ g: 9, s: null, m: 8, e: 7 });
  });

  it('caps an account at 50 presets but still lets one be overwritten', async () => {
    for (let i = 0; i < 50; i++) {
      expect((await send('put', '/api/tools/citadel-presets', 'user1', { name: `P${i}`, data: ARMY })).status).toBe(200);
    }
    expect((await send('put', '/api/tools/citadel-presets', 'user1', { name: 'One more', data: ARMY })).status).toBe(409);
    expect((await send('put', '/api/tools/citadel-presets', 'user1', { name: 'P7', data: ARMY })).status).toBe(200);
  });
});

describe('/api/tools/stack-presets', () => {
  let app: express.Express;
  let cleanup: () => void;
  let cookies: Record<'user1' | 'user1b', string>;
  const SETTINGS = {
    baseMode: 'fill', baseCount: 760, tierMultiplier: 1.9, siegeMultiplier: 1.25, leadership: 250_000, authority: 0, dominance: 900,
    monsterMode: 'scaled', templeLevel: 30, specialistsFirst: true, epicHunterLast: false,
  };
  const DATA = {
    rows: [{ troopId: 'corax-1', healthPct: 412.5 }, { troopId: 'heavy-halberdier-7', healthPct: 0 }, { troopId: 'siege-ballistae-7', healthPct: 0 }],
    settings: SETTINGS,
  };

  beforeEach(() => {
    cleanup = makeTestDb().cleanup;
    seedTwoClans();
    const su = userRepo.createUser('su', 'Test1234!aA', 'superadmin');
    const mk = (name: string) => {
      const u = userRepo.createUser(name, 'Test1234!aA', 'user', su.id, 1);
      return `${SESSION_COOKIE_NAME}=${userRepo.createSession(u.id)}`;
    };
    cookies = { user1: mk('u1'), user1b: mk('u1b') };
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

  it('saves troops and settings per account, apart from the citadel armies', async () => {
    const save = await send('put', '/api/tools/stack-presets', 'user1', { name: ' Epic  run ', data: DATA });
    expect(save.status).toBe(200);
    expect(save.body.preset).toMatchObject({ name: 'Epic run', data: DATA });
    expect((await send('get', '/api/tools/stack-presets', 'user1')).body.presets).toHaveLength(1);
    expect((await send('get', '/api/tools/citadel-presets', 'user1')).body.presets).toEqual([]);
    expect((await send('get', '/api/tools/stack-presets', 'user1b')).body.presets).toEqual([]);
    expect((await send('delete', `/api/tools/stack-presets/${save.body.preset.id}`, 'user1b')).status).toBe(404);
    const own = await send('delete', `/api/tools/stack-presets/${save.body.preset.id}`, 'user1');
    expect(own.status).toBe(200);
    expect(own.body.presets).toEqual([]);
  });

  it('refuses malformed armies and settings rather than storing or clamping them', async () => {
    const bad: object[] = [
      { name: '', data: DATA },
      { name: 'Ma​in', data: DATA }, // zero-width space
      { name: 'X', data: { ...DATA, rows: 'corax-1' } },
      { name: 'X', data: { ...DATA, rows: [{ troopId: 'Corax!', healthPct: 0 }] } },
      { name: 'X', data: { ...DATA, rows: [{ troopId: 'corax-1', healthPct: 'lots' }] } },
      { name: 'X', data: { ...DATA, rows: Array.from({ length: 31 }, () => DATA.rows[0]) } },
      { name: 'X', data: { rows: DATA.rows } },
      { name: 'X', data: { ...DATA, settings: { ...SETTINGS, baseMode: 'auto' } } },
      { name: 'X', data: { ...DATA, settings: { ...SETTINGS, baseCount: 0 } } },
      { name: 'X', data: { ...DATA, settings: { ...SETTINGS, baseCount: 12.5 } } },
      { name: 'X', data: { ...DATA, settings: { ...SETTINGS, tierMultiplier: 9 } } },
      { name: 'X', data: { ...DATA, settings: { ...SETTINGS, siegeMultiplier: -1 } } },
      { name: 'X', data: { ...DATA, settings: { ...SETTINGS, leadership: '250000' } } },
      { name: 'X', data: { ...DATA, settings: { ...SETTINGS, monsterMode: 'all' } } },
      { name: 'X', data: { ...DATA, settings: { ...SETTINGS, templeLevel: 46 } } },
      { name: 'X', data: { ...DATA, settings: { ...SETTINGS, specialistsFirst: 'yes' } } },
      [],
    ];
    for (const body of bad) {
      const r = await send('put', '/api/tools/stack-presets', 'user1', body);
      expect(r.status, JSON.stringify(body).slice(0, 100)).toBe(400);
    }
    expect((await send('get', '/api/tools/stack-presets', 'user1')).body.presets).toEqual([]);
  });

  it('caps an account at 50 but still lets one be overwritten', async () => {
    for (let i = 0; i < 50; i++) {
      expect((await send('put', '/api/tools/stack-presets', 'user1', { name: `S${i}`, data: DATA })).status).toBe(200);
    }
    expect((await send('put', '/api/tools/stack-presets', 'user1', { name: 'One more', data: DATA })).status).toBe(409);
    const again = await send('put', '/api/tools/stack-presets', 'user1', { name: 'S7', data: { ...DATA, settings: { ...SETTINGS, baseCount: 800 } } });
    expect(again.status).toBe(200);
    expect(again.body.preset.data.settings.baseCount).toBe(800);
  });
});
