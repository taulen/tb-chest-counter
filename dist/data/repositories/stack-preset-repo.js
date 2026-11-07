"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BASE_MODES = exports.MONSTER_MODES = void 0;
exports.parseStackPreset = parseStackPreset;
exports.listStackPresets = listStackPresets;
exports.saveStackPreset = saveStackPreset;
exports.deleteStackPreset = deleteStackPreset;
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
const database_js_1 = require("../database.js");
const citadel_preset_repo_js_1 = require("./citadel-preset-repo.js");
exports.MONSTER_MODES = ['reference', 'whole-stacks', 'scaled'];
/** How the base count is set: typed, or fitted to the leadership. */
exports.BASE_MODES = ['manual', 'fill'];
function int(value, field, min, max, errors) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        errors.push(`${field} must be a whole number ${min}-${max}`);
        return min;
    }
    return value;
}
function decimal(value, field, min, max, errors) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        errors.push(`${field} must be a number ${min}-${max}`);
        return min;
    }
    return Math.round(value * 100) / 100;
}
function bool(value, field, errors) {
    if (typeof value !== 'boolean')
        errors.push(`${field} must be true or false`);
    return value === true;
}
/** Validate a save request: { name, data: { rows[], settings } }. Refuses, never clamps. */
function parseStackPreset(body) {
    const errors = [];
    const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {});
    const name = (0, citadel_preset_repo_js_1.parsePresetName)(b.name, errors);
    const d = (b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? b.data : {});
    const rawRows = Array.isArray(d.rows) ? d.rows : null;
    if (!rawRows)
        errors.push('data.rows must be a list');
    else if (rawRows.length > citadel_preset_repo_js_1.MAX_PRESET_ROWS)
        errors.push(`data.rows holds at most ${citadel_preset_repo_js_1.MAX_PRESET_ROWS} troops`);
    const rows = [];
    for (const [i, raw] of (rawRows ?? []).slice(0, citadel_preset_repo_js_1.MAX_PRESET_ROWS).entries()) {
        const r = (raw ?? {});
        const troopId = typeof r.troopId === 'string' ? r.troopId : '';
        if (!citadel_preset_repo_js_1.PRESET_ID_RE.test(troopId))
            errors.push(`data.rows[${i}].troopId is not a troop id`);
        rows.push({ troopId, healthPct: (0, citadel_preset_repo_js_1.pct)(r.healthPct, `data.rows[${i}].healthPct`, errors) });
    }
    const s = (d.settings && typeof d.settings === 'object' && !Array.isArray(d.settings) ? d.settings : null);
    if (!s)
        errors.push('data.settings must be an object');
    const v = s ?? {};
    const monsterMode = exports.MONSTER_MODES.includes(v.monsterMode) ? v.monsterMode : null;
    if (s && !monsterMode)
        errors.push(`data.settings.monsterMode must be one of ${exports.MONSTER_MODES.join(', ')}`);
    const baseMode = exports.BASE_MODES.includes(v.baseMode) ? v.baseMode : null;
    if (s && !baseMode)
        errors.push(`data.settings.baseMode must be one of ${exports.BASE_MODES.join(', ')}`);
    const settings = {
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
    if (errors.length)
        return { ok: false, errors };
    return { ok: true, value: { name, data: { rows, settings } } };
}
function toPreset(row) {
    try {
        return { id: row.id, name: row.name, updatedAt: row.updated_at, data: JSON.parse(row.data) };
    }
    catch {
        return null;
    }
}
function listStackPresets(userId) {
    const rows = (0, database_js_1.getDb)().prepare('SELECT id, name, data, updated_at FROM stack_presets WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(userId);
    return rows.map(toPreset).filter((p) => p !== null);
}
/** Save under a name; the same name overwrites. Null when the account is full. */
function saveStackPreset(userId, name, data) {
    const db = (0, database_js_1.getDb)();
    const now = new Date().toISOString();
    return db.transaction(() => {
        const existing = db.prepare('SELECT id FROM stack_presets WHERE user_id = ? AND name = ?').get(userId, name);
        if (!existing) {
            const { c } = db.prepare('SELECT COUNT(*) AS c FROM stack_presets WHERE user_id = ?').get(userId);
            if (c >= citadel_preset_repo_js_1.MAX_PRESETS_PER_USER)
                return null;
        }
        const row = db.prepare(`INSERT INTO stack_presets (user_id, name, data, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
       RETURNING id, name, data, updated_at`).get(userId, name, JSON.stringify(data), now);
        return toPreset(row);
    })();
}
/** Delete one of the account's own presets. False when it isn't theirs or doesn't exist. */
function deleteStackPreset(userId, id) {
    return (0, database_js_1.getDb)().prepare('DELETE FROM stack_presets WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}
//# sourceMappingURL=stack-preset-repo.js.map