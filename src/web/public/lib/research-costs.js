// Research costs (Valor points per level), the Guardsmen tier totals and the
// upgrade blueprints, for Tools → Costs.
//
// Source: kingdom289.com → General tips → Costs & Upgrades, which renders the
// Google Sheet exported to src/data/researchCosts.json in taulen/kingdom289
// (Apr 2026). 418 rows over 14 research trees.
//
// Almost nothing in that sheet is unique: every 10-level research runs on one
// of 20 shared cost curves, and every one-level research (a unit tier, a
// captain, a crypt level) costs one of 18 unlock prices. So a curve is stored
// once in CURVES and a row is [name, curveKey] or [name, unlockPrice]; the page
// merges rows that cost the same (mergeRows) — that is most of what makes it
// compact. Totals are computed, never copied: the sheet's own total column has
// slips (10.8M, 198.7M and 4.3M against levels that sum to 12.8M, 200.1M, 5.7M).
//
// Fixed against the sheet, each where the sheet contradicts itself:
//   - Level 2 of the 9.6M curve: 14.0M on most trees, 19.0M on Guardsmen I and
//     Logistics. Every curve roughly doubles from level 1 to 2 — 19.0M.
//   - Monsters' March Speed III has a blank level 4; its two siblings on the
//     same curve read 400M.
//   - Army Modernization lists Ranged Units' Health V twice and no Strength V;
//     the first one sits among the Strength V rows.
//   - Spelling: Guardsmen/Specialists possessives, "Specalists'", "Effiency",
//     "Scoketing", "Combing Enchantments", "Monster III", "Scouts's", and the
//     truncated "Sacred Potion II" / "Construction III".
// Guardsmen II's VI/VII curves differ from Monsters II's and Engineer Corps
// II's in three levels (999B vs 990B, 799B vs 780B, 9,990B vs 9,900B). Nothing
// says which is right, so both are kept as given (s7g/s8g vs s7/s8).
//
// Curve keys: s = the standard ladder; p = the cheaper one Specialists, Army
// Modernization and Monsters Boost run on; m = the two Monsters-only steps.
//
// `unlockPath` marks the troop trees, where a stage's usual trio (training
// cost, march speed, carrying capacity) sits partly OFF the path: training
// cost leads to march speed, which leads to the next troops, and carrying
// capacity branches off as a dead end. Two maxed is what continuing costs —
// the sheet's own "2×10" — so a trio's row says that only PATH_PICKS of its
// total are needed (pathSkipsSome).
//
// Plain ESM, no DOM: tests/web/research-costs.test.ts imports it directly.

export const CURVES = {
  s1: [300, 700, 1800, 4500, 8900, 22_000, 45_000, 90_000, 220_000, 450_000],
  s2: [45_000, 90_000, 140_000, 230_000, 410_000, 820_000, 1.4e6, 2e6, 3.2e6, 4.5e6],
  s3: [700_000, 1.4e6, 2.1e6, 3.5e6, 6.4e6, 13e6, 21e6, 32e6, 50e6, 70e6],
  s4: [9.6e6, 19e6, 29e6, 48e6, 87e6, 170e6, 290e6, 430e6, 670e6, 960e6],
  s5: [120e6, 230e6, 350e6, 580e6, 1e9, 2.1e9, 3.5e9, 5.2e9, 8.1e9, 12e9],
  s6: [1.7e9, 3.5e9, 5.2e9, 8.6e9, 16e9, 31e9, 52e9, 78e9, 120e9, 170e9],
  s7: [16.9e9, 28e9, 47e9, 78e9, 130e9, 219e9, 317e9, 619e9, 990e9, 1.7e12],
  s7g: [16.9e9, 28e9, 47e9, 78e9, 130e9, 219e9, 317e9, 619e9, 999e9, 1.7e12],
  s8: [170e9, 280e9, 470e9, 780e9, 1.3e12, 2.2e12, 3.17e12, 6.19e12, 9.9e12, 17e12],
  s8g: [170e9, 280e9, 470e9, 799e9, 1.3e12, 2.2e12, 3.17e12, 6.19e12, 9.99e12, 17e12],
  p1: [200, 300, 800, 1900, 3900, 9700, 19_000, 39_000, 100_000, 190_000],
  p2: [20_000, 40_000, 60_000, 100_000, 180_000, 360_000, 600_000, 900_000, 1.4e6, 2e6],
  p3: [340_000, 670_000, 1e6, 1.7e6, 3e6, 6e6, 10e6, 15e6, 24e6, 34e6],
  p4: [3.9e6, 7.9e6, 12e6, 20e6, 36e6, 70e6, 120e6, 180e6, 280e6, 390e6],
  p5: [50e6, 100e6, 150e6, 250e6, 450e6, 870e6, 1.5e9, 2.2e9, 3.4e9, 4.7e9],
  p6: [600e6, 1.2e9, 1.8e9, 3e9, 5.4e9, 10.4e9, 18e9, 26.4e9, 41e9, 56e9],
  p7: [5.9e9, 9.9e9, 16.9e9, 27.9e9, 45.9e9, 77.9e9, 129e9, 219e9, 370e9, 599e9],
  p8: [59e9, 99e9, 169e9, 279e9, 459e9, 779e9, 1.29e12, 2.19e12, 3.7e12, 5.99e12],
  m1: [80e6, 160e6, 240e6, 400e6, 720e6, 1.4e9, 2.4e9, 3.6e9, 5.6e9, 8e9],
  m2: [960e6, 1.9e9, 2.9e9, 4.8e9, 8.7e9, 16.9e9, 28.9e9, 43e9, 67e9, 96e9],
};

export const TREES = [
  {
    key: 'guardsmen',
    name: 'Guardsmen',
    unlockPath: true,
    sections: [
      {
        name: 'Guardsmen I',
        rows: [
          ['Archers I', 300],
          ['Spearmen I', 300],
          ['Riders I', 300],
          ["Guardsmen's Training Cost I", 's1'],
          ["Guardsmen's Carrying Capacity I", 's1'],
          ['Archers II', 450_000],
          ['Spearmen II', 450_000],
          ['Riders II', 450_000],
          ["Guardsmen's Training Cost II", 's2'],
          ['Captain Bernard', 450_000],
          ["Guardsmen's March Speed I", 's2'],
          ['Captain Lucius', 450_000],
          ['Archers III', 8.5e6],
          ['Spearmen III', 8.5e6],
          ['Riders III', 8.5e6],
          ["Guardsmen's March Speed II", 's3'],
          ['Captain Doria', 80e6],
          ["Guardsmen's Carrying Capacity II", 's3'],
          ['Archers IV', 80e6],
          ['Spearmen IV', 80e6],
          ['Riders IV', 80e6],
          ["Guardsmen's Training Cost III", 's4'],
          ["Guardsmen's March Speed III", 's4'],
          ["Guardsmen's Carrying Capacity III", 's4'],
          ['Archers V', 900e6],
          ['Spearmen V', 900e6],
          ['Riders V', 900e6],
          ['Battle Griffin V', 900e6],
          ["Guardsmen's Training Cost IV", 's5'],
          ['Captain Brunhild', 900e6],
          ["Guardsmen's March Speed IV", 's5'],
          ["Guardsmen's Carrying Capacity IV", 's5'],
          ['Heavy Arbalester VI', 9e9],
          ['Heavy Halberdier VI', 9e9],
          ['Mounted Knight VI', 9e9],
          ['Battle Griffin VI', 9e9],
          ["Guardsmen's Training Cost V", 's6'],
          ["Guardsmen's March Speed V", 's6'],
          ["Guardsmen's Carrying Capacity V", 's6'],
          ['Heavy Arbalester VII', 90e9],
          ['Heavy Halberdier VII', 90e9],
          ['Mounted Knight VII', 90e9],
          ['Battle Griffin VII', 90e9],
        ],
      },
      {
        name: 'Guardsmen II',
        rows: [
          ["Guardsmen's Training Cost VI", 's7g'],
          ["Guardsmen's Carrying Capacity VI", 's7g'],
          ["Guardsmen's March Speed VI", 's7g'],
          ['Purifier I', 900e9],
          ['Punisher I', 900e9],
          ['Smiter I', 900e9],
          ['Corax I', 900e9],
          ["Guardsmen's Training Cost VII", 's8g'],
          ["Guardsmen's Carrying Capacity VII", 's8g'],
          ["Guardsmen's March Speed VII", 's8g'],
          ['Purifier II', 9e12],
          ['Punisher II', 9e12],
          ['Smiter II', 9e12],
          ['Corax II', 9e12],
        ],
      },
    ],
  },
  {
    key: 'specialists',
    name: 'Specialists',
    unlockPath: true,
    sections: [
      {
        name: 'Specialists I',
        rows: [
          ['Swordsmen I', 200],
          ['Spies I', 200],
          ["Specialists' Training Cost I", 'p1'],
          ["Specialists' Carrying Capacity I", 'p1'],
          ['Swordsmen II', 120_000],
          ['Spies II', 120_000],
          ["Specialists' Training Cost II", 'p2'],
          ['Captain Ye Ho-Sung', 120_000],
          ["Specialists' March Speed I", 'p2'],
          ['Swordsmen III', 2.5e6],
          ['Spies III', 2.5e6],
          ["Specialists' March Speed II", 'p3'],
          ['Captain Dustan', 22e6],
          ["Specialists' Carrying Capacity II", 'p3'],
          ['Swordsmen IV', 22e6],
          ['Spies IV', 22e6],
          ["Specialists' Training Cost III", 'p4'],
          ["Specialists' Carrying Capacity III", 'p4'],
          ["Specialists' March Speed III", 'p4'],
          ['Spies V', 300e6],
          ['Vultures V', 300e6],
          ['Swordsmen V', 300e6],
          ['Deadshots V', 300e6],
          ['Lion Riders V', 300e6],
          ["Specialists' Training Cost IV", 'p5'],
          ["Specialists' Carrying Capacity IV", 'p5'],
          ["Specialists' March Speed IV", 'p5'],
          ['Swift Jaeger VI', 3e9],
          ['Vultures VI', 3e9],
          ['Deadshots VI', 3e9],
          ['Heavy Knight VI', 3e9],
          ['Lion Riders VI', 3e9],
          ["Specialists' Training Cost V", 'p6'],
          ["Specialists' Carrying Capacity V", 'p6'],
          ["Specialists' March Speed V", 'p6'],
          ['Swift Jaeger VII', 30e9],
          ['Vultures VII', 30e9],
          ['Heavy Knight VII', 30e9],
          ['Deadshots VII', 30e9],
          ['Lion Riders VII', 30e9],
        ],
      },
      {
        name: 'Specialists II',
        rows: [
          ["Specialists' Training Cost VI", 'p7'],
          ["Specialists' Carrying Capacity VI", 'p7'],
          ["Specialists' March Speed VI", 'p7'],
          ['Panoptic I', 300e9],
          ['Royal Lion I', 300e9],
          ['Duelist I', 300e9],
          ['Legitimist I', 300e9],
          ['Whitemane I', 300e9],
          ["Specialists' Training Cost VII", 'p8'],
          ["Specialists' Carrying Capacity VII", 'p8'],
          ["Specialists' March Speed VII", 'p8'],
          ['Panoptic II', 3e12],
          ['Royal Lion II', 3e12],
          ['Duelist II', 3e12],
          ['Legitimist II', 3e12],
          ['Whitemane II', 3e12],
        ],
      },
    ],
  },
  {
    key: 'engineers',
    name: 'Engineer Corps',
    unlockPath: true,
    sections: [
      {
        name: 'Engineer Corps I',
        rows: [
          ['City Walls I', 300],
          ['Catapults I', 300],
          ["Siege Engines' Training Cost I", 's1'],
          ["Siege Engines' Carrying Capacity I", 's1'],
          ['City Walls II', 450_000],
          ['Catapults II', 450_000],
          ["Siege Engines' Training Cost II", 's2'],
          ['Captain Brann', 450_000],
          ["Siege Engines' March Speed I", 's2'],
          ['City Walls III', 8.5e6],
          ['Catapults III', 8.5e6],
          ["Siege Engines' March Speed II", 's3'],
          ["Siege Engines' Carrying Capacity II", 's3'],
          ['City Walls IV', 80e6],
          ['Catapults IV', 80e6],
          ["Siege Engines' Training Cost III", 's4'],
          ["Siege Engines' March Speed III", 's4'],
          ["Siege Engines' Carrying Capacity III", 's4'],
          ['City Walls V', 900e6],
          ['Catapults V', 900e6],
          ["Siege Engines' Training Cost IV", 's5'],
          ["Siege Engines' March Speed IV", 's5'],
          ["Siege Engines' Carrying Capacity IV", 's5'],
          ['City Walls VI', 9e9],
          ['Ballistae VI', 9e9],
          ["Siege Engines' Training Cost V", 's6'],
          ["Siege Engines' March Speed V", 's6'],
          ["Siege Engines' Carrying Capacity V", 's6'],
          ['City Walls VII', 90e9],
          ['Ballistae VII', 90e9],
        ],
      },
      {
        name: 'Engineer Corps II',
        rows: [
          ["Siege Engines' Training Cost VI", 's7'],
          ["Siege Engines' March Speed VI", 's7'],
          ["Siege Engines' Carrying Capacity VI", 's7'],
          ['Fortress Walls I', 900e9],
          ['Josephine I', 900e9],
          ["Siege Engines' Training Cost VII", 's8'],
          ["Siege Engines' March Speed VII", 's8'],
          ["Siege Engines' Carrying Capacity VII", 's8'],
          ['Fortress Walls II', 9e12],
          ['Josephine II', 9e12],
        ],
      },
    ],
  },
  {
    key: 'monsters',
    name: 'Monsters',
    unlockPath: true,
    sections: [
      {
        name: 'Monsters I',
        rows: [
          ['Monsters III', 8.5e6],
          ["Monsters' Cost I", 's3'],
          ["Monsters' March Speed I", 's3'],
          ["Monsters' Carrying Capacity I", 's3'],
          ['Monsters IV', 80e6],
          ["Monsters' March Speed II", 's4'],
          ["Monsters' Cost II", 's4'],
          ['Monsters V', 900e6],
          ['Captain Ingrid', 900e6],
          ["Monsters' March Speed III", 'm1'],
          ["Monsters' Carrying Capacity II", 'm1'],
          ["Monsters' Cost III", 'm1'],
          ['Monsters VI', 9e9],
          ["Monsters' March Speed IV", 'm2'],
          ["Monsters' Carrying Capacity III", 'm2'],
          ["Monsters' Cost IV", 'm2'],
          ['Monsters VII', 90e9],
        ],
      },
      {
        name: 'Monsters II',
        rows: [
          ["Monsters' Cost V", 's7'],
          ["Monsters' Carrying Capacity IV", 's7'],
          ["Monsters' March Speed V", 's7'],
          ['Monsters I', 900e9],
          ["Monsters' Cost VI", 's8'],
          ["Monsters' Carrying Capacity V", 's8'],
          ["Monsters' March Speed VI", 's8'],
          ['Monsters II', 9e12],
        ],
      },
    ],
  },
  {
    key: 'monsters-boost',
    name: 'Monsters Boost',
    sections: [
      {
        name: 'Monsters Boost',
        rows: [
          ["Beasts' Strength I", 'p3'],
          ["Giants' Strength I", 'p3'],
          ["Elementals' Strength I", 'p3'],
          ["Dragons' Strength I", 'p3'],
          ["Beasts' Health I", 'p3'],
          ["Giants' Health I", 'p3'],
          ["Elementals' Health I", 'p3'],
          ["Dragons' Health I", 'p3'],
          ["Beasts' Strength II", 'p4'],
          ["Giants' Strength II", 'p4'],
          ["Elementals' Strength II", 'p4'],
          ["Dragons' Strength II", 'p4'],
          ["Beasts' Health II", 'p4'],
          ['Chance for Beasts to Strike Two Squads', 'p4'],
          ["Elementals' Health II", 'p4'],
          ['Chance for Elementals to Strike Two Squads', 'p4'],
          ["Giants' Health II", 'p4'],
          ['Chance for Giants to Strike Two Squads', 'p4'],
          ["Dragons' Health II", 'p4'],
          ['Chance for Dragons to Strike Two Squads', 'p4'],
          ["Beasts' Strength III", 'p5'],
          ['Chance for Beasts to Block a Strike', 'p5'],
          ["Beasts' Health III", 'p5'],
          ["Elementals' Strength III", 'p5'],
          ['Chance for Elementals to Block a Strike', 'p5'],
          ["Elementals' Health III", 'p5'],
          ["Giants' Strength III", 'p5'],
          ['Chance for Giants to Block a Strike', 'p5'],
          ["Giants' Health III", 'p5'],
          ["Dragons' Strength III", 'p5'],
          ['Chance for Dragons to Block a Strike', 'p5'],
          ["Dragons' Health III", 'p5'],
        ],
      },
    ],
  },
  {
    key: 'army',
    name: 'Army Modernization',
    sections: [
      {
        name: 'Army Modernization',
        rows: [
          ['Army Strength I', 'p1'],
          ['Army Health I', 'p1'],
          ['Strength of Fortifications I', 'p1'],
          ["Mounted Units' Strength I", 'p1'],
          ["Melee Units' Strength I", 'p1'],
          ["Ranged Units' Strength I", 'p1'],
          ["Siege Engines' Strength I", 'p2'],
          ['Health of Fortifications I', 'p2'],
          ["Flying Units' Strength I", 'p2'],
          ["Flying Units' Health I", 'p2'],
          ["Scouts' Strength I", 'p2'],
          ["Ranged Units' Health I", 'p2'],
          ["Mounted Units' Health I", 'p2'],
          ["Melee Units' Health I", 'p2'],
          ["Siege Engines' Health I", 'p2'],
          ["Flying Units' Strength II", 'p3'],
          ["Scouts' Health I", 'p2'],
          ["Flying Units' Health II", 'p3'],
          ["Ranged Units' Strength II", 'p3'],
          ["Mounted Units' Strength II", 'p3'],
          ["Melee Units' Strength II", 'p3'],
          ["Ranged Units' Health II", 'p3'],
          ["Mounted Units' Health II", 'p3'],
          ["Melee Units' Health II", 'p3'],
          ["Siege Engines' Strength II", 'p3'],
          ["Siege Engines' Health II", 'p3'],
          ['Captain Proscope', 22e6],
          ['Strength of Fortifications II', 'p3'],
          ['Health of Fortifications II', 'p3'],
          ["Scouts' Strength II", 'p4'],
          ["Scouts' Health II", 'p4'],
          ["Ranged Units' Strength III", 'p4'],
          ["Mounted Units' Strength III", 'p4'],
          ["Melee Units' Strength III", 'p4'],
          ["Ranged Units' Health III", 'p4'],
          ["Mounted Units' Health III", 'p4'],
          ["Melee Units' Health III", 'p4'],
          ["Flying Units' Strength III", 'p4'],
          ["Flying Units' Health III", 'p4'],
          ["Siege Engines' Strength III", 'p4'],
          ["Siege Engines' Health III", 'p4'],
          ['Strength of Fortifications III', 'p4'],
          ['Health of Fortifications III', 'p4'],
          ["Scouts' Strength III", 'p5'],
          ["Scouts' Health III", 'p5'],
          ["Ranged Units' Strength IV", 'p5'],
          ["Mounted Units' Strength IV", 'p5'],
          ["Melee Units' Strength IV", 'p5'],
          ["Ranged Units' Health IV", 'p5'],
          ["Mounted Units' Health IV", 'p5'],
          ["Melee Units' Health IV", 'p5'],
          ["Flying Units' Health IV", 'p5'],
          ["Flying Units' Strength IV", 'p5'],
          ["Siege Engines' Strength IV", 'p5'],
          ["Siege Engines' Health IV", 'p5'],
          ['Strength of Fortifications IV', 'p5'],
          ['Health of Fortifications IV', 'p5'],
          ["Scouts' Strength IV", 'p6'],
          ["Scouts' Health IV", 'p6'],
          ["Ranged Units' Strength V", 'p6'],
          ["Mounted Units' Strength V", 'p6'],
          ["Melee Units' Strength V", 'p6'],
          ["Siege Engines' Strength V", 'p6'],
          ["Siege Engines' Health V", 'p6'],
          ['Strength of Fortifications V', 'p6'],
          ['Health of Fortifications V', 'p6'],
          ["Scouts' Strength V", 'p6'],
          ["Scouts' Health V", 'p6'],
          ["Ranged Units' Health V", 'p6'],
          ["Mounted Units' Health V", 'p6'],
          ["Melee Units' Health V", 'p6'],
          ["Flying Units' Strength V", 'p6'],
          ["Flying Units' Health V", 'p6'],
        ],
      },
    ],
  },
  {
    key: 'economy',
    name: 'Economy',
    sections: [
      {
        name: 'Economy',
        rows: [
          ['Stone Production I', 's1'],
          ['Iron Production I', 's1'],
          ['Lumber Production I', 's1'],
          ['Warehouse Capacity I', 's1'],
          ['Construction Speed I', 's2'],
          ['Training Queue Limit I', 's1'],
          ['Food Production I', 's1'],
          ['Silver Production I', 's1'],
          ['Research Speed I', 's2'],
          ['Sacred Potion Production I', 's2'],
          ['Stone Production II', 's2'],
          ['Iron Production II', 's2'],
          ['Lumber Production II', 's2'],
          ['Warehouse Capacity II', 's2'],
          ['Training Queue Limit II', 's2'],
          ['Silver Production II', 's3'],
          ['Food Production II', 's3'],
          ['Research Speed II', 's3'],
          ['Construction Speed II', 's3'],
          ['Sacred Potion Production II', 's4'],
          ['Stone Production III', 's3'],
          ['Iron Production III', 's3'],
          ['Lumber Production III', 's3'],
          ['Training Queue Limit III', 's4'],
          ['Warehouse Capacity III', 's4'],
          ['Construction Speed III', 's4'],
          ['Food Production III', 's4'],
          ['Silver Production III', 's4'],
          ['Research Speed III', 's4'],
          ['Sacred Potion Production III', 's5'],
        ],
      },
    ],
  },
  {
    key: 'logistics',
    name: 'Logistics',
    sections: [
      {
        name: 'Logistics',
        rows: [
          ['Resource Gathering on the World Map I', 's1'],
          ['Troop Marching Range I', 's1'],
          ['Caravan Speed I', 's1'],
          ['Caravan Carrying Capacity I', 's1'],
          ['Portal Duration I', 's2'],
          ['Crypt March Range I', 's2'],
          ['Maximum Portals', 8.5e6],
          ['Resource Gathering Speed II', 's2'],
          ['Caravan Speed II', 's2'],
          ['Caravan Carrying Capacity II', 's2'],
          ['Troop Marching Range II', 's2'],
          ['Resource Gathering Speed III', 's3'],
          ['Portal Duration II', 's3'],
          ['Maximum Portals II', 80e6],
          ['Caravan Speed III', 's3'],
          ['Caravan Carrying Capacity III', 's3'],
          ['Crypt March Range II', 's3'],
          ['Captain Stror', 80e6],
          ['Portal Duration III', 's4'],
          ['Troop Marching Range III', 's4'],
          ['Maximum Portals III', 900e6],
          ['Crypt March Range III', 's4'],
          ['Resource Gathering on the World Map IV', 's4'],
        ],
      },
    ],
  },
  {
    key: 'archeology',
    name: 'Archeology',
    sections: [
      {
        name: 'Archeology',
        rows: [
          ['Tar Production I', 's1'],
          ['Tar Capacity I', 's1'],
          ['Crypt Exploration Efficiency I', 's1'],
          ['Crypts II', 450_000],
          ['Tar Production II', 's2'],
          ['Tar Capacity II', 's2'],
          ['Chance to Explore Twice I', 's2'],
          ['Crypt Exploration Cost I', 's2'],
          ['Crypts III', 8.5e6],
          ['Tar Production III', 's3'],
          ['Tar Capacity III', 's3'],
          ['Crypt Exploration Efficiency II', 's3'],
          ['Captain Carter', 80e6],
          ['Crypts IV', 80e6],
          ['Crypt Exploration Efficiency III', 's4'],
          ['Crypt Exploration Cost II', 's4'],
          ['Chance to Explore Twice II', 's4'],
          ['Crypts V', 900e6],
          ['Tar Capacity IV', 's5'],
          ['Tar Production IV', 's5'],
          ['Common Crypt Exploration Efficiency I', 's5'],
          ['Common Crypt Exploration Cost I', 's5'],
          ['Rare Crypt Exploration Efficiency I', 's5'],
          ['Rare Crypt Exploration Cost I', 's5'],
          ['Epic Crypt Exploration Efficiency I', 's5'],
          ['Epic Crypt Exploration Cost I', 's5'],
          ['Crypts VI', 9e9],
          ['Tar Production V', 's6'],
          ['Tar Capacity V', 's6'],
          ['Common Crypt Exploration Efficiency II', 's6'],
          ['Common Crypt Exploration Cost II', 's6'],
          ['Rare Crypt Exploration Efficiency II', 's6'],
          ['Rare Crypt Exploration Cost II', 's6'],
          ['Epic Crypt Exploration Efficiency II', 's6'],
          ['Epic Crypt Exploration Cost II', 's6'],
          ['Crypts VII', 90e9],
        ],
      },
    ],
  },
  {
    key: 'blacksmithing',
    name: 'Blacksmithing',
    sections: [
      {
        name: 'Blacksmithing',
        rows: [
          ['Equipment Crafting Cost I', 's1'],
          ['Equipment Crafting Speed I', 's1'],
          ['Combining Gems I', 450_000],
          ['Combining Enchantments I', 450_000],
          ['Gem Crafting I', 450_000],
          ['Gem and Enchantment Socketing I', 450_000],
          ['Material Quality Choice I', 450_000],
          ['Increased Equipment Durability I', 450_000],
          ['Enchantment Saving Chance I', 's2'],
          ['Gem Saving Chance I', 's2'],
          ['Equipment Repair Cost I', 's2'],
          ['Enchantment Crafting Speed II', 's2'],
          ['Material Saving Chance I', 's2'],
          ['Combining Gems II', 8.5e6],
          ['Combining Enchantments II', 8.5e6],
          ['Gem Crafting II', 8.5e6],
          ['Gem and Enchantment Socketing II', 8.5e6],
          ['Material Quality Choice II', 8.5e6],
          ['Increased Equipment Durability II', 8.5e6],
          ['Enchantment Saving Chance II', 's3'],
          ['Gem Saving Chance II', 's3'],
          ['Equipment Crafting Cost II', 's3'],
          ['Equipment Crafting Speed III', 's3'],
          ['Equipment Repair Cost II', 's3'],
          ['Material Saving Chance II', 's3'],
          ['Combining Gems III', 80e6],
          ['Combining Enchantments III', 80e6],
          ['Gem Crafting III', 80e6],
          ['Gem and Enchantment Socketing III', 80e6],
          ['Equipment Durability Increase III', 80e6],
          ['Material Quality Choice III', 80e6],
          ['Equipment Repair Cost III', 's4'],
          ['Gem Saving Chance III', 's4'],
          ['Enchantment Saving Chance III', 's4'],
          ['Equipment Crafting Cost III', 's4'],
          ['Material Saving Chance III', 's4'],
          ['Equipment Repair Cost IV', 's5'],
          ['Combining Gems IV', 900e6],
          ['Combining Enchantments IV', 900e6],
          ['Gem Crafting IV', 900e6],
          ['Gem and Enchantment Socketing IV', 900e6],
          ['Equipment Durability Increase IV', 900e6],
          ['Material Quality Choice IV', 900e6],
          ['Material Saving Chance IV', 's5'],
          ['Enchantment Saving Chance IV', 's5'],
          ['Gem Saving Chance IV', 's5'],
        ],
      },
    ],
  },
];

/** All 10 levels of a curve, summed. */
export function curveTotal(key) {
  return CURVES[key].reduce((a, b) => a + b, 0);
}

/**
 * A section's rows with everything that costs the same merged into one group,
 * cheapest level 1 first — which is also the order the tree unlocks them in.
 * Names keep the sheet's order inside a group. `total` is ONE of them: a
 * research maxed, or the unlock price — rowTotal() is the whole row.
 *
 * @returns {{ curve: string|null, unlock: number|null, names: string[], first: number, total: number }[]}
 */
export function mergeRows(rows) {
  const groups = new Map();
  rows.forEach(([name, cost], order) => {
    const isCurve = typeof cost === 'string';
    const key = isCurve ? `c:${cost}` : `u:${cost}`;
    let g = groups.get(key);
    if (!g) {
      g = isCurve
        ? { curve: cost, unlock: null, names: [], first: CURVES[cost][0], total: curveTotal(cost), order }
        : { curve: null, unlock: cost, names: [], first: cost, total: cost, order };
      groups.set(key, g);
    }
    g.names.push(name);
  });
  return [...groups.values()]
    .sort((a, b) => a.first - b.first || a.order - b.order)
    .map(({ order, ...g }) => g);
}

/**
 * The sheet's Guardsmen tier overview: a tier costs its unit unlock plus two
 * maxed 10-level researches from the stage before ("2×10", PATH_PICKS). Computed from the
 * curves, so G8 reads 9.21T where the sheet doubled a rounded 4.2T into 9.3T.
 */
export const GUARDSMEN_TIERS = [
  { tier: 'G4', unlock: 80e6, research: 's3' },
  { tier: 'G5', unlock: 900e6, research: 's4' },
  { tier: 'G6', unlock: 9e9, research: 's5' },
  { tier: 'G7', unlock: 90e9, research: 's6' },
  { tier: 'G8', unlock: 900e9, research: 's7g' },
];

export function tierTotal(tier) {
  return tier.unlock + PATH_PICKS * curveTotal(tier.research);
}

/** Researches of a stage a troop tree needs maxed to reach the next troops. */
export const PATH_PICKS = 2;

/** A merged row's total: every research in it maxed, or every unlock bought. */
export function rowTotal(group) {
  return group.total * group.names.length;
}

/**
 * True when a merged row holds more researches than continuing needs — a
 * troop-tree trio, where the path takes two and carrying capacity is a dead end.
 */
export function pathSkipsSome(tree, group) {
  return Boolean(tree.unlockPath) && group.curve !== null && group.names.length > PATH_PICKS;
}

/** Blueprints per upgrade level, and their Gold: 10 per blueprint at every level. */
export const BLUEPRINTS = [
  [10, 320],
  [15, 2450],
  [20, 10_400],
  [25, 25_600],
  [30, 51_000],
  [35, 112_000],
  [40, 196_000],
  [45, 343_000],
].map(([level, blueprints]) => ({ level, blueprints, gold: blueprints * 10 }));
