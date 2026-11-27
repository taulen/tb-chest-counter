/**
 * Battle reports shared in chat (v143, docs/battle-reports.md): a link in any
 * chat the clan keeps is queued once, opened between scans, and a Tin Man hit
 * shows with the Tin Man's stacks under the clan that saw it. Ids are made up.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { saveChatMessages, upsertChatChannel } from '../../src/data/repositories/chat-repo.js';
import {
  getReportChats, getTinmanRequiredStacks, listAnnouncements, listTinmanHits, markReportFailed, pendingReports, recordReportShares,
  reportCounts, saveFetchedReport, setReportChats, setTinmanRequiredStacks,
} from '../../src/data/repositories/battle-report-repo.js';
import { playerIdOf, type BattleReport } from '../../src/game-protocol/battle-report.js';
import { refreshGroupChats, getPostableChannels } from '../../src/data/repositories/chat-digest-repo.js';
import type { ChatMessage } from '../../src/game-protocol/chat.js';
import { makeTestDb, seedTwoClans } from '../helpers/test-db.js';

let cleanup: () => void;
beforeEach(() => { ({ cleanup } = makeTestDb()); seedTwoClans(); });
afterEach(() => cleanup());

const CLAN_URL = 'triumph_clan_channel_1';
const DM_URL = 'whisper_1_2';
const GROUP_URL = 'sendbird_group_channel_9';
const T0 = 1_795_000_000_000;
const PLAYER = playerIdOf(300, 0x12345);
const E1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const E2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const E3 = 'aaaaaaaa-0000-4000-8000-000000000003';

const link = (entryId: string, entryType = 'attack', staticId = 6054) => JSON.stringify({ subs: { '/%0%/': {
  type: 'journal', entryType, guid: [300, 0x345], staticId, name: '', v: 1, journalV2EntryId: entryId, source: 'unity_v2',
} } });

function msg(id: number, channelUrl: string, data: string, at = T0 + id): ChatMessage {
  return {
    messageId: id, channelUrl, createdAt: at, customType: 'user', senderId: 'tb:1', senderName: 'Hitter',
    senderInfo: `12c,${PLAYER.toString(16)},12c00000202,0,4,CWB`, message: '/%0%/', data, updatedAt: 0, translations: '',
  };
}

function tinmanReport(stacks: number, level = 55): BattleReport {
  const units = [7540, 7541, 7542, 7543].slice(0, stacks).map((unit) => ({ unit, count: 1000 }));
  return {
    kind: 'battle', won: false, rounds: 6, targetStaticId: 5999 + level, strikeLogId: null,
    attackers: [{ playerId: PLAYER, armyId: 1, units: [{ unit: 206, count: 475 }], killed: {}, effects: [] }],
    defenders: [{ playerId: playerIdOf(260, 1), armyId: 2, units, killed: { 7540: 10, 7541: 5 }, effects: [] }],
  };
}

describe('report shares', () => {
  it('queues attack reports and announcements linked in any kept chat — the clan chat, a DM to the scanner, a report chat', () => {
    upsertChatChannel(1, { url: CLAN_URL, customType: 'clanGroup', name: '', memberCount: 0, members: [], lastMessageAt: null });
    saveChatMessages(1, [
      msg(1, CLAN_URL, link(E1)),
      msg(2, DM_URL, link(E2)),
      msg(3, GROUP_URL, link(E3, 'clan_announcement', 0)),
      msg(4, CLAN_URL, link('aaaaaaaa-0000-4000-8000-000000000009', 'scout', 0)),
      msg(5, CLAN_URL, ''),
    ]);
    expect(pendingReports(T0, 10, 1).map((p) => p.entryId).sort()).toEqual([E1, E2, E3]);
  });

  it('reads every clan’s queue with any clan’s token, its own shares first', () => {
    recordReportShares(2, [msg(1, CLAN_URL, link(E1, 'attack', 6054)), msg(2, CLAN_URL, link(E2))]);
    recordReportShares(1, [msg(3, CLAN_URL, link(E3, 'attack', 1817), T0 - 60_000)]);
    // Clan 1's own (older) share first, then clan 2's newest first — an inactive clan's reports get read.
    expect(pendingReports(T0, 10, 1).map((p) => p.entryId)).toEqual([E3, E2, E1]);
    expect(pendingReports(T0, 2, 2).map((p) => p.entryId)).toEqual([E2, E1]);
  });

  it('keeps one report however often it is shared, and one share per clan', () => {
    recordReportShares(1, [msg(1, CLAN_URL, link(E1)), msg(2, DM_URL, link(E1))]);
    recordReportShares(2, [msg(3, CLAN_URL, link(E1))]);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM battle_reports').get()).toEqual({ n: 1 });
    expect(getDb().prepare('SELECT clan_id, channel_url FROM battle_report_shares ORDER BY clan_id').all())
      .toEqual([{ clan_id: 1, channel_url: CLAN_URL }, { clan_id: 2, channel_url: CLAN_URL }]);
  });

  it('opens the newest share first and backs off a failure, giving up on a report the game refuses twice', () => {
    recordReportShares(1, [msg(1, CLAN_URL, link(E1)), msg(2, CLAN_URL, link(E2))]);
    expect(pendingReports(T0, 10, 1).map((p) => p.entryId)).toEqual([E2, E1]);
    expect(markReportFailed(E2, 'timeout', { gone: false, nowMs: T0 })).toBe('failed');
    expect(pendingReports(T0, 10, 1).map((p) => p.entryId)).toEqual([E1]);
    expect(pendingReports(T0 + 10 * 60_000, 10, 1).map((p) => p.entryId)).toEqual([E2, E1]);
    expect(markReportFailed(E1, 'status 4', { gone: true, nowMs: T0 })).toBe('failed');
    expect(markReportFailed(E1, 'status 4', { gone: true, nowMs: T0 + 3_600_000 })).toBe('unavailable');
    expect(reportCounts(1)).toMatchObject({ shared: 2, read: 0, waiting: 1, unavailable: 1 });
  });
});

describe('Tin Man hits', () => {
  beforeEach(() => {
    upsertChatChannel(1, { url: CLAN_URL, customType: 'clanGroup', name: '', memberCount: 0, members: [], lastMessageAt: null });
    upsertChatChannel(1, { url: DM_URL, customType: 'whisper', name: '', memberCount: 0, members: [], lastMessageAt: null });
    getDb().prepare(
      "INSERT INTO members (clan_id, name, normalized_name, first_seen, last_seen, is_active, game_player_id) VALUES (1, 'Hitter', 'hitter', '2026-11-01', '2026-11-27', 1, ?)",
    ).run(PLAYER);
  });

  it('lists the clan’s hits in the window with the Tin Man’s stacks, the member and where it was shared', () => {
    recordReportShares(1, [msg(1, CLAN_URL, link(E1)), msg(2, DM_URL, link(E2)), msg(3, CLAN_URL, link(E3))]);
    saveFetchedReport(E1, { at: 1_795_381_332, type: 'battle', report: tinmanReport(4), raw: Buffer.from([0x90]), strikeLog: null, strikes: null });
    saveFetchedReport(E2, { at: 1_795_400_000, type: 'battle', report: tinmanReport(2, 131), raw: Buffer.from([0x90]), strikeLog: null, strikes: null });
    const citadel: BattleReport = { ...tinmanReport(4), targetStaticId: 1817 };
    saveFetchedReport(E3, { at: 1_795_400_100, type: 'battle', report: citadel, raw: Buffer.from([0x90]), strikeLog: null, strikes: null });

    const hits = listTinmanHits(1, null, null);
    expect(hits.map((h) => [h.entryId, h.stacks, h.level, h.sharedIn])).toEqual([[E2, 2, 131, 'private'], [E1, 4, 55, 'clan']]);
    expect(hits[1]).toMatchObject({ name: 'Hitter', playerId: PLAYER, killed: 15 });
    expect(hits[1].memberId).not.toBeNull();
    // The window is the fight's time, half-open.
    expect(listTinmanHits(1, new Date(1_795_381_332_000).toISOString(), new Date(1_795_400_000_000).toISOString()).map((h) => h.entryId)).toEqual([E1]);
    expect(listTinmanHits(2, null, null)).toEqual([]);
  });

  it('keeps the clan’s Tin Man rule to the offered choices', () => {
    expect(getTinmanRequiredStacks(1)).toBeNull();
    setTinmanRequiredStacks(1, 4);
    expect(getTinmanRequiredStacks(1)).toBe(4);
    setTinmanRequiredStacks(1, 7);
    expect(getTinmanRequiredStacks(1)).toBeNull();
  });
});

describe('clan announcements', () => {
  it('lists the clan’s announcements newest first with their author and headline', () => {
    const annc = (entryId: string, author: string) => JSON.stringify({ subs: { '/%0%/': {
      type: 'journal', entryType: 'clan_announcement', guid: [302, 1], staticId: 0, name: author, v: 1, journalV2EntryId: entryId,
    } } });
    saveChatMessages(1, [msg(1, CLAN_URL, annc(E1, 'Leader One')), msg(2, DM_URL, annc(E2, 'Leader Two'))]);
    saveFetchedReport(E1, { at: 1_795_700_000, type: 'clan_announcement', report: null, raw: Buffer.from([0x90]), strikeLog: null, strikes: null, announcement: 'HELLO ORCAS!\n\nVAULTS AFTER RESET' });
    saveFetchedReport(E2, { at: 1_795_780_000, type: 'clan_announcement', report: null, raw: Buffer.from([0x90]), strikeLog: null, strikes: null, announcement: 'Tinman times:\nR +0' });
    expect(listAnnouncements(1).map((a) => [a.author, a.headline])).toEqual([['Leader Two', 'Tinman times'], ['Leader One', 'VAULTS AFTER RESET']]);
    expect(listAnnouncements(1)[1].text).toBe('HELLO ORCAS!\n\nVAULTS AFTER RESET');
    // Only those since a moment (the strip over My Clan's tabs), and only the clan's own.
    expect(listAnnouncements(1, 50, new Date(1_795_750_000_000).toISOString()).map((a) => a.entryId)).toEqual([E2]);
    expect(listAnnouncements(2)).toEqual([]);
  });
});

describe('report chats', () => {
  it('replaces the picked chats, keeping the day a chat was added', () => {
    setReportChats(1, [{ url: GROUP_URL, name: 'Tin Man hits' }], '2026-11-27T10:00:00.000Z');
    setReportChats(1, [{ url: GROUP_URL, name: 'Tin Man hits!' }, { url: 'sendbird_group_channel_8', name: 'Citadels' }], '2026-11-28T10:00:00.000Z');
    expect(getReportChats(1)).toEqual([
      { url: 'sendbird_group_channel_8', name: 'Citadels', addedAt: '2026-11-28T10:00:00.000Z', purpose: 'reports' },
      { url: GROUP_URL, name: 'Tin Man hits!', addedAt: '2026-11-27T10:00:00.000Z', purpose: 'reports' },
    ]);
    setReportChats(1, []);
    expect(getReportChats(1)).toEqual([]);
  });

  it('refreshes the account’s group chats only when they changed', () => {
    const chats = [{ url: GROUP_URL, customType: 'publicGroup', name: 'testchattracker', memberCount: 2 }];
    expect(refreshGroupChats(1, chats)).toBe(true);
    expect(refreshGroupChats(1, chats)).toBe(false);
    expect(getPostableChannels(1).map((c) => c.name)).toEqual(['testchattracker']);
    expect(refreshGroupChats(1, [{ ...chats[0], memberCount: 3 }])).toBe(true);
  });
});
