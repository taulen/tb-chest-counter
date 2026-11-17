// Clan logos (game-art/clan-logo.ts): the packed code, the composition of the
// four layers (made up here — solid squares, never the game's art), and
// GET /game-art/<version>/clan-logo/<code>.png against a temp art dir laid out
// the way store.ts writes it. Also item icons by item id (item-icons.ts).

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { clanLogoLayers, clanLogoUrl, composeClanLogo, createClanLogoRouter, decodeClanLogo } from '../../src/game-art/clan-logo.js';
import { itemIconUrls, setItemIconsForTest } from '../../src/game-art/item-icons.js';
import { resetGameArtMemo, type GameArtIndex } from '../../src/game-art/store.js';
import { emptyMappings } from '../../src/game-art/mappings.js';
import { decodePng, encodePng } from '../../src/game-art/png.js';

const CURRENT = 'd'.repeat(32);
const CWB = 1118480; // 0x11_11_10 → background 17, frame 17, emblem 16

/** A w×h square of one colour; `hole` leaves a transparent border of that width. */
function square(w: number, h: number, rgba: [number, number, number, number], hole = 0) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = x >= hole && y >= hole && x < w - hole && y < h - hole;
      data.set(inside ? rgba : [0, 0, 0, 0], (y * w + x) * 4);
    }
  }
  return encodePng({ width: w, height: h, data });
}

const pixel = (img: { width: number; data: Buffer }, x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

let dir: string;
let layers: { background: Buffer; mask: Buffer; frame: Buffer; emblem: Buffer };

beforeAll(async () => {
  layers = {
    background: await square(10, 10, [200, 0, 0, 255]), // red field, full square
    mask: await square(6, 6, [255, 0, 0, 255]), // the frame's opening: the middle 6×6
    frame: await square(10, 10, [0, 0, 200, 255], 4), // blue, only a 2×2 core (transparent elsewhere)
    emblem: await square(2, 2, [0, 200, 0, 255]), // green, centred
  };
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clan-logo-'));
  const names = clanLogoLayers(decodeClanLogo(CWB)!);
  const files: Record<string, Buffer> = {
    [names.background]: layers.background,
    [names.mask]: layers.mask,
    [names.frame]: layers.frame,
    [names.emblem]: layers.emblem,
    booster_piece_shield_blue_72: layers.emblem,
  };
  fs.mkdirSync(path.join(dir, CURRENT), { recursive: true });
  const index: GameArtIndex = {
    version: CURRENT,
    builtAt: '2026-11-17T00:00:00.000Z',
    staticVersion: 'test',
    images: Object.fromEntries(Object.keys(files).map((n) => [n, { w: 10, h: 10, file: `${n}.png`, category: 'clan', bundle: '0'.repeat(32) }])),
    mappings: emptyMappings(),
    stats: { bundles: 1, downloaded: 1, reused: 0, bytes: 1, failed: 0, seconds: 0 },
  };
  fs.writeFileSync(path.join(dir, CURRENT, 'index.json'), JSON.stringify(index));
  for (const [n, buf] of Object.entries(files)) fs.writeFileSync(path.join(dir, CURRENT, `${n}.png`), buf);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ current: CURRENT, previous: null }));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  resetGameArtMemo();
  setItemIconsForTest(null);
});

beforeEach(() => resetGameArtMemo());

describe('clan logo code', () => {
  it('packs background, frame and emblem one byte each', () => {
    expect(decodeClanLogo(1118480)).toEqual({ background: 17, frame: 17, emblem: 16 });
    expect(decodeClanLogo(660741)).toEqual({ background: 10, frame: 21, emblem: 5 });
    expect(decodeClanLogo(2168077)).toEqual({ background: 33, frame: 21, emblem: 13 });
    expect(clanLogoLayers({ background: 33, frame: 21, emblem: 13 })).toEqual({
      background: 'clan_background_33_lg', mask: 'clan_mask_21_lg', frame: 'clan_frame_21_lg', emblem: 'clan_emblem_13_lg',
    });
  });

  it('is not a logo when a layer is missing or the code is out of range', () => {
    for (const bad of [0, -1, 0x1000000, 0x110010, 0x001110, 0x111100, 1.5, null, undefined]) expect(decodeClanLogo(bad as number)).toBeNull();
  });
});

describe('composeClanLogo', () => {
  it('cuts the background to the mask, then draws the frame and the emblem, all centred', async () => {
    const img = await decodePng(await composeClanLogo(layers));
    expect([img.width, img.height]).toEqual([10, 10]);
    expect(pixel(img, 0, 0)).toEqual([0, 0, 0, 0]); // outside the mask: background cut away
    expect(pixel(img, 2, 2)).toEqual([200, 0, 0, 255]); // inside the mask: the background
    expect(pixel(img, 4, 4)).toEqual([0, 200, 0, 255]); // the emblem on top of the frame's core
  });
});

describe('GET /game-art/:version/clan-logo/:code.png', () => {
  const app = () => {
    const a = express();
    a.use(createClanLogoRouter({ dir }));
    a.use((_req, res) => res.status(418).send('fell through'));
    return a;
  };

  it('composes the logo once, then serves it public and immutable', async () => {
    const res = await request(app()).get(`/game-art/${CURRENT}/clan-logo/${CWB}.png`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(fs.existsSync(path.join(dir, CURRENT, 'clan-logos', `${CWB}.png`))).toBe(true);
    expect((await request(app()).get(`/game-art/${CURRENT}/clan-logo/${CWB}.png`)).status).toBe(200);
  });

  it('404s a logo whose layers the art lacks, a bad code and an unknown version', async () => {
    expect((await request(app()).get(`/game-art/${CURRENT}/clan-logo/660741.png`)).status).toBe(404);
    expect((await request(app()).get(`/game-art/${CURRENT}/clan-logo/0.png`)).status).toBe(404);
    expect((await request(app()).get(`/game-art/${CURRENT}/clan-logo/abc.png`)).status).toBe(404);
    expect((await request(app()).get(`/game-art/${'e'.repeat(32)}/clan-logo/${CWB}.png`)).status).toBe(404);
  });

  it('gives a URL only for a logo the current art can draw', () => {
    expect(clanLogoUrl(CWB, dir)).toBe(`/game-art/${CURRENT}/clan-logo/${CWB}.png`);
    expect(clanLogoUrl(660741, dir)).toBeNull();
    expect(clanLogoUrl(null, dir)).toBeNull();
  });
});

describe('item icons by id', () => {
  it("gives each item its own icon's URL, and nothing for an item without one", async () => {
    const prev = process.env.GAME_ART_DIR;
    process.env.GAME_ART_DIR = dir;
    resetGameArtMemo();
    try {
      setItemIconsForTest([{ id: 3024, icon: 'booster_piece_shield_blue_72' }, { id: 702010, icon: 'icon_multistage_victory_points' }]);
      const urls = await itemIconUrls([3024, 702010, 99]);
      expect(urls.get(3024)).toBe(`/game-art/${CURRENT}/booster_piece_shield_blue_72.png`);
      expect(urls.has(702010)).toBe(false); // not extracted in this art
      expect(urls.has(99)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.GAME_ART_DIR;
      else process.env.GAME_ART_DIR = prev;
      resetGameArtMemo();
    }
  });
});
