/**
 * Players' titles (Nov 2026): the player record's field 19 / 20 and the city's
 * field 21 in the shapes prod's replies carry, the titles table (T29) as
 * names.json keeps it, and the view the profile header gets — only titles
 * still running, newest first.
 */
import { describe, expect, it } from 'vitest';
import type { Frame, Wire } from '../../src/game-protocol/codec.js';
import { parseCityRecord, parsePlayers } from '../../src/game-protocol/messages.js';
import { NAMES_FORMAT, TABLE_TITLES, buildNames, buildTitles, textLines } from '../../src/game-protocol/static-data.js';
import { parseCityTitles, parsePlayerTitles, parseTitleCounts, titleViews } from '../../src/game-protocol/titles.js';

const frame = (type: number, body: Wire[]): Frame => ({ type, seq: 0, head: [type, 0], body, children: [], events: [] });

describe('parsing', () => {
  it('reads the player record: field 19 the titles held, field 20 how often each was received', () => {
    // Prod's 402 shape (Nov 17 2026): Crypt Delver held, a history of seven titles.
    const rec: Wire[] = [[4501125731471], 'suid', 'FELI 2', 'US', 31, 9, 1, 214, 44, 17, 295274115, [1297080123906], 0, 'CWB', 0,
      [260, 803, 165], [1297100544969], 12169, 0,
      [[161, 1794840304], [375, 1793812336]],
      [[29, 2], [160, 99], [161, 190], [375, 3]],
      '', [1]];
    const [p] = parsePlayers(frame(402, [[rec]]));
    expect(p.titles).toEqual([
      { titleId: 161, assignedAt: 1794840304, eventId: null },
      { titleId: 375, assignedAt: 1793812336, eventId: null },
    ]);
    expect(p.titleCounts).toEqual({ 29: 2, 160: 99, 161: 190, 375: 3 });
    expect(p.goldPass).toBe(true);
  });

  it('tells "holds none" ([]) from "not in the reply" (null)', () => {
    expect(parsePlayerTitles([])).toEqual([]);
    expect(parsePlayerTitles(undefined)).toBeNull();
    expect(parsePlayerTitles('')).toBeNull();
    expect(parseTitleCounts(undefined)).toBeNull();
    // Malformed entries are skipped, not guessed at.
    expect(parsePlayerTitles([[29], ['x', 1], [0, 5], [29, 1794392169]])).toEqual([{ titleId: 29, assignedAt: 1794392169, eventId: null }]);
    expect(parseTitleCounts([[29, 0], [29], [375, 7]])).toEqual({ 375: 7 });
  });

  it('reads city field 21: {titleId: [titleId, eventId, assignedAt]}', () => {
    expect(parseCityTitles({ 29: [29, 0, 1794392169], 375: [375, 53, 1793839488] })).toEqual([
      { titleId: 29, assignedAt: 1794392169, eventId: 0 },
      { titleId: 375, assignedAt: 1793839488, eventId: 53 },
    ]);
    expect(parseCityTitles({})).toEqual([]);
    expect(parseCityTitles({ $pairs: [[[29], [29, 0, 1794392169]]] })).toEqual([{ titleId: 29, assignedAt: 1794392169, eventId: 0 }]);
    expect(parseCityTitles(undefined)).toBeNull();
    expect(parseCityTitles([])).toBeNull();
  });

  it('parseCityRecord carries the titles', () => {
    const rec: Wire[] = new Array(36).fill(null);
    rec[0] = [4599909974049];
    rec[1] = [[4599909974049]];
    rec[21] = { 29: [29, 0, 1794392169], 161: [161, 0, 1794925727] };
    const city = parseCityRecord(frame(601, [[[[rec], []]]]));
    expect(city?.titles?.map((t) => t.titleId)).toEqual([29, 161]);
  });
});

// A miniature of T29: Prefect (Loyalty Bonus, 7 days), Great Marshal (Premium,
// no set end) and a test row with no English name.
const strings: Wire[] = [
  'titles.title_name.loyalty_bonus', // 0
  'titles.description.loyalty_bonus_new', // 1
  '{"bigIcon":"perfect_50","mobileIcon":"bonus_perfect_72","rewardIcon":"bonus_perfect_72","smallIcon":"perfect_28"}', // 2
  'titles.title_source.loyalty_bonus', // 3
  'titles.title_name.n0061', // 4
  'titles.description.n0061', // 5
  '{"bigIcon":"titul_throne_50","rewardIcon":"bonus_great_marshal_72","smallIcon":"titul_great_marshal_28"}', // 6
  'test_pvp_a', // 7
];
const vectors: Wire[] = [[0], [1], [3], [4], [5], [7]];
const en = new Map([
  ['titles.title_name.loyalty_bonus', 'Prefect'],
  ['titles.description.loyalty_bonus_new', '+50% to Valor, Conquest, and Experience point gain.\\nThe title is active for 7 days after being acquired.'],
  ['titles.title_source.loyalty_bonus', 'Received from the Loyalty Bonus'],
  ['titles.title_name.n0061', 'Great Marshal'],
  ['titles.description.n0061', '+5 help from allies for troop training.\\n  +25% to army strength.\\n\\n'],
]);
const T29: Record<string, Wire> = {
  29: [29, 0, 1, 2, 5618, 1, 0, 604800, 0, 0, 0, 0, 2, 0, 0],
  161: [161, 3, 4, 6, 5603, 1, 0, 0, 0, 0, 0, 0, -1, 0, 0],
  302: [302, 5, 1, 2, 131, 1, 0, 2419200, 0, 0, 0, 0, 2, 0, 0],
};

describe('the titles table (T29)', () => {
  const str = (ref: Wire) => (typeof ref === 'number' && typeof strings[ref] === 'string' ? (strings[ref] as string) : undefined);
  const vec = (ref: Wire) => (typeof ref === 'number' && Array.isArray(vectors[ref]) ? (vectors[ref] as Wire[]) : undefined);

  it('keeps the bonus text line by line, as the game breaks it', () => {
    expect(textLines([5], str, new Map([['titles.description.n0061', ' a  b\\n\\n c ']]))).toBe('a b\nc');
    expect(textLines(undefined, str, en)).toBe('');
  });

  it('builds name, bonus text, source, duration and both icons; rows without English are test rows', () => {
    expect(buildTitles(T29, str, vec, en)).toEqual({
      29: {
        name: 'Prefect',
        description: '+50% to Valor, Conquest, and Experience point gain.\nThe title is active for 7 days after being acquired.',
        source: 'Received from the Loyalty Bonus',
        seconds: 604800,
        icon: 'perfect_28',
        art: 'bonus_perfect_72',
      },
      // No mobileIcon: the reward icon is the picture. No set end, no source.
      161: {
        name: 'Great Marshal',
        description: '+5 help from allies for troop training.\n+25% to army strength.',
        source: '',
        seconds: 0,
        icon: 'titul_great_marshal_28',
        art: 'bonus_great_marshal_72',
      },
    });
  });

  it('is part of names.json from format 11', () => {
    expect(NAMES_FORMAT).toBeGreaterThanOrEqual(11);
    const n = buildNames('v1', strings, vectors, new Map([[TABLE_TITLES, T29]]), en);
    expect(n.titles?.['29']?.name).toBe('Prefect');
  });
});

describe('titleViews', () => {
  const names = { titles: buildTitles(T29, (r) => (typeof r === 'number' ? (strings[r] as string) : undefined), (r) => (typeof r === 'number' ? (vectors[r] as Wire[]) : undefined), en) };
  const urls = { icon: (id: number) => `/game-art/v/${id}_28.png`, art: (id: number) => (id === 29 ? '/game-art/v/bonus_perfect_72.png' : null) };
  const now = 1794941290; // 2026-11-17T18:48:10Z

  it('shows the titles still running, newest received first, with their end and icons', () => {
    const v = titleViews(names, [
      { titleId: 29, assignedAt: 1794392169, firstSeen: '2026-11-16T04:25:52.395Z', times: 2 },
      { titleId: 161, assignedAt: 1794840304, firstSeen: '2026-11-16T04:25:52.395Z', times: 190 },
      // Prefect from three weeks ago ran out: never shown, even if no read said so.
      { titleId: 29, assignedAt: 1793000000, firstSeen: '2026-10-26T00:00:00.000Z' },
      { titleId: 999, assignedAt: 1794900000, firstSeen: '2026-11-17T08:00:00.000Z' },
    ], now, urls);
    expect(v.map((t) => [t.titleId, t.name, t.endsAt])).toEqual([
      [999, '#999', null],
      [161, 'Great Marshal', null],
      [29, 'Prefect', '2026-11-18T10:16:09.000Z'],
    ]);
    expect(v[2]).toMatchObject({
      receivedAt: '2026-11-11T10:16:09.000Z',
      seconds: 604800,
      source: 'Received from the Loyalty Bonus',
      times: 2,
      iconUrl: '/game-art/v/29_28.png',
      artUrl: '/game-art/v/bonus_perfect_72.png',
    });
    expect(v[1].times).toBe(190);
    expect(v[0].times).toBeNull();
  });

  it('works without the static data', () => {
    expect(titleViews(null, [{ titleId: 29, assignedAt: 1794392169, firstSeen: 'x' }], now, urls)[0]).toMatchObject({ name: '#29', endsAt: null });
  });
});
