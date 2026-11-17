/**
 * Normalise a chest, source or sender name for matching the game's spelling
 * against the one already stored: case, spacing, "Lvl"/"Level" and dash style.
 * The game says "Level 25–29 Vault of the Ancients" where rows recorded before
 * the switch to the game protocol say "Lvl 25-29 Vault of the Ancients"; both
 * normalise the same, so the protocol scan keeps writing the stored spelling.
 */
export function normalizeGiftText(s: string): string {
  return s.toLowerCase().replace(/\blvl\b/g, 'level').replace(/[–—]/g, '-').replace(/\s+/g, '');
}
