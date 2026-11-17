/**
 * The member timeline (data/member-timeline.ts): one list from every history
 * source, newest first. The first read of a source is the baseline and never
 * a change; a day's research / talents / captains / gear fold into one entry;
 * paging is by cursor, so entries added at the top never shift older pages.
 */
import { describe, expect, it } from 'vitest';
import {
  buildTimeline, isScreenshotSpelling, pageTimeline, timelineCursor,
  type TimelineLookups, type TimelineSources, type TimelineTitleInfo,
} from '../../src/data/member-timeline.js';
import { buildRosterChanges, type RosterMember, type RosterSources } from '../../src/data/roster-changes.js';

const PREMIUM = 'Can be obtained by activating Premium.';
/** T29 as prod's names.json has it (Nov 2026), the ids these tests use. */
const TITLES: Record<number, Omit<TimelineTitleInfo, 'iconUrl'>> = {
  29: { name: 'Prefect', seconds: 604_800, source: 'Received from the Loyalty Bonus' },
  137: { name: 'Healer', seconds: 604_800, source: 'Can be obtained from the Blessing of the Gods tournament.' },
  160: { name: 'Great Archaeologist', seconds: 0, source: PREMIUM },
  161: { name: 'Great Marshal', seconds: 0, source: PREMIUM },
  162: { name: 'Great Ruler', seconds: 0, source: PREMIUM },
  2: { name: 'Senator', seconds: 0, source: 'Can be obtained from the Clash for the Throne tournament.' },
};

const look: TimelineLookups = {
  techName: (id) => `Tech ${id}`,
  techIconUrl: () => null,
  techKind: (id) => (id >= 25000 ? 'talent' : 'research'),
  captainName: (id) => (id === 8 ? 'Carter' : `Captain ${id}`),
  captainIconUrl: () => null,
  artifactName: (t) => (t === 20 ? 'Chronoglyph' : `Artifact ${t}`),
  artifactIconUrl: () => null,
  itemName: (t) => `Item ${t}`,
  itemIconUrl: () => null,
  heroName: (id) => `Hero ${id}`,
  heroAvatarUrl: () => null,
  dragonIconUrl: (stage) => (stage === null ? null : `/art/icon_red_dragon_${stage}.png`),
  title: (id) => ({ ...(TITLES[id] ?? { name: `#${id}`, seconds: 0, source: '' }), iconUrl: `/art/title_${id}.png` }),
};

const empty = (): TimelineSources => ({
  moves: [], playerHistory: [], audit: [], titles: [], techChanges: [], tierChanges: [], captainChanges: [],
  artifactChanges: [], equipmentChanges: [], cityStatus: [], mightDays: [], dragonDays: [],
});

const member = (id: number, name: string, over: Partial<RosterMember> = {}): RosterMember => ({
  id, name, normalizedName: name.toLowerCase(), aliases: [], firstSeen: '2026-12-01T00:00:00Z', lastSeen: '2026-11-17T00:00:00Z',
  isActive: true, leftAt: null, ...over,
});

/** One member's moves, the way the timeline repo takes them from the clan's list. */
const movesOf = (memberId: number, roster: RosterSources) => buildRosterChanges(roster, 17).filter((m) => m.memberId === memberId);

const ph = (at: string, over: Partial<TimelineSources['playerHistory'][number]> = {}) => ({
  at, name: 'taulen302', heroLevel: 210, cityLevel: 44, vip: 17, goldPass: 0, heroAvatar: 9, role: 4, ...over,
});

describe('member timeline', () => {
  it('leaves each source\'s first read out: it is the baseline, not a change', () => {
    const src = empty();
    // The first player-history row differs from nothing and must not show.
    src.playerHistory = [ph('2026-11-16T10:00:00Z', { heroLevel: 200 }), ph('2026-11-17T10:00:00Z', { heroLevel: 211, role: 3 })];
    src.cityStatus = [
      { at: '2026-11-17T08:00:00Z', shielded: 1, burning: 0 },
      { at: '2026-11-17T12:00:00Z', shielded: 0, burning: 1 },
    ];
    const kinds = buildTimeline(src, look, 17).map((e) => e.kind).sort();
    expect(kinds).toEqual(['burning', 'hero_level', 'rank', 'shield']);
    const t = buildTimeline(src, look, 17);
    expect(t.find((e) => e.kind === 'hero_level')).toMatchObject({ from: 200, to: 211 });
    expect(t.find((e) => e.kind === 'rank')).toMatchObject({ from: 4, to: 3, promoted: true });
    expect(t.find((e) => e.kind === 'shield')).toMatchObject({ on: false });
    expect(t.find((e) => e.kind === 'burning')).toMatchObject({ on: true });
  });

  it('folds a game day\'s research into one entry, talents apart, and keys days by the 17:00 UTC rollover', () => {
    const src = empty();
    src.techChanges = [
      { at: '2026-11-17T10:00:00Z', techId: 1001, level: 5, prevLevel: 4 },
      { at: '2026-11-17T12:00:00Z', techId: 1002, level: 1, prevLevel: null },
      { at: '2026-11-17T12:00:00Z', techId: 25001, level: 3, prevLevel: 2 },
      // After 17:00 UTC: the next game day.
      { at: '2026-11-17T18:00:00Z', techId: 1001, level: 6, prevLevel: 5 },
    ];
    const t = buildTimeline(src, look, 17);
    const research = t.filter((e) => e.kind === 'research');
    expect(research.map((e) => [e.day, (e.items as unknown[]).length])).toEqual([['2026-11-17', 1], ['2026-11-16', 2]]);
    // A folded entry is dated by its latest read.
    expect(research[1].at).toBe('2026-11-17T12:00:00Z');
    expect(t.filter((e) => e.kind === 'talents')).toHaveLength(1);
  });

  it('keeps only big might moves, labels a first-seen artifact as into the line-up, and names gear changes', () => {
    const src = empty();
    src.mightDays = [
      { day: '2026-11-14', at: '2026-11-14T20:00:00Z', might: 100_000_000 },
      { day: '2026-11-15', at: '2026-11-15T20:00:00Z', might: 104_000_000 }, // +4 %: not news
      { day: '2026-11-16', at: '2026-11-16T20:00:00Z', might: 120_000_000 }, // +15 %
    ];
    src.artifactChanges = [
      { changedAt: '2026-11-17T12:57:16Z', artifactType: 20, level: 43, star: 21, prevLevel: null, prevStar: null, rerolled: false },
      { changedAt: '2026-11-17T12:57:16Z', artifactType: 16, level: 41, star: 19, prevLevel: 40, prevStar: 19, rerolled: false },
    ];
    src.equipmentChanges = [
      { changedAt: '2026-11-17T12:57:16Z', captainId: 19, position: 3, itemType: 4239, prevType: null, reworked: false },
      { changedAt: '2026-11-17T12:57:16Z', captainId: 8, position: 4, itemType: 0, prevType: 4223, reworked: false },
      { changedAt: '2026-11-17T12:57:16Z', captainId: 1, position: 5, itemType: 4246, prevType: 4246, reworked: true },
    ];
    const t = buildTimeline(src, look, 17);
    expect(t.filter((e) => e.kind === 'might')).toEqual([expect.objectContaining({ from: 104_000_000, to: 120_000_000 })]);
    const arts = t.filter((e) => e.kind === 'artifact');
    expect(arts.find((a) => a.artifactType === 20)).toMatchObject({ name: 'Chronoglyph', intoLineup: true });
    expect(arts.find((a) => a.artifactType === 16)).toMatchObject({ intoLineup: false, prevLevel: 40, level: 41 });
    const gear = t.find((e) => e.kind === 'gear')!;
    expect((gear.items as Array<Record<string, unknown>>).map((i) => [i.captainName, i.change])).toEqual([
      [`Captain 19`, 'put_on'], ['Carter', 'taken_off'], [null, 'reworked'],
    ]);
  });

  it('shows the dragon levelling and evolving day by day: the first read is the baseline, a day without a read is a gap', () => {
    const src = empty();
    src.dragonDays = [
      // The baseline (an old read: no stage parsed yet).
      { day: '2026-11-14', at: '2026-11-14T20:00:00Z', level: 236, stage: null },
      { day: '2026-11-15', at: '2026-11-15T20:00:00Z', level: 236, stage: 5 }, // stage first seen: no entry
      { day: '2026-11-16', at: '2026-11-16T20:00:00Z', level: null, stage: null }, // no dragon read that day
      { day: '2026-11-17', at: '2026-11-17T20:00:00Z', level: 237, stage: 6 },
      { day: '2026-11-18', at: '2026-11-18T20:00:00Z', level: 237, stage: 6 },
    ];
    const t = buildTimeline(src, look, 17);
    expect(t.filter((e) => e.kind === 'dragon')).toEqual([expect.objectContaining({
      group: 'growth', day: '2026-11-17', at: '2026-11-17T20:00:00Z',
      from: 236, to: 237, stageFrom: 5, stageTo: 6, iconUrl: '/art/icon_red_dragon_6.png',
    })]);

    // A level-up alone carries no evolution fields (and the reverse).
    src.dragonDays = [
      { day: '2026-11-14', at: '2026-11-14T20:00:00Z', level: 100, stage: 3 },
      { day: '2026-11-15', at: '2026-11-15T20:00:00Z', level: 100, stage: 4 },
      { day: '2026-11-16', at: '2026-11-16T20:00:00Z', level: 104, stage: 4 },
    ];
    const [up, evolved] = buildTimeline(src, look, 17).filter((e) => e.kind === 'dragon');
    expect(up).toMatchObject({ from: 100, to: 104 });
    expect(up).not.toHaveProperty('stageTo');
    expect(evolved).toMatchObject({ stageFrom: 3, stageTo: 4 });
    expect(evolved).not.toHaveProperty('to');
  });

  it('shows the admin\'s manual renames and merges into the member, not the sync\'s own renames', () => {
    const src = empty();
    src.moves = movesOf(1300, {
      members: [member(1300, 'Nimduen')],
      players: [{ playerId: 77, name: 'Нимдуен', joinedAt: 1_790_000_000, inClan: false, memberId: 1300, linked: true }],
      audit: [{ at: '2026-11-17T04:00:00Z', action: 'member.left_clan', details: { id: 1300, name: 'Nimduen', source: 'game', linked: true } }],
    });
    src.audit = [
      { at: '2026-11-17T01:52:48Z', action: 'merge_player', details: { from: 'Нимдуен', to: 'Nimduen', clanId: 2 } },
      { at: '2026-11-17T02:07:06Z', action: 'rename_member', details: { id: 1300, from: 'Nimduen', newName: 'Нимдуен', source: 'game' } },
      { at: '2026-11-17T03:00:00Z', action: 'rename_member', details: { id: '1300', newName: 'Nimduen' } },
    ];
    const t = buildTimeline(src, look, 17);
    expect(t.map((e) => e.kind)).toEqual(['left', 'renamed', 'merged', 'joined']);
    expect(t.find((e) => e.kind === 'renamed')).toMatchObject({ by: 'admin', to: 'Nimduen' });
    expect(t.find((e) => e.kind === 'left')).toMatchObject({ site: false });
  });

  it('takes joined / came back / left from the clan\'s Joins & leaves, so the two views agree', () => {
    const roster = {
      members: [
        member(1, 'Nightfrog', { firstSeen: '2026-08-23T17:35:33Z' }),
        member(2, 'Ghost', { isActive: false, leftAt: '2026-10-25T17:20:30Z' }),
      ],
      players: [{ playerId: 9, name: 'Nightfrog', joinedAt: Date.parse('2026-11-17T17:15:08Z') / 1000, inClan: true, memberId: 1, linked: true }],
      audit: [],
    };
    const src = empty();
    src.moves = movesOf(1, roster);
    expect(buildTimeline(src, look, 17)).toEqual([
      expect.objectContaining({ kind: 'joined', returned: true, seenSince: '2026-08-23T17:35:33Z', prevLeftAt: null }),
    ]);
    src.moves = movesOf(2, roster);
    expect(buildTimeline(src, look, 17)).toEqual([expect.objectContaining({ kind: 'left', site: true, at: '2026-10-25T17:20:30Z' })]);
  });

  it('pages by cursor: stable when newer entries appear, filtered by group', () => {
    const src = empty();
    src.cityStatus = [{ at: '2026-11-01T00:00:00Z', shielded: 1, burning: 0 }];
    for (let d = 2; d <= 9; d++) src.cityStatus.push({ at: `2026-11-0${d}T00:00:00Z`, shielded: d % 2, burning: 0 });
    const all = buildTimeline(src, look, 17);
    expect(all).toHaveLength(8);
    const p1 = pageTimeline(all, { limit: 3 });
    expect(p1.entries.map((e) => e.at.slice(8, 10))).toEqual(['09', '08', '07']);
    expect(p1.total).toBe(8);
    // A newer entry arrives; the next page still continues after p1's last.
    src.cityStatus.push({ at: '2026-11-10T00:00:00Z', shielded: 0, burning: 1 });
    const later = buildTimeline(src, look, 17);
    const p2 = pageTimeline(later, { before: p1.next, limit: 3 });
    expect(p2.entries.map((e) => e.at.slice(8, 10))).toEqual(['06', '05', '04']);
    const last = pageTimeline(later, { before: timelineCursor(p2.entries[2]), limit: 10 });
    expect(last.entries.map((e) => e.at.slice(8, 10))).toEqual(['03', '02']);
    expect(last.next).toBeNull();
    // Groups: every entry here is the city's; none is the clan's.
    expect(pageTimeline(later, { groups: new Set(['clan']), limit: 10 }).entries).toEqual([]);
    expect(pageTimeline(later, { groups: new Set(['city']), limit: 100 }).total).toBe(10);
  });
});

const unix = (iso: string) => Date.parse(iso) / 1000;
const grant = (titleId: number, assigned: string, firstSeen: string, goneAt: string | null = null) =>
  ({ titleId, assignedAt: unix(assigned), firstSeen, goneAt });
type Item = { titleId: number; name: string; change: string; at: string; iconUrl: string | null };
const titleDays = (src: TimelineSources, nowIso: string) =>
  buildTimeline(src, look, 17, Date.parse(nowIso)).filter((e) => e.kind === 'titles').reverse()
    .map((e) => [e.day, (e.items as Item[]).map((i) => `${i.name} ${i.change} ${i.at.slice(5, 16)}`)]);

describe('member timeline: titles', () => {
  it('says when a timed title was received (the game\'s own time), received again, ran out or was taken; a running one has no end', () => {
    const src = empty();
    src.titles = [
      // Prefect: ran out after its 7 days, the next claimed 20 minutes later.
      grant(29, '2026-11-01T10:00:00Z', '2026-11-02T04:00:00Z', '2026-11-08T10:34:00Z'),
      grant(29, '2026-11-08T10:20:00Z', '2026-11-08T10:34:00Z'),
      // Healer won again before the first ran out: "again", no end in between.
      grant(137, '2026-11-10T00:30:00Z', '2026-11-10T01:00:00Z', '2026-11-11T20:34:00Z'),
      grant(137, '2026-11-11T20:00:00Z', '2026-11-11T20:34:00Z'),
      // A Healer gone well before its end: taken, dated by the read without it.
      grant(137, '2026-10-01T00:30:00Z', '2026-10-01T01:00:00Z', '2026-10-03T08:00:00Z'),
      // Read a few minutes early by our clock: still "ran out" at the game's end.
      grant(29, '2026-10-20T10:00:00Z', '2026-10-20T11:00:00Z', '2026-10-27T09:58:00Z'),
    ];
    expect(titleDays(src, '2026-11-12T12:00:00Z')).toEqual([
      ['2026-09-30', ['Healer received 10-01T00:30']],
      ['2026-10-02', ['Healer gone 10-03T08:00']],
      ['2026-10-19', ['Prefect received 10-20T10:00']],
      ['2026-10-26', ['Prefect ran_out 10-27T10:00']],
      ['2026-10-31', ['Prefect received 11-01T10:00']],
      // One game day: the old one ran out, the new one came — one entry.
      ['2026-11-07', ['Prefect ran_out 11-08T10:00', 'Prefect received 11-08T10:20']],
      ['2026-11-09', ['Healer received 11-10T00:30']],
      ['2026-11-11', ['Healer again 11-11T20:00']],
      // Prefect (ends 11-15) and the second Healer (11-18) still run: no end.
    ]);
    const t = buildTimeline(src, look, 17, Date.parse('2026-11-12T12:00:00Z'));
    const day = t.find((e) => e.kind === 'titles' && e.day === '2026-11-07')!;
    expect(day).toMatchObject({ group: 'titles', at: '2026-11-08T10:20:00.000Z' });
    expect((day.items as Item[])[1]).toMatchObject({ titleId: 29, iconUrl: '/art/title_29.png' });
    // Later, both have run out.
    expect(titleDays(src, '2026-11-20T00:00:00Z').slice(-2)).toEqual([
      ['2026-11-14', ['Prefect ran_out 11-15T10:20']],
      ['2026-11-18', ['Healer ran_out 11-18T20:00']],
    ]);
  });

  it('counts Premium\'s three as one holding by the reads: re-grants and switches are not news, the end is the first read with none', () => {
    const src = empty();
    // Prod, Nov 17 2026: the game re-grants and swaps these every hour or two.
    src.titles = [
      grant(162, '2026-11-17T15:16:41Z', '2026-11-17T16:19:04Z', '2026-11-17T18:34:28Z'),
      grant(161, '2026-11-17T18:10:31Z', '2026-11-17T18:34:28Z', '2026-11-17T19:34:53Z'),
      grant(162, '2026-11-17T19:25:10Z', '2026-11-17T19:34:39Z', '2026-11-17T20:34:56Z'),
      grant(162, '2026-11-17T20:27:22Z', '2026-11-17T20:34:56Z'),
    ];
    expect(titleDays(src, '2026-11-17T21:00:00Z')).toEqual([['2026-11-16', ['Great Ruler received 11-17T15:16']]]);

    // Premium lapsed: gone at the first read with none of the three, named by the last held.
    src.titles[3].goneAt = '2026-11-18T09:00:00Z';
    // A Premium title back after a read without any: a new holding.
    src.titles.push(grant(160, '2026-11-18T09:30:00Z', '2026-11-18T10:00:00Z'));
    // A title of another source is its own holding (Senator, no set end).
    src.titles.push(grant(2, '2026-11-05T12:00:00Z', '2026-11-17T16:19:04Z', '2026-11-18T09:00:00Z'));
    expect(titleDays(src, '2026-11-18T12:00:00Z')).toEqual([
      ['2026-11-04', ['Senator received 11-05T12:00']],
      ['2026-11-16', ['Great Ruler received 11-17T15:16']],
      ['2026-11-17', ['Great Ruler gone 11-18T09:00', 'Senator gone 11-18T09:00', 'Great Archaeologist received 11-18T09:30']],
    ]);
  });
});

describe('member timeline: screenshot-era spellings', () => {
  const known = { gameNames: new Set(['Нимдуен', 'FELI']), typedNames: new Set(['Tigger K260 SK']) };

  it('calls a merged-in name a screenshot-era spelling only when neither the game nor a person ever gave it', () => {
    expect(isScreenshotSpelling('lg 5 5S pw', known)).toBe(true);
    expect(isScreenshotSpelling('Mκam from Chaos', known)).toBe(true);
    // The game's own spelling folded into the site's member: a real merge.
    expect(isScreenshotSpelling('Нимдуен', known)).toBe(false);
    // An admin's manual rename is a person's name, never the reader's.
    expect(isScreenshotSpelling('Tigger K260 SK', known)).toBe(false);
    // Exact: the reader's lower-case "Feli" is not the game's "FELI".
    expect(isScreenshotSpelling('Feli', known)).toBe(true);
  });

  it('tags those merges and folds each run of them (nothing else between) into one entry, every spelling kept with its dates', () => {
    const src = empty();
    const merge = (at: string, from: string) => ({
      at, action: 'merge_player', details: { from, to: 'أوزيريس', clanId: 1 }, screenshotSpelling: isScreenshotSpelling(from, known),
    });
    src.audit = [
      merge('2026-04-28T16:42:02.908Z', 'lg 5 5S pw'),
      merge('2026-04-29T03:27:04.071Z', 'lo;u8 Sw'),
      merge('2026-04-29T03:27:14.452Z', 'lg'),
      // The game's own spelling: a real merge, and it splits the runs.
      merge('2026-04-29T03:27:22.079Z', 'Нимдуен'),
      merge('2026-04-30T08:05:34.470Z', 'lg'),
      merge('2026-05-01T11:10:58.131Z', 'lg 5'),
      merge('2026-05-02T09:27:00.000Z', 'lg'),
    ];
    // A big might move between two merges splits a run too.
    src.mightDays = [
      { day: '2026-05-03', at: '2026-05-03T20:00:00.000Z', might: 100 },
      { day: '2026-05-04', at: '2026-05-04T20:00:00.000Z', might: 150 },
    ];
    src.audit.push(merge('2026-05-09T18:31:00.000Z', 'lo 388 uw'));
    const t = buildTimeline(src, look, 17);
    expect(t.map((e) => [e.kind, e.day, e.ocr, e.kind === 'merged' ? e.items ?? e.from : null])).toEqual([
      // A run of one: still the folded shape, the page shows it as one line.
      ['merged', '2026-05-09', true, [{ name: 'lo 388 uw', ats: ['2026-05-09T18:31:00.000Z'] }]],
      ['might', '2026-05-04', undefined, null],
      ['merged', '2026-05-01', true, [
        { name: 'lg', ats: ['2026-04-30T08:05:34.470Z', '2026-05-02T09:27:00.000Z'] },
        { name: 'lg 5', ats: ['2026-05-01T11:10:58.131Z'] },
      ]],
      ['merged', '2026-04-28', false, 'Нимдуен'],
      ['merged', '2026-04-28', true, [
        { name: 'lg 5 5S pw', ats: ['2026-04-28T16:42:02.908Z'] },
        { name: 'lo;u8 Sw', ats: ['2026-04-29T03:27:04.071Z'] },
        { name: 'lg', ats: ['2026-04-29T03:27:14.452Z'] },
      ]],
    ]);
    expect(t.filter((e) => e.kind === 'merged').every((e) => e.group === 'clan')).toBe(true);
    // Dated by the run's newest merge; keyed by its oldest, so keys stay unique.
    expect(t[2]).toMatchObject({ at: '2026-05-02T09:27:00.000Z', key: 'merged:ocr:2026-04-30T08:05:34.470Z' });
    expect(new Set(t.map((e) => e.key)).size).toBe(t.length);
  });
});
