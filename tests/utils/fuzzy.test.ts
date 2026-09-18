import { describe, it, expect } from 'vitest';
import { exactMatchMember, fuzzyMatchMember, levenshtein } from '../../src/utils/fuzzy.js';
import type { ClanMember } from '../../src/models/types.js';

/**
 * The edit budget was tightened from max(len)/3 to "2 for 6+ chars, else 1" once
 * Tesseract was replaced by PaddleOCR. These cases pin both directions: real OCR
 * damage still matches, and a long garbled name no longer reaches a member several
 * edits away instead of being surfaced as new.
 *
 * Names here are taken from real screenshots in data/resource_test_screenshots.
 */
/**
 * Build a member the way the database actually stores one.
 *
 * `normalizedName` is LOWERCASED here because that is what member-repo writes
 * (`normalizeName` = trim + toLowerCase + collapse whitespace). The previous
 * fixture passed the name through with its capitalisation intact, which is a
 * shape production never produces — and that is precisely why the
 * case-divergence guard could compare against the wrong field for months while
 * every test below still passed. Keep this lowercased.
 */
const mk = (name: string, id: number, aliases: string[] = []): ClanMember => ({
  id,
  name,
  normalizedName: name.trim().toLowerCase().replace(/\s+/g, ' '),
  aliases,
  firstSeen: '2026-01-01', lastSeen: '2026-07-27', isActive: true,
});

const ROSTER: ClanMember[] = [
  'LizDidntDoIt', 'Toupie', 'Archraven', 'Megrond', 'Nimath', 'Frostterror',
  'Crème À la mode Pie', 'Warrior 1977', 'Glorgol', 'Melmaran', 'alex21rus',
].map((n, i) => mk(n, i + 1));

const match = (ocr: string) => fuzzyMatchMember(ocr, ROSTER)?.name ?? null;

describe('fuzzyMatchMember', () => {
  it('matches exactly, case- and accent-insensitively', () => {
    expect(match('LizDidntDoIt')).toBe('LizDidntDoIt');
    expect(match('lizdidntdoit')).toBe('LizDidntDoIt');
    // The accented member name is reached by folding, not by spending edit budget —
    // tightening the budget must not break it.
    expect(match('Creme A la mode Pie')).toBe('Crème À la mode Pie');
    expect(match('crEme a LA mode pie')).toBe('Crème À la mode Pie');
  });

  it('absorbs the homoglyph substitutions PaddleOCR actually makes', () => {
    // Confirmed against a real screenshot: capital I read as lowercase l.
    expect(match('LizDidntDolt')).toBe('LizDidntDoIt');
    expect(match('Toup1e')).toBe('Toupie');
    expect(match('Archrauen')).toBe('Archraven');
    expect(match('Me9rond')).toBe('Megrond');
    expect(match('Frostterrer')).toBe('Frostterror');
  });

  it('still allows two edits on a longer name', () => {
    // "Morarn II" → "Morarn ll" is the two-substitution case the old comment cited,
    // minus the missing space that the OCR dictionary fix removed.
    const roster = [mk('Morarn II', 1)];
    expect(fuzzyMatchMember('Morarn ll', roster)?.name).toBe('Morarn II');
    expect(levenshtein('morarn ll', 'morarn ii')).toBe(2);
  });

  it('refuses a long name that is more than two edits away', () => {
    // Under max(len)/3 a 12-char name tolerated 4 edits, so heavily garbled reads
    // could land on the wrong member. They must now surface as new instead.
    expect(levenshtein('lizdidntxxxx', 'lizdidntdoit')).toBeGreaterThan(2);
    expect(match('LizDidntXXXX')).toBeNull();
    expect(match('Frostterrxxx')).toBeNull();
  });

  it('keeps short names on a one-edit budget', () => {
    expect(match('Toupie')).toBe('Toupie');
    // 5 chars, 2 edits — rejected.
    expect(fuzzyMatchMember('Nimxx', [mk('Nimath', 1)])).toBeNull();
  });

  it('does not match a name that resembles nothing on the roster', () => {
    expect(match('CompletelyDifferent')).toBeNull();
    expect(match('')).toBeNull();
  });

  it('matches on aliases too', () => {
    const roster = [mk('Melmaran', 1, ['Mel'])];
    expect(fuzzyMatchMember('Mel', roster)?.name).toBe('Melmaran');
  });

  it('prefers the closest member when several are within budget', () => {
    const roster = [mk('Kern', 1), mk('Kerny', 2)];
    // Exact wins outright.
    expect(fuzzyMatchMember('Kern', roster)?.name).toBe('Kern');
  });

  // ── capitalisation as an identity signal ────────────────────────────────────
  //
  // Two real players can sit 1 folded edit apart (XERN / Kern), which no edit budget
  // can separate — 1 edit is the floor any fuzzy match must allow. Capitalisation
  // does separate them: PaddleOCR reproduces case faithfully, and the homoglyph
  // errors it does make cost one edit with or without case folding.

  it('does not merge two real names that only look close with case folded', () => {
    // XERN vs Kern: 1 edit folded, 4 with case. Different names, not OCR damage.
    expect(levenshtein('xern', 'kern')).toBe(1);
    expect(levenshtein('XERN', 'Kern')).toBe(4);
    expect(fuzzyMatchMember('XERN', [mk('Kern', 1)])).toBeNull();
    expect(fuzzyMatchMember('Kern', [mk('XERN', 1)])).toBeNull();
  });

  it('keeps matching homoglyph damage, which costs one edit either way', () => {
    // The distinguishing property: for real OCR damage the two distances agree.
    expect(levenshtein('LizDidntDolt', 'LizDidntDoIt')).toBe(1);
    expect(fuzzyMatchMember('LizDidntDolt', [mk('LizDidntDoIt', 1)])?.name).toBe('LizDidntDoIt');
    // Same inside an all-caps name.
    expect(levenshtein('SHAHlN', 'SHAHIN')).toBe(1);
    expect(fuzzyMatchMember('SHAHlN', [mk('SHAHIN', 1)])?.name).toBe('SHAHIN');
  });

  it('is unaffected by a pure case difference, which the exact pass settles', () => {
    // Folds to distance 0, so the case-divergence check is never consulted.
    expect(fuzzyMatchMember('joooo', [mk('JOooO', 1)])?.name).toBe('JOooO');
    expect(fuzzyMatchMember('MELMARAN', [mk('Melmaran', 1)])?.name).toBe('Melmaran');
  });

  it('does not let the lowercased normalizedName column defeat the guard', () => {
    // Regression for the bug this guard shipped with: it compared the mixed-case
    // OCR read against `normalizedName`, which the repo stores lowercased. The
    // "with case" distance was therefore inflated by about one per capital, so
    // any input with 2+ capitals was rejected however clean the match was.
    // Both of these are real readings that were being dropped in production.
    expect(fuzzyMatchMember('RebenTurk', [mk('RebelTurk', 1)])?.name).toBe('RebelTurk');
    expect(fuzzyMatchMember('CHaoS JO00O', [mk('CHaoS JOooO', 1)])?.name).toBe('CHaoS JOooO');

    // The pathological shape: capitals everywhere, one real edit. Under the bug
    // the cased distance was ~8 against 'chaosjoooo' and this returned null.
    expect(fuzzyMatchMember('PropofolDok', [mk('PropofolDoc', 1)])?.name).toBe('PropofolDoc');

    // And the guard still has to work — this is the case it exists for, and it
    // must keep rejecting even though the comparison field changed.
    expect(fuzzyMatchMember('XERN', [mk('Kern', 1)])).toBeNull();
  });

  it('exposes an exact-only pass, so a caller with two pools can order them correctly', () => {
    // Why this exists: ranking a whole pool above another lets a FUZZY hit in the
    // first pool beat an EXACT hit in the second. Measured on the live roster — the
    // member list's "Bardin" is exactly member #78 Bardin (inactive), but active
    // member "Bain" is 2 edits away and claimed the reading first, so Bardin's might
    // was filed under Bain and Bardin looked like he had left the clan.
    const activePool = [mk('Bain', 74)];
    const inactivePool = [mk('Bardin', 78)];

    // The trap: fuzzy against the active pool alone does match.
    expect(fuzzyMatchMember('Bardin', activePool)?.name).toBe('Bain');
    // Exact-only refuses it, so a caller can try every exact pass first.
    expect(exactMatchMember('Bardin', activePool)).toBeNull();
    expect(exactMatchMember('Bardin', inactivePool)?.name).toBe('Bardin');
  });

  it('matches aliases and folds accents in the exact-only pass too', () => {
    expect(exactMatchMember('Mel', [mk('Melmaran', 1, ['Mel'])])?.name).toBe('Melmaran');
    expect(exactMatchMember('Creme A la mode Pie', ROSTER)?.name).toBe('Crème À la mode Pie');
    expect(exactMatchMember('', ROSTER)).toBeNull();
  });

  // ── spacing is not identity ─────────────────────────────────────────────────
  //
  // A player whose in-game name is written out letter-by-letter is read back with
  // the gaps in different places on every scan. Against the spaced original those
  // readings are ~6 edits away — three times the budget — so before despacing this
  // matcher could not reach them at all, and the might capture and resource reader
  // minted a fresh member row per spelling. Four merge rules for one player
  // ("J I Z Z I C A") is what that looked like on the live roster.

  it('matches every OCR spacing variant of a letter-spaced name', () => {
    const roster = [mk('J I Z Z I C A', 1)];
    for (const read of ['JIZZICA', 'JI ZZICA', 'JIZZI C A', 'JI ZZI C A', 'J I Z Z I C A']) {
      expect(fuzzyMatchMember(read, roster)?.name).toBe('J I Z Z I C A');
    }
    // These are EXACT matches on the despaced key, not distance ones — the budget
    // is left free for real damage. Note how far out of reach they were before.
    expect(exactMatchMember('JIZZICA', roster)?.name).toBe('J I Z Z I C A');
    expect(levenshtein('jizzica', 'j i z z i c a')).toBe(6);
  });

  it('still spends the edit budget on real damage inside a spacing variant', () => {
    // The combined case: spacing lost AND a duplicated character. Despacing turns a
    // 7-edit problem into the 1-edit one it always was.
    const roster = [mk('J I Z Z I C A', 1)];
    expect(fuzzyMatchMember('J I Z Z I ZC A', roster)?.name).toBe('J I Z Z I C A');
    expect(fuzzyMatchMember('JIZZIZCA', roster)?.name).toBe('J I Z Z I C A');
    expect(levenshtein('jizzizca', 'jizzica')).toBe(1);
  });

  it('does not let despacing become a licence to merge unrelated names', () => {
    // Despacing only makes two names EQUAL when they are the same letters in the same
    // order; anything else still has to clear the budget.
    expect(fuzzyMatchMember('J I M M I X X', [mk('J I Z Z I C A', 1)])).toBeNull();
    expect(fuzzyMatchMember('War rior 1977', ROSTER)?.name).toBe('Warrior 1977');
    expect(fuzzyMatchMember('Glor gol', ROSTER)?.name).toBe('Glorgol');
  });

  it('subjects a letter-spaced name to the same budget as any other name', () => {
    // Worth pinning because it IS a behaviour change, not just a fix. Before, a
    // letter-spaced name sat 6+ edits from everything and so could never match
    // anything; now it is a 7-character key like any other and carries the same
    // 2-edit exposure the rest of the roster has always had. "J I M M I C A" and
    // "J I Z Z I C A" therefore merge — exactly as plain "Jimmica" and "Jizzica"
    // already would. That is the documented floor of fuzzy matching (XERN/Kern),
    // not a new hole opened by despacing.
    expect(levenshtein('jimmica', 'jizzica')).toBe(2);
    expect(fuzzyMatchMember('J I M M I C A', [mk('J I Z Z I C A', 1)])?.name)
      .toBe('J I Z Z I C A');
    expect(fuzzyMatchMember('Jimmica', [mk('Jizzica', 1)])?.name).toBe('Jizzica');
  });

  it('keeps the case-divergence guard working on despaced keys', () => {
    // Both sides are despaced before the guard counts edits; if only one were, the
    // cased distance would be inflated by every space and the guard would reject
    // every genuine match. XERN/Kern must still be refused.
    expect(fuzzyMatchMember('X E R N', [mk('Kern', 1)])).toBeNull();
    expect(fuzzyMatchMember('CHaoS JO00O', [mk('CHaoSJOooO', 1)])?.name).toBe('CHaoSJOooO');
  });

  it('does not let a despaced hit outrank an exactly-spelled member', () => {
    // The despaced pass is a second full sweep, not an extra condition inside the
    // first loop. Interleaved, a despaced hit on member #1 would beat the member who
    // actually spells the name that way — the ordering bug that sent Bardin's might
    // to Bain, in a new costume.
    const roster = [mk('ABCD', 1), mk('A B C D', 2)];
    expect(exactMatchMember('A B C D', roster)?.id).toBe(2);
    expect(exactMatchMember('ABCD', roster)?.id).toBe(1);
  });

  it('keeps a numeric-suffix alt off the member it is one edit from', () => {
    // The structural rule this used to be recorded as needing. Distance cannot help:
    // "Toupie2" is 1 edit from "Toupie" folded AND cased, and the live pair that
    // forced the fix — "FELI 2" against member "FELI" — is 1 edit on a 5-character
    // key, the floor every fuzzy matcher has to allow.
    expect(levenshtein('Toupie2', 'Toupie')).toBe(1);
    expect(fuzzyMatchMember('Toupie2', [mk('Toupie', 1)])).toBeNull();
    expect(fuzzyMatchMember('FELI 2', [mk('FELI', 1)])).toBeNull();
    expect(fuzzyMatchMember('FELI', [mk('FELI 2', 1)])).toBeNull();
  });

  it('matches each of an alt pair to itself when both are on the roster', () => {
    // Splitting them is only half the job — each still has to resolve, and exactly.
    const roster = [mk('FELI', 1), mk('FELI 2', 2)];
    expect(fuzzyMatchMember('FELI', roster)?.id).toBe(1);
    expect(fuzzyMatchMember('FELI 2', roster)?.id).toBe(2);
    expect(fuzzyMatchMember('FELI2', roster)?.id).toBe(2);
  });

  it('separates a 2+ character roman-numeral alt', () => {
    // The live roster carries FLOKI and FLOKI II as two members. Despaced they are
    // "floki" and "flokiii" — 2 edits on a 2-edit budget, one bad read from collapsing.
    expect(fuzzyMatchMember('FLOKI II', [mk('FLOKI', 1)])).toBeNull();
    expect(fuzzyMatchMember('FLOKI', [mk('FLOKI II', 1)])).toBeNull();
  });

  it('leaves a SUBSTITUTED homoglyph digit alone — that is OCR damage', () => {
    // 0/1/5/8/9 are what this OCR writes for o/l/s/b/g, so a digit standing where a
    // letter stands is exactly the damage the budget exists to repair.
    expect(fuzzyMatchMember('Toup1e', [mk('Toupie', 1)])?.name).toBe('Toupie');
    expect(fuzzyMatchMember('bacardy1', [mk('bacardyl', 1)])?.name).toBe('bacardyl');
    expect(fuzzyMatchMember('Me9rond', [mk('Megrond', 1)])?.name).toBe('Megrond');
    // …and a single trailing i or v is an ordinary name ending, not a roman numeral.
    expect(fuzzyMatchMember('Levi', [mk('Lev', 1)])?.name).toBe('Lev');
  });

  it('separates an APPENDED digit even when that digit is a homoglyph', () => {
    // "Cordarus 1" is a live member. Nothing bolts a digit onto an otherwise intact
    // name, so the append is the alt convention, not a misread of a trailing letter —
    // that would be a substitution, which leaves the length alone.
    expect(fuzzyMatchMember('Cordarus 1', [mk('Cordarus', 1)])).toBeNull();
    expect(fuzzyMatchMember('Cordarus', [mk('Cordarus 1', 1)])).toBeNull();
    expect(fuzzyMatchMember('Stafford85', [mk('Stafford', 1)])).toBeNull();
  });

  it('still matches a name whose identity digits are unchanged', () => {
    expect(fuzzyMatchMember('a1ex21rus', ROSTER)?.name).toBe('alex21rus');
    expect(fuzzyMatchMember('War rior 1977', ROSTER)?.name).toBe('Warrior 1977');
  });
});
