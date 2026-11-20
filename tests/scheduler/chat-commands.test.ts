/**
 * Chat commands (scheduler/chat-commands.ts): which messages are commands,
 * who gets an answer, in which chat, how often — and what the answers say.
 * Every send goes through a mock; nothing here talks to the chat service.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logged: string[] = [];
vi.mock('../../src/utils/logger.js', () => {
  const rec = (...args: unknown[]) => { logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  const l = { info: rec, warn: rec, debug: rec, error: rec, child: () => l };
  return { childLogger: () => l, getLogger: () => l, createLogger: () => l };
});

const schedule = vi.hoisted(() => ({
  byKey: {} as Record<string, { next: { from: string } | null; live: boolean; endsAt?: string }>,
  fail: false,
}));
vi.mock('../../src/external/event-calendar.js', () => ({
  getEventSchedule: vi.fn(async (key: string) => {
    if (schedule.fail) throw new Error('feed down');
    const s = schedule.byKey[key];
    return { next: s?.next ? { ...s.next, to: s.next.from, resetAt: s.next.from, label: '', isCurrent: false, estimated: false } : null, live: !!s?.live, cycleEndsAt: null };
  }),
  getEventOccurrences: vi.fn(async (key: string) => {
    const s = schedule.byKey[key];
    return s?.live && s.endsAt ? [{ from: '2026-11-17T17:00:00.000Z', to: s.endsAt, resetAt: s.endsAt, label: '', isCurrent: true, estimated: false }] : [];
  }),
}));

import { getDb } from '../../src/data/database.js';
import { setChatCommandsEnabled, setChatCommandsGroupEnabled } from '../../src/data/repositories/chat-command-repo.js';
import { saveChatDigestSettings } from '../../src/data/repositories/chat-digest-repo.js';
import { setInvitesEnabled } from '../../src/data/repositories/account-invite-repo.js';
import { setClanLeaderboardGoal } from '../../src/data/repositories/clan-repo.js';
import { chatPausedUntil, noteChatMuted } from '../../src/data/repositories/chat-send-state-repo.js';
import {
  CLAN_MAX_PER_HOUR,
  COMMAND_REPLIES_PER_RUN,
  GROUP_MAX_PER_HOUR,
  PLAYER_MAX_PER_HOUR,
  REPEAT_WINDOW_MS,
  buildCommandReply,
  commandGroupChannel,
  durationText,
  hasWaitingChatCommands,
  fitsReply,
  parseChatCommand,
  processChatCommands,
} from '../../src/scheduler/chat-commands.js';
import { COMMAND_TEXTS } from '../../src/scheduler/chat-command-texts.js';
import { isInviteKeyword, processInviteRequests } from '../../src/scheduler/chat-invites.js';
import {
  CHANNEL_MAX_LENGTH,
  MAX_COMMAND_REPLY_CHARS,
  MAX_INVITE_REPLY_CHARS,
  MAX_POST_CHARS,
  sendCommandReply,
  sendGroupCommandReply,
  sendInviteMessage,
  type SendOutcome,
} from '../../src/game-protocol/chat-send.js';
import { invalidate } from '../../src/utils/ttl-cache.js';
import { makeTestDb, seedTwoClans } from '../helpers/test-db.js';

const SCANNER = 'tb:1000';
// Wednesday 18 Nov 2026, 10:00 UTC: game day 2026-11-17, day 3 of the Sunday
// week that started 2026-11-15 17:00 UTC.
const T0 = Date.parse('2026-11-18T10:00:00.000Z');
const WEEK_FROM = Date.parse('2026-11-15T17:00:00.000Z');
const HOUR = 3600_000;
let cleanup: () => void;
let nowMs = T0;
const now = () => nowMs;

beforeEach(() => {
  ({ cleanup } = makeTestDb());
  seedTwoClans();
  invalidate('');
  logged.length = 0;
  nowMs = T0;
  schedule.byKey = {};
  schedule.fail = false;
  delete process.env.CHAT_SEND_DISABLED;
});
afterEach(() => {
  cleanup();
  invalidate('');
  delete process.env.CHAT_SEND_DISABLED;
});

let sessionId = 0;
let chestId = 0;
function base(): void {
  if (sessionId) return;
  sessionId = (getDb().prepare(
    "INSERT INTO scan_sessions (clan_id, started_at, completed_at, status, trigger_source) VALUES (1, 'x', 'x', 'completed', 'manual') RETURNING id",
  ).get() as { id: number }).id;
  chestId = (getDb().prepare("INSERT INTO chests (name, chest_type) VALUES ('Common Chest', 'common') RETURNING id").get() as { id: number }).id;
}
beforeEach(() => { sessionId = 0; chestId = 0; });

/** A roster player with a member row on the board. Returns the member id. */
function player(clanId: number, playerId: number, name: string, opts: { role?: number; joinedAtS?: number } = {}): number {
  getDb().prepare(
    `INSERT INTO game_players (clan_id, player_id, name, role, joined_at, in_clan, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, 1, '2026-10-01', '2026-11-18')`,
  ).run(clanId, playerId, name, opts.role ?? 4, opts.joinedAtS ?? 1780000000);
  return (getDb().prepare(
    `INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active, game_player_id)
     VALUES (?, ?, ?, 'x', 'x', 1, ?) RETURNING id`,
  ).get(clanId, name, name.toLowerCase(), playerId) as { id: number }).id;
}

let capture = 0;
function chest(memberId: number, points: number, atMs: number, clanId = 1): void {
  base();
  getDb().prepare(
    `INSERT INTO chest_records (clan_id, session_id, member_id, chest_id, point_value, captured_at, confidence)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  ).run(clanId, sessionId, memberId, chestId, points, atMs + (capture++ % 1000));
  invalidate('');
}

/** A stored private chat between the scanner and `chatId`, and one message in it. */
function dm(clanId: number, chatId: string, playerId: number | null, text: string, atMs: number, opts: { members?: string[]; type?: string } = {}): string {
  const url = `sendbird_group_channel_${chatId.replace(':', '')}`;
  const members = (opts.members ?? [SCANNER, chatId]).map((userId) => ({ userId, nickname: userId }));
  getDb().prepare(
    `INSERT INTO chat_channels (clan_id, channel_url, custom_type, name, member_count, members, first_seen, last_seen)
     VALUES (?, ?, ?, '', ?, ?, 'x', 'x') ON CONFLICT (clan_id, channel_url) DO NOTHING`,
  ).run(clanId, url, opts.type ?? 'whisper', members.length, JSON.stringify(members));
  getDb().prepare(
    `INSERT INTO chat_messages (clan_id, channel_url, message_id, created_at, custom_type, sender_id, sender_name, message, captured_at, sender_player_id)
     VALUES (?, ?, ?, ?, 'user', ?, 'n', ?, 'x', ?)`,
  ).run(clanId, url, Math.floor(Math.random() * 1e9), atMs, chatId, text, playerId);
  return url;
}

function sender(outcomes: SendOutcome[] = []) {
  const sent: Array<{ channelUrl: string; text: string; userId: string }> = [];
  const fn = vi.fn(async (a: { userId: string; token: string; channelUrl: string; text: string }) => {
    sent.push({ channelUrl: a.channelUrl, text: a.text, userId: a.userId });
    return outcomes.shift() ?? { status: 'sent', messageId: 777 } as SendOutcome;
  });
  return { fn, sent };
}

const requests = () => getDb().prepare('SELECT command, status, reason, player_id FROM chat_command_requests ORDER BY id')
  .all() as Array<{ command: string; status: string; reason: string | null; player_id: number }>;
const opts = (s: ReturnType<typeof sender>) => ({ scannerChatId: SCANNER, chatToken: async () => 'tok', send: s.fn, now, sleep: async () => {} });

describe('the command words', () => {
  it('are one word on their own, any case, with a leading ! or / and trailing punctuation', () => {
    for (const [text, command] of [['me', 'me'], ['!Top', 'top'], ['/points.', 'points'], ['HELP?', 'help'], ['progress', 'progress'], ['calendar', 'events'], ['crypt', 'points'], ['leaderboard', 'top'], ['missing', 'missing']] as const) {
      expect(parseChatCommand(text)?.command, text).toBe(command);
    }
    for (const no of ['what are my points', 'me please', 'hello', '', 'yo', 'pointz']) expect(parseChatCommand(no), no).toBeNull();
  });

  it('never takes an account-invite keyword: those ask for a code', () => {
    for (const w of ['code', 'invite', 'tracker', 'код', 'código']) {
      expect(isInviteKeyword(w)).toBe(true);
      expect(parseChatCommand(w), w).toBeNull();
    }
  });

  it('a word in another language picks the reply language', () => {
    expect(parseChatCommand('puntos')).toEqual({ command: 'points', lang: 'es' });
    expect(parseChatCommand('Очки')).toEqual({ command: 'points', lang: 'ru' });
    expect(parseChatCommand('Punkte!')).toEqual({ command: 'points', lang: 'de' });
    expect(parseChatCommand('événements')).toEqual({ command: 'events', lang: 'fr' });
    expect(parseChatCommand('points')).toEqual({ command: 'points', lang: null });
  });
});

describe('answering', () => {
  let alpha: number;
  beforeEach(() => {
    alpha = player(1, 11, 'Alpha');
    const beta = player(1, 12, 'Beta');
    chest(alpha, 300, WEEK_FROM + HOUR);
    chest(alpha, 100, T0 - HOUR); // today
    chest(beta, 500, WEEK_FROM + 2 * HOUR);
    setChatCommandsEnabled(1, true, T0 - 60_000);
  });

  it('a roster member asking in their 1:1 chat gets their week back there, once', async () => {
    const url = dm(1, 'tb:11', 11, 'me', T0);
    const s = sender();
    expect(await processChatCommands(1, opts(s))).toContain('1 answered');
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ channelUrl: url, userId: SCANNER });
    const text = s.sent[0].text;
    expect(text).toContain('Alpha — this week (day 3 of 7)');
    expect(text).toContain('#2 of 2 · 400 points · 2 chests');
    expect(text).toContain('Today: 100 points · 1 chest');
    expect(requests()).toEqual([{ command: 'me', status: 'sent', reason: null, player_id: 11 }]);
    // Handled once: the next minute's poll sends nothing.
    await processChatCommands(1, opts(s));
    expect(s.sent).toHaveLength(1);
  });

  it('never answers a non-member, a message from before commands were on, or commands switched off', async () => {
    dm(1, 'tb:99', 99, 'me', T0);
    dm(1, 'tb:11', 11, 'me', T0 - 5 * 60_000);
    const s = sender();
    await processChatCommands(1, opts(s));
    expect(s.sent).toHaveLength(0);
    expect(requests()).toEqual([{ command: 'me', status: 'ignored', reason: 'not-member', player_id: 99 }]);

    setChatCommandsEnabled(1, false, T0);
    dm(1, 'tb:12', 12, 'top', T0 + 1000);
    nowMs = T0 + 2000;
    await processChatCommands(1, opts(s));
    expect(s.sent).toHaveLength(0);
  });

  it('a message that is no command gets no reply and no record', async () => {
    dm(1, 'tb:11', 11, 'hi, how do I see my points?', T0);
    dm(1, 'tb:11', 11, 'thanks', T0 + 1);
    const s = sender();
    await processChatCommands(1, opts(s));
    expect(s.sent).toHaveLength(0);
    expect(requests()).toEqual([]);
  });

  it('only answers in a 1:1 chat with the scanner, from the chat account the player writes from', async () => {
    dm(1, 'tb:11', 11, 'me', T0, { members: [SCANNER, 'tb:11', 'tb:12'] });
    const s = sender();
    await processChatCommands(1, opts(s));
    expect(s.sent).toHaveLength(0);
    expect(requests()[0]).toMatchObject({ status: 'ignored', reason: 'channel' });

    // Player 12 has always written from tb:12; a message claiming to be them from tb:66 is not answered.
    getDb().prepare(
      `INSERT INTO chat_messages (clan_id, channel_url, message_id, created_at, custom_type, sender_id, sender_name, message, captured_at, sender_player_id)
       VALUES (1, 'triumph_clan_channel_5', 1, ?, 'user', 'tb:12', 'Beta', 'hello', 'x', 12)`,
    ).run(T0 - HOUR);
    dm(1, 'tb:66', 12, 'top', T0 + 10);
    nowMs = T0 + 20;
    await processChatCommands(1, opts(s));
    expect(s.sent).toHaveLength(0);
    expect(requests()[1]).toMatchObject({ status: 'ignored', reason: 'chat-account-mismatch' });
  });

  it('the same command again within the repeat window gets nothing; after it, an answer', async () => {
    dm(1, 'tb:11', 11, 'points', T0);
    const s = sender();
    await processChatCommands(1, opts(s));
    dm(1, 'tb:11', 11, 'points', T0 + 60_000);
    nowMs = T0 + 61_000;
    await processChatCommands(1, opts(s));
    expect(s.sent).toHaveLength(1);
    expect(requests()[1]).toMatchObject({ status: 'ignored', reason: 'repeat' });

    dm(1, 'tb:11', 11, 'points', T0 + REPEAT_WINDOW_MS + 60_000);
    nowMs = T0 + REPEAT_WINDOW_MS + 61_000;
    await processChatCommands(1, opts(s));
    expect(s.sent).toHaveLength(2);
  });

  it('one reply per player a run, at most COMMAND_REPLIES_PER_RUN a run; the rest wait for the next minute', async () => {
    for (let p = 20; p < 25; p++) player(1, p, `P${p}`);
    dm(1, 'tb:11', 11, 'me', T0);
    dm(1, 'tb:11', 11, 'top', T0 + 1);
    for (let p = 20; p < 25; p++) dm(1, `tb:${p}`, p, 'help', T0 + p);
    const s = sender();
    await processChatCommands(1, opts(s));
    expect(s.sent).toHaveLength(COMMAND_REPLIES_PER_RUN);
    // Alpha's second command waited, though it came before the others.
    expect(s.sent.filter((m) => m.channelUrl.endsWith('tb11'))).toHaveLength(1);
    nowMs = T0 + 60_000;
    await processChatCommands(1, opts(s));
    nowMs = T0 + 120_000;
    await processChatCommands(1, opts(s));
    expect(s.sent).toHaveLength(7);
    expect(requests().every((r) => r.status === 'sent')).toBe(true);
  });

  it('an alias of a command already waiting is a repeat too', async () => {
    dm(1, 'tb:11', 11, 'me', T0);
    dm(1, 'tb:11', 11, 'stats', T0 + 1);
    const s = sender();
    await processChatCommands(1, opts(s));
    expect(requests().map((r) => r.reason)).toEqual([null, 'repeat']);
  });

  it('a player gets at most PLAYER_MAX_PER_HOUR replies an hour', async () => {
    getDb().prepare(
      `INSERT INTO chat_command_requests (clan_id, channel_url, message_id, sender_chat_id, player_id, command, requested_at, status, attempts, sent_at, created_at, updated_at)
       SELECT 1, 'old', value, 'tb:11', 11, 'help', ? + value, 'sent', 1, ? + value, 'x', 'x' FROM json_each(?)`,
    ).run(T0 - 50 * 60_000, T0 - 50 * 60_000, JSON.stringify(Array.from({ length: PLAYER_MAX_PER_HOUR }, (_, i) => i + 1)));
    dm(1, 'tb:11', 11, 'me', T0);
    const s = sender();
    await processChatCommands(1, opts(s));
    expect(s.sent).toHaveLength(0);
    expect(requests().at(-1)).toMatchObject({ command: 'me', status: 'ignored', reason: 'player-limit' });
    // An hour after those, they count no more.
    dm(1, 'tb:11', 11, 'points', T0 + 11 * 60_000);
    nowMs = T0 + 11 * 60_000 + 1000;
    await processChatCommands(1, opts(s));
    expect(s.sent).toHaveLength(1);
  });

  it('the clan as a whole gets at most CLAN_MAX_PER_HOUR replies an hour; the rest wait', async () => {
    getDb().prepare(
      `INSERT INTO chat_command_requests (clan_id, channel_url, message_id, sender_chat_id, player_id, command, requested_at, status, attempts, sent_at, created_at, updated_at)
       SELECT 1, 'old', value, 'tb:x', 900 + value, 'me', ?, 'sent', 1, ?, 'x', 'x' FROM json_each(?)`,
    ).run(T0 - 30 * 60_000, T0 - 30 * 60_000, JSON.stringify(Array.from({ length: CLAN_MAX_PER_HOUR }, (_, i) => i + 1)));
    dm(1, 'tb:11', 11, 'me', T0);
    const s = sender();
    await processChatCommands(1, opts(s));
    expect(s.sent).toHaveLength(0);
    expect(requests().at(-1)).toMatchObject({ status: 'pending' });
    // Half an hour later the old ones have aged out of the hour.
    nowMs = T0 + 31 * 60_000;
    await processChatCommands(1, opts(s));
    expect(s.sent).toHaveLength(1);
  });

  it('nothing while the scanner account is muted; a "You are muted." refusal pauses and keeps the command waiting', async () => {
    noteChatMuted(1, 'You are muted.', T0 - 60_000);
    dm(1, 'tb:11', 11, 'me', T0);
    const s = sender();
    await processChatCommands(1, opts(s));
    expect(s.sent).toHaveLength(0);
    expect(requests()[0]).toMatchObject({ status: 'pending' });

    nowMs = chatPausedUntil(1, T0)! + 1000;
    const muted = sender([{ status: 'refused', error: 'chat refused the message: You are muted.' }]);
    await processChatCommands(1, opts(muted));
    expect(muted.sent).toHaveLength(1);
    expect(requests()[0]).toMatchObject({ status: 'pending', reason: 'muted' });
    expect(getDb().prepare('SELECT sent_at, attempts FROM chat_command_requests').get()).toEqual({ sent_at: null, attempts: 0 });
    expect(chatPausedUntil(1, nowMs)).not.toBeNull();
  });

  it('a reply with no answer is never resent; a refused one is tried again, three times at most', async () => {
    dm(1, 'tb:11', 11, 'me', T0);
    const s = sender([{ status: 'unknown', error: 'chat socket timed out' }]);
    await processChatCommands(1, opts(s));
    nowMs = T0 + 60_000;
    await processChatCommands(1, opts(s));
    expect(s.sent).toHaveLength(1);
    expect(requests()[0]).toMatchObject({ status: 'unknown' });

    dm(1, 'tb:12', 12, 'me', T0 + 1);
    const refused = sender([1, 2, 3].map(() => ({ status: 'refused', error: 'nope' }) as SendOutcome));
    for (let i = 0; i < 5; i++) {
      nowMs = T0 + (i + 2) * 60_000;
      await processChatCommands(1, opts(refused));
    }
    expect(refused.sent).toHaveLength(3);
    expect(requests()[1]).toMatchObject({ status: 'failed' });
  });

  it('no chat token now: the command waits for the next scan, and is dropped once too old', async () => {
    dm(1, 'tb:11', 11, 'me', T0);
    const s = sender();
    await processChatCommands(1, { ...opts(s), chatToken: async () => null });
    expect(s.sent).toHaveLength(0);
    expect(requests()[0]).toMatchObject({ status: 'pending' });
    nowMs = T0 + 3 * HOUR + 1000;
    await processChatCommands(1, opts(s));
    expect(s.sent).toHaveLength(0);
    expect(requests()[0]).toMatchObject({ status: 'ignored', reason: 'too-old' });
  });

  it('a waiting command asks for a scan after a restart — unless commands are off, the account is muted or it is too old', async () => {
    expect(hasWaitingChatCommands(1, T0)).toBe(false);
    dm(1, 'tb:11', 11, 'me', T0);
    const s = sender();
    await processChatCommands(1, { ...opts(s), chatToken: async () => null });
    expect(hasWaitingChatCommands(1, T0 + 1000)).toBe(true);
    expect(hasWaitingChatCommands(1, T0 + 3 * HOUR + 1000)).toBe(false);
    noteChatMuted(1, 'You are muted.', T0 + 2000);
    expect(hasWaitingChatCommands(1, T0 + 3000)).toBe(false);
    getDb().prepare('DELETE FROM chat_send_state').run();
    setChatCommandsEnabled(1, false, T0 + 4000);
    expect(hasWaitingChatCommands(1, T0 + 5000)).toBe(false);
  });

  it('CHAT_SEND_DISABLED answers nothing', async () => {
    process.env.CHAT_SEND_DISABLED = '1';
    dm(1, 'tb:11', 11, 'me', T0);
    const s = sender();
    await processChatCommands(1, opts(s));
    expect(s.sent).toHaveLength(0);
    expect(requests()[0]).toMatchObject({ status: 'ignored', reason: 'sending-disabled' });
  });

  it('the reply is in the language the command word was in', async () => {
    dm(1, 'tb:11', 11, 'puntos', T0);
    const s = sender();
    await processChatCommands(1, opts(s));
    expect(s.sent[0].text).toContain('Alpha: 400 puntos esta semana (día 3 de 7) · #2 de 2');
  });
});

describe('the replies', () => {
  let alpha: number;
  let beta: number;
  beforeEach(() => {
    alpha = player(1, 11, 'Alpha');
    beta = player(1, 12, 'Beta', { role: 2 });
    player(1, 13, 'Gamma');
    chest(alpha, 300, WEEK_FROM + HOUR);
    chest(beta, 500, WEEK_FROM + 2 * HOUR);
  });

  it('the goal line follows the board: reached, on pace, behind pace', async () => {
    // 65 h into a 168 h week: the pace mark for 700 is 271.
    setClanLeaderboardGoal(1, { enabled: true, weeklyPoints: 700 }, '2026-11-15');
    invalidate('');
    expect(await buildCommandReply(1, 11, 'points', 'en', T0)).toContain('Weekly goal 700: on pace ◐ (271 by now)');
    expect(await buildCommandReply(1, 13, 'points', 'en', T0)).toContain('Weekly goal 700: behind pace ↓ (271 by now) · 700 to go');
    setClanLeaderboardGoal(1, { enabled: true, weeklyPoints: 400 }, '2026-11-15');
    expect(await buildCommandReply(1, 12, 'points', 'en', T0)).toContain('Weekly goal 400: reached ✓');
  });

  it('top lists the week by points with chests, and where the asker stands below it', async () => {
    const text = await buildCommandReply(1, 13, 'top', 'en', T0);
    expect(text.split('\n')).toEqual([
      'Top 2 this week (day 3 of 7) · points (chests)',
      '1. Beta 500 (1)',
      '2. Alpha 300 (1)',
      'You: #3 of 3 · 0 (0)',
    ]);
  });

  it('top always fits one message, however long the names', async () => {
    for (let p = 30; p < 60; p++) chest(player(1, p, `${'W'.repeat(28)}${p}`), 1000 + p, WEEK_FROM + p * 1000);
    for (const lang of ['en', 'es', 'fr', 'ru', 'de'] as const) {
      const text = await buildCommandReply(1, 11, 'top', lang, T0);
      expect(fitsReply(text), lang).toBe(true);
      expect(text.split('\n').length).toBeGreaterThan(5);
    }
  });

  it('missing is for leaders only, and lists who is behind pace, furthest behind first', async () => {
    expect(await buildCommandReply(1, 11, 'missing', 'en', T0)).toBe(COMMAND_TEXTS.en.leadersOnly);
    expect(await buildCommandReply(1, 12, 'missing', 'en', T0)).toBe(COMMAND_TEXTS.en.noGoal);
    setClanLeaderboardGoal(1, { enabled: true, weeklyPoints: 1000 }, '2026-11-15');
    invalidate('');
    // Pace mark 387: Gamma (0) and Alpha (300) are behind; Beta (500) is on pace.
    expect((await buildCommandReply(1, 12, 'missing', 'en', T0)).split('\n')).toEqual([
      'Behind pace this week (day 3 of 7): 2 of 3',
      'Pace by now: 387 of 1,000',
      'Gamma 0',
      'Alpha 300',
    ]);
    setClanLeaderboardGoal(1, { enabled: true, weeklyPoints: 100 }, '2026-11-15');
    chest(alpha, 0, WEEK_FROM + 3 * HOUR);
    chest(player(1, 14, 'Delta'), 0, WEEK_FROM);
    getDb().prepare('UPDATE members SET is_active = 0 WHERE name IN (?, ?)').run('Gamma', 'Delta');
    invalidate('');
    expect(await buildCommandReply(1, 12, 'missing', 'en', T0)).toBe('Nobody is behind pace this week (day 3 of 7) ✓');
  });

  it('help lists the commands, "code" while invites are on, and "missing" for leaders', async () => {
    const member = await buildCommandReply(1, 11, 'help', 'en', T0);
    expect(member).toContain('me · points · chests · top · progress · events');
    expect(member).not.toContain('missing');
    expect(member).not.toContain('code:');
    setInvitesEnabled(1, true, T0);
    const leader = await buildCommandReply(1, 12, 'help', 'en', T0);
    expect(leader).toContain('code: your code for the site');
    expect(leader).toContain('Leaders: missing');
  });

  it('progress shows each closed week, and the weeks before the player joined as such', async () => {
    getDb().prepare('UPDATE game_players SET joined_at = ? WHERE player_id = 11').run(Math.floor(Date.parse('2026-11-03T12:00:00Z') / 1000));
    chest(alpha, 250, Date.parse('2026-11-10T12:00:00Z'));
    const lines = (await buildCommandReply(1, 11, 'progress', 'en', T0)).split('\n');
    expect(lines[0]).toBe('Alpha — last 4 weeks (points · rank)');
    expect(lines[1]).toBe('2026-10-18: not in the clan yet');
    expect(lines[2]).toBe('2026-10-25: not in the clan yet');
    expect(lines[3]).toBe('2026-11-01: 0 · #1');
    expect(lines[4]).toBe('2026-11-08: 250 · #1');
    expect(lines[5]).toBe('This week so far: 300 · #2');
  });

  it('events: what runs now and what comes next, soonest first', async () => {
    schedule.byKey = {
      olympus: { live: true, next: null, endsAt: new Date(T0 + 26 * HOUR).toISOString() },
      'dark-omens': { live: false, next: { from: new Date(T0 + 7 * HOUR + 20 * 60_000).toISOString() } },
      ragnarok: { live: false, next: { from: new Date(T0 + 3 * 24 * HOUR).toISOString() } },
    };
    const lines = (await buildCommandReply(1, 11, 'events', 'en', T0)).split('\n');
    expect(lines[0]).toBe('Events');
    expect(lines[1]).toBe('Now: Trials of Olympus — ends in 1d 2h');
    expect(lines[2]).toBe('Next: Dark Omens — in 7h 20m');
    expect(lines[3]).toBe('Next: Ragnarök — in 3d');
    schedule.byKey = {};
    expect(await buildCommandReply(1, 11, 'events', 'en', T0)).toBe(COMMAND_TEXTS.en.noEvents);
    schedule.fail = true;
    expect(await buildCommandReply(1, 11, 'events', 'en', T0)).toBe(COMMAND_TEXTS.en.calendarDown);
  });

  it('a player with no member row gets told so, not an empty reply', async () => {
    getDb().prepare("INSERT INTO game_players (clan_id, player_id, name, role, joined_at, in_clan, first_seen, last_seen) VALUES (1, 77, 'New', 4, 1, 1, 'x', 'x')").run();
    expect(await buildCommandReply(1, 77, 'me', 'en', T0)).toBe(COMMAND_TEXTS.en.notOnBoard);
  });

  it('every language says every reply in one message', async () => {
    setClanLeaderboardGoal(1, { enabled: true, weeklyPoints: 1000 }, '2026-11-15');
    invalidate('');
    for (const lang of ['en', 'es', 'fr', 'ru', 'de'] as const) {
      for (const command of ['me', 'points', 'chests', 'top', 'progress', 'events', 'help', 'missing'] as const) {
        const text = await buildCommandReply(1, 12, command, lang, T0);
        expect(text.trim(), `${lang} ${command}`).not.toBe('');
        expect(fitsReply(text), `${lang} ${command}`).toBe(true);
      }
    }
    expect(await buildCommandReply(1, 11, 'points', 'ru', T0)).toContain('300 очков на этой неделе (день 3 из 7)');
    expect(await buildCommandReply(1, 11, 'chests', 'ru', T0)).toContain('1 сундук на этой неделе');
  });
});

describe('the digest group chat', () => {
  const CARTER = 'sendbird_group_channel_carter';
  const OTHER = 'sendbird_group_channel_other';
  function groupChat(url: string, name: string, type = 'privateGroup', maxLength: number | null = null): void {
    getDb().prepare(
      `INSERT INTO chat_channels (clan_id, channel_url, custom_type, name, member_count, members, max_length, first_seen, last_seen)
       VALUES (1, ?, ?, ?, 12, '[]', ?, 'x', 'x')`,
    ).run(url, type, name, maxLength);
  }
  function say(url: string, chatId: string, playerId: number, text: string, atMs: number): void {
    getDb().prepare(
      `INSERT INTO chat_messages (clan_id, channel_url, message_id, created_at, custom_type, sender_id, sender_name, message, captured_at, sender_player_id)
       VALUES (1, ?, ?, ?, 'user', ?, 'n', ?, 'x', ?)`,
    ).run(url, Math.floor(Math.random() * 1e9), atMs, chatId, text, playerId);
  }
  beforeEach(() => {
    chest(player(1, 11, 'Alpha'), 300, WEEK_FROM + HOUR);
    chest(player(1, 12, 'Beta', { role: 2 }), 500, WEEK_FROM + HOUR);
    groupChat(CARTER, 'CWB • Carter');
    groupChat(OTHER, 'Some other chat', 'publicGroup');
    saveChatDigestSettings(1, { enabled: true, channelUrl: CARTER, channelName: 'CWB • Carter', entries: 20, postUtcMinute: 1050 });
    setChatCommandsEnabled(1, true, T0 - HOUR);
  });

  it('is off by default; once on, a command there is answered there, from the switch-on', async () => {
    say(CARTER, 'tb:11', 11, 'leaderboard', T0 - 60_000);
    const s = sender();
    await processChatCommands(1, opts(s));
    expect(s.sent).toHaveLength(0);
    expect(requests()).toEqual([]);

    setChatCommandsGroupEnabled(1, true, T0);
    expect(commandGroupChannel(1)).toBe(CARTER);
    nowMs = T0 + 1000;
    await processChatCommands(1, opts(s));
    // The message from before the switch-on is never answered.
    expect(s.sent).toHaveLength(0);

    say(CARTER, 'tb:11', 11, 'leaderboard', T0 + 2000);
    nowMs = T0 + 3000;
    await processChatCommands(1, opts(s));
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].channelUrl).toBe(CARTER);
    expect(s.sent[0].text).toContain('1. Beta 500 (1)');
  });

  it('never answers in any other group chat, nor while commands are off', async () => {
    setChatCommandsGroupEnabled(1, true, T0 - 60_000);
    say(OTHER, 'tb:11', 11, 'top', T0);
    const s = sender();
    await processChatCommands(1, opts(s));
    expect(s.sent).toHaveLength(0);
    expect(requests()).toEqual([]);

    setChatCommandsEnabled(1, false, T0);
    say(CARTER, 'tb:11', 11, 'top', T0 + 1000);
    nowMs = T0 + 2000;
    expect(commandGroupChannel(1)).toBeNull();
    await processChatCommands(1, opts(s));
    expect(s.sent).toHaveLength(0);
  });

  it('a shared answer asked again by anyone gets nothing; a personal one is per player', async () => {
    setChatCommandsGroupEnabled(1, true, T0 - 60_000);
    say(CARTER, 'tb:11', 11, 'top', T0);
    say(CARTER, 'tb:12', 12, 'top', T0 + 1);
    say(CARTER, 'tb:11', 11, 'me', T0 + 2);
    say(CARTER, 'tb:12', 12, 'me', T0 + 3);
    const s = sender();
    for (let i = 0; i < 4; i++) {
      nowMs = T0 + 10 + i * 60_000;
      await processChatCommands(1, opts(s));
    }
    expect(requests().map((r) => `${r.player_id}:${r.command}:${r.status}:${r.reason ?? ''}`)).toEqual([
      '11:top:sent:', '12:top:ignored:repeat', '11:me:sent:', '12:me:sent:',
    ]);
    // One group reply a run: three replies took three runs.
    expect(s.sent.map((m) => m.channelUrl)).toEqual([CARTER, CARTER, CARTER]);
  });

  it('at most GROUP_MAX_PER_HOUR replies an hour into the group chat; private replies still go', async () => {
    setChatCommandsGroupEnabled(1, true, T0 - 60_000);
    getDb().prepare(
      `INSERT INTO chat_command_requests (clan_id, channel_url, message_id, sender_chat_id, player_id, command, requested_at, status, attempts, sent_at, created_at, updated_at)
       SELECT 1, ?, value, 'tb:x', 900 + value, 'me', ?, 'sent', 1, ?, 'x', 'x' FROM json_each(?)`,
    ).run(CARTER, T0 - 10 * 60_000, T0 - 10 * 60_000, JSON.stringify(Array.from({ length: GROUP_MAX_PER_HOUR }, (_, i) => i + 1)));
    say(CARTER, 'tb:11', 11, 'events', T0);
    dm(1, 'tb:12', 12, 'me', T0 + 1);
    const s = sender();
    await processChatCommands(1, opts(s));
    expect(s.sent.map((m) => m.channelUrl)).toEqual(['sendbird_group_channel_tb12']);
    expect(requests().find((r) => r.command === 'events')).toMatchObject({ status: 'pending' });
  });

  it('a group reply is in the clan’s digest language, not the asker’s account language', async () => {
    saveChatDigestSettings(1, { enabled: true, channelUrl: CARTER, channelName: 'CWB • Carter', entries: 20, postUtcMinute: 1050, language: 'de' });
    setChatCommandsGroupEnabled(1, true, T0 - 60_000);
    say(CARTER, 'tb:11', 11, 'points', T0);
    const s = sender();
    await processChatCommands(1, opts(s));
    expect(s.sent[0].text).toContain('Alpha: 300 Punkte diese Woche (Tag 3 von 7) · #2 von 2');
  });

  it('switched off while a group command waits: it is not answered', async () => {
    setChatCommandsGroupEnabled(1, true, T0 - 60_000);
    say(CARTER, 'tb:11', 11, 'me', T0);
    const s = sender();
    await processChatCommands(1, { ...opts(s), chatToken: async () => null });
    setChatCommandsGroupEnabled(1, false, T0 + 1000);
    nowMs = T0 + 2000;
    await processChatCommands(1, opts(s));
    expect(s.sent).toHaveLength(0);
    expect(requests()[0]).toMatchObject({ status: 'ignored', reason: 'group-off' });
  });

  describe('"code" asked in the group chat', () => {
    const session = { key: 'k', userId: SCANNER } as never;
    const inviteOpts = (s: ReturnType<typeof sender>, openChat = vi.fn()) => ({ scannerChatId: SCANNER, chatToken: async () => 'tok', send: s.fn, now, chatSession: session, openChat });
    const inviteRows = () => getDb().prepare('SELECT status, reason FROM chat_invite_requests ORDER BY id').all();
    beforeEach(() => {
      setInvitesEnabled(1, true, T0 - HOUR);
      setChatCommandsGroupEnabled(1, true, T0 - HOUR);
    });

    it('goes to the asker’s private chat with the scanner, never the group', async () => {
      dm(1, 'tb:11', 11, 'hello', T0 - 2 * HOUR);
      say(CARTER, 'tb:11', 11, 'code', T0);
      const s = sender();
      const openChat = vi.fn();
      await processInviteRequests(1, inviteOpts(s, openChat));
      expect(s.sent).toHaveLength(1);
      expect(s.sent[0].channelUrl).toBe('sendbird_group_channel_tb11');
      expect(s.sent[0].text).toMatch(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/);
      expect(openChat).not.toHaveBeenCalled();
      expect(inviteRows()).toEqual([{ status: 'sent', reason: null }]);
      // And it is not a chat command either: nothing is answered in the group.
      const c = sender();
      await processChatCommands(1, opts(c));
      expect(c.sent).toHaveLength(0);
    });

    it('with no private chat yet, opens one (exactly the two of them) and sends there', async () => {
      say(CARTER, 'tb:12', 12, 'code', T0);
      const s = sender();
      const openChat = vi.fn(async () => ({
        url: 'sendbird_group_channel_new', customType: 'whisper', name: '', memberCount: 2, lastMessageAt: null,
        members: [{ userId: SCANNER, nickname: '' }, { userId: 'tb:12', nickname: '' }],
      }));
      await processInviteRequests(1, inviteOpts(s, openChat));
      expect(openChat).toHaveBeenCalledWith(session, 'tb:12');
      expect(s.sent.map((m) => m.channelUrl)).toEqual(['sendbird_group_channel_new']);
    });

    it('a chat that opens with anyone else in it gets nothing, and the request fails', async () => {
      say(CARTER, 'tb:12', 12, 'code', T0);
      const s = sender();
      const openChat = vi.fn(async () => ({
        url: 'sendbird_group_channel_new', customType: 'whisper', name: '', memberCount: 3, lastMessageAt: null,
        members: [{ userId: SCANNER, nickname: '' }, { userId: 'tb:12', nickname: '' }, { userId: 'tb:13', nickname: '' }],
      }));
      await processInviteRequests(1, inviteOpts(s, openChat));
      expect(s.sent).toHaveLength(0);
      expect(inviteRows()).toEqual([{ status: 'failed', reason: 'open-chat-failed' }]);
    });

    it('is not read at all while the group chat is off; help there says the code comes privately', async () => {
      setChatCommandsGroupEnabled(1, false, T0 - 60_000);
      say(CARTER, 'tb:11', 11, 'code', T0);
      const s = sender();
      await processInviteRequests(1, inviteOpts(s));
      expect(s.sent).toHaveLength(0);
      expect(inviteRows()).toEqual([]);
      expect(await buildCommandReply(1, 11, 'help', 'en', T0, { inGroup: true })).toContain('code: your code for the site, sent to you privately');
      expect((await buildCommandReply(1, 11, 'help', 'en', T0)).split('\n')).toContain('code: your code for the site');
    });
  });

  it('the group send refuses the clan chat, the kingdom chat, a private chat and any other group chat', async () => {
    const s = sender();
    const carter = { url: CARTER, customType: 'privateGroup', name: 'CWB • Carter', members: [] };
    expect((await sendGroupCommandReply({ userId: SCANNER, token: 't', channel: carter, allowedUrl: CARTER, text: 'hi' }, s.fn)).status).toBe('sent');
    for (const channel of [
      { ...carter, url: 'triumph_clan_channel_5', customType: 'clanGroup' },
      { ...carter, url: 'triumph_realm_channel_289', customType: 'realmGroup' },
      { ...carter, customType: 'whisper' },
      { ...carter, url: OTHER },
      { ...carter, name: '' },
    ]) {
      expect((await sendGroupCommandReply({ userId: SCANNER, token: 't', channel, allowedUrl: CARTER, text: 'hi' }, s.fn)).status, JSON.stringify(channel)).toBe('refused');
    }
    expect((await sendGroupCommandReply({ userId: SCANNER, token: 't', channel: carter, allowedUrl: null, text: 'hi' }, s.fn)).status).toBe('refused');
    expect(s.sent).toHaveLength(1);
  });
});

describe('message length', () => {
  it('our ceilings sit under the chat’s own limit', () => {
    expect(MAX_COMMAND_REPLY_CHARS).toBeLessThanOrEqual(CHANNEL_MAX_LENGTH);
    expect(MAX_INVITE_REPLY_CHARS).toBeLessThanOrEqual(CHANNEL_MAX_LENGTH);
    expect(MAX_POST_CHARS).toBeLessThanOrEqual(CHANNEL_MAX_LENGTH);
  });

  it('every reply in every language fits, in a big clan with long names — and in a chat with a smaller limit', async () => {
    setClanLeaderboardGoal(1, { enabled: true, weeklyPoints: 100_000 }, '2026-11-15');
    player(1, 12, 'Leader', { role: 1 });
    for (let p = 100; p < 250; p++) chest(player(1, p, `Ж${'ю'.repeat(24)}${p}`), 10 + p, WEEK_FROM + p * 1000);
    schedule.byKey = Object.fromEntries(['ancients', 'ragnarok', 'olympus', 'dark-omens', 'runics', 'doomsday', 'arachnes-swarm', 'hell-forge', 'sands-of-eternity']
      .map((k, i) => [k, { live: i < 3, next: { from: new Date(T0 + (i + 1) * 5 * HOUR).toISOString() }, endsAt: new Date(T0 + 30 * HOUR).toISOString() }]));
    for (const limit of [null, 300, 120]) {
      for (const lang of ['en', 'es', 'fr', 'ru', 'de'] as const) {
        for (const command of ['me', 'points', 'chests', 'top', 'progress', 'events', 'help', 'missing'] as const) {
          const text = await buildCommandReply(1, 12, command, lang, T0, { channelMax: limit });
          expect(text.trim(), `${limit} ${lang} ${command}`).not.toBe('');
          expect(fitsReply(text, limit), `${limit} ${lang} ${command}: ${text.length} chars`).toBe(true);
        }
      }
    }
    // A cut list says how many it left out.
    expect(await buildCommandReply(1, 12, 'missing', 'en', T0)).toMatch(/… and \d+ more$/);
  });

  it('a reply is built for the chat it goes to: a chat with a smaller limit gets a shorter one', async () => {
    for (let p = 100; p < 140; p++) chest(player(1, p, `Player number ${p}`), p, WEEK_FROM + p * 1000);
    player(1, 11, 'Alpha');
    setChatCommandsEnabled(1, true, T0 - 60_000);
    dm(1, 'tb:11', 11, 'top', T0);
    getDb().prepare('UPDATE chat_channels SET max_length = 150').run();
    const s = sender();
    await processChatCommands(1, opts(s));
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].text.length).toBeLessThanOrEqual(150);
    expect(s.sent[0].text).toMatch(/… and \d+ more/);
  });

  it('the sends refuse a text past the chat’s own limit', async () => {
    const s = sender();
    const dmChat = { url: 'sendbird_group_channel_x', customType: 'whisper', members: [{ userId: SCANNER }, { userId: 'tb:11' }], maxLength: 50 };
    expect((await sendCommandReply({ userId: SCANNER, token: 't', channel: dmChat, recipientUserId: 'tb:11', text: 'x'.repeat(51) }, s.fn)).status).toBe('refused');
    expect((await sendInviteMessage({ userId: SCANNER, token: 't', channel: dmChat, recipientUserId: 'tb:11', text: 'x'.repeat(51) }, s.fn)).status).toBe('refused');
    expect((await sendCommandReply({ userId: SCANNER, token: 't', channel: dmChat, recipientUserId: 'tb:11', text: 'x'.repeat(50) }, s.fn)).status).toBe('sent');
    expect(s.sent).toHaveLength(1);
  });
});

describe('the send', () => {
  it('refuses anything but the 1:1 chat with that player, and a reply past the size', async () => {
    const s = sender();
    const ok = { url: 'sendbird_group_channel_x', customType: 'whisper', members: [{ userId: SCANNER }, { userId: 'tb:11' }] };
    expect(await sendCommandReply({ userId: SCANNER, token: 't', channel: ok, recipientUserId: 'tb:11', text: 'hi' }, s.fn)).toEqual({ status: 'sent', messageId: 777 });
    for (const channel of [
      { ...ok, customType: 'clanGroup' },
      { ...ok, url: 'triumph_clan_channel_5' },
      { ...ok, members: [...ok.members, { userId: 'tb:12' }] },
    ]) {
      expect((await sendCommandReply({ userId: SCANNER, token: 't', channel, recipientUserId: 'tb:11', text: 'hi' }, s.fn)).status).toBe('refused');
    }
    expect((await sendCommandReply({ userId: SCANNER, token: 't', channel: ok, recipientUserId: 'tb:11', text: 'x'.repeat(900) }, s.fn)).status).toBe('refused');
    expect(s.sent).toHaveLength(1);
  });

  it('durations read like the game: days and hours, else hours and minutes', () => {
    const en = COMMAND_TEXTS.en.units;
    expect(durationText(26 * HOUR, en)).toBe('1d 2h');
    expect(durationText(48 * HOUR, en)).toBe('2d');
    expect(durationText(HOUR + 5 * 60_000, en)).toBe('1h 5m');
    expect(durationText(30_000, en)).toBe('1m');
    expect(durationText(26 * HOUR, COMMAND_TEXTS.ru.units)).toBe('1 д 2 ч');
  });
});
