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