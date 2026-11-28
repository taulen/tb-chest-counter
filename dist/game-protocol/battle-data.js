"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BATTLE_DATA_FORMAT = exports.BATTLE_DATA_FILE = void 0;
exports.buildBattleData = buildBattleData;
exports.battleUnitNames = battleUnitNames;
exports.BATTLE_DATA_FILE = 'battle-data.json';
/** Bump when the file's shape changes. */
exports.BATTLE_DATA_FORMAT = 1;
/** T7 f1 of an army on the map (monster squads, citadels, enemy cities, vaults). */
const MAP_ARMY = 6;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isRow = (r) => Array.isArray(r);
const nonEmpty = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0;
function rowsOf(t) {
    return Object.entries(t ?? {})
        .filter((e) => isRow(e[1]))
        .map(([id, row]) => [Number(id), row])
        .sort((a, b) => a[0] - b[0]);
}
/** How a player fields a priced unit: its march cost decides, then its tags. */
function kindOf(tags, lead, dom, auth) {
    if (auth > 0)
        return 'mercenaries';
    if (dom > 0)
        return 'monsters';
    if (lead <= 0)
        return null;
    if (tags.has('engine') || tags.has('siege'))
        return 'siege';
    if (tags.has('guardsmen'))
        return 'guardsmen';
    if (tags.has('specialist'))
        return 'specialists';
    return null;
}
function buildBattleData(t7, t9, look, version) {
    const tagList = (v) => (Array.isArray(v) ? v : []).map((r) => look.str(r)?.toLowerCase()).filter((s) => !!s);
    // Every unit that can fight, by id.
    const all = new Map();
    for (const [id, row] of rowsOf(t9)) {
        const str = num(row[10]);
        const hp = num(row[12]);
        const name = look.name(row[1]);
        if (!(str > 0) || !(hp > 0) || !name)
            continue;
        const tags = tagList(row[23]);
        const vs = [];
        for (const f of Array.isArray(row[38]) ? row[38] : []) {
            if (!Array.isArray(f) || !Array.isArray(f[0]))
                continue;
            const on = tagList(f[0]);
            const pct = num(f[1]);
            const mult = num(f[2]) > 0 ? num(f[2]) / 100 : 1;
            if (on.length && (pct || mult !== 1))
                vs.push([on, pct, mult]);
        }
        const lead = num(row[16]) / 100;
        const auth = num(row[17]) / 100;
        const dom = num(row[18]) / 100;
        const priced = Array.isArray(row[6]) && nonEmpty(row[6][0]);
        const unit = { name, tier: num(row[2]), str, hp, tags, vs, icon: look.str(row[4]) ?? '', priced };
        const kind = priced ? kindOf(new Set(tags), lead, dom, auth) : null;
        if (kind) {
            unit.kind = kind;
            if (kind === 'mercenaries')
                unit.auth = auth;
            else if (kind === 'monsters')
                unit.dom = dom;
            else
                unit.lead = lead;
        }
        all.set(id, unit);
    }
    // A trained troop or mercenary appears again under a higher id with the same
    // numbers and no march cost (75xxx): the lowest id is the one armies carry.
    const seen = new Set();
    const fieldable = new Set();
    for (const [id, u] of all) {
        if (!u.kind)
            continue;
        const key = `${u.name}|${u.str}|${u.hp}|${u.kind}`;
        if (seen.has(key)) {
            delete u.kind;
            continue;
        }
        seen.add(key);
        fieldable.add(id);
    }
    const groups = new Map();
    for (const [id, row] of rowsOf(t7)) {
        if (row[1] !== MAP_ARMY)
            continue;
        const name = look.name(row[3]);
        const raw = Array.isArray(row[6]) ? row[6][1] : undefined;
        if (!name || !nonEmpty(raw))
            continue;
        const army = Object.entries(raw)
            .map(([u, n]) => [Number(u), num(n)])
            .filter(([, n]) => n > 0);
        if (!army.length || army.some(([u]) => !all.has(u)))
            continue;
        army.sort((a, b) => all.get(b[0]).str * b[1] - all.get(a[0]).str * a[1] || a[0] - b[0]);
        const level = num(row[15]);
        const g = `${name}|${level}`;
        if (!groups.has(g))
            groups.set(g, []);
        groups.get(g).push({ id, name, level, cls: num(row[18]), army, key: JSON.stringify([...army].sort((a, b) => a[0] - b[0])) });
    }
    const targets = [];
    const used = new Set(fieldable);
    for (const list of groups.values()) {
        const current = list.filter((c) => c.cls !== 0);
        const pick = current.length ? current : list;
        const byArmy = new Map();
        for (const c of pick) {
            const t = byArmy.get(c.key);
            if (t)
                t.ids.push(c.id);
            else
                byArmy.set(c.key, { ids: [c.id], name: c.name, level: c.level, cls: c.cls, army: c.army });
        }
        for (const t of byArmy.values()) {
            targets.push(t);
            for (const [u] of t.army)
                used.add(u);
        }
    }
    targets.sort((a, b) => a.name.localeCompare(b.name) || a.level - b.level || a.ids[0] - b.ids[0]);
    const units = {};
    for (const id of [...used].sort((a, b) => a - b)) {
        const { priced: _p, ...u } = all.get(id);
        units[String(id)] = u;
    }
    return { format: exports.BATTLE_DATA_FORMAT, version, units, targets };
}
/** The English names of the units battle data carries, for names.json (and so the game's own text in every site language). */
function battleUnitNames(data) {
    return Object.fromEntries(Object.entries(data.units).map(([id, u]) => [id, u.name]));
}
//# sourceMappingURL=battle-data.js.map