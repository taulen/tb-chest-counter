"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TRIUMPHAL_PACKAGE_POINTS = exports.TRIUMPHAL_CHEST_NAMES = exports.KNOWN_CHESTS = void 0;
exports.cleanChestName = cleanChestName;
exports.correctChestName = correctChestName;
exports.getChestRarity = getChestRarity;
exports.isKnownChestName = isKnownChestName;
exports.correctTriumphalChestName = correctTriumphalChestName;
exports.isHardcodedChestName = isHardcodedChestName;
exports.containsKnownChestName = containsKnownChestName;
const enums_js_1 = require("../models/enums.js");
const ocr_normalize_js_1 = require("./ocr-normalize.js");
/**
 * Canonical chest names from TBChestTracker + in-game observations.
 * Maps exact chest name → rarity type.
 * New chests can be added here or overridden via admin panel.
 */
exports.KNOWN_CHESTS = {
    // Common crypt chests
    'Elegant Chest': enums_js_1.ChestType.COMMON,
    'Fire Chest': enums_js_1.ChestType.COMMON,
    'Forgotten Chest': enums_js_1.ChestType.COMMON,
    'Cobra Chest': enums_js_1.ChestType.COMMON,
    'Orc Chest': enums_js_1.ChestType.COMMON,
    'Barbarian Chest': enums_js_1.ChestType.COMMON,
    'Infernal Chest': enums_js_1.ChestType.COMMON,
    'Mayan Chest': enums_js_1.ChestType.COMMON,
    'Sand Chest': enums_js_1.ChestType.COMMON,
    'Stone Chest': enums_js_1.ChestType.COMMON,
    'Gnome Workshop Chest': enums_js_1.ChestType.COMMON,
    'Carrot Chest': enums_js_1.ChestType.COMMON,
    'Bone Chest': enums_js_1.ChestType.COMMON,
    'Ore Chest': enums_js_1.ChestType.COMMON, // OCR misread of Orc Chest, but keep as fallback
    // Wealth chests (clan)
    'Common Chest of Wealth': enums_js_1.ChestType.COMMON,
    'Uncommon Chest of Wealth': enums_js_1.ChestType.UNCOMMON,
    'Rare Chest of Wealth': enums_js_1.ChestType.RARE,
    'Epic Chest of Wealth': enums_js_1.ChestType.EPIC,
    // Typed by the rarity in its own name, like the four above. The 29 rows
    // already stored hold `common` (the type an unknown chest is created with)
    // and will keep it — getOrCreateChestId sets chest_type on first sight only
    // — so this is the type a FRESH install gives it, and the badge on existing
    // rows is an admin chest-type override away if it ever matters.
    'Legendary Chest of Wealth': enums_js_1.ChestType.LEGENDARY,
    // Rare crypt chests
    'Rare Dragon Chest': enums_js_1.ChestType.RARE,
    // Epic crypt chests
    "Ancient Warrior's Chest": enums_js_1.ChestType.EPIC,
    'Harpy Chest': enums_js_1.ChestType.EPIC,
    'Trillium Chest': enums_js_1.ChestType.EPIC,
    'Scarab Chest': enums_js_1.ChestType.EPIC,
    'Cobalt Chest': enums_js_1.ChestType.EPIC,
    'Minotaur Chest': enums_js_1.ChestType.EPIC,
    'White Wood Chest': enums_js_1.ChestType.EPIC,
    'Titansteel Chest': enums_js_1.ChestType.EPIC,
    'Abandoned Chest': enums_js_1.ChestType.EPIC,
    'Braided Chest': enums_js_1.ChestType.EPIC,
    'Scorpion Chest': enums_js_1.ChestType.EPIC,
    'Chest of the Cursed': enums_js_1.ChestType.EPIC,
    'Ancient Bastion Chest': enums_js_1.ChestType.EPIC,
    'House of Horrors Chest': enums_js_1.ChestType.EPIC,
    'Turtle Chest': enums_js_1.ChestType.EPIC,
    "Priest's Chest": enums_js_1.ChestType.EPIC,
    'Pacified Mimic Chest': enums_js_1.ChestType.EPIC,
    // Citadel chests
    'Elven Citadel Chest': enums_js_1.ChestType.EPIC,
    'Cursed Citadel Chest': enums_js_1.ChestType.EPIC,
    // Arena
    "Gladiator's Chest": enums_js_1.ChestType.ARENA,
    // Triumphal / Bank
    'Wooden Chest': enums_js_1.ChestType.COMMON,
    'Bronze Chest': enums_js_1.ChestType.UNCOMMON,
    'Silver Chest': enums_js_1.ChestType.RARE,
    'Golden Chest': enums_js_1.ChestType.EPIC,
    'Precious Chest': enums_js_1.ChestType.LEGENDARY,
    'Magic Chest': enums_js_1.ChestType.LEGENDARY,
    // Event / reward chests (seeded from catalog export; admin can override type)
    "Ancients' Chest": enums_js_1.ChestType.COMMON,
    'Arachne Chest': enums_js_1.ChestType.COMMON,
    'Arcane Chest': enums_js_1.ChestType.COMMON,
    'Ascendant Ashen Chest': enums_js_1.ChestType.COMMON,
    "Azada's Chest": enums_js_1.ChestType.COMMON,
    'Basilisk Chest': enums_js_1.ChestType.COMMON,
    'Briareus Chest': enums_js_1.ChestType.COMMON,
    'Chest of Authority': enums_js_1.ChestType.COMMON,
    'Chimera Chest': enums_js_1.ChestType.COMMON,
    'Cursed Chest': enums_js_1.ChestType.COMMON,
    'Dark Omens chest': enums_js_1.ChestType.COMMON,
    'Dark Omens ranking chest': enums_js_1.ChestType.COMMON,
    'Easter Chest': enums_js_1.ChestType.COMMON,
    'Elven Chest': enums_js_1.ChestType.COMMON,
    'Epic Monster Chest': enums_js_1.ChestType.COMMON,
    'Epic Omen Chest': enums_js_1.ChestType.EPIC,
    'Fallen King Chest': enums_js_1.ChestType.COMMON,
    "Fenrir's Chest": enums_js_1.ChestType.COMMON,
    'Fire Hydra Chest': enums_js_1.ChestType.COMMON,
    // All three Golden Guardian tiers, so an OCR variant folds onto the canonical
    // spelling instead of minting a second `chests` row — getOrCreateChestId has no
    // spelling-fold reuse scan of its own, and cleanupChestNames can only fold a bad
    // row back if the good name is in here. Legendary was missing since it shipped;
    // that left it (and the new Ascendant) parked in the Needs Review queue forever
    // while Epic was filtered out, which is the visible half of "not tracked the same".
    // COMMON for all three: getOrCreateChestId never refreshes chest_type on an
    // existing row, so the 382 Ascendant records already stored as common could never
    // be reconciled to a different rarity declared here.
    'Golden Guardian Ascendant Chest': enums_js_1.ChestType.COMMON,
    'Golden Guardian Epic Chest': enums_js_1.ChestType.COMMON,
    'Golden Guardian Legendary Chest': enums_js_1.ChestType.COMMON,
    "Governor's Chest": enums_js_1.ChestType.COMMON,
    'Great Hunt chest': enums_js_1.ChestType.COMMON,
    // Lowercase "chest" is the game's own spelling, as with "Dark Omens chest".
    "Hell's Blacksmith's chest": enums_js_1.ChestType.COMMON,
    'Hermes Chest': enums_js_1.ChestType.COMMON,
    'Inferno Chest': enums_js_1.ChestType.COMMON,
    // The game spells it with the umlaut. Both readings still land here — ocrNormalize folds
    // the accent, so "Jormungandr's Chest" matches this entry — and cleanupChestNames renames
    // any row already stored the plain way on the next boot.
    'Jörmungandr\'s Chest': enums_js_1.ChestType.COMMON,
    // Second tier of the Ashen squad's reward, alongside Ascendant above —
    // same pattern as the Golden Guardian tiers, and COMMON for the same reason
    // (the 566 rows already stored carry it and can never be reconciled up).
    'Legendary Ashen Chest': enums_js_1.ChestType.COMMON,
    'Lotus Chest': enums_js_1.ChestType.COMMON,
    'Major Omen Chest': enums_js_1.ChestType.UNCOMMON,
    "Merchant's Chest": enums_js_1.ChestType.COMMON,
    'Minor Omen Chest': enums_js_1.ChestType.COMMON,
    'Olympus Chest': enums_js_1.ChestType.COMMON,
    'Olympus Elite Chest': enums_js_1.ChestType.COMMON,
    'Prepared alchemical cauldron': enums_js_1.ChestType.COMMON,
    'Quick March Chest': enums_js_1.ChestType.COMMON,
    'Runic Chest': enums_js_1.ChestType.COMMON,
    // Declared ahead of its first scan: the Sacred Rituals tournament already
    // has a point value seeded, and pre-declaring a chest is supported (see
    // checkConfigIntegrity, which returns nothing for a name with no records).
    'Sacred Rituals Chest': enums_js_1.ChestType.COMMON,
    'Sakura of Plenty Chest': enums_js_1.ChestType.COMMON,
    'Sapphire Chest': enums_js_1.ChestType.COMMON,
    'Shadow Chest': enums_js_1.ChestType.COMMON,
    'Spoils of Dread Chest': enums_js_1.ChestType.COMMON,
    'Tartaros Chest': enums_js_1.ChestType.COMMON,
    'Undead Chest': enums_js_1.ChestType.COMMON,
    'Union Chest': enums_js_1.ChestType.COMMON,
};
/**
 * Strip common OCR artifacts and fix well-known letter swaps in a chest
 * name, WITHOUT matching against the `KNOWN_CHESTS` catalog. This is the
 * cleaning half of `correctChestName`, factored out so callers that must
 * NOT map to the catalog (the triumphal path — a triumphal row can never
 * be stored as e.g. "Runic Chest") can still normalise OCR noise before
 * storing a brand-new chest name.
 */
function cleanChestName(ocrName) {
    // Strip common OCR artifacts
    let cleaned = ocrName
        .replace(/^[\d\W]*\]\s*/, '') // "7] Orc Chest" → "Orc Chest"
        .replace(/^["|'™]+\s*/, '') // '™ Barbarian Chest' → "Barbarian Chest"
        .replace(/^[|=]+\s*/, '') // "| Elegant Chest" → "Elegant Chest"
        .replace(/\.\s*$/, '') // "Fire Chest." → "Fire Chest"
        .replace(/\s+/g, ' ')
        .trim();
    // Fix common OCR letter swaps
    cleaned = cleaned
        .replace(/^[Ss]arbarian/i, 'Barbarian') // s→B
        .replace(/^Ore Chest$/i, 'Orc Chest') // e↔c
        .replace(/^Ore chest$/i, 'Orc Chest')
        .replace(/eplc/gi, 'epic') // eplc → epic
        .replace(/^infernal/i, 'Infernal') // fix case
        .replace(/^stone/i, 'Stone')
        .replace(/^common /i, 'Common ')
        .replace(/^uncommon /i, 'Uncommon ')
        .replace(/^rare /i, 'Rare ');
    return cleaned;
}
/**
 * Fix OCR chest name by matching against known canonical names.
 * Strips common OCR artifacts and fuzzy-matches.
 */
function correctChestName(ocrName) {
    const cleaned = cleanChestName(ocrName);
    // Exact match
    if (exports.KNOWN_CHESTS[cleaned])
        return cleaned;
    // Case-insensitive match
    const lower = cleaned.toLowerCase();
    for (const name of Object.keys(exports.KNOWN_CHESTS)) {
        if (name.toLowerCase() === lower)
            return name;
    }
    // Fuzzy: check if any known name is contained in the OCR text
    for (const name of Object.keys(exports.KNOWN_CHESTS)) {
        if (lower.includes(name.toLowerCase()))
            return name;
    }
    // Same fuzzy match again, but with full OCR-character normalization.
    // Handles digit↔letter confusions (0↔o, 5↔S, 1↔l, !↔I, 8↔B) and
    // stripped apostrophes ("Priests Chest" → "Priest's Chest"). Both
    // the OCR text and the canonical names get normalized so confusions
    // in either direction are caught.
    const ocrNorm = (0, ocr_normalize_js_1.ocrNormalize)(cleaned);
    for (const name of Object.keys(exports.KNOWN_CHESTS)) {
        if (ocrNorm.includes((0, ocr_normalize_js_1.ocrNormalize)(name)))
            return name;
    }
    // Space-insensitive containment — final, most-lenient tier. PaddleOCR emits
    // words without inter-word spaces ("RunicChest") and glues the "Clan" icon
    // badge onto the name row ("Clan RunicChest"), neither of which the
    // space-preserving tiers above catch. Match on a space-stripped copy and,
    // to avoid a shorter name matching inside a longer one ("Common Chest of
    // Wealth" inside "Uncommon Chest of Wealth"), keep the LONGEST canonical
    // name that appears as a substring.
    const ocrNormNoSpace = ocrNorm.replace(/ /g, '');
    if (ocrNormNoSpace) {
        let bestName = '';
        let bestLen = 0;
        for (const name of Object.keys(exports.KNOWN_CHESTS)) {
            const nameNorm = (0, ocr_normalize_js_1.ocrNormalize)(name).replace(/ /g, '');
            if (nameNorm && nameNorm.length > bestLen && ocrNormNoSpace.includes(nameNorm)) {
                bestLen = nameNorm.length;
                bestName = name;
            }
        }
        if (bestName)
            return bestName;
    }
    return cleaned;
}
/**
 * Get the rarity type for a chest name.
 */
function getChestRarity(chestName) {
    const corrected = correctChestName(chestName);
    return exports.KNOWN_CHESTS[corrected] ?? enums_js_1.ChestType.COMMON;
}
/**
 * True when the OCR'd chest name resolves to a canonical entry in
 * KNOWN_CHESTS (either directly or via correctChestName's fuzzy tiers).
 * False when correctChestName fell through and returned the cleaned
 * input unchanged — that row is about to be stored as a brand-new
 * chest, which the scanner surfaces so an operator can review whether
 * it's a real new chest or OCR garbage.
 */
function isKnownChestName(chestName) {
    return exports.KNOWN_CHESTS[correctChestName(chestName)] !== undefined;
}
/**
 * The seeded set of triumphal (Bank Gifts tab) chest names. Historically
 * this was a closed set of six, but a game update added more bank chests
 * (e.g. Conqueror's Chest), so the runtime set is DB-managed and can grow:
 * superadmins add new ones via the Triumphal Chest Points admin card, and
 * the scan resolves OCR against the DB-backed list (falling back to this
 * seed). These are just the built-in defaults, not a hard limit.
 */
exports.TRIUMPHAL_CHEST_NAMES = [
    'Wooden Chest',
    'Bronze Chest',
    'Silver Chest',
    'Golden Chest',
    'Precious Chest',
    'Magic Chest',
    "Conqueror's Chest",
];
/**
 * Seed point values for a complete package (3-of-a-kind) of each built-in
 * triumphal chest. Historically these were only ever sold as three
 * identical chests, so these are the canonical "3-of-a-kind" values
 * (Magic 250 … Wooden 5; Conqueror's 10 — a $10 pack).
 *
 * A game update now sells them singly (1, 2, or 3 at a time), so each
 * chest is worth exactly one third of its package value. We keep the
 * whole-number package values rather than a rounded per-chest value:
 * scoring divides by three at full precision and rounds only the final
 * per-member total, so 3 identical chests always sum back to exactly the
 * package value (3 Golden = 50, never 51) while a single chest still
 * rounds to a sensible whole number (1 Golden = 17).
 *
 * These are only the SEED defaults: at v54 they're copied into the
 * `triumphal_chest_points` table, which is thereafter the authoritative,
 * superadmin-editable source of truth (see triumphal-points-repo.ts).
 */
exports.TRIUMPHAL_PACKAGE_POINTS = {
    'Magic Chest': 250,
    'Precious Chest': 100,
    'Golden Chest': 50,
    'Silver Chest': 20,
    'Bronze Chest': 10,
    'Wooden Chest': 5,
    "Conqueror's Chest": 10,
};
/**
 * Resolve an OCR'd chest name from the Triumphal (Bank) Gifts tab.
 *
 * First tries to match one of the KNOWN triumphal chests (correcting OCR
 * noise) — `knownNames` defaults to the built-in seed but the scan passes
 * the live DB-backed list so newly-added chests are recognised too.
 *
 * When nothing matches, the name is treated as a BRAND-NEW triumphal
 * chest: it's cleaned of OCR artifacts and returned as-is so it's stored
 * rather than silently dropped (it scores 0 until a superadmin assigns a
 * package value, and surfaces for review). Cleaning deliberately does NOT
 * consult the `KNOWN_CHESTS` catalog or merge rules, so a triumphal row
 * can never be mislabeled as a non-triumphal chest (e.g. "Runic Chest").
 *
 * Returns `null` only when the OCR text is empty/pure noise (nothing left
 * after cleaning) — the caller skips those rows.
 */
function correctTriumphalChestName(ocrName, knownNames = exports.TRIUMPHAL_CHEST_NAMES) {
    if (!ocrName)
        return null;
    const norm = (0, ocr_normalize_js_1.ocrNormalize)(ocrName);
    if (!norm)
        return null;
    const knownNorm = knownNames.map((name) => ({ name, norm: (0, ocr_normalize_js_1.ocrNormalize)(name) }));
    // Exact normalized match.
    for (const { name, norm: n } of knownNorm) {
        if (n === norm)
            return name;
    }
    // Substring containment in either direction (OCR added/clipped chars).
    for (const { name, norm: n } of knownNorm) {
        if (n && (norm.includes(n) || n.includes(norm)))
            return name;
    }
    // Nearest by edit distance — accept only when unambiguous: the best
    // match must be close (≤ 2 edits) AND clearly better than the runner-up
    // (≥ 2 edits clearer). "wooden" vs "golden" are only 2 edits apart, so
    // a tight, margin-checked threshold avoids flipping one into the other.
    let best = null;
    let bestDist = Infinity;
    let secondDist = Infinity;
    for (const { name, norm: n } of knownNorm) {
        const d = (0, ocr_normalize_js_1.levenshtein)(norm, n);
        if (d < bestDist) {
            secondDist = bestDist;
            bestDist = d;
            best = name;
        }
        else if (d < secondDist) {
            secondDist = d;
        }
    }
    if (best && bestDist <= 2 && secondDist - bestDist >= 2)
        return best;
    // No known triumphal chest matched — capture it as a new one rather
    // than dropping the row. Clean OCR artifacts only (never map to the
    // KNOWN_CHESTS catalog); an empty result means pure noise → skip.
    const cleaned = cleanChestName(ocrName);
    return cleaned || null;
}
/**
 * True when the chest name is in our hardcoded `KNOWN_CHESTS` map —
 * i.e. its rarity is already understood and the operator doesn't need
 * to review it. Used by the admin "Needs Review" queue to skip items
 * that are already part of the seeded catalog.
 */
function isHardcodedChestName(name) {
    return Object.prototype.hasOwnProperty.call(exports.KNOWN_CHESTS, name);
}
// Words that appear in chest names but aren't distinctive enough to act
// as a "this is the Gifts panel" signal — rarity adjectives show up in
// unrelated UI text constantly, and "chest"/"of"/"the" are too generic.
const CHEST_NAME_STOPWORDS = new Set([
    'chest', 'of', 'the', 'and',
    'common', 'uncommon', 'rare', 'epic', 'legendary', 'arena',
]);
const KNOWN_CHEST_TOKEN_REGEX = (() => {
    const tokens = new Set();
    for (const name of Object.keys(exports.KNOWN_CHESTS)) {
        // Fold before the [^a-z] strip, or an accented name contributes a mangled token:
        // "Jörmungandr's Chest" would offer "rmungandr" and never match the word in the text.
        for (const token of (0, ocr_normalize_js_1.foldDiacritics)(name).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)) {
            if (token.length >= 3 && !CHEST_NAME_STOPWORDS.has(token))
                tokens.add(token);
        }
    }
    return new RegExp(`\\b(${Array.from(tokens).sort().join('|')})\\b`, 'i');
})();
/**
 * True when the OCR text contains a distinctive word from any chest name
 * in `KNOWN_CHESTS` (e.g. "stone", "fire", "carrot"). Used by the
 * panel-header screen-state fallback to confirm "this looks like the
 * Gifts panel" when Tesseract garbles the stylized "Gifts" tab header.
 * Derived from the canonical chest list so new entries automatically
 * widen the heuristic.
 */
function containsKnownChestName(text) {
    // Fold the text as well as the token list, or an accented reading of an accented name
    // fails to match its own token ("jörmungandr" against the folded "jormungandr").
    return KNOWN_CHEST_TOKEN_REGEX.test((0, ocr_normalize_js_1.foldDiacritics)(text));
}
//# sourceMappingURL=chest-names.js.map