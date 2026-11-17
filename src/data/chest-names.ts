import { ChestType } from '../models/enums.js';

/**
 * The site's type for every chest it does not count as common. Anything not
 * listed is common — including the bottom rung of each ladder below (Common
 * Chest of Wealth, Wooden Chest).
 *
 * Chest NAMES are not listed anywhere any more: every chest arrives from the
 * game under the game's own name (protocol-scan.ts), so the old hand catalog
 * and its OCR spelling corrections went with the screenshot scanner (Nov 2026).
 *
 * The TYPE stays ours, because the game has no equivalent. Its only grade is
 * the item quality (T8 f10, the forge's ladder 1 Poor … 8 Godlike), checked
 * against all 97 chest names stored on prod on Nov 17 2026:
 *  - It belongs to a gift type — a chest AND a source — and follows the crypt
 *    or monster LEVEL: Barbarian Chest is grade 2 from a Level 5 Crypt and 6
 *    from a Level 25 one. Read as common (1–2), uncommon (3), rare (4), epic
 *    (5), legendary (6+), 50 of the 97 names span several types, so no one
 *    type per name can be read off it.
 *  - The other 46 still aren't this categorisation: 36 would change — the
 *    event chests to legendary (grades 6–8), Gladiator's Chest to common
 *    (grade 1), every Bank chest one step up (Wooden 3 … Magic 8). Only the
 *    Chests of Wealth line up.
 * The part of a type the game does state per record — which kind of crypt a
 * chest came from — is already taken from the game's source name
 * (getSourceRarity, v83), and outranks the chest's own type on every record.
 *
 * syncChestTypes (database.ts) applies this to stored chests on every boot;
 * the scan uses it for a chest's first record. Types are display categories
 * (badges, the by-type breakdowns) — points key on (source, chest name), never
 * on the type.
 */
export const CHEST_TYPES: Readonly<Record<string, ChestType>> = {
  // Clan wealth: typed by the rarity in its own name.
  'Uncommon Chest of Wealth': ChestType.UNCOMMON,
  'Rare Chest of Wealth': ChestType.RARE,
  'Epic Chest of Wealth': ChestType.EPIC,
  'Legendary Chest of Wealth': ChestType.LEGENDARY,
  // Rare crypts.
  'Rare Dragon Chest': ChestType.RARE,
  // Epic crypts.
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
  // Citadels.
  'Elven Citadel Chest': ChestType.EPIC,
  'Cursed Citadel Chest': ChestType.EPIC,
  // Arena.
  "Gladiator's Chest": ChestType.ARENA,
  // Triumphal / Bank, by package size (Wooden is common).
  'Bronze Chest': ChestType.UNCOMMON,
  'Silver Chest': ChestType.RARE,
  'Golden Chest': ChestType.EPIC,
  'Precious Chest': ChestType.LEGENDARY,
  'Magic Chest': ChestType.LEGENDARY,
  // Dark Omens summons (Minor Omen Chest is common).
  'Major Omen Chest': ChestType.UNCOMMON,
  'Epic Omen Chest': ChestType.EPIC,
};

/** The type CHEST_TYPES declares for this exact name, if any. */
export function declaredChestType(chestName: string): ChestType | undefined {
  return Object.prototype.hasOwnProperty.call(CHEST_TYPES, chestName) ? CHEST_TYPES[chestName] : undefined;
}

/** A chest's type: the declared one, else common. */
export function chestTypeFor(chestName: string): ChestType {
  return declaredChestType(chestName) ?? ChestType.COMMON;
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
