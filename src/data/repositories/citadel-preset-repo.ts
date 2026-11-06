/**
 * Saved armies for Tools → Citadel, one set per account (migration v95).
 *
 * The simulator runs in the browser (web/public/lib/citadel-sim.js); the server
 * only stores what a player saved under a name, so the same army and bonuses
 * open on any device they sign in from. The server doesn't know the troop list,
 * so it checks the SHAPE strictly (ids look like ids, numbers are finite and in
 * range, sizes are bounded) and the page ignores ids it doesn't know.
 */
import { getDb } from '../database.js';

export const MAX_PRESETS_PER_USER = 50;
export const MAX_PRESET_ROWS = 30;
const MAX_NAME = 40;

export interface CitadelPresetRow {
  troopId: string;
  count: number;
  strengthPct: number;
  healthPct: number;
}
export interface CitadelPresetData {
  citadelId: string;
  rows: CitadelPresetRow[];
}
export interface CitadelPreset {
  id: number;
  name: string;
  updatedAt: string;
  data: CitadelPresetData;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/**
 * Characters a name may not hold: control characters, and the invisible ones
 * that make two names look identical or flip how the text around them reads
 * (zero-width space, direction marks, bidi overrides and isolates, word joiners,
 * BOM). ZWJ/ZWNJ stay allowed — emoji and some scripts need them. Names are
 * always stored and sent as data (bound parameters; escaped where shown); this
 * only keeps what a player sees honest.
 */
const UNSAFE_NAME_RE = /[\p{Cc}​‎‏‪-‮⁠-⁤⁦-⁩﻿]/u;
const CITADEL_RE = /^(elven|cursed)-\d{1,2}$/;

function pct(value: unknown, field: string, errors: string[]): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < -100 || n > 1_000_000) {
    errors.push(`${field} must be a number between -100 and 1000000`);
    return 0;
  }
  return Math.round(n * 100) / 100;
}

/** Validate a save request: { name, data: { citadelId, rows[] } }. Refuses, never clamps. */
export function parseCitadelPreset(body: unknown): Parsed<{ name: string; data: CitadelPresetData }> {
  const errors: string[] = [];
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > MAX_NAME) errors.push(`name must be 1-${MAX_NAME} characters`);
  else if (UNSAFE_NAME_RE.test(name)) errors.push('name holds control or invisible characters');
  const d = (b.data ?? {}) as Record<string, unknown>;
  const citadelId = typeof d.citadelId === 'string' ? d.citadelId : '';
  if (!CITADEL_RE.test(citadelId)) errors.push('data.citadelId is not a citadel');
  const rawRows = Array.isArray(d.rows) ? d.rows : null;
  if (!rawRows) errors.push('data.rows must be a list');
  else if (rawRows.length > MAX_PRESET_ROWS) errors.push(`data.rows holds at most ${MAX_PRESET_ROWS} troops`);
  const rows: CitadelPresetRow[] = [];
  for (const [i, raw] of (rawRows ?? []).slice(0, MAX_PRESET_ROWS).entries()) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const troopId = typeof r.troopId === 'string' ? r.troopId : '';
    if (!ID_RE.test(troopId)) errors.push(`data.rows[${i}].troopId is not a troop id`);
    const count = typeof r.count === 'number' ? r.count : Number(r.count);
    if (!Number.isInteger(count) || count < 0 || count > 100_000_000) errors.push(`data.rows[${i}].count must be a whole number 0-100000000`);
    rows.push({
      troopId,
      count: Number.isInteger(count) ? count : 0,
      strengthPct: pct(r.strengthPct, `data.rows[${i}].strengthPct`, errors),
      healthPct: pct(r.healthPct, `data.rows[${i}].healthPct`, errors),
    });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { name, data: { citadelId, rows } } };
}

function toPreset(row: { id: number; name: string; data: string; updated_at: string }): CitadelPreset {
  let data: CitadelPresetData;
  try {
    data = JSON.parse(row.data) as CitadelPresetData;
  } catch {
    data = { citadelId: 'elven-25', rows: [] };
  }
  return { id: row.id, name: row.name, updatedAt: row.updated_at, data };
}

export function listCitadelPresets(userId: number): CitadelPreset[] {
  const rows = getDb().prepare(
    'SELECT id, name, data, updated_at FROM citadel_presets WHERE user_id = ? ORDER BY name COLLATE NOCASE',
  ).all(userId) as { id: number; name: string; data: string; updated_at: string }[];
  return rows.map(toPreset);
}

/** Save under a name; the same name overwrites. Null when the account is full. */
export function saveCitadelPreset(userId: number, name: string, data: CitadelPresetData): CitadelPreset | null {
  const db = getDb();
  const now = new Date().toISOString();
  return db.transaction(() => {
    const existing = db.prepare('SELECT id FROM citadel_presets WHERE user_id = ? AND name = ?').get(userId, name) as { id: number } | undefined;
    if (!existing) {
      const { c } = db.prepare('SELECT COUNT(*) AS c FROM citadel_presets WHERE user_id = ?').get(userId) as { c: number };
      if (c >= MAX_PRESETS_PER_USER) return null;
    }
    const row = db.prepare(
      `INSERT INTO citadel_presets (user_id, name, data, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
       RETURNING id, name, data, updated_at`,
    ).get(userId, name, JSON.stringify(data), now) as { id: number; name: string; data: string; updated_at: string };
    return toPreset(row);
  })();
}

// ─── Troop levels (migration v96): one row per account ───

/** Unlocked tier per troop kind: Guardsmen, Specialists, Monsters, Engineers. Null = any. */
export interface CitadelLevels {
  g: number | null;
  s: number | null;
  m: number | null;
  e: number | null;
}
const LEVEL_KEYS = ['g', 's', 'm', 'e'] as const;
const NO_LEVELS: CitadelLevels = { g: null, s: null, m: null, e: null };

/** Validate { g, s, m, e }: each a whole number 1-9, or null for "any". Refuses, never clamps. */
export function parseCitadelLevels(body: unknown): Parsed<CitadelLevels> {
  const errors: string[] = [];
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const out: CitadelLevels = { ...NO_LEVELS };
  for (const k of LEVEL_KEYS) {
    const v = b[k];
    if (v === null || v === undefined) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 9) errors.push(`${k} must be a whole number 1-9, or null`);
    else out[k] = v;
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: out };
}

export function getCitadelLevels(userId: number): CitadelLevels {
  const row = getDb().prepare('SELECT g, s, m, e FROM citadel_levels WHERE user_id = ?').get(userId) as CitadelLevels | undefined;
  return row ? { g: row.g, s: row.s, m: row.m, e: row.e } : { ...NO_LEVELS };
}

export function saveCitadelLevels(userId: number, levels: CitadelLevels): CitadelLevels {
  getDb().prepare(
    `INSERT INTO citadel_levels (user_id, g, s, m, e, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET g = excluded.g, s = excluded.s, m = excluded.m, e = excluded.e, updated_at = excluded.updated_at`,
  ).run(userId, levels.g, levels.s, levels.m, levels.e, new Date().toISOString());
  return getCitadelLevels(userId);
}

/** Delete one of the account's own presets. False when it isn't theirs or doesn't exist. */
export function deleteCitadelPreset(userId: number, id: number): boolean {
  return getDb().prepare('DELETE FROM citadel_presets WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}
