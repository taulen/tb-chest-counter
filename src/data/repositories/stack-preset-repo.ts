/**
 * Saved armies for Tools → Stacks, one set per account (migration v97).
 *
 * The stack calculator runs in the browser (web/public/lib/stack-calc.js); the
 * server only keeps what a player saved under a name — the troops with their
 * health bonuses, and the sizing settings — so it opens the same on any device.
 * As with the citadel presets (citadel-preset-repo.ts, whose name and id checks
 * this shares), the server checks the SHAPE strictly and the page ignores troop
 * ids it doesn't know.
 */
import { getDb } from '../database.js';
import {
  MAX_PRESETS_PER_USER,
  MAX_PRESET_ROWS,
  PRESET_ID_RE,
  parsePresetName,
  pct,
} from './citadel-preset-repo.js';

export const MONSTER_MODES = ['reference', 'whole-stacks', 'scaled'] as const;
export type MonsterMode = (typeof MONSTER_MODES)[number];
/** How the base count is set: typed, or fitted to the leadership. */
export const BASE_MODES = ['manual', 'fill'] as const;
export type BaseMode = (typeof BASE_MODES)[number];

export interface StackPresetRow {
  troopId: string;
  healthPct: number;
}
export interface StackPresetSettings {
  baseMode: BaseMode;
  baseCount: number;
  tierMultiplier: number;
  siegeMultiplier: number;
  leadership: number;
  authority: number;
  dominance: number;
  monsterMode: MonsterMode;
  templeLevel: number;
  specialistsFirst: boolean;
  epicHunterLast: boolean;
}
export interface StackPresetData {
  rows: StackPresetRow[];
  settings: StackPresetSettings;
}
export interface StackPreset {
  id: number;
  name: string;
  updatedAt: string;
  data: StackPresetData;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function int(value: unknown, field: string, min: number, max: number, errors: string[]): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    errors.push(`${field} must be a whole number ${min}-${max}`);
    return min;
  }
  return value;
}

function decimal(value: unknown, field: string, min: number, max: number, errors: string[]): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    errors.push(`${field} must be a number ${min}-${max}`);
    return min;
  }
  return Math.round(value * 100) / 100;
}

function bool(value: unknown, field: string, errors: string[]): boolean {
  if (typeof value !== 'boolean') errors.push(`${field} must be true or false`);
  return value === true;
}

/** Validate a save request: { name, data: { rows[], settings } }. Refuses, never clamps. */
export function parseStackPreset(body: unknown): Parsed<{ name: string; data: StackPresetData }> {
  const errors: string[] = [];
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const name = parsePresetName(b.name, errors);
  const d = (b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? b.data : {}) as Record<string, unknown>;

  const rawRows = Array.isArray(d.rows) ? d.rows : null;
  if (!rawRows) errors.push('data.rows must be a list');
  else if (rawRows.length > MAX_PRESET_ROWS) errors.push(`data.rows holds at most ${MAX_PRESET_ROWS} troops`);
  const rows: StackPresetRow[] = [];
  for (const [i, raw] of (rawRows ?? []).slice(0, MAX_PRESET_ROWS).entries()) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const troopId = typeof r.troopId === 'string' ? r.troopId : '';
    if (!PRESET_ID_RE.test(troopId)) errors.push(`data.rows[${i}].troopId is not a troop id`);
    rows.push({ troopId, healthPct: pct(r.healthPct, `data.rows[${i}].healthPct`, errors) });
  }

  const s = (d.settings && typeof d.settings === 'object' && !Array.isArray(d.settings) ? d.settings : null) as Record<string, unknown> | null;
  if (!s) errors.push('data.settings must be an object');
  const v = s ?? {};
  const monsterMode = MONSTER_MODES.includes(v.monsterMode as MonsterMode) ? (v.monsterMode as MonsterMode) : null;
  if (s && !monsterMode) errors.push(`data.settings.monsterMode must be one of ${MONSTER_MODES.join(', ')}`);
  const baseMode = BASE_MODES.includes(v.baseMode as BaseMode) ? (v.baseMode as BaseMode) : null;
  if (s && !baseMode) errors.push(`data.settings.baseMode must be one of ${BASE_MODES.join(', ')}`);
  const settings: StackPresetSettings = {
    baseMode: baseMode ?? 'manual',
    baseCount: int(v.baseCount, 'data.settings.baseCount', 1, 10_000_000, errors),
    tierMultiplier: decimal(v.tierMultiplier, 'data.settings.tierMultiplier', 1, 5, errors),
    siegeMultiplier: decimal(v.siegeMultiplier, 'data.settings.siegeMultiplier', 0, 3, errors),
    leadership: int(v.leadership, 'data.settings.leadership', 0, 1_000_000_000, errors),
    authority: int(v.authority, 'data.settings.authority', 0, 1_000_000_000, errors),
    dominance: int(v.dominance, 'data.settings.dominance', 0, 1_000_000_000, errors),
    monsterMode: monsterMode ?? 'reference',
    templeLevel: int(v.templeLevel, 'data.settings.templeLevel', 1, 45, errors),
    specialistsFirst: bool(v.specialistsFirst, 'data.settings.specialistsFirst', errors),
    epicHunterLast: bool(v.epicHunterLast, 'data.settings.epicHunterLast', errors),
  };
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { name, data: { rows, settings } } };
}

type DbRow = { id: number; name: string; data: string; updated_at: string };

function toPreset(row: DbRow): StackPreset | null {
  try {
    return { id: row.id, name: row.name, updatedAt: row.updated_at, data: JSON.parse(row.data) as StackPresetData };
  } catch {
    return null;
  }
}

export function listStackPresets(userId: number): StackPreset[] {
  const rows = getDb().prepare(
    'SELECT id, name, data, updated_at FROM stack_presets WHERE user_id = ? ORDER BY name COLLATE NOCASE',
  ).all(userId) as DbRow[];
  return rows.map(toPreset).filter((p): p is StackPreset => p !== null);
}

/** Save under a name; the same name overwrites. Null when the account is full. */
export function saveStackPreset(userId: number, name: string, data: StackPresetData): StackPreset | null {
  const db = getDb();
  const now = new Date().toISOString();
  return db.transaction(() => {
    const existing = db.prepare('SELECT id FROM stack_presets WHERE user_id = ? AND name = ?').get(userId, name);
    if (!existing) {
      const { c } = db.prepare('SELECT COUNT(*) AS c FROM stack_presets WHERE user_id = ?').get(userId) as { c: number };
      if (c >= MAX_PRESETS_PER_USER) return null;
    }
    const row = db.prepare(
      `INSERT INTO stack_presets (user_id, name, data, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
       RETURNING id, name, data, updated_at`,
    ).get(userId, name, JSON.stringify(data), now) as DbRow;
    return toPreset(row);
  })();
}

/** Delete one of the account's own presets. False when it isn't theirs or doesn't exist. */
export function deleteStackPreset(userId: number, id: number): boolean {
  return getDb().prepare('DELETE FROM stack_presets WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}
