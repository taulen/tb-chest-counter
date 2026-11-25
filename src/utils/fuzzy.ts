import type { ClanMember } from '../models/types.js';
import { foldDiacritics, despace } from './name-normalize.js';

// Accented characters (è, À, ü, …) compare equal to their ASCII base letter on both
// sides. foldDiacritics is the one shared copy.
function prepareForMatch(raw: string): string {
  return foldDiacritics(raw.trim().toLowerCase().replace(/\s+/g, ' '));
}

/**
 * The member a name belongs to: an accent- and case-folded match on the name or
 * an alias, else on the despaced key (spacing and punctuation ignored). No
 * distance tier any more — names come from the game exactly, and the
 * edit-distance matcher built for OCR misreads went with the last caller that
 * fed it typed or pasted names (the event standings paste, Nov 25 2026).
 *
 * Two separate sweeps, not two conditions inside one loop: ranking the rules
 * per member instead of per pass would let a despaced hit on the first member
 * beat a genuinely spelled-out hit on the fifth.
 */
export function exactMatchMember(
  rawName: string,
  members: ClanMember[],
): ClanMember | null {
  const normalized = prepareForMatch(rawName);
  if (!normalized) return null;
  for (const m of members) {
    if (prepareForMatch(m.normalizedName) === normalized) return m;
    if (m.aliases.some((a: string) => prepareForMatch(a) === normalized)) return m;
  }

  const key = despace(rawName);
  if (!key) return null;
  for (const m of members) {
    if (despace(m.normalizedName) === key) return m;
    if (m.aliases.some((a: string) => despace(a) === key)) return m;
  }
  return null;
}
