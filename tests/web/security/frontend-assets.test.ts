// The frontend's static files must load with NO session.
//
// They used to sit behind requireAuth, and Cloudflare stores whatever an asset
// URL answers — `private, no-store` included — for ~22 hours at the location
// that saw it. One logged-out request for /v/<build>/app.js therefore pinned a
// `302 -> /login` there, and every visitor routed through that location got an
// empty app after a good login (a phone on holiday, Oct 2026, while the desktop
// at home was fine). See src/web/frontend-assets.ts.
//
// Mirrors server.ts: the asset router is mounted ahead of everything gated, and
// what it doesn't serve falls through. A stand-in gate behind it answers the
// way requireAuth does for a logged-out page request, so "fell through" and
// "served" are told apart by status alone.

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createFrontendAssetRouter } from '../../../src/web/frontend-assets.js';

const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, 'src/web/public');
const ASSETS_DIR = path.join(ROOT, 'assets');

function makeApp() {
  const app = express();
  app.use(createFrontendAssetRouter(PUBLIC_DIR, ASSETS_DIR));
  app.use((_req, res) => res.redirect('/login'));
  return app;
}

/** Every file under `dir`, as forward-slash paths relative to it. */
function walk(dir: string, rel = ''): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walk(dir, child) : [child];
  });
}

const files = walk(PUBLIC_DIR);
const nonHtml = files.filter((f) => !f.endsWith('.html'));

describe('frontend assets are served without a session', () => {
  it('finds the frontend on disk', () => {
    // Guards against every assertion below passing over an empty list.
    expect(nonHtml).toContain('app.js');
    expect(nonHtml).toContain('public-share.js');
    expect(nonHtml).toContain('lib/ui.js');
  });

  it('serves every script and stylesheet at its versioned URL, immutable', async () => {
    const app = makeApp();
    const failures: string[] = [];
    for (const file of nonHtml) {
      const res = await request(app).get(`/v/testbuild/${file}`);
      if (res.status !== 200) failures.push(`${file} -> ${res.status}`);
      else if (!/immutable/.test(String(res.headers['cache-control']))) failures.push(`${file} not immutable`);
    }
    expect(failures).toEqual([]);
  });

  it('serves the bare URL too, uncached', async () => {
    const app = makeApp();
    const res = await request(app).get('/lib/ui.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it('serves Chart.js', async () => {
    const res = await request(makeApp()).get('/v/testbuild/vendor/chart.umd.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
  });

  it('serves the resource icons and calibration examples the pages reference', async () => {
    const app = makeApp();
    for (const dir of ['resource-icons', 'calibration-examples']) {
      const [first] = fs.readdirSync(path.join(ASSETS_DIR, dir));
      const res = await request(app).get(`/assets/${dir}/${first}`);
      expect(res.status, `${dir}/${first}`).toBe(200);
    }
  });
});

describe('what the asset router leaves to the gated routes', () => {
  it('never serves an HTML shell — those go through the version rewriter behind auth', async () => {
    const app = makeApp();
    for (const file of files.filter((f) => f.endsWith('.html'))) {
      expect((await request(app).get(`/v/testbuild/${file}`)).status, file).toBe(302);
      expect((await request(app).get(`/${file}`)).status, file).toBe(302);
    }
  });

  it('falls through on a directory instead of redirecting to a trailing slash', async () => {
    const app = makeApp();
    expect((await request(app).get('/lib')).status).toBe(302);
    expect((await request(app).get('/v/testbuild/lib')).headers.location).toBe('/login');
    expect((await request(app).get('/')).headers.location).toBe('/login');
  });

  it('keeps the rest of assets/ out of reach', async () => {
    const [model] = fs.readdirSync(path.join(ASSETS_DIR, 'paddle-models'));
    expect((await request(makeApp()).get(`/assets/paddle-models/${model}`)).status).toBe(302);
  });
});
