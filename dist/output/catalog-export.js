"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.exportCatalog = exportCatalog;
const chestRepo = __importStar(require("../data/repositories/chest-repo.js"));
const mergeRepo = __importStar(require("../data/repositories/merge-repo.js"));
const sourcePointsRepo = __importStar(require("../data/repositories/source-points-repo.js"));
const database_js_1 = require("../data/database.js");
const source_names_js_1 = require("../vision/source-names.js");
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
function exportCatalog(clanId) {
    const names = chestRepo.getDistinctChestNames(clanId);
    const sources = chestRepo.getDistinctChestSources(clanId);
    const mergeRules = mergeRepo.getMergeRules(clanId);
    const chestTypeOverrides = mergeRepo.getChestTypeOverrides(clanId);
    const sourcePointOverrides = sourcePointsRepo.getAllOverrides();
    // Index overrides by sourceKey so we can fold name-specific rows into
    // the source buckets below. A source key may have a wildcard row and
    // zero or more name-specific rows.
    const overridesBySource = new Map();
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
    const db = (0, database_js_1.getDb)();
    const chestCountRows = db.prepare(`
    SELECT chest_source, chest_name, chest_type, COUNT(*) as cnt
    FROM chest_records_v
    WHERE clan_id = ? AND chest_source != ''
    GROUP BY chest_source, chest_name, chest_type
  `).all(clanId);
    const sourceKeyBuckets = new Map();
    const unparseableSources = [];
    for (const { source, count } of sources) {
        const key = (0, source_names_js_1.getSourceKey)(source);
        if (!key) {
            unparseableSources.push({ source, count });
            continue;
        }
        let bucket = sourceKeyBuckets.get(key);
        if (!bucket) {
            bucket = {
                defaultPoints: (0, source_names_js_1.getDefaultPointsForKey)(key),
                isCustom: !(0, source_names_js_1.isKnownSourceKey)(key),
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
        const key = (0, source_names_js_1.getSourceKey)(row.chest_source);
        if (!key)
            continue;
        const bucket = sourceKeyBuckets.get(key);
        if (!bucket)
            continue;
        const existing = bucket.chestCounts.get(row.chest_name);
        if (existing) {
            existing.count += row.cnt;
            if (row.cnt > existing.typeCount) {
                existing.chestType = row.chest_type;
                existing.typeCount = row.cnt;
            }
        }
        else {
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
                defaultPoints: (0, source_names_js_1.getDefaultPointsForKey)(sourceKey),
                isCustom: !(0, source_names_js_1.isKnownSourceKey)(sourceKey),
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
  `).all(clanId);
    const majorityType = new Map();
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
            .sort((a, b) => a.type.localeCompare(b.type) || a.fromValue.localeCompare(b.fromValue)),
        chestTypeOverrides: chestTypeOverrides
            .map((o) => ({ chestName: o.chestName, chestType: o.chestType }))
            .sort((a, b) => a.chestName.localeCompare(b.chestName)),
        sourcePointOverrides: sourcePointOverrides
            .map((o) => ({ sourceKey: o.sourceKey, chestName: o.chestName, pointValue: o.pointValue }))
            .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey) || a.chestName.localeCompare(b.chestName)),
    };
}
//# sourceMappingURL=catalog-export.js.map