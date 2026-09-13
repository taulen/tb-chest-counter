import * as chestRepo from '../data/repositories/chest-repo.js';
import * as mergeRepo from '../data/repositories/merge-repo.js';
import * as sourcePointsRepo from '../data/repositories/source-points-repo.js';
import { getDb } from '../data/database.js';
import { getSourceKey, getDefaultPointsForKey, isKnownSourceKey } from '../vision/source-names.js';

// v1: flat sourceKeys entries with a single pointValue per key.
// v2: sourceKeys gained a tiers[] array keyed on chest_type.
// v3: tiers[] renamed to chestNames[] and keyed on chest_name instead of
//     chest_type, since rarity isn't granular enough to differentiate
//     chests that share a source (e.g. Minor/Major/Epic Omen Chest are
//     all common). sourcePointOverrides rows carry chestName.
const CATALOG_SCHEMA_VERSION = 3;

/**
 * Snapshot of every chest name, chest source, and admin correction currently
 * in the DB. The goal is to produce a single JSON dump that can be dropped
 * into the source tree to seed KNOWN_CHESTS / SOURCE_POINTS for new
 * deployments, so fresh installs don't re-discover the same OCR fixes.
 *
 * Unlike the full JSON export, this intentionally excludes chest_records,
 * members, and sessions — it's a catalog, not a backup.
 */
export function exportCatalog(clanId: number): object {
  const names = chestRepo.getDistinctChestNames(clanId);
  const sources = chestRepo.getDistinctChestSources(clanId);
  const mergeRules = mergeRepo.getMergeRules(clanId);
  const chestTypeOverrides = mergeRepo.getChestTypeOverrides(clanId);
  const sourcePointOverrides = sourcePointsRepo.getAllOverrides();

  // Index overrides by sourceKey so we can fold name-specific rows into
  // the source buckets below. A source key may have a wildcard row and
  // zero or more name-specific rows.
  const overridesBySource = new Map<string, Map<string, number>>();
  for (const ov of sourcePointOverrides) {
    let inner = overridesBySource.get(ov.sourceKey);
    if (!inner) {
      inner = new Map();
      overridesBySource.set(ov.sourceKey, inner);
    }
    inner.set(ov.chestName, ov.pointValue);
  }

  // Per-chest chest counts grouped by source_key, including each row's
  // chest_type for the UI badge (lookup doesn't use it).
  const db = getDb();
  const chestCountRows = db.prepare(`
    SELECT chest_source, chest_name, chest_type, COUNT(*) as cnt
    FROM chest_records_v
    WHERE clan_id = ? AND chest_source != ''
    GROUP BY chest_source, chest_name, chest_type
  `).all(clanId) as { chest_source: string; chest_name: string; chest_type: string; cnt: number }[];

  interface SourceKeyBucket {
    defaultPoints: number;
    isCustom: boolean;
    count: number;
    variants: Set<string>;
    // chest_name -> { count, majority chest_type }
    chestCounts: Map<string, { count: number; chestType: string; typeCount: number }>;
  }
  const sourceKeyBuckets = new Map<string, SourceKeyBucket>();
  const unparseableSources: { source: string; count: number }[] = [];

  for (const { source, count } of sources) {
    const key = getSourceKey(source);
    if (!key) {
      unparseableSources.push({ source, count });
      continue;
    }
    let bucket = sourceKeyBuckets.get(key);
    if (!bucket) {
      bucket = {
        defaultPoints: getDefaultPointsForKey(key),
        isCustom: !isKnownSourceKey(key),
        count: 0,
        variants: new Set(),
        chestCounts: new Map(),
      };
      sourceKeyBuckets.set(key, bucket);
    }
    bucket.count += count;
    bucket.variants.add(source);
  }

  for (const row of chestCountRows) {
    const key = getSourceKey(row.chest_source);
    if (!key) continue;
    const bucket = sourceKeyBuckets.get(key);
    if (!bucket) continue;
    const existing = bucket.chestCounts.get(row.chest_name);
    if (existing) {
      existing.count += row.cnt;
      if (row.cnt > existing.typeCount) {
        existing.chestType = row.chest_type;
        existing.typeCount = row.cnt;
      }
    } else {
      bucket.chestCounts.set(row.chest_name, {
        count: row.cnt,
        chestType: row.chest_type,
        typeCount: row.cnt,
      });
    }
  }

  // Include chest-name override rows that have no matching chest_records
  // yet (admin pre-seeded a value before any chests arrived).
  for (const [sourceKey, names] of overridesBySource.entries()) {
    let bucket = sourceKeyBuckets.get(sourceKey);
    if (!bucket) {
      bucket = {
        defaultPoints: getDefaultPointsForKey(sourceKey),
        isCustom: !isKnownSourceKey(sourceKey),
        count: 0,
        variants: new Set(),
        chestCounts: new Map(),
      };
      sourceKeyBuckets.set(sourceKey, bucket);
    }
    for (const chestName of names.keys()) {
      if (chestName !== '' && !bucket.chestCounts.has(chestName)) {
        bucket.chestCounts.set(chestName, { count: 0, chestType: '', typeCount: 0 });
      }
    }
  }

  // Majority-vote chest type per chest name so OCR outliers don't win.
  const typeCounts = db.prepare(`
    SELECT chest_name, chest_type, COUNT(*) as cnt
    FROM chest_records_v
    WHERE clan_id = ?
    GROUP BY chest_name, chest_type
  `).all(clanId) as { chest_name: string; chest_type: string; cnt: number }[];

  const majorityType = new Map<string, { type: string; cnt: number }>();
  for (const row of typeCounts) {
    const cur = majorityType.get(row.chest_name);
    if (!cur || row.cnt > cur.cnt) {
      majorityType.set(row.chest_name, { type: row.chest_type, cnt: row.cnt });
    }
  }

  const chestNames = names
    .map(({ name, count }) => ({
      name,
      type: majorityType.get(name)?.type ?? 'unknown',
      count,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const sourceKeys = Array.from(sourceKeyBuckets.entries())
    .map(([key, b]) => {
      const wildcardOverride = overridesBySource.get(key)?.get('') ?? null;
      const nameRows = Array.from(b.chestCounts.entries())
        .map(([chestName, c]) => {
          const override = overridesBySource.get(key)?.get(chestName);
          const pointValue = override ?? wildcardOverride ?? b.defaultPoints;
          return {
            chestName,
            chestType: c.chestType,
            count: c.count,
            override: override ?? null,
            pointValue,
          };
        })
        .sort((a, z) => a.chestName.localeCompare(z.chestName));

      return {
        sourceKey: key,
        // Wildcard-level (or default) for v1-shape readers.
        pointValue: wildcardOverride ?? b.defaultPoints,
        defaultPoints: b.defaultPoints,
        override: wildcardOverride,
        isCustom: b.isCustom,
        count: b.count,
        variants: Array.from(b.variants).sort((a, z) => a.localeCompare(z)),
        chestNames: nameRows,
      };
    })
    .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));

  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    summary: {
      totalChestNames: chestNames.length,
      totalDistinctSources: sources.length,
      totalSourceKeys: sourceKeys.length,
      totalMergeRules: mergeRules.length,
      totalChestTypeOverrides: chestTypeOverrides.length,
      totalSourcePointOverrides: sourcePointOverrides.length,
      totalUnparseableSources: unparseableSources.length,
    },
    chestNames,
    sourceKeys,
    unparseableSources: unparseableSources.sort((a, b) => a.source.localeCompare(b.source)),
    mergeRules: mergeRules
      .map((r) => ({ type: r.type, fromValue: r.fromValue, toValue: r.toValue }))
      .sort((a, b) =>
        a.type.localeCompare(b.type) || a.fromValue.localeCompare(b.fromValue),
      ),
    chestTypeOverrides: chestTypeOverrides
      .map((o) => ({ chestName: o.chestName, chestType: o.chestType }))
      .sort((a, b) => a.chestName.localeCompare(b.chestName)),
    sourcePointOverrides: sourcePointOverrides
      .map((o) => ({ sourceKey: o.sourceKey, chestName: o.chestName, pointValue: o.pointValue }))
      .sort((a, b) =>
        a.sourceKey.localeCompare(b.sourceKey) || a.chestName.localeCompare(b.chestName),
      ),
  };
}
