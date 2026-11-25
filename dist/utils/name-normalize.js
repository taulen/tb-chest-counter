"use strict";
/**
 * Shared name primitives: the accent fold the chest, source and member keys
 * are built with, and the despaced lookup key.
 *
 * The OCR-era tolerance that lived here — Cyrillic homoglyph transliteration
 * for the merge rules, and the alt-suffix / identity-digit guards for the
 * edit-distance matcher — went with those (Nov 25 2026): names come from the
 * game exactly.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.foldDiacritics = foldDiacritics;
exports.despace = despace;
/**
 * Fold accented Latin letters onto their base letter: ö → o, é → e, ç → c.
 *
 * NOT an OCR workaround: the game's own names carry accents ("Jörmungandr's
 * Chest", "Jörmungandr Shop") while the hand-written config and the stored
 * source-point keys spell them without, and the fold is what makes them agree.
 *
 * Decompose (NFD) splits the letter from its accent, then the combining mark is
 * dropped — which matters because the alternative, letting a later `[^a-z]` strip
 * remove the whole character, DELETES it instead of folding it: "Jörmungandr"
 * reached the catalog matcher as "jrmungandrs chest" against "jormungandrs chest",
 * and the same chest was recorded under two names.
 */
function foldDiacritics(s) {
    return s.normalize('NFD').replace(/\p{M}/gu, '');
}
/**
 * The **despaced lookup key** for a name: fold accents, lowercase, and throw away
 * everything that isn't a letter or a digit — spaces included. A LOOKUP key only;
 * never displayed and never stored as a member's name.
 */
function despace(s) {
    return foldDiacritics(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}
//# sourceMappingURL=name-normalize.js.map