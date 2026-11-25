"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exactMatchMember = exactMatchMember;
const name_normalize_js_1 = require("./name-normalize.js");
// Accented characters (è, À, ü, …) compare equal to their ASCII base letter on both
// sides. foldDiacritics is the one shared copy.
function prepareForMatch(raw) {
    return (0, name_normalize_js_1.foldDiacritics)(raw.trim().toLowerCase().replace(/\s+/g, ' '));
}
/**
 * The member a name belongs to: an accent- and case-folded match on the name or
 * an alias. Nothing looser any more (Nov 25 2026) — names come from the game
 * exactly. The edit-distance matcher went with the event standings paste, the
 * last caller that fed it typed or pasted names, and the spacing-insensitive
 * pass with it: it existed for OCR spacing variants, and with exact names it
 * could only hand a new player "Raven" the row of an existing "Ra ven".
 */
function exactMatchMember(rawName, members) {
    const normalized = prepareForMatch(rawName);
    if (!normalized)
        return null;
    for (const m of members) {
        if (prepareForMatch(m.normalizedName) === normalized)
            return m;
        if (m.aliases.some((a) => prepareForMatch(a) === normalized))
            return m;
    }
    return null;
}
//# sourceMappingURL=fuzzy.js.map