import type { ClanMember } from '../models/types.js';
import {
  foldDiacritics, despace, despaceKeepingCase, namesDifferByAltSuffix,
} from '../vision/ocr-normalize.js';

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// Accented characters (è, À, ü, …) must compare equal to their ASCII base letter on both
// the OCR output side and the DB-stored name side. foldDiacritics is the one shared copy —
// this module had its own, and the chest-name and source-key matchers had none, which is
// how "Jörmungandr" ended up recorded twice.
function prepareForMatch(raw: string): string {
  return foldDiacritics(raw.trim().toLowerCase().replace(/\s+/g, ' '));
}

/**
 * Distances are measured on the DESPACED key, not on `prepareForMatch`'s output.
 *
 * `prepareForMatch` collapses runs of whitespace but keeps single spaces, and that
 * one space is the difference between this matcher working and not working at all.
 * A player written out letter-by-letter in game — "J I Z Z I C A" — reads back from
 * OCR with the gaps in different places every scan, and against the spaced original
 * "jizzica" is SIX edits away. Nothing this side of a budget of 6 (which would let
 * unrelated players absorb each other wholesale) could match it, so the might
 * capture and the resource reader minted a fresh member row per spelling and left
 * the admin to merge them by hand, over and over.
 *
 * Despacing first removes the problem instead of budgeting for it: every spacing
 * variant is the same key, and the 2-edit budget is left to cover real character
 * damage. `matchKnownPlayer` on the gift-scan side has always compared this way —
 * this is what brings the other two paths into line with it.
 */
function prepareKey(raw: string): string {
  return despace(raw);
}

/** Same key minus the case fold, for the case-divergence check below. */
function prepareKeyKeepingCase(raw: string): string {
  return despaceKeepingCase(raw);
}

/**
 * Edit-distance budget for a fuzzy name match: 2 for names of 6+ characters, 1 below
 * that. Deliberately identical to the budget matchKnownPlayer uses on the scan side,
 * so a name behaves the same whether it arrives from a gift scan or a resource import.
 *
 * This was `max(len) / 3` — up to 4 edits on a 12-character name. That was set for
 * Tesseract (937dcc9), and one of the three edits it budgeted for was a missing space
 * ("Morarn II" → "Morarnll"), which was a dictionary bug in the OCR setup, not real
 * name damage; PP-OCRv6 preserves spaces since the dict gained its trailing space
 * entry. Tesseract itself is gone — the vision factory only builds PaddleOcrProvider.
 *
 * Spaces now cost nothing at all: both sides are despaced before they reach here (see
 * prepareKey), so the entire budget is available for character damage instead of being
 * eaten by wherever OCR happened to break a name up.
 *
 * Measured on 505 name sightings across 52 real screenshots (63 distinct names): every
 * low-count near-variant turned out to be a genuinely different player read correctly,
 * and the only confirmed OCR name error was a single homoglyph substitution
 * ("LizDidntDoIt" → "LizDidntDolt", distance 1). A budget of 2 leaves 100 % headroom
 * over anything observed while cutting the worst case from 4 edits to 2 — a garbled
 * long name can no longer silently land on a member four edits away instead of
 * surfacing in the New Members review queue.
 *
 * Known limitation, unfixable by any budget: two real players 1 edit apart (this
 * roster has XERN and Kern) can absorb each other. Distance 1 is the minimum any
 * fuzzy match must allow. The numeric-suffix alt that used to be listed here
 * ("Toupie2" vs "Toupie", and the live "FELI" / "FELI 2") is no longer one of them —
 * it was never a budget problem, and `namesDifferByAltSuffix` separates those on the
 * characters instead.
 */
function editBudget(a: string, b: string): number {
  return Math.max(a.length, b.length) >= 6 ? 2 : 1;
}

/**
 * How much further apart two names may be with capitalisation taken into account than
 * they are with it folded away.
 *
 * Capitalisation is a strong identity signal here because PaddleOCR reproduces it
 * faithfully — it reads "XERN", "SHAHIN", "JOooO" and "alex21rus" exactly — and the one
 * thing it does get wrong, homoglyph pairs whose upper and lower forms look alike
 * (capital I vs lowercase l), costs a single edit whether or not you compare case. So
 * when folding case is the only reason two names look close, they are two different
 * names following different conventions, not one name with OCR damage:
 *
 *   XERN  vs Kern           folded 1, with case 4  → different names, reject
 *   LizDidntDolt vs …DoIt   folded 1, with case 1  → real OCR damage, accept
 *
 * A pure case difference ("joooo" for "JOooO") folds to distance 0 and is settled by the
 * exact-match pass before this is ever consulted, so nothing here can break it. Scripts
 * without case (Cyrillic, Arabic) compare identically both ways, so they are unaffected.
 *
 * The cased comparison MUST use `m.name`, not `m.normalizedName`. That was the original
 * bug: `members.normalized_name` is lowercased by the repo on write, so comparing a
 * mixed-case OCR read against it inflated the "with case" distance by roughly one per
 * capital letter — turning this guard into "reject any fuzzy match whose input has two or
 * more capitals". Nearly every player name does. Measured on the live roster, it was
 * silently rejecting real matches like "RebenTurk" → "RebelTurk" (1 edit either way) and
 * "CHaoS JO00O" → "CHaoS JOooO" (2 either way).
 *
 * It survived because the unit-test fixture built members with `normalizedName: name`,
 * case intact — a shape the database never produces. The fixture now lowercases like the
 * repo does, so these tests would catch a regression.
 */
const CASE_DIVERGENCE_ALLOWANCE = 1;

/**
 * Exact (accent-folded) name or alias match, with no fuzzy fallback.
 *
 * Exposed separately because a caller searching more than one pool has to run
 * every exact pass before any fuzzy one. Ranking a whole pool above another —
 * active members before inactive ones, say — silently lets a fuzzy hit in the
 * first pool beat an EXACT hit in the second. Observed on the live roster: the
 * member list's "Bardin" is exactly member #78 Bardin (inactive), but active
 * member #74 "Bain" is 2 edits away and claimed the reading first, so Bardin's
 * might went to Bain and Bardin looked like he'd left the clan.
 */
export function exactMatchMember(
  rawName: string,
  members: ClanMember[],
): ClanMember | null {
  const normalized = prepareForMatch(rawName);
  if (!normalized) return null;
  for (const m of members) {
    if (prepareForMatch(m.normalizedName) === normalized) return m;
    if (m.aliases.some((a: string) => prepareForMatch(a) === normalized)) return m;
  }

  // Second pass on the despaced key, so a name whose only difference is where the
  // spaces fell still counts as EXACT rather than dropping to the distance tier
  // (where it could never have been reached — see prepareKey).
  //
  // A separate full sweep, not a second condition inside the loop above. Ranking
  // the two rules per-member instead of per-pool would let a despaced hit on the
  // first member beat a genuinely spelled-out hit on the fifth — the same ordering
  // bug that sent Bardin's might to Bain, described above.
  const key = prepareKey(rawName);
  if (!key) return null;
  for (const m of members) {
    if (prepareKey(m.normalizedName) === key) return m;
    if (m.aliases.some((a: string) => prepareKey(a) === key)) return m;
  }
  return null;
}

/**
 * Find the best matching clan member for a raw OCR name. Exact (accent-folded) match
 * wins; otherwise the closest member within {@link editBudget}. Returns null when no
 * member is close enough — the caller then treats the name as new.
 */
export function fuzzyMatchMember(
  rawName: string,
  members: ClanMember[],
): ClanMember | null {
  const normalized = prepareForMatch(rawName);
  if (!normalized) return null;

  const exact = exactMatchMember(rawName, members);
  if (exact) return exact;

  const key = prepareKey(rawName);
  if (!key) return null;
  const cased = prepareKeyKeepingCase(rawName);

  let best: ClanMember | null = null;
  let bestDist = Infinity;
  for (const m of members) {
    const mNorm = prepareKey(m.normalizedName);
    // A numeric or roman-numeral alt suffix is a different account, and no budget can
    // express that: "FELI 2" is 1 edit from "FELI", the floor every fuzzy matcher has
    // to allow. Checked before distance so it can't be undercut by a closer neighbour.
    if (namesDifferByAltSuffix(rawName, m.name)) continue;
    const dist = levenshtein(key, mNorm);
    if (dist > editBudget(key, mNorm) || dist >= bestDist) continue;
    // Reject when folding case is what made these look alike — see
    // CASE_DIVERGENCE_ALLOWANCE. Compares against m.name because that's the only
    // field carrying the member's real capitalisation; normalizedName is stored
    // lowercased and would make this reject almost every genuine match.
    const casedDist = levenshtein(cased, prepareKeyKeepingCase(m.name));
    if (casedDist - dist > CASE_DIVERGENCE_ALLOWANCE) continue;
    bestDist = dist;
    best = m;
  }
  return best;
}
