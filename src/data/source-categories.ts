/**
 * Which family a chest source belongs to — the grouping shared by the
 * leaderboard FAQ's points table (points-guide.ts) and the Chest Points admin
 * board (points-board.ts), so the two never disagree about where a source
 * lives.
 *
 * Keyed on the canonical source key from getSourceKey(). Keys are matched in
 * their despaced form too, because PaddleOCR drops the spaces the slug-fallback
 * keys are built from ("level16heroicmonster"). Anything unrecognised lands in
 * "other": the failure mode of a new source is a row in the wrong box, never a
 * missing one.
 */
import { canonicalSourceKey } from '../vision/source-names.js';

export type SourceCategory =
  | 'crypts' | 'citadels' | 'heroic' | 'squads' | 'runic' | 'vault'
  | 'events' | 'tournaments' | 'shops' | 'other';

/** Display order and titles. */
export const SOURCE_CATEGORIES: readonly { key: SourceCategory; title: string }[] = [
  { key: 'crypts', title: 'Crypts' },
  { key: 'citadels', title: 'Citadels' },
  { key: 'heroic', title: 'Heroic Monsters' },
  { key: 'squads', title: 'Epic Squads' },
  { key: 'runic', title: 'Runic Raids' },
  { key: 'vault', title: 'Vault of the Ancients' },
  { key: 'events', title: 'Events' },
  { key: 'tournaments', title: 'Tournaments' },
  { key: 'shops', title: 'Shops' },
  { key: 'other', title: 'Other' },
];

export function sourceCategory(key: string): SourceCategory {
  const canon = canonicalSourceKey(key);
  if (/^(common|rare|epic|tartaros) \d+$/.test(key)) return 'crypts';
  if (/^(elven|cursed) citadel \d+$/.test(key)) return 'citadels';
  if (/^level\d+heroicmonster$/.test(canon)) return 'heroic';
  if (/^vault \d+$/.test(key)) return 'vault';
  if (canon.includes('runic')) return 'runic';
  if (canon.includes('squad') || canon === 'shadowcity') return 'squads';
  if (canon.includes('tournament')) return 'tournaments';
  if (/shop|store|exchange/.test(canon)) return 'shops';
  if (/event|omens|carrot|beastman|yokai|sakura|pumpkin/.test(canon)) return 'events';
  return 'other';
}
