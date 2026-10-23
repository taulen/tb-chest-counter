// Ancient planner — the arithmetic behind Tools → Ancient planner.
//
// A replica of totalcalculator.org/summons.php ("Ancient planning calculator").
// That page computes server-side and publishes no source, so every constant
// here was MEASURED: the form is a plain GET, and controlled inputs (one member
// at one tier, one variable at a time) were fed to it and the outputs fitted.
// tests/web/ancient-planner.test.ts replays recorded outputs against this
// module, so a changed constant fails the suite rather than quietly drifting.
// The derivation lives in docs/ancient-planner.md.
//
// The model, in game terms:
//  - Ancients' Treasure: every member raids a vault whose level their guards
//    level caps, and the clan banks the vault points — the pot.
//  - The pot buys three clan artifacts that share ONE cumulative cost ladder
//    (28 levels): the Enchanted Figurine (summons), the Tome of Knowledge
//    (bonus %) and the Mysterious Clock (minutes each Tin Man stays).
//    The planner buys the Figurine for N summons and the chosen Tome level,
//    and the Clock gets whatever is left.
//  - Rise of the Ancients: every summon is fought as a kill, at the clan's
//    Tin Man level, rising one level per kill. What the clan must score is the
//    HP of those kills times (1 + Tome bonus), split across members by a fixed
//    weight per tier.
//
// Plain ESM, no DOM access — imported by pages/tools.js and by the test suite.

/** Per tier: vault points banked, vault points when "tricked" one vault level
 *  above the cap, and the relative share of the score one member is asked for.
 *  T9 (maxed on G, S, M and E) raids the same vault as a G9 but carries 1.75×
 *  the share. The weight ratios between neighbours are 1.75, 2.25, 2.5, 2.5,
 *  3, 3, 4, 5, 4 — the reference author calls them "chosen somewhat
 *  arbitrarily", so they are a planning convention, not a game constant. */
export const TIERS = [
  { key: 't9', label: 'T9', vault: 8200, trickVault: 8200, weight: 17718.75 },
  { key: 'g9', label: 'G9', vault: 8200, trickVault: 8200, weight: 10125 },
  { key: 'g8', label: 'G8', vault: 6300, trickVault: 8200, weight: 4500 },
  { key: 'g7', label: 'G7', vault: 4800, trickVault: 5100, weight: 1800 },
  { key: 'g6', label: 'G6', vault: 3700, trickVault: 3900, weight: 720 },
  { key: 'g5', label: 'G5', vault: 2900, trickVault: 3000, weight: 240 },
  { key: 'g4', label: 'G4', vault: 2200, trickVault: 2300, weight: 80 },
  { key: 'g3', label: 'G3', vault: 1700, trickVault: 1800, weight: 20 },
  { key: 'g2', label: 'G2', vault: 1300, trickVault: 1400, weight: 4 },
  { key: 'g1', label: 'G1', vault: 1000, trickVault: 1100, weight: 1 },
];

/** Cumulative vault points to take ANY of the three artifacts to level 1…28. */
export const ARTIFACT_LEVEL_COSTS = [
  0, 1800, 3900, 6000, 8100, 10200, 12900, 15800, 19000, 22300,
  27800, 34300, 41300, 48700, 57400, 65900, 79000, 93000, 109000, 126000,
  153000, 185000, 230000, 278000, 339000, 404000, 486000, 572000,
];

/** Tome of Knowledge bonus (%) at levels 1…28 — the only bonus values the
 *  reference accepts. Scales the points needed, not the number of hits. */
export const TOME_BONUS_PCT = [
  0, 4, 7, 9, 12, 14, 17, 19, 22, 24, 27, 29, 32, 34, 37, 39, 42, 44, 47, 49,
  52, 54, 57, 59, 65, 70, 80, 100,
];

/** Mysterious Clock minutes per summon at levels 1…28. */
export const CLOCK_MINUTES = [
  2, 3, 5, 7, 9, 11, 13, 15, 17, 19, 22, 25, 28, 31, 34, 37, 40, 43, 46, 49,
  52, 55, 58, 61, 75, 90, 105, 120,
];

/** Figurine level that buys 1…8 summons. 7 and 8 follow the reference
 *  calculator (levels 22 and 24); the TB Clan Portal planner documents levels
 *  21 and 23 instead (153k / 230k) — unverified in game either way. */
export const FIGURINE_LEVEL_FOR_SUMMONS = [1, 2, 6, 10, 14, 18, 22, 24];

export const MAX_SUMMONS = FIGURINE_LEVEL_FOR_SUMMONS.length;
export const MIN_TINMAN_LEVEL = 1;
export const MAX_TINMAN_LEVEL = 250;

/** Measured HP of levels 152…250 (millions). Below 152 the HP is an exact
 *  multiplier chain (tinManHp); above it the reference no longer fits any
 *  clean multiplier — the bump at 184–185 reads like observed in-game values —
 *  so these were pinned by intersecting the rounding intervals of many scaled
 *  readings per level. Accurate to ±0.04%, far inside the 3 significant
 *  figures the planner shows. */
const HP_152_TO_250_M = [
  870.417, 899.904, 930.453, 962.16, 994.714, 1028.62, 1063.61, 1099.61,
  1137.16, 1175.78, 1215.96, 1257.1, 1299.69, 1344, 1389.77, 1436.93,
  1486, 1536.43, 1588.62, 1641.85, 1696.83, 1754.09, 1812.5, 1872.89,
  1935.72, 2000.82, 2067.82, 2136.89, 2208.23, 2282.5, 2359.04, 2438.26,
  2535.89, 2636.88, 2722.77, 2811.61, 2888.25, 2975.3, 3064.8, 3157.26,
  3251.47, 3348.72, 3449.66, 3552.74, 3658.83, 3768.91, 3881.94, 3998.61,
  4119.2, 4241.96, 4369.33, 4500.04, 4635.58, 4773.94, 4917.6, 5064.95,
  5217.18, 5374.22, 5534.61, 5700.97, 5871.85, 6047.96, 6229.48, 6416.38,
  6608.94, 6807.3, 7010.34, 7222.42, 7438.71, 7661.65, 7891.58, 8128.42,
  8371.42, 8623.94, 8881.91, 9149.09, 9422.29, 9705.13, 9997.29, 10296.4,
  10606.3, 10922.9, 11252.7, 11588.6, 11935.5, 12293.5, 12663.8, 13044,
  13434.7, 13836.5, 14252.8, 14680.8, 15123.3, 15573.3, 16041.4, 16522.9,
  17018.1, 17527.9, 18054.6,
];

/** Per-level growth below 152: [first level the multiplier applies to, multiplier]. */
const HP_GROWTH = [[2, 1.5], [7, 1.3], [12, 1.2], [32, 1.12], [52, 1.05], [101, 1.04]];

const HP_TABLE = (() => {
  const t = [0, 1000];
  for (let level = 2; level <= 151; level++) {
    let mult = 1;
    for (const [from, m] of HP_GROWTH) if (level >= from) mult = m;
    t.push(t[level - 1] * mult);
  }
  for (const m of HP_152_TO_250_M) t.push(m * 1e6);
  return t;
})();

/** Clamp to a whole Tin Man level. Past 250 the reference keeps using 250's HP. */
export function clampTinManLevel(level) {
  const n = Math.round(Number(level));
  if (!Number.isFinite(n)) return MIN_TINMAN_LEVEL;
  return Math.min(MAX_TINMAN_LEVEL, Math.max(MIN_TINMAN_LEVEL, n));
}

/** HP of one Tin Man at `level` (clamped to 1…250). */
export function tinManHp(level) {
  return HP_TABLE[clampTinManLevel(level)];
}

/** Tome level (1…28) for a bonus %, or null when the bonus isn't a real level. */
export function tomeLevelForBonus(bonusPct) {
  const i = TOME_BONUS_PCT.indexOf(Number(bonusPct));
  return i === -1 ? null : i + 1;
}

const pctWhole = (v) => Math.min(100, Math.max(0, Number(v) || 0));
const pct = (v) => pctWhole(v) / 100;
const count = (v) => Math.max(0, Math.floor(Number(v) || 0));

/**
 * The clan's vault-point pot. `trickPct` of members place a vault one level
 * above their cap; `missingPct` of the whole pot is written off as no-shows.
 * Floored, as the reference does.
 */
export function vaultPot(counts, { missingPct = 0, trickPct = 0 } = {}) {
  // In whole-percent units, so whole inputs stay exact: 1300 × (1 − 0.33) in
  // floats is 870.999…, which floors to 870 where the reference says 871.
  const trick = pctWhole(trickPct);
  const kept = 100 - pctWhole(missingPct);
  let raw = 0;
  for (const t of TIERS) {
    raw += count(counts[t.key]) * (t.vault * (100 - trick) + t.trickVault * trick);
  }
  return Math.floor((raw * kept) / 10_000 + 1e-9);
}

/**
 * Every summon option 1…8 for one set of inputs.
 *
 * @param {object} input
 * @param {Record<string, number>} input.counts  members per tier key (t9, g9 … g1)
 * @param {number} input.bonusPct    Tome bonus — one of TOME_BONUS_PCT
 * @param {number} input.missingPct  share of the pot lost to no-shows
 * @param {number} input.trickPct    share of members who trick one vault level up
 * @param {number} input.marginPct   expected overshoot; each target is divided by (1 + margin)
 * @param {number} input.level       Tin Man level the first summon meets
 */
export function planAncients(input) {
  const bonusPct = Number(input.bonusPct) || 0;
  const tomeLevel = tomeLevelForBonus(bonusPct) ?? 1;
  const tomeCost = ARTIFACT_LEVEL_COSTS[tomeLevel - 1];
  const pot = vaultPot(input.counts, input);
  const level = clampTinManLevel(input.level);
  const overshoot = 1 + pct(input.marginPct);
  const weightTotal = TIERS.reduce((a, t) => a + count(input.counts[t.key]) * t.weight, 0);

  const options = [];
  let hpTotal = 0;
  for (let summons = 1; summons <= MAX_SUMMONS; summons++) {
    hpTotal += tinManHp(level + summons - 1);
    const figurineCost = ARTIFACT_LEVEL_COSTS[FIGURINE_LEVEL_FOR_SUMMONS[summons - 1] - 1];
    const left = pot - figurineCost - tomeCost;

    let clockLevel = null;
    if (left >= 0) {
      clockLevel = 1;
      for (let l = 2; l <= ARTIFACT_LEVEL_COSTS.length; l++) {
        if (ARTIFACT_LEVEL_COSTS[l - 1] <= left) clockLevel = l;
      }
    }

    const requirement = hpTotal * (1 + bonusPct / 100);
    /** @type {Record<string, number | null>} tier key → points each, null with nobody to split across */
    const perMember = {};
    for (const t of TIERS) {
      perMember[t.key] = weightTotal > 0 ? (requirement * t.weight) / weightTotal / overshoot : null;
    }

    options.push({
      summons,
      attainable: left >= 0,
      /** Vault points still missing — 0 when attainable. */
      short: left >= 0 ? 0 : -left,
      minutes: clockLevel === null ? null : CLOCK_MINUTES[clockLevel - 1],
      clockLevel,
      /** Vault points left after the Clock — null when unattainable. */
      leftover: clockLevel === null ? null : left - ARTIFACT_LEVEL_COSTS[clockLevel - 1],
      /** Tin Man level after the last kill. */
      endLevel: clampTinManLevel(level + summons),
      requirement,
      perMember,
    });
  }

  return { pot, tomeLevel, tomeCost, level, weightTotal, options };
}

const SUFFIXES = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];

/** 3 significant figures with a K/M/B/T suffix, as the reference prints them. */
export function formatCompact(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  for (const [scale, suffix] of SUFFIXES) {
    // Round first so 999,600 reads "1M", not "1000K".
    if (Math.abs(Number(value.toPrecision(3))) >= scale) {
      return `${Number((value / scale).toPrecision(3))}${suffix}`;
    }
  }
  return String(Number(value.toPrecision(3)));
}
