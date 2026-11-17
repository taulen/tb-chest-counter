// GET /api/game-texts/:lang against a temp GAME_STATIC_DIR laid out the way
// the names build writes it (data/game-static/<version>/texts-<lang>.json).

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createGameTextsRouter } from '../../../src/web/routes/game-texts.js';
import { resetGameTexts, useGameTextsDir, writeGameTexts } from '../../../src/game-protocol/game-texts.js';

let dir: string;
const savedEnv = process.env.GAME_STATIC_DIR;

function app(refresh = vi.fn(async () => undefined)) {
  const a = express();
  a.use(createGameTextsRouter({ refresh }));
  a.use((_req, res) => res.status(418).send('fell through'));
  return { a, refresh };
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-texts-'));
  process.env.GAME_STATIC_DIR = dir;
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.GAME_STATIC_DIR;
  else process.env.GAME_STATIC_DIR = savedEnv;
  resetGameTexts();
});

beforeEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  resetGameTexts();
});

describe('GET /api/game-texts/:lang', () => {
  it('serves the newest version on disk, with a private max-age and an ETag', async () => {
    writeGameTexts(path.join(dir, 'v1'), 'de', 'v1', { 'Wooden Chest': 'Holztruhe' });
    const res = await request(app().a).get('/api/game-texts/de');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['cache-control']).toBe('private, max-age=600');
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{20}"$/);
    expect(res.body).toMatchObject({ version: 'v1', lang: 'de', format: 1, texts: { 'Wooden Chest': 'Holztruhe' } });
  });

  it('answers 304 to a matching If-None-Match', async () => {
    writeGameTexts(path.join(dir, 'v1'), 'ru', 'v1', { Arena: 'Арена' });
    const { a } = app();
    const first = await request(a).get('/api/game-texts/ru');
    const again = await request(a).get('/api/game-texts/ru').set('If-None-Match', first.headers.etag);
    expect(again.status).toBe(304);
    expect(again.text).toBe('');
  });

  it('switches to the version the names resolve to', async () => {
    writeGameTexts(path.join(dir, 'v1'), 'fr', 'v1', { Arena: 'Arène (v1)' });
    writeGameTexts(path.join(dir, 'v2'), 'fr', 'v2', { Arena: 'Arène (v2)' });
    useGameTextsDir(path.join(dir, 'v1'));
    const { a } = app();
    expect((await request(a).get('/api/game-texts/fr')).body.texts.Arena).toBe('Arène (v1)');
    useGameTextsDir(path.join(dir, 'v2'));
    expect((await request(a).get('/api/game-texts/fr')).body.texts.Arena).toBe('Arène (v2)');
  });

  it("falls back to an older version's file when the current one lacks the language", async () => {
    writeGameTexts(path.join(dir, 'old'), 'es', 'old', { Arena: 'Arena (old)' });
    fs.mkdirSync(path.join(dir, 'new'), { recursive: true });
    useGameTextsDir(path.join(dir, 'new'));
    expect((await request(app().a).get('/api/game-texts/es')).body.texts.Arena).toBe('Arena (old)');
  });

  it('is a 404 — never cached — for an unknown language, English, or no texts yet', async () => {
    const { a } = app();
    for (const lang of ['xx', 'en', '..%2Fnames', 'de']) {
      const res = await request(a).get(`/api/game-texts/${lang}`);
      expect(res.status, lang).toBe(404);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('ignores a file of another format', async () => {
    fs.mkdirSync(path.join(dir, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'v1', 'texts-de.json'), JSON.stringify({ version: 'v1', lang: 'de', format: 99, texts: {} }));
    expect((await request(app().a).get('/api/game-texts/de')).status).toBe(404);
  });

  it('asks for a refresh in the background at most every ten minutes', async () => {
    writeGameTexts(path.join(dir, 'v1'), 'de', 'v1', {});
    const { a, refresh } = app();
    await request(a).get('/api/game-texts/de');
    await request(a).get('/api/game-texts/fr');
    await request(a).get('/api/game-texts/de');
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
