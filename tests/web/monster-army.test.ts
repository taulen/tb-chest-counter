/**
 * Tools → Monsters' data side (lib/monster-army.js): battle-data.json as unit
 * definitions, the target list players pick from, troop levels, and what a
 * player's shared battles say — bonuses, the event bonus, the most of each
 * troop they sent. Made-up data in battle-data.json's shape.
 */
import { describe, expect, it } from 'vitest';
import {
  unitDefs, fieldableUnits, unitLevel, targetGroup, targetFamilies, targetOfReport,
  hasEventMonsters, withEventBonus, eventBonusFromReport, armyFromBattles,
  targetCommand, battleCommand, battlesLedFor,
} from '../../src/web/public/lib/monster-army.js';

const DATA = {
  units: {
    206: { name: 'Corax I', tier: 8, str: 61200, hp: 183600, tags: ['flying', 'guardsmen', 'human'], vs: [[['mounted'], 1333, 1]], icon: 'c', kind: 'guardsmen', lead: 20 },
    191: { name: 'Fire Phoenix I', tier: 8, str: 660000, hp: 1980000, tags: ['flying', 'elemental'], vs: [[['melee'], 701, 1]], icon: 'p', kind: 'monsters', dom: 54 },
    3079: { name: 'Slavic warrior', tier: 9, str: 11000, hp: 33000, tags: ['melee', 'guardsmen', 'human'], vs: [[['beast'], 2050, 1]], icon: 's', kind: 'mercenaries', auth: 1 },
    6033: { name: 'Bear', tier: 5, str: 22000, hp: 66000, tags: ['melee', 'beast'], vs: [[['mounted'], 70, 1]], icon: 'b' },
    7620: { name: 'Fenrir', tier: 10, str: 50, hp: 150, tags: ['melee', 'fenrirsquad', 'epicmonster'], vs: [], icon: 'f' },
  },
  targets: [
    { ids: [1531], name: 'Common Elf squad', level: 30, cls: 1, army: [[6033, 780000]] },
    { ids: [1530], name: 'Common Elf squad', level: 29, cls: 1, army: [[6033, 700000]] },
    { ids: [2936, 2937], name: 'Rare Elf squad', level: 45, cls: 2, army: [[6033, 640000]] },
    { ids: [4012], name: 'Epic Fenrir squad', level: 50, cls: 5, army: [[7620, 1447916675]] },
    { ids: [3001], name: 'Legendary Elf squad', level: 15, cls: 0, army: [[6033, 1]] },
    { ids: [1817], name: 'Elven Citadel', level: 30, cls: 4, army: [[6033, 12000]] },
    { ids: [1822], name: 'Сommon Pumpkin squad', level: 1, cls: 0, army: [[6033, 3]] },
    { ids: [9001], name: 'Grove Elder', level: 50, cls: 1, army: [[6033, 2], [6033, 3]] },
    { ids: [9002], name: 'Grove Elder', level: 50, cls: 1, army: [[6033, 9]] },
  ],
};
const defs = unitDefs(DATA);

describe('units', () => {
  it('keeps one object per unit, id as text, kind as its group', () => {
    expect(defs.get('206')).toMatchObject({ id: '206', unit: 206, name: 'Corax I', kind: 'guardsmen', group: 'guardsmen' });
    expect(defs.get('206')).toBe(defs.get('206'));
  });

  it('offers only what a player can send, by kind then strength', () => {
    expect(fieldableUnits(defs).map((d) => d.id)).toEqual(['206', '191', '3079']);
  });

  it('gates trained troops by level, never mercenaries', () => {
    expect(unitLevel(defs.get('206'))).toEqual(['g', 8]);
    expect(unitLevel(defs.get('191'))).toEqual(['m', 8]);
    expect(unitLevel(defs.get('3079'))).toBeNull();
  });
});

describe('targets', () => {
  it('groups by the game\'s class, and by name where the class says nothing', () => {
    expect(DATA.targets.map(targetGroup)).toEqual(['common', 'common', 'rare', 'epic', 'legendary', 'citadel', 'common', 'common', 'common']);
  });

  it('lists families by group and levels ascending, several armies at one level as versions', () => {
    const groups = targetFamilies(DATA);
    expect(groups.map((g) => g.group)).toEqual(['common', 'rare', 'legendary', 'epic', 'citadel']);
    const common = groups[0].families;
    expect(common.map((f) => f.name)).toEqual(['Common Elf squad', 'Grove Elder', 'Сommon Pumpkin squad']);
    expect(common[0].levels.map((l) => l.level)).toEqual([29, 30]);
    expect(common[1].levels[0].variants.map((v: { ids: number[] }) => v.ids[0])).toEqual([9001, 9002]);
  });

  it('finds a report\'s target by any of its ids', () => {
    expect(targetOfReport(DATA, 2937)?.name).toBe('Rare Elf squad');
    expect(targetOfReport(DATA, 1)).toBeNull();
    expect(targetOfReport(DATA, null)).toBeNull();
  });

  it('knows which targets have event monsters, and adds the army\'s extra to every troop', () => {
    expect(hasEventMonsters(DATA.targets[3], defs)).toBe(true);
    expect(hasEventMonsters(DATA.targets[0], defs)).toBe(false);
    expect(withEventBonus(defs.get('206'), 450).vs).toEqual([[['mounted'], 1333, 1], [['epicmonster'], 450, 1]]);
    expect(withEventBonus(defs.get('206'), 0)).toBe(defs.get('206'));
  });
});

describe('who leads', () => {
  it('reads a target\'s rule and a battle\'s march the same way, and keeps the battles that match', () => {
    const rare = { hero: true, captains: 0 };
    const common = { hero: false, captains: 1 };
    const heroic = { hero: true, captains: 3 };
    expect([rare, common, heroic].map(targetCommand)).toEqual(['hero', 'captains', 'both']);
    expect(battleCommand({ hero: true, captains: 0 })).toBe('hero');
    expect(battleCommand({ hero: false, captains: 3 })).toBe('captains');
    expect(battleCommand(null)).toBeNull();
    const battles = [{ id: 'a', led: { hero: true, captains: 0 } }, { id: 'b', led: { hero: false, captains: 1 } }, { id: 'c', led: null }];
    expect(battlesLedFor(rare, battles).map((b: { id: string }) => b.id)).toEqual(['a']);
    expect(battlesLedFor(common, battles).map((b: { id: string }) => b.id)).toEqual(['b']);
  });
});

describe('what a player\'s battles say', () => {
  const unit = (id: number) => ({ unit: id, name: DATA.units[id as keyof typeof DATA.units].name, strength: DATA.units[id as keyof typeof DATA.units].str, health: DATA.units[id as keyof typeof DATA.units].hp });

  it('reads the event bonus off strikes on event monsters: what the features made beyond the troop\'s own', () => {
    // 10 Corax I, +100% strength, +450% event bonus (no feature of its own vs Fenrir): M = 1 + 1 + 4.5.
    const damage = 10 * 61200 * 6.5;
    const report = { troops: [{ ...unit(206), count: 10, strikes: [{ count: 10, damage, extraA: damage * (4.5 / 6.5), extraB: 0, capped: false, target: unit(7620) }] }] };
    expect(eventBonusFromReport(report, defs)).toBeCloseTo(450, 3);
    expect(eventBonusFromReport({ troops: [] }, defs)).toBeNull();
  });

  it('suggests every troop sent, capped at the most sent in one battle, mercenary buys summed', () => {
    const battle = (at: string, troops: Array<[number, number]>) => ({
      entryId: at, at, attacker: { playerId: 1, name: 'me' }, target: { staticId: 1531, name: '', level: null },
      troops: troops.map(([u, count]) => ({ ...unit(u), count, card: null, unitHealth: null, strikes: [] })),
    });
    const reports = [
      battle('2026-11-27T10:00:00Z', [[206, 100], [3079, 130], [3079, 320], [6033, 5]]),
      battle('2026-11-26T10:00:00Z', [[206, 300], [191, 4]]),
    ];
    const rows = armyFromBattles(reports, defs);
    expect(rows.map((r) => [r.unitId, r.cap])).toEqual([['206', 300], ['3079', 450], ['191', 4]]);
    // Tools → Monsters: the latest battle alone (what the player has now); the rest only fill gaps.
    const latest = armyFromBattles([reports[0]], defs, reports);
    expect(latest.map((r) => [r.unitId, r.cap])).toEqual([['206', 100], ['3079', 450]]);
  });
});
