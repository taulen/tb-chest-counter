"use strict";
/**
 * Shared OCR text-matching primitives — normalizers and edit distance
 * used by both the chest-name matcher (chest-names.ts) and the
 * player-name matcher (player-names.ts). Kept in their own module so
 * those two don't have to import each other just to share a helper.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.transliterateCyrillicHomoglyphs = transliterateCyrillicHomoglyphs;
exports.foldDiacritics = foldDiacritics;
exports.despace = despace;
exports.despaceKeepingCase = despaceKeepingCase;
exports.namesDifferByAltSuffix = namesDifferByAltSuffix;
exports.ocrNormalize = ocrNormalize;
exports.normalizeNonLatin = normalizeNonLatin;
exports.levenshtein = levenshtein;
/**
 * Cyrillic glyphs that are visually identical (or nearly so) to Latin
 * letters. Tesseract with multi-language models loaded routinely picks
 * the Cyrillic glyph for individual chars in otherwise-Latin words —
 * "Stone" comes back as "Sтоnе" (mid-word т/о/е are Cyrillic), or a
 * known player "Andre" as "Аndre" (leading А is Cyrillic). Mapping
 * these onto their Latin lookalikes before fuzzy matching lets
 * `correctChestName` and `matchKnownPlayer` resolve the canonical form.
 * Uppercase forms cover both cases because `ocrNormalize` lowercases
 * first, but Cyrillic uppercase doesn't lowercase to ASCII — so we
 * list both.
 */
const CYRILLIC_TO_LATIN = {
    // Uppercase
    'А': 'a', 'В': 'b', 'Е': 'e', 'К': 'k', 'М': 'm', 'Н': 'h',
    'О': 'o', 'Р': 'p', 'С': 'c', 'Т': 't', 'Х': 'x', 'У': 'y',
    // Lowercase
    'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h',
    'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'х': 'x', 'у': 'y',
    // Cyrillic letters with no Latin lookalike are intentionally absent —
    // we only want to defuse homoglyph confusion, not transliterate a
    // genuine Cyrillic word into garbage Latin.
};
function transliterateCyrillicHomoglyphs(s) {
    let out = '';
    for (const ch of s)
        out += CYRILLIC_TO_LATIN[ch] ?? ch;
    return out;
}
/**
 * Normalize a string for OCR-aware comparison. Maps characters that
 * Tesseract routinely confuses with each other onto a shared form,
 * strips apostrophes and non-alpha chars, then lowercases. The goal
 * is that "050" and "oSo" both normalize to the same string, and
 * "Priests Chest" matches "Priest's Chest". Also collapses Cyrillic
 * homoglyphs onto Latin so multi-lang Tesseract picking "Сtone" for
 * "Stone" still resolves correctly.
 *
 * Shared by correctChestName and matchKnownPlayer. Note this strips
 * every non-Latin character — for genuinely non-Latin names use
 * `normalizeNonLatin` instead.
 */
/**
 * Fold accented Latin letters onto their base letter: ö → o, é → e, ç → c.
 *
 * Decompose (NFD) splits the letter from its accent, then the combining mark is dropped —
 * which matters because the alternative, letting a later `[^a-z]` strip remove the whole
 * character, DELETES it instead of folding it. That is a real bug rather than a
 * hypothetical: the game's "Jörmungandr" was reaching the catalog matcher as
 * "jrmungandrs chest" against a catalog entry of "jormungandrs chest", so a missing "o"
 * kept them apart and the same chest was recorded under two names — 57 rows as
 * "Jormungandr's Chest" and 24 as "Jörmungandr's Chest", scored separately. The source-key
 * slug had the same hole and produced "epic j rmungandr squad".
 *
 * The one shared copy: fuzzy.ts had its own, and player/chest matching had none.
 */
function foldDiacritics(s) {
    return s.normalize('NFD').replace(/\p{M}/gu, '');
}
/**
 * The **despaced lookup key** for a name: fold accents, lowercase, and throw away
 * everything that isn't a letter or a digit — spaces included.
 *
 * Spacing is the one thing OCR gets wrong that no edit-distance budget can absorb.
 * A player whose in-game name is written out letter-by-letter ("J I Z Z I C A") is
 * read back as "JIZZICA", "JI ZZICA", "JIZZI C A" and "JI ZZI C A" on different
 * scans; against the spaced original those are 6 edits apart, three times the
 * 2-edit budget, so every variant looks like a brand-new player. Collapsing the
 * spaces first makes all of them the single key "jizzica", and leaves the edit
 * budget to do what it is actually for — genuine character damage.
 *
 * This is a LOOKUP key only. It is never displayed and never stored as a member's
 * name; the roster keeps whatever spacing it was given.
 *
 * Deliberately does NOT transliterate Cyrillic homoglyphs, unlike merge-repo's
 * private `normalize`. `matchKnownPlayer` decides whether a name is non-Latin by
 * testing whether this key comes back empty, and transliterating would turn a
 * genuinely Cyrillic name made of homoglyph letters ("Кот") into "kot" — sending
 * it down the Latin path and out of reach of `normalizeNonLatin`.
 */
function despace(s) {
    return foldDiacritics(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}
/**
 * {@link despace} with capitalisation intact, for the case-divergence guard in
 * fuzzy.ts — that check only means anything if both sides are despaced the same
 * way before it counts edits.
 */
function despaceKeepingCase(s) {
    return foldDiacritics(s).replace(/[^A-Za-z0-9]/g, '');
}
/**
 * The digits in a name that NO letter looks like. So "Sm4sH" yields "4", "Bully26"
 * yields "26", and "bacardy1" yields "" because that 1 is genuinely ambiguous with
 * l and I.
 *
 * The folded set — 0→o, 5→s, 1→l, 8→b, 9→g — is exactly what might-capture's
 * `sameOcrSkeleton` collapses, and both come off the same live roster readings
 * ("mimo0000" for "mimooooo", "Me9rond" for "Megrond"). Leaving 9 out was enough to
 * make this rule reject that real pair, so the two sets stay in step: a digit
 * belongs here only when no letter genuinely looks like it. Note `ocrNormalize`
 * folds a smaller set (no 9→g) because it also deletes every digit afterwards, so
 * the difference never showed there.
 *
 * Order is preserved, so this is a signature rather than a set: "Player37" and
 * "Player73" have different ones.
 */
function identityDigits(s) {
    return (foldDiacritics(s)
        .toLowerCase()
        .replace(/0/g, 'o')
        .replace(/5/g, 's')
        .replace(/1/g, 'l')
        .replace(/8/g, 'b')
        .replace(/9/g, 'g')
        .match(/[0-9]/g) ?? []).join('');
}
/**
 * What may sit on the end of a COMPLETE other name and mark an alt account: a run of
 * digits, or a 2+ character roman numeral.
 *
 * Every digit qualifies here, including the 0/1/5/8/9 that {@link identityDigits}
 * folds away, and the difference between the two rules is append versus substitute.
 * A homoglyph digit is a SUBSTITUTION — it stands where a letter stands, so the name
 * keeps its length ("Toup1e" for "Toupie", "Me9rond" for "Megrond", "050" for "oSo",
 * "mimo0000" for "mimooooo"). Not one measured OCR error appends a digit to a name
 * that is otherwise entirely intact. So "Cordarus 1" next to "Cordarus" is the alt
 * convention, not damage, and reading it as damage is what left three names on the
 * live roster ("bacardy1", "Stafford85", "Cordarus 1") one join away from silently
 * absorbing their own base name.
 *
 * The roman forms deliberately EXCLUDE the one-character "i", "v" and "x": those are
 * ordinary name endings (Levi, Max), and a single trailing character is also the
 * commonest thing for OCR to drop, so treating one as identity would split real
 * members apart. A digit does not have that problem — a trailing letter misread as a
 * digit is a substitution, which this branch never sees.
 */
const ALT_SUFFIX = /^(?:[0-9]+|i{2,3}|iv|vi{1,3}|ix|xi{1,2})$/;
/** Letters and digits of any script, spacing and punctuation gone. */
function altKey(s) {
    return foldDiacritics(s.normalize('NFKC')).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}
/**
 * True when two names differ in a way that marks them as SEPARATE ACCOUNTS rather
 * than one name with OCR damage — a numeric or roman-numeral alt suffix.
 *
 * Real case that forced this: one clan holds both "FELI" and "FELI 2", two distinct
 * players. Every matcher merged them, and it took three different mechanisms to do it:
 *
 *   despaced keys      feli2 / feli    1 edit against a budget of 1   → merged
 *   ocrNormalize       "feli" / "feli" the 2 is DELETED, so this is
 *                                      an EXACT match, reached before
 *                                      any distance check at all      → merged
 *   sameOcrSkeleton    fell / fell     same, digits stripped          → merged
 *
 * So no edit budget could have saved it: two of the three never measured a distance.
 * The lever has to be the characters themselves, and it exists — a digit that no
 * letter resembles is not something PaddleOCR invents or drops. "FELI 2" is read as
 * "FELI 2"; the 2 was only ever discarded on OUR side, by normalizers written when
 * digits were assumed to be letter noise (oSo ↔ 050) rather than identity.
 *
 * Two rules, because a digit can mean either thing depending on WHERE it sits:
 *
 *   {@link identityDigits}  a digit anywhere in the name, but only the five (2, 3, 4,
 *                           6, 7) that no letter resembles. 0/1/5/8/9 are folded away
 *                           first, so "mikl"/"mikI", "oSo"/"050", "Toup1e"/"Toupie"
 *                           and "Megrond"/"Me9rond" keep merging exactly as before.
 *   {@link ALT_SUFFIX}      ANY digit run, or a 2+ character roman numeral, APPENDED
 *                           to the whole of the other name. A homoglyph digit is a
 *                           substitution and leaves the length alone, so nothing that
 *                           rule protects can reach this one — which is what lets it
 *                           cover "Cordarus 1", where the suffix is a folded digit.
 *
 * Measured against the live roster (251 members, Sep 5 backup): every one of the 251
 * still resolves to itself through both matchers, and no pair they currently collapse
 * is separated by this — it costs nothing that works today. What it removes from the
 * collision list is the clan's own "FLOKI" / "FLOKI II", the roman half of the same
 * convention: two members that survive as two only because their exact spellings
 * happened to be read first, 2 edits apart on a 2-edit budget. The roster also carries
 * "bacardy1", "Stafford85" and "Cordarus 1", none of whose base names is a member
 * today — each one join away from the same silent absorption.
 *
 * The residual risk is the mirror image — a genuine OCR misread of an identity digit
 * ("Sm4sH" read as "SmasH") now fails to match and mints a duplicate member. That is
 * the deliberate direction: a duplicate lands in the New Members review queue with a
 * crop attached and an admin merges it, while a silent absorption is unrecoverable —
 * the absorbed player's chests are already filed under someone else's name.
 *
 * What this still cannot see is an alt that is not a suffix at all: a tag, a prefix,
 * or a spelling the player chose themselves. Nothing in a name can reveal those.
 */
function namesDifferByAltSuffix(a, b) {
    // Keyed Unicode-aware rather than through despace, which keeps only [a-z0-9] and so
    // flattens every non-Latin name to the empty string. The two names this has to
    // separate can be Arabic or Cyrillic with a Latin "2" on the end just as easily as
    // Latin ones, and that path has its own distance tier with the same 1-edit floor.
    // For an ASCII name this produces exactly what despace does.
    const ka = altKey(a);
    const kb = altKey(b);
    if (!ka || !kb || ka === kb)
        return false;
    if (identityDigits(ka) !== identityDigits(kb))
        return true;
    // One name is the whole of the other plus an alt marker. Checked on top of the digit
    // signature because it reaches the suffixes that signature deliberately folds away:
    // "Cordarus 1" is "Cordarus" plus an appended digit, and no OCR error appends one.
    const [shorter, longer] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
    return shorter.length >= 3
        && longer.startsWith(shorter)
        && ALT_SUFFIX.test(longer.slice(shorter.length));
}
function ocrNormalize(s) {
    return foldDiacritics(transliterateCyrillicHomoglyphs(s))
        .toLowerCase()
        .replace(/0/g, 'o') // 0 ↔ o (very common)
        .replace(/5/g, 's') // 5 ↔ S
        .replace(/1/g, 'l') // 1 ↔ l ↔ I
        .replace(/!/g, 'i') // ! ↔ I
        .replace(/8/g, 'b') // 8 ↔ B
        .replace(/[^a-z ]/g, '') // strip apostrophes, digits-now-letters, punctuation
        .replace(/\s+/g, ' ')
        .trim();
}
/**
 * Normalize a non-Latin (Arabic / Cyrillic / CJK / Hangul / ...) name
 * for comparison. The Latin-oriented `ocrNormalize` strips every
 * non-ASCII character, which annihilates these scripts entirely — so
 * names written in them need their own path.
 *
 * Applies Unicode compatibility composition (NFKC, which folds Arabic
 * presentation forms onto their canonical letters), lowercases, and
 * strips combining marks (Arabic harakat / tanwin), whitespace,
 * punctuation, and invisible bidi/format characters — RTL/LTR marks
 * and zero-width joiners routinely leak into OCR'd Arabic.
 */
function normalizeNonLatin(s) {
    return s
        .normalize('NFKC')
        .toLowerCase()
        .replace(/\p{M}/gu, '') // combining marks (Arabic harakat/tanwin)
        .replace(/[\s\p{P}\p{C}]/gu, ''); // whitespace, punctuation, bidi/format/control chars
}
/**
 * Simple Levenshtein (edit) distance. Shared by the chest-name and
 * player-name fuzzy matchers.
 */
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++)
        dp[i][0] = i;
    for (let j = 0; j <= n; j++)
        dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}
//# sourceMappingURL=ocr-normalize.js.map