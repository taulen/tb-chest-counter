// Citadel simulator — the battle rules and data behind Tools → Citadel.
//
// Every rule here was measured from real battle reports (Elven 10, 15, 20, 25
// and 30) and replays them strike for strike; tests/web/citadel-sim.test.ts
// holds those reports, so a changed rule fails the suite. The evidence and the
// open questions are in docs/citadel-simulator.md.
//
// The fight, in game terms:
//  - SIEGE (only while the walls stand): siege engines strike first (initiative
//    +5), then the walls, then everything else hits the walls. Rounds repeat
//    until the walls are down. Wounds taken from the walls heal before the
//    battle; units the walls kill stay dead.
//  - BATTLE in rounds. A coin flip decides who opens round 1; after that the
//    side that did NOT act last opens the next round. Within a round the sides
//    alternate, each using its strongest stack that has not acted yet (stack
//    strength = units × strength × (1 + bonus); features play no part). When
//    one side runs out, the other side's remaining stacks act back to back.
//  - TARGETING: a stack hits the enemy it would deal the most damage to —
//    features ("vs mounted +667 %") are added to the bonus, and damage is
//    capped at what the target has left. Ties go to the target that would hit
//    back hardest.
//  - DAMAGE: units × strength × (1 + bonus + matching features); siege engines
//    deal ×20 against fortifications. A stack's health is a pool: units alive =
//    ceil(pool ÷ unit health), and a damaged stack strikes with those units.
//    Wounds stay through the whole battle, for every troop kind.
//  - LUCK (double damage, striking two squads) is not simulated; the
//    tests replay it through `luck` to match the reports exactly.
//
// Plain ESM, no DOM access — imported by pages/citadel-tool.js and the tests.

/** Base strength and health from the game cards / totalbattlewiki.com; features
 *  ("vs") in percent. `group` sorts the picker; `tier` (1-9) is the level of its
 *  group that unlocks it, null for mercenaries. */
function troop(id, name, group, tier, str, hp, tags, vs, extra = {}) {
  return { id, name, group, tier, str, hp, tags, vs, siegeEngine: false, ...extra };
}
const SIEGE = { siegeEngine: true };

export const TROOPS = [
  // From totalbattlewiki.com (Nov 2026): every guardsman, specialist, monster
  // and engineer tier I-IX, by group, highest tier first. The 33 troops
  // game01master covers were checked against game cards and battle reports.
  troop('corax-2', 'Corax II', 'guardsmen', 9, 110200, 330600, ['flying', 'guardsman', 'human'], { fortification: 1051, mounted: 1999 }),
  troop('smiter-2', 'Smiter II', 'guardsmen', 9, 11020, 33060, ['guardsman', 'human', 'mounted'], { siege: 1384, ranged: 1667 }),
  troop('punisher-2', 'Punisher II', 'guardsmen', 9, 5510, 16530, ['guardsman', 'human', 'melee'], { beast: 2050, mounted: 1000 }),
  troop('purifier-2', 'Purifier II', 'guardsmen', 9, 5510, 16530, ['guardsman', 'human', 'ranged'], { melee: 1333, flying: 1717 }),
  troop('corax-1', 'Corax I', 'guardsmen', 8, 61200, 183600, ['flying', 'guardsman', 'human'], { fortification: 701, mounted: 1333 }),
  troop('smiter-1', 'Smiter I', 'guardsmen', 8, 6120, 18360, ['guardsman', 'human', 'mounted'], { siege: 923, ranged: 1111 }),
  troop('punisher-1', 'Punisher I', 'guardsmen', 8, 3060, 9180, ['guardsman', 'human', 'melee'], { beast: 1367, mounted: 667 }),
  troop('purifier-1', 'Purifier I', 'guardsmen', 8, 3060, 9180, ['guardsman', 'human', 'ranged'], { melee: 888, flying: 1145 }),
  troop('griffin-7', 'Battle Griffin VII', 'guardsmen', 7, 34000, 102000, ['beast', 'flying', 'guardsman'], { fortification: 467, mounted: 888 }),
  troop('mounted-knight-7', 'Mounted Knight VII', 'guardsmen', 7, 3400, 10200, ['guardsman', 'human', 'mounted'], { siege: 615, ranged: 740 }),
  troop('heavy-arbalester-7', 'Heavy Arbalester VII', 'guardsmen', 7, 1700, 5100, ['guardsman', 'human', 'ranged'], { melee: 592, flying: 763 }),
  troop('heavy-halberdier-7', 'Heavy Halberdier VII', 'guardsmen', 7, 1700, 5100, ['guardsman', 'human', 'melee'], { beast: 911, mounted: 444 }),
  troop('griffin-6', 'Battle Griffin VI', 'guardsmen', 6, 19000, 57000, ['beast', 'flying', 'guardsman'], { fortification: 311, mounted: 592 }),
  troop('mounted-knight-6', 'Mounted Knight VI', 'guardsmen', 6, 1900, 5700, ['guardsman', 'human', 'mounted'], { siege: 410, ranged: 494 }),
  troop('heavy-arbalester-6', 'Heavy Arbalester VI', 'guardsmen', 6, 940, 2820, ['guardsman', 'human', 'ranged'], { melee: 395, flying: 509 }),
  troop('heavy-halberdier-6', 'Heavy Halberdier VI', 'guardsmen', 6, 940, 2820, ['guardsman', 'human', 'melee'], { beast: 608, mounted: 296 }),
  troop('griffin-5', 'Battle Griffin V', 'guardsmen', 5, 10000, 30000, ['beast', 'flying', 'guardsman'], { fortification: 208, mounted: 395 }),
  troop('rider-5', 'Rider V', 'guardsmen', 5, 1050, 3150, ['guardsman', 'human', 'mounted'], { siege: 273, ranged: 329 }),
  troop('archer-5', 'Archer V', 'guardsmen', 5, 520, 1560, ['guardsman', 'human', 'ranged'], { melee: 263, flying: 339 }),
  troop('spearmen-5', 'Spearman V', 'guardsmen', 5, 520, 1560, ['guardsman', 'human', 'melee'], { beast: 405, mounted: 197 }),
  troop('rider-4', 'Rider IV', 'guardsmen', 4, 580, 1740, ['guardsman', 'human', 'mounted'], { siege: 182, ranged: 219 }),
  troop('archer-4', 'Archer IV', 'guardsmen', 4, 290, 870, ['guardsman', 'human', 'ranged'], { melee: 176, flying: 226 }),
  troop('spearmen-4', 'Spearman IV', 'guardsmen', 4, 290, 870, ['guardsman', 'human', 'melee'], { beast: 270, mounted: 132 }),
  troop('rider-3', 'Rider III', 'guardsmen', 3, 320, 960, ['guardsman', 'human', 'mounted'], { siege: 122, ranged: 146 }),
  troop('archer-3', 'Archer III', 'guardsmen', 3, 160, 480, ['guardsman', 'human', 'ranged'], { melee: 117, flying: 151 }),
  troop('spearmen-3', 'Spearman III', 'guardsmen', 3, 160, 480, ['guardsman', 'human', 'melee'], { beast: 180, mounted: 88 }),
  troop('rider-2', 'Rider II', 'guardsmen', 2, 180, 540, ['guardsman', 'human', 'mounted'], { siege: 81, ranged: 98 }),
  troop('archer-2', 'Archer II', 'guardsmen', 2, 90, 270, ['guardsman', 'human', 'ranged'], { melee: 78, flying: 101 }),
  troop('spearmen-2', 'Spearman II', 'guardsmen', 2, 90, 270, ['guardsman', 'human', 'melee'], { beast: 120, mounted: 59 }),
  troop('rider-1', 'Rider I', 'guardsmen', 1, 100, 300, ['guardsman', 'human', 'mounted'], { siege: 54, ranged: 65 }),
  troop('archer-1', 'Archer I', 'guardsmen', 1, 50, 150, ['guardsman', 'human', 'ranged'], { melee: 52, flying: 67 }),
  troop('spearmen-1', 'Spearman I', 'guardsmen', 1, 50, 150, ['guardsman', 'human', 'melee'], { beast: 80, mounted: 39 }),
  troop('royal-lion-2', 'Royal Lion II', 'specialists', 9, 110200, 330600, ['beast', 'flying', 'specialist'], { fortification: 525, mounted: 1000 }),
  troop('whitemane-2', 'Whitemane II', 'specialists', 9, 11020, 33060, ['human', 'mounted', 'specialist'], { siege: 692, ranged: 833 }),
  troop('duelist-2', 'Duelist II', 'specialists', 9, 5510, 16530, ['human', 'melee', 'specialist'], { beast: 1025, mounted: 500 }),
  troop('legitimist-2', 'Legitimist II', 'specialists', 9, 5510, 16530, ['human', 'ranged', 'specialist'], { melee: 667, flying: 859 }),
  troop('royal-lion-1', 'Royal Lion I', 'specialists', 8, 61200, 183600, ['beast', 'flying', 'specialist'], { fortification: 350, mounted: 667 }),
  troop('whitemane-1', 'Whitemane I', 'specialists', 8, 6120, 18360, ['human', 'mounted', 'specialist'], { siege: 461, ranged: 555 }),
  troop('duelist-1', 'Duelist I', 'specialists', 8, 3060, 9180, ['human', 'melee', 'specialist'], { beast: 683, mounted: 333 }),
  troop('legitimist-1', 'Legitimist I', 'specialists', 8, 3060, 9180, ['human', 'ranged', 'specialist'], { melee: 444, flying: 572 }),
  troop('lion-rider-7', 'Lion Rider VII', 'specialists', 7, 3400, 10200, ['human', 'mounted', 'specialist'], { siege: 308, human: 105, ranged: 370 }),
  troop('deadshot-7', 'Deadshot VII', 'specialists', 7, 1700, 5100, ['human', 'ranged', 'specialist'], { human: 105, melee: 296, flying: 382 }),
  troop('heavy-knight-7', 'Heavy Knight VII', 'specialists', 7, 1700, 5100, ['human', 'melee', 'specialist'], { beast: 456, human: 105, mounted: 222 }),
  troop('vulture-7', 'Vulture VII', 'specialists', 7, 1700, 5100, ['flying', 'human', 'specialist'], { fortification: 234, human: 105, mounted: 444 }),
  troop('lion-rider-6', 'Lion Rider VI', 'specialists', 6, 1900, 5700, ['human', 'mounted', 'specialist'], { siege: 205, human: 105, ranged: 247 }),
  troop('deadshot-6', 'Deadshot VI', 'specialists', 6, 940, 2820, ['human', 'ranged', 'specialist'], { human: 105, melee: 197, flying: 254 }),
  troop('heavy-knight-6', 'Heavy Knight VI', 'specialists', 6, 940, 2820, ['human', 'melee', 'specialist'], { beast: 304, human: 105, mounted: 148 }),
  troop('vulture-6', 'Vulture VI', 'specialists', 6, 940, 2820, ['flying', 'human', 'specialist'], { fortification: 156, human: 105, mounted: 296 }),
  troop('lion-rider-5', 'Lion Rider V', 'specialists', 5, 1050, 3150, ['human', 'mounted', 'specialist'], { siege: 137, human: 105, ranged: 165 }),
  troop('deadshot-5', 'Deadshot V', 'specialists', 5, 520, 1560, ['human', 'ranged', 'specialist'], { human: 105, melee: 132, flying: 170 }),
  troop('swordsmen-5', 'Swordsman V', 'specialists', 5, 520, 1560, ['human', 'melee', 'specialist'], { beast: 203, human: 105, mounted: 99 }),
  troop('vulture-5', 'Vulture V', 'specialists', 5, 520, 1560, ['flying', 'human', 'specialist'], { fortification: 104, human: 105, mounted: 197 }),
  troop('swordsmen-4', 'Swordsman IV', 'specialists', 4, 290, 870, ['human', 'melee', 'specialist'], { beast: 135, human: 105, mounted: 66 }),
  troop('swordsmen-3', 'Swordsman III', 'specialists', 3, 160, 480, ['human', 'melee', 'specialist'], { beast: 90, human: 105, mounted: 44 }),
  troop('swordsmen-2', 'Swordsman II', 'specialists', 2, 90, 270, ['human', 'melee', 'specialist'], { beast: 60, human: 105, mounted: 29 }),
  troop('swordsmen-1', 'Swordsman I', 'specialists', 1, 50, 150, ['human', 'melee', 'specialist'], { beast: 40, human: 105, mounted: 20 }),
  troop('kraken-2', 'Kraken II', 'monsters', 9, 1210000, 3630000, ['giant', 'melee', 'monster'], { beast: 1435, mounted: 1486 }),
  troop('fire-phoenix-2', 'Fire Phoenix II', 'monsters', 9, 1190000, 3570000, ['elemental', 'flying', 'monster'], { dragon: 1871, melee: 1051 }),
  troop('devastator-2', 'Devastator II', 'monsters', 9, 1170000, 3510000, ['dragon', 'monster', 'mounted'], { giant: 1000, ranged: 1922 }),
  troop('trickster-2', 'Trickster II', 'monsters', 9, 1150000, 3450000, ['beast', 'monster', 'ranged'], { elemental: 1512, flying: 1410 }),
  troop('kraken-1', 'Kraken I', 'monsters', 8, 670000, 2010000, ['giant', 'melee', 'monster'], { beast: 957, mounted: 991 }),
  troop('fire-phoenix-1', 'Fire Phoenix I', 'monsters', 8, 660000, 1980000, ['elemental', 'flying', 'monster'], { dragon: 1247, melee: 701 }),
  troop('devastator-1', 'Devastator I', 'monsters', 8, 650000, 1950000, ['dragon', 'monster', 'mounted'], { giant: 667, ranged: 1281 }),
  troop('trickster-1', 'Trickster I', 'monsters', 8, 640000, 1920000, ['beast', 'monster', 'ranged'], { elemental: 1008, flying: 940 }),
  troop('wind-lord', 'Wind Lord', 'monsters', 7, 310000, 930000, ['elemental', 'melee', 'monster'], { dragon: 911, mounted: 387 }),
  troop('black-dragon', 'Black Dragon', 'monsters', 7, 300000, 900000, ['dragon', 'flying', 'monster'], { beast: 729, melee: 570 }),
  troop('destructive-colossus', 'Destructive Colossus', 'monsters', 7, 290000, 870000, ['giant', 'monster', 'ranged'], { melee: 752, flying: 547 }),
  troop('ancient-terror', 'Ancient Terror', 'monsters', 7, 280000, 840000, ['beast', 'monster', 'mounted'], { fortification: 547, ranged: 752 }),
  troop('jungle-destroyer', 'Jungle Destroyer', 'monsters', 6, 130000, 390000, ['beast', 'melee', 'monster'], { dragon: 243, mounted: 623 }),
  troop('ruby-golem', 'Ruby Golem', 'monsters', 6, 130000, 390000, ['elemental', 'melee', 'monster'], { melee: 486, mounted: 380 }),
  troop('crystal-dragon', 'Crystal Dragon', 'monsters', 6, 120000, 360000, ['dragon', 'melee', 'monster'], { elemental: 608, mounted: 258 }),
  troop('troll-rider', 'Troll Rider', 'monsters', 6, 110000, 330000, ['giant', 'monster', 'mounted'], { fortification: 486, ranged: 380 }),
  troop('ettin', 'Ettin', 'monsters', 5, 48000, 144000, ['giant', 'melee', 'monster'], { fortification: 243, mounted: 334 }),
  troop('manticore', 'Fearsome Manticore', 'monsters', 5, 46000, 138000, ['beast', 'flying', 'monster'], { giant: 324, flying: 253 }),
  troop('flaming-centaur', 'Flaming Centaur', 'monsters', 5, 44000, 132000, ['elemental', 'monster', 'mounted'], { beast: 162, ranged: 415 }),
  troop('desert-vanquisher', 'Desert Vanquisher', 'monsters', 5, 42000, 126000, ['dragon', 'monster', 'mounted'], { elemental: 324, ranged: 253 }),
  troop('ice-phoenix', 'Ice Phoenix', 'monsters', 4, 17000, 51000, ['elemental', 'flying', 'monster'], { dragon: 162, flying: 223 }),
  troop('magic-dragon', 'Magic Dragon', 'monsters', 4, 15000, 45000, ['dragon', 'monster', 'ranged'], { ranged: 216, melee: 169 }),
  troop('many-armed-giant', 'Many-Armed Giant', 'monsters', 4, 13000, 39000, ['giant', 'melee', 'monster'], { elemental: 270, mounted: 115 }),
  troop('gorgon-medusa', 'Gorgon Medusa', 'monsters', 4, 12000, 36000, ['beast', 'monster', 'ranged'], { melee: 277, flying: 108 }),
  troop('stone-gargoyle', 'Stone Gargoyle', 'monsters', 3, 5200, 15600, ['flying', 'giant', 'monster'], { beast: 72, melee: 185 }),
  troop('emerald-dragon', 'Emerald Dragon', 'monsters', 3, 4500, 13500, ['dragon', 'flying', 'monster'], { giant: 72, mounted: 185 }),
  troop('battle-boar', 'Battle Boar', 'monsters', 3, 3900, 11700, ['beast', 'monster', 'mounted'], { ranged: 113, mounted: 144 }),
  troop('water-elemental', 'Water Elemental', 'monsters', 3, 1900, 5700, ['elemental', 'monster', 'ranged'], { melee: 113, flying: 144 }),
  // Mercenaries: bought, not unlocked by level.
  troop('wyvern', 'Wyvern', 'mercenaries', null, 690000, 2070000, ['cursed', 'flying', 'mercenary'], { melee: 75 }),
  troop('jago', 'Jago', 'mercenaries', null, 220000, 660000, ['beast', 'flying', 'mercenary', 'specialist'], { fortification: 525, mounted: 1000 }),
  troop('warregal', 'Warregal', 'mercenaries', null, 220000, 660000, ['beast', 'flying', 'guardsman', 'mercenary'], { fortification: 1051, mounted: 1999 }),
  troop('ariel', 'Ariel', 'mercenaries', null, 55000, 330000, ['human', 'mercenary', 'siege'], { fortification: 1667 }, SIEGE),
  troop('epic-monster-hunter', 'Epic Monster Hunter', 'mercenaries', null, 25000, 75000, ['guardsman', 'mercenary'], {}),
  // Siege health is the game card's 6× strength (Siege Ballistae VII = 51,000);
  // totalbattlewiki.com shows 3×. Josephine I, Ballistae VI and Catapults IV/V
  // keep game01master's rounded card values (the Catapult V battle replay uses 15,800).
  troop('josephine-2', 'Josephine II', 'siege', 9, 27550, 165300, ['engineer', 'human', 'siege'], { fortification: 1667 }, SIEGE),
  troop('josephine-1', 'Josephine I', 'siege', 8, 15310, 91800, ['engineer', 'human', 'siege'], { fortification: 1111 }, SIEGE),
  troop('siege-ballistae-7', 'Siege Ballistae VII', 'siege', 7, 8500, 51000, ['engineer', 'human', 'siege'], { fortification: 740 }, SIEGE),
  troop('siege-ballistae-6', 'Siege Ballistae VI', 'siege', 6, 4730, 28400, ['engineer', 'human', 'siege'], { fortification: 494 }, SIEGE),
  troop('catapult-5', 'Catapult V', 'siege', 5, 2630, 15800, ['engineer', 'human', 'siege'], { fortification: 329 }, SIEGE),
  troop('catapult-4', 'Catapult IV', 'siege', 4, 1460, 8750, ['engineer', 'human', 'siege'], { fortification: 219 }, SIEGE),
  troop('catapult-3', 'Catapult III', 'siege', 3, 810, 4860, ['engineer', 'human', 'siege'], { fortification: 146 }, SIEGE),
  troop('catapult-2', 'Catapult II', 'siege', 2, 450, 2700, ['engineer', 'human', 'siege'], { fortification: 98 }, SIEGE),
  troop('catapult-1', 'Catapult I', 'siege', 1, 250, 1500, ['engineer', 'human', 'siege'], { fortification: 65 }, SIEGE),
];
export const TROOP_GROUPS = ['guardsmen', 'specialists', 'monsters', 'mercenaries', 'siege'];

/**
 * Troops that read the same strength and health bonus off their cards: the
 * same captain, artifact and research lines apply to every tier. These are
 * game01master's groups (its getBonusGroup, which links the strength fields),
 * with one change: Fire Phoenix and Royal Lion share a family. game01master
 * keeps them apart, but the user's cards read the same strength AND health
 * for Phoenix I and Royal Lion I twice (Nov 2026). The page links strength and
 * health within a family only while the boxes agree, so a pair that does differ
 * just stops following once typed apart. A troop in no family shares with nothing.
 */
export const BONUS_FAMILIES = {
  corax: ['corax-1', 'corax-2'],
  'phoenix-lion': ['fire-phoenix-1', 'fire-phoenix-2', 'royal-lion-1', 'royal-lion-2', 'jago'],
  vulture: ['vulture-5', 'vulture-6', 'vulture-7'],
  griffin: ['griffin-5', 'griffin-6', 'griffin-7', 'warregal'],
  // A line's renamed tiers stay in its family, as game01master's melee ones do
  // (Spearman → Heavy Halberdier → Punisher). The ranged and mounted lines
  // follow the same pattern; they're not in game01master, so that is by analogy.
  'melee-guardsmen': ['spearmen-1', 'spearmen-2', 'spearmen-3', 'spearmen-4', 'spearmen-5', 'heavy-halberdier-6', 'heavy-halberdier-7', 'punisher-1', 'punisher-2'],
  'melee-specialists': ['swordsmen-1', 'swordsmen-2', 'swordsmen-3', 'swordsmen-4', 'swordsmen-5', 'heavy-knight-6', 'heavy-knight-7', 'duelist-1', 'duelist-2'],
  'ranged-guardsmen': ['archer-1', 'archer-2', 'archer-3', 'archer-4', 'archer-5', 'heavy-arbalester-6', 'heavy-arbalester-7', 'purifier-1', 'purifier-2'],
  'mounted-guardsmen': ['rider-1', 'rider-2', 'rider-3', 'rider-4', 'rider-5', 'mounted-knight-6', 'mounted-knight-7', 'smiter-1', 'smiter-2'],
  'ranged-specialists': ['deadshot-5', 'deadshot-6', 'deadshot-7', 'legitimist-1', 'legitimist-2'],
  'mounted-specialists': ['lion-rider-5', 'lion-rider-6', 'lion-rider-7', 'whitemane-1', 'whitemane-2'],
};
/**
 * The order the game lists troops when a march is set up (game01master's
 * RESULT_ORDER): the march list follows it, so a player goes straight down
 * the screen typing counts instead of hunting for each troop. One fix from the
 * game itself (Nov 2026 march screen): Jago comes before Warregal —
 * game01master has them the other way round.
 */
export const MARCH_ORDER = [
  'wyvern', 'jago', 'warregal', 'ariel', 'epic-monster-hunter', 'fire-phoenix-2',
  'fire-phoenix-1', 'manticore', 'corax-2', 'royal-lion-2', 'corax-1',
  'royal-lion-1', 'griffin-7', 'josephine-2', 'griffin-6', 'josephine-1',
  'griffin-5', 'siege-ballistae-7', 'siege-ballistae-6', 'punisher-1',
  'duelist-1', 'catapult-5', 'vulture-7', 'heavy-halberdier-7',
  'heavy-knight-7', 'catapult-4', 'vulture-6', 'heavy-halberdier-6',
  'heavy-knight-6', 'catapult-3', 'spearmen-5', 'swordsmen-5', 'vulture-5',
];

/**
 * Rows with troops to send, sorted as the march screen lists them. The screen
 * puts mercenaries first, then monsters, then everything else, each by base
 * strength (highest first); MARCH_ORDER settles ties. That rule reproduces
 * MARCH_ORDER exactly and places every other troop by its strength — checked
 * in game only for the 33 in MARCH_ORDER.
 */
export function marchList(rows) {
  const rank = (def) => (def.group === 'mercenaries' ? 0 : def.group === 'monsters' ? 1 : 2);
  const at = (id) => {
    const k = MARCH_ORDER.indexOf(id);
    return k === -1 ? MARCH_ORDER.length : k;
  };
  const key = (r) => {
    const def = troopById(r.troopId);
    return def ? [rank(def), -def.str, at(r.troopId)] : [3, 0, at(r.troopId)];
  };
  return rows.filter((r) => r.count > 0).sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });
}

/**
 * The level that unlocks each troop: [kind, tier], kind g/s/m/e (Guardsmen,
 * Specialists, Monsters, Engineers — the levels players quote as "8/8/8/7"),
 * from each troop's `tier` (the wiki's tier I-IX). The roman numeral in a name
 * is the tier up to VII; the renamed tiers start again at I = 8 (Punisher I,
 * Corax II = 9…). Mercenaries aren't unlocked by level and are always offered.
 */
const LEVEL_KIND = { guardsmen: 'g', specialists: 's', monsters: 'm', siege: 'e' };
export const TROOP_TIERS = Object.fromEntries(
  TROOPS.filter((x) => x.tier && LEVEL_KIND[x.group]).map((x) => [x.id, [LEVEL_KIND[x.group], x.tier]]),
);

/** [kind, tier] for a troop, or null when no level gates it. */
export function troopTier(troopId) {
  return TROOP_TIERS[troopId] ?? null;
}

/** Whether levels { g, s, m, e } (null = any) unlock this troop. */
export function troopUnlocked(troopId, levels) {
  const tier = TROOP_TIERS[troopId];
  if (!tier || !levels) return true;
  const cap = levels[tier[0]];
  return cap === null || cap === undefined || tier[1] <= cap;
}

/** How many tiers below your level the troop picker still offers (8 → 5-8). */
export const LEVEL_WINDOW = 3;

/** Whether the picker offers this troop at these levels: your level and the
 *  LEVEL_WINDOW tiers below it. Mercenaries and "any" levels show everything. */
export function troopInWindow(troopId, levels) {
  const tier = TROOP_TIERS[troopId];
  if (!tier || !levels) return true;
  const cap = levels[tier[0]];
  if (cap === null || cap === undefined) return true;
  return tier[1] <= cap && tier[1] >= cap - LEVEL_WINDOW;
}

const FAMILY_OF = new Map(Object.entries(BONUS_FAMILIES).flatMap(([fam, ids]) => ids.map((id) => [id, fam])));

/** The bonus family of a troop, or null when it shares its bonuses with none. */
export function bonusFamily(troopId) {
  return FAMILY_OF.get(troopId) ?? null;
}

/** Citadel defenders, from their in-game cards (all checked). */
function unit(id, name, str, hp, tags, vs) {
  return { id, name, str, hp, tags, vs };
}
export const DEFENDERS = Object.fromEntries([
  unit('walls', 'Citadel Walls', 10000, 30000, ['fortification'], { melee: 100, ranged: 100, mounted: 100 }),
  unit('dwarf', 'Dwarf', 28, 84, ['elves', 'melee'], { mounted: 10 }),
  unit('elven-archer', 'Elven Archer', 100, 300, ['elves', 'ranged'], { melee: 35 }),
  unit('druid', 'Druid', 900, 2700, ['elves', 'ranged'], { melee: 25 }),
  unit('centaur', 'Centaur', 2600, 7800, ['elves', 'mounted'], { ranged: 50, siege: 20 }),
  unit('pegasus-rider', 'Pegasus Rider', 8200, 24600, ['elves', 'flying'], { melee: 60, dragon: 50 }),
  unit('bear', 'Bear', 22000, 66000, ['beast', 'elves', 'melee'], { mounted: 70, elemental: 50 }),
  unit('unicorn-rider', 'Unicorn Rider', 27000, 81000, ['elves', 'mounted'], { ranged: 65 }),
  unit('ent', 'Ent', 73000, 219000, ['elemental', 'elves', 'melee'], { ranged: 55, dragon: 45 }),
  unit('life-dragon', 'Life Dragon', 240000, 720000, ['dragon', 'elves', 'flying'], { mounted: 60, giant: 50 }),
  unit('werewolf', 'Werewolf', 360, 1080, ['beast', 'cursed', 'melee'], { mounted: 45 }),
  unit('death-rider', 'Death Rider', 3200, 9600, ['cursed', 'mounted'], { ranged: 50 }),
  unit('bull-rider', 'Bull Rider', 29000, 87000, ['cursed', 'mounted'], { ranged: 55 }),
  unit('giant-zombie', 'Giant Zombie', 33000, 99000, ['cursed', 'giant', 'melee'], { mounted: 70, beast: 45 }),
  unit('cursed-dendroid', 'Cursed Dendroid', 110000, 330000, ['cursed', 'elemental', 'melee'], { ranged: 65, dragon: 50 }),
  unit('cursed-dragon', 'Cursed Dragon', 320000, 960000, ['cursed', 'dragon', 'flying'], { giant: 50, mounted: 50 }),
].map((d) => [d.id, d]));

/** What is inside each citadel — counted from in-game march screens. */
export const CITADELS = [
  { id: 'elven-10', kind: 'elven', level: 10, walls: 90, units: [['bear', 9], ['pegasus-rider', 19], ['elven-archer', 1200], ['druid', 100], ['dwarf', 2200]] },
  { id: 'elven-15', kind: 'elven', level: 15, walls: 700, units: [['ent', 21], ['unicorn-rider', 47], ['centaur', 290], ['druid', 1100], ['elven-archer', 5000]] },
  { id: 'elven-20', kind: 'elven', level: 20, walls: 3650, units: [['life-dragon', 41], ['ent', 110], ['bear', 230], ['centaur', 2500], ['druid', 3600]] },
  { id: 'elven-25', kind: 'elven', level: 25, walls: 31900, units: [['life-dragon', 480], ['ent', 880], ['bear', 2400], ['pegasus-rider', 4300], ['centaur', 10000]] },
  { id: 'elven-30', kind: 'elven', level: 30, walls: 135000, units: [['life-dragon', 2300], ['ent', 4300], ['bear', 12000], ['pegasus-rider', 21000], ['centaur', 49000]] },
  { id: 'cursed-20', kind: 'cursed', level: 20, walls: 9200, units: [['cursed-dragon', 10], ['giant-zombie', 80], ['bull-rider', 54], ['death-rider', 650], ['werewolf', 2900]] },
  { id: 'cursed-25', kind: 'cursed', level: 25, walls: 77500, units: [['cursed-dragon', 120], ['cursed-dendroid', 205], ['giant-zombie', 540], ['bull-rider', 400], ['death-rider', 2750]] },
];

const TROOP_BY_ID = new Map(TROOPS.map((x) => [x.id, x]));
const CITADEL_BY_ID = new Map(CITADELS.map((c) => [c.id, c]));
export const troopById = (id) => TROOP_BY_ID.get(id) ?? null;
export const citadelById = (id) => CITADEL_BY_ID.get(id) ?? null;

// ─── Engine ──────────────────────────────────────────────────────

const MAX_SIEGE_ROUNDS = 40;
const MAX_BATTLE_ROUNDS = 60;

/** A health bonus nobody entered: the stack counts as untouchable. That can only
 *  make it MORE attractive as a target (damage is capped at what a target has
 *  left), so a stack that still isn't hit would not be hit with its real health
 *  either; one that IS hit is reported (`healthUnknown`) for the page to ask. */
const UNKNOWN_HEALTH_FACTOR = 1e9;

function makeStack(side, def, count, strengthPct = 0, healthPct = 0, index = -1) {
  const unknown = healthPct === null;
  const uhp = def.hp * (unknown ? UNKNOWN_HEALTH_FACTOR : 1 + healthPct / 100);
  return {
    side, def, index, count, healthUnknown: unknown,
    s: strengthPct / 100,
    tags: new Set(def.tags),
    vs: Object.entries(def.vs || {}).map(([tag, pct]) => [tag, pct / 100]),
    siegeEngine: !!def.siegeEngine,
    uhp,
    pool: count * uhp,
    taken: 0,
  };
}

function alive(st) {
  return st.pool <= 1e-6 ? 0 : Math.ceil(st.pool / st.uhp - 1e-9);
}

/** Turn order: units × strength × (1 + bonus). Features play no part. */
function strength(st) {
  return alive(st) * st.def.str * (1 + st.s);
}

function damageVs(actor, target) {
  let bonus = actor.s;
  for (const [tag, v] of actor.vs) if (target.tags.has(tag)) bonus += v;
  const d = alive(actor) * actor.def.str * (1 + bonus);
  return actor.siegeEngine && target.tags.has('fortification') ? d * 20 : d;
}

/** Most damage dealt (capped at what is left); ties → whoever hits back hardest. */
function pickTarget(actor, enemies, exclude = null) {
  let best = null;
  let bestKey = null;
  for (const t of enemies) {
    if (t === exclude || alive(t) === 0) continue;
    const key = [Math.round(Math.min(damageVs(actor, t), t.pool)), Math.round(damageVs(t, actor)), Math.round(strength(t))];
    if (!bestKey || key[0] > bestKey[0] || (key[0] === bestKey[0] && (key[1] > bestKey[1] || (key[1] === bestKey[1] && key[2] > bestKey[2])))) {
      best = t;
      bestKey = key;
    }
  }
  return best;
}

function strongestUnacted(stacks, acted) {
  let best = null;
  for (const s of stacks) {
    if (acted.has(s) || alive(s) === 0) continue;
    if (!best || strength(s) > strength(best)) best = s;
  }
  return best;
}

/**
 * Simulate one attack.
 * @param {object} p
 * @param {string} p.citadelId   e.g. 'elven-30'
 * @param {{troopId:string,count:number,strengthPct?:number,healthPct?:number|null}[]} p.army
 *        healthPct null = not entered (see UNKNOWN_HEALTH_FACTOR)
 * @param {'you'|'citadel'} p.opener  who opens the first battle round
 * @param {Record<number,{double?:boolean,second?:boolean}>} [p.luck]  1-based action number → luck rolls (tests)
 */
export function simulate({ citadelId, army, opener = 'citadel', luck = {} }) {
  const citadel = citadelById(citadelId);
  if (!citadel) throw new Error(`unknown citadel ${citadelId}`);
  const mine = [];
  army.forEach((row, index) => {
    const def = troopById(row.troopId);
    const n = Math.max(0, Math.floor(Number(row.count) || 0));
    const health = row.healthPct === null || row.healthPct === undefined || row.healthPct === '' ? null : Number(row.healthPct) || 0;
    if (def && n > 0) mine.push(makeStack('you', def, n, Number(row.strengthPct) || 0, health, index));
  });
  const theirs = citadel.units.map(([id, n], index) => makeStack('citadel', DEFENDERS[id], n, 0, 0, index));
  const walls = citadel.walls > 0 ? makeStack('citadel', DEFENDERS.walls, citadel.walls, 0, 0, -1) : null;

  const strikes = [];
  let action = 0;
  const hit = (actor, target, phase, round) => {
    action += 1;
    const roll = luck[action] || {};
    const mult = roll.double ? 2 : 1;
    const record = (t, dealt, second) => {
      const before = alive(t);
      t.pool -= dealt;
      t.taken += dealt;
      const after = alive(t);
      strikes.push({
        phase, round, side: actor.side, actor: actor.def.id, target: t.def.id, damage: dealt,
        double: !!roll.double, second, killed: after === 0,
        // Units the hit removed and what the target has left — the "result" column of the strike list.
        unitsLost: before - after, unitsLeft: after,
      });
    };
    record(target, Math.min(damageVs(actor, target) * mult, target.pool), false);
    if (roll.second) {
      const pool = actor.side === 'you' ? (phase === 'siege' ? [] : theirs) : mine;
      const t2 = pickTarget(actor, pool, target);
      if (t2) record(t2, Math.min(damageVs(actor, t2) * mult, t2.pool), true);
    }
  };
  const living = (list) => list.filter((s) => alive(s) > 0);

  // Siege
  let wallsDown = !walls;
  let siegeRounds = 0;
  if (walls && mine.length) {
    outer: for (let r = 1; r <= MAX_SIEGE_ROUNDS; r++) {
      siegeRounds = r;
      const acted = new Set();
      for (let s; (s = strongestUnacted(mine.filter((x) => x.siegeEngine), acted));) {
        hit(s, walls, 'siege', r);
        acted.add(s);
        if (alive(walls) === 0) { wallsDown = true; break outer; }
      }
      const target = pickTarget(walls, living(mine));
      if (target) hit(walls, target, 'siege', r);
      if (!living(mine).length) break;
      for (let s; (s = strongestUnacted(mine.filter((x) => !x.siegeEngine), acted));) {
        hit(s, walls, 'siege', r);
        acted.add(s);
        if (alive(walls) === 0) { wallsDown = true; break outer; }
      }
    }
  }
  const siegeLost = new Map(mine.map((s) => [s, s.count - alive(s)]));
  const siegeTaken = new Map(mine.map((s) => [s, s.taken]));
  // Wounds from the walls heal before the battle; the dead stay dead.
  for (const s of mine) s.pool = alive(s) * s.uhp;

  // Battle
  let won = false;
  let reason = null;
  let rounds = 0;
  if (!mine.length) reason = 'empty';
  else if (!wallsDown) reason = living(mine).length ? 'walls' : 'destroyed';
  else {
    let first = opener === 'you' ? 'you' : 'citadel';
    const sides = { you: mine, citadel: theirs };
    battle: for (let r = 1; r <= MAX_BATTLE_ROUNDS; r++) {
      rounds = r;
      const acted = new Set();
      let side = first;
      let last = null;
      for (;;) {
        const other = side === 'you' ? 'citadel' : 'you';
        const actor = strongestUnacted(sides[side], acted);
        if (!actor) {
          if (!strongestUnacted(sides[other], acted)) break;
          side = other;
          continue;
        }
        const target = pickTarget(actor, sides[other]);
        if (!target) break;
        hit(actor, target, 'battle', r);
        acted.add(actor);
        last = side;
        if (!living(theirs).length) { won = true; break battle; }
        if (!living(mine).length) { reason = 'destroyed'; break battle; }
        side = other;
      }
      first = last === 'you' ? 'citadel' : 'you';
    }
    if (!won && !reason) reason = 'rounds';
  }

  return {
    citadelId,
    opener,
    won,
    reason,
    wallsDown,
    siegeRounds,
    rounds,
    strikes,
    army: mine.map((s) => ({
      index: s.index,
      troopId: s.def.id,
      count: s.count,
      alive: alive(s),
      lost: s.count - alive(s),
      lostInSiege: siegeLost.get(s),
      siegeDamage: siegeTaken.get(s),
      battleDamage: s.taken - siegeTaken.get(s),
      unitHealth: s.uhp,
      healthUnknown: s.healthUnknown,
      wasHit: s.taken > 0,
    })),
    defenders: theirs.map((s) => ({ unitId: s.def.id, count: s.count, alive: alive(s) })),
  };
}

/** Both coin-flip outcomes for the same army. */
export function simulateBoth(params) {
  return { you: simulate({ ...params, opener: 'you' }), citadel: simulate({ ...params, opener: 'citadel' }) };
}

// ─── Automatic counts: search with the simulator itself ───────────

/** Automatic counts must still win with every bonus this much lower. */
export const SAFETY = 0.03;

/** Monsters and mercenaries are never traded for cheaper losses: a setup that
 *  loses even one of them ranks below every setup that loses only guardsmen,
 *  specialists or siege engines, however many. The first striker is there to
 *  absorb the losses; these are not. */
export const PROTECTED_GROUPS = new Set(['monsters', 'mercenaries']);

/** Expected losses of a setup (the mean of both coin flips), split into the
 *  protected kinds and the rest. Each lost troop is worth its base health, so one
 *  Wyvern (2.07M) weighs about eleven Corax I (183.6k) and losing cheap low-tier
 *  units is cheap. */
function lossValue(both) {
  let rest = 0;
  let prot = 0;
  for (const res of [both.you, both.citadel]) {
    for (const s of res.army) {
      const def = troopById(s.troopId);
      if (PROTECTED_GROUPS.has(def.group)) prot += s.lost * def.hp;
      else rest += s.lost * def.hp;
    }
  }
  return { prot: prot / 2, rest: rest / 2 };
}

/**
 * Counts that win in BOTH coin-flip outcomes with the fewest expected losses,
 * for the troop types and bonuses given (any citadel). A local search over
 * each row's count, trying the breakpoints where a stack's damage crosses a
 * defender's health — the counts where its target can change — plus plain
 * nudges. Deterministic. Rows whose health is unknown are searched at 0% health
 * (pessimistic); the page asks for it if that stack ends up being hit.
 *
 * Every candidate must also win with all your bonuses SAFETY lower (a misread
 * card, a captain left behind), and its losses are averaged over both — so the
 * search can't settle on a count that only works to the last unit.
 *
 * @param {{ citadelId: string, army: {troopId: string, count?: number, strengthPct?: number|null, healthPct?: number|null}[], budget?: number, starts?: number[][] }} p
 *        starts: extra starting counts (game01master's, the player's own)
 * @returns {{ ok: boolean, counts: number[], both: any, evaluations: number }}
 */
export function optimizeCounts({ citadelId, army, budget = 2500, starts = [] }) {
  const citadel = citadelById(citadelId);
  if (!citadel || !army.length) return { ok: false, counts: army.map(() => 0), both: null, evaluations: 0 };
  const rows = army.map((r) => ({ ...r, healthPct: r.healthPct ?? 0 }));
  // The same army with every bonus SAFETY lower (on the multiplier, 1 + bonus).
  const lower = (pct) => ((1 + (Number(pct) || 0) / 100) * (1 - SAFETY) - 1) * 100;
  const weaker = rows.map((r) => ({ ...r, strengthPct: lower(r.strengthPct), healthPct: lower(r.healthPct) }));
  const defs = rows.map((r) => troopById(r.troopId));
  const targets = [
    ...citadel.units.map(([id, n]) => ({ def: DEFENDERS[id], n })),
    ...(citadel.walls ? [{ def: DEFENDERS.walls, n: citadel.walls }] : []),
  ];
  /** Damage of ONE unit of row i against a full defender stack. */
  const perUnit = (i, target) => {
    const tgt = makeStack('citadel', target.def, 1);
    const me = makeStack('you', defs[i], 1, Number(rows[i].strengthPct) || 0, 0);
    return damageVs(me, tgt);
  };

  let evaluations = 0;
  const evaluate = (counts) => {
    evaluations += 1;
    const both = simulateBoth({ citadelId, army: rows.map((r, i) => ({ ...r, count: counts[i] })) });
    const weak = simulateBoth({ citadelId, army: weaker.map((r, i) => ({ ...r, count: counts[i] })) });
    const won = both.you.won && both.citadel.won && weak.you.won && weak.citadel.won;
    const left = [both.you, both.citadel, weak.you, weak.citadel].reduce((a, res) => a + res.defenders.reduce((x, d) => x + d.alive, 0), 0);
    const power = counts.reduce((a, n, i) => a + n * defs[i].str * (1 + (Number(rows[i].strengthPct) || 0) / 100), 0);
    const l = lossValue(both);
    const w = lossValue(weak);
    const prot = won ? (l.prot + w.prot) / 2 : Infinity;
    const loss = won ? (l.rest + w.rest) / 2 : Infinity;
    return { counts: [...counts], both, won, prot, loss, left, power };
  };
  // Win first; then the fewest monster/mercenary losses; then the fewest other
  // losses; then the smaller army (less strength sent).
  const better = (a, b) => {
    if (a.won !== b.won) return a.won;
    if (!a.won) return a.left < b.left || (a.left === b.left && a.power < b.power);
    if (Math.abs(a.prot - b.prot) > 1e-6) return a.prot < b.prot;
    if (Math.abs(a.loss - b.loss) > 1e-6) return a.loss < b.loss;
    return a.power < b.power - 1e-6;
  };

  // Start: every stack big enough to one-shot the biggest defender stack (siege
  // engines: the walls), then double everything until both outcomes are won.
  const biggest = targets.filter((x) => x.def.id !== 'walls').reduce((m, x) => Math.max(m, x.n * x.def.hp), 0);
  const wallHp = citadel.walls * DEFENDERS.walls.hp;
  let start = rows.map((r, i) => {
    const want = defs[i].siegeEngine && citadel.walls ? wallHp : biggest;
    const best = Math.max(...targets.filter((x) => (defs[i].siegeEngine ? x.def.id === 'walls' : x.def.id !== 'walls')).map((x) => perUnit(i, x)), 1);
    return Math.max(1, Math.ceil(want / best));
  });
  let best = evaluate(start);
  for (let k = 0; k < 8 && !best.won; k++) {
    start = start.map((n) => n * 2);
    const next = evaluate(start);
    if (better(next, best)) best = next;
  }
  for (const s of starts) {
    if (!Array.isArray(s) || s.length !== rows.length || !s.every((n) => Number.isInteger(n) && n >= 0)) continue;
    const cand = evaluate(s);
    if (better(cand, best)) best = cand;
  }
  if (!best.won) return { ok: false, counts: best.counts, both: best.both, evaluations };

  // Breakpoints per row: counts where its damage just reaches each defender's health.
  const breaks = rows.map((r, i) => {
    const set = new Set();
    for (const x of targets) {
      const per = perUnit(i, x);
      if (per <= 0) continue;
      for (const frac of [1, 0.5, 0.25]) {
        const k = Math.floor((x.n * x.def.hp * frac) / per);
        for (const d of [-1, 0, 1]) if (k + d >= 0) set.add(k + d);
      }
    }
    return [...set];
  });

  let improved = true;
  while (improved && evaluations < budget) {
    improved = false;
    for (let i = 0; i < rows.length && evaluations < budget; i++) {
      const n = best.counts[i];
      const cands = new Set([0, n - 1, n + 1, ...breaks[i]]);
      for (const f of [0.5, 0.75, 0.9, 0.97, 1.03, 1.1, 1.33, 2]) cands.add(Math.round(n * f));
      for (const c of cands) {
        if (c < 0 || c === n || c > 1e8 || evaluations >= budget) continue;
        const counts = [...best.counts];
        counts[i] = c;
        const cand = evaluate(counts);
        if (better(cand, best)) {
          best = cand;
          improved = true;
        }
      }
    }
  }
  return { ok: true, counts: best.counts, both: best.both, evaluations };
}

// ─── game01master's sizing (Elven 25 and 30 only) ─────────────────

/** game01master's targets: the first striker kills the Life Dragon and absorbs
 *  its opening strike; the second kills the Pegasus Rider (or, with a Fire
 *  Phoenix, cripples the Bear); the third kills the Centaur; cleanups are sized
 *  just below the third so they act after it. Its Bear target is deliberately
 *  under the real 792M / 158.4M — see docs/citadel-simulator.md. */
const GM = {
  'elven-25': { firstStrike: 115.2e6, wall: 957e6, normal: [345.6e6, 105.78e6, 78e6], withPhoenix: [345.6e6, 158e6, 78e6], cleanup: 77e6 },
  'elven-30': { firstStrike: 552e6, wall: 4.05e9, normal: [1656e6, 516.6e6, 382.2e6], withPhoenix: [1656e6, 788e6, 382.2e6], cleanup: 380.8e6 },
};
/** game01master adds these troops' "vs Beasts" feature wherever they stand. */
const GM_BEAST_EXTRA = new Set(['punisher-1', 'heavy-halberdier-7', 'heavy-halberdier-6', 'duelist-1', 'heavy-knight-7', 'heavy-knight-6', 'spearmen-5', 'swordsmen-5']);
export const GM_CITADELS = new Set(Object.keys(GM));

/** Role of each army row in game01master's template: 'first' | 'second' |
 *  'third' | 'cleanup' | 'extra' | 'walls' (first siege engine) | null. */
export function gmRoles(citadelId, army) {
  if (!GM[citadelId]) return army.map(() => null);
  let fighter = 0;
  let wallTaken = false;
  return army.map((row) => {
    const def = troopById(row.troopId);
    if (!def) return null;
    if (def.siegeEngine) {
      if (wallTaken) return 'extra';
      wallTaken = true;
      return 'walls';
    }
    const i = fighter++;
    return ['first', 'second', 'third'][i] ?? (i < 9 ? 'cleanup' : 'extra');
  });
}

/** game01master's counts for each row (null where it has no rule). Counts are
 *  rounded DOWN on purpose: a bigger stack can change its own target. */
export function gmCounts(citadelId, army) {
  const g = GM[citadelId];
  if (!g) return army.map(() => null);
  const roles = gmRoles(citadelId, army);
  const secondRow = army[roles.indexOf('second')];
  const withPhoenix = !!secondRow && /^fire-phoenix/.test(secondRow.troopId);
  const targets = withPhoenix ? g.withPhoenix : g.normal;
  let fighter = 0;
  return army.map((row, i) => {
    const def = troopById(row.troopId);
    const role = roles[i];
    if (!def || !role || role === 'extra') return null;
    const s = (Number(row.strengthPct) || 0) / 100;
    const h = (Number(row.healthPct) || 0) / 100;
    if (role === 'walls') {
      const perUnit = def.str * (1 + s + (def.vs.fortification || 0) / 100) * 20;
      return Math.ceil(g.wall / perUnit) + 2;
    }
    const slot = fighter++;
    let eff = s;
    if (GM_BEAST_EXTRA.has(def.id)) eff += (def.vs.beast || 0) / 100;
    if (role === 'second' && withPhoenix) eff += (def.vs.melee || 0) / 100;
    const target = targets[slot] ?? g.cleanup;
    let n = Math.floor(target / (def.str * (1 + eff)));
    if (role === 'first') n += Math.floor(g.firstStrike / (def.hp * (1 + h))) + 10;
    if (role === 'cleanup' && def.id === 'epic-monster-hunter') n = Math.max(0, n - 5);
    return n;
  });
}
