// Tools → Rewards: the arithmetic. Plain ESM with no DOM access, so the tests
// import it directly (tests/web/rewards-split.test.ts).
//
// A clan reward pot (Dragon Coins, clan fragments) is shared out in proportion
// to each player's score: pot × score ÷ the included players' total. Coins
// don't split, so everyone first gets that rounded down, and the units left
// over go one each to the largest fractions (the largest-remainder method). So
// every player lands on their exact share rounded down or up, and the shares
// always add up to the pot exactly.
//
// totalcalculator.org/rewards.php, which this tool replaces, lands everyone on
// that same floor-or-ceiling too. Its Dragon Coins follow largest remainder in
// every probe, ties to the earlier line. Its fragments don't: which player gets
// a leftover fragment shifts with the size of the coin pot (probed 2026-11-07:
// 500 fragments over 100/50/25 is 286/143/71 beside 500 coins and 285/143/72
// beside 501). That is an artifact of how it orders players, not a rule, so
// here both pots split the same way and a player can differ from it by one
// fragment.
//
// Exact integer arithmetic (BigInt): a damage score runs to billions and a coin
// pot to millions, and their product is past what a double holds exactly — a
// float floor would hand out a unit too many or too few at the boundaries.

/**
 * Split `pot` whole units over `weights` in proportion, by largest remainder.
 * A tie on the fraction goes to the earlier entry, as on the reference — pass
 * players in rank order and that is the higher-ranked one. Zero, negative or
 * non-numeric weights get nothing, and so does everyone when the pot or the
 * weights total nothing.
 *
 * @param {number[]} weights
 * @param {number} pot
 * @returns {number[]}
 */
export function splitPot(weights, pot) {
  const out = weights.map(() => 0);
  const units = toUnits(pot);
  const ws = weights.map((w) => toUnits(w));
  const total = ws.reduce((a, b) => a + b, 0n);
  if (units === 0n || total === 0n) return out;

  const rest = [];
  let given = 0n;
  ws.forEach((w, i) => {
    const num = units * w;
    const whole = num / total;
    out[i] = Number(whole);
    given += whole;
    if (num % total > 0n) rest.push({ i, frac: num % total });
  });
  // Fewer units are left than players with a fraction: the fractions sum to
  // exactly that many whole units.
  rest.sort((a, b) => cmp(b.frac, a.frac) || a.i - b.i);
  const left = Number(units - given);
  for (let k = 0; k < left; k++) out[rest[k].i] += 1;
  return out;
}

/** A non-negative whole number as BigInt; anything else is 0. */
function toUnits(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? BigInt(n) : 0n;
}

function cmp(a, b) {
  return a > b ? 1 : a < b ? -1 : 0;
}

/**
 * A player's score after `day` of a pasted run. The in-game ranking is
 * cumulative, so it is their total in the newest snapshot at or before that
 * day; a day they are missing from carries their earlier total forward (as on
 * the Events page). 0 when no snapshot up to that day has them.
 *
 * @param {Record<number|string, number>} cumulative pasted day → points
 * @param {number} day
 */
export function scoreAfterDay(cumulative, day) {
  let best = -1;
  let score = 0;
  for (const [k, v] of Object.entries(cumulative || {})) {
    const d = Number(k);
    if (d <= day && d > best) {
      best = d;
      score = Number(v) || 0;
    }
  }
  return score;
}

/**
 * Share both pots over the players. Excluded players weigh nothing, so what
 * would have been theirs is spread over everyone else by score.
 *
 * @template {{ score: number, included: boolean }} P
 * @param {P[]} players
 * @param {{ coins: number, fragments: number }} pots
 * @returns {{ rows: Array<P & { share: number, coins: number, fragments: number }>, scoreTotal: number, recipients: number }}
 */
export function distributeRewards(players, pots) {
  const weights = players.map((p) => (p.included ? Math.max(0, Number(p.score) || 0) : 0));
  const scoreTotal = weights.reduce((a, b) => a + b, 0);
  const coins = splitPot(weights, pots.coins);
  const fragments = splitPot(weights, pots.fragments);
  const rows = players.map((p, i) => ({
    ...p,
    share: scoreTotal > 0 ? weights[i] / scoreTotal : 0,
    coins: coins[i],
    fragments: fragments[i],
  }));
  return { rows, scoreTotal, recipients: weights.filter((w) => w > 0).length };
}

/**
 * Read a pot typed by hand: "7000000", "7,000,000", "7 000 000", or with a
 * k / m / b suffix ("7.5m", "7,5m"). Anything unreadable is 0.
 */
export function parsePot(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return 0;
  const suffix = s.match(/^(\d+(?:[.,]\d+)?)([kmb])$/);
  if (suffix) {
    const scale = { k: 1e3, m: 1e6, b: 1e9 }[suffix[2]];
    return Math.round(Number(suffix[1].replace(',', '.')) * scale);
  }
  const digits = s.replace(/[^\d]/g, '');
  return digits ? Number(digits) : 0;
}
