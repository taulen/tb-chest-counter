/**
 * Chat storage is permanent (chat-repo.ts, v113): the chat service only serves
 * recent history, so a line it stops returning must stay ours. A re-read never
 * deletes or blanks a message; only a real edit replaces the text, keeping the
 * old one. The read side is pinned to the clan's own clanGroup channel.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import {
  chatHistoryInfo, chatSenders, clanChatChannels, ftsQuery, isChatHistoryComplete, markChatHistoryComplete,
  oldestChatMessageAt, readChatPage, saveChatMessages, upsertChatChannel,
} from '../../src/data/repositories/chat-repo.js';
import type { ChatMessage } from '../../src/game-protocol/chat.js';
import { makeTestDb, seedTwoClans } from '../helpers/test-db.js';

let cleanup: () => void;
beforeEach(() => { ({ cleanup } = makeTestDb()); seedTwoClans(); });
afterEach(() => cleanup());

const CLAN_URL = 'triumph_clan_channel_1297080123906';
const WHISPER_URL = 'whisper_1_2';
const T0 = 1_794_900_000_000;

function msg(id: number, at: number, text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    messageId: id, channelUrl: CLAN_URL, createdAt: at, customType: 'user', senderId: 'tb:1',
    senderName: 'taulen302', senderInfo: '104,12e00000c87,12e00000202,0,2,CWB', message: text, data: '',
    updatedAt: 0, translations: '', ...extra,
  };
}

function channel(url: string, customType: string) {
  return { url, customType, name: '', memberCount: 0, members: [], lastMessageAt: null };
}

const stored = () => getDb().prepare('SELECT message_id, message, previous_message FROM chat_messages ORDER BY message_id').all();

describe('chat storage', () => {
  beforeEach(() => {
    upsertChatChannel(1, channel(CLAN_URL, 'clanGroup'));
  });

  it('keeps every message for good: a later read that no longer returns it changes nothing', () => {
    expect(saveChatMessages(1, [msg(1, T0, 'first'), msg(2, T0 + 1000, 'second')])).toBe(2);
    // The service's window moved on: message 1 is gone from the read.
    expect(saveChatMessages(1, [msg(2, T0 + 1000, 'second'), msg(3, T0 + 2000, 'third')])).toBe(1);
    expect(stored()).toEqual([
      { message_id: 1, message: 'first', previous_message: null },
      { message_id: 2, message: 'second', previous_message: null },
      { message_id: 3, message: 'third', previous_message: null },
    ]);
  });

  it('an edit replaces the text and keeps the earlier one; an empty re-read never blanks it', () => {
    saveChatMessages(1, [msg(1, T0, 'hello')]);
    expect(saveChatMessages(1, [msg(1, T0, 'hello, clan', { updatedAt: T0 + 5000 })])).toBe(0);
    saveChatMessages(1, [msg(1, T0, '')]);
    expect(stored()).toEqual([{ message_id: 1, message: 'hello, clan', previous_message: 'hello' }]);
  });

  it('remembers how far back the history goes and when the start is reached', () => {
    saveChatMessages(1, [msg(5, T0 + 5000, 'b'), msg(4, T0 + 4000, 'a')]);
    expect(oldestChatMessageAt(1, CLAN_URL)).toBe(T0 + 4000);
    expect(isChatHistoryComplete(1, CLAN_URL)).toBe(false);
    markChatHistoryComplete(1, CLAN_URL);
    expect(isChatHistoryComplete(1, CLAN_URL)).toBe(true);
    expect(chatHistoryInfo(1, [CLAN_URL])).toEqual({ total: 2, oldestAt: T0 + 4000, newestAt: T0 + 5000, complete: true });
  });
});

describe('reading the clan chat', () => {
  beforeEach(() => {
    upsertChatChannel(1, channel(CLAN_URL, 'clanGroup'));
    upsertChatChannel(1, channel(WHISPER_URL, 'whisper'));
    upsertChatChannel(2, channel('triumph_clan_channel_42', 'clanGroup'));
    const loc = JSON.stringify({ subs: { '/%0%/': { type: 'coord', entryType: 'user', x: 808, y: 40, realmId: 260, staticId: 4, name: 'Kajim', v: 1 } } });
    saveChatMessages(1, [
      msg(10, T0, 'Good morning clan'),
      msg(11, T0 + 1000, 'Тинмен через два часа', { senderName: 'Рили', senderInfo: '104,12e000003e8,12e00000202,0,4,CWB' }),
      msg(12, T0 + 1000, '/%0%/', { data: loc }),
      msg(13, T0 + 3000, 'secret', { channelUrl: WHISPER_URL }),
    ]);
    saveChatMessages(2, [msg(20, T0 + 2000, 'other clan morning', { channelUrl: 'triumph_clan_channel_42' })]);
  });

  it('lists only the clan\'s own clanGroup channel — never private messages, never another clan', () => {
    expect(clanChatChannels(1)).toEqual([CLAN_URL]);
    const all = readChatPage(1, clanChatChannels(1), {}).map((m) => m.messageId);
    expect(all).toEqual([12, 11, 10]);
    expect(all).not.toContain(13);
    expect(all).not.toContain(20);
  });

  it('prefers the channel of the game clan the latest capture read', () => {
    upsertChatChannel(1, channel('triumph_clan_channel_7', 'clanGroup'));
    getDb().prepare(`INSERT INTO game_capture_runs (clan_id, started_at, game_clan_id) VALUES (1, '2026-11-17T00:00:00Z', 1297080123906)`).run();
    expect(clanChatChannels(1)).toEqual([CLAN_URL]);
  });

  it('pages newest first by (time, message id), and reads the newer side oldest first', () => {
    const channels = clanChatChannels(1);
    const first = readChatPage(1, channels, { limit: 2 });
    expect(first.map((m) => m.messageId)).toEqual([12, 11]);
    const older = readChatPage(1, channels, { limit: 2, before: { at: first[1].createdAt, id: first[1].messageId } });
    expect(older.map((m) => m.messageId)).toEqual([10]);
    const newer = readChatPage(1, channels, { after: { at: T0, id: 10 } });
    expect(newer.map((m) => m.messageId)).toEqual([11, 12]);
  });

  it('searches words as prefixes, in any script, including the names behind a shared location', () => {
    const channels = clanChatChannels(1);
    expect(readChatPage(1, channels, { q: 'morn' }).map((m) => m.messageId)).toEqual([10]);
    expect(readChatPage(1, channels, { q: 'тинм' }).map((m) => m.messageId)).toEqual([11]);
    expect(readChatPage(1, channels, { q: 'kajim' }).map((m) => m.messageId)).toEqual([12]);
    // By sender name too.
    expect(readChatPage(1, channels, { q: 'рили' }).map((m) => m.messageId)).toEqual([11]);
    // Never another clan's or a private line.
    expect(readChatPage(1, channels, { q: 'secret' })).toEqual([]);
    expect(readChatPage(1, channels, { q: 'other' })).toEqual([]);
    // Typed FTS syntax is only ever words.
    expect(ftsQuery('a"b OR (c*')).toBe('"a"* "b"* "OR"* "c"*');
    expect(readChatPage(1, channels, { q: '"*' })).toEqual([]);
  });

  it('filters by sender and time', () => {
    const channels = clanChatChannels(1);
    expect(readChatPage(1, channels, { senderPlayerId: 0x12e000003e8 }).map((m) => m.messageId)).toEqual([11]);
    expect(readChatPage(1, channels, { fromMs: T0 + 1, toMs: T0 + 2000 }).map((m) => m.messageId)).toEqual([12, 11]);
    expect(chatSenders(1, channels)).toEqual([
      { playerId: 0x12e00000c87, name: 'taulen302', messages: 2, lastAt: T0 + 1000 },
      { playerId: 0x12e000003e8, name: 'Рили', messages: 1, lastAt: T0 + 1000 },
    ]);
  });

  it('deleting the clan clears its chat and the search index with it', () => {
    getDb().prepare('DELETE FROM chat_messages WHERE clan_id = 1').run();
    const n = getDb().prepare("SELECT COUNT(*) AS n FROM chat_messages_fts WHERE chat_messages_fts MATCH 'morning'").get() as { n: number };
    expect(n.n).toBe(1); // only clan 2's line is left
  });
});
