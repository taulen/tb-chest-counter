/**
 * What one member's leaderboard points were made of in a window: their chests
 * grouped by the source that paid them — "Level 10 Crypt · 100 chests · 500
 * points" — in the sections of the FAQ's points table (points-guide.ts), so a
 * visitor can read the two side by side. Behind the public share page's
 * per-player hover card and tap-to-open sheet (lib/leaderboard-breakdown.js).
 *
 * Totals are the leaderboard row's own: getMemberChestsBySource runs
 * computeLeaderboard's WHERE with the member added, clan-reward exclusion
 * included, and every record lands in exactly one group here.
 *
 * A source is identified the way scoring identifies it — getSourceKey, compared
 * despaced (canonicalSourceKey) — so OCR spellings of one source are one line.
 * The line is labelled with the game's own text for it (the spelling the clan
 * has received most), not a name built from the key: that text is what a player
 * recognises, and what tGame()'s "Level {n} Crypt" patterns translate.
 */

import { getDb } from './database.js';
import { getMemberChestsBySource } from './repositories/chest-repo.js';
import { getSourceKeySummary } from './repositories/source-points-repo.js';
import { sourceCategory, sourceSortRank, SOURCE_CATEGORIES, type SourceCategory } from './source-categories.js';
import { canonicalSourceKey, getSourceKey, parseSourceLevel } from '../vision/source-names.js';

/** The FAQ points table's sections: crypts and citadels share one, as there. */
export type BreakdownSectionKey =
  | 'crypts' | 'heroic' | 'squads' | 'runic' | 'vault' | 'events' | 'tournaments' | 'shops' | 'other';

const SECTION_ORDER: readonly BreakdownSectionKey[] = [
  'crypts', 'heroic', 'squads', 'runic', 'vault', 'events', 'tournaments', 'shops', 'other',
];

/** Sections whose sources are a level ladder, listed by tier and level rather than by points. */
const LADDER_SECTIONS = new Set<BreakdownSectionKey>(['crypts', 'heroic', 'runic', 'vault']);

const CATEGORY_INDEX = new Map(SOURCE_CATEGORIES.map((c, i) => [c.key, i]));

export interface MemberBreakdownRow {
  /** The game's text for the source; '' for chests recorded without one. */
  source: string;
  chests: number;
  points: number;
}

export interface MemberBreakdownSection {
  key: BreakdownSectionKey;
  chests: number;
  points: number;
  rows: MemberBreakdownRow[];
}

export interface MemberSourceBreakdown {
  memberId: number;
  memberName: string;
  totalChests: number;
  totalPoints: number;
  sections: MemberBreakdownSection[];
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function sectionFor(category: SourceCategory): BreakdownSectionKey {
  return category === 'citadels' ? 'crypts' : category;
}

/**
 * The clan's most-received spelling of each source, by despaced key. From the
 * per-clan source summary the FAQ and the Chest Points board already read, so
 * it is warm (and shared) in the common case.
 */
function clanSourceSpellings(clanId: number): Map<string, string> {
  const best = new Map<string, { source: string; count: number }>();
  for (const s of getSourceKeySummary(clanId)) {
    if (!s.sampleSource || s.totalCount === 0) continue;
    const canon = canonicalSourceKey(s.sourceKey);
    const cur = best.get(canon);
    if (!cur || s.totalCount > cur.count) best.set(canon, { source: s.sampleSource, count: s.totalCount });
  }
  return new Map([...best].map(([canon, v]) => [canon, v.source]));
}

/**
 * Fold per-source-string counts into sections. Pure, for the tests.
 *
 * `spellings` maps a despaced source key to the label to show for it; a key it
 * doesn't know is labelled with this member's most-received spelling.
 */
export function foldMemberSources(
  raw: readonly { source: string; chests: number; points: number }[],
  spellings: ReadonlyMap<string, string> = new Map(),
): Pick<MemberSourceBreakdown, 'totalChests' | 'totalPoints' | 'sections'> {
  interface Bucket {
    key: string | null;
    label: string;
    labelChests: number;
    chests: number;
    points: number;
  }
  const buckets = new Map<string, Bucket>();
  for (const r of raw) {
    const key = r.source ? getSourceKey(r.source) : null;
    // '' collects everything without a usable source: no source recorded, or
    // one too garbled to key.
    const canon = key ? canonicalSourceKey(key) : '';
    let b = buckets.get(canon);
    if (!b) {
      b = { key, label: '', labelChests: -1, chests: 0, points: 0 };
      buckets.set(canon, b);
    }
    b.chests += r.chests;
    b.points += r.points;
    if (key && r.chests > b.labelChests) {
      b.label = r.source;
      b.labelChests = r.chests;
    }
    // The spaced spelling of a key is the one the category patterns read.
    if (key && b.key && key.split(' ').length > b.key.split(' ').length) b.key = key;
  }

  interface Line extends MemberBreakdownRow {
    category: SourceCategory;
    rank: number;
    level: number;
  }
  const bySection = new Map<BreakdownSectionKey, Line[]>();
  let totalChests = 0;
  let totalPoints = 0;
  for (const [canon, b] of buckets) {
    totalChests += b.chests;
    totalPoints += b.points;
    const category: SourceCategory = b.key ? sourceCategory(b.key) : 'other';
    const source = b.key ? (spellings.get(canon) ?? b.label) : '';
    const level = parseSourceLevel(source) ?? Number(/(\d+)/.exec(b.key ?? '')?.[1] ?? 0);
    const line: Line = {
      source,
      chests: b.chests,
      points: b.points,
      category,
      rank: b.key ? sourceSortRank(b.key) : 0,
      level,
    };
    const section = sectionFor(category);
    const list = bySection.get(section) ?? [];
    list.push(line);
    bySection.set(section, list);
  }

  const sections: MemberBreakdownSection[] = [];
  for (const key of SECTION_ORDER) {
    const lines = bySection.get(key);
    if (!lines) continue;
    lines.sort(LADDER_SECTIONS.has(key)
      // Crypts before citadels, then common → rare → epic → Tartaros, then level.
      ? (a, b) => (CATEGORY_INDEX.get(a.category) ?? 99) - (CATEGORY_INDEX.get(b.category) ?? 99)
        || a.rank - b.rank
        || a.level - b.level
        || collator.compare(a.source, b.source)
      // Named sources: what paid most first. The no-source line sorts like any other.
      : (a, b) => b.points - a.points || b.chests - a.chests || collator.compare(a.source, b.source));
    sections.push({
      key,
      chests: lines.reduce((n, l) => n + l.chests, 0),
      points: lines.reduce((n, l) => n + l.points, 0),
      rows: lines.map(({ source, chests, points }) => ({ source, chests, points })),
    });
  }
  return { totalChests, totalPoints, sections };
}

/**
 * The breakdown for one ACTIVE member of `clanId` over [from, to) (ISO; both
 * optional, as on the leaderboard), or null when the clan has no such member —
 * the same set of people the board lists, so the endpoint reveals nobody the
 * board doesn't.
 */
export function getMemberSourceBreakdown(
  clanId: number,
  memberId: number,
  from?: string,
  to?: string,
): MemberSourceBreakdown | null {
  const member = getDb()
    .prepare('SELECT name FROM members WHERE id = ? AND clan_id = ? AND is_active = 1')
    .get(memberId, clanId) as { name: string } | undefined;
  if (!member) return null;
  const raw = getMemberChestsBySource(clanId, memberId, from, to);
  return {
    memberId,
    memberName: member.name,
    ...foldMemberSources(raw, clanSourceSpellings(clanId)),
  };
}
