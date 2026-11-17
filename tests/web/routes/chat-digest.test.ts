import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../../src/config/index.js', () => ({
  loadConfig: () => ({ gameDayRolloverUtcHour: 17 }),
}));

// Every request is a clan admin of clan 1 (requireClanAdmin's job is tested elsewhere).
vi.mock('../../../src/web/middleware/auth.js', () => {
  const pass = (req: import('express').Request, _res: import('express').Response, next: import('express').NextFunction) => {
    req.user = { id: 1, username: 'test-admin', role: 'superadmin', clanId: 1 } as never;
    req.clanId = 1;
    next();
  };
  return { requireAuth: pass, requireAdmin: pass, requireSuperAdmin: pass, requireClanAccess: pass, requireClanAdmin: pass, SESSION_COOKIE_NAME: 'session' };
});

// The transport must never be reached from a route: saving and queueing never send.
vi.mock('../../../src/game-protocol/chat-send.js', async (orig) => {
  const real = await orig<typeof import('../../../src/game-protocol/chat-send.js')>();
  return { ...real, sendOverSocket: vi.fn(async () => { throw new Error('a route must never send'); }) };
});

import { createChatDigestRouter } from '../../../src/web/routes/clans/chat-digest.js';
import { getDb } from '../../../src/data/database.js';
import { getChatDigestSettings, setPostableChannels } from '../../../src/data/repositories/chat-digest-repo.js';
import { createUser } from '../../../src/data/repositories/user-repo.js';
import { makeTestDb } from '../../helpers/test-db.js';

const CARTER = { url: 'sendbird_group_channel_carter', customType: 'publicGroup', name: 'CWB • Carter', memberCount: 74 };
const VAULTS = { url: 'sendbird_group_channel_vaults', customType: 'publicGroup', name: 'CWB • Vaults', memberCount: 96 };
const CLAN_CHAT = { url: 'triumph_clan_channel_1297080123906', customType: 'clanGroup', name: 'game_config.value.chat.clan_group_key', memberCount: 69 };
const REALM = { url: 'triumph_realm_channel_260', customType: 'realmGroup', name: 'Kingdom', memberCount: 1452 };

describe('clans → in-game chat digest routes', () => {
  let cleanup: () => void;
  let app: express.Express;

  beforeEach(() => {
    ({ cleanup } = makeTestDb());
    createUser('test-admin', 'irrelevant-pw-1234', 'superadmin');
    // Even if bad rows got stored, the picker must not offer them.
    setPostableChannels(1, [CARTER, VAULTS, CLAN_CHAT, REALM], { userId: 'tb:1', name: 'D4DDYLiZ' });
    app = express();
    app.use(express.json());
    app.use('/api/clans', createChatDigestRouter());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    cleanup();
  });

  it('offers only the named group chats — never the clan chat or the kingdom chat', async () => {
    const r = await request(app).get('/api/clans/1/chat-digest');
    expect(r.status).toBe(200);
    expect(r.body.channels.map((c: { name: string }) => c.name)).toEqual(['CWB • Carter', 'CWB • Vaults']);
    expect(r.body.settings.enabled).toBe(false);
    expect(r.body.settings.posterName).toBe('D4DDYLiZ');
    expect(r.body.preview).toMatchObject({ gameDate: expect.any(String), maxChars: 898, maxBytes: 1114 });
  });

  it('refuses the clan chat as the target and saves a group chat without posting anything', async () => {
    expect((await request(app).put('/api/clans/1/chat-digest').send({ enabled: true, channelUrl: CLAN_CHAT.url, entries: 20, postUtcMinute: 1050 })).status).toBe(400);
    expect((await request(app).put('/api/clans/1/chat-digest').send({ enabled: true, channelUrl: REALM.url, entries: 20, postUtcMinute: 1050 })).status).toBe(400);
    expect((await request(app).put('/api/clans/1/chat-digest').send({ enabled: true, channelUrl: CARTER.url, entries: 99, postUtcMinute: 1050 })).status).toBe(400);
    const ok = await request(app).put('/api/clans/1/chat-digest').send({ enabled: true, channelUrl: CARTER.url, entries: 20, postUtcMinute: 1050 });
    expect(ok.status).toBe(200);
    expect(getChatDigestSettings(1)).toMatchObject({ enabled: true, channelUrl: CARTER.url, channelName: 'CWB • Carter', entries: 20 });
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM chat_digest_posts').get() as { n: number }).n).toBe(0);
  });

  it('queues a test post, and refuses it once the day\'s message is used up or sending is switched off', async () => {
    await request(app).put('/api/clans/1/chat-digest').send({ enabled: true, channelUrl: CARTER.url, entries: 20, postUtcMinute: 1050 });
    const q = await request(app).post('/api/clans/1/chat-digest/test');
    expect(q.status).toBe(202);
    expect(getChatDigestSettings(1).testRequestedAt).not.toBeNull();

    const { body } = await request(app).get('/api/clans/1/chat-digest');
    getDb().prepare(
      `INSERT INTO chat_digest_posts (clan_id, game_date, sent_game_date, channel_url, status, attempts, text, created_at, updated_at)
       VALUES (1, ?, '2026-11-16', ?, 'sent', 1, 'x', 'now', 'now')`,
    ).run(body.preview.gameDate, CARTER.url);
    const used = await request(app).post('/api/clans/1/chat-digest/test');
    expect(used.status).toBe(409);
    expect(used.body.code).toBe('posted');

    vi.stubEnv('CHAT_SEND_DISABLED', '1');
    expect((await request(app).post('/api/clans/1/chat-digest/test')).status).toBe(409);
  });
});
