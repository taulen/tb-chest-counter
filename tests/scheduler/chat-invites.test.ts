/**
 * Account invites in the game chat (scheduler/chat-invites.ts): who gets an
 * answer, in which chat, how often — and the welcome codes for new members.
 * Every send goes through a mock; nothing here talks to the chat service.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logged: string[] = [];
vi.mock('../../src/utils/logger.js', () => {
  const rec = (...args: unknown[]) => { logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  const l = { info: rec, warn: rec, debug: rec, error: rec, child: () => l };
  return { childLogger: () => l, getLogger: () => l, createLogger: () => l };
});

import { getDb } from '../../src/data/database.js';
import {
  hashCode,
  lookupCode,
  setInvitesEnabled,
  setWelcomeMode,
  welcomeProgress,
  WELCOME_CODE_TTL_MS,
  WELCOME_GAP_AFTER_MUTE_MS,
  WELCOME_MIN_GAP_MS,
} from '../../src/data/repositories/account-invite-repo.js';
import { chatPausedUntil, getChatSendState, MUTE_BACKOFF_MS, MUTE_END_MARGIN_MS } from '../../src/data/repositories/chat-send-state-repo.js';
import {
  answerInviteRequests,
  detectInviteRequests,
  findChatAccount,
  hasWaitingInviteRequests,
  inviteReplyText,
  isInviteKeyword,
  processInviteRequests,
  sendWelcomeCodes,
  defaultSiteNameFor,
  siteNameFor,
  spacedSiteName,
  welcomeText,
} from '../../src/scheduler/chat-invites.js';
import { assertInviteChannel, sendInviteMessage, type SendOutcome } from '../../src/game-protocol/chat-send.js';
import type { ChatChannel, ChatMember, ChatSession } from '../../src/game-protocol/chat.js';
import { makeTestDb, seedTwoClans } from '../helpers/test-db.js';

const SCANNER = 'tb:1000';
const T0 = Date.parse('2026-11-18T10:00:00.000Z');
let cleanup: () => void;
let nowMs = T0;
const now = () => nowMs;

beforeEach(() => {
  ({ cleanup } = makeTestDb());
  seedTwoClans();
  logged.length = 0;
  nowMs = T0;
  delete process.env.CHAT_SEND_DISABLED;
});
afterEach(() => {
  cleanup();
  delete process.env.CHAT_SEND_DISABLED;
});

function gamePlayer(clanId: number, playerId: number, name: string, role = 4, inClan = 1, joinedAtS = 1790000000): void {
  getDb().prepare(
    `INSERT INTO game_players (clan_id, player_id, name, role, joined_at, in_clan, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, '2026-11-01', '2026-11-18')
     ON CONFLICT (clan_id, player_id) DO UPDATE SET in_clan = excluded.in_clan, joined_at = excluded.joined_at`,
  ).run(clanId, playerId, name, role, joinedAtS, inClan);
}

/** A stored private chat between the scanner and `chatId`, and one message in it. */
function dm(clanId: number, chatId: string, playerId: number | null, text: string, atMs: number, opts: { members?: string[]; type?: string; url?: string } = {}): string {
  const url = opts.url ?? `sendbird_group_channel_${chatId.replace(':', '')}`;
  const members = (opts.members ?? [SCANNER, chatId]).map((userId) => ({ userId, nickname: userId }));
  getDb().prepare(
    `INSERT INTO chat_channels (clan_id, channel_url, custom_type, name, member_count, members, first_seen, last_seen)
     VALUES (?, ?, ?, '', ?, ?, 'x', 'x') ON CONFLICT (clan_id, channel_url) DO NOTHING`,
  ).run(clanId, url, opts.type ?? 'whisper', members.length, JSON.stringify(members));
  const id = Math.floor(Math.random() * 1e9);
  getDb().prepare(
    `INSERT INTO chat_messages (clan_id, channel_url, message_id, created_at, custom_type, sender_id, sender_name, message, captured_at, sender_player_id)
     VALUES (?, ?, ?, ?, 'user', ?, 'n', ?, 'x', ?)`,
  ).run(clanId, url, id, atMs, chatId, text, playerId);
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

const codeIn = (text: string) => (text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/) ?? [])[1] ?? '';
const requests = () => getDb().prepare('SELECT status, reason, player_id FROM chat_invite_requests ORDER BY id').all() as Array<{ status: string; reason: string | null; player_id: number }>;
const opts = (send: ReturnType<typeof sender>) => ({ scannerChatId: SCANNER, chatToken: async () => 'tok', send: send.fn, now });

describe('the keyword', () => {
  it('is one word on its own, any case, with a leading ! or / and trailing punctuation', () => {
    for (const ok of ['code', 'Code', ' CODE ', '!code', '/invite', 'tracker.', 'код', 'Código!', 'codigo?']) expect(isInviteKeyword(ok), ok).toBe(true);
    for (const no of ['send me the code', 'codes', 'hello', '', 'code please', 'join']) expect(isInviteKeyword(no), no).toBe(false);
  });
});

describe('answering a request', () => {
  beforeEach(() => {
    gamePlayer(1, 11, 'Alpha');
    setInvitesEnabled(1, true, T0 - 60_000);
  });

  it('a roster member asking in their 1:1 chat gets one code there; only its hash is kept and no log line holds it', async () => {
    const url = dm(1, 'tb:11', 11, 'code', T0);
    const s = sender();
    await processInviteRequests(1, opts(s));
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ channelUrl: url, userId: SCANNER });
    const code = codeIn(s.sent[0].text);
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(s.sent[0].text).toContain('72 hours');
    expect(lookupCode(code, T0)?.playerId).toBe(11);
    expect(getDb().prepare('SELECT code_hash FROM account_invite_codes').get()).toEqual({ code_hash: hashCode(code) });
    expect(logged.join('\n')).not.toContain(code);
    expect(logged.join('\n')).not.toContain(code.replace('-', ''));
    // Handled once: the next minute's poll sends nothing.
    await processInviteRequests(1, opts(s));
    expect(s.sent).toHaveLength(1);
  });

  it('never answers a non-member, a message from before invites were switched on, or invites switched off', async () => {
    dm(1, 'tb:99', 99, 'code', T0);
    dm(1, 'tb:11', 11, 'code', T0 - 5 * 60_000);
    const s = sender();
    await processInviteRequests(1, opts(s));
    expect(s.sent).toHaveLength(0);
    expect(requests()).toEqual([{ status: 'ignored', reason: 'not-member', player_id: 99 }]);

    setInvitesEnabled(1, false, T0);
    dm(1, 'tb:11', 11, 'code', T0 + 1000);
    await processInviteRequests(1, opts(s));
    expect(s.sent).toHaveLength(0);
  });

  it('refuses a chat that is not exactly the scanner and the asker, or not a private chat', async () => {
    dm(1, 'tb:11', 11, 'code', T0, { members: [SCANNER, 'tb:11', 'tb:12'] });
    const s = sender();
    await processInviteRequests(1, opts(s));
    expect(s.sent).toHaveLength(0);
    expect(requests()[0]).toMatchObject({ status: 'ignored', reason: 'channel' });

    expect(() => assertInviteChannel({ url: 'triumph_clan_channel_5', customType: 'clanGroup', members: [{ userId: SCANNER }, { userId: 'tb:11' }] }, SCANNER, 'tb:11')).toThrow();
    expect(() => assertInviteChannel({ url: 'x', customType: 'publicGroup', members: [{ userId: SCANNER }, { userId: 'tb:11' }] }, SCANNER, 'tb:11')).toThrow();
    expect(() => assertInviteChannel({ url: 'x', customType: 'whisper', members: [{ userId: SCANNER }, { userId: 'tb:12' }] }, SCANNER, 'tb:11')).toThrow();
    expect(() => assertInviteChannel({ url: 'x', customType: 'whisper', members: [{ userId: SCANNER }, { userId: 'tb:11' }] }, SCANNER, 'tb:11')).not.toThrow();
  });

  it('refuses a player id claimed from a chat account that player never wrote from', async () => {
    dm(1, 'tb:11', 11, 'hello', T0 - 3600_000, { url: 'triumph_clan_channel_1', type: 'clanGroup', members: [] });
    dm(1, 'tb:66', 11, 'code', T0);
    const s = sender();
    await processInviteRequests(1, opts(s));
    expect(s.sent).toHaveLength(0);
    expect(requests()[0]).toMatchObject({ status: 'ignored', reason: 'chat-account-mismatch' });
  });

  it('one code per player per 10 minutes, one open request at a time', async () => {
    dm(1, 'tb:11', 11, 'code', T0);
    const s = sender();
    await processInviteRequests(1, opts(s));
    nowMs = T0 + 5 * 60_000;
    dm(1, 'tb:11', 11, 'code', nowMs);
    await processInviteRequests(1, opts(s));
    expect(s.sent).toHaveLength(1);
    expect(requests()[1]).toMatchObject({ status: 'ignored', reason: 'cooldown' });
    nowMs = T0 + 11 * 60_000;
    dm(1, 'tb:11', 11, 'code', nowMs);
    await processInviteRequests(1, opts(s));
    expect(s.sent).toHaveLength(2);
  });

  it('a refused send withdraws the code and tries again; an unknown outcome is never resent', async () => {
    dm(1, 'tb:11', 11, 'code', T0);
    const s = sender([{ status: 'refused', error: 'no' }, { status: 'unknown', error: 'timeout' }]);
    await answerInviteRequests(1, opts(s));
    detectInviteRequests(1, SCANNER, T0);
    await answerInviteRequests(1, opts(s));
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM account_invite_codes').get()).toEqual({ n: 0 });
    await answerInviteRequests(1, opts(s));
    expect(s.sent).toHaveLength(2);
    expect(requests()[0].status).toBe('unknown');
    await answerInviteRequests(1, opts(s));
    await answerInviteRequests(1, opts(s));
    expect(s.sent).toHaveLength(2);
    // The code that may have gone out still works.
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM account_invite_codes').get()).toEqual({ n: 1 });
  });

  it('CHAT_SEND_DISABLED answers nothing, and the send itself refuses too', async () => {
    process.env.CHAT_SEND_DISABLED = '1';
    dm(1, 'tb:11', 11, 'code', T0);
    const s = sender();
    await processInviteRequests(1, opts(s));
    expect(s.sent).toHaveLength(0);
    expect(requests()[0]).toMatchObject({ status: 'ignored', reason: 'sending-disabled' });
    const out = await sendInviteMessage({ userId: SCANNER, token: 't', channel: { url: 'x', customType: 'whisper', members: [{ userId: SCANNER }, { userId: 'tb:11' }] }, recipientUserId: 'tb:11', text: 'hi' }, s.fn);
    expect(out.status).toBe('refused');
    expect(s.fn).not.toHaveBeenCalled();
  });

  it('with no chat token yet the request waits for the next scan', async () => {
    dm(1, 'tb:11', 11, 'code', T0);
    const s = sender();
    await processInviteRequests(1, { ...opts(s), chatToken: async () => null });
    expect(requests()[0].status).toBe('pending');
    await processInviteRequests(1, opts(s));
    expect(s.sent).toHaveLength(1);
  });
});

describe('welcome codes for new members', () => {
  const session: ChatSession = { appId: 'x', userId: SCANNER, key: 'k' };
  const T0s = Math.floor(T0 / 1000);
  function api(members: ChatMember[], channel?: (other: string) => ChatChannel) {
    return {
      listMembers: vi.fn(async () => members),
      openPrivateChat: vi.fn(async (_s: ChatSession, other: string): Promise<ChatChannel> => channel?.(other) ?? ({
        url: `dm-${other}`, customType: 'whisper', name: `${SCANNER}_${other}`, memberCount: 2,
        members: [{ userId: SCANNER, nickname: 's' }, { userId: other, nickname: 'o' }], lastMessageAt: null,
      })),
    };
  }
  const member = (playerId: number, name: string, chatId = `tb:${playerId}`): ChatMember =>
    ({ userId: chatId, nickname: name, memberInfo: `1,${playerId.toString(16)},2,0,4,TAG` });
  const wopts = (s: ReturnType<typeof sender>, a: ReturnType<typeof api>, extra: { betweenScans?: boolean } = {}) =>
    ({ scannerChatId: SCANNER, chatSession: session, chatToken: async () => 'tok', send: s.fn, chatApi: a, now, ...extra });
  const welcomes = () => getDb().prepare('SELECT player_id, status, reason FROM chat_invite_welcomes ORDER BY player_id').all();
  /** The next run's turn: the gap after the scanner's last invite DM has passed. */
  const later = () => { nowMs += WELCOME_MIN_GAP_MS; };
  const MUTED: SendOutcome = { status: 'refused', error: 'chat refused the message: You are muted.' };

  beforeEach(() => {
    getDb().prepare("INSERT INTO chat_channels (clan_id, channel_url, custom_type, first_seen, last_seen) VALUES (1, 'triumph_clan_channel_1', 'clanGroup', 'x', 'x')").run();
  });

  it('off by default: nothing happens', async () => {
    gamePlayer(1, 21, 'New', 4, 1, T0s + 60);
    const s = sender();
    expect(await sendWelcomeCodes(1, wopts(s, api([member(21, 'New')])))).toBe('');
    expect(s.sent).toHaveLength(0);
  });

  it('dry run: records and logs everyone who would get one (current members too), sends nothing; switched on, they are still due', async () => {
    setWelcomeMode(1, 'dry-run', T0);
    gamePlayer(1, 20, 'OldTimer', 4, 1, T0s - 3600);
    gamePlayer(1, 21, 'New', 4, 1, T0s + 60);
    const s = sender();
    const a = api([member(20, 'OldTimer'), member(21, 'New')]);
    await sendWelcomeCodes(1, wopts(s, a));
    expect(s.sent).toHaveLength(0);
    expect(a.openPrivateChat).not.toHaveBeenCalled();
    // The current member (the backlog) as well as the new arrival: a clan with
    // nobody new used to preview nothing at all.
    expect(welcomes()).toEqual([
      { player_id: 20, status: 'dry-run', reason: null },
      { player_id: 21, status: 'dry-run', reason: null },
    ]);
    expect(logged.some((l) => l.includes('DRY RUN') && l.includes('2 would get one') && l.includes('New'))).toBe(true);
    expect(welcomeProgress(1).backlogDue).toBe(2);
    setWelcomeMode(1, 'on', T0 + 1000);
    await sendWelcomeCodes(1, wopts(s, a));
    later();
    await sendWelcomeCodes(1, wopts(s, a));
    expect(s.sent.map((x) => x.channelUrl).sort()).toEqual(['dm-tb:20', 'dm-tb:21']);
  });

  it('on: one 72-hour code each in a 1:1 chat — the first switch-on includes current members (the backlog) — once, ever', async () => {
    setWelcomeMode(1, 'on', T0);
    gamePlayer(1, 20, 'OldTimer', 4, 1, T0s - 3600);
    gamePlayer(1, 21, 'New', 4, 1, T0s + 60);
    const s = sender();
    const a = api([member(20, 'OldTimer'), member(21, 'New')]);
    expect(await sendWelcomeCodes(1, wopts(s, a))).toBe('welcome codes: 1 sent');
    // The new arrival first; the backlog member a run later.
    expect(s.sent.map((x) => x.channelUrl)).toEqual(['dm-tb:21']);
    later();
    await sendWelcomeCodes(1, wopts(s, a));
    expect(s.sent.map((x) => x.channelUrl)).toEqual(['dm-tb:21', 'dm-tb:20']);
    expect(s.sent[0].text).toMatch(/72 hours/);
    expect(s.sent[0].text).toMatch(/Reply "code"/);
    const code = codeIn(s.sent[0].text);
    expect(lookupCode(code, T0 + WELCOME_CODE_TTL_MS - 60_000)?.playerId).toBe(21);
    expect(lookupCode(code, T0 + WELCOME_CODE_TTL_MS + 60_000)).toBeNull();
    expect(logged.join('\n')).not.toContain(code);
    expect(welcomeProgress(1)).toMatchObject({ sent: 2, due: 0, total: 2 });

    // A rejoin never resends.
    gamePlayer(1, 21, 'New', 4, 0, T0s + 60);
    gamePlayer(1, 21, 'New', 4, 1, T0s + 7200);
    later();
    await sendWelcomeCodes(1, wopts(s, a));
    expect(s.sent).toHaveLength(2);
  });

  it('one code a run, at least 10 minutes after the last; switching it off stops it where it is', async () => {
    const ms: ChatMember[] = [];
    for (let i = 0; i < 5; i++) {
      gamePlayer(1, 300 + i, `M${i}`, 4, 1, T0s - 86400 * (i + 1));
      ms.push(member(300 + i, `M${i}`));
    }
    setWelcomeMode(1, 'on', T0);
    const s = sender();
    const a = api(ms);
    await sendWelcomeCodes(1, wopts(s, a));
    expect(s.sent).toHaveLength(1);
    // A manual scan straight after sends nothing: too soon (Nov 18 2026, two
    // scans three minutes apart sent 20 and the game muted the scanner).
    nowMs += WELCOME_MIN_GAP_MS - 1000;
    await sendWelcomeCodes(1, wopts(s, a));
    expect(s.sent).toHaveLength(1);
    nowMs += 1000;
    await sendWelcomeCodes(1, wopts(s, a));
    expect(s.sent).toHaveLength(2);
    expect(welcomeProgress(1)).toMatchObject({ sent: 2, due: 3, total: 5 });

    // Two runs at once (a scan and the poller): one goes, the other does nothing.
    later();
    await Promise.all([sendWelcomeCodes(1, wopts(s, a)), sendWelcomeCodes(1, wopts(s, a))]);
    expect(s.sent).toHaveLength(3);

    // Off: it stops there.
    setWelcomeMode(1, 'off', nowMs);
    later();
    await sendWelcomeCodes(1, wopts(s, a));
    expect(s.sent).toHaveLength(3);

    // On again: the backlog carries on, it doesn't start over.
    setWelcomeMode(1, 'on', nowMs);
    for (let i = 0; i < 3; i++) {
      later();
      await sendWelcomeCodes(1, wopts(s, a));
    }
    expect(s.sent).toHaveLength(5);
    expect(new Set(s.sent.map((x) => x.channelUrl)).size).toBe(5);
    expect(welcomeProgress(1)).toMatchObject({ sent: 5, due: 0, total: 5 });
  });

  it('a player whose chat account is not seen yet waits; the run sends to the next one', async () => {
    setWelcomeMode(1, 'on', T0);
    gamePlayer(1, 21, 'New', 4, 1, T0s + 60);
    gamePlayer(1, 20, 'OldTimer', 4, 1, T0s - 3600);
    const s = sender();
    await sendWelcomeCodes(1, wopts(s, api([member(20, 'OldTimer')])));
    expect(s.sent.map((x) => x.channelUrl)).toEqual(['dm-tb:20']);
    expect(welcomes()).toEqual([
      { player_id: 20, status: 'sent', reason: null },
      { player_id: 21, status: 'waiting', reason: 'no-chat-account' },
    ]);
  });

  it('"You are muted." is OUR account muted: everything stops for 75 min and the player stays due, the try not counted', async () => {
    setWelcomeMode(1, 'on', T0);
    setInvitesEnabled(1, true, T0);
    gamePlayer(1, 21, 'New', 4, 1, T0s + 60);
    gamePlayer(1, 22, 'Other', 4, 1, T0s + 30);
    const s = sender([MUTED]);
    const a = api([member(21, 'New'), member(22, 'Other')]);
    expect(await sendWelcomeCodes(1, wopts(s, a))).toBe('');
    // One try, then nothing more in that run.
    expect(s.sent).toHaveLength(1);
    expect(welcomes()).toEqual([{ player_id: 21, status: 'waiting', reason: 'muted' }]);
    expect(getDb().prepare('SELECT attempts FROM chat_invite_welcomes WHERE player_id = 21').get()).toEqual({ attempts: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM account_invite_codes').get()).toEqual({ n: 0 });
    expect(chatPausedUntil(1, nowMs)).toBe(T0 + MUTE_BACKOFF_MS[0]);
    expect(logged.some((l) => l.includes('the game muted the scanner account'))).toBe(true);

    // While muted nothing is tried: no welcome code, no reply to a player who
    // asks, and no scan is asked for to answer them.
    gamePlayer(1, 11, 'Asker', 4, 1, T0s - 7200);
    dm(1, 'tb:11', 11, 'code', T0 + 60_000);
    nowMs = T0 + 60 * 60_000;
    await processInviteRequests(1, opts(s));
    await sendWelcomeCodes(1, wopts(s, a));
    expect(s.sent).toHaveLength(1);
    expect(requests()).toEqual([{ status: 'pending', reason: null, player_id: 11 }]);
    expect(hasWaitingInviteRequests(1, nowMs)).toBe(false);

    // After the pause: the player who asked is answered, then the welcome
    // codes go on, one at a time, 10 minutes after that reply.
    nowMs = T0 + MUTE_BACKOFF_MS[0] + 1;
    expect(hasWaitingInviteRequests(1, nowMs)).toBe(true);
    await processInviteRequests(1, opts(s));
    expect(s.sent).toHaveLength(2);
    expect(requests()[0].status).toBe('sent');
    await sendWelcomeCodes(1, wopts(s, a));
    expect(s.sent).toHaveLength(2);
    // For a week after a mute they go twice as far apart.
    later();
    await sendWelcomeCodes(1, wopts(s, a));
    expect(s.sent).toHaveLength(2);
    nowMs += WELCOME_GAP_AFTER_MUTE_MS - WELCOME_MIN_GAP_MS;
    await sendWelcomeCodes(1, wopts(s, a));
    expect(s.sent.map((x) => x.channelUrl)).toEqual(['dm-tb:21', 'sendbird_group_channel_tb11', 'dm-tb:21']);
    nowMs += MUTE_BACKOFF_MS[0] + 7 * 24 * 3600_000;
    await sendWelcomeCodes(1, wopts(s, a));
    expect(s.sent).toHaveLength(4);
    expect(welcomes()).toContainEqual({ player_id: 21, status: 'sent', reason: null });
  });

  it('when the chat service says when the mute ends, nothing is tried before then (plus a margin), however long', async () => {
    setWelcomeMode(1, 'on', T0);
    gamePlayer(1, 21, 'New', 4, 1, T0s + 60);
    const s = sender([MUTED]);
    const ends = T0 + 5 * 3600_000;
    const a = { ...api([member(21, 'New')]), muteInfo: vi.fn(async () => ({ muted: true, endAt: ends, raw: '{"is_muted":true}' })) };
    await sendWelcomeCodes(1, wopts(s, a));
    expect(a.muteInfo).toHaveBeenCalledWith(session, 'dm-tb:21');
    expect(chatPausedUntil(1, nowMs)).toBe(ends + MUTE_END_MARGIN_MS);
    nowMs = ends;
    await sendWelcomeCodes(1, wopts(s, a));
    expect(s.sent).toHaveLength(1);
    // The refusal and what the chat service said are kept in the log.
    expect(logged.some((l) => l.includes("mute's own end"))).toBe(true);
    nowMs = ends + MUTE_END_MARGIN_MS + 1;
    await sendWelcomeCodes(1, wopts(s, a));
    expect(s.sent).toHaveLength(2);

    // It says "not muted" (the game mutes outside it) or can't be read: the set pause.
    const b = { ...api([member(21, 'New'), member(22, 'Other')]), muteInfo: vi.fn(async () => { throw new Error('HTTP 403'); }) };
    gamePlayer(1, 22, 'Other', 4, 1, T0s + 30);
    const s2 = sender([MUTED]);
    nowMs += WELCOME_GAP_AFTER_MUTE_MS;
    await sendWelcomeCodes(1, wopts(s2, b));
    expect(s2.sent).toHaveLength(1);
    expect(chatPausedUntil(1, nowMs)).toBe(nowMs + MUTE_BACKOFF_MS[0]);
  });

  it('a reply muted is held the same way: back to waiting, the try not counted', async () => {
    setInvitesEnabled(1, true, T0);
    gamePlayer(1, 11, 'Asker', 4, 1, T0s - 7200);
    dm(1, 'tb:11', 11, 'code', T0 + 1000);
    const s = sender([MUTED]);
    await processInviteRequests(1, opts(s));
    expect(s.sent).toHaveLength(1);
    expect(requests()).toEqual([{ status: 'pending', reason: 'muted', player_id: 11 }]);
    expect(getDb().prepare('SELECT attempts FROM chat_invite_requests').get()).toEqual({ attempts: 0 });
    expect(chatPausedUntil(1, nowMs)).toBe(T0 + MUTE_BACKOFF_MS[0]);
  });

  it('muted again right after a pause waits longer; a message that gets through starts the backoff over', async () => {
    setWelcomeMode(1, 'on', T0);
    gamePlayer(1, 21, 'New', 4, 1, T0s + 60);
    gamePlayer(1, 22, 'Other', 4, 1, T0s + 30);
    const s = sender([MUTED, MUTED]);
    const a = api([member(21, 'New'), member(22, 'Other')]);
    await sendWelcomeCodes(1, wopts(s, a));
    nowMs = T0 + MUTE_BACKOFF_MS[0] + 1;
    await sendWelcomeCodes(1, wopts(s, a));
    expect(s.sent).toHaveLength(2);
    expect(chatPausedUntil(1, nowMs)).toBe(nowMs + MUTE_BACKOFF_MS[1]);
    expect(getChatSendState(1).muteCount).toBe(2);
    nowMs += MUTE_BACKOFF_MS[1] + 1;
    await sendWelcomeCodes(1, wopts(s, a));
    expect(s.sent).toHaveLength(3);
    expect(welcomes()).toContainEqual({ player_id: 21, status: 'sent', reason: null });
    expect(getChatSendState(1).muteCount).toBe(0);
  });

  it('between scans (the minute poller): live sends only, and a run that found no one waits 10 minutes before reading again', async () => {
    setWelcomeMode(1, 'dry-run', T0);
    gamePlayer(1, 21, 'New', 4, 1, T0s + 60);
    const s = sender();
    const a = api([]);
    // No dry-run listing from the poller: that is the scan's.
    expect(await sendWelcomeCodes(1, wopts(s, a, { betweenScans: true }))).toBe('');
    expect(welcomes()).toEqual([]);
    setWelcomeMode(1, 'on', T0);
    await sendWelcomeCodes(1, wopts(s, a, { betweenScans: true }));
    expect(a.listMembers).toHaveBeenCalledTimes(1);
    expect(welcomes()).toEqual([{ player_id: 21, status: 'waiting', reason: 'no-chat-account' }]);
    nowMs += 60_000;
    await sendWelcomeCodes(1, wopts(s, a, { betweenScans: true }));
    expect(a.listMembers).toHaveBeenCalledTimes(1);
    later();
    a.listMembers.mockResolvedValue([member(21, 'New')]);
    expect(await sendWelcomeCodes(1, wopts(s, a, { betweenScans: true }))).toBe('welcome codes: 1 sent');
    expect(s.sent.map((x) => x.channelUrl)).toEqual(['dm-tb:21']);
  });

  it('never a player who already left, or who already has a linked account', async () => {
    setWelcomeMode(1, 'on', T0);
    gamePlayer(1, 22, 'Gone', 4, 0, T0s + 60);
    gamePlayer(1, 23, 'Linked', 4, 1, T0s + 60);
    getDb().prepare("INSERT INTO users (id, username, password_hash, role, created_at, clan_id) VALUES (50, 'linked', 'x', 'user', 'x', 1)").run();
    getDb().prepare("INSERT INTO user_game_links (user_id, clan_id, player_id, linked_at, synced_at) VALUES (50, 2, 23, 'x', 'x')").run();
    const s = sender();
    await sendWelcomeCodes(1, wopts(s, api([member(22, 'Gone'), member(23, 'Linked')])));
    expect(s.sent).toHaveLength(0);
  });

  it('never sends into a chat that is not exactly the scanner and that player', async () => {
    setWelcomeMode(1, 'on', T0);
    gamePlayer(1, 21, 'New', 4, 1, T0s + 60);
    const s = sender();
    const a = api([member(21, 'New')], (other) => ({
      url: 'dm-wrong', customType: 'whisper', name: '', memberCount: 3,
      members: [{ userId: SCANNER, nickname: 's' }, { userId: other, nickname: 'o' }, { userId: 'tb:5', nickname: 'x' }], lastMessageAt: null,
    }));
    await sendWelcomeCodes(1, wopts(s, a));
    expect(s.sent).toHaveLength(0);
    expect(welcomes()).toEqual([{ player_id: 21, status: 'skipped', reason: 'channel' }]);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM account_invite_codes').get()).toEqual({ n: 0 });
  });

  it('an unknown outcome is never resent; CHAT_SEND_DISABLED sends nothing', async () => {
    setWelcomeMode(1, 'on', T0);
    gamePlayer(1, 21, 'New', 4, 1, T0s + 60);
    gamePlayer(1, 22, 'Other', 4, 1, T0s + 60);
    const s = sender([{ status: 'unknown', error: 'timeout' }]);
    const a = api([member(21, 'New'), member(22, 'Other')]);
    process.env.CHAT_SEND_DISABLED = '1';
    await sendWelcomeCodes(1, wopts(s, a));
    expect(s.sent).toHaveLength(0);
    delete process.env.CHAT_SEND_DISABLED;
    await sendWelcomeCodes(1, wopts(s, a));
    later();
    await sendWelcomeCodes(1, wopts(s, a));
    expect(s.sent).toHaveLength(2);
    later();
    await sendWelcomeCodes(1, wopts(s, a));
    expect(s.sent).toHaveLength(2);
    expect(welcomes()).toEqual([
      { player_id: 21, status: 'unknown', reason: 'timeout' },
      { player_id: 22, status: 'sent', reason: null },
    ]);
  });

  it('no message ever carries a link: no http, no www, no unspaced domain — the site is spaced out', async () => {
    getDb().prepare("UPDATE clans SET public_url = 'https://www.cwb.fyi', name = 'cwb.fyi' WHERE id = 1").run();
    expect(siteNameFor(1)).toBe('cwb . fyi');
    // The settings box is pre-filled with this; saving it unchanged keeps following the address.
    expect(defaultSiteNameFor(1)).toBe('cwb . fyi');
    expect(spacedSiteName('https://Chests.Taul1.com:8443/join?x=1')).toBe('chests . taul1 . com');
    const linky = /http|www|[a-z0-9-]\.[a-z]{2,}/i;
    // Every wording (the extremes, and a spread of random ones) says the same
    // things: the code, the tracker and its maker, both doors, the hours.
    const rands = [() => 0, () => 0.999, () => 0.5, ...Array.from({ length: 200 }, () => Math.random)];
    const texts: string[] = [];
    for (const r of rands) {
      texts.push(
        inviteReplyText('ABCDEFGH', siteNameFor(1), r),
        inviteReplyText('ABCDEFGH', null, r),
        welcomeText('ABCDEFGH', 'cwb.fyi', siteNameFor(1), r),
        welcomeText('ABCDEFGH', 'Normal Clan', null, r),
        welcomeText('ABCDEFGH', 'A Very Long Clan Name Indeed Of The Realm', 'chests . taul1 . com', r),
      );
    }
    for (const text of texts) {
      expect(text, text).not.toMatch(linky);
      expect(text.length, text).toBeLessThanOrEqual(400);
      expect(text, text).toContain('ABCD-EFGH');
      expect(text, text).toContain('TB Chest Counter');
      expect(text, text).toContain('clan tracker by taulen');
      expect(text, text).toContain('"Have a code? Join here"');
      // Signed-in players never see the sign-in page: their door is named too.
      expect(text, text).toContain('"Add a clan with a code" in your account menu');
      expect(text, text).toContain('72 hours');
    }
    expect(inviteReplyText('ABCDEFGH', siteNameFor(1), () => 0)).toContain('Go to cwb . fyi');
    // The clan name is dropped when it looks like a link.
    expect(welcomeText('ABCDEFGH', 'cwb.fyi', siteNameFor(1), () => 0).startsWith('Welcome! ')).toBe(true);
    // The wording varies: not one message shape for everyone.
    const shapes = new Set(Array.from({ length: 50 }, () => welcomeText('ABCDEFGH', 'Normal Clan', siteNameFor(1))));
    expect(shapes.size).toBeGreaterThan(5);

    // And what actually goes out.
    setWelcomeMode(1, 'on', T0);
    gamePlayer(1, 21, 'New', 4, 1, T0s + 60);
    const s = sender();
    await sendWelcomeCodes(1, wopts(s, api([member(21, 'New')])));
    expect(s.sent[0].text).not.toMatch(linky);
  });

  it('finds the chat account from the player’s own lines first, else a member whose id AND name match', () => {
    expect(findChatAccount(1, 21, 'New', [member(21, 'New')])).toBe('tb:21');
    expect(findChatAccount(1, 21, 'New', [member(21, 'Impostor')])).toBeNull();
    expect(findChatAccount(1, 21, 'New', [member(21, 'New', 'tb:a'), member(21, 'New', 'tb:b')])).toBeNull();
    dm(1, 'tb:own', 21, 'hi', T0, { url: 'triumph_clan_channel_1', type: 'clanGroup', members: [] });
    expect(findChatAccount(1, 21, 'New', [member(21, 'New', 'tb:other')])).toBe('tb:own');
  });
});
