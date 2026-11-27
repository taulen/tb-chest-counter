/**
 * Opening shared battle reports between scans (scheduler/battle-reports.ts):
 * read what the game hands back, keep the strike log, leave a report the game
 * refuses, stop at a dead connection, and drop a token that has run out.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/data/database.js';
import { recordReportShares } from '../../src/data/repositories/battle-report-repo.js';
import { fetchSharedReports } from '../../src/scheduler/battle-reports.js';
import { JOURNAL_METHOD, type JournalReply } from '../../src/game-protocol/journal.js';
import { encodeValues, type Wire } from '../../src/game-protocol/codec.js';
import { makeTestDb, seedTwoClans } from '../helpers/test-db.js';

let cleanup: () => void;
beforeEach(() => { ({ cleanup } = makeTestDb()); seedTwoClans(); });
afterEach(() => cleanup());

const NOW = 1_795_800_000_000;
const token = (exp: number) => `eyJ0eXAiOiJKV1QifQ%3D%3D.${encodeURIComponent(Buffer.from(JSON.stringify({ aud: 'Journal', exp })).toString('base64'))}.c2ln`;
const GOOD = token(NOW / 1000 + 86_400);
const bin = (b: Buffer) => ({ $bin: b.length, hex: b.toString('hex') });
const E1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const E2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const LOG = 'cccccccc-0000-4000-8000-000000000001';

function share(entryId: string, id: number, type = 'attack') {
  recordReportShares(1, [{
    channelUrl: 'triumph_clan_channel_1', messageId: id, createdAt: NOW - 1000 + id, senderName: 'Hitter', senderInfo: '',
    data: JSON.stringify({ subs: { '/%0%/': { type: 'journal', entryType: type, staticId: 6054, journalV2EntryId: entryId } } }),
  }]);
}

function battle(): Buffer {
  const march = (owner: number, units: Wire[]): Wire[] => { const m: Wire[] = new Array(36).fill(0); m[0] = [owner + 1]; m[1] = [[owner]]; m[30] = units; return m; };
  const b: Wire[] = new Array(17).fill([]);
  b[0] = 'battle'; b[1] = 'false'; b[2] = 6;
  b[7] = [[[300, 1], march(1288490188801, [[206, 475, 0]]), [{}, {}, 1]]];
  b[8] = [[[260, 1], march(1116691496961, [[7540, 9, 0], [7541, 9, 0], [7542, 9, 0]]), [{}, { 7540: 1 }, 1]]];
  b[9] = LOG;
  b[14] = 6054;
  return encodeValues([b]);
}

/** A fake journal: answers by entry id from `replies`; a function throws like a dead socket. */
function fakeJournal(replies: Record<string, JournalReply | (() => never)>, calls: Array<[number, Wire[]]>) {
  return async () => ({
    async call(method: number, args: Wire[]): Promise<JournalReply> {
      calls.push([method, args]);
      const key = method === JOURNAL_METHOD.items ? `log:${String(args[0])}` : String(args[0]);
      const r = replies[key];
      if (typeof r === 'function') return r();
      return r ?? { seq: 1, status: 3, error: 'not found', body: null };
    },
    close() {},
  });
}

const row = (entryId: string) => getDb().prepare('SELECT status, attempts, kind, tinman_stacks, strike_log IS NOT NULL AS has_log, summary FROM battle_reports WHERE entry_id = ?').get(entryId) as
  { status: string; attempts: number; kind: string | null; tinman_stacks: number | null; has_log: number; summary: string | null };

describe('opening shared reports', () => {
  it('reads a battle and its strike log, and asks the game for nothing else', async () => {
    share(E1, 1);
    const calls: Array<[number, Wire[]]> = [];
    const strikeRows = encodeValues([[['true', [1], 206, 475, 100, 0, 0, 0, [2], 7540, 9, 900, 8, 800]]]);
    const r = await fetchSharedReports(1, GOOD, {
      now: NOW,
      open: fakeJournal({
        [E1]: { seq: 1, status: 0, error: '', body: [1_795_381_332, 'battle', [bin(battle())]] },
        [`log:${E1}`]: { seq: 2, status: 0, error: '', body: [{ [LOG]: [bin(strikeRows)] }] },
      }, calls),
    });
    expect(r).toEqual({ note: 'battle reports: 1 read', tokenBad: false });
    expect(calls.map((c) => c[0])).toEqual([JOURNAL_METHOD.sharedEntry, JOURNAL_METHOD.items]);
    expect(calls[1][1]).toEqual([E1, [LOG]]);
    expect(row(E1)).toMatchObject({ status: 'ok', kind: 'battle', tinman_stacks: 3, has_log: 1 });
    expect(JSON.parse(row(E1).summary!).strikes).toHaveLength(1);
  });

  it('keeps an announcement’s text', async () => {
    share(E1, 1, 'clan_announcement');
    await fetchSharedReports(1, GOOD, {
      now: NOW,
      open: fakeJournal({ [E1]: { seq: 1, status: 0, error: '', body: [1, 'clan_announcement', [bin(encodeValues([['clan_announcement', [302, 1], 'VAULTS AFTER RESET']]))]] } }, []),
    });
    expect(row(E1)).toMatchObject({ status: 'ok', kind: 'clan_announcement' });
    expect(JSON.parse(row(E1).summary!)).toEqual({ v: 1, announcement: 'VAULTS AFTER RESET' });
  });

  it('leaves a report the game refuses for a later try, and stops at a dead connection', async () => {
    share(E1, 1);
    share(E2, 2);
    const calls: Array<[number, Wire[]]> = [];
    const r = await fetchSharedReports(1, GOOD, {
      now: NOW,
      open: fakeJournal({ [E2]: () => { throw new Error('journal socket closed'); } }, calls),
    });
    // E2 is the newer share: tried first, the socket died, E1 waits for the next poll.
    expect(calls).toHaveLength(1);
    expect(r.note).toBe('');
    expect(row(E2)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(row(E1)).toMatchObject({ status: 'pending', attempts: 0 });
    // Later: E1 is refused by the game.
    await fetchSharedReports(1, GOOD, { now: NOW, open: fakeJournal({}, []) });
    expect(row(E1)).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('does nothing with a token that has run out, and says so', async () => {
    share(E1, 1);
    const calls: Array<[number, Wire[]]> = [];
    const r = await fetchSharedReports(1, token(NOW / 1000 - 10), { now: NOW, open: fakeJournal({}, calls) });
    expect(r.tokenBad).toBe(true);
    expect(calls).toHaveLength(0);
    expect(await fetchSharedReports(1, null, { now: NOW })).toEqual({ note: '', tokenBad: false });
  });
});
