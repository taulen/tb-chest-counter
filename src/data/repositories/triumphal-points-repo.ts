import { getDb } from '../database.js';

// Triumphal chest point values are a single GLOBAL, superadmin-managed
// scoring table (no clan_id) — triumphal chest values are a game-wide
// fact, mirroring source_point_overrides. Each row is a chest name and
// its 3-of-a-kind "package" value; the per-chest value is package / 3,
// rounded once per member at scoring time (see triumphal-chest-repo.ts).
//
// A triumphal chest observed in scans but NOT present here is "new":
// it's stored and counted but scores 0 until a superadmin assigns a
// value. Membership in this table IS the "reviewed" state — there's no
// separate acknowledgment row.

export interface TriumphalChestPoint {
  id: number;
  chestName: string;
  packagePoints: number;
  updatedAt: string;
}

export interface TriumphalChestPointRow {
  chestName: string;
  /** 3-of-a-kind package value, or null when this observed chest has no
   *  configured value yet (scores 0 — "new", awaiting a superadmin). */
  packagePoints: number | null;
  /** Per-chest value shown in the UI: round(packagePoints / 3), or null. */
  perChestPoints: number | null;
  /** How many triumphal chest rows carry this name (across all clans —
   *  the table is global). 0 for a configured-but-never-seen chest. */
  observedCount: number;
  isConfigured: boolean;
  /** Observed in scans but not yet configured — flagged for review. */
  isNew: boolean;
}

/**
 * Names with a configured package value — the live "known triumphal
 * chests" set the scan resolves OCR against (passed to
 * correctTriumphalChestName). Seeded with the built-in defaults at v54.
 */
export function getKnownChestNames(): string[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT chest_name FROM triumphal_chest_points ORDER BY chest_name',
  ).all() as { chest_name: string }[];
  return rows.map((r) => r.chest_name);
}

export function getAll(): TriumphalChestPoint[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT id, chest_name, package_points, updated_at FROM triumphal_chest_points ORDER BY chest_name',
  ).all() as { id: number; chest_name: string; package_points: number; updated_at: string }[];
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
export function getManagementList(): TriumphalChestPointRow[] {
  const db = getDb();

  const configured = db.prepare(
    'SELECT chest_name, package_points FROM triumphal_chest_points',
  ).all() as { chest_name: string; package_points: number }[];
  const configuredMap = new Map(configured.map((r) => [r.chest_name, r.package_points]));

  const observed = db.prepare(`
    SELECT ch.name AS chest_name, COUNT(*) AS cnt
    FROM triumphal_chest_records t
    JOIN chests ch ON ch.id = t.chest_id
    GROUP BY ch.name
  `).all() as { chest_name: string; cnt: number }[];
  const observedMap = new Map(observed.map((r) => [r.chest_name, r.cnt]));

  const names = new Set<string>([...configuredMap.keys(), ...observedMap.keys()]);
  const rows: TriumphalChestPointRow[] = [];
  for (const name of names) {
    const pkg = configuredMap.has(name) ? (configuredMap.get(name) as number) : null;
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
    if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
    const pa = a.packagePoints ?? -1;
    const pb = b.packagePoints ?? -1;
    if (pa !== pb) return pb - pa;
    return a.chestName.localeCompare(b.chestName);
  });
  return rows;
}

/**
 * Distinct triumphal chest names this clan has scanned that have no
 * configured value yet — the review-queue "new triumphal chests" list.
 */
export function getNewChestNames(clanId: number): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT ch.name AS chest_name
    FROM triumphal_chest_records t
    JOIN chests ch ON ch.id = t.chest_id
    WHERE t.clan_id = ?
      AND ch.name NOT IN (SELECT chest_name FROM triumphal_chest_points)
    ORDER BY ch.name
  `).all(clanId) as { chest_name: string }[];
  return rows.map((r) => r.chest_name);
}

/** Count-only variant of getNewChestNames for the nav review badge. */
export function countNewChestNames(clanId: number): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(DISTINCT ch.name) AS cnt
    FROM triumphal_chest_records t
    JOIN chests ch ON ch.id = t.chest_id
    WHERE t.clan_id = ?
      AND ch.name NOT IN (SELECT chest_name FROM triumphal_chest_points)
  `).get(clanId) as { cnt: number };
  return row.cnt;
}

/** Upsert a chest's package (3-of-a-kind) value. Global. */
export function setPoints(chestName: string, packagePoints: number): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO triumphal_chest_points (chest_name, package_points, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(chest_name) DO UPDATE SET package_points = ?, updated_at = ?
  `).run(chestName, packagePoints, now, packagePoints, now);
}

/** Remove a chest's configured value (reverts it to "new", scoring 0). */
export function deletePoints(chestName: string): number {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM triumphal_chest_points WHERE chest_name = ?',
  ).run(chestName);
  return result.changes;
}
