"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exactMatchMember = exactMatchMember;
function prepareForMatch(raw) {
    return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}
/**
 * The member a name belongs to: a case-insensitive match on the name or an
 * alias. Nothing looser any more (Nov 25 2026) — names come from the game
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