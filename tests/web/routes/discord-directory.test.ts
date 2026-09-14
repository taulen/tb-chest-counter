// Role scoping on the Discord directory lookup.
//
// The dropdowns on the clan card are filled from the bot's own view of
// Discord, and that view belongs to the TOKEN, not to the clan: one bot
// invited to two servers reports both. A superadmin should see that whole
// reach. A clan admin should not — otherwise the picker hands them the other
// clan's channel list and member roster, and a channel to post their own
// clan's reports into.
//
// This is discovery scoping only, and the tests are written to say so: the
// same admin can still rewrite the clan's bot token and still paste a raw
// channel id into the manual field. What is pinned here is what the UI will
// *offer* them.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// The role under test. Mutable so one auth mock can serve every case —
// vi.mock is hoisted, so this has to be a module-level binding the factory
// closes over rather than a value captured at mock time.
let currentUser = { id: 1, username: 'test-admin', role: 'superadmin', clanId: 1 };

vi.mock('../../../src/discord/bot.js', () => ({
  startClanBot: vi.fn(),
  stopClanBot: vi.fn(),
  reloadClanBot: vi.fn(async () => {}),
  sendClanTestMessage: vi.fn(async () => ({ ok: true })),
  sendClanDigestDmTest: vi.fn(async () => ({ ok: true })),
  isClanBotConnected: vi.fn(() => false),
}));

vi.mock('../../../src/browser/launcher.js', () => ({
  launchBrowser: vi.fn(),
  closeBrowser: vi.fn(async () => {}),
}));

vi.mock('../../../src/scheduler/loop.js', () => ({ ScanLoop: class {} }));

vi.mock('../../../src/config/index.js', () => ({
  loadConfig: () => ({ gameDayRolloverUtcHour: 17 }),
}));

// The bot is in TWO servers. That is the whole point of the fixture: with a
// single-guild bot every assertion below passes for the wrong reason.
const GUILD_OWN = '1000000000000000001';
const GUILD_OTHER = '2000000000000000002';

vi.mock('../../../src/discord/directory.js', () => ({
  fetchBotGuilds: vi.fn(async () => [
    { id: GUILD_OWN, name: 'Our Clan Server' },
    { id: GUILD_OTHER, name: 'Someone Elses Server' },
  ]),
  fetchDiscordDirectory: vi.fn(async (_token: string, guildId: string | null) => ({
    guilds: [
      { id: GUILD_OWN, name: 'Our Clan Server' },
      { id: GUILD_OTHER, name: 'Someone Elses Server' },
    ],
    channels: guildId ? [{ id: '55', name: 'general', categoryName: null }] : [],
    members: guildId ? [{ id: '77', name: 'Someone', username: 'someone' }] : [],
    guildId,
    membersUnavailable: null,
  })),
  describeDiscordError: vi.fn((err: unknown) => String(err)),
}));

vi.mock('../../../src/web/middleware/auth.js', () => {
  const inject = (req: import('express').Request, _res: import('express').Response, next: import('express').NextFunction) => {
    req.user = { ...currentUser } as never;
    req.clanId = currentUser.clanId;
    next();
  };
  return {
    requireAuth: inject,
    requireAdmin: inject,
    requireSuperAdmin: inject,
    requireClanAccess: inject,
    requireClanAdmin: inject,
    SESSION_COOKIE_NAME: 'session',
  };
});

import { createClansRouter } from '../../../src/web/routes/clans.js';
import { fetchDiscordDirectory } from '../../../src/discord/directory.js';
import { setClanDiscordSettings } from '../../../src/data/repositories/clan-repo.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';
import { createUser } from '../../../src/data/repositories/user-repo.js';

/** Give clan 1 a token, and optionally a saved guild to be pinned to. */
function configureClan1(guildId: string): void {
  setClanDiscordSettings(1, {
    enabled: true,
    token: 'bot-token-for-clan-1',
    channelId: '',
    guildId,
    scanReportsEnabled: true,
    onlyNewChests: false,
    dailyDigestEnabled: false,
    dailyDigestShareUserId: '',
    commandsEnabled: false,
  });
}

describe('POST /api/clans/:id/discord/directory — role scoping', () => {
  let cleanup: () => void;
  let app: express.Express;

  beforeEach(() => {
    const t = makeTestDb();
    cleanup = t.cleanup;
    seedTwoClans();
    createUser('test-admin', 'irrelevant-pw-1234', 'superadmin');
    currentUser = { id: 1, username: 'test-admin', role: 'superadmin', clanId: 1 };
    app = express();
    app.use(express.json());
    app.use('/api/clans', createClansRouter());
  });

  afterEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it('gives a superadmin the bot\'s whole reach', async () => {
    configureClan1(GUILD_OWN);
    const res = await request(app).post('/api/clans/1/discord/directory').send({});
    expect(res.status).toBe(200);
    expect(res.body.guilds.map((g: { id: string }) => g.id)).toEqual([GUILD_OWN, GUILD_OTHER]);
    expect(res.body.scopedToGuildId).toBeNull();
  });

  it('pins a clan admin to the guild their clan already uses', async () => {
    configureClan1(GUILD_OWN);
    currentUser = { id: 1, username: 'test-admin', role: 'admin', clanId: 1 };
    const res = await request(app).post('/api/clans/1/discord/directory').send({});
    expect(res.status).toBe(200);
    expect(res.body.guilds.map((g: { id: string }) => g.id)).toEqual([GUILD_OWN]);
    expect(res.body.scopedToGuildId).toBe(GUILD_OWN);
  });

  it('ignores a clan admin asking for another guild', async () => {
    configureClan1(GUILD_OWN);
    currentUser = { id: 1, username: 'test-admin', role: 'admin', clanId: 1 };
    const res = await request(app)
      .post('/api/clans/1/discord/directory')
      .send({ guildId: GUILD_OTHER });
    expect(res.status).toBe(200);
    // The lookup itself must run against the pinned guild — filtering only
    // the guild list would still have returned the other server's channels
    // and members in the same response.
    expect(vi.mocked(fetchDiscordDirectory)).toHaveBeenCalledWith(expect.any(String), GUILD_OWN);
    expect(res.body.guilds.map((g: { id: string }) => g.id)).toEqual([GUILD_OWN]);
  });

  it('leaves the list open for a clan admin with no guild saved yet', async () => {
    // First-time setup: there is nothing to pin to, and an empty dropdown
    // would make the integration impossible to configure without a superadmin.
    configureClan1('');
    currentUser = { id: 1, username: 'test-admin', role: 'admin', clanId: 1 };
    const res = await request(app).post('/api/clans/1/discord/directory').send({});
    expect(res.status).toBe(200);
    expect(res.body.guilds).toHaveLength(2);
    expect(res.body.scopedToGuildId).toBeNull();
  });

  it('leaves the list open when the saved guild is one the bot has left', async () => {
    // Pinning to a guild the bot can no longer see would strand the admin on
    // a dead server with no channels and no way to pick a live one.
    configureClan1('9999999999999999999');
    currentUser = { id: 1, username: 'test-admin', role: 'admin', clanId: 1 };
    const res = await request(app).post('/api/clans/1/discord/directory').send({});
    expect(res.status).toBe(200);
    expect(res.body.guilds).toHaveLength(2);
    expect(res.body.scopedToGuildId).toBeNull();
  });
});
