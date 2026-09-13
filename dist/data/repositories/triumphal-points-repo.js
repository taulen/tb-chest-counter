"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getKnownChestNames = getKnownChestNames;
exports.getAll = getAll;
exports.getManagementList = getManagementList;
exports.getNewChestNames = getNewChestNames;
exports.countNewChestNames = countNewChestNames;
exports.setPoints = setPoints;
exports.deletePoints = deletePoints;
const database_js_1 = require("../database.js");
/**
 * Names with a configured package value — the live "known triumphal
 * chests" set the scan resolves OCR against (passed to
 * correctTriumphalChestName). Seeded with the built-in defaults at v54.
 */
function getKnownChestNames() {
    const db = (0, database_js_1.getDb)();
    const rows = db.prepare('SELECT chest_name FROM triumphal_chest_points ORDER BY chest_name').all();
    return rows.map((r) => r.chest_name);
}
function getAll() {
    const db = (0, database_js_1.getDb)();
    const rows = db.prepare('SELECT id, chest_name, package_points, updated_at FROM triumphal_chest_points ORDER BY chest_name').all();
    return rows.map((r) => ({
        id: r.id,
        chestName: r.chest_name,
        packagePoints: r.package_points,
        updatedAt: r.updated_at,
    }));
}
/**
 * Admin management list: the union of every configured chest and every
 * chest name ever observed on a triumphal scan (across all clans, since
 * the table is global). Unconfigured-but-observed chests are flagged
 * `isNew` and sorted to the top so a superadmin can assign them a value.
 */
function getManagementList() {
    const db = (0, database_js_1.getDb)();
    const configured = db.prepare('SELECT chest_name, package_points FROM triumphal_chest_points').all();
    const configuredMap = new Map(configured.map((r) => [r.chest_name, r.package_points]));
    const observed = db.prepare(`
    SELECT ch.name AS chest_name, COUNT(*) AS cnt
    FROM triumphal_chest_records t
    JOIN chests ch ON ch.id = t.chest_id
    GROUP BY ch.name
  `).all();
    const observedMap = new Map(observed.map((r) => [r.chest_name, r.cnt]));
    const names = new Set([...configuredMap.keys(), ...observedMap.keys()]);
    const rows = [];
    for (const name of names) {
        const pkg = configuredMap.has(name) ? configuredMap.get(name) : null;
        const observedCount = observedMap.get(name) ?? 0;
        const isConfigured = pkg !== null;
        rows.push({
            chestName: name,
            packagePoints: pkg,
            perChestPoints: pkg === null ? null : Math.round(pkg / 3),
            observedCount,
            isConfigured,
            isNew: !isConfigured && observedCount > 0,
        });
    }
    // New/unconfigured first (so they can't be missed), then richest
    // package value, then name.
    rows.sort((a, b) => {
        if (a.isNew !== b.isNew)
            return a.isNew ? -1 : 1;
        const pa = a.packagePoints ?? -1;
        const pb = b.packagePoints ?? -1;
        if (pa !== pb)
            return pb - pa;
        return a.chestName.localeCompare(b.chestName);
    });
    return rows;
}
/**
 * Distinct triumphal chest names this clan has scanned that have no
 * configured value yet — the review-queue "new triumphal chests" list.
 */
function getNewChestNames(clanId) {
    const db = (0, database_js_1.getDb)();
    const rows = db.prepare(`
    SELECT DISTINCT ch.name AS chest_name
    FROM triumphal_chest_records t
    JOIN chests ch ON ch.id = t.chest_id
    WHERE t.clan_id = ?
      AND ch.name NOT IN (SELECT chest_name FROM triumphal_chest_points)
    ORDER BY ch.name
  `).all(clanId);
    return rows.map((r) => r.chest_name);
}
/** Count-only variant of getNewChestNames for the nav review badge. */
function countNewChestNames(clanId) {
    const db = (0, database_js_1.getDb)();
    const row = db.prepare(`
    SELECT COUNT(DISTINCT ch.name) AS cnt
    FROM triumphal_chest_records t
    JOIN chests ch ON ch.id = t.chest_id
    WHERE t.clan_id = ?
      AND ch.name NOT IN (SELECT chest_name FROM triumphal_chest_points)
  `).get(clanId);
    return row.cnt;
}
/** Upsert a chest's package (3-of-a-kind) value. Global. */
function setPoints(chestName, packagePoints) {
    const db = (0, database_js_1.getDb)();
    const now = new Date().toISOString();
    db.prepare(`
    INSERT INTO triumphal_chest_points (chest_name, package_points, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(chest_name) DO UPDATE SET package_points = ?, updated_at = ?
  `).run(chestName, packagePoints, now, packagePoints, now);
}
/** Remove a chest's configured value (reverts it to "new", scoring 0). */
function deletePoints(chestName) {
    const db = (0, database_js_1.getDb)();
    const result = db.prepare('DELETE FROM triumphal_chest_points WHERE chest_name = ?').run(chestName);
    return result.changes;
}
//# sourceMappingURL=triumphal-points-repo.js.map