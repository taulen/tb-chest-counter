// GET /game-art/<version>/<name>.png and GET /api/game-art, against a temp
// data dir laid out the way store.ts writes it.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createGameArtRouter } from '../../src/game-art/routes.js';
import { resetGameArtMemo, heroAvatarImage, gameArtUrl, type GameArtIndex } from '../../src/game-art/store.js';
import { emptyMappings } from '../../src/game-art/mappings.js';
import { encodePng } from '../../src/game-art/png.js';

const CURRENT = 'a'.repeat(32);
const PREVIOUS = 'b'.repeat(32);
const PRUNED = 'c'.repeat(32);

let dir: string;
let png: Buffer;

function writeVersion(version: string, names: string[]): void {
  fs.mkdirSync(path.join(dir, version), { recursive: true });
  const index: GameArtIndex = {
    version,
    builtAt: '2026-11-17T00:00:00.000Z',
    staticVersion: 'test',
    images: Object.fromEntries(names.map((n) => [n, { w: 2, h: 2, file: `${n}.png`, category: 'heroes', bundle: '0'.repeat(32) }])),
    mappings: { ...emptyMappings(), heroAvatars: { '2': 'icon_hero_72' } },
    stats: { bundles: 1, downloaded: 1, reused: 0, bytes: 1, failed: 0, seconds: 0 },
  };
  fs.writeFileSync(path.join(dir, version, 'index.json'), JSON.stringify(index));
  for (const n of names) fs.writeFileSync(path.join(dir, version, `${n}.png`), png);
}

function app() {
  const a = express();
  a.use(createGameArtRouter({ dir }));
  a.use((_req, res) => res.status(418).send('fell through'));
  return a;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-art-'));
  png = await encodePng({ width: 2, height: 2, data: Buffer.alloc(16, 200) });
  writeVersion(CURRENT, ['icon_hero_72', 'clan_frame_1']);
  writeVersion(PREVIOUS, ['old_icon_72']);
  writeVersion(PRUNED, ['gone_72']); // on disk but no longer in state.json
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ current: CURRENT, previous: PREVIOUS }));
  fs.writeFileSync(path.join(dir, 'secret.png'), png);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  resetGameArtMemo();
});

beforeEach(() => resetGameArtMemo());

describe('GET /game-art/:version/:file', () => {
  it('serves a known image, public and immutable, without a session', async () => {
    const res = await request(app()).get(`/game-art/${CURRENT}/icon_hero_72.png`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(Buffer.from(res.body as Buffer).equals(png)).toBe(true);
  });

  it('serves the previous version too, but not a pruned one', async () => {
    expect((await request(app()).get(`/game-art/${PREVIOUS}/old_icon_72.png`)).status).toBe(200);
    expect((await request(app()).get(`/game-art/${PRUNED}/gone_72.png`)).status).toBe(404);
  });

  it('404s an unknown name, a name from another version and a malformed version', async () => {
    expect((await request(app()).get(`/game-art/${CURRENT}/nope_72.png`)).status).toBe(404);
    expect((await request(app()).get(`/game-art/${CURRENT}/old_icon_72.png`)).status).toBe(404);
    expect((await request(app()).get('/game-art/latest/icon_hero_72.png')).status).toBe(404);
    expect((await request(app()).get(`/game-art/${CURRENT.toUpperCase()}/icon_hero_72.png`)).status).toBe(404);
  });

  it('never leaves the version directory', async () => {
    for (const p of [
      `/game-art/${CURRENT}/..%2Fsecret.png`,
      `/game-art/${CURRENT}/..%2F..%2Fsecret.png`,
      `/game-art/${CURRENT}/%2e%2e%2fsecret.png`,
      `/game-art/${CURRENT}/..%5Csecret.png`,
      `/game-art/${CURRENT}/index.json`,
      `/game-art/${CURRENT}/Icon_Hero_72.png`,
      `/game-art/${CURRENT}/icon_hero_72.png%00.json`,
    ]) {
      const res = await request(app()).get(p);
      expect(res.status, p).toBe(404);
    }
    // a path with a different shape never matches the route at all
    expect((await request(app()).get('/game-art/../secret.png')).status).not.toBe(200);
    expect((await request(app()).get(`/game-art/${CURRENT}/a/b.png`)).status).toBe(418);
  });
});

describe('GET /api/game-art', () => {
  it('lists the current version, its names per category and the mappings', async () => {
    const res = await request(app()).get('/api/game-art');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.body.version).toBe(CURRENT);
    expect(res.body.base).toBe(`/game-art/${CURRENT}/`);
    expect(res.body.names.sort()).toEqual(['clan_frame_1', 'icon_hero_72']);
    expect(res.body.categories.heroes.sort()).toEqual(['clan_frame_1', 'icon_hero_72']);
    expect(res.body.mappings.heroAvatars).toEqual({ '2': 'icon_hero_72' });
  });

  it('says so when nothing has been extracted yet', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'game-art-empty-'));
    const a = express();
    a.use(createGameArtRouter({ dir: empty }));
    const res = await request(a).get('/api/game-art');
    expect(res.body).toMatchObject({ version: null, base: null, names: [] });
    fs.rmSync(empty, { recursive: true, force: true });
  });
});

describe('heroAvatarImage / gameArtUrl', () => {
  it('map a heroAvatar to the current version\'s portrait and its URL', () => {
    expect(heroAvatarImage(2, dir)).toBe('icon_hero_72');
    expect(heroAvatarImage(99, dir)).toBeNull();
    expect(heroAvatarImage(null, dir)).toBeNull();
    expect(gameArtUrl('icon_hero_72', dir)).toBe(`/game-art/${CURRENT}/icon_hero_72.png`);
    expect(gameArtUrl('missing', dir)).toBeNull();
  });
});
