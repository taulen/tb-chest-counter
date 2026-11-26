// The patch notes' diffs (src/game-patch/notes-diff.ts): what a game patch
// added, revealed, renamed and changed, from two versions of the game's
// files. Shapes follow the real names.json / art slice / tech-trees.json /
// translation CSVs (Nov 25 2026 patch); names and values are made up.

import { describe, expect, it } from 'vitest';
import {
  artNamesByStem,
  artStem,
  artTextKeys,
  assembleTexts,
  diffArtNames,
  diffSections,
  diffTrees,
  normalizeValue,
  planKeys,
  planTexts,
  summarizeNotes,
  textGroupKey,
  techsShownByTrees,
  type NoteLang,
  type PatchNotes,
  type TreeSnapshot,
} from '../../src/game-patch/notes-diff.js';
import { sectionDef, type SectionCtx } from '../../src/game-patch/notes-sections.js';

const ctx: SectionCtx = {
  mappings: { captains: { 34: 'boudica_icon' }, captainTile: { backs: { 3: 'back_gold' }, frames: { 3: 'frame_gold' } } },
  itemIcons: new Map([['17146', 'colosseum_blueprint']]),
  techIcons: new Map(),
};

describe('sections', () => {
  it('lists added entries, a renamed one, and leaves an untouched one out', () => {
    const prev = { gifts: { 2080: { chest: "Koschei's Chest", source: 'Epic squad' }, 1: { chest: 'Wooden Chest', source: '' } } };
    const next = {
      gifts: {
        2080: { chest: "Wyrm's Chest", source: 'Epic squad' },
        1: { chest: 'Wooden Chest', source: '' },
        17146: { chest: 'Colosseum Blueprint', source: '' },
      },
      items: { 17146: { kind: 1 } },
    };
    const [gifts] = diffSections(prev, next, 'names', ctx);
    expect(gifts.key).toBe('gifts');
    expect(gifts.entries.map((e) => [e.kind, e.name, e.was ?? null])).toEqual([
      ['added', 'Colosseum Blueprint', null],
      ['renamed', "Wyrm's Chest", "Koschei's Chest"],
    ]);
    expect(gifts.entries[0].icon).toEqual(['colosseum_blueprint']);
  });

  it('calls a placeholder given its real name "revealed": several ids under one name before', () => {
    const cap = (name: string, icon: string) => ({ name, rarity: 3, rarityName: 'Legendary Captain', icon, art: `lvlup_${icon}`, stars: {} });
    const prev = { captains: { 32: cap('Artemisia', 'artemisia_icon'), 34: cap('Artemisia', 'artemisia_icon'), 35: cap('Artemisia', 'artemisia_icon') } };
    const next = { captains: { 32: cap('Artemisia', 'artemisia_icon'), 34: cap('Boudica', 'boudica_icon'), 35: cap('Hannibal Barca', 'hannibal_barca_icon') } };
    const [captains] = diffSections(prev, next, 'names', ctx);
    expect(captains.entries.map((e) => [e.kind, e.name])).toEqual([['revealed', 'Boudica'], ['revealed', 'Hannibal Barca']]);
    // The art mapping first, the name's own sprite after; the rarity tile's back and frame.
    expect(captains.entries[0].icon).toEqual(['boudica_icon']);
    expect(captains.entries[0].layers).toEqual({ back: 'back_gold', frame: 'frame_gold' });
    expect(captains.entries[0].art).toContain('citizen_captain_boudica');
  });

  it('calls a blank or a text-key name "revealed" too', () => {
    const prev = { frames: { 10000101: { name: '', visual: 'xmas26_frame' } } };
    const next = { frames: { 10000101: { name: 'Winter Grandeur', visual: 'xmas26_frame' } } };
    expect(diffSections(prev, next, 'art', ctx)[0].entries[0]).toMatchObject({ kind: 'revealed', name: 'Winter Grandeur', icon: ['xmas26_frame'] });
    const prevG = { gifts: { 320022: { chest: 'item.name.mod_roulette_4_progress', source: '' }, 320023: { chest: 'item.name.mod_roulette_5_progress', source: '' } } };
    const nextG = { gifts: { 320022: { chest: "Corsair's Bazaar progress points", source: '' }, 320023: { chest: "Corsair's Bazaar progress points", source: '' } } };
    const [g] = diffSections(prevG, nextG, 'names', ctx);
    // One entry: revealed placeholders group by their new name.
    expect(g.entries).toHaveLength(1);
    expect(g.entries[0]).toMatchObject({ kind: 'revealed', ids: ['320022', '320023'] });
  });

  it('marks a name that is still a text key, and groups a monster\'s many map objects', () => {
    const next = { gifts: { 889121: { chest: 'item.name.clan_duel_point', source: '' } }, objects: { 9664: 'Kingdom Throne', 9665: 'Kingdom Throne', 9666: 'Wonder of the World' } };
    const prev = { gifts: {}, objects: {} };
    const sections = diffSections(prev, next, 'names', ctx);
    expect(sections.find((s) => s.key === 'gifts')!.entries[0]).toMatchObject({ unnamed: true });
    expect(sections.find((s) => s.key === 'objects')!.entries.map((e) => [e.name, e.ids?.length ?? 1])).toEqual([['Kingdom Throne', 2], ['Wonder of the World', 1]]);
  });

  it('ignores a value that only changed format ("+30%" → "+30,0%"), lists one that moved', () => {
    const cap = (v: string) => ({ name: 'Artemisia', rarity: 3, rarityName: 'Legendary Captain', icon: 'a', art: 'b', stars: { 2: [['Army strength', v]] } });
    expect(diffSections({ captains: { 32: cap('+30%') } }, { captains: { 32: cap('+30,0%') } }, 'names', ctx)).toEqual([]);
    const [s] = diffSections({ captains: { 32: cap('+30%') } }, { captains: { 32: cap('+35%') } }, 'names', ctx);
    expect(s.entries[0]).toMatchObject({ kind: 'changed', changes: [{ at: '★2', text: 'Army strength', was: '+30%', now: '+35%' }] });
  });

  it('lists a value that moved before a line that came or went, and counts what it cuts', () => {
    const lv = (n: number, text: string, value: string) => [n, [[text, value]]];
    const art = (levels: Record<string, unknown>) => ({ name: 'Celestial Scales', rarity: 5, rarityName: 'Legendary', icon: 'x', maxLevel: 60, maxStar: 25, levels, stars: {} });
    const prevLevels: Record<string, unknown> = {};
    const nextLevels: Record<string, unknown> = {};
    for (let i = 1; i <= 20; i++) {
      prevLevels[`1${i}`] = lv(i, 'Research speed', `+${i}%`);
      nextLevels[`1${i}`] = lv(i, 'Army strength', `+${i}%`);
    }
    prevLevels['199'] = lv(60, 'Experience', '+20%');
    nextLevels['199'] = lv(60, 'Experience', '+25%');
    const [s] = diffSections({ artifacts: { 27: art(prevLevels) } }, { artifacts: { 27: art(nextLevels) } }, 'names', ctx);
    const e = s.entries[0];
    expect(e.changes![0]).toEqual({ at: 'Lv 60', text: 'Experience', was: '+20%', now: '+25%' });
    expect(e.changes![1].was).toBeNull(); // then what it gained
    expect(e.changes).toHaveLength(12);
    expect(e.moreChanges).toBe(41 - 12);
  });

  it('shows a kind of data it has no entry for, named as well as the value allows', () => {
    const prev = { spells: { 1: { name: 'Fireball' } } };
    const next = { spells: { 1: { name: 'Fireball' }, 2: { name: 'Ice Storm', icon: 'Ice_Storm_72' } } };
    const [s] = diffSections(prev, next, 'names', ctx);
    expect(s).toMatchObject({ key: 'spells', entries: [{ kind: 'added', name: 'Ice Storm', icon: ['ice_storm_72'] }] });
    expect(sectionDef('names', 'spells').key).toBe('spells');
  });

  it("lists one whole object that moved (the Dragon's) as one change", () => {
    const [s] = diffSections({ dragon: { name: 'Dragon', xp: [0, 10] } }, { dragon: { name: 'Dragon', xp: [0, 12] } }, 'names', ctx);
    expect(s.entries).toEqual([{ id: 'dragon', kind: 'changed', name: '', changes: [{ at: 'xp › 1', text: '', was: '10', now: '12' }] }]);
  });

  it('never lists bookkeeping, nor anything with no previous version to compare with', () => {
    expect(diffSections(null, { gifts: { 1: { chest: 'A' } } }, 'names', ctx)).toEqual([]);
    expect(diffSections({ version: 'a', builtAt: 'x' }, { version: 'b', builtAt: 'y' }, 'names', ctx)).toEqual([]);
    // A kind the old file didn't carry is not "everything new".
    expect(diffSections({}, { titles: { 1: { name: 'King' } } }, 'names', ctx)).toEqual([]);
  });

  it('leaves out ids another part shows (techs in a new tree)', () => {
    const [s] = diffSections({ techs: {} }, { techs: { 27000: { name: 'Scoutpost points', maxLevel: 10 }, 9: { name: 'Other', maxLevel: 1 } } }, 'names', ctx, new Map([['techs', new Set(['27000'])]]));
    expect(s.entries.map((e) => e.name)).toEqual(['Other']);
  });

  it('normalizes numbers, not words', () => {
    expect(normalizeValue('+30,0%')).toBe(normalizeValue('+30%'));
    expect(normalizeValue('+30,5%')).toBe('+30.5%');
    expect(normalizeValue('Level 2')).not.toBe(normalizeValue('Level 3'));
  });
});

describe('research trees', () => {
  const node = (techId: number, maxLevel = 10) => ({ techId, name: `T${techId}`, maxLevel, col: 1, row: 1 });
  const tree = (id: number, nodes: TreeSnapshot['nodes'], name = `Tree ${id}`): TreeSnapshot => ({ id, name, kind: 'clan', tab: 'Clan Duel', nodes });

  it('a new tree whole, a grown one with its new and raised nodes', () => {
    const prev = { trees: [tree(1, [node(100), node(101)])] };
    const next = { trees: [tree(1, [node(100, 15), node(101), node(102)]), tree(27, [node(27000), node(27001)])] };
    const notes = diffTrees(prev, next);
    expect(notes.map((n) => [n.kind, n.tree.id, n.newNodes, n.raised])).toEqual([
      ['added', 27, [27000, 27001], []],
      ['grown', 1, [102], [{ techId: 100, was: 10, now: 15 }]],
    ]);
    expect([...techsShownByTrees(notes)]).toEqual(['27000', '27001', '102']);
  });

  it('nothing without both versions', () => {
    expect(diffTrees(null, { trees: [tree(1, [node(1)])] })).toEqual([]);
  });

  it("counts a tree's research the game doesn't draw yet; old research an older file didn't list is not new", () => {
    const unplaced = (techId: number) => ({ techId, name: `T${techId}`, maxLevel: 10 });
    const prev = { trees: [tree(2, [node(1400)])] };
    const next = {
      trees: [
        { ...tree(2, [node(1400)]), unplaced: [unplaced(1300), unplaced(1441)] },
        { ...tree(28, [node(30088)]), unplaced: [unplaced(30000), unplaced(30001)] },
      ],
    };
    // 1300 is in the old patch's data (just never listed with the tree); 1441 is not.
    const notes = diffTrees(prev, next, new Set(['1400', '1300']));
    expect(notes.map((n) => [n.kind, n.tree.id, n.newNodes])).toEqual([
      ['added', 28, [30088, 30000, 30001]],
      ['grown', 2, [1441]],
    ]);
  });
});

describe('texts', () => {
  const prevEn = new Map([
    ['client.clan_duels.rating.title', 'RATING'],
    ['client.old_window.text', 'Gone soon'],
  ]);
  const nextEn = new Map([
    ['client.clan_duels.rating.title', 'RANKING'],
    ['client.new_temple.header.title', 'Temple'],
    ['client.new_temple.delete.btn_delete', 'Delete'],
    ['client.new_temple.info.q_troop_gone', 'Why has a unit disappeared from the Temple?'],
    ['client_config.value.help.windows.pvp_ladder_3v3.title', 'Ascendant Arena'],
    ['client_config.value.help.windows.pvp_ladder_3v3.description', 'General rules of the Ascendant Arena tournament'],
    ['client_config.value.help.windows.pvp_ladder_3v3.match_format.title', 'Match Format'],
    ['client_config.value.help.windows.pvp_ladder_3v3.match_format.description_np', 'Each match consists of three battles.'],
    ['client_config.value.help.windows.bbp_boudica.title', 'Boudica'],
    ['authority', 'Authority'],
  ]);

  it('groups by feature, finds its title, and turns a new help window into a guide', () => {
    const plan = planTexts(prevEn, nextEn);
    expect(plan.removed).toEqual(['client.old_window.text']);
    expect(plan.changed).toEqual(['client.clan_duels.rating.title']);
    expect([...plan.guides.keys()]).toEqual(['pvp_ladder_3v3']);
    expect(plan.groups.get('new_temple')).toMatchObject({ titleKey: 'client.new_temple.header.title' });
    // A window that only gained its title is a help text, not a guide.
    expect(plan.groups.get('help')!.added).toEqual(['client_config.value.help.windows.bbp_boudica.title']);
    expect(plan.groups.get('')!.added).toEqual(['authority']);

    const keys = planKeys(plan);
    expect(keys.prev).toEqual(new Set(['client.clan_duels.rating.title']));
    expect(keys.next.has('client.new_temple.header.title')).toBe(true);

    const next = new Map<NoteLang, Map<string, string>>([
      ['en', nextEn],
      ['de', new Map([['client.new_temple.delete.btn_delete', 'Löschen'], ['client.clan_duels.rating.title', 'RANGLISTE']])],
    ]);
    const prev = new Map<NoteLang, Map<string, string>>([['en', prevEn], ['de', new Map([['client.clan_duels.rating.title', 'WERTUNG']])]]);
    const { guides, texts } = assembleTexts(plan, next, prev);
    expect(guides).toEqual([{
      key: 'pvp_ladder_3v3',
      title: { en: 'Ascendant Arena' },
      parts: [
        { texts: [{ en: 'General rules of the Ascendant Arena tournament' }] },
        { title: { en: 'Match Format' }, texts: [{ en: 'Each match consists of three battles.' }] },
      ],
    }]);
    expect(texts[0]).toMatchObject({ key: 'new_temple', title: { en: 'Temple' } });
    expect(texts[0].added.find((x) => x.key.endsWith('btn_delete'))!.text).toEqual({ en: 'Delete', de: 'Löschen' });
    const duel = texts.find((g) => g.key === 'clan_duels')!;
    expect(duel.changed[0]).toEqual({ key: 'client.clan_duels.rating.title', text: { en: 'RANKING', de: 'RANGLISTE' }, was: { en: 'RATING', de: 'WERTUNG' } });
  });

  it('a group is the first segment past the namespaces', () => {
    expect(textGroupKey('client.new_temple.delete.title')).toBe('new_temple');
    expect(textGroupKey('global_tournament.client.value.prime_arena_3v3_op.banner_special_title')).toBe('prime_arena_3v3_op');
    expect(textGroupKey('tech.name.clan_duels_army_health_2')).toBe('tech');
    expect(textGroupKey('authority')).toBe('');
  });
});

describe('art', () => {
  it('stems strip sizes, icon, shard and walk-cycle suffixes', () => {
    expect(artStem('icon_xmas26_frame_72')).toBe('xmas26_frame');
    expect(artStem('monument_construction_speed_shard_28')).toBe('monument_construction_speed');
    expect(artStem('boudica_hero_left_down')).toBe('boudica');
    expect(artStem('banner_regular_battlepass_57_708x123_b')).toBe('banner_regular_battlepass_57');
  });

  it('groups what the catalogue added, leaving out what an entry already shows', () => {
    const groups = diffArtNames(
      ['old_thing'],
      ['old_thing', 'boudica_icon', 'boudica_hero_down', 'king_arthur_icon', 'king_arthur_shard_icon', 'xmas26_frame'],
      new Set(['boudica_icon']),
    );
    expect(groups).toEqual([
      { stem: 'king_arthur', names: ['king_arthur_icon', 'king_arthur_shard_icon'] },
      { stem: 'xmas26_frame', names: ['xmas26_frame'] },
    ]);
    expect(diffArtNames(null, ['a'], new Set())).toEqual([]);
  });

  it("finds the game's texts about a picture by every part of its name, names and descriptions first", () => {
    const en = new Map([
      ['customization.name.union_clan_city_57', 'Glaciaris'],
      ['customization.description.union_clan_city_57', 'Grants a permanent 10% bonus to allied army health.'],
      ['client.union_clan_city_57.window_hint', 'Hint'],
      ['customization.name.union_clan_city_56', 'Other'],
    ]);
    const keys = artTextKeys([{ stem: 'clan_city_customization_union_57', names: [] }, { stem: 'king_arthur', names: [] }, { stem: 'x', names: [] }], en);
    expect(keys.get('clan_city_customization_union_57')).toEqual([
      'customization.name.union_clan_city_57',
      'customization.description.union_clan_city_57',
    ]);
    // Nothing the game has written yet; a one-part stem says too little to match.
    expect(keys.has('king_arthur')).toBe(false);
    expect(keys.has('x')).toBe(false);
  });

  it("names a picture by whatever the art slice draws with it", () => {
    const slice = {
      items: [{ id: 1, name: 'Captain Selection Chest', icon: 'chest_with_choice_epic_chars_2' }],
      cityLooks: { 9: { name: 'Glaciaris', icons: { 1: 'Clan_City_57_Icon' } } },
    };
    const byStem = artNamesByStem(slice, (n) => n.toLowerCase());
    expect(byStem.get('chest_with_choice_epic_chars_2')).toEqual(['Captain Selection Chest']);
    expect(byStem.get('clan_city_57')).toEqual(['Glaciaris']);
  });
});

describe('summary', () => {
  it('counts every part and picks the headline names', () => {
    const n: PatchNotes = {
      format: 1, id: 'p', date: '2026-11-25T23:31:14.655Z', names: null, art: null,
      sections: [
        { key: 'events', source: 'names', entries: [{ id: '1038,1', kind: 'added', name: 'CLAN DUEL' }] },
        { key: 'captains', source: 'names', entries: [{ id: '34', kind: 'revealed', name: 'Boudica', was: 'Artemisia' }, { id: '9', kind: 'removed', name: 'Old' }] },
      ],
      trees: [{ kind: 'added', tree: { id: 27, name: 'Clan Duel', kind: 'clan', nodes: [] }, newNodes: [], raised: [] }],
      guides: [{ key: 'g', parts: [{ texts: [{ en: 'a' }, { en: 'b' }] }] }],
      texts: [{ key: 'x', added: [{ key: 'k', text: { en: 'v' } }], changed: [], removed: [] }],
      images: [{ stem: 's', names: ['s'] }],
    };
    expect(summarizeNotes(n)).toEqual({
      id: 'p',
      date: '2026-11-25T23:31:14.655Z',
      counts: { trees: 1, events: 1, captains: 1, guides: 1, texts: 3, images: 1 },
      highlights: [{ section: 'trees', name: 'Clan Duel' }, { section: 'events', name: 'CLAN DUEL' }, { section: 'captains', name: 'Boudica' }],
    });
  });
});
