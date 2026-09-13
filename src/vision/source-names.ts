/**
 * Chest-source OCR cleanup, canonical source keys, and the official
 * point-value scoring table.
 */
import { foldDiacritics } from './ocr-normalize.js';

/**
 * Source-based point values from the official scoring system — the value that
 * applies to EVERY chest from a source, keyed by the canonical source key
 * (`type level`, e.g. "common 5", "epic 25", "elven citadel 20").
 *
 * Seeded from a live catalog export (data/exports/chest-catalog-*.json), which
 * is exactly what src/output/catalog-export.ts exists to produce: the admin
 * overrides a deployment has accumulated, in a form that can be dropped back
 * into the source tree so the NEXT install starts where this one ended up
 * instead of re-deriving the whole table by hand.
 *
 * A value here is only a default: the `source_point_overrides` table wins over
 * it always, so re-seeding this table never moves a running deployment's
 * scoring. It changes what a fresh install starts with, and nothing else.
 */
const SOURCE_POINTS: Record<string, number> = {
  // Crypts. The ladder is steep and deliberately so — it is the game's own
  // scoring, not a local house rule.
  'common 5': 1, 'common 10': 5, 'common 15': 25, 'common 20': 80, 'common 25': 275,
  'rare 10': 8, 'rare 15': 40, 'rare 20': 140, 'rare 25': 360, 'rare 30': 600,
  'epic 10': 10, 'epic 15': 60, 'epic 20': 225, 'epic 25': 450, 'epic 30': 700, 'epic 35': 1000,
  // 'common 30' / 'common 35' have no entry on purpose: the only chest that
  // drops from them is the Tartaros Chest, which is scored per-name below at
  // the EPIC ladder's 700/1000 rather than the common one.
  'elven citadel 10': 4, 'elven citadel 15': 20, 'elven citadel 20': 60, 'elven citadel 25': 250, 'elven citadel 30': 500,
  // Cursed citadels are still on the pre-rescale values — no override was ever
  // set for them, so these two are the only crypt/citadel rows here that the
  // live deployment has not confirmed. Left as they were rather than guessed at.
  'cursed citadel 20': 20, 'cursed citadel 25': 40,
  'arena': 10,
  'union reward': 50,
  'jormungandr shop': 25,
  'vault 10': 5, 'vault 15': 10, 'vault 20': 20, 'vault 25': 35, 'vault 30': 50, 'vault 35': 75,
  'vault 40': 100, 'vault 45': 150,
  // Event / reward / squad sources (seeded from catalog export)
  'alchemy tournament': 10,
  'authority rush tournament': 25,
  'azada s shop': 25,
  'beastman': 10,
  'carrot monster': 10,
  'clan wealth': 1,
  'clash for the throne tournament': 50,
  'dark omens event': 1,
  'epic ancient squad': 1,
  'epic ashen squad': 50,
  'epic basilisk squad': 100,
  'epic briareus squad': 100,
  'epic chimera squad': 100,
  'epic fenrir squad': 50,
  'epic inferno squad': 30,
  'epic undead squad': 50,
  'fallen king squad': 50,
  'hermes store': 25,
  // Heroic monsters: the flat `level` value is a placeholder the real scoring
  // has outgrown — the game pays by TIER, not by level (16-19 → 20, 20-24 → 60,
  // 25-29 → 150, 30-34 → 350, 35-39 → 625), which is what the per-chest table
  // below encodes. These stay as the floor for a heroic chest the per-chest
  // table doesn't name, e.g. the day the game adds a sixth monster type.
  'level 16 heroic monster': 16, 'level 17 heroic monster': 17, 'level 18 heroic monster': 18,
  'level 19 heroic monster': 19, 'level 20 heroic monster': 20, 'level 21 heroic monster': 21,
  'level 22 heroic monster': 22, 'level 23 heroic monster': 23, 'level 24 heroic monster': 24,
  'level 25 heroic monster': 25, 'level 26 heroic monster': 26, 'level 27 heroic monster': 27,
  'level 28 heroic monster': 28, 'level 29 heroic monster': 29, 'level 30 heroic monster': 30,
  'level 31 heroic monster': 31,
  'lvl 20 24 raid runic squad': 20,
  'lvl 25 29 raid runic squad': 25,
  'lvl 30 34 raid runic squad': 30,
  'lvl 35 39 raid runic squad': 35,
  'lvl 40 44 raid runic squad': 50,
  'lvl 45 raid runic squad': 75,
  'mercenary exchange': 25,
  'mimic chest': 15,
  'rise of the ancients event': 10,
  'sakura of plenty': 10,
  'shadow city': 50,
  'spoils of dread event': 50,
  'story': 15,
  'summoning dark omens': 15,
  'the great hunt tournament': 25,
  'yokai': 50,
};

/**
 * The source keys the flat table declares. Exported for the config guard in
 * tests/config/source-points-seed.test.ts, which checks them for canonical-key
 * collisions; nothing at runtime should need it (use getDefaultPointsForKey).
 */
export const SOURCE_POINT_KEYS: readonly string[] = Object.keys(SOURCE_POINTS);

/**
 * Per-(source key, chest NAME) default points — the layer the flat table above
 * cannot express.
 *
 * One source routinely pays different amounts for the chests it drops, and
 * rarity is not the discriminator (see src/data/repositories/source-points-repo.ts:
 * Minor/Major/Epic Omen Chest are all `common` yet score 50/100/150). Every
 * value here is a real one read off a live deployment's override table, so a
 * fresh install now scores a heroic kill or an omen summon correctly on its
 * first scan instead of at whatever the source-wide default happens to be.
 *
 * Resolution order, unchanged in spirit: an admin override for the exact
 * (source, chest) wins, then a wildcard override for the source, then THIS
 * table, then the source-wide default. Overrides always beat defaults — a
 * seeded value must never quietly outrank something an admin typed.
 *
 * Chest names must be the spelling `correctChestName` produces, for the same
 * reason event-catalog.ts must: `chests` rows are reconciled through it on
 * every boot, so a name this table spells differently is a name no row can
 * ever carry, and the entry would read as a silent 0-point default rather than
 * as an error. tests/config/source-points-seed.test.ts pins that.
 */
export const SOURCE_CHEST_POINTS: Record<string, Record<string, number>> = {
  'alchemy tournament': {
    'Gnome Workshop Chest': 10,
    'Prepared alchemical cauldron': 25,
    'Sakura of Plenty Chest': 25,
  },
  'arachne s swarm epic squad': { 'Arachne Chest': 500 },
  'arena': { 'Gladiator\'s Chest': 1 },
  'authority rush tournament': { 'Chest of Authority': 10 },
  'azada s shop': { 'Azada\'s Chest': 25 },
  'beastman': { 'Easter Chest': 50 },
  'clan wealth': {
    'Common Chest of Wealth': 1,
    'Epic Chest of Wealth': 1,
    'Rare Chest of Wealth': 1,
    'Uncommon Chest of Wealth': 1,
  },
  'common 10': { 'Tartaros Chest': 8 },
  'common 15': { 'Tartaros Chest': 60 },
  'common 20': { 'Tartaros Chest': 225 },
  'common 25': { 'Tartaros Chest': 450 },
  'common 30': { 'Tartaros Chest': 700 },
  'common 35': { 'Tartaros Chest': 1000 },
  'dark omens event': { 'Arcane Chest': 500, 'Dark Omens chest': 1 },
  'epic ancient squad': {
    'Golden Guardian Ascendant Chest': 3,
    'Golden Guardian Epic Chest': 1,
    'Golden Guardian Legendary Chest': 2,
  },
  'epic ashen squad': { 'Ascendant Ashen Chest': 100, 'Legendary Ashen Chest': 500 },
  'epic basilisk squad': { 'Basilisk Chest': 0 },
  'epic briareus squad': { 'Briareus Chest': 500 },
  'epic chimera squad': { 'Chimera Chest': 500 },
  'epic fenrir squad': { 'Fenrir\'s Chest': 150 },
  'epic inferno squad': { 'Fire Hydra Chest': 50, 'Hell\'s Blacksmith\'s chest': 50 },
  'epic jormungandr squad': { 'Jörmungandr\'s Chest': 500 },
  'epic undead squad': { 'Epic Monster Chest': 500 },
  'event trials of olympus': { 'Olympus Chest': 1, 'Olympus Elite Chest': 1 },
  'fallen king squad': { 'Fallen King Chest': 500 },
  'hermes store': { 'Hermes Chest': 50 },
  'jormungandr shop': { 'Jörmungandr\'s Chest': 500 },
  'level 16 heroic monster': { 'Undead Chest': 20 },
  'level 17 heroic monster': { 'Elven Chest': 20 },
  'level 18 heroic monster': { 'Cursed Chest': 20 },
  'level 19 heroic monster': { 'Barbarian Chest': 20 },
  'level 20 heroic monster': { 'Inferno Chest': 60 },
  'level 21 heroic monster': { 'Undead Chest': 60 },
  'level 22 heroic monster': { 'Elven Chest': 60 },
  'level 23 heroic monster': { 'Cursed Chest': 60 },
  'level 24 heroic monster': { 'Barbarian Chest': 60 },
  'level 25 heroic monster': { 'Inferno Chest': 150 },
  'level 26 heroic monster': { 'Undead Chest': 150 },
  'level 27 heroic monster': { 'Elven Chest': 150 },
  'level 28 heroic monster': { 'Cursed Chest': 150 },
  'level 29 heroic monster': { 'Barbarian Chest': 150 },
  'level 30 heroic monster': { 'Inferno Chest': 350 },
  'level 31 heroic monster': { 'Undead Chest': 350 },
  'level 32 heroic monster': { 'Elven Chest': 350 },
  'level 33 heroic monster': { 'Cursed Chest': 350 },
  'level 34 heroic monster': { 'Barbarian Chest': 350 },
  'level 35 heroic monster': { 'Inferno Chest': 625 },
  'level 36 heroic monster': { 'Undead Chest': 625 },
  'level 37 heroic monster': { 'Elven Chest': 625 },
  'level 38 heroic monster': { 'Cursed Chest': 625 },
  'level 39 heroic monster': { 'Barbarian Chest': 625 },
  'level 40 heroic monster': { 'Inferno Chest': 625 },
  'level 41 heroic monster': { 'Undead Chest': 10000 },
  'level 42 heroic monster': { 'Elven Chest': 10000 },
  'level 43 heroic monster': { 'Cursed Chest': 1000 },
  'level 44 heroic monster': { 'Barbarian Chest': 1000 },
  'level 45 heroic monster': { 'Inferno Chest': 1000 },
  'lvl 20 24 raid runic squad': { 'Runic Chest': 20 },
  'lvl 25 29 raid runic squad': { 'Runic Chest': 50 },
  'lvl 30 34 raid runic squad': { 'Runic Chest': 125 },
  'lvl 35 39 raid runic squad': { 'Runic Chest': 200 },
  'lvl 40 44 raid runic squad': { 'Runic Chest': 350 },
  'lvl 45 raid runic squad': { 'Runic Chest': 500 },
  'mimic chest': { 'Pacified Mimic Chest': 25 },
  'sacred rituals tournament': { 'Sacred Rituals Chest': 125 },
  'sakura of plenty': { 'Sakura of Plenty Chest': 10 },
  'shadow city': { 'Shadow Chest': 500 },
  'story': { 'Governor\'s Chest': 10 },
  'summoning dark omens': { 'Epic Omen Chest': 150, 'Major Omen Chest': 100, 'Minor Omen Chest': 50 },
};

/**
 * Clean up an OCR source string: strip "Open" button text, brackets, etc.
 */
export function cleanSource(ocrSource: string): string {
  return ocrSource
    .replace(/\s*\[?\s*(?:open|oper|oer|on)\s*\]?\s*$/i, '') // Strip Open button variants
    .replace(/[[\]]/g, '')   // Strip brackets
    .replace(/\s*[=]+\s*$/, '')  // Trailing "=="
    .replace(/\s+[A-Z]{1,2}\s*$/, '') // Trailing 1-2 uppercase letters (OCR junk like "EE")
    .replace(/\.+$/, '')     // Trailing periods
    .replace(/eplc/gi, 'epic') // OCR misread
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract the canonical "source key" from an OCR'd source string.
 * Returns strings like "epic 30", "common 25", "elven citadel 20", "arena".
 *
 * For known patterns (citadel, crypt, vault, arena, jormungandr, union) the
 * key is structured (`type level`) so all level/rarity variants of the same
 * source type collapse onto a single canonical key.
 *
 * For everything else — new game features the parser doesn't know about yet —
 * we fall back to a normalized slug of the raw string (lowercased,
 * non-alphanumerics → spaces, collapsed). This means new source types
 * automatically show up in the Source Point Values admin UI with default 0
 * points and admins can assign a value via the existing override flow
 * instead of waiting for a code change. Returns null only for empty strings
 * or pure-noise OCR (no letters / under 3 chars after normalization).
 */
/**
 * Extract the numeric level from a source string, or null when it has none.
 * Accepts "level 25", "lvl 25", "level 25-29" (for ranges the starting level
 * is used). Shared by getSourceKey and the Events breakdown so both read the
 * level the same way.
 */
export function parseSourceLevel(source: string): number | null {
  if (!source) return null;
  const m = source.toLowerCase().match(/(?:level|lvl)\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Extract the level *range* from a source string as a display string, e.g.
 * "20-24" from "Lvl 20-24 Raid Runic Squad". Falls back to the single level
 * ("25" from "Level 25 Crypt") when there's no adjacent second number, and to
 * null when the source has no level at all. Accepts a hyphen or plain space
 * between the two numbers so OCR variants ("Lvl 20-24" / "Lvl 20 24") collapse
 * to the same label. Used for level-event column headers so a ranged tier reads
 * "Runic Lvl 20-24" rather than "Runic Lvl 20".
 */
export function parseSourceLevelRange(source: string): string | null {
  if (!source) return null;
  const lower = source.toLowerCase();
  const range = lower.match(/(?:level|lvl)\s*(\d+)\s*(?:[-–—]\s*|\s+)(\d+)/);
  if (range) return `${range[1]}-${range[2]}`;
  const single = lower.match(/(?:level|lvl)\s*(\d+)/);
  return single ? single[1] : null;
}

export function getSourceKey(source: string): string | null {
  return deriveSourceKey(source);
}


function deriveSourceKey(source: string): string | null {
  if (!source) return null;
  const lower = source.toLowerCase();

  // Extract level number. Accepts "level 25", "lvl 25", "level 25-29"
  // (for vault ranges we use the starting level). The numbered match is
  // the first digit group after "level"/"lvl".
  const level = parseSourceLevel(source) ?? 0;

  if (lower.includes('citadel')) {
    if (lower.includes('cursed')) return `cursed citadel ${level}`;
    return `elven citadel ${level}`;
  }
  if (lower.includes('epic') && lower.includes('crypt')) return `epic ${level}`;
  if (lower.includes('rare') && lower.includes('crypt')) return `rare ${level}`;
  if (lower.includes('crypt')) return `common ${level}`;
  if (lower.includes('vault')) return `vault ${level}`;
  if (lower.includes('arena')) return 'arena';
  // A SQUAD named after Jörmungandr is not the Jörmungandr shop. Without this guard the
  // bare name match swallowed "Epic Jörmungandr squad" whenever OCR read the "ö" as a plain
  // "o" — so the same squad's chests landed in the shop's scoring bucket on some readings
  // and under their own key on others, which is the second half of the split that made
  // "epic j rmungandr squad" visible. Narrowed on 'squad' specifically, not on requiring
  // 'shop', because the real shop source strings are not all known here and demanding
  // 'shop' could silently re-point chests that are correctly classified today.
  if (lower.includes('jormungandr') && !lower.includes('squad')) return 'jormungandr shop';
  if (lower.includes('union')) return 'union reward';

  // Fallback: slugify unknown source types so they're configurable via the
  // admin UI without a code change. Drop pure-noise inputs (no letters, or
  // too short) to avoid creating keys from OCR garbage.
  //
  // Accents are folded, not stripped: without the fold the [^a-z0-9] class turns the "ö"
  // of "Epic Jörmungandr squad" into a SPACE and the key reads "epic j rmungandr squad" —
  // which is both what an admin sees on the source-points page and, worse, a different key
  // from the same source read without the umlaut.
  //
  // Applied HERE rather than to `lower` above on purpose. The pattern matchers ahead of
  // this include a bare `includes('jormungandr')`, so folding earlier would reclassify an
  // "Epic Jörmungandr squad" as the Jörmungandr SHOP and quietly re-point every one of its
  // chests. (That rule already does this to a source read with a plain "o" — a real
  // ambiguity, but one that moves scoring data and so is not this change's to make.)
  const slug = foldDiacritics(lower)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (slug.length < 3 || !/[a-z]/.test(slug)) return null;
  return slug;
}

/**
 * Space-insensitive canonical form of a source key: lowercase, alphanumerics
 * only. PaddleOCR drops the inter-word spaces that the slug-fallback keys are
 * built from ("Clan Wealth" → "ClanWealth" → slug "clanwealth" vs the historical
 * "clan wealth"), so all source-key *matching* (default points + admin
 * overrides) compares on this form. Stored/displayed keys keep their readable
 * spacing; only the comparison is normalized. Structured keys ("rare 10") are
 * unaffected in practice — they collapse to "rare10" identically on both sides.
 *
 * Folds accents for the same reason getSourceKey does, so a key that still carries one
 * ("Jörmungandr Shop") matches the folded slug. It cannot repair a key that was MANGLED by
 * the old behaviour, though — "epic j rmungandr squad" has lost the letter, not just its
 * accent, so an override stored under that key will read as an empty bucket until it is set
 * again.
 */
export function canonicalSourceKey(key: string): string {
  return foldDiacritics(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * True when two `chest_sources` STRINGS are the same real source spelled
 * differently — the test for "don't mint a second row for this".
 *
 * Deliberately a sibling of `canonicalSourceKey` rather than a widening of it.
 * That one is load-bearing for SCORING: it keys `SOURCE_POINTS_CANONICAL` and
 * the point-lookup cache, and production already stores overrides under keys
 * like "lvl 30 34 raid runic squad", so changing its semantics re-keys live
 * admin config. This one only decides row identity, so it can be more
 * aggressive — it additionally folds the game's own Lvl/Level abbreviation,
 * which OCR emits both ways ("Lvl 35-39 Vault of the Ancients" and
 * "Level 35-39 Vault of the Ancients" are one source, and prod holds both).
 * Scoring is unaffected either way, because getSourceKey already collapses that
 * pair to the same structured key.
 *
 * Unqualified `lvl` → `level`, not `\blvl\b`: PaddleOCR glues the number on
 * ("Lvl35-39"), where a word boundary never fires because "l" and "3" are both
 * word characters.
 *
 * NOT the same as `getSourceKey`, which is derived and lossier — "Level 10 Crypt"
 * and "Tartaros Crypt level 10" both derive "common 10" yet are two different
 * in-game sources. Grouping rows on that would fuse them.
 */
export function sourceSpellingKey(source: string): string {
  return foldDiacritics(source)
    .toLowerCase()
    .replace(/lvl/g, 'level')
    .replace(/[^a-z0-9]/g, '');
}

// Canonical-form index of the hardcoded point table, so a spaceless key from
// PaddleOCR ("clanwealth", "lvl3034raidrunicsquad") still resolves to the
// value stored under the spaced form ("clan wealth", "lvl 30 34 raid runic squad").
const SOURCE_POINTS_CANONICAL = new Map<string, number>(
  Object.entries(SOURCE_POINTS).map(([k, v]) => [canonicalSourceKey(k), v]),
);

// Same canonical-form index for the per-chest table. Only the SOURCE key is
// canonicalised: chest names are matched exactly, because a stored chest name
// has already been through correctChestName and so carries the one spelling
// this table is pinned against.
const SOURCE_CHEST_POINTS_CANONICAL = new Map<string, number>(
  Object.entries(SOURCE_CHEST_POINTS).flatMap(([key, byName]) =>
    Object.entries(byName).map(
      ([chestName, v]) => [`${canonicalSourceKey(key)}\t${chestName}`, v] as [string, number],
    ),
  ),
);

/**
 * Get the default (hardcoded) point value for a canonical source key.
 * This is the fallback when no admin override exists. Matches
 * space-insensitively so spaced (Tesseract/historical) and spaceless
 * (PaddleOCR) forms of the same source resolve to the same value.
 */
export function getDefaultPointsForKey(key: string | null): number {
  if (!key) return 0;
  return SOURCE_POINTS[key] ?? SOURCE_POINTS_CANONICAL.get(canonicalSourceKey(key)) ?? 0;
}

/**
 * Get the default point value for a source key AND a specific chest name:
 * the per-chest seed if this source pays that chest its own rate, else the
 * source-wide default.
 *
 * This is the bottom of the lookup stack, below both override layers — see
 * getPointsForSourceCached in src/data/repositories/source-points-repo.ts. Call
 * it rather than getDefaultPointsForKey wherever a chest name is in hand; the
 * key-only function stays for the places that legitimately have no name (the
 * source-wide "default" shown on the admin page, and the fallback a wildcard
 * row reverts to when its override is deleted).
 */
export function getDefaultPointsFor(key: string | null, chestName: string): number {
  if (!key) return 0;
  if (chestName) {
    const exact = SOURCE_CHEST_POINTS[key]?.[chestName];
    if (exact !== undefined) return exact;
    const canonical = SOURCE_CHEST_POINTS_CANONICAL.get(`${canonicalSourceKey(key)}\t${chestName}`);
    if (canonical !== undefined) return canonical;
  }
  return getDefaultPointsForKey(key);
}

/**
 * True for keys produced by the structured pattern matchers in
 * `getSourceKey()` (crypt/citadel/vault/arena/etc.). False for keys generated
 * by the slug fallback — those represent source types the parser doesn't know
 * yet and that the admin probably wants to review and assign points to.
 */
export function isKnownSourceKey(key: string): boolean {
  if (!key) return false;
  if (key === 'arena' || key === 'union reward' || key === 'jormungandr shop') return true;
  if (/^(common|rare|epic|vault) \d+$/.test(key)) return true;
  if (/^(elven citadel|cursed citadel) \d+$/.test(key)) return true;
  return false;
}

export function getPointsFromSource(source: string): number {
  return getDefaultPointsForKey(getSourceKey(source));
}

/**
 * True when the source string resolves to a canonical key with a
 * hardcoded point value in SOURCE_POINTS. The structured matchers
 * (crypt/citadel/vault/arena/etc.) and the named events that we've
 * seeded from prior catalog exports are all covered. Slug-fallback
 * keys for sources we haven't seen yet return false so they still
 * surface for admin review.
 */
export function isHardcodedSource(source: string): boolean {
  const key = getSourceKey(source);
  if (!key) return false;
  return Object.prototype.hasOwnProperty.call(SOURCE_POINTS, key);
}
