/**
 * The clan's own game data (v111, My Clan page): the clan record's
 * Information-tab fields, the Clan Capital (research in field 17, treasury in
 * field 5, position), messages 25 (might + wealth points), 14003 (help
 * points), 28001 (medals) and 23 (wealth ranking) — parsed from hand-written
 * minimal replies shaped like the live ones — and the repository's history:
 * research keeps a row only when a level moves, and the first read is the
 * baseline, not a change.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Frame, Wire } from '../../src/game-protocol/codec.js';
import {
  parseCapitalBorder,
  parseClanCapital,
  parseClanMedals,
  parseClanRanking,
  parseClanRecord,
  parseClanStats,
  parseClanSummaries,
  rankIn,
} from '../../src/game-protocol/messages.js';
import {
  getClanInfo,
  getClanRankHistory,
  getClanRankingLists,
  getClanTechChanges,
  getClanTechs,
  getClanTreasury,
  getDailyClanStats,
  getLatestClanStats,
  hasClanTechs,
  latestArchivedClanObject,
  saveClanInfo,
  saveClanRanking,
  saveClanStats,
  saveClanTechs,
  saveClanTreasury,
} from '../../src/data/repositories/game-clan-repo.js';
import { saveRawSnapshot } from '../../src/data/repositories/game-protocol-repo.js';
import { makeTestDb } from '../helpers/test-db.js';

const frame = (type: number, body: Wire[]): Frame => ({ type, seq: 1, head: [type, 1], body, children: [], events: [] });

/** A 36-field object record, like a city's or the Clan Capital's. */
function capitalRecord(fields: Record<number, Wire>): Wire[] {
  const r: Wire[] = new Array(36).fill(null);
  for (const [i, v] of Object.entries(fields)) r[Number(i)] = v;
  return r;
}

describe('clan messages', () => {
  it('reads the Information-tab fields of the clan record (15000)', () => {
    const rec: Wire = [
      [1297080123906],
      ['CWB', 'ChaosWithoutBorders', 1118480, 'Welcome', 'Message of the day', [1297080171719], [1297120550815], [1297080143438],
        1776412294, 3, 1, 0, 0, 'en_US', 1794724537, 1],
      [[[390842355323], 1, 1790003608], [[631360456527], 5, 1794868161]],
      [], {}, [[1116875204268], [1297120550815]], 100, 8325969188, null, 6004, null, 5011, { $pairs: [[[1018, 1], [16]]] },
      [],
      false,
    ];
    const r = parseClanRecord(frame(15000, [[[rec]]]));
    expect(r).toMatchObject({
      capitalId: 1297120550815,
      memberLimit: 100,
      might: 8325969188,
      foundedAt: 1776412294,
      language: 'en_US',
      logo: 1118480,
      extra: { f9: 6004, f11: 5011, f12: { $pairs: [[[1018, 1], [16]]] } },
    });
  });

  it('reads the Clan Capital: research (f17), treasury (f5) and position', () => {
    const rec = capitalRecord({
      0: [1297120550815],
      1: [[0], [1297080123906], 10001, 1776412294, 0, 0, 5079388, 3082211, 260, 260, [0], 1, 2, [260, 801, 171], [260, 801, 171]],
      5: { 20: [20, 200971520], 31: [31, 7510571] },
      17: { 10000: [10000, 10], 10007: [10007, 1], 33: [33, 8] },
    });
    // The reply unwraps to [[record], []], as archived.
    const c = parseClanCapital(frame(601, [[[rec], []]]));
    expect(c).toEqual({
      capitalId: 1297120550815,
      techs: { 33: 8, 10000: 10, 10007: 1 },
      treasury: { 20: 200971520, 31: 7510571 },
      position: [260, 801, 171],
    });
  });

  it('reads might and wealth points (25), help points (14003), medals (28001), the wealth ranking (23)', () => {
    const stats = parseClanStats(frame(25, [[{ 1: 8325969188, 3: 296887512787800, 7: 297868207, 9: 66 }]]));
    expect(stats?.might).toBe(8325969188);
    expect(stats?.wealth).toBe(297868207);
    expect(stats?.raw).toMatchObject({ 3: 296887512787800, 9: 66 });

    const border = parseCapitalBorder(frame(14003, [[
      [[[20], 296887512787800], [[29], 2000000], [[30], 5590629], [[31], 1794914450]],
      [[[1, 31], 1], [[60], 1]],
      [[[30], 0]],
    ]]));
    expect(border?.helpPoints).toBe(5590629);
    expect(border?.raw).toMatchObject({ 29: 2000000, 31: 1794914450 });

    expect(parseClanMedals(frame(28001, [[[[27, 1778515989], [23, 1787975559]]]]))).toEqual([
      { medalId: 27, earnedAt: 1778515989 },
      { medalId: 23, earnedAt: 1787975559 },
    ]);

    // Not sorted by value: the rank comes from sorting.
    const ranking = parseClanRanking(frame(23, [[[[863288427082, 29990833856], [1297080123906, 297852373], [983547510798, 3287818205]]]]));
    expect(ranking).toHaveLength(3);
    expect(rankIn(ranking, 1297080123906)).toBe(3);
    expect(rankIn(ranking, 983547510798)).toBe(2);
    expect(rankIn(ranking, 1)).toBeNull();
  });

  it('reads the listed clans of a ranking (15200): logo, tag, name, members, might', () => {
    const row = (id: number, logo: number, tag: string, name: string, max: number, n: number, might: number): Wire =>
      [[[id], logo, tag, name, 3, 0, 0, max, n, 'en_US', might, 1], { $pairs: [[[1018, 1], [0]]] }];
    const out = parseClanSummaries(frame(15200, [[[[row(1529008357388, 1513752, 'LWR', 'Last War', 60, 50, 802787), row(1297080123906, 1118480, 'CWB', 'ChaosWithoutBorders', 100, 69, 8325969188)]]]]));
    expect(out).toEqual([
      { clanId: 1529008357388, logo: 1513752, tag: 'LWR', name: 'Last War', memberLimit: 60, members: 50, language: 'en_US', might: 802787 },
      { clanId: 1297080123906, logo: 1118480, tag: 'CWB', name: 'ChaosWithoutBorders', memberLimit: 100, members: 69, language: 'en_US', might: 8325969188 },
    ]);
  });
});

describe('clan repository', () => {
  let cleanup: () => void;
  beforeEach(() => { ({ cleanup } = makeTestDb()); });
  afterEach(() => cleanup());

  it('keeps research history only on change, the first read as the baseline', () => {
    const clanId = 1;
    expect(hasClanTechs(clanId)).toBe(false);
    expect(saveClanTechs(clanId, { 10000: 9, 10007: 1 }, '2026-11-16T20:00:00Z')).toBe(2);
    expect(saveClanTechs(clanId, { 10000: 9, 10007: 1 }, '2026-11-17T01:00:00Z')).toBe(0);
    expect(saveClanTechs(clanId, { 10000: 10, 10007: 1, 10011: 1 }, '2026-11-17T05:00:00Z')).toBe(2);
    expect(hasClanTechs(clanId)).toBe(true);
    expect(getClanTechs(clanId)).toEqual({ levels: { 10000: 10, 10007: 1, 10011: 1 }, readAt: '2026-11-17T05:00:00Z' });
    expect(getClanTechChanges(clanId, '2026-11-01T00:00:00Z')).toEqual([
      { techId: 10000, level: 10, changedAt: '2026-11-17T05:00:00Z' },
      { techId: 10011, level: 1, changedAt: '2026-11-17T05:00:00Z' },
    ]);
  });

  it('stores the info, a stats row per scan, the treasury per day, and finds the archived capital', () => {
    const clanId = 1;
    saveClanInfo(clanId, {
      gameClanId: 1297080123906, tag: 'CWB', name: 'ChaosWithoutBorders', foundedAt: 1776412294, language: 'en_US',
      capitalId: 1297120550815, position: [260, 801, 171],
    }, '2026-11-17T05:00:00Z');
    expect(getClanInfo(clanId)).toMatchObject({
      tag: 'CWB', foundedAt: '2026-04-17T07:51:34.000Z', realm: 260, capitalX: 801, capitalY: 171,
    });
    // A later read without a position keeps the known one.
    saveClanInfo(clanId, {
      gameClanId: 1297080123906, tag: 'CWB', name: 'ChaosWithoutBorders', foundedAt: null, language: 'en_US', capitalId: null, position: null,
    }, '2026-11-17T06:00:00Z');
    expect(getClanInfo(clanId)).toMatchObject({ foundedAt: '2026-04-17T07:51:34.000Z', capitalX: 801, updatedAt: '2026-11-17T06:00:00Z' });

    const s = { members: 69, memberLimit: 100, might: 1, wealth: 10, helpPoints: 5, wealthRank: 12, raw: {} };
    saveClanStats(clanId, '2026-11-16', s, '2026-11-16T20:00:00Z');
    saveClanStats(clanId, '2026-11-16', { ...s, might: 2 }, '2026-11-17T04:00:00Z');
    saveClanStats(clanId, '2026-11-17', { ...s, might: 3 }, '2026-11-17T18:00:00Z');
    expect(getLatestClanStats(clanId)?.might).toBe(3);
    // One row per game day: the day's last read.
    expect(getDailyClanStats(clanId, '2026-11-01').map((r) => [r.gameDate, r.might])).toEqual([['2026-11-16', 2], ['2026-11-17', 3]]);

    saveClanTreasury(clanId, '2026-11-16', { 20: 100, 31: 7 }, '2026-11-16T20:00:00Z');
    saveClanTreasury(clanId, '2026-11-17', { 20: 150 }, '2026-11-17T18:00:00Z');
    expect(getClanTreasury(clanId)).toEqual({
      gameDate: '2026-11-17', capturedAt: '2026-11-17T18:00:00Z', rows: [{ resourceId: 20, amount: 150, previous: 100 }],
    });

    expect(latestArchivedClanObject(clanId, 1297120550815)).toBeNull();
    saveRawSnapshot(clanId, 'clan_object', 1297120550815, '2026-11-16', [[[['x']]]], '2026-11-16T20:00:00Z');
    expect(latestArchivedClanObject(clanId, 1297120550815)).toEqual({ capturedAt: '2026-11-16T20:00:00Z', body: [[[['x']]]] });
  });

  it("keeps the latest list per ranking and this clan's rank per scan", () => {
    const clanId = 1;
    const e = (id: number, value: number) => ({ clanId: id, value, tag: 'T', name: 'N', logo: null, members: 1, memberLimit: 100 });
    saveClanRanking(clanId, '2026-11-16', 7, [e(1, 30), e(2, 20)], { rank: 2, value: 20 }, '2026-11-16T20:00:00Z');
    saveClanRanking(clanId, '2026-11-17', 7, [e(2, 40), e(1, 30)], { rank: 1, value: 40 }, '2026-11-17T18:00:00Z');
    saveClanRanking(clanId, '2026-11-17', 3, [e(1, 9)], { rank: null, value: null }, '2026-11-17T18:00:00Z');
    const lists = getClanRankingLists(clanId).sort((a, b) => a.kind - b.kind);
    expect(lists.map((l) => [l.kind, l.capturedAt, l.entries.map((x) => x.clanId)])).toEqual([
      [3, '2026-11-17T18:00:00Z', [1]],
      [7, '2026-11-17T18:00:00Z', [2, 1]],
    ]);
    expect(getClanRankHistory(clanId, '2026-11-01')).toEqual([
      { kind: 3, gameDate: '2026-11-17', rank: null, value: null },
      { kind: 7, gameDate: '2026-11-16', rank: 2, value: 20 },
      { kind: 7, gameDate: '2026-11-17', rank: 1, value: 40 },
    ]);
  });
});
