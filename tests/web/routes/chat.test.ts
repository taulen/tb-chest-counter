// /api/chat with real auth: the stored CLAN chat for any member of the active
// clan — never private messages, never another clan's chat.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createChatRouter, resetChatNamesCache } from '../../../src/web/routes/chat.js';
import { requireAuth, requireClanContext, SESSION_COOKIE_NAME } from '../../../src/web/middleware/auth.js';
import { makeTestDb, seedTwoClans } from '../../helpers/test-db.js';
import * as userRepo from '../../../src/data/repositories/user-repo.js';
import { getDb } from '../../../src/data/database.js';
import { saveChatMessages, upsertChatChannel } from '../../../src/data/repositories/chat-repo.js';
import type { ChatMessage } from '../../../src/game-protocol/chat.js';
import type { GameNames } from '../../../src/game-protocol/static-data.js';

const T0 = 1_794_900_000_000;
const CLAN1 = 'triumph_clan_channel_111';
const CLAN2 = 'triumph_clan_channel_222';
const WHISPER = 'whisper_tb1_tb2';

const msg = (channelUrl: string, id: number, at: number, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  messageId: id, channelUrl, createdAt: at, customType: 'user', senderId: 'tb:1', senderName: 'Alice',
  senderInfo: '104,65,6f,0,3,CWB', message: text, data: '', updatedAt: 0, translations: '', ...extra,
});
const channel = (url: string, customType: string) => ({ url, customType, name: '', memberCount: 0, members: [], lastMessageAt: null });

describe('/api/chat', () => {
  let app: express.Express;
  let cleanup: () => void;
  let cookies: Record<'user1' | 'user2', string>;

  beforeEach(() => {
    cleanup = makeTestDb().cleanup;
    seedTwoClans();
    const su = userRepo.createUser('su', 'Test1234!aA', 'superadmin');
    const mk = (name: string, clanId: number) => {
      const u = userRepo.createUser(name, 'Test1234!aA', 'user', su.id, clanId);
      return `${SESSION_COOKIE_NAME}=${userRepo.createSession(u.id)}`;
    };
    cookies = { user1: mk('u1', 1), user2: mk('u2', 2) };

    upsertChatChannel(1, channel(CLAN1, 'clanGroup'));
    upsertChatChannel(1, channel(WHISPER, 'whisper'));
    upsertChatChannel(2, channel(CLAN2, 'clanGroup'));
    const loc = JSON.stringify({ subs: { '/%0%/': { type: 'coord', entryType: 'user', x: 808, y: 40, realmId: 260, staticId: 4, name: 'Kajim', v: 1 } } });
    saveChatMessages(1, [
      msg(CLAN1, 1, T0, 'morning all'),
      msg(CLAN1, 2, T0 + 1000, '/%0%/', { data: loc }),
      msg(CLAN1, 3, T0 + 2000, 'raid at 18'),
      msg(WHISPER, 4, T0 + 3000, 'private hello'),
    ]);
    saveChatMessages(2, [msg(CLAN2, 5, T0, 'clan two morning')]);
    // Alice (player 0x65 = 101) is a linked member of clan 1.
    getDb().prepare(`INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, game_player_id) VALUES (1, 'Alice', 'alice', '', '', 101)`).run();
    resetChatNamesCache({ objects: { 4: 'Portal' } } as unknown as GameNames);

    app = express();
    app.use('/api/chat', requireAuth, requireClanContext, createChatRouter());
  });

  afterEach(() => {
    resetChatNamesCache();
    cleanup();
  });

  const get = (path: string, who: keyof typeof cookies) => request(app).get(path).set('Accept', 'application/json').set('Cookie', cookies[who]);

  it('needs a signed-in member', async () => {
    expect((await request(app).get('/api/chat/clan').set('Accept', 'application/json')).status).toBe(401);
  });

  it('serves the clan chat newest first, never a private message, never another clan', async () => {
    const r = await get('/api/chat/clan', 'user1');
    expect(r.status).toBe(200);
    expect(r.body.messages.map((m: { text: string }) => m.text)).toEqual(['raid at 18', '/%0%/', 'morning all']);
    expect(JSON.stringify(r.body)).not.toContain('private hello');
    expect(JSON.stringify(r.body)).not.toContain('clan two');
    expect(r.body.history).toMatchObject({ total: 3, oldestAt: T0, complete: false });

    const other = await get('/api/chat/clan', 'user2');
    expect(other.body.messages.map((m: { text: string }) => m.text)).toEqual(['clan two morning']);
  });

  it('carries the sender (rank at the time, member link) and resolves game object names', async () => {
    const r = await get('/api/chat/clan', 'user1');
    const loc = r.body.messages.find((m: { text: string }) => m.text === '/%0%/');
    expect(loc.sender).toEqual({ name: 'Alice', playerId: 101, rank: 3, tag: 'CWB' });
    expect(loc.subs['/%0%/']).toMatchObject({ type: 'coord', name: 'Kajim', staticId: 4 });
    expect(r.body.objects).toEqual({ 4: 'Portal' });
    expect(r.body.people[101]).toMatchObject({ memberId: expect.any(Number) });
  });

  it('pages with cursors, reads the newer side, searches and filters', async () => {
    const page = await get('/api/chat/clan?limit=2', 'user1');
    expect(page.body.hasMore).toBe(true);
    const last = page.body.messages[1].key;
    const older = await get(`/api/chat/clan?limit=2&before=${last}`, 'user1');
    expect(older.body.messages.map((m: { text: string }) => m.text)).toEqual(['morning all']);
    const newer = await get(`/api/chat/clan?after=${T0}:1`, 'user1');
    expect(newer.body.messages.map((m: { text: string }) => m.text)).toEqual(['/%0%/', 'raid at 18']);

    const found = await get('/api/chat/clan?q=kaj', 'user1');
    expect(found.body.messages.map((m: { text: string }) => m.text)).toEqual(['/%0%/']);
    const none = await get('/api/chat/clan?q=private', 'user1');
    expect(none.body.messages).toEqual([]);
    const bySender = await get('/api/chat/clan?sender=101', 'user1');
    expect(bySender.body.messages).toHaveLength(3);
    const window = await get(`/api/chat/clan?from=${T0 + 1}&to=${T0 + 2000}`, 'user1');
    expect(window.body.messages.map((m: { text: string }) => m.text)).toEqual(['/%0%/']);
  });

  it('says how many messages a search matches in the whole history, on its first page', async () => {
    const r = await get('/api/chat/clan?q=morning', 'user1');
    expect(r.body.matches).toEqual({ total: 1, oldestAt: T0 });
    const unfiltered = await get('/api/chat/clan', 'user1');
    expect(unfiltered.body.matches).toBeNull();
    const page2 = await get(`/api/chat/clan?q=morning&before=${T0}:1`, 'user1');
    expect(page2.body.matches).toBeNull();
  });

  it('opens the conversation at a message or at a time — unfiltered, and only this clan\'s', async () => {
    const at = await get(`/api/chat/clan/context?around=${T0 + 1000}:2`, 'user1');
    expect(at.status).toBe(200);
    expect(at.body.messages.map((m: { text: string }) => m.text)).toEqual(['morning all', '/%0%/', 'raid at 18']);
    expect(at.body).toMatchObject({ focus: `${T0 + 1000}:2`, hasOlder: false, hasNewer: false });
    expect(JSON.stringify(at.body)).not.toContain('private hello');

    const day = await get(`/api/chat/clan/context?at=${T0 + 1500}`, 'user1');
    expect(day.body.focus).toBe(`${T0 + 2000}:3`);

    // Another clan's message id opens nothing of theirs.
    const other = await get(`/api/chat/clan/context?around=${T0}:5`, 'user1');
    expect(JSON.stringify(other.body.messages)).not.toContain('clan two');
    expect(other.body.focus).toBeNull();
  });

  it('lists who wrote in the clan chat, without private-message senders', async () => {
    saveChatMessages(1, [msg(WHISPER, 9, T0, 'psst', { senderInfo: '104,c8,6f,0,5,CWB', senderName: 'Bob' })]);
    const r = await get('/api/chat/clan/senders', 'user1');
    expect(r.body.senders).toEqual([{ playerId: 101, name: 'Alice', messages: 3, lastAt: T0 + 2000, memberId: expect.any(Number) }]);
  });
});
