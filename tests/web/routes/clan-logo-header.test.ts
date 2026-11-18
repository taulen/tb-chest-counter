/**
 * The clan's in-game logo in the headers: the signed-in app's clan switcher
 * (GET /api/clans/switcher, each clan's own logo) and the public share board
 * (/api/public/:token/clan → clanLogoUrl, the token's clan's). Each names its
 * own clan's logo only, and null until a scan has read one.
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

vi.mock('../../../src/discord/bot.js', () => ({
  startClanBot: vi.fn(),
  stopClanBot: vi.fn(),
  sendClanTestMessage: vi.fn(async () => ({ ok: true })),
  isClanBotConnected: vi.fn(() => false),
}));

vi.mock('../../../src/scheduler/loop.js', () => ({
  ScanLoop: class {},
}));

// Every request is a superadmin viewing clan 1.
vi.mock('../../../src/web/middleware/auth.js', () => {
  const asSuperadmin = (req: import('express').Request, _res: import('express').Response, next: import('express').NextFunction) => {
    req.user = { id: 1, username: 'test-admin', role: 'superadmin', clanId: 1 } as never;
    req.clanId = 1;
    next();
  };
  return {
    requireAuth: asSuperadmin,
    requireAdmin: asSuperadmin,
    requireSuperAdmin: asSuperadmin,
    requireClanAccess: asSuperadmin,
    requireClanAdmin: asSuperadmin,
    SESSION_COOKIE_NAME: 'session',
  };
});

import { createClansRouter } from '../../../src/web/routes/clans.js';
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

  it('the app\'s clan switcher gets each clan\'s own logo, and none before a scan read it', async () => {
    const app = express();
    app.use('/api/clans', createClansRouter());
    const logos = async () => new Map(
      ((await request(app).get('/api/clans/switcher')).body.clans as Array<{ id: number; logoUrl: string | null }>)
        .map((c) => [c.id, c.logoUrl]),
    );

    expect(await logos()).toEqual(new Map([[1, null], [2, null]]));
    saveClanInfo(1, clanInfo(11, 'CWB', CWB));
    saveClanInfo(2, clanInfo(22, 'SIK', SIK));
    expect(await logos()).toEqual(new Map([
      [1, `/game-art/v1/clan-logo/${CWB}.png`],
      [2, `/game-art/v1/clan-logo/${SIK}.png`],
    ]));
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
