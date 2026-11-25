"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.foldDiacritics = foldDiacritics;
/**
 * The accent fold — used in ONE place now: deriving a source's point key
 * (source-names.ts `getSourceKey` / `canonicalSourceKey`), the internal slug
 * chest point values are stored under ("Jörmungandr Shop" → `jormungandr shop`).
 * The key is never shown; the names themselves are the game's, verbatim.
 *
 * Every NAME comparison is exact since Nov 25 2026: stored chests and sources
 * carry the game's own names (v139 moved the last OCR-era spellings), the scan
 * writes them verbatim, and the hand-written lists use them too. The OCR-era
 * tolerance that lived here — spacing-insensitive keys, Cyrillic homoglyph
 * transliteration, alt-suffix guards — is gone.
 *
 * NFD splits a letter from its accent and the combining mark is dropped, so the
 * letter is folded rather than deleted by a later `[^a-z0-9]` strip.
 */
function foldDiacritics(s) {
    return s.normalize('NFD').replace(/\p{M}/gu, '');
}
//# sourceMappingURL=name-normalize.js.map