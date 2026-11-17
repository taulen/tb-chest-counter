import { ChestType } from '../models/enums.js';
import { ocrNormalize } from '../utils/name-normalize.js';

/**
 * Canonical chest names from TBChestTracker + in-game observations.
 * Maps exact chest name → rarity type. This is the one place a chest's type
 * is set: syncChestTypes (database.ts) applies it to stored chests on every
 * boot. A crypt's own rarity still wins per record (getSourceRarity).
 */
export const KNOWN_CHESTS: Record<string, ChestType> = {
  // Common crypt chests
  'Elegant Chest': ChestType.COMMON,
  'Fire Chest': ChestType.COMMON,
  'Forgotten Chest': ChestType.COMMON,
  'Cobra Chest': ChestType.COMMON,
  'Orc Chest': ChestType.COMMON,
  'Barbarian Chest': ChestType.COMMON,
  'Infernal Chest': ChestType.COMMON,
  'Mayan Chest': ChestType.COMMON,
  'Sand Chest': ChestType.COMMON,
  'Stone Chest': ChestType.COMMON,
  'Gnome Workshop Chest': ChestType.COMMON,
  'Carrot Chest': ChestType.COMMON,
  'Bone Chest': ChestType.COMMON,
  'Ore Chest': ChestType.COMMON, // OCR misread of Orc Chest, but keep as fallback
  // Wealth chests (clan)
  'Common Chest of Wealth': ChestType.COMMON,
  'Uncommon Chest of Wealth': ChestType.UNCOMMON,
  'Rare Chest of Wealth': ChestType.RARE,
  'Epic Chest of Wealth': ChestType.EPIC,
  // Typed by the rarity in its own name, like the four above.
  'Legendary Chest of Wealth': ChestType.LEGENDARY,
  // Rare crypt chests
  'Rare Dragon Chest': ChestType.RARE,
  // Epic crypt chests
  "Ancient Warrior's Chest": ChestType.EPIC,
  'Harpy Chest': ChestType.EPIC,
  'Trillium Chest': ChestType.EPIC,
  'Scarab Chest': ChestType.EPIC,
  'Cobalt Chest': ChestType.EPIC,
  'Minotaur Chest': ChestType.EPIC,
  'White Wood Chest': ChestType.EPIC,
  'Titansteel Chest': ChestType.EPIC,
  'Abandoned Chest': ChestType.EPIC,
  'Braided Chest': ChestType.EPIC,
  'Scorpion Chest': ChestType.EPIC,
  'Chest of the Cursed': ChestType.EPIC,
  'Ancient Bastion Chest': ChestType.EPIC,
  'House of Horrors Chest': ChestType.EPIC,
  'Turtle Chest': ChestType.EPIC,
  "Priest's Chest": ChestType.EPIC,
  'Pacified Mimic Chest': ChestType.EPIC,
  // Citadel chests
  'Elven Citadel Chest': ChestType.EPIC,
  'Cursed Citadel Chest': ChestType.EPIC,
  // Arena
  "Gladiator's Chest": ChestType.ARENA,
  // Triumphal / Bank
  'Wooden Chest': ChestType.COMMON,
  'Bronze Chest': ChestType.UNCOMMON,
  'Silver Chest': ChestType.RARE,
  'Golden Chest': ChestType.EPIC,
  'Precious Chest': ChestType.LEGENDARY,
  'Magic Chest': ChestType.LEGENDARY,
  // Event / reward chests (seeded from catalog export)
  "Ancients' Chest": ChestType.COMMON,
  'Arachne Chest': ChestType.COMMON,
  'Arcane Chest': ChestType.COMMON,
  'Ascendant Ashen Chest': ChestType.COMMON,
  "Azada's Chest": ChestType.COMMON,
  'Basilisk Chest': ChestType.COMMON,
  'Briareus Chest': ChestType.COMMON,
  'Chest of Authority': ChestType.COMMON,
  'Chimera Chest': ChestType.COMMON,
  'Cursed Chest': ChestType.COMMON,
  'Dark Omens chest': ChestType.COMMON,
  'Dark Omens ranking chest': ChestType.COMMON,
  'Easter Chest': ChestType.COMMON,
  'Elven Chest': ChestType.COMMON,
  'Epic Monster Chest': ChestType.COMMON,
  'Epic Omen Chest': ChestType.EPIC,
  'Fallen King Chest': ChestType.COMMON,
  "Fenrir's Chest": ChestType.COMMON,
  'Fire Hydra Chest': ChestType.COMMON,
  // All three Golden Guardian tiers, so an OCR variant folds onto the canonical
  // spelling instead of minting a second `chests` row — getOrCreateChestId has no
  // spelling-fold reuse scan of its own, and cleanupChestNames can only fold a bad
  // row back if the good name is in here. Legendary was missing since it shipped;
  // that left it (and the new Ascendant) parked in the Needs Review queue forever
  // while Epic was filtered out, which is the visible half of "not tracked the same".
  'Golden Guardian Ascendant Chest': ChestType.COMMON,
  'Golden Guardian Epic Chest': ChestType.COMMON,
  'Golden Guardian Legendary Chest': ChestType.COMMON,
  "Governor's Chest": ChestType.COMMON,
  'Great Hunt chest': ChestType.COMMON,
  // Lowercase "chest" is the game's own spelling, as with "Dark Omens chest".
  "Hell's Blacksmith's chest": ChestType.COMMON,
  'Hermes Chest': ChestType.COMMON,
  'Inferno Chest': ChestType.COMMON,
  // The game spells it with the umlaut. Both readings still land here — ocrNormalize folds
  // the accent, so "Jormungandr's Chest" matches this entry — and cleanupChestNames renames
  // any row already stored the plain way on the next boot.
  'Jörmungandr\'s Chest': ChestType.COMMON,
  // Second tier of the Ashen squad's reward, alongside Ascendant above —
  // same pattern as the Golden Guardian tiers.
  'Legendary Ashen Chest': ChestType.COMMON,
  'Lotus Chest': ChestType.COMMON,
  'Major Omen Chest': ChestType.UNCOMMON,
  "Merchant's Chest": ChestType.COMMON,
  'Minor Omen Chest': ChestType.COMMON,
  'Olympus Chest': ChestType.COMMON,
  'Olympus Elite Chest': ChestType.COMMON,
  'Prepared alchemical cauldron': ChestType.COMMON,
  'Quick March Chest': ChestType.COMMON,
  'Runic Chest': ChestType.COMMON,
  // Declared ahead of its first scan: the Sacred Rituals tournament already
  // has a point value seeded, and pre-declaring a chest is supported (see
  // checkConfigIntegrity, which returns nothing for a name with no records).
  'Sacred Rituals Chest': ChestType.COMMON,
  'Sakura of Plenty Chest': ChestType.COMMON,
  'Sapphire Chest': ChestType.COMMON,
  'Shadow Chest': ChestType.COMMON,
  'Spoils of Dread Chest': ChestType.COMMON,
  'Tartaros Chest': ChestType.COMMON,
  'Undead Chest': ChestType.COMMON,
  'Union Chest': ChestType.COMMON,
};

/**
 * Strip common OCR artifacts and fix well-known letter swaps in a chest
 * name, WITHOUT matching against the `KNOWN_CHESTS` catalog. This is the
 * cleaning half of `correctChestName`, factored out so callers that must
 * NOT map to the catalog (the triumphal path — a triumphal row can never
 * be stored as e.g. "Runic Chest") can still normalise OCR noise before
 * storing a brand-new chest name.
 */
export function cleanChestName(ocrName: string): string {
  // Strip common OCR artifacts
  let cleaned = ocrName
    .replace(/^[\d\W]*\]\s*/, '')   // "7] Orc Chest" → "Orc Chest"
    .replace(/^["|'™]+\s*/, '')     // '™ Barbarian Chest' → "Barbarian Chest"
    .replace(/^[|=]+\s*/, '')       // "| Elegant Chest" → "Elegant Chest"
    .replace(/\.\s*$/, '')          // "Fire Chest." → "Fire Chest"
    .replace(/\s+/g, ' ')
    .trim();

  // Fix common OCR letter swaps
  cleaned = cleaned
    .replace(/^[Ss]arbarian/i, 'Barbarian')      // s→B
    .replace(/^Ore Chest$/i, 'Orc Chest')       // e↔c
    .replace(/^Ore chest$/i, 'Orc Chest')
    .replace(/eplc/gi, 'epic')                    // eplc → epic
    .replace(/^infernal/i, 'Infernal')            // fix case
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
export function correctChestName(ocrName: string): string {
  const cleaned = cleanChestName(ocrName);

  // Exact match
  if (KNOWN_CHESTS[cleaned]) return cleaned;

  // Case-insensitive match
  const lower = cleaned.toLowerCase();
  for (const name of Object.keys(KNOWN_CHESTS)) {
    if (name.toLowerCase() === lower) return name;
  }

  // Fuzzy: check if any known name is contained in the OCR text
  for (const name of Object.keys(KNOWN_CHESTS)) {
    if (lower.includes(name.toLowerCase())) return name;
  }

  // Same fuzzy match again, but with full OCR-character normalization.
  // Handles digit↔letter confusions (0↔o, 5↔S, 1↔l, !↔I, 8↔B) and
  // stripped apostrophes ("Priests Chest" → "Priest's Chest"). Both
  // the OCR text and the canonical names get normalized so confusions
  // in either direction are caught.
  const ocrNorm = ocrNormalize(cleaned);
  for (const name of Object.keys(KNOWN_CHESTS)) {
    if (ocrNorm.includes(ocrNormalize(name))) return name;
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
    for (const name of Object.keys(KNOWN_CHESTS)) {
      const nameNorm = ocrNormalize(name).replace(/ /g, '');
      if (nameNorm && nameNorm.length > bestLen && ocrNormNoSpace.includes(nameNorm)) {
        bestLen = nameNorm.length;
        bestName = name;
      }
    }
    if (bestName) return bestName;
  }

  return cleaned;
}

/**
 * Get the rarity type for a chest name.
 */
export function getChestRarity(chestName: string): ChestType {
  const corrected = correctChestName(chestName);
  return KNOWN_CHESTS[corrected] ?? ChestType.COMMON;
}

/**
 * The seeded set of triumphal (Bank Gifts tab) chest names. Historically
 * this was a closed set of six, but a game update added more bank chests
 * (e.g. Conqueror's Chest), so the runtime set is DB-managed and can grow:
 * superadmins add new ones via the Triumphal Chest Points admin card. These
 * are just the built-in defaults, not a hard limit.
 */
export const TRIUMPHAL_CHEST_NAMES = [
  'Wooden Chest',
  'Bronze Chest',
  'Silver Chest',
  'Golden Chest',
  'Precious Chest',
  'Magic Chest',
  "Conqueror's Chest",
] as const;

export type TriumphalChestName = typeof TRIUMPHAL_CHEST_NAMES[number];

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
export const TRIUMPHAL_PACKAGE_POINTS: Record<TriumphalChestName, number> = {
  'Magic Chest': 250,
  'Precious Chest': 100,
  'Golden Chest': 50,
  'Silver Chest': 20,
  'Bronze Chest': 10,
  'Wooden Chest': 5,
  "Conqueror's Chest": 10,
};

/**
 * True when the chest name is in our hardcoded `KNOWN_CHESTS` map —
 * i.e. its rarity is already understood and the operator doesn't need
 * to review it. Used by the admin "Needs Review" queue to skip items
 * that are already part of the seeded catalog.
 */
export function isHardcodedChestName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(KNOWN_CHESTS, name);
}
