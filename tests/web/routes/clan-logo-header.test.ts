/**
 * The clan's in-game logo in the headers: the signed-in app's clan label /
 * switcher (GET /api/game/clan/logo, the ACTIVE clan's) and the public share
 * board (/api/public/:token/clan → clanLogoUrl, the token's clan's). Each
 * names its own clan's logo only, and null until a scan has read one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// No extracted art in a test: a logo code maps straight to its URL.
vi.mock('../../../src/game-art/clan-logo.js', async (orig) => {
  const real = await orig<typeof import('../../../src/game-art/clan-logo.js')>();
  return {
    ...real,
    clanLogoUrl: (code: number | null | undefined) => (typeof code === 'number' ? `/game-art/v1/clan-logo/${code}.png` : null),
  };
});

import { createGameRouter } from '../../../src/web/routes/game.js';
import { createPublicShareApiRouter } from '../../../src/web/routes/public-share.js';
import { saveClanInfo } from '../../../src/data/repositories/game-clan-repo.js';
import { createShareLink } from '../../../src/data/repositories/share-link-repo.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';

const CWB = 1118480;
const SIK = 660741;

function clanInfo(gameClanId: number, tag: string, logo: number | null) {
  return { gameClanId, tag, name: tag, foundedAt: null, language: 'en', capitalId: null, position: null, logo };
}

describe('the clan logo in the headers', () => {
  let cleanup: () => void;

  beforeEach(() => {
    ({ cleanup } = makeTestDb());
    seedTwoClans();
  });
  afterEach(() => cleanup());

  function gameApp(activeClanId: number): express.Express {
    const app = express();
    app.use((req, _res, next) => {
      req.clanId = activeClanId;
      next();
    });
    app.use('/api/game', createGameRouter());
    return app;
  }

  it('the app header gets the ACTIVE clan\'s logo, and none before a scan read it', async () => {
    expect((await request(gameApp(1)).get('/api/game/clan/logo')).body).toEqual({ logoUrl: null });
    saveClanInfo(1, clanInfo(11, 'CWB', CWB));
    saveClanInfo(2, clanInfo(22, 'SIK', SIK));
    expect((await request(gameApp(1)).get('/api/game/clan/logo')).body).toEqual({ logoUrl: `/game-art/v1/clan-logo/${CWB}.png` });
    expect((await request(gameApp(2)).get('/api/game/clan/logo')).body).toEqual({ logoUrl: `/game-art/v1/clan-logo/${SIK}.png` });
  });

  it('the share board gets the token clan\'s logo, never another clan\'s', async () => {
    createShareLink(1, 'aAaA11', null);
    const app = express();
    app.use('/api/public', createPublicShareApiRouter());

    expect((await request(app).get('/api/public/aAaA11/clan')).body.clanLogoUrl).toBeNull();
    saveClanInfo(2, clanInfo(22, 'SIK', SIK));
    expect((await request(app).get('/api/public/aAaA11/clan')).body.clanLogoUrl).toBeNull();
    saveClanInfo(1, clanInfo(11, 'CWB', CWB));
    expect((await request(app).get('/api/public/aAaA11/clan')).body.clanLogoUrl).toBe(`/game-art/v1/clan-logo/${CWB}.png`);
  });
});
