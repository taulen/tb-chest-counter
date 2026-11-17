/**
 * The in-game chat digest (scheduler/chat-digest.ts, game-protocol/chat-send.ts):
 * the hand-written layout, the size ceiling, the posting window, the coverage
 * rule, the channel guard and — above all — at most ONE message per clan per
 * game day. Every send goes through a mock transport: nothing here (or in any
 * test) ever talks to the real chat service.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../src/data/database.js';
import {
  COVERAGE_MAX_GAP_H,
  coverageOf,
  digestDayLabel,
  digestSchedule,
  formatChatDigest,
  POST_LATE_LIMIT_MS,
  runChatDigest,
  type DigestRow,
} from '../../src/scheduler/chat-digest.js';
import {
  MAX_POST_BYTES,
  MAX_POST_CHARS,
  assertPostableChannel,
  postToGroupChat,
  type SocketSender,
} from '../../src/game-protocol/chat-send.js';
import {
  getChatDigestSettings,
  getDigestPost,
  requestTestPost,
  saveChatDigestSettings,
} from '../../src/data/repositories/chat-digest-repo.js';
import { makeTestDb } from '../helpers/test-db.js';

// The hand-written post of 15 November 2026 (user's screenshot), names as typed there.
const SCREENSHOT_ROWS: DigestRow[] = [
  ['Princess of Chaos', 35, 5815], ['jass', 13, 3560], ['FELI 2', 13, 2950], ['nurgul', 37, 2650],
  ['taulen302', 15, 2514], ['Dark Blue', 12, 1950], ['Megrond', 32, 1472], ['Marcus Maximus', 17, 1455],
  ['ChaoticChefPhoenix', 40, 1111], ['Darth', 8, 901], ['GamzeDD', 11, 730], ['Nimlotilas', 6, 652],
  ['Chaotic Sugman', 23, 568], ['Spartano666', 14, 495], ['Nimath', 20, 482], ['Lafym', 4, 481],
  ['Sir Grayling', 5, 480], ['fahd', 25, 399], ['Mкam from Chaos', 6, 390], ['Granizel', 9, 310],
].map(([name, chests, points]) => ({ name: name as string, chests: chests as number, points: points as number }));

const SCREENSHOT = [
  'Daily Digest — 15 November',
  'Our top 20 crypters',
  ' 1) Princess of Chaos ··· 35 chests (5,815)',
  ' 2) jass ················ 13 chests (3,560)',
  ' 3) FELI 2 ·············· 13 chests (2,950)',
  ' 4) nurgul ·············· 37 chests (2,650)',
  ' 5) taulen302 ··········· 15 chests (2,514)',
  ' 6) Dark Blue ··········· 12 chests (1,950)',
  ' 7) Megrond ············· 32 chests (1,472)',
  ' 8) Marcus Maximus ······ 17 chests (1,455)',
  ' 9) ChaoticChefPhoenix ·· 40 chests (1,111)',
  '10) Darth ··············· 8 chests (901)',
  '11) GamzeDD ············· 11 chests (730)',
  '12) Nimlotilas ·········· 6 chests (652)',
  '13) Chaotic Sugman ······ 23 chests (568)',
  '14) Spartano666 ········· 14 chests (495)',
  '15) Nimath ·············· 20 chests (482)',
  '16) Lafym ··············· 4 chests (481)',
  '17) Sir Grayling ········ 5 chests (480)',
  '18) fahd ················ 25 chests (399)',
  '19) Mкam from Chaos ····· 6 chests (390)',
  '20) Granizel ············ 9 chests (310)',
].join('\n');

describe('chat digest — the post', () => {
  it('reproduces the hand-written 15 November digest exactly, and that is the size ceiling', () => {
    const { text, shown } = formatChatDigest(SCREENSHOT_ROWS, '2026-11-15', 20);
    expect(text).toBe(SCREENSHOT);
    expect(shown).toBe(20);
    expect(text.length).toBe(MAX_POST_CHARS);
    expect(Buffer.byteLength(text, 'utf8')).toBe(MAX_POST_BYTES);
    expect(digestDayLabel('2026-01-02')).toBe('2 January');
  });

  it('never exceeds the ceiling: shorter dot leaders first, then names, then fewer entries', () => {
    const long = SCREENSHOT_ROWS.map((r, i) => ({ ...r, name: `${'Ж'.repeat(16)}${i}` }));
    const r1 = formatChatDigest(long, '2026-11-15', 20);
    expect(r1.text.length).toBeLessThanOrEqual(MAX_POST_CHARS);
    expect(Buffer.byteLength(r1.text, 'utf8')).toBeLessThanOrEqual(MAX_POST_BYTES);
    expect(r1.text.split('\n')[1]).toBe(`Our top ${r1.shown} crypters`);
    expect(r1.text.split('\n').length).toBe(r1.shown + 2);

    const huge = SCREENSHOT_ROWS.map((r, i) => ({ ...r, name: `${'Ж'.repeat(60)}${i}`, chests: 123456, points: 98765432 }));
    const r2 = formatChatDigest(huge, '2026-11-15', 20);
    expect(r2.shown).toBeGreaterThan(0);
    expect(r2.shown).toBeLessThan(20);
    expect(r2.text.length).toBeLessThanOrEqual(MAX_POST_CHARS);
    expect(Buffer.byteLength(r2.text, 'utf8')).toBeLessThanOrEqual(MAX_POST_BYTES);
    expect(r2.text).toContain('…');
  });

  it('keeps names on one line, says "1 chest", and posts nothing for an empty day', () => {
    const { text } = formatChatDigest([{ name: 'Evil\nName', chests: 1, points: 50 }], '2026-11-15', 20);
    expect(text.split('\n')).toEqual(['Daily Digest — 15 November', 'Our top 1 crypters', ' 1) Evil Name ··········· 1 chest (50)']);
    expect(formatChatDigest([], '2026-11-15', 20)).toEqual({ text: '', shown: 0 });
  });

  it('writes the post in the clan\'s language: header, month, plural and number grouping', () => {
    const rows = [{ name: 'jass', chests: 13, points: 3560 }, { name: 'Lafym', chests: 1, points: 481 }, { name: 'nurgul', chests: 22, points: 2650 }];
    const ru = formatChatDigest(rows, '2026-11-15', 20, 'ru').text.split('\n');
    expect(ru[0]).toBe('Итоги дня — 15 ноября');
    expect(ru[1]).toBe('Наши лучшие 3 по склепам');
    // Russian plurals: 13 сундуков, 1 сундук, 22 сундука.
    expect(ru[2]).toMatch(/13 сундуков \(3\s560\)$/);
    expect(ru[3]).toMatch(/1 сундук \(481\)$/);
    expect(ru[4]).toMatch(/22 сундука \(2\s650\)$/);
    const de = formatChatDigest(rows, '2026-11-15', 20, 'de').text.split('\n');
    expect(de[0]).toBe('Tagesübersicht — 15. November');
    expect(de[2]).toMatch(/13 Truhen \(3\.560\)$/);
    expect(de[3]).toMatch(/1 Truhe \(481\)$/);
    expect(formatChatDigest(rows, '2026-11-15', 20, 'es').text.split('\n')[0]).toBe('Resumen diario — 15 de noviembre');
    expect(digestDayLabel('2026-08-01', 'fr')).toBe('1 août');
  });

  it('a language never breaks the size ceiling', () => {
    const many = SCREENSHOT_ROWS.map((r) => ({ ...r, chests: r.chests * 1000, points: r.points * 1000 }));
    for (const lang of ['en', 'es', 'fr', 'ru', 'de'] as const) {
      const r = formatChatDigest(many, '2026-11-15', 20, lang);
      expect(r.text.length).toBeLessThanOrEqual(MAX_POST_CHARS);
      expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(MAX_POST_BYTES);
      expect(r.shown).toBeGreaterThan(0);
    }
  });
});

describe('chat digest — when', () => {
  it('posts the game day that closed at the last rollover, after the post time', () => {
    const at = Date.parse('2026-11-16T17:40:00Z');
    const s = digestSchedule(at, 17, 17 * 60 + 30);
    expect(s.gameDate).toBe('2026-11-15');
    expect(s.sentGameDate).toBe('2026-11-16');
    expect(new Date(s.dayStartMs).toISOString()).toBe('2026-11-15T17:00:00.000Z');
    expect(new Date(s.dayEndMs).toISOString()).toBe('2026-11-16T17:00:00.000Z');
    expect(new Date(s.postAtMs).toISOString()).toBe('2026-11-16T17:30:00.000Z');
    // Before the rollover the closed day is the one before.
    expect(digestSchedule(Date.parse('2026-11-16T16:00:00Z'), 17, 1050).gameDate).toBe('2026-11-14');
    // A post time before the rollover hour lands later in the same game day.
    expect(new Date(digestSchedule(at, 17, 16 * 60).postAtMs).toISOString()).toBe('2026-11-17T16:00:00.000Z');
  });

  it('needs the scan before the day, scans within the gap limit and the closing scan', () => {
    const start = Date.parse('2026-11-15T17:00:00Z');
    const end = start + 24 * 3600_000;
    const h = (n: number) => start + n * 3600_000;
    expect(coverageOf([h(-1), h(1), h(3), h(5), h(7), h(9), h(11), h(13), h(15), h(17), h(19), h(21), h(23), h(24.7)], start, end).ok).toBe(true);
    expect(coverageOf([h(-1), h(2), h(22), h(24.7)], start, end)).toMatchObject({ ok: false, code: 'gap' });
    expect(coverageOf([h(1), h(3), h(24.5)], start, end)).toMatchObject({ ok: false, code: 'no-scan-before' });
    expect(coverageOf([h(-1), h(2), h(5)], start, end)).toMatchObject({ ok: false, waiting: true, code: 'waiting' });
    expect(COVERAGE_MAX_GAP_H).toBe(3);
  });
});

describe('chat digest — where (the channel guard)', () => {
  it('refuses the clan chat, the kingdom chat and private chats — by type and by URL', () => {
    const refuse = (c: { url: string; customType: string; name: string }) => expect(() => assertPostableChannel(c)).toThrow(/refusing|no channel/);
    refuse({ url: 'triumph_clan_channel_1297080123906', customType: 'clanGroup', name: 'game_config.value.chat.clan_group_key' });
    refuse({ url: 'triumph_clan_channel_1297080123906', customType: 'publicGroup', name: 'CWB • Carter' }); // wrong type stored — the URL still refuses
    refuse({ url: 'sendbird_group_channel_1', customType: 'clanGroup', name: 'x' });
    refuse({ url: 'triumph_realm_channel_260', customType: 'realmGroup', name: 'Kingdom' });
    refuse({ url: 'sendbird_group_channel_2', customType: 'whisper', name: 'tb:1_tb:2' });
    refuse({ url: 'sendbird_group_channel_3', customType: 'privateSystemGroup', name: 'System' });
    refuse({ url: 'sendbird_group_channel_4', customType: 'publicGroup', name: '  ' });
    refuse({ url: '', customType: 'publicGroup', name: 'CWB • Carter' });
    expect(() => assertPostableChannel({ url: 'sendbird_group_channel_798560814_0e3a', customType: 'publicGroup', name: 'CWB • Carter' })).not.toThrow();
  });

  it('never hands a refused channel, an over-long text or anything under the kill switch to the transport', async () => {
    const send = vi.fn<SocketSender>(async () => ({ status: 'sent', messageId: 1 }));
    const carter = { url: 'sendbird_group_channel_1', customType: 'publicGroup', name: 'CWB • Carter' };
    const base = { userId: 'tb:1', token: 'x', text: SCREENSHOT };
    expect(await postToGroupChat({ ...base, channel: { url: 'triumph_clan_channel_1', customType: 'clanGroup', name: '' } }, send)).toMatchObject({ status: 'refused' });
    expect(await postToGroupChat({ ...base, channel: carter, text: `${SCREENSHOT}x` }, send)).toMatchObject({ status: 'refused' });
    vi.stubEnv('CHAT_SEND_DISABLED', '1');
    expect(await postToGroupChat({ ...base, channel: carter }, send)).toMatchObject({ status: 'refused' });
    vi.unstubAllEnvs();
    expect(send).not.toHaveBeenCalled();
    expect(await postToGroupChat({ ...base, channel: carter }, send)).toEqual({ status: 'sent', messageId: 1 });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('chat digest — at most one message a day', () => {
  let cleanup: () => void;
  const CLAN = 1;
  const CARTER = { url: 'sendbird_group_channel_798560814_carter', customType: 'publicGroup', name: 'CWB • Carter', memberCount: 74 };
  const CLAN_CHAT = { url: 'triumph_clan_channel_1297080123906', customType: 'clanGroup', name: '', memberCount: 69 };
  const day = Date.parse('2026-11-15T17:00:00Z');
  const at = (h: number) => day + h * 3600_000;
  const client = { suid: 'tb:83761497', nickname: 'D4DDYLiZ', chatToken: vi.fn(async () => 'a'.repeat(40)) };

  const scan = (ms: number) => getDb().prepare(
    `INSERT INTO scan_sessions (started_at, completed_at, status, trigger_source, clan_id) VALUES (?, ?, 'completed', 'scheduled', ?)`,
  ).run(new Date(ms - 60_000).toISOString(), new Date(ms).toISOString(), CLAN);

  const run = (nowMs: number, send: SocketSender, extra: Partial<Parameters<typeof runChatDigest>[1]> = {}) => runChatDigest(CLAN, {
    client, rolloverUtcHour: 17, now: nowMs, send,
    listGroupChats: async () => [CARTER, CLAN_CHAT],
    rows: () => SCREENSHOT_ROWS,
    ...extra,
  });

  beforeEach(() => {
    ({ cleanup } = makeTestDb());
    // A covered day: a scan before it, every 2 h inside it, and the closing scan.
    for (let h = -1; h <= 25; h += 2) scan(at(h));
    saveChatDigestSettings(CLAN, { enabled: true, channelUrl: null, channelName: 'CWB • Carter', entries: 20, postUtcMinute: 17 * 60 + 30 });
    client.chatToken.mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    cleanup();
  });

  it('posts once after the post time, into the chosen group chat, and never again that day', async () => {
    const send = vi.fn<SocketSender>(async () => ({ status: 'sent', messageId: 16772399999 }));
    expect(await run(at(24.2), send)).toBe(''); // 17:12 UTC: before 17:30
    expect(send).not.toHaveBeenCalled();

    expect(await run(at(25.1), send)).toMatch(/posted to "CWB • Carter"/);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ channelUrl: CARTER.url, userId: 'tb:83761497', text: SCREENSHOT });
    expect(getDigestPost(CLAN, '2026-11-15')).toMatchObject({ status: 'sent', messageId: 16772399999, attempts: 1 });
    // The seeded-by-name chat is pinned by URL now.
    expect(getChatDigestSettings(CLAN).channelUrl).toBe(CARTER.url);

    // Later scans the same game day, and an admin's test request: nothing more goes out.
    await run(at(27), send);
    requestTestPost(CLAN, 1, new Date(at(28)).toISOString());
    expect(await run(at(28), send)).toMatch(/test not sent: already posted/);
    await run(at(40), send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(getChatDigestSettings(CLAN).testRequestedAt).toBeNull();
  });

  it('never posts a stale day: enabled long after the post time, it waits for the next day', async () => {
    const send = vi.fn<SocketSender>(async () => ({ status: 'sent', messageId: 7 }));
    // 15 Nov posts with the first scan after the 16 Nov 17:00 reset (at 24). Switched on at 17 Nov
    // 09:00 (at 40): the day closed long ago — the leaders posted it by hand.
    expect(await run(at(40), send)).toBe('');
    expect(send).not.toHaveBeenCalled();
    // Just inside the limit it still goes.
    expect(await run(at(24) + POST_LATE_LIMIT_MS - 60_000, send)).toMatch(/posted/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a test post may send the latest closed day however late it is', async () => {
    const send = vi.fn<SocketSender>(async () => ({ status: 'sent', messageId: 8 }));
    requestTestPost(CLAN, 1, new Date(at(40)).toISOString());
    expect(await run(at(40), send)).toMatch(/posted/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a test post uses the day\'s one message — the scheduled post does not follow it', async () => {
    const send = vi.fn<SocketSender>(async () => ({ status: 'sent', messageId: 5 }));
    requestTestPost(CLAN, 1, new Date(at(24.1)).toISOString());
    scan(at(24.15)); // the scan that runs the hook, just after the rollover
    expect(await run(at(24.2), send)).toMatch(/posted/); // before the post time: the test goes anyway
    expect(getDigestPost(CLAN, '2026-11-15')).toMatchObject({ status: 'sent', trigger: 'test' });
    await run(at(25.1), send);
    await run(at(27), send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retries a VERIFIED failure once, on a later scan — never within the same scan, never a third time', async () => {
    const send = vi.fn<SocketSender>(async () => ({ status: 'refused', error: 'chat refused the message: muted' }));
    await run(at(25.1), send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(getDigestPost(CLAN, '2026-11-15')).toMatchObject({ status: 'failed', attempts: 1 });
    await run(at(27), send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(getDigestPost(CLAN, '2026-11-15')).toMatchObject({ status: 'failed', attempts: 2 });
    await run(at(29), send);
    await run(at(31), send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('never resends when it is unclear whether the message went out', async () => {
    const send = vi.fn<SocketSender>(async () => ({ status: 'unknown', error: 'chat socket timed out' }));
    await run(at(25.1), send);
    await run(at(27), send);
    await run(at(29), send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(getDigestPost(CLAN, '2026-11-15')).toMatchObject({ status: 'unknown', attempts: 1 });
  });

  it('a send that crashed mid-way (row left "sending") is never retried', async () => {
    const send = vi.fn<SocketSender>(async () => ({ status: 'sent', messageId: 1 }));
    getDb().prepare(
      `INSERT INTO chat_digest_posts (clan_id, game_date, sent_game_date, channel_url, status, attempts, text, created_at, updated_at)
       VALUES (?, '2026-11-15', '2026-11-16', ?, 'sending', 1, 'x', ?, ?)`,
    ).run(CLAN, CARTER.url, new Date(at(25)).toISOString(), new Date(at(25)).toISOString());
    await run(at(27), send);
    expect(send).not.toHaveBeenCalled();
  });

  it('one message per sending day even across digest days', async () => {
    const send = vi.fn<SocketSender>(async () => ({ status: 'sent', messageId: 1 }));
    // Something for another digest day already went out on game day 2026-11-16.
    getDb().prepare(
      `INSERT INTO chat_digest_posts (clan_id, game_date, sent_game_date, channel_url, status, attempts, text, created_at, updated_at)
       VALUES (?, '2026-11-14', '2026-11-16', ?, 'sent', 1, 'x', ?, ?)`,
    ).run(CLAN, CARTER.url, new Date(at(24.5)).toISOString(), new Date(at(24.5)).toISOString());
    await run(at(25.1), send);
    expect(send).not.toHaveBeenCalled();
  });

  it('skips a day the scans did not cover, posts nothing under the kill switch or when switched off', async () => {
    const send = vi.fn<SocketSender>(async () => ({ status: 'sent', messageId: 1 }));
    getDb().prepare("DELETE FROM scan_sessions WHERE completed_at > ? AND completed_at < ?").run(new Date(at(4)).toISOString(), new Date(at(12)).toISOString());
    expect(await run(at(25.1), send)).toMatch(/skipped/);
    expect(getDigestPost(CLAN, '2026-11-15')).toBeNull();

    for (let h = 3; h <= 13; h += 2) scan(at(h));
    vi.stubEnv('CHAT_SEND_DISABLED', 'true');
    expect(await run(at(25.1), send)).toMatch(/disabled/);
    vi.unstubAllEnvs();
    saveChatDigestSettings(CLAN, { ...getChatDigestSettings(CLAN), enabled: false });
    expect(await run(at(25.1), send)).toBe('');
    expect(send).not.toHaveBeenCalled();
  });

  it('never posts into the clan chat, even when the settings point at it', async () => {
    const send = vi.fn<SocketSender>(async () => ({ status: 'sent', messageId: 1 }));
    getDb().prepare('UPDATE chat_digest_settings SET channel_url = ? WHERE clan_id = ?').run(CLAN_CHAT.url, CLAN);
    // The account's channel list is postable kinds only — and the guard refuses the clan chat regardless.
    await run(at(25.1), send, { listGroupChats: async () => [CARTER, CLAN_CHAT] });
    expect(send).not.toHaveBeenCalled();
    expect(getDigestPost(CLAN, '2026-11-15')).toBeNull();
  });

  it('does not post when the account is not in the chosen chat', async () => {
    const send = vi.fn<SocketSender>(async () => ({ status: 'sent', messageId: 1 }));
    expect(await run(at(25.1), send, { listGroupChats: async () => [CLAN_CHAT] })).toMatch(/not in the chosen chat/);
    expect(send).not.toHaveBeenCalled();
  });
});
