// Tools → Citadel's (and → Stacks') troops, the citadels' defenders and what
// is inside each citadel: plain data with no imports, because the art pipeline
// (src/game-art/mappings.ts loadTroopList) loads this file on its own to name
// every troop's icon. lib/citadel-sim.js re-exports all of it.
//
// Every value matches the game's own unit data (battle-data.json, checked Nov
// 28 2026): docs/citadel-simulator.md#data.

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
  troop('many-armed-giant', 'Many-Armed Guardian', 'monsters', 4, 13000, 39000, ['giant', 'melee', 'monster'], { elemental: 270, mounted: 115 }),
  troop('gorgon-medusa', 'Gorgon Medusa', 'monsters', 4, 12000, 36000, ['beast', 'monster', 'ranged'], { melee: 277, flying: 108 }),
  troop('stone-gargoyle', 'Stone Gargoyle', 'monsters', 3, 5200, 15600, ['flying', 'giant', 'monster'], { beast: 72, melee: 185 }),
  troop('emerald-dragon', 'Emerald Dragon', 'monsters', 3, 4500, 13500, ['dragon', 'flying', 'monster'], { giant: 72, mounted: 185 }),
  troop('battle-boar', 'Battle Boar', 'monsters', 3, 3900, 11700, ['beast', 'monster', 'mounted'], { ranged: 113, mounted: 144 }),
  troop('water-elemental', 'Water Elemental', 'monsters', 3, 1900, 5700, ['elemental', 'monster', 'ranged'], { melee: 113, flying: 144 }),
  // Mercenaries: bought, not unlocked by level. Every fighting mercenary on
  // totalbattlewiki.com/troops/mercenaries/ (Nov 2026; the scouts Grace and
  // Pathfinder are left out, though scouts do fight: Tools → Monsters has
  // them), by tier and strength. The first
  // five were checked against game cards before the rest were added. Epic
  // Monster Hunter V-VII come from Kaiculator's unit table (the wiki has only the
  // Superior one). mercTier is the tier the merc exchange lists them under;
  // authority, revivalGold and epicPct (vs epic monsters) are used by Tools →
  // Stacks (stack-calc.js), not by the citadel fight.
  // Tier IX
  troop('wyvern', 'Wyvern', 'mercenaries', null, 690000, 2070000, ['cursed', 'flying', 'mercenary'], { melee: 75 }, { mercTier: 9, authority: 63, revivalGold: 500 }),
  troop('warden', 'Warden', 'mercenaries', null, 470000, 1410000, ['elves', 'mercenary', 'mounted'], { ranged: 70 }, { mercTier: 9, authority: 43, revivalGold: 340 }),
  troop('eternal-cannoneer', 'Eternal Cannoneer', 'mercenaries', null, 440000, 1320000, ['mercenary', 'ranged', 'undead'], { flying: 65 }, { mercTier: 9, authority: 40, revivalGold: 320 }),
  troop('demonic-salamander', 'Demonic Salamander', 'mercenaries', null, 410000, 1230000, ['demon', 'melee', 'mercenary'], { mounted: 65 }, { mercTier: 9, authority: 38, revivalGold: 300 }),
  troop('jago', 'Jago', 'mercenaries', null, 220000, 660000, ['beast', 'flying', 'mercenary', 'specialist'], { fortification: 525, mounted: 1000 }, { mercTier: 9, authority: 20, revivalGold: 160 }),
  troop('warregal', 'Warregal', 'mercenaries', null, 220000, 660000, ['beast', 'flying', 'guardsman', 'mercenary'], { fortification: 1051, mounted: 1999 }, { mercTier: 9, authority: 20, revivalGold: 160 }),
  troop('ariel', 'Ariel', 'mercenaries', null, 55000, 330000, ['human', 'mercenary', 'siege'], { fortification: 1667 }, { ...SIEGE, mercTier: 9, authority: 10, revivalGold: 80 }),
  troop('epic-monster-hunter', 'Superior Epic Monster Hunter', 'mercenaries', null, 25000, 75000, ['guardsman', 'mercenary'], {}, { mercTier: 9, authority: 1, revivalGold: 8, epicPct: 1000 }),
  troop('galloper', 'Galloper', 'mercenaries', null, 22000, 66000, ['human', 'mercenary', 'mounted', 'specialist'], { ranged: 833, siege: 692 }, { mercTier: 9, authority: 2, revivalGold: 16 }),
  troop('quicksand', 'Quicksand', 'mercenaries', null, 22000, 66000, ['guardsman', 'human', 'mercenary', 'mounted'], { ranged: 1667, siege: 1384 }, { mercTier: 9, authority: 2, revivalGold: 16 }),
  troop('highlander', 'Highlander', 'mercenaries', null, 11000, 33000, ['guardsman', 'human', 'mercenary', 'ranged'], { flying: 1717, melee: 1333 }, { mercTier: 9, authority: 1, revivalGold: 8 }),
  troop('pounder', 'Pounder', 'mercenaries', null, 11000, 33000, ['human', 'mercenary', 'ranged', 'specialist'], { flying: 859, melee: 667 }, { mercTier: 9, authority: 1, revivalGold: 8 }),
  troop('scarface', 'Scarface', 'mercenaries', null, 11000, 33000, ['human', 'melee', 'mercenary', 'specialist'], { beast: 1025, mounted: 500 }, { mercTier: 9, authority: 1, revivalGold: 8 }),
  troop('slavic-warrior', 'Slavic warrior', 'mercenaries', null, 11000, 33000, ['guardsman', 'human', 'melee', 'mercenary'], { beast: 2050, mounted: 1000 }, { mercTier: 9, authority: 1, revivalGold: 8 }),
  // Tier VII
  troop('fire-lord', 'Fire Lord', 'mercenaries', null, 560000, 1680000, ['demon', 'elemental', 'mercenary', 'ranged'], { dragon: 45, melee: 80 }, { mercTier: 7, authority: 164, revivalGold: 1310 }),
  troop('sandworm', 'Sandworm', 'mercenaries', null, 430000, 1290000, ['barbarian', 'elemental', 'melee', 'mercenary'], { dragon: 50, mounted: 75 }, { mercTier: 7, authority: 128, revivalGold: 1020 }),
  troop('cursed-dragon', 'Cursed Dragon', 'mercenaries', null, 320000, 960000, ['cursed', 'dragon', 'flying', 'mercenary'], { giant: 50, mounted: 50 }, { mercTier: 7, authority: 93, revivalGold: 740 }),
  troop('life-dragon', 'Life Dragon', 'mercenaries', null, 240000, 720000, ['dragon', 'elves', 'flying', 'mercenary'], { giant: 50, mounted: 60 }, { mercTier: 7, authority: 70, revivalGold: 560 }),
  troop('overlord', 'Overlord', 'mercenaries', null, 200000, 600000, ['giant', 'mercenary', 'ranged', 'undead'], { beast: 50, melee: 60 }, { mercTier: 7, authority: 60, revivalGold: 480 }),
  troop('golden-dragon', 'Golden Dragon', 'mercenaries', null, 170000, 510000, ['dragon', 'flying', 'mercenary'], { giant: 365, mounted: 934 }, { mercTier: 7, authority: 50, revivalGold: 400 }),
  troop('lightning-lord', 'Lightning Lord', 'mercenaries', null, 153000, 460000, ['giant', 'mercenary', 'ranged'], { beast: 729, melee: 570 }, { mercTier: 7, authority: 45, revivalGold: 360 }),
  troop('sea-lord', 'Sea Lord', 'mercenaries', null, 140000, 420000, ['elemental', 'mercenary', 'mounted'], { dragon: 547, ranged: 752 }, { mercTier: 7, authority: 40, revivalGold: 320 }),
  troop('jungle-king', 'Jungle King', 'mercenaries', null, 110000, 330000, ['beast', 'melee', 'mercenary'], { elemental: 911, mounted: 387 }, { mercTier: 7, authority: 33, revivalGold: 264 }),
  troop('palintone', 'Palintone', 'mercenaries', null, 17000, 102000, ['human', 'mercenary', 'siege'], { fortification: 740 }, { ...SIEGE, mercTier: 7, authority: 10, revivalGold: 80 }),
  troop('epic-monster-hunter-7', 'Epic Monster Hunter VII', 'mercenaries', null, 3740, 11220, ['guardsman', 'mercenary'], {}, { mercTier: 7, authority: 1, revivalGold: 8, epicPct: 934 }),
  // Tier VI
  troop('archdemon', 'Archdemon', 'mercenaries', null, 180000, 540000, ['demon', 'giant', 'melee', 'mercenary'], { beast: 40, mounted: 60 }, { mercTier: 6, authority: 95, revivalGold: 760 }),
  troop('abomination', 'Abomination', 'mercenaries', null, 130000, 390000, ['barbarian', 'beast', 'melee', 'mercenary'], { elemental: 50, ranged: 60 }, { mercTier: 6, authority: 68, revivalGold: 540 }),
  troop('cursed-dendroid', 'Cursed Dendroid', 'mercenaries', null, 110000, 330000, ['cursed', 'elemental', 'melee', 'mercenary'], { dragon: 50, ranged: 65 }, { mercTier: 6, authority: 57, revivalGold: 450 }),
  troop('shedu', 'Shedu', 'mercenaries', null, 75600, 226800, ['beast', 'flying', 'mercenary', 'specialist'], { fortification: 156, human: 105, mounted: 296 }, { mercTier: 6, authority: 40, revivalGold: 320 }),
  troop('sphynx', 'Sphynx', 'mercenaries', null, 75600, 226800, ['beast', 'flying', 'guardsman', 'mercenary'], { fortification: 311, mounted: 592 }, { mercTier: 6, authority: 40, revivalGold: 320 }),
  troop('ent', 'Ent', 'mercenaries', null, 73000, 219000, ['elemental', 'elves', 'melee', 'mercenary'], { dragon: 45, ranged: 55 }, { mercTier: 6, authority: 39, revivalGold: 310 }),
  troop('bone-golem', 'Bone Golem', 'mercenaries', null, 70000, 210000, ['melee', 'mercenary', 'undead'], { dragon: 40 }, { mercTier: 6, authority: 37, revivalGold: 300 }),
  troop('death-chariot', 'Death Chariot', 'mercenaries', null, 57000, 171000, ['mercenary', 'mounted', 'undead'], { ranged: 60 }, { mercTier: 6, authority: 30, revivalGold: 240 }),
  troop('trebuchet', 'Trebuchet', 'mercenaries', null, 9500, 57000, ['human', 'mercenary', 'siege'], { fortification: 494 }, { ...SIEGE, mercTier: 6, authority: 10, revivalGold: 80 }),
  troop('chariot', 'Chariot', 'mercenaries', null, 3800, 11400, ['guardsman', 'human', 'mercenary', 'mounted'], { ranged: 493, siege: 410 }, { mercTier: 6, authority: 2, revivalGold: 16 }),
  troop('rhino-rider', 'Rhino Rider', 'mercenaries', null, 3780, 11340, ['human', 'mercenary', 'mounted', 'specialist'], { human: 105, ranged: 247, siege: 205 }, { mercTier: 6, authority: 2, revivalGold: 16 }),
  troop('arbalester', 'Arbalester', 'mercenaries', null, 1900, 5700, ['guardsman', 'human', 'mercenary', 'ranged'], { flying: 509, melee: 394 }, { mercTier: 6, authority: 1, revivalGold: 8 }),
  troop('knight', 'Knight', 'mercenaries', null, 1900, 5700, ['human', 'melee', 'mercenary', 'specialist'], { beast: 304, human: 105, mounted: 148 }, { mercTier: 6, authority: 1, revivalGold: 8 }),
  troop('legionary', 'Legionary', 'mercenaries', null, 1900, 5700, ['guardsman', 'human', 'melee', 'mercenary'], { beast: 608, mounted: 295 }, { mercTier: 6, authority: 1, revivalGold: 8 }),
  troop('trailseeker', 'Trailseeker', 'mercenaries', null, 1890, 5670, ['human', 'mercenary', 'ranged', 'specialist'], { flying: 254, human: 105, melee: 198 }, { mercTier: 6, authority: 1, revivalGold: 8 }),
  troop('epic-monster-hunter-6', 'Epic Monster Hunter VI', 'mercenaries', null, 2030, 6090, ['guardsman', 'mercenary'], {}, { mercTier: 6, authority: 1, revivalGold: 8, epicPct: 609 }),
  // Tier V
  troop('fireworm-rider', 'Fireworm Rider', 'mercenaries', null, 50000, 150000, ['demon', 'mercenary', 'mounted'], { ranged: 55 }, { mercTier: 5, authority: 48, revivalGold: 380 }),
  troop('cyclops', 'Cyclops', 'mercenaries', null, 45000, 135000, ['barbarian', 'giant', 'mercenary', 'ranged'], { beast: 40, fortification: 100, melee: 45 }, { mercTier: 5, authority: 43, revivalGold: 340 }),
  troop('ifrit', 'Ifrit', 'mercenaries', null, 44000, 132000, ['demon', 'elemental', 'flying', 'mercenary'], { dragon: 40, melee: 70 }, { mercTier: 5, authority: 42, revivalGold: 330 }),
  troop('scorpion-rider', 'Scorpion Rider', 'mercenaries', null, 37000, 111000, ['barbarian', 'mercenary', 'mounted'], { ranged: 40 }, { mercTier: 5, authority: 36, revivalGold: 280 }),
  troop('giant-zombie', 'Giant Zombie', 'mercenaries', null, 33000, 99000, ['cursed', 'giant', 'melee', 'mercenary'], { beast: 45, mounted: 70 }, { mercTier: 5, authority: 32, revivalGold: 250 }),
  troop('bull-rider', 'Bull Rider', 'mercenaries', null, 29000, 87000, ['cursed', 'mercenary', 'mounted'], { ranged: 55 }, { mercTier: 5, authority: 28, revivalGold: 220 }),
  troop('unicorn-rider', 'Unicorn Rider', 'mercenaries', null, 27000, 81000, ['elves', 'mercenary', 'mounted'], { ranged: 65 }, { mercTier: 5, authority: 26, revivalGold: 200 }),
  troop('bear', 'Bear', 'mercenaries', null, 22000, 66000, ['beast', 'elves', 'melee', 'mercenary'], { elemental: 50, mounted: 70 }, { mercTier: 5, authority: 21, revivalGold: 160 }),
  troop('gargoyle', 'Gargoyle', 'mercenaries', null, 19000, 57000, ['beast', 'flying', 'mercenary', 'undead'], { elemental: 45, mounted: 70 }, { mercTier: 5, authority: 19, revivalGold: 150 }),
  troop('scorpion', 'Scorpion', 'mercenaries', null, 5250, 32000, ['human', 'mercenary', 'siege'], { fortification: 329 }, { ...SIEGE, mercTier: 5, authority: 10, revivalGold: 80 }),
  troop('swift-marksman', 'Swift Marksman', 'mercenaries', null, 1050, 3150, ['guardsman', 'human', 'mercenary', 'ranged'], { flying: 339, melee: 263 }, { mercTier: 5, authority: 1, revivalGold: 8 }),
  troop('epic-monster-hunter-5', 'Epic Monster Hunter V', 'mercenaries', null, 1050, 3150, ['guardsman', 'mercenary'], {}, { mercTier: 5, authority: 1, revivalGold: 8, epicPct: 373 }),
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
