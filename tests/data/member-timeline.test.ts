/**
 * The member timeline (data/member-timeline.ts): one list from every history
 * source, newest first. The first read of a source is the baseline and never
 * a change; a day's research / talents / captains / gear fold into one entry;
 * paging is by cursor, so entries added at the top never shift older pages.
 */
import { describe, expect, it } from 'vitest';
import { buildTimeline, pageTimeline, timelineCursor, type TimelineLookups, type TimelineSources } from '../../src/data/member-timeline.js';

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
};

const empty = (): TimelineSources => ({
  joinedAt: null, playerHistory: [], audit: [], techChanges: [], tierChanges: [], captainChanges: [],
  artifactChanges: [], equipmentChanges: [], cityStatus: [], mightDays: [], dragonDays: [],
});

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
    src.joinedAt = 1_790_000_000;
    src.audit = [
      { at: '2026-11-17T01:52:48Z', action: 'merge_player', details: { from: 'Нимдуен', to: 'Nimduen', clanId: 2 } },
      { at: '2026-11-17T02:07:06Z', action: 'rename_member', details: { id: 1300, from: 'Nimduen', newName: 'Нимдуен', source: 'game' } },
      { at: '2026-11-17T03:00:00Z', action: 'rename_member', details: { id: '1300', newName: 'Nimduen' } },
      { at: '2026-11-17T04:00:00Z', action: 'member.left_clan', details: { id: 1300 } },
    ];
    const t = buildTimeline(src, look, 17);
    expect(t.map((e) => e.kind)).toEqual(['left', 'renamed', 'merged', 'joined']);
    expect(t.find((e) => e.kind === 'renamed')).toMatchObject({ by: 'admin', to: 'Nimduen' });
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
